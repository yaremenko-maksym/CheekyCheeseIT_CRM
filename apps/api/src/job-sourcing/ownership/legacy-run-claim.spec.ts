import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import { specRegistry } from '../../test/ledger-fixtures'
import { JobSourceDeliberateStopError } from '../source-budget.error'
import { JobRunLedger } from './job-run-ledger'
import { validateEnding } from './ledger-policy'
import {
  JobSourceRunBusyError,
  LEGACY_RUN_ADAPTER_VERSION,
  isLegacyKind,
  legacyClaimRefusal,
} from './legacy-run-claim'

/**
 * Task 4.6 S6c — the LEGACY claim and the run-row-only ending, over a database double that records
 * the SQL it is handed (the mutation gate runs no integration spec;
 * `legacy-run-claim.integration.spec.ts` runs the same paths on Postgres).
 */
const dialect = new PgDialect()
const registry = specRegistry(['REMOTIVE_API'])
const SOURCE = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const CYCLE = '1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e'
const ACTOR = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f'
const RUN = '3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a'

describe('legacyClaimRefusal', () => {
  const dou = registry.get('DOU_RSS')
  const row = { enabled: true, trigger_mode: 'BOTH' }

  it('accepts an enabled LEGACY source whose trigger mode admits the cycle`s trigger', () => {
    expect(legacyClaimRefusal(dou, row, 'SCHEDULED')).toBeNull()
    expect(legacyClaimRefusal(dou, row, 'MANUAL')).toBeNull()
    expect(legacyClaimRefusal(dou, { ...row, trigger_mode: 'MANUAL' }, 'MANUAL')).toBeNull()
  })

  it('refuses every kind but LEGACY first, whatever else the row says', () => {
    expect(legacyClaimRefusal(registry.get('REMOTIVE_API'), row, 'MANUAL')).toBe('NOT_ACTIVATABLE')
    expect(legacyClaimRefusal(undefined, row, 'MANUAL')).toBe('NOT_ACTIVATABLE')
    expect(legacyClaimRefusal(registry.get('REMOTIVE_API'), { enabled: false }, 'MANUAL')).toBe(
      'NOT_ACTIVATABLE',
    )
  })

  it('refuses a disabled source (only a literal true is enabled), then a trigger it does not take', () => {
    expect(legacyClaimRefusal(dou, { ...row, enabled: false }, 'MANUAL')).toBe('DISABLED')
    expect(legacyClaimRefusal(dou, { ...row, enabled: null }, 'MANUAL')).toBe('DISABLED')
    expect(legacyClaimRefusal(dou, { ...row, enabled: 'true' }, 'MANUAL')).toBe('DISABLED')
    expect(legacyClaimRefusal(dou, { enabled: false, trigger_mode: 'MANUAL' }, 'SCHEDULED')).toBe(
      'DISABLED',
    )
    expect(legacyClaimRefusal(dou, { ...row, trigger_mode: 'MANUAL' }, 'SCHEDULED')).toBe(
      'TRIGGER_MODE',
    )
    expect(legacyClaimRefusal(dou, { ...row, trigger_mode: 'SCHEDULED' }, 'MANUAL')).toBe(
      'TRIGGER_MODE',
    )
  })

  it('isLegacyKind: the LEGACY contract only', () => {
    expect(isLegacyKind(dou)).toBe(true)
    expect(isLegacyKind(registry.get('REMOTIVE_API'))).toBe(false)
    expect(isLegacyKind(undefined)).toBe(false)
  })
})

describe('validateEnding over the DOU bridge ADR`s "Golden behaviour" table (AC 5)', () => {
  it.each([
    ['provider throws', 'FAILED', 'UPSTREAM'],
    ['zero postings', 'FAILED', 'PARSE_DRIFT'],
    ['exhausted budget', 'PARTIAL', 'COST_STOP'],
    ['budget contention', 'CANCELLED', 'CANCELLED'],
    ['a clean run', 'SUCCEEDED', null],
  ] as const)('accepts %s: %s / %s', (_l, outcome, code) => {
    expect(() => validateEnding(outcome, code)).not.toThrow()
  })

  it.each([
    ['PARTIAL', 'CANCELLED'],
    ['CANCELLED', 'COST_STOP'],
    ['FAILED', 'LEASE_EXPIRED'],
  ] as const)('refuses the swapped pair %s / %s', (outcome, code) => {
    expect(() => validateEnding(outcome, code)).toThrow(RangeError)
  })
})

