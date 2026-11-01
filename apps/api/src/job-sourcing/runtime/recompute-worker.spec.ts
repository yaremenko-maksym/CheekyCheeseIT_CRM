import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as funnel from '../funnel/evaluate'
import type { MeterDb } from '../metering/account-meter.store'
import {
  type ClaimedDirtyWork,
  type CompleteOutcome,
  DirtyWorkFencedError,
  type FailOutcome,
  type RetryOptions,
} from '../ownership/dirty-work.store'
import { CanonicalStateError } from '../store/canonical.store'
import { LockContentionError } from '../store/lock-order'
import {
  RECOMPUTE_YIELD_EVERY,
  type RecomputeBatch,
  RecomputeNotReadyError,
  RecomputePoisonError,
  type RecomputeSteps,
  RecomputeWorker,
  classifyFailure,
  createRecomputeSteps,
} from './recompute-worker'

vi.mock('../funnel/evaluate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../funnel/evaluate')>()
  return { ...actual, evaluate: vi.fn(actual.evaluate) }
})

/**
 * r5 Task 4.6 S4a — the recompute worker: the orchestration against a steps double (failure
 * classes, fencing, ordering, the event-loop yield), and the real steps against a recording
 * transaction double (version compare, atomic completion, install). The same against a real
 * Postgres: `recompute-worker.integration.spec.ts`.
 */

const work = (
  n: number,
  kind: ClaimedDirtyWork['entityKind'] = 'OPPORTUNITY',
): ClaimedDirtyWork => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  owner: 'spec',
  fencingEpoch: 1,
  entityKind: kind,
  entityId: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
  targetVersion: 1,
  reason: 'SPEC',
  retryCount: 0,
})

interface Fake {
  steps: RecomputeSteps
  processed: string[]
  failed: [string, string, RetryOptions][]
  claims: [string, number][]
  batches: RecomputeBatch[]
}

function fakeSteps(
  claimed: ClaimedDirtyWork[],
  process: (w: ClaimedDirtyWork) => Promise<CompleteOutcome> | CompleteOutcome = () => 'DONE',
  fail: (w: ClaimedDirtyWork) => Promise<FailOutcome> | FailOutcome = () => 'RETRY',
): Fake {
  const f: Fake = { processed: [], failed: [], claims: [], batches: [], steps: undefined as never }
  f.steps = {
    async claim(owner, batchSize) {
      f.claims.push([owner, batchSize])
      return claimed
    },
    async process(w, batch) {
      f.processed.push(w.id)
      f.batches.push(batch)
      return process(w)
    },
    async fail(w, code, opts) {
      f.failed.push([w.id, code, opts])
      return fail(w)
    },
  }
  return f
}

const NOW = new Date('2026-10-26T10:00:00Z')
const worker = (f: Fake, extra: Partial<ConstructorParameters<typeof RecomputeWorker>[1]> = {}) =>
  new RecomputeWorker(f.steps, { owner: 'spec-owner', now: () => NOW, ...extra })

