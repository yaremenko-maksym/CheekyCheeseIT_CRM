import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SpecCatalog, specRegistry } from '../../test/ledger-fixtures'
import type { MeterDb } from '../metering/account-meter.store'
import { JobRunLedger } from './job-run-ledger'

/**
 * r5 Task 6.5 — `setEnabled` and the extended `resetFailures` on a scripted transaction, so the
 * mutation gate sees every branch (it never runs `*.integration.spec.ts`). The SQL itself, the
 * fencing of a live owner and the settlement are pinned against real Postgres by
 * job-run-ledger.switch.integration.spec.ts.
 */

const settle = vi.hoisted(() => ({
  lock: vi.fn(async (_tx: unknown, _accountKey: string) => new Map()),
  settle: vi.fn(async (_tx: unknown, _runId: string, _meters: unknown) => 0),
}))

vi.mock('../metering/account-meter.store', async (original) => ({
  ...(await original<typeof import('../metering/account-meter.store')>()),
  lockAccountMeters: settle.lock,
  settleRunReservations: settle.settle,
}))

const dialect = new PgDialect()
const SOURCE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const ACTOR = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const RUN_A = '11111111-1111-4111-8111-111111111111'
const RUN_B = '22222222-2222-4222-8222-222222222222'
const MANIFEST = 'remotive.api.spec'

type Row = Record<string, unknown>

interface Script {
  source?: Row | undefined
  started?: Row[]
  /** Run ids whose lock re-read finds them no longer STARTED. */
  gone?: string[]
}

function harness(script: Script, catalog = readyCatalog()) {
  const statements: { sql: string; params: unknown[] }[] = []
  const execute = vi.fn(async (q: SQL) => {
    const { sql, params } = dialect.sqlToQuery(q)
    statements.push({ sql, params })
    if (sql.includes('FROM job_sources WHERE job_sources.id')) {
      return { rows: script.source === undefined ? [] : [script.source] }
    }
    if (sql.includes('SELECT id, account_key FROM job_collection_runs')) {
      return { rows: script.started ?? [] }
    }
    if (sql.includes('SELECT id FROM job_collection_runs WHERE id')) {
      const id = String(params[0])
      return { rows: (script.gone ?? []).includes(id) ? [] : [{ id }] }
    }
    return { rows: [{ ok: 1 }] }
  })
  const transaction = vi.fn(
    async (cb: (tx: { execute: typeof execute }) => unknown, _opts?: unknown) => cb({ execute }),
  )
  const ledger = new JobRunLedger(
    { execute, transaction } as unknown as MeterDb,
    specRegistry(['REMOTIVE_API', 'ARBEITNOW_API'], ['ARBEITNOW_API']),
    catalog,
  )
  return { ledger, statements, transaction }
}

function readyCatalog(): SpecCatalog {
  const catalog = new SpecCatalog()
  catalog.add(MANIFEST)
  return catalog
}

const source = (over: Row = {}): Row => ({
  type: 'REMOTIVE_API',
  manifest_id: MANIFEST,
  enabled: false,
  readiness: 'CANDIDATE',
  last_error_code: null,
  meter_key: null,
  db_now: '2026-11-04T10:00:00.000Z',
  ...over,
})

const updates = (s: { sql: string }[]) => s.filter((x) => /^\s*UPDATE job_sources/.test(x.sql))
const runUpdates = (s: { sql: string }[]) =>
  s.filter((x) => /^\s*UPDATE job_collection_runs/.test(x.sql))

beforeEach(() => {
  settle.lock.mockClear()
  settle.settle.mockClear()
})

describe('setEnabled — input guards', () => {
  it.each([
    ['a non-uuid source', { sourceId: 'src-1', actor: ACTOR, enabled: true }],
    ['a non-uuid actor', { sourceId: SOURCE, actor: 'admin', enabled: true }],
  ])('%s is a RangeError before any SQL', async (_label, input) => {
    const h = harness({ source: source() })
    await expect(h.ledger.setEnabled(input)).rejects.toThrow(
      new RangeError('setEnabled: invalid id'),
    )
    expect(h.transaction).not.toHaveBeenCalled()
  })

  it('a non-boolean value is a RangeError before any SQL', async () => {
    const h = harness({ source: source() })
    await expect(
      h.ledger.setEnabled({
        sourceId: SOURCE,
        actor: ACTOR,
        enabled: 'true' as unknown as boolean,
      }),
    ).rejects.toThrow(new RangeError('setEnabled: enabled is a boolean'))
    expect(h.transaction).not.toHaveBeenCalled()
  })
})