describe('JobSourceRunBusyError', () => {
  it('is a deliberate stop that is not an exhausted budget, naming the source', () => {
    const e = new JobSourceRunBusyError(SOURCE)
    expect(e).toBeInstanceOf(JobSourceDeliberateStopError)
    expect(e.budgetExhausted).toBe(false)
    expect(e.sourceId).toBe(SOURCE)
    expect(e.name).toBe('JobSourceRunBusyError')
    expect(e.message).toBe(
      `Source ${SOURCE}: a collection is already running, so this one did not start and spent nothing.`,
    )
  })

  it('names the DOU provider version the run row records', () => {
    expect(LEGACY_RUN_ADAPTER_VERSION).toBe('dou-rss-legacy/1')
  })
})

type Rows = Record<string, unknown>[]

/** A ledger over a double whose transaction answers each statement by `answer`. */
function ledgerOver(answer: (text: string) => Rows | Error) {
  const seen: string[] = []
  const params: unknown[][] = []
  const execute = vi.fn(async (q: SQL) => {
    const { sql: text, params: p } = dialect.sqlToQuery(q)
    seen.push(text)
    params.push(p)
    const a = answer(text)
    if (a instanceof Error) throw a
    return { rows: a }
  })
  // The meter / reservation reads go through drizzle's builder: every chain resolves to no rows.
  const chain: unknown = new Proxy(() => undefined, {
    get: (_t, p) => (p === 'then' ? (resolve: (v: unknown) => void) => resolve([]) : () => chain),
  })
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>, config: unknown) => {
    expect(config).toEqual({ isolationLevel: 'read committed' })
    return fn({ execute, select: () => chain })
  })
  const ledger = new JobRunLedger({ execute, transaction } as never, registry, {
    entry: () => undefined,
    hostPolicy: () => undefined,
    onDemandTypes: () => [],
  } as never)
  return { ledger, seen, params, transaction }
}

const cycleRow = (trigger: string, requestedBy: string | null) => ({
  id: CYCLE,
  trigger,
  requested_by: requestedBy,
})

const sourceRow = (over: Record<string, unknown> = {}) => ({
  id: SOURCE,
  type: 'DOU_RSS',
  enabled: true,
  trigger_mode: 'BOTH',
  run_account_key: `#source:${SOURCE}`,
  ...over,
})

function claimAnswers(cycle: Rows, source: Rows, insert: Rows | Error = []) {
  return (text: string): Rows | Error => {
    if (text.includes('FROM job_collection_cycles')) return cycle
    if (text.startsWith('SELECT job_sources.*')) return source
    if (text.includes('INSERT INTO job_collection_runs')) return insert
    return []
  }
}

const runRow = [{ id: RUN, fencing_epoch: 4, checkpoint: {}, account_key: `#source:${SOURCE}` }]
const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { cause: { code } })