describe('RecomputeWorker.runOnce: claim and ordering', () => {
  it('claims the initial batch of 200 for its owner; an empty batch does nothing', async () => {
    const f = fakeSteps([])
    expect(await worker(f).runOnce()).toEqual({
      claimed: 0,
      done: 0,
      deferred: 0,
      retried: 0,
      failed: 0,
      fenced: 0,
    })
    expect(f.claims).toEqual([['spec-owner', 200]])
    expect(f.processed).toEqual([])
    await worker(f, { batchSize: 7 }).runOnce()
    expect(f.claims[1]).toEqual(['spec-owner', 7])
  })

  it('resolves the batch records before any opportunity, keeping claim order within a kind', async () => {
    const rows = [work(1), work(2, 'SOURCE_RECORD'), work(3), work(4, 'SOURCE_RECORD')]
    const f = fakeSteps(rows)
    await worker(f).runOnce()
    expect(f.processed).toEqual([rows[1]?.id, rows[3]?.id, rows[0]?.id, rows[2]?.id])
  })

  it('counts DONE and DEFERRED; every row shares one batch and one evaluation time', async () => {
    const rows = [work(1), work(2), work(3)]
    const f = fakeSteps(rows, (w) => (w === rows[1] ? 'DEFERRED' : 'DONE'))
    expect(await worker(f).runOnce()).toEqual({
      claimed: 3,
      done: 2,
      deferred: 1,
      retried: 0,
      failed: 0,
      fenced: 0,
    })
    expect(new Set(f.batches).size).toBe(1)
    expect(f.batches[0]?.evaluationTime).toBe(NOW)
  })

  it('without a clock the evaluation time is the time of the run', async () => {
    const f = fakeSteps([work(1)])
    const before = Date.now()
    await new RecomputeWorker(f.steps, { owner: 'o' }).runOnce()
    const t = f.batches[0]?.evaluationTime.getTime() as number
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(Date.now())
  })
})

describe('RecomputeWorker.runOnce: failure classes (AC 3, 4)', () => {
  it('a poison row is failed with ONE attempt and the batch goes on', async () => {
    const rows = [work(1), work(2), work(3)]
    const f = fakeSteps(
      rows,
      (w) => {
        if (w === rows[1]) throw new RecomputePoisonError('INVALID_REVISION')
        return 'DONE'
      },
      () => 'FAILED',
    )
    expect(await worker(f).runOnce()).toMatchObject({ done: 2, failed: 1, retried: 0 })
    expect(f.failed).toEqual([[rows[1]?.id, 'INVALID_REVISION', { maxAttempts: 1 }]])
    expect(f.processed).toHaveLength(3)
  })

  it('an infrastructure error is failed with the default attempts: RETRY, then FAILED when spent', async () => {
    const rows = [work(1), work(2)]
    const contention = new LockContentionError('55P03', 3, null)
    const f = fakeSteps(
      rows,
      () => {
        throw contention
      },
      (w) => (w === rows[0] ? 'RETRY' : 'FAILED'),
    )
    expect(await worker(f).runOnce()).toMatchObject({ retried: 1, failed: 1, done: 0 })
    expect(f.failed).toEqual([
      [rows[0]?.id, 'LOCK_CONTENTION', {}],
      [rows[1]?.id, 'LOCK_CONTENTION', {}],
    ])
  })

  it('a fenced row is neither failed nor completed, and the batch goes on', async () => {
    const rows = [work(1), work(2)]
    const f = fakeSteps(rows, (w) => {
      if (w === rows[0]) throw new DirtyWorkFencedError()
      return 'DONE'
    })
    expect(await worker(f).runOnce()).toMatchObject({ fenced: 1, done: 1, failed: 0, retried: 0 })
    expect(f.failed).toEqual([])
  })

  it('a fence lost while recording the failure counts as fenced', async () => {
    const rows = [work(1), work(2)]
    const f = fakeSteps(
      rows,
      () => {
        throw new Error('boom')
      },
      (w) => {
        if (w === rows[0]) throw new DirtyWorkFencedError()
        return 'RETRY'
      },
    )
    expect(await worker(f).runOnce()).toMatchObject({ fenced: 1, retried: 1 })
  })

  it('a failure that cannot be recorded ends the batch (the lease returns the rest)', async () => {
    const rows = [work(1), work(2)]
    const down = new Error('connection terminated')
    const f = fakeSteps(
      rows,
      () => {
        throw new Error('boom')
      },
      () => {
        throw down
      },
    )
    await expect(worker(f).runOnce()).rejects.toBe(down)
    expect(f.processed).toEqual([rows[0]?.id])
  })
})