describe('setEnabled — the locked read', () => {
  it('locks the source row, in READ COMMITTED', async () => {
    const h = harness({ source: source({ enabled: true }) })
    await h.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: true })
    expect(h.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'read committed',
    })
    expect(h.statements[0]?.sql).toContain('FOR UPDATE OF job_sources')
    expect(h.statements[0]?.params).toContain(SOURCE)
  })

  it('an unknown source is NOT_FOUND, nothing written', async () => {
    const h = harness({ source: undefined })
    expect(await h.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: true })).toEqual({
      kind: 'NOT_FOUND',
    })
    expect(h.statements).toHaveLength(1)
  })

  it.each([true, false])(
    'already enabled=%s: unchanged, no audit entry, no run touched',
    async (enabled) => {
      const h = harness({ source: source({ enabled }), started: [{ id: RUN_A, account_key: 'k' }] })
      expect(await h.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled })).toEqual({
        kind: 'SWITCHED',
        changed: false,
        cancelledRuns: 0,
      })
      expect(h.statements).toHaveLength(1)
    },
  )
})

describe('setEnabled — enable', () => {
  it('a ready source is switched on with one ENABLED entry and nothing else written', async () => {
    const h = harness({ source: source() })
    expect(await h.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: true })).toEqual({
      kind: 'SWITCHED',
      changed: true,
      cancelledRuns: 0,
    })
    const [update] = updates(h.statements)
    expect(updates(h.statements)).toHaveLength(1)
    expect(update?.params).toEqual(expect.arrayContaining([true, 'ENABLED', ACTOR, SOURCE]))
    expect(update?.sql).toContain('admin_state_history = admin_state_history || jsonb_build_array')
    // Enable never resets quota, failures, cooldown, the due time, the reasons or readiness.
    for (const column of [
      'budget_used',
      'consecutive_failures',
      'cooldown_until',
      'next_attempt_at',
      'last_error_code',
      'disabled_reason',
      'readiness',
    ]) {
      expect(update?.sql).not.toContain(column)
    }
    // No run is looked at on enable.
    expect(h.statements.some((s) => s.sql.includes('job_collection_runs'))).toBe(false)
  })

  it('a stored BLOCKED readiness refuses NOT_READY, nothing written', async () => {
    const h = harness({ source: source({ readiness: 'BLOCKED' }) })
    expect(await h.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: true })).toEqual({
      kind: 'REFUSED',
      reason: 'NOT_READY',
    })
    expect(updates(h.statements)).toEqual([])
  })

  it('a source the claim gate refuses (no catalog entry) is NOT_READY', async () => {
    const h = harness({ source: source({ manifest_id: 'not.in.catalog' }) })
    expect(await h.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: true })).toEqual({
      kind: 'REFUSED',
      reason: 'NOT_READY',
    })
    expect(updates(h.statements)).toEqual([])
  })

  it('a NULL manifest id has no entry: NOT_READY', async () => {
    const h = harness({ source: source({ manifest_id: null }) })
    expect(
      (await h.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: true })).kind,
    ).toBe('REFUSED')
  })

  it('an unwired transport is NOT_READY', async () => {
    const catalog = new SpecCatalog()
    catalog.add(MANIFEST, { type: 'ARBEITNOW_API' })
    const h = harness({ source: source({ type: 'ARBEITNOW_API' }) }, catalog)
    expect(await h.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: true })).toEqual({
      kind: 'REFUSED',
      reason: 'NOT_READY',
    })
  })

  it('a quota-declared entry without a meter is NOT_READY; with the meter key it passes', async () => {
    const catalog = new SpecCatalog()
    catalog.add(MANIFEST, { quotaDeclared: true })
    const refused = harness({ source: source() }, catalog)
    expect(
      (await refused.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: true })).kind,
    ).toBe('REFUSED')
    const metered = harness({ source: source({ meter_key: 'acct:main' }) }, catalog)
    expect(
      (await metered.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: true })).kind,
    ).toBe('SWITCHED')
  })

  it('an unscheduled (null-profile) entry may still be switched on: the gate is the manual one', async () => {
    const catalog = new SpecCatalog()
    catalog.add(MANIFEST, { fetchProfile: null })
    const h = harness({ source: source() }, catalog)
    expect(
      (await h.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: true })).kind,
    ).toBe('SWITCHED')
  })

  it('an ACCESS_POLICY refusal is AUTH_PAUSED, nothing written', async () => {
    const h = harness({ source: source({ last_error_code: 'ACCESS_POLICY' }) })
    expect(await h.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: true })).toEqual({
      kind: 'REFUSED',
      reason: 'AUTH_PAUSED',
    })
    expect(updates(h.statements)).toEqual([])
  })

  it('a LEGACY source (DOU) has no claim gate: switched on without a manifest entry', async () => {
    const h = harness({ source: source({ type: 'DOU_RSS', manifest_id: null }) })
    expect(
      (await h.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: true })).kind,
    ).toBe('SWITCHED')
  })

  it('a LEGACY source still honours an access pause and a BLOCKED readiness', async () => {
    const auth = harness({
      source: source({ type: 'DOU_RSS', manifest_id: null, last_error_code: 'ACCESS_POLICY' }),
    })
    expect(await auth.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: true })).toEqual(
      { kind: 'REFUSED', reason: 'AUTH_PAUSED' },
    )
    const blocked = harness({
      source: source({ type: 'DOU_RSS', manifest_id: null, readiness: 'BLOCKED' }),
    })
    expect(
      await blocked.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: true }),
    ).toEqual({ kind: 'REFUSED', reason: 'NOT_READY' })
  })

  it('an unreadable database clock fails loudly rather than gating on a guess', async () => {
    const h = harness({ source: source({ db_now: 'not-a-time' }) })
    await expect(
      h.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: true }),
    ).rejects.toThrow('setEnabled: the database clock was unreadable')
  })
})