describe('JobRunLedger.claimLegacyRun', () => {
  const manual = { cycleId: CYCLE, owner: 'dou-bridge', sourceId: SOURCE, actor: ACTOR }

  it('claims a LEGACY source: lock_timeout, the locked row with its account key, the run insert', async () => {
    const { ledger, seen, params } = ledgerOver(
      claimAnswers([cycleRow('MANUAL', ACTOR)], [sourceRow()], runRow),
    )
    const claim = await ledger.claimLegacyRun(manual)
    expect(claim.kind).toBe('CLAIMED')
    if (claim.kind !== 'CLAIMED') return
    expect(claim.run).toMatchObject({
      runId: RUN,
      fencingEpoch: 4,
      sourceId: SOURCE,
      cycleId: CYCLE,
      accountKey: `#source:${SOURCE}`,
      sourceType: 'DOU_RSS',
      checkpoint: null,
    })
    expect(claim.run.ownerToken.startsWith('dou-bridge:')).toBe(true)
    expect(seen[1]).toBe(`SELECT set_config('lock_timeout', $1, true)`)
    expect(params[1]).toEqual(['2000ms'])
    expect(seen[2]).toBe(
      `SELECT job_sources.*, COALESCE((SELECT m.account_key FROM job_account_meters m WHERE m.id = job_sources.account_meter_id), '#source:' || job_sources.id::text) AS run_account_key
            FROM job_sources WHERE job_sources.id = $1::uuid FOR UPDATE OF job_sources`,
    )
    expect(params[2]).toEqual([SOURCE])
    const insert = seen.findIndex((s) => s.includes('INSERT INTO job_collection_runs'))
    expect(params[insert]).toContain(LEGACY_RUN_ADAPTER_VERSION)
    expect(params[insert]).toContain(`#source:${SOURCE}`)
    expect(params[insert]).toContain('MANUAL')
  })

  it('a scheduled cycle needs no actor and claims the same way', async () => {
    const { ledger } = ledgerOver(
      claimAnswers([cycleRow('SCHEDULED', null)], [sourceRow()], runRow),
    )
    const claim = await ledger.claimLegacyRun({ cycleId: CYCLE, owner: 'dou', sourceId: SOURCE })
    expect(claim.kind).toBe('CLAIMED')
  })

  it.each([
    ['a REPORTING source', sourceRow({ type: 'REMOTIVE_API' }), 'NOT_ACTIVATABLE'],
    ['a disabled source', sourceRow({ enabled: false }), 'DISABLED'],
    [
      'a scheduled-only source on a manual cycle',
      sourceRow({ trigger_mode: 'SCHEDULED' }),
      'TRIGGER_MODE',
    ],
  ])('refuses %s and inserts nothing', async (_label, row, reason) => {
    const { ledger, seen } = ledgerOver(claimAnswers([cycleRow('MANUAL', ACTOR)], [row], runRow))
    expect(await ledger.claimLegacyRun(manual)).toEqual({ kind: 'REFUSED', reason })
    expect(seen.some((s) => /^\s*(INSERT|UPDATE|DELETE)/.test(s))).toBe(false)
  })

  it('refuses a source that does not exist, and an id that is not a uuid before any statement', async () => {
    const missing = ledgerOver(claimAnswers([cycleRow('MANUAL', ACTOR)], []))
    expect(await missing.ledger.claimLegacyRun(manual)).toEqual({
      kind: 'REFUSED',
      reason: 'NOT_FOUND',
    })
    const bad = ledgerOver(() => [])
    expect(await bad.ledger.claimLegacyRun({ ...manual, sourceId: 'x' })).toEqual({
      kind: 'REFUSED',
      reason: 'NOT_FOUND',
    })
    expect(bad.seen).toEqual([])
  })

  it('a single-flight violation (23505) is the typed busy stop; a lock timeout is a refusal', async () => {
    const busy = ledgerOver(
      claimAnswers([cycleRow('MANUAL', ACTOR)], [sourceRow()], pgError('23505')),
    )
    const error = await busy.ledger.claimLegacyRun(manual).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(JobSourceRunBusyError)
    expect((error as JobSourceRunBusyError).sourceId).toBe(SOURCE)
    const locked = ledgerOver((text) =>
      text.startsWith('SELECT job_sources.*')
        ? pgError('55P03')
        : claimAnswers([cycleRow('MANUAL', ACTOR)], [])(text),
    )
    expect(await locked.ledger.claimLegacyRun(manual)).toEqual({
      kind: 'REFUSED',
      reason: 'LOCK_TIMEOUT',
    })
    const other = ledgerOver(
      claimAnswers([cycleRow('MANUAL', ACTOR)], [sourceRow()], pgError('23503')),
    )
    await expect(other.ledger.claimLegacyRun(manual)).rejects.toThrow('pg 23503')
  })

  it('a manual cycle names its own actor; a scheduled one takes none; an invalid owner is refused', async () => {
    const mismatch = ledgerOver(claimAnswers([cycleRow('MANUAL', ACTOR)], [sourceRow()]))
    await expect(mismatch.ledger.claimLegacyRun({ ...manual, actor: SOURCE })).rejects.toThrow(
      'claimLegacyRun: a manual cycle needs its own actor, a scheduled one none',
    )
    await expect(
      mismatch.ledger.claimLegacyRun({ cycleId: CYCLE, owner: 'dou', sourceId: SOURCE }),
    ).rejects.toThrow(RangeError)
    const scheduled = ledgerOver(claimAnswers([cycleRow('SCHEDULED', null)], [sourceRow()]))
    await expect(scheduled.ledger.claimLegacyRun(manual)).rejects.toThrow(RangeError)
    expect(scheduled.transaction).not.toHaveBeenCalled()
    await expect(
      scheduled.ledger.claimLegacyRun({ ...manual, owner: 'Bad Owner' }),
    ).rejects.toThrow('invalid owner')
  })
})

