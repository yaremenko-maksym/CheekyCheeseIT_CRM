import { createHash, randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  openCrmAppSession,
} from '../../database/__test-helpers__/crm-app-session'
import * as schema from '../../database/schema'
import { hasDatabaseUrl } from '../../test/require-real-db'
import { MATCH_RULE_VERSION, loadRoster } from '../runtime/recompute-inputs'
import type { RelevanceReply, RelevanceSenior, RelevanceVacancy } from './jev-relevance-grader'
import {
  RELEVANCE_BACKOFF,
  type RelevancePassResult,
  type RelevanceGrader,
  runRelevancePass,
} from './relevance-pass'
import { createRelevanceStore } from './relevance.store'

/**
 * Queue relevance PR1, Task 4 — the relevance pass and its store against a real Postgres, run as
 * `crm_app` (the grants are the shipped files). The grader is a fake. Every opportunity of a test
 * is dated in 2999, so the pass's `last_observed_at DESC` order reaches them first, and the limit is
 * the test's own count; a row of another suite reaching the fake fails the test. Each test closes
 * its rows afterwards, so a later test never sees them.
 */
const TAG = randomUUID().slice(0, 8)
const PREFIX = `rel1-${TAG}`
const NOW = new Date('2026-11-24T10:00:00.000Z')
const MIN = 60_000

let session: CrmAppSession
let db: ReturnType<typeof drizzle<typeof schema>>
let team: string
const seniors: string[] = []
const mine: string[] = []
const shas: string[] = []
let seq = 0