describe('classifyFailure', () => {
  const pg = (code: string) => Object.assign(new Error('pg'), { code, severity: 'ERROR' })

  it.each([
    ['poison error', new RecomputePoisonError('EVALUATION_THREW'), 'EVALUATION_THREW', true],
    ['input not ready', new RecomputeNotReadyError('ROSTER_NOT_READY'), 'ROSTER_NOT_READY', false],
    [
      'canonical state',
      new CanonicalStateError('OPPORTUNITY_NOT_FOUND'),
      'OPPORTUNITY_NOT_FOUND',
      true,
    ],
    ['lock contention', new LockContentionError('40P01', 3, null), 'LOCK_CONTENTION', false],
    ['data exception', pg('22P02'), 'PG_22P02', true],
    ['connection failure', pg('08006'), 'PG_08006', false],
    ['statement timeout', pg('57014'), 'PG_57014', false],
    ['foreign key', pg('23503'), 'PG_23503', false],
    // CR-M-2: a bare RangeError may be the runtime's own; poison needs an explicit marker.
    ['a range error', new RangeError('bad'), 'RECOMPUTE_ERROR', false],
    [
      'a stack overflow',
      new RangeError('Maximum call stack size exceeded'),
      'RECOMPUTE_ERROR',
      false,
    ],
    ['anything else', new TypeError('x'), 'RECOMPUTE_ERROR', false],
    ['a non-error', 'oops', 'RECOMPUTE_ERROR', false],
  ])('%s', (_name, err, code, poison) => {
    expect(classifyFailure(err)).toEqual({ code, poison })
  })

  it('a malformed SQLSTATE is not trusted as a code', () => {
    expect(
      classifyFailure(Object.assign(new Error('x'), { code: '22', severity: 'ERROR' })),
    ).toEqual({
      code: 'RECOMPUTE_ERROR',
      poison: false,
    })
    expect(
      classifyFailure(Object.assign(new RangeError('x'), { code: 'lower', severity: 'ERROR' })),
    ).toEqual({ code: 'RECOMPUTE_ERROR', poison: false })
  })

  it('the typed errors name themselves', () => {
    expect(new RecomputePoisonError('X')).toMatchObject({
      name: 'RecomputePoisonError',
      message: 'recompute refused the record: X',
    })
    expect(new RecomputeNotReadyError('Y')).toMatchObject({
      name: 'RecomputeNotReadyError',
      message: 'recompute input not ready: Y',
    })
  })
})

