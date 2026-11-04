import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import type { DatabaseService } from '../../database/database.service'
import { MATCH_RULE_VERSION } from '../runtime/recompute-inputs'
import {
  currentGeneration,
  GENERATION_MAX_ENTRIES,
  GENERATION_TTL_MS,
  generationById,
} from './queue-generation'
import type { JobQueueScope, LiveSeniorVersion } from './queue-scope'

/** Unit double for the mutation gate; publication itself is pinned on Postgres by the integration spec. */
const TEAM = '11111111-1111-4111-8111-111111111111'
const GEN = '55555555-5555-4555-8555-555555555555'
const NEW_GEN = '66666666-6666-4666-8666-666666666666'
const SEN = '33333333-3333-4333-8333-333333333333'
const NOW = new Date('2026-11-04T12:00:00.000Z')
const versions: LiveSeniorVersion[] = [{ seniorId: SEN, profile: 'p', exclusion: 'e' }]
const team: JobQueueScope = { kind: 'TEAM', teamId: TEAM, seniorIds: [SEN], versions }
const studio: JobQueueScope = { kind: 'STUDIO' }

type Rows = Array<Record<string, unknown>>
function harness(...answers: Rows[]) {
  const execute = vi.fn(async (_q: SQL) => {
    const next = answers.shift()
    if (next === undefined) throw new Error('unexpected query')
    return { rows: next }
  })
  const transaction = vi.fn(<T>(fn: (tx: unknown) => Promise<T>) => fn({ execute }))
  const database = { db: { execute, transaction } } as unknown as DatabaseService
  const compiled = (call: number) => {
    const q = new PgDialect().sqlToQuery((execute.mock.calls[call] as [SQL])[0])
    return { text: q.sql.replace(/\s+/g, ' '), params: q.params }
  }
  return { database, execute, transaction, compiled }
}
const row = (over: Record<string, unknown> = {}) => ({
  id: GEN,
  scope_kind: 'TEAM',
  team_id: TEAM,
  status: 'PUBLISHED',
  expires_at: new Date('2026-11-04T12:05:00.000Z'),
  policy_signature: 'sig',
  ...over,
})
const EXPIRES = new Date(NOW.getTime() + 15 * 60 * 1000)

describe('generation constants', () => {
  it('lives 15 minutes and retains the top 5000', () => {
    expect(GENERATION_TTL_MS).toBe(900_000)
    expect(GENERATION_MAX_ENTRIES).toBe(5000)
  })
})

describe('generationById', () => {
  it('maps a row, whichever way the driver spells the instant', async () => {
    const h = harness([row({ expires_at: '2026-11-04T12:05:00.123Z' })])
    await expect(generationById(h.database.db, GEN)).resolves.toEqual({
      id: GEN,
      scopeKind: 'TEAM',
      teamId: TEAM,
      status: 'PUBLISHED',
      expiresAt: new Date('2026-11-04T12:05:00.123Z'),
      policySignature: 'sig',
    })
    expect(h.compiled(0).params).toEqual([GEN])
  })
  it('a driver Date is kept to the millisecond, and every column is selected', async () => {
    const exact = new Date('2026-11-04T12:05:00.456Z')
    const h = harness([row({ expires_at: exact })])
    await expect(generationById(h.database.db, GEN)).resolves.toMatchObject({ expiresAt: exact })
    expect(h.compiled(0).text).toBe(
      'SELECT id, scope_kind, team_id, status, expires_at, policy_signature FROM job_queue_generations WHERE id = $1::uuid',
    )
  })
  it('keeps a studio generation team-less', async () => {
    const h = harness([row({ scope_kind: 'STUDIO', team_id: null })])
    await expect(generationById(h.database.db, GEN)).resolves.toMatchObject({ teamId: null })
  })
  it('is null when there is no such row', async () => {
    await expect(generationById(harness([]).database.db, GEN)).resolves.toBeNull()
  })
})