describe('setEnabled — disable', () => {
  it('switches off with one DISABLED entry and no readiness check', async () => {
    const h = harness({
      source: source({ enabled: true, readiness: 'BLOCKED', last_error_code: 'ACCESS_POLICY' }),
    })
    expect(await h.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: false })).toEqual({
      kind: 'SWITCHED',
      changed: true,
      cancelledRuns: 0,
    })
    const [update] = updates(h.statements)
    expect(update?.params).toEqual(expect.arrayContaining([false, 'DISABLED', ACTOR, SOURCE]))
    expect(updates(h.statements)).toHaveLength(1)
  })

  it('ends every STARTED run CANCELLED, meters locked first, reservations settled', async () => {
    const h = harness({
      source: source({ enabled: true }),
      started: [
        { id: RUN_A, account_key: 'acct:a' },
        { id: RUN_B, account_key: '#source:x' },
      ],
    })
    expect(await h.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: false })).toEqual({
      kind: 'SWITCHED',
      changed: true,
      cancelledRuns: 2,
    })
    const pick = h.statements.find((s) => s.sql.includes('SELECT id, account_key'))
    expect(pick?.sql).toContain("outcome = 'STARTED'")
    expect(pick?.params).toContain(SOURCE)
    expect(settle.lock.mock.calls.map((c) => c[1])).toEqual(['acct:a', '#source:x'])
    expect(settle.settle.mock.calls.map((c) => c[1])).toEqual([RUN_A, RUN_B])
    const ended = runUpdates(h.statements)
    expect(ended.map((u) => u.params)).toEqual([[RUN_A], [RUN_B]])
    expect(ended[0]?.sql).toContain("outcome = 'CANCELLED', error_code = 'CANCELLED'")
    expect(ended[0]?.sql).toContain('ended_at = clock_timestamp()')
  })

  it('a run that ended between the pick and its lock is skipped, not counted', async () => {
    const h = harness({
      source: source({ enabled: true }),
      started: [
        { id: RUN_A, account_key: 'acct:a' },
        { id: RUN_B, account_key: 'acct:b' },
      ],
      gone: [RUN_A],
    })
    expect(await h.ledger.setEnabled({ sourceId: SOURCE, actor: ACTOR, enabled: false })).toEqual({
      kind: 'SWITCHED',
      changed: true,
      cancelledRuns: 1,
    })
    expect(settle.settle.mock.calls.map((c) => c[1])).toEqual([RUN_B])
    expect(runUpdates(h.statements).map((u) => u.params)).toEqual([[RUN_B]])
    const relock = h.statements.filter((s) => s.sql.includes('SELECT id FROM job_collection_runs'))
    expect(relock[0]?.sql).toContain("outcome = 'STARTED' FOR UPDATE")
  })
})

describe('resetFailures — clears an access pause, audited (Task 6.5)', () => {
  it('clears ACCESS_POLICY only, and names it in the entry; other entries keep their shape', async () => {
    const h = harness({})
    expect(
      await h.ledger.resetFailures({ sourceId: SOURCE, actor: ACTOR, reason: 'rekeyed' }),
    ).toBe(true)
    const [reset] = h.statements
    expect(reset?.sql).toContain('last_error_code = CASE WHEN last_error_code = $1::text THEN NULL')
    expect(reset?.sql).toContain("'clearedErrorCode', CASE WHEN last_error_code = ")
    expect(reset?.sql).toContain('jsonb_strip_nulls(jsonb_build_object(')
    expect(reset?.params).toEqual(
      expect.arrayContaining(['ACCESS_POLICY', ACTOR, 'rekeyed', SOURCE]),
    )
  })
})