describe('event-loop yield (AC 6)', () => {
  /** Busy for `ms` of wall clock: CPU-bound work that never yields on its own. */
  const spin = (ms: number) => {
    const end = performance.now() + ms
    while (performance.now() < end) {
      /* evaluation-sized CPU work */
    }
  }

  /**
   * While `run` is in flight: the longest the event loop went without running a 1 ms timer
   * (`lag`), and how many times that timer got to run at all (`ticks`). A timer can only run
   * when the loop is given back, so `ticks` counts the yields whatever the machine's load.
   */
  async function maxLag(
    run: () => Promise<unknown>,
  ): Promise<{ lag: number; total: number; ticks: number }> {
    let last = performance.now()
    let lag = 0
    let ticks = 0
    let measuring = false
    const probe = setInterval(() => {
      const now = performance.now()
      lag = Math.max(lag, now - last)
      last = now
      if (measuring) ticks += 1
    }, 1)
    await new Promise((r) => setTimeout(r, 5))
    last = performance.now()
    lag = 0
    measuring = true
    const start = performance.now()
    await run()
    measuring = false
    const total = performance.now() - start
    lag = Math.max(lag, performance.now() - last)
    clearInterval(probe)
    return { lag, total, ticks }
  }

  const PER_ROW_MS = 4
  const ROWS = 200
  const batch = Array.from({ length: ROWS }, (_, i) => work(i + 1))
  const spinning = () =>
    fakeSteps(batch, () => {
      spin(PER_ROW_MS)
      return 'DONE'
    })

  it('yields every 50 rows: probe ticks within [2, 6], and the no-yield control has 0 ticks', async () => {
    expect(RECOMPUTE_YIELD_EVERY).toBe(50)
    // Measured back to back so both runs share the machine's load. Only the tick count is
    // load-independent, so it carries the proof; wall-clock thresholds flake under load.
    const yielding = await maxLag(() => worker(spinning()).runOnce())
    const control = await maxLag(() => worker(spinning(), { yieldEvery: ROWS }).runOnce())
    // 200 rows x 4 ms = 800 ms of CPU work in four 50-row stretches.
    expect(yielding.total).toBeGreaterThanOrEqual(ROWS * PER_ROW_MS)
    // Sensitivity: without a yield the probe sees the whole batch as one stall, and never runs.
    expect(control.lag).toBeGreaterThanOrEqual(ROWS * PER_ROW_MS * 0.9)
    expect(control.ticks).toBe(0)
    // With the yield: the loop is given back between the four stretches (3 yields), not per row.
    // 2, not 3, at the low end: a batch that starts inside a timers-phase callback resumes its
    // first yield in the check phase of the same loop iteration, before any timer can run.
    expect(yielding.ticks).toBeGreaterThanOrEqual(2)
    expect(yielding.ticks).toBeLessThanOrEqual(6)
    // No wall-clock lag ratio here: it flaked under CI load (601 ms vs a 563 ms bound), and the
    // tick count already separates the mutants. Yield on every row gives ~200 ticks; never
    // yielding gives 0; a missing counter reset yields once, so 1 tick: too few.
  })
})

// ---------------------------------------------------------------------------------------------
// The real steps over a recording transaction double.
// ---------------------------------------------------------------------------------------------

const dialect = new PgDialect()
type Query = { sql: string; params: unknown[] }
type Answer = (q: Query) => Record<string, unknown>[]

function recordingDb(answer: Answer) {
  const seen = { transactions: 0, statements: [] as Query[] }
  const execute = async (query: SQL) => {
    const q = dialect.sqlToQuery(query)
    seen.statements.push(q)
    return { rows: answer(q) }
  }
  const db = {
    execute,
    async transaction(fn: (tx: unknown) => Promise<unknown>) {
      seen.transactions += 1
      return fn({ execute })
    },
  } as unknown as MeterDb
  const did = (re: RegExp) => seen.statements.filter((s) => re.test(s.sql))
  return { db, seen, did }
}

const SENIOR = '00000000-0000-4000-8000-0000000000aa'
const opportunityRow = (over: Record<string, unknown> = {}) => ({
  id: work(1).entityId,
  revision: 1,
  title: 'Senior Go Engineer',
  employer_name: 'Acme',
  location: null,
  stack_keywords: [],
  application_url: 'https://acme.test/apply',
  availability: 'OPEN',
  first_seen_at: new Date('2026-10-20T00:00:00Z'),
  description: 'Build things.',
  normalized: { dates: [], remote: null },
  evidence: { fields: [] },
  source_type: 'REMOTIVE_API',
  source_url: 'https://acme.test/job',
  grants: [],
  ...over,
})

interface World {
  seq?: number | null
  completes?: boolean
  opportunity?: Record<string, unknown>
  /** The revision the install transaction's lock reads; null = the opportunity is gone. */
  lockRevision?: number | null
  /** Called on every roster read; throw to fail it. */
  onRoster?: () => void
}