describe('the run-row-only ending (finish / recoverExpired of a LEGACY run)', () => {
  const handle = { runId: RUN, ownerToken: 'dou:t', fencingEpoch: 4 }

  function endAnswers(type: string) {
    return (text: string): Rows => {
      if (text.startsWith('SELECT id, source_id, account_key')) {
        return [{ id: RUN, source_id: SOURCE, account_key: `#source:${SOURCE}` }]
      }
      if (text.startsWith('SELECT id FROM job_collection_runs')) return [{ id: RUN }]
      if (text.includes('slowdown_level FROM job_sources')) {
        return [{ type, manifest_id: null, consecutive_failures: 0, slowdown_level: 0 }]
      }
      if (text.startsWith('SELECT r.received')) return [{ received: 0, paged: false }]
      if (text.startsWith('SELECT clock_timestamp()')) return [{ db_now: '2026-10-31T05:00:00Z' }]
      return []
    }
  }

  const sourceWrites = (seen: string[]) => seen.filter((s) => /UPDATE job_sources/.test(s))
  const runWrite = (seen: string[]) =>
    seen.filter((s) => /^\s*UPDATE job_collection_runs\s+SET outcome/.test(s))

  it.each([
    ['FAILED / UPSTREAM', { outcome: 'FAILED', errorCode: 'UPSTREAM' }],
    ['FAILED / PARSE_DRIFT', { outcome: 'FAILED', errorCode: 'PARSE_DRIFT' }],
    ['PARTIAL / COST_STOP', { outcome: 'PARTIAL', errorCode: 'COST_STOP' }],
    ['CANCELLED / CANCELLED', { outcome: 'CANCELLED', errorCode: 'CANCELLED' }],
    ['SUCCEEDED', { outcome: 'SUCCEEDED', errorCode: null }],
  ] as const)('finish %s writes the run row and never job_sources', async (_l, ending) => {
    const { ledger, seen, params } = ledgerOver(endAnswers('DOU_RSS'))
    await ledger.finish(handle, ending)
    expect(sourceWrites(seen)).toEqual([])
    const i = seen.findIndex((s) => /UPDATE job_collection_runs\s+SET outcome/.test(s))
    expect(runWrite(seen)).toHaveLength(1)
    expect(params[i]?.slice(0, 2)).toEqual([ending.outcome, ending.errorCode])
  })

  it('recoverExpired of a LEGACY run ends it FAILED / LEASE_EXPIRED on the run row only', async () => {
    const { ledger, seen, params } = ledgerOver(endAnswers('DOU_RSS'))
    expect(await ledger.recoverExpired()).toBe(1)
    expect(sourceWrites(seen)).toEqual([])
    const i = seen.findIndex((s) => /UPDATE job_collection_runs\s+SET outcome/.test(s))
    expect(params[i]?.slice(0, 2)).toEqual(['FAILED', 'LEASE_EXPIRED'])
  })

  it('a REPORTING run still writes its failure accounting (unchanged)', async () => {
    const { ledger, seen } = ledgerOver(endAnswers('REMOTIVE_API'))
    await ledger.finish(handle, { outcome: 'FAILED', errorCode: 'UPSTREAM' })
    expect(sourceWrites(seen)).toHaveLength(1)
    expect(sourceWrites(seen)[0]).toMatch(/consecutive_failures = consecutive_failures \+ 1/)
    const rec = ledgerOver(endAnswers('REMOTIVE_API'))
    expect(await rec.ledger.recoverExpired()).toBe(1)
    expect(sourceWrites(rec.seen)).toHaveLength(1)
  })
})