describe('currentGeneration', () => {
  it('serves the published generation of the same policy: no transaction, no write', async () => {
    const h = harness([row()])
    const g = await currentGeneration(h.database, team, versions, 'sig', NOW)
    expect(g.id).toBe(GEN)
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.compiled(0).text).toContain(
      `status = 'PUBLISHED' AND scope_kind = 'TEAM' AND team_id = $`,
    )
    expect(h.compiled(0).params).toEqual([TEAM])
  })

  it('reads only the STUDIO generation for the STUDIO scope', async () => {
    const h = harness([row({ scope_kind: 'STUDIO', team_id: null })])
    await currentGeneration(h.database, studio, [], 'sig', NOW)
    expect(h.compiled(0).text).toContain(`status = 'PUBLISHED' AND scope_kind = 'STUDIO'`)
    expect(h.compiled(0).params).toEqual([])
  })

  /** Published row, lock, re-read, insert, entries, invalidate, publish, purge. */
  const publishAnswers = (first: Rows): Rows[] => [
    first,
    [],
    first,
    [{ id: NEW_GEN }],
    [],
    [],
    [],
    [],
  ]

  it.each([
    ['none exists', [] as Rows],
    ['the head expired', [row({ expires_at: new Date('2026-11-04T11:00:00.000Z') })]],
    ['the policy changed', [row({ policy_signature: 'older' })]],
  ])('publishes when %s', async (_label, first) => {
    const h = harness(...publishAnswers(first))
    await expect(currentGeneration(h.database, team, versions, 'sig', NOW)).resolves.toEqual({
      id: NEW_GEN,
      scopeKind: 'TEAM',
      teamId: TEAM,
      status: 'PUBLISHED',
      expiresAt: EXPIRES,
      policySignature: 'sig',
    })
    expect(h.transaction).toHaveBeenCalledTimes(1)
    expect(h.execute).toHaveBeenCalledTimes(8)
  })

  it('takes the per-scope lock first and writes in the order the triggers allow', async () => {
    const h = harness(...publishAnswers([]))
    await currentGeneration(h.database, team, versions, 'sig', NOW)
    expect(h.compiled(1).text).toContain('pg_advisory_xact_lock(hashtextextended(')
    expect(h.compiled(1).params).toEqual([`job-queue-generation:TEAM:${TEAM}`])
    expect(h.compiled(3).text).toContain('INSERT INTO job_queue_generations')
    expect(h.compiled(3).params).toEqual([
      'TEAM',
      TEAM,
      'sig',
      MATCH_RULE_VERSION,
      NOW.toISOString(),
      EXPIRES.toISOString(),
    ])
    const entries = h.compiled(4)
    expect(entries.text).toContain('INSERT INTO job_queue_generation_entries')
    expect(entries.text).toContain('ORDER BY c.score DESC, c.first_seen_at DESC, c.id DESC')
    expect(entries.params).toContain(NEW_GEN)
    expect(entries.params).toContain(GENERATION_MAX_ENTRIES)
    expect(entries.text).toContain('FROM job_opportunity_team_triage g')
    expect(entries.text).toContain(`WHERE m.opportunity_id = o.id AND m.outcome = 'LEAD'`)
    expect(h.compiled(5).text).toContain(`SET status = 'INVALIDATED'`)
    expect(h.compiled(5).params).toEqual([NOW.toISOString(), TEAM])
    expect(h.compiled(6).text).toContain(`SET status = 'PUBLISHED'`)
    expect(h.compiled(6).params).toEqual([NOW.toISOString(), NEW_GEN])
    expect(h.compiled(7).text).toContain(
      `DELETE FROM job_queue_generations WHERE status = 'INVALIDATED'`,
    )
    expect(h.compiled(7).params).toEqual([TEAM])
  })

  it('a STUDIO publication is keyed and shaped for the studio', async () => {
    const h = harness(...publishAnswers([]))
    await expect(
      currentGeneration(h.database, studio, versions, 'sig', NOW),
    ).resolves.toMatchObject({
      scopeKind: 'STUDIO',
      teamId: null,
    })
    expect(h.compiled(1).params).toEqual(['job-queue-generation:STUDIO'])
    expect(h.compiled(3).params).toEqual([
      'STUDIO',
      null,
      'sig',
      MATCH_RULE_VERSION,
      NOW.toISOString(),
      EXPIRES.toISOString(),
    ])
  })

  it('coalesces: a publisher that lost the race serves the winner and writes nothing', async () => {
    const h = harness([], [], [row({ id: NEW_GEN })])
    await expect(currentGeneration(h.database, team, versions, 'sig', NOW)).resolves.toMatchObject({
      id: NEW_GEN,
    })
    expect(h.execute).toHaveBeenCalledTimes(3)
  })
})