const world =
  ({
    seq = 1,
    completes = true,
    opportunity = opportunityRow(),
    lockRevision = 1,
    onRoster = () => {},
  }: World): Answer =>
  (q) => {
    if (/^\s*WITH cur AS/.test(q.sql)) return completes ? [{ status: 'DONE' }] : []
    if (/SET retry_count = retry_count \+ 1/.test(q.sql)) return [{ status: 'PENDING' }]
    if (/WITH picked AS/.test(q.sql))
      return [
        {
          id: work(9).id,
          entity_kind: 'OPPORTUNITY',
          entity_id: work(9).entityId,
          target_version: 3,
          reason: 'R',
          fencing_epoch: 2,
          retry_count: 0,
        },
      ]
    if (/FROM job_source_record_heads/.test(q.sql))
      return seq === null ? [] : [{ observation_seq: seq }]
    if (/FROM job_opportunities o/.test(q.sql)) return [opportunity]
    if (/FROM job_opportunities WHERE id = .* FOR NO KEY UPDATE$/.test(q.sql))
      return lockRevision === null ? [] : [{ revision: lockRevision }]
    if (/FROM users u JOIN team_members/.test(q.sql)) {
      onRoster()
      return [
        { id: SENIOR, tech_stack: ['Go'], team_ids: ['00000000-0000-4000-8000-0000000000t1'] },
      ]
    }
    return []
  }

const batchAt = (): RecomputeBatch => ({ evaluationTime: NOW })

describe('createRecomputeSteps: claim and fail through the store', () => {
  it('claims for the owner with the batch size, and maps the rows', async () => {
    const { db, did } = recordingDb(world({}))
    const [claimed] = await createRecomputeSteps(db).claim('own', 17)
    expect(did(/WITH picked AS/)[0]?.params).toContain('own')
    expect(did(/WITH picked AS/)[0]?.params).toContain(17)
    expect(claimed).toMatchObject({ owner: 'own', fencingEpoch: 2, targetVersion: 3 })
  })

  it('fails with the given attempts, or the store default (5)', async () => {
    const { db, did } = recordingDb(world({}))
    const steps = createRecomputeSteps(db)
    expect(await steps.fail(work(1), 'PG_08006', { maxAttempts: 1 })).toBe('RETRY')
    await steps.fail(work(1), 'PG_08006', {})
    const [one, dflt] = did(/SET retry_count = retry_count \+ 1/)
    // retry_count + 1 >= $1 (twice), then the error code.
    expect(one?.params.slice(0, 3)).toEqual([1, 1, 'PG_08006'])
    expect(dflt?.params.slice(0, 3)).toEqual([5, 5, 'PG_08006'])
  })
})

describe('createRecomputeSteps: SOURCE_RECORD (AC 4, 5)', () => {
  const rec = work(2, 'SOURCE_RECORD')

  it('a current record is resolved and completed in ONE transaction under the lock timeout', async () => {
    const { db, seen, did } = recordingDb(world({ seq: 1 }))
    expect(await createRecomputeSteps(db).process(rec, batchAt())).toBe('DONE')
    expect(seen.transactions).toBe(1)
    expect(seen.statements[0]?.sql).toBe(`SET LOCAL lock_timeout = '5000ms'`)
    expect(did(/FROM job_source_records WHERE id IN .* FOR UPDATE/)).toHaveLength(1)
    expect(did(/^\s*WITH cur AS/)).toHaveLength(1)
  })

  it.each([
    ['moved on', 2],
    ['without a head (gone)', null],
  ])('a record that %s is completed without resolving', async (_n, seq) => {
    const { db, did } = recordingDb(world({ seq }))
    await createRecomputeSteps(db).process(rec, batchAt())
    expect(did(/FOR UPDATE/)).toEqual([])
    expect(did(/^\s*WITH cur AS/)).toHaveLength(1)
  })

  it('a lost fence surfaces as DirtyWorkFencedError (the transaction rolls back)', async () => {
    const { db } = recordingDb(world({ completes: false }))
    await expect(createRecomputeSteps(db).process(rec, batchAt())).rejects.toBeInstanceOf(
      DirtyWorkFencedError,
    )
  })
})