async function blob(text: string): Promise<string> {
  const sha = createHash('sha256').update(text).digest('hex')
  shas.push(sha)
  await session.admin.query(
    `INSERT INTO job_text_blobs (sha256, text) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [sha, text],
  )
  return sha
}

async function addSenior(): Promise<string> {
  const { rows } = await session.admin.query(
    `INSERT INTO users (email, display_name, role, technical_roles)
     VALUES ($1, 'Rel1 spec senior', 'SENIOR', ARRAY['BACKEND_ENGINEER']) RETURNING id`,
    [`rel1-senior-${TAG}-${seniors.length}@example.test`],
  )
  const id = rows[0].id as string
  seniors.push(id)
  await session.admin.query(`INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)`, [
    team,
    id,
  ])
  return id
}

async function profileVersion(seniorId: string): Promise<string> {
  const v = (await loadRoster(db)).versions.get(seniorId)?.profile
  if (v === undefined) throw new Error('senior not on the roster')
  return v
}

/** An evaluated opportunity with a description, inserted directly. */
async function opportunity(
  opts: { availability?: string; manual?: boolean; evaluated?: boolean } = {},
): Promise<{ id: string; revision: number; title: string }> {
  seq += 1
  const title = `Wizard ${PREFIX} java ${seq}`
  const sha = await blob(`DESCRIPTION ${PREFIX} ${seq}`)
  const { rows } = await session.admin.query(
    `INSERT INTO job_opportunities
       (title, title_key, stack_keywords, description_sha256, technical_roles, availability,
        manual_team_id, last_observed_at)
     VALUES ($1, $2, ARRAY['java'], $3, ARRAY['BACKEND_ENGINEER'], $4::job_availability, $5,
             '2999-01-01T00:00:00Z'::timestamptz + $6 * interval '1 second')
     RETURNING id, revision`,
    [title, title.toLowerCase(), sha, opts.availability ?? 'OPEN', opts.manual ? team : null, seq],
  )
  const id = rows[0].id as string
  mine.push(id)
  if (opts.evaluated !== false) {
    await session.admin.query(
      `UPDATE job_opportunities
          SET evaluated_revision = revision, evaluation_verdict = 'OPEN',
              evaluated_inputs_version = 'rel1-spec'
        WHERE id = $1`,
      [id],
    )
  }
  return { id, revision: Number(rows[0].revision), title }
}

async function lead(opportunityId: string, revision: number, seniorId: string): Promise<void> {
  await session.admin.query(
    `INSERT INTO job_opportunity_matches
       (opportunity_id, senior_id, opportunity_revision, senior_profile_version,
        exclusion_version, rule_version, outcome)
     VALUES ($1, $2, $3, $4, 'rel1-spec', $5, 'LEAD')`,
    [opportunityId, seniorId, revision, await profileVersion(seniorId), MATCH_RULE_VERSION],
  )
}

function fakeGrader(answer: (s: readonly RelevanceSenior[]) => RelevanceReply) {
  const calls: { vacancy: RelevanceVacancy; seniors: readonly RelevanceSenior[] }[] = []
  const jev: RelevanceGrader = {
    grade(vacancy, s) {
      calls.push({ vacancy, seniors: s })
      if (!vacancy.title.includes(PREFIX)) throw new Error('a row of another suite was selected')
      return Promise.resolve(answer(s))
    },
  }
  return { jev, calls }
}

const fits =
  (...f: number[]) =>
  () => ({ kind: 'ok' as const, fits: f })
const down = () => ({ kind: 'unavailable' as const, reason: 'PROVIDER_ERROR' })

const log = { log: () => {}, warn: () => {}, error: () => {} }

function pass(jev: RelevanceGrader, limit: number, now = NOW): Promise<RelevancePassResult> {
  return runRelevancePass({ db, jev, log, now: () => now, limit })
}

async function relevanceOf(opportunityId: string) {
  const { rows } = await session.admin.query(
    `SELECT senior_id::text AS senior_id, status, fit, attempts, next_attempt_at
       FROM job_opportunity_relevance WHERE opportunity_id = $1 ORDER BY senior_id`,
    [opportunityId],
  )
  return rows as {
    senior_id: string
    status: string
    fit: number | null
    attempts: number
    next_attempt_at: Date | null
  }[]
}

async function relevanceDirty(opportunityId: string) {
  const { rows } = await session.admin.query(
    `SELECT target_version::int AS target_version, reason FROM job_dirty_work
      WHERE entity_kind = 'OPPORTUNITY' AND entity_id = $1 AND reason LIKE 'RELEVANCE:%'
      ORDER BY id`,
    [opportunityId],
  )
  return rows as { target_version: number; reason: string }[]
}

describe.skipIf(!hasDatabaseUrl())('relevance pass against Postgres (queue relevance PR1)', () => {
  beforeAll(async () => {
    session = await openCrmAppSession({ appPoolMax: 4 })
    const { rows } = await session.admin.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    db = drizzle(session.pool, { schema })
    const { rows: teams } = await session.admin.query(
      `INSERT INTO teams (name) VALUES ($1) RETURNING id`,
      [`rel1-team-${TAG}`],
    )
    team = teams[0].id as string
    await addSenior()
    await addSenior()
    seniors.sort()
  })

  afterEach(async () => {
    // A closed row is never a candidate again.
    await session.admin.query(
      `UPDATE job_opportunities SET availability = 'CLOSED' WHERE id = ANY($1::uuid[])`,
      [mine],
    )
  })

  afterAll(async () => {
    if (session === undefined) return
    try {
      await session.admin.query(`DELETE FROM job_dirty_work WHERE entity_id = ANY($1::uuid[])`, [
        mine,
      ])
      // Cascades the match and relevance rows.
      await session.admin.query(`DELETE FROM job_opportunities WHERE id = ANY($1::uuid[])`, [mine])
      await session.admin.query(`DELETE FROM job_text_blobs WHERE sha256 = ANY($1::text[])`, [shas])
      await session.admin.query(`DELETE FROM team_members WHERE user_id = ANY($1::uuid[])`, [
        seniors,
      ])
      await session.admin.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [seniors])
      await session.admin.query(`DELETE FROM teams WHERE id = $1`, [team])
    } finally {
      await session.close()
    }
  })

  it('grades every LEAD pair, stores GRADED rows and enqueues one RELEVANCE dirty row', async () => {
    const o = await opportunity()
    await lead(o.id, o.revision, seniors[0] as string)
    await lead(o.id, o.revision, seniors[1] as string)
    const g = fakeGrader(fits(0.25, 1))
    await expect(pass(g.jev, 1)).resolves.toEqual({ graded: 2, failed: 0, stoppedBy: null })
    expect(g.calls).toHaveLength(1)
    expect(g.calls[0]?.seniors).toEqual([
      { roles: ['BACKEND_ENGINEER'], skills: null },
      { roles: ['BACKEND_ENGINEER'], skills: null },
    ])
    expect(JSON.stringify(g.calls)).not.toContain(seniors[0] as string)
    const rows = await relevanceOf(o.id)
    expect(rows.map((r) => [r.senior_id, r.status, r.fit, r.attempts])).toEqual([
      [seniors[0], 'GRADED', 0.25, 0],
      [seniors[1], 'GRADED', 1, 0],
    ])
    const dirty = await relevanceDirty(o.id)
    expect(dirty).toHaveLength(1)
    expect(dirty[0]?.target_version).toBe(o.revision)
    expect(dirty[0]?.reason).toMatch(/^RELEVANCE:rel\.1:[0-9a-f]{16}$/)

    // Graded at the current key: the next pass sends nothing.
    const again = fakeGrader(fits(0))
    await expect(pass(again.jev, 1)).resolves.toEqual({ graded: 0, failed: 0, stoppedBy: null })
    expect(again.calls).toHaveLength(0)
  })

  it('a second grading at the same revision enqueues a second, distinct dirty row', async () => {
    const o = await opportunity()
    await lead(o.id, o.revision, seniors[0] as string)
    await pass(fakeGrader(fits(0.5)).jev, 1)
    await lead(o.id, o.revision, seniors[1] as string)
    const g = fakeGrader(fits(0.75))
    await expect(pass(g.jev, 1)).resolves.toMatchObject({ graded: 1 })
    expect(g.calls[0]?.seniors).toHaveLength(1)
    const dirty = await relevanceDirty(o.id)
    expect(dirty).toHaveLength(2)
    expect(dirty[0]?.reason).not.toBe(dirty[1]?.reason)
    expect(dirty.map((d) => d.target_version)).toEqual([o.revision, o.revision])
  })

  it('a new description makes the graded pair pending again', async () => {
    const o = await opportunity()
    await lead(o.id, o.revision, seniors[0] as string)
    await pass(fakeGrader(fits(0.5)).jev, 1)
    const sha = await blob(`DESCRIPTION ${PREFIX} rewritten ${seq}`)
    await session.admin.query(
      `UPDATE job_opportunities SET description_sha256 = $2 WHERE id = $1`,
      [o.id, sha],
    )
    const g = fakeGrader(fits(1))
    await expect(pass(g.jev, 1)).resolves.toMatchObject({ graded: 1 })
    expect(g.calls[0]?.vacancy.description).toBe(`DESCRIPTION ${PREFIX} rewritten ${seq}`)
    expect((await relevanceOf(o.id))[0]).toMatchObject({ status: 'GRADED', fit: 1 })
  })

  it('a failure backs off: FAILED row, attempts counted, no candidate until next_attempt_at', async () => {
    const o = await opportunity()
    await lead(o.id, o.revision, seniors[0] as string)
    await expect(pass(fakeGrader(down).jev, 1)).resolves.toEqual({
      graded: 0,
      failed: 1,
      stoppedBy: 'PROVIDER_ERROR',
    })
    let [row] = await relevanceOf(o.id)
    expect(row).toMatchObject({ status: 'FAILED', fit: null, attempts: 1 })
    expect(row?.next_attempt_at?.getTime()).toBe(NOW.getTime() + RELEVANCE_BACKOFF(0))
    expect(await relevanceDirty(o.id)).toEqual([])

    const early = fakeGrader(fits(1))
    await pass(early.jev, 1, new Date(NOW.getTime() + 14 * MIN))
    expect(early.calls).toHaveLength(0)

    const later = new Date(NOW.getTime() + 16 * MIN)
    await pass(fakeGrader(down).jev, 1, later)
    ;[row] = await relevanceOf(o.id)
    expect(row).toMatchObject({ status: 'FAILED', attempts: 2 })
    expect(row?.next_attempt_at?.getTime()).toBe(later.getTime() + RELEVANCE_BACKOFF(1))
  })

  it('a failure never overwrites a current GRADED row', async () => {
    const o = await opportunity()
    await lead(o.id, o.revision, seniors[0] as string)
    await pass(fakeGrader(fits(0.75)).jev, 1)
    const store = createRelevanceStore(db)
    const c = {
      id: o.id,
      title: o.title,
      titleKey: o.title.toLowerCase(),
      descriptionSha256: shas[shas.length - 1] as string,
      description: '',
      categories: ['java'],
      roles: ['BACKEND_ENGINEER' as const],
      pairs: [],
    }
    await store.recordFailures(
      c,
      [
        {
          seniorId: seniors[0] as string,
          profileVersion: await profileVersion(seniors[0] as string),
        },
      ],
      NOW,
    )
    expect((await relevanceOf(o.id))[0]).toMatchObject({
      status: 'GRADED',
      fit: 0.75,
      attempts: 0,
      next_attempt_at: null,
    })
  })

  it('applyGrades writes nothing when the title moved after the read', async () => {
    const o = await opportunity()
    await lead(o.id, o.revision, seniors[0] as string)
    const store = createRelevanceStore(db)
    const [c] = await store.candidates(NOW, 1)
    expect(c?.id).toBe(o.id)
    await session.admin.query(`UPDATE job_opportunities SET title_key = $2 WHERE id = $1`, [
      o.id,
      `${o.title.toLowerCase()} moved`,
    ])
    const pair = c?.pairs[0] as { seniorId: string; profileVersion: string }
    await expect(
      store.applyGrades(c as NonNullable<typeof c>, [{ ...pair, fit: 1 }]),
    ).resolves.toBe(false)
    expect(await relevanceOf(o.id)).toEqual([])
    expect(await relevanceDirty(o.id)).toEqual([])
  })

  it('manual, closed and not-yet-evaluated opportunities are never candidates', async () => {
    const manual = await opportunity({ manual: true })
    const closed = await opportunity({ availability: 'CLOSED' })
    const pending = await opportunity({ evaluated: false })
    for (const o of [manual, closed, pending]) await lead(o.id, o.revision, seniors[0] as string)
    const g = fakeGrader(fits(1))
    await expect(pass(g.jev, 3)).resolves.toEqual({ graded: 0, failed: 0, stoppedBy: null })
    expect(g.calls).toHaveLength(0)
    for (const o of [manual, closed, pending]) expect(await relevanceOf(o.id)).toEqual([])
  })
})