describe('createRecomputeSteps: OPPORTUNITY (AC 1, 2, 3)', () => {
  const evaluate = vi.mocked(funnel.evaluate)
  afterEach(() => evaluate.mockClear())

  it('locks the opportunity FIRST, then reads it and the roster, evaluates, installs, completes — one transaction', async () => {
    const { db, seen, did } = recordingDb(world({}))
    expect(await createRecomputeSteps(db).process(work(1), batchAt())).toBe('DONE')
    expect(evaluate).toHaveBeenCalledOnce()
    expect(evaluate.mock.calls[0]?.[0]).toMatchObject({
      recordKey: work(1).id,
      evaluationTime: NOW,
      rosterSeniorIds: [SENIOR],
      unavailable: [],
    })
    expect(seen.transactions).toBe(1)
    // SR-M-1: every input read comes after the opportunity lock.
    const order = (re: RegExp) => seen.statements.findIndex((s) => re.test(s.sql))
    const lock = order(/FROM job_opportunities WHERE id = .* FOR NO KEY UPDATE$/)
    expect(seen.statements[0]?.sql).toBe(`SET LOCAL lock_timeout = '5000ms'`)
    expect(lock).toBe(1)
    expect(order(/FROM job_opportunities o/)).toBeGreaterThan(lock)
    expect(order(/FROM users u JOIN team_members/)).toBeGreaterThan(lock)
    const [insert] = did(/INSERT INTO job_opportunity_matches/)
    expect(JSON.stringify(insert?.params)).toContain(SENIOR)
    expect(JSON.stringify(insert?.params)).toContain('LEAD')
    expect(order(/^\s*WITH cur AS/)).toBe(seen.statements.length - 1)
  })

  it('reads the roster per row, never from a batch snapshot', async () => {
    const { db, did } = recordingDb(world({}))
    const steps = createRecomputeSteps(db)
    const batch = batchAt()
    await steps.process(work(1), batch)
    await steps.process(work(1), batch)
    expect(did(/FROM users u JOIN team_members/)).toHaveLength(2)
  })

  it('CR-M-1: a failed roster read costs only its own row; the next row reads it again', async () => {
    let reads = 0
    const { db, did } = recordingDb(
      world({
        onRoster: () => {
          reads += 1
          if (reads === 1) throw new Error('connection terminated')
        },
      }),
    )
    const steps = createRecomputeSteps(db)
    const batch = batchAt()
    const first = await steps.process(work(1), batch).catch((e: unknown) => e)
    expect(classifyFailure(first)).toEqual({ code: 'RECOMPUTE_ERROR', poison: false })
    expect(await steps.process(work(2), batch)).toBe('DONE')
    expect(did(/FROM users u JOIN team_members/)).toHaveLength(2)
    expect(did(/INSERT INTO job_opportunity_matches/)).toHaveLength(1)
  })

  it.each([
    ['moved on', 2],
    ['is gone', null],
  ])('an opportunity that %s is completed under the lock, without evaluating', async (_n, rev) => {
    const { db, did } = recordingDb(world({ lockRevision: rev }))
    await createRecomputeSteps(db).process(work(1), batchAt())
    expect(evaluate).not.toHaveBeenCalled()
    expect(did(/FROM job_opportunities o/)).toEqual([])
    expect(did(/FROM users u/)).toEqual([])
    expect(did(/job_opportunity_matches/)).toEqual([])
    expect(did(/^\s*WITH cur AS/)).toHaveLength(1)
  })

  it('an invalid revision is poison, and nothing is installed', async () => {
    const { db, did } = recordingDb(
      world({ opportunity: opportunityRow({ availability: 'BOGUS' }) }),
    )
    await expect(createRecomputeSteps(db).process(work(1), batchAt())).rejects.toEqual(
      new RecomputePoisonError('INVALID_REVISION'),
    )
    expect(did(/job_opportunity_matches/)).toEqual([])
    expect(did(/^\s*WITH cur AS/)).toEqual([])
  })

  it('an evaluation that throws is poison', async () => {
    evaluate.mockImplementationOnce(() => {
      throw new Error('bug')
    })
    const { db } = recordingDb(world({}))
    await expect(createRecomputeSteps(db).process(work(1), batchAt())).rejects.toEqual(
      new RecomputePoisonError('EVALUATION_THREW'),
    )
  })

  it('an input that is not ready is retryable, never poison', async () => {
    evaluate.mockReturnValueOnce({
      kind: 'RETRYABLE',
      recordKey: 'k',
      code: 'ROSTER_NOT_READY',
      unavailable: [],
      readiness: [],
      trace: [],
    })
    const { db, did } = recordingDb(world({}))
    const err = await createRecomputeSteps(db)
      .process(work(1), batchAt())
      .catch((e: unknown) => e)
    expect(err).toEqual(new RecomputeNotReadyError('ROSTER_NOT_READY'))
    expect(classifyFailure(err)).toEqual({ code: 'ROSTER_NOT_READY', poison: false })
    expect(did(/job_opportunity_matches/)).toEqual([])
  })

  describe('U10 (ADR 6a): enqueue DETAIL_FETCH for a wanted opportunity (AC1 enqueue-half, AC3)', () => {
    const REC = '00000000-0000-4000-8000-0000000000a1'
    const withMissing = () =>
      world({
        opportunity: opportunityRow({ on_demand_missing: [{ recordId: REC, version: 5 }] }),
      })

    it('a LEAD/TRIAGE opportunity enqueues one DETAIL_FETCH per backing ON_DEMAND record', async () => {
      const { db, did } = recordingDb(withMissing())
      await createRecomputeSteps(db, {}, ['GREENHOUSE_ATS']).process(work(1), batchAt())
      // The ON_DEMAND types reach loadOpportunity's detail subquery (threaded, not dropped).
      expect(did(/FROM job_opportunities o/)[0]?.sql).toMatch(/r\.source_type IN/)
      const [enqueue] = did(/INSERT INTO job_dirty_work/)
      expect(enqueue?.params).toEqual(
        expect.arrayContaining(['SOURCE_RECORD', REC, 5, 'DETAIL_FETCH']),
      )
      // Fetch once: the insert carries the ON CONFLICT no-op on (kind, entity, version, reason).
      expect(enqueue?.sql).toMatch(
        /ON CONFLICT \(entity_kind, entity_id, target_version, reason\) DO NOTHING/,
      )
    })

    it('enqueues nothing and emits no detail subquery when no source type is ON_DEMAND', async () => {
      const { db, did } = recordingDb(world({}))
      await createRecomputeSteps(db).process(work(1), batchAt())
      expect(did(/FROM job_opportunities o/)[0]?.sql).not.toMatch(/r\.source_type IN/)
      expect(did(/INSERT INTO job_dirty_work/)).toEqual([])
    })

    it('enqueues nothing when the opportunity is not wanted (EXCLUDED), even with a record missing detail', async () => {
      evaluate.mockReturnValueOnce({
        kind: 'EXCLUDED',
        audit: { excluded: [] },
      } as unknown as ReturnType<typeof funnel.evaluate>)
      const { db, did } = recordingDb(withMissing())
      await createRecomputeSteps(db, {}, ['GREENHOUSE_ATS']).process(work(1), batchAt())
      expect(did(/INSERT INTO job_dirty_work/)).toEqual([])
    })

    it('enqueues nothing when EVALUATED has no projection (no senior wanted it)', async () => {
      evaluate.mockReturnValueOnce({
        kind: 'EVALUATED',
        projections: [],
        audit: { excluded: [] },
      } as unknown as ReturnType<typeof funnel.evaluate>)
      const { db, did } = recordingDb(withMissing())
      await createRecomputeSteps(db, {}, ['GREENHOUSE_ATS']).process(work(1), batchAt())
      expect(did(/INSERT INTO job_dirty_work/)).toEqual([])
    })
  })
})
