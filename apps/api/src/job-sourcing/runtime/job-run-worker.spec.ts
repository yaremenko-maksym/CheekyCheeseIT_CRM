import type { JobSourceType } from '@crm/shared'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import { SourceRateLimitedError } from '../http/source-errors'
import type { MeterDb } from '../metering/account-meter.store'
import type { ClaimedRun, RunEnding } from '../ownership/job-run-ledger'
import { RunFencedError } from '../ownership/run-ownership'
import {
  type CollectionBatch,
  type CollectionContext,
  type CollectionErrorCode,
  type ReportingJobSourceProvider,
  buildCollectionBatch,
  buildRequestReport,
} from '../providers/reporting-provider'
import { JobSourceRegistry } from '../registry/job-source-registry'
import { ReportingAdapter } from '../registry/registered-adapter'
import type { HostBan } from '../scheduling/host-state'
import {
  type WorkerDeps,
  type WorkerOptions,
  RunSetupError,
  FREE_PLAN_METERS,
  JobRunWorker,
  MeterBindingRefusedError,
  endingOf,
  meterWindowsFor,
  validateWorkerOptions,
} from './job-run-worker'

/**
 * r5 Task 2.5 T7 — the worker through its interface, with the ledger and the database as
 * recording doubles. The same behaviours against a real Postgres are in
 * `job-run-worker.integration.spec.ts`.
 */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const claimed = (n: number, over: Partial<ClaimedRun> = {}): ClaimedRun => ({
  runId: uuid(100 + n),
  ownerToken: `spec:${n}`,
  fencingEpoch: 1,
  sourceId: uuid(200 + n),
  cycleId: uuid(1),
  attemptId: `run-${n}`,
  accountKey: `#source:${uuid(200 + n)}`,
  sourceType: 'REMOTIVE_API',
  checkpoint: null,
  ...over,
})

const NOW = new Date('2026-10-25T10:00:00Z')

function report(code: CollectionErrorCode | null, message = 'provider answered HTTP 500') {
  return buildRequestReport(
    {
      attempt: 1,
      page: 1,
      url: 'https://h.example/x',
      status: code === null ? 200 : null,
      startedAt: NOW,
      endedAt: NOW,
      cost: null,
      error: code === null ? null : { code, message },
    },
    ['sekrit-key'],
  )
}

function batch(
  stop: 'EXHAUSTED' | 'ERROR' | 'COST_STOP' | 'CANCELLED',
  code: CollectionErrorCode | null = null,
  pages = 0,
): CollectionBatch {
  return buildCollectionBatch({
    observations: [],
    facts: {
      stop,
      pagesCompleted: pages,
      counts: { raw: 0, normalized: 0, invalid: 0, quarantined: 0, discarded: 0 },
      scope: { namespace: 'n', query: null, configVersion: 1, window: null },
      resumed: false,
    },
    requests: [report(code)],
    checkpoint: null,
    invalidSamples: [],
  })
}

type Collect = (config: unknown, ctx: CollectionContext) => Promise<CollectionBatch>

const RUN_ROW = {
  config_version: 3,
  config: { a: 1 },
  policy_version: 4,
  host_key: 'h.example',
  manifest_id: 'm1',
  meter_account_key: null,
  meter_unit: null,
  meter_window: null,
  meter_limit: null,
} as Record<string, unknown>

const dialect = new PgDialect()

function world(
  opts: {
    collect?: Collect
    claims?: ClaimedRun[]
    heartbeat?: () => Promise<boolean>
    /** Overrides of the run row the worker reads; `null` returns no row at all. */
    row?: Record<string, unknown> | null
    entry?: 'MISSING'
    policy?: 'MISSING'
    deps?: Partial<WorkerDeps>
    options?: Partial<WorkerOptions>
    registry?: JobSourceRegistry
  } = {},
) {
  const log: string[] = []
  const finishes: { runId: string; ending: RunEnding }[] = []
  const bans: HostBan[] = []
  const configs: unknown[] = []
  const meterBindings: unknown[] = []
  const saves: unknown[] = []
  const readIds: unknown[] = []
  let finishThrows: unknown = null
  const provider: ReportingJobSourceProvider = {
    type: 'REMOTIVE_API',
    parseConfig: (raw) => {
      configs.push(raw)
      return raw as never
    },
    collectReport: (config, ctx) => (opts.collect ?? (async () => batch('EXHAUSTED')))(config, ctx),
  }
  const db = {
    async execute(query: SQL) {
      // The contract double: the worker reads THE claimed run's row, joined to its source and meter.
      const q = dialect.sqlToQuery(query)
      readIds.push(q.params[0])
      if (!/FROM job_collection_runs r\s+JOIN job_sources s/.test(q.sql)) return { rows: [] }
      if (opts.row === null) return { rows: [] }
      return { rows: [{ ...RUN_ROW, ...opts.row }] }
    },
  } as unknown as MeterDb
  const deps: WorkerDeps = {
    ledger: {
      options: { leaseMs: 300, runMaxAgeMs: 10_000 } as never,
      async recoverExpired() {
        log.push('recover')
        return 1
      },
      async claimDue(input) {
        log.push(`claim:${input.limit}`)
        return { claimed: opts.claims ?? [claimed(1)], refused: [] }
      },
      async claimSource() {
        log.push('claimSource')
        return { kind: 'CLAIMED', run: claimed(9) }
      },
      async finish(h, ending) {
        log.push(`finish:${ending.outcome}`)
        if (finishThrows !== null) throw finishThrows
        finishes.push({ runId: h.runId, ending })
      },
      async savePage(...args) {
        saves.push(args)
      },
      meterFor: (run, windows) => {
        meterBindings.push({ accountKey: run.accountKey, windows })
        return {
          async reserve(unit, amount) {
            log.push('meter:reserve')
            return { id: 'm1', unit, amount }
          },
          async markSent() {
            log.push('meter:markSent')
          },
          async reconcile() {
            log.push('meter:reconcile')
          },
        }
      },
    },
    heartbeat: opts.heartbeat ?? (async () => true),
    registry:
      opts.registry ??
      new JobSourceRegistry([
        new ReportingAdapter(provider, { adapterVersion: 'r-1', allowedHosts: ['h.example'] }),
      ]),
    catalog: {
      entry: (id) =>
        opts.entry === 'MISSING' || id !== 'm1'
          ? undefined
          : {
              type: 'REMOTIVE_API',
              activationFacts: () => ({
                readiness: 'CANDIDATE',
                blockerCodes: [],
                payloadVerified: true,
              }),
              entryReadiness: () => 'CANDIDATE',
              quotaDeclared: false,
              intervalHours: 24,
              floorHours: 0,
              banScope: 'SOURCE',
            },
      hostPolicy: (key) =>
        opts.policy === 'MISSING' || key !== 'h.example'
          ? undefined
          : { rate: null, floorHours: 5 },
    },
    db,
    recordBan: async (ban) => {
      log.push('ban')
      bans.push(ban)
    },
    secretsFor: () => ['sekrit-key'],
    now: () => NOW,
    ...opts.deps,
  }
  const worker = new JobRunWorker(deps, {
    owner: 'spec',
    poolSize: 2,
    heartbeatMs: 20,
    runDeadlineMs: 120,
    deadlineGraceMs: 60,
    ...opts.options,
  })
  return {
    worker,
    log,
    finishes,
    bans,
    configs,
    meterBindings,
    saves,
    readIds,
    failFinish: (e: unknown) => {
      finishThrows = e
    },
  }
}

describe('worker start and the pool', () => {
  it('recovers expired runs once, before its first claim (AC 16)', async () => {
    const w = world()
    await w.worker.runDue({ cycleId: uuid(1) })
    await w.worker.runDue({ cycleId: uuid(1) })
    expect(w.log.filter((l) => l === 'recover' || l.startsWith('claim'))).toEqual([
      'recover',
      'claim:2',
      'claim:2',
    ])
  })

  it('claims only the free slots: a full pool claims nothing', async () => {
    let release: () => void = () => undefined
    const w = world({
      collect: () =>
        new Promise((resolve) => {
          release = () => resolve(batch('EXHAUSTED'))
        }),
      claims: [claimed(1), claimed(2)],
    })
    const first = w.worker.runDue({ cycleId: uuid(1) })
    await new Promise((r) => setTimeout(r, 5))
    expect(await w.worker.runDue({ cycleId: uuid(1) })).toEqual([])
    expect(
      (await w.worker.runSource({ cycleId: uuid(1), sourceId: uuid(5), actor: uuid(6) })).kind,
    ).toBe('REFUSED')
    release()
    await first
    expect(w.log.filter((l) => l.startsWith('claim'))).toEqual(['claim:2'])
  })

  it('two passes at once never claim more than the pool: the slots are held during the claim', async () => {
    const w = world({ claims: [] })
    await w.worker.start()
    await Promise.all([
      w.worker.runDue({ cycleId: uuid(1) }),
      w.worker.runDue({ cycleId: uuid(1) }),
      w.worker.runSource({ cycleId: uuid(1), sourceId: uuid(5), actor: uuid(6) }),
    ])
    expect(w.log.filter((l) => l.startsWith('claim'))).toEqual(['claim:2'])
    // and the slots come back once the claim is done
    await w.worker.runDue({ cycleId: uuid(1) })
    expect(w.log.filter((l) => l.startsWith('claim'))).toEqual(['claim:2', 'claim:2'])
  })

  it('a claim that throws gives its slots back', async () => {
    const w = world()
    const ledger = (w.worker as unknown as { deps: WorkerDeps }).deps.ledger as {
      claimDue: unknown
    }
    let fail = true
    const real = ledger.claimDue as WorkerDeps['ledger']['claimDue']
    ledger.claimDue = (async (input: Parameters<WorkerDeps['ledger']['claimDue']>[0]) => {
      if (fail) {
        fail = false
        throw new Error('db down')
      }
      return real(input)
    }) as never
    await expect(w.worker.runDue({ cycleId: uuid(1) })).rejects.toThrow('db down')
    expect(await w.worker.runDue({ cycleId: uuid(1) })).toHaveLength(1)
  })

  it('one throwing source leaves the other SUCCEEDED (AC 4)', async () => {
    const w = world({
      claims: [claimed(1), claimed(2)],
      collect: async (_c, ctx) => {
        if (ctx.run.attemptId === 'run-1') throw new Error('kaboom with sekrit-key inside')
        return batch('EXHAUSTED')
      },
    })
    const reports = await w.worker.runDue({ cycleId: uuid(1) })
    expect(reports.map((r) => [r.runId, r.outcome, r.errorCode])).toEqual([
      [uuid(101), 'FAILED', 'ADAPTER_INVARIANT'],
      [uuid(102), 'SUCCEEDED', null],
    ])
    // the exception's own text never reaches the row
    expect(w.finishes[0]?.ending.errorMessage).toBe('the adapter threw Error')
  })

  it('the manual path claims the named source and runs it', async () => {
    const w = world()
    const r = await w.worker.runSource({ cycleId: uuid(1), sourceId: uuid(5), actor: uuid(6) })
    expect(r).toMatchObject({ kind: 'RAN', report: { runId: uuid(109), outcome: 'SUCCEEDED' } })
    expect(w.log).toEqual(['recover', 'claimSource', 'finish:SUCCEEDED'])
  })
})

describe('the run row is ended before the summary is built (AC 5)', () => {
  it('a summary that cannot be built still leaves the run finished', async () => {
    const w = world({
      collect: async () => {
        const b = batch('EXHAUSTED')
        return { ...b, counts: { raw: 5, normalized: 0, invalid: 0, quarantined: 0, discarded: 0 } }
      },
    })
    const [r] = await w.worker.runDue({ cycleId: uuid(1) })
    expect(r).toMatchObject({ outcome: 'SUCCEEDED', finished: true, counts: null })
    expect(w.log).toContain('finish:SUCCEEDED')
  })

  it('a batch summarises its counts', async () => {
    const w = world()
    const [r] = await w.worker.runDue({ cycleId: uuid(1) })
    expect(r?.counts).toEqual({ received: 0, invalid: 0, normalized: 0 })
  })

  it('a finish the ledger refuses (fenced) is reported, not thrown', async () => {
    const w = world()
    w.failFinish(new RunFencedError())
    const [r] = await w.worker.runDue({ cycleId: uuid(1) })
    expect(r).toMatchObject({ finished: false })
  })
})

describe('the deadline and the heartbeat (SR-M-18)', () => {
  it('an adapter whose request never settles has its run ended PARTIAL / DEADLINE', async () => {
    let signal: AbortSignal | null = null
    const w = world({
      collect: (_c, ctx) => {
        signal = ctx.signal
        return new Promise(() => {})
      },
    })
    const [r] = await w.worker.runDue({ cycleId: uuid(1) })
    expect(r).toMatchObject({ outcome: 'PARTIAL', errorCode: 'DEADLINE', finished: true })
    expect(signal!.aborted).toBe(true)
  })

  it('a heartbeat that finds the run fenced closes the context: the next request is refused', async () => {
    const w = world({
      heartbeat: async () => false,
      collect: async (_c, ctx) => {
        await new Promise((r) => setTimeout(r, 50))
        await ctx.fetchText({ url: 'https://h.example/x' })
        return batch('EXHAUSTED')
      },
    })
    const [r] = await w.worker.runDue({ cycleId: uuid(1) })
    expect(r).toMatchObject({ outcome: 'FAILED', errorCode: 'RUN_FENCED' })
  })
})

describe('the ban the context could not write is written again after finish (SR-M-21)', () => {
  it('a HOST_BAN_UNRECORDED run calls recordHostBan after finish', async () => {
    let attempts = 0
    const banned: HostBan[] = []
    const w = world({
      collect: async (_c, ctx) => {
        await ctx.fetchText({ url: 'https://h.example/x' }).catch(() => undefined)
        return batch('ERROR', 'RATE_LIMIT')
      },
      deps: {
        transport: async () => {
          throw new SourceRateLimitedError('h.example')
        },
        recordBan: async (ban) => {
          attempts += 1
          log.push('ban')
          if (attempts <= 3) throw new Error('db down')
          banned.push(ban)
        },
      },
    })
    const log = w.log
    const [r] = await w.worker.runDue({ cycleId: uuid(1) })
    expect(r).toMatchObject({ outcome: 'FAILED', errorCode: 'HOST_BAN_UNRECORDED' })
    expect(w.log.slice(-2)).toEqual(['finish:FAILED', 'ban'])
    expect(attempts).toBe(4)
    // the ban carries the run's host, source and the host policy's floor
    expect(banned).toEqual([
      {
        hostKey: 'h.example',
        reason: 'HTTP_429',
        sourceId: uuid(201),
        retryAfter: null,
        floorHours: 5,
      },
    ])
  })

  it('a ban that was written is not written again, and a failing late write is swallowed', async () => {
    const w = world({
      collect: async (_c, ctx) => {
        await ctx.fetchText({ url: 'https://h.example/x' }).catch(() => undefined)
        return batch('ERROR', 'RATE_LIMIT')
      },
      deps: {
        transport: async () => {
          throw new SourceRateLimitedError('h.example')
        },
      },
    })
    const [r] = await w.worker.runDue({ cycleId: uuid(1) })
    expect(r).toMatchObject({ errorCode: 'RATE_LIMIT' })
    expect(w.log.filter((l) => l === 'ban')).toHaveLength(1)

    let calls = 0
    const failing = world({
      collect: async (_c, ctx) => {
        await ctx.fetchText({ url: 'https://h.example/x' }).catch(() => undefined)
        return batch('ERROR', 'RATE_LIMIT')
      },
      deps: {
        transport: async () => {
          throw new SourceRateLimitedError('h.example')
        },
        recordBan: async () => {
          calls += 1
          throw new Error('still down')
        },
      },
    })
    await expect(failing.worker.runDue({ cycleId: uuid(1) })).resolves.toHaveLength(1)
    expect(calls).toBe(4)
  })
})

describe('endingOf: every way a run ends', () => {
  const open = { closed: null, banCode: null, unrecordedBan: null } as const
  const S = ['sekrit-key']

  it.each([
    [batch('EXHAUSTED'), 'SUCCEEDED', null],
    [batch('COST_STOP', 'COST_STOP'), 'PARTIAL', 'COST_STOP'],
    [batch('ERROR', 'DEADLINE', 1), 'PARTIAL', 'DEADLINE'],
    [batch('ERROR', 'PAGE_CAP'), 'PARTIAL', 'PAGE_CAP'],
    [batch('ERROR', 'TRANSIENT_NETWORK', 2), 'FAILED', 'TRANSIENT_NETWORK'],
    [batch('ERROR', 'RUN_FENCED'), 'FAILED', 'RUN_FENCED'],
    [batch('ERROR', 'NOT_MARKED_SENT'), 'FAILED', 'NOT_MARKED_SENT'],
    [batch('ERROR', 'LEASE_EXPIRED'), 'FAILED', 'ADAPTER_INVARIANT'],
    [batch('CANCELLED', 'CANCELLED'), 'CANCELLED', 'CANCELLED'],
  ] as const)('a batch %#', (b, outcome, code) => {
    expect(endingOf({ kind: 'BATCH', batch: b }, open, S)).toMatchObject({
      outcome,
      errorCode: code,
    })
  })

  it('a failed batch with no request error is an adapter invariant', () => {
    const b = { ...batch('ERROR', 'UPSTREAM'), requests: [] } as unknown as CollectionBatch
    expect(endingOf({ kind: 'BATCH', batch: b }, open, S)).toEqual({
      outcome: 'FAILED',
      errorCode: 'ADAPTER_INVARIANT',
      errorMessage: 'the batch failed without a request error',
    })
  })

  it('the persisted message is the request report`s, redacted and capped', () => {
    const b = buildCollectionBatch({
      observations: [],
      facts: {
        stop: 'ERROR',
        pagesCompleted: 0,
        counts: { raw: 0, normalized: 0, invalid: 0, quarantined: 0, discarded: 0 },
        scope: { namespace: 'n', query: null, configVersion: 1, window: null },
        resumed: false,
      },
      requests: [report('UPSTREAM', `x`.repeat(1000))],
      checkpoint: null,
      invalidSamples: [],
    })
    const e = endingOf({ kind: 'BATCH', batch: b }, open, ['later-secret'])
    expect(e.errorMessage).toHaveLength(300)
    const withSecret = endingOf({ kind: 'BATCH', batch: batch('ERROR', 'UPSTREAM') }, open, [
      'provider answered',
    ])
    expect(withSecret.errorMessage).not.toContain('provider answered')
  })

  it('a ban wins over the batch; an unrecorded ban is flagged', () => {
    const b = { kind: 'BATCH', batch: batch('EXHAUSTED') } as const
    expect(
      endingOf(b, { closed: 'BANNED', banCode: 'RATE_LIMIT', unrecordedBan: null }, S),
    ).toMatchObject({
      outcome: 'FAILED',
      errorCode: 'RATE_LIMIT',
    })
    expect(
      endingOf(
        b,
        { closed: 'BANNED', banCode: null, unrecordedBan: { reason: 'HTTP_403' } as HostBan },
        S,
      ),
    ).toMatchObject({ outcome: 'FAILED', errorCode: 'HOST_BAN_UNRECORDED' })
    expect(endingOf(b, { closed: 'BANNED', banCode: null, unrecordedBan: null }, S).errorCode).toBe(
      'ACCESS_POLICY',
    )
  })

  it('an unsettled adapter or a deadline close is PARTIAL / DEADLINE', () => {
    expect(endingOf({ kind: 'UNSETTLED' }, open, S)).toMatchObject({
      outcome: 'PARTIAL',
      errorCode: 'DEADLINE',
      errorMessage: 'the adapter did not settle within the deadline grace',
    })
    expect(
      endingOf({ kind: 'BATCH', batch: batch('EXHAUSTED') }, { ...open, closed: 'DEADLINE' }, S),
    ).toMatchObject({
      outcome: 'PARTIAL',
      errorCode: 'DEADLINE',
      errorMessage: 'the run reached its deadline',
    })
  })

  it('a thrown error keeps a known code; its own text is replaced unless it is ours', () => {
    const coded = Object.assign(new Error('sekrit-key leaked'), { code: 'RUN_FENCED' })
    expect(endingOf({ kind: 'THREW', error: coded }, open, S)).toEqual({
      outcome: 'FAILED',
      errorCode: 'RUN_FENCED',
      errorMessage: '[REDACTED] leaked',
    })
    expect(
      endingOf({ kind: 'THREW', error: Object.assign(new Error('x'), { code: 'NOPE' }) }, open, S),
    ).toEqual({
      outcome: 'FAILED',
      errorCode: 'ADAPTER_INVARIANT',
      errorMessage: 'the adapter threw Error',
    })
    expect(endingOf({ kind: 'THREW', error: 'str' }, open, S).errorMessage).toBe(
      'the adapter threw string',
    )
    expect(endingOf({ kind: 'THREW', error: null }, open, S).errorCode).toBe('ADAPTER_INVARIANT')
    expect(
      endingOf(
        { kind: 'THREW', error: Object.assign(new Error('x'), { code: 'LEASE_EXPIRED' }) },
        open,
        S,
      ).errorCode,
    ).toBe('ADAPTER_INVARIANT')
  })
})

describe('the meter binding (AC 13, free plan)', () => {
  const run = (type: JobSourceType = 'JSEARCH_API', accountKey = 'jsearch:main') => ({
    accountKey,
    sourceId: uuid(7),
    sourceType: type,
  })

  it('binds the run`s account at the meter row`s unit and window', () => {
    expect(
      meterWindowsFor(run(), {
        accountKey: 'jsearch:main',
        unit: 'REQUEST',
        window: 'MONTH',
        limit: 200,
      }),
    ).toEqual({ REQUEST: 'MONTH' })
  })

  it('an unmetered run whose source still has no meter is unmetered', () => {
    expect(meterWindowsFor(run('REMOTIVE_API', `#source:${uuid(7)}`), null)).toBeNull()
  })

  it('a meter of another account (the source`s meter changed after the claim) is refused', () => {
    expect(() =>
      meterWindowsFor(run(), {
        accountKey: 'jsearch:other',
        unit: 'REQUEST',
        window: 'MONTH',
        limit: 1,
      }),
    ).toThrow(MeterBindingRefusedError)
    expect(() => meterWindowsFor(run(), null)).toThrow(MeterBindingRefusedError)
    expect(() =>
      meterWindowsFor(run('REMOTIVE_API', `#source:${uuid(7)}`), {
        accountKey: 'x:y',
        unit: 'REQUEST',
        window: 'DAY',
        limit: 1,
      }),
    ).toThrow(MeterBindingRefusedError)
  })

  it('TheirStack is bound only to a RECORD / MONTH meter of at most 200', () => {
    expect(FREE_PLAN_METERS.THEIRSTACK_API).toEqual({ unit: 'RECORD', window: 'MONTH', limit: 200 })
    const ts = run('THEIRSTACK_API', 'theirstack:api-main')
    const m = (over = {}) => ({
      accountKey: 'theirstack:api-main',
      unit: 'RECORD' as const,
      window: 'MONTH' as const,
      limit: 200,
      ...over,
    })
    expect(meterWindowsFor(ts, m())).toEqual({ RECORD: 'MONTH' })
    expect(meterWindowsFor(ts, m({ limit: 1 }))).toEqual({ RECORD: 'MONTH' })
    for (const bad of [
      m({ limit: 201 }),
      m({ limit: null }),
      m({ unit: 'REQUEST' }),
      m({ window: 'DAY' }),
    ]) {
      expect(() => meterWindowsFor(ts, bad)).toThrow(
        /THEIRSTACK_API is bound only to a RECORD \/ MONTH meter of at most 200/,
      )
    }
    expect(() => meterWindowsFor({ ...ts, accountKey: `#source:${uuid(7)}` }, null)).toThrow(
      MeterBindingRefusedError,
    )
  })
})

describe('worker options carry ceilings', () => {
  const ledger = { leaseMs: 300_000, runMaxAgeMs: 7_200_000 }
  const ok = {
    owner: 'api-1',
    poolSize: 2,
    heartbeatMs: 60_000,
    runDeadlineMs: 3_600_000,
    deadlineGraceMs: 60_000,
  }

  it('accepts the defaults against the ledger defaults', () => {
    expect(() => validateWorkerOptions(ok, ledger)).not.toThrow()
    expect(() =>
      validateWorkerOptions({ ...ok, poolSize: 8, heartbeatMs: 100_000 }, ledger),
    ).not.toThrow()
    expect(() =>
      validateWorkerOptions({ ...ok, runDeadlineMs: 7_100_000, deadlineGraceMs: 100_000 }, ledger),
    ).not.toThrow()
  })

  it.each([
    [{ owner: 'Bad Owner' }, /owner/],
    [{ poolSize: 0 }, /poolSize/],
    [{ poolSize: 9 }, /poolSize/],
    [{ poolSize: 1.5 }, /poolSize/],
    [{ heartbeatMs: 100_001 }, /third of the lease/],
    [{ heartbeatMs: 0 }, /third of the lease/],
    [{ runDeadlineMs: 0 }, /positive/],
    [{ deadlineGraceMs: -1 }, /positive/],
    [{ runDeadlineMs: 7_100_000, deadlineGraceMs: 100_001 }, /RUN_MAX_AGE/],
  ])('refuses %o', (over, message) => {
    expect(() => validateWorkerOptions({ ...ok, ...over }, ledger)).toThrow(message)
  })

  it('the owner pattern is anchored at both ends', () => {
    expect(() => validateWorkerOptions({ ...ok, owner: 'api-1 X' }, ledger)).toThrow(
      'worker: invalid owner',
    )
  })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('setting a run up: every refusal is named on the run row', () => {
  const setup = async (w: ReturnType<typeof world>) => {
    const [r] = await w.worker.runDue({ cycleId: uuid(1) })
    return { r, message: w.finishes[0]?.ending.errorMessage }
  }

  it.each([
    [{ row: null }, 'the claimed run has no row'],
    [{ row: { host_key: null } }, 'the run`s source has no host key or manifest entry'],
    [{ row: { manifest_id: null } }, 'the run`s source has no host key or manifest entry'],
    [{ entry: 'MISSING' as const }, 'the run`s catalog entry or host policy is gone'],
    [{ policy: 'MISSING' as const }, 'the run`s catalog entry or host policy is gone'],
    [{ registry: new JobSourceRegistry([]) }, 'REMOTIVE_API has no reporting adapter'],
  ])('%o', async (opts, message) => {
    let collected = false
    const w = world({
      ...opts,
      collect: async () => {
        collected = true
        return batch('EXHAUSTED')
      },
    })
    const { r, message: persisted } = await setup(w)
    expect(r).toMatchObject({ outcome: 'FAILED', errorCode: 'ADAPTER_INVARIANT', finished: true })
    expect(persisted).toBe(message)
    expect(collected).toBe(false)
    // a run that never got a context has no ban to write again, and finishes ITS run
    expect(w.log).not.toContain('ban')
    expect(w.finishes.map((f) => f.runId)).toEqual([uuid(101)])
  })

  it('a refused meter binding is named too', async () => {
    const w = world({
      row: { meter_account_key: 'someone:else', meter_unit: 'REQUEST', meter_window: 'DAY' },
    })
    const { message } = await setup(w)
    expect(message).toBe('the source`s meter is not the claimed run`s account')
  })
})

describe('what a run is handed', () => {
  it('reads ITS run row, parses the snapshot with its version, and builds the context from both', async () => {
    let seen: CollectionContext | null = null
    const w = world({
      collect: async (_c, ctx) => {
        seen = ctx
        await ctx.checkpoints.savePage({ observations: [], checkpoint: { n: 1 } as never })
        return batch('EXHAUSTED')
      },
    })
    await w.worker.runDue({ cycleId: uuid(1) })
    expect(w.readIds).toEqual([uuid(101)])
    expect(w.finishes.map((f) => f.runId)).toEqual([uuid(101)])
    expect(w.configs).toEqual([{ a: 1, configVersion: 3 }])
    expect(seen!.policyVersion).toBe(4)
    expect(seen!.secrets).toEqual(['sekrit-key'])
    expect(seen!.deadline.getTime()).toBe(NOW.getTime() + 120)
    expect(seen!.now()).toBe(NOW)
    expect(w.saves).toEqual([
      [
        { runId: uuid(101), ownerToken: 'spec:1', fencingEpoch: 1 },
        { observations: [], checkpoint: { n: 1 } },
        { timeoutMs: 20 },
      ],
    ])
  })

  it('a 403 on the entry`s SOURCE scope bans nothing (the scope comes from the catalog entry)', async () => {
    const w = world({
      collect: async (_c, ctx) => {
        await ctx.fetchText({ url: 'https://h.example/x' }).catch(() => undefined)
        return batch('ERROR', 'ACCESS_POLICY')
      },
      deps: {
        transport: async () => {
          const { SourceBlockedError } = await import('../http/source-errors')
          throw new SourceBlockedError('h.example', 403)
        },
      },
    })
    const [r] = await w.worker.runDue({ cycleId: uuid(1) })
    expect(r).toMatchObject({ errorCode: 'ACCESS_POLICY' })
    expect(w.log).not.toContain('ban')
  })

  it('a metered source is bound to the run`s account at its meter row`s unit and window', async () => {
    const accountKey = 'jsearch:main'
    const w = world({
      claims: [claimed(1, { accountKey })],
      row: {
        meter_account_key: accountKey,
        meter_unit: 'REQUEST',
        meter_window: 'MONTH',
        meter_limit: '7',
      },
      collect: async (_c, ctx) => {
        await ctx.meter.reserve('REQUEST', 1)
        return batch('EXHAUSTED')
      },
    })
    await w.worker.runDue({ cycleId: uuid(1) })
    expect(w.meterBindings).toEqual([{ accountKey, windows: { REQUEST: 'MONTH' } }])
    expect(w.log).toContain('meter:reserve')
  })

  it.each([
    ['200', 'SUCCEEDED'],
    [null, 'FAILED'],
  ])('a TheirStack meter limit read as %s binds or is refused', async (limit, outcome) => {
    const accountKey = 'theirstack:main'
    const ts = {
      type: 'THEIRSTACK_API',
      parseConfig: (raw: unknown) => raw,
      collectReport: async () => batch('EXHAUSTED'),
    } as unknown as ReportingJobSourceProvider
    const w = world({
      claims: [claimed(1, { accountKey, sourceType: 'THEIRSTACK_API' })],
      registry: new JobSourceRegistry([new ReportingAdapter(ts, { allowedHosts: ['h.example'] })]),
      row: {
        meter_account_key: accountKey,
        meter_unit: 'RECORD',
        meter_window: 'MONTH',
        meter_limit: limit,
      },
    })
    const [r] = await w.worker.runDue({ cycleId: uuid(1) })
    expect(r?.outcome).toBe(outcome)
  })
})

describe('the worker`s own clock', () => {
  it('without an injected clock, the deadline runs from the real now', async () => {
    let deadline = 0
    const w = world({
      deps: { now: undefined },
      collect: async (_c, ctx) => {
        deadline = ctx.deadline.getTime()
        return batch('EXHAUSTED')
      },
    })
    const before = Date.now()
    await w.worker.runDue({ cycleId: uuid(1) })
    expect(deadline).toBeGreaterThanOrEqual(before + 120)
    expect(deadline).toBeLessThanOrEqual(Date.now() + 120)
  })
})

describe('the heartbeat, the deadline and the end of a run', () => {
  it('a successful heartbeat renews the local lease, so a long run keeps sending', async () => {
    let beats = 0
    const w = world({
      heartbeat: async () => {
        beats += 1
        return true
      },
      deps: { transport: async () => 'ok' },
      options: { runDeadlineMs: 2_000, deadlineGraceMs: 100 },
      collect: async (_c, ctx) => {
        await sleep(400) // past L = 300
        await ctx.fetchText({ url: 'https://h.example/x' })
        return batch('EXHAUSTED')
      },
    })
    const [r] = await w.worker.runDue({ cycleId: uuid(1) })
    expect(r?.outcome).toBe('SUCCEEDED')
    expect(beats).toBeGreaterThan(5)
  })

  it('a heartbeat that cannot reach the database is not a fence, and is not an unhandled error', async () => {
    const w = world({
      heartbeat: async () => {
        throw new Error('db down')
      },
      deps: { transport: async () => 'ok' },
      collect: async (_c, ctx) => {
        await sleep(60)
        await ctx.fetchText({ url: 'https://h.example/x' })
        return batch('EXHAUSTED')
      },
    })
    const [r] = await w.worker.runDue({ cycleId: uuid(1) })
    expect(r?.outcome).toBe('SUCCEEDED')
  })

  it('after the run, its timers stop and its context refuses whatever the adapter still tries', async () => {
    let beats = 0
    let late: unknown = null
    let sends = 0
    const w = world({
      heartbeat: async () => {
        beats += 1
        return true
      },
      deps: {
        transport: async () => {
          sends += 1
          return 'ok'
        },
      },
      collect: async (_c, ctx) => {
        setTimeout(() => {
          ctx.fetchText({ url: 'https://h.example/x' }).catch((e: unknown) => {
            late = e
          })
        }, 50)
        await sleep(45)
        return batch('EXHAUSTED')
      },
    })
    await w.worker.runDue({ cycleId: uuid(1) })
    const beatsAtEnd = beats
    await sleep(120)
    expect(beats).toBe(beatsAtEnd)
    expect((late as { code?: string } | null)?.code).toBe('CANCELLED')
    expect(sends).toBe(0)
  })

  it('the deadline aborts the signal; an adapter that stops then ends PARTIAL / DEADLINE before the grace', async () => {
    let reason: unknown = null
    const started = Date.now()
    const w = world({
      collect: (_c, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => {
            reason = ctx.signal.reason
            resolve(batch('EXHAUSTED'))
          })
        }),
    })
    const [r] = await w.worker.runDue({ cycleId: uuid(1) })
    const elapsed = Date.now() - started
    expect(reason).toBe('DEADLINE')
    expect(w.finishes[0]?.ending).toEqual({
      outcome: 'PARTIAL',
      errorCode: 'DEADLINE',
      errorMessage: 'the run reached its deadline',
    })
    expect(r?.outcome).toBe('PARTIAL')
    expect(elapsed).toBeGreaterThanOrEqual(110)
    expect(elapsed).toBeLessThan(175)
  })

  it('an adapter that never settles is ended only after the deadline AND its grace', async () => {
    const started = Date.now()
    const w = world({ collect: () => new Promise(() => {}) })
    await w.worker.runDue({ cycleId: uuid(1) })
    expect(Date.now() - started).toBeGreaterThanOrEqual(175)
    expect(w.finishes[0]?.ending.errorMessage).toBe(
      'the adapter did not settle within the deadline grace',
    )
  })

  it('shutdown releases what the worker owns, and is a no-op when it owns nothing', async () => {
    let closed = 0
    const w = world({
      deps: {
        close: async () => {
          closed += 1
        },
      },
    })
    await w.worker.onModuleDestroy()
    expect(closed).toBe(1)
    await expect(world().worker.onModuleDestroy()).resolves.toBeUndefined()
  })
})

describe('the manual path and the pool boundaries', () => {
  it('a manual claim holds its slot while it claims, and passes the owner and the source', async () => {
    const args: unknown[] = []
    const w = world({ claims: [] })
    const ledger = (w.worker as unknown as { deps: WorkerDeps }).deps.ledger as {
      claimSource: WorkerDeps['ledger']['claimSource']
    }
    const real = ledger.claimSource
    ledger.claimSource = async (input) => {
      args.push(input)
      return real(input)
    }
    await w.worker.start()
    await Promise.all([
      w.worker.runSource({ cycleId: uuid(1), sourceId: uuid(5), actor: uuid(6) }),
      w.worker.runDue({ cycleId: uuid(1) }),
    ])
    expect(w.log.filter((l) => l.startsWith('claim'))).toEqual(['claimSource', 'claim:1'])
    expect(args).toEqual([{ cycleId: uuid(1), sourceId: uuid(5), actor: uuid(6), owner: 'spec' }])
    await w.worker.runDue({ cycleId: uuid(1) })
    expect(w.log.filter((l) => l.startsWith('claim')).at(-1)).toBe('claim:2')
  })

  it('a refused manual claim runs nothing', async () => {
    const w = world()
    const ledger = (w.worker as unknown as { deps: WorkerDeps }).deps.ledger as {
      claimSource: unknown
    }
    ledger.claimSource = async () => ({ kind: 'REFUSED', reason: 'HOST_BUSY' })
    expect(
      await w.worker.runSource({ cycleId: uuid(1), sourceId: uuid(5), actor: uuid(6) }),
    ).toEqual({
      kind: 'REFUSED',
      reason: 'HOST_BUSY',
    })
    expect(w.log).not.toContain('finish:SUCCEEDED')
  })

  it('with one slot taken, a pass claims exactly the one free slot', async () => {
    let release: () => void = () => undefined
    const w = world({
      claims: [claimed(1)],
      collect: () =>
        new Promise((resolve) => {
          release = () => resolve(batch('EXHAUSTED'))
        }),
      options: { runDeadlineMs: 5_000, deadlineGraceMs: 100 },
    })
    const first = w.worker.runClaimed(claimed(7))
    await sleep(5)
    const second = w.worker.runDue({ cycleId: uuid(1) })
    await sleep(5)
    expect(w.log.filter((l) => l.startsWith('claim'))).toEqual(['claim:1'])
    release()
    release()
    await Promise.all([first, second])
  })
})

describe('errors the worker names', () => {
  it('a refused binding and a setup refusal carry their own names', () => {
    expect(new MeterBindingRefusedError('x')).toMatchObject({
      name: 'MeterBindingRefusedError',
      message: 'x',
    })
    expect(new MeterBindingRefusedError('x')).toBeInstanceOf(RunSetupError)
    expect(new RunSetupError('y')).toMatchObject({ name: 'RunSetupError', message: 'y' })
  })

  it('the binding refusals say exactly what was refused', () => {
    expect(() =>
      meterWindowsFor(
        { accountKey: 'a:b', sourceId: uuid(7), sourceType: 'JSEARCH_API' },
        { accountKey: 'c:d', unit: 'REQUEST', window: 'DAY', limit: 1 },
      ),
    ).toThrow(new MeterBindingRefusedError('the source`s meter is not the claimed run`s account'))
  })
})

describe('endingOf: the sentences on the row', () => {
  const open = { closed: null, banCode: null, unrecordedBan: null } as const
  const b = { kind: 'BATCH', batch: batch('EXHAUSTED') } as const

  it('a ban, recorded or not, and a cancelled batch', () => {
    expect(
      endingOf(b, { closed: 'BANNED', banCode: 'ACCESS_POLICY', unrecordedBan: null }, []),
    ).toEqual({
      outcome: 'FAILED',
      errorCode: 'ACCESS_POLICY',
      errorMessage: 'the host refused a request; the run stopped',
    })
    expect(
      endingOf(b, { closed: 'BANNED', banCode: 'RATE_LIMIT', unrecordedBan: {} as HostBan }, []),
    ).toEqual({
      outcome: 'FAILED',
      errorCode: 'HOST_BAN_UNRECORDED',
      errorMessage: 'the host refused a request and its ban could not be recorded',
    })
    expect(endingOf({ kind: 'BATCH', batch: batch('CANCELLED', 'CANCELLED') }, open, [])).toEqual({
      outcome: 'CANCELLED',
      errorCode: 'CANCELLED',
      errorMessage: 'the run was cancelled',
    })
  })

  it('the LAST request error decides, not the first and not a later success', () => {
    const many = buildCollectionBatch({
      observations: [],
      facts: {
        stop: 'COST_STOP',
        pagesCompleted: 1,
        counts: { raw: 0, normalized: 0, invalid: 0, quarantined: 0, discarded: 0 },
        scope: { namespace: 'n', query: null, configVersion: 1, window: null },
        resumed: false,
      },
      requests: [report('UPSTREAM', 'first'), report('COST_STOP', 'second'), report(null)],
      checkpoint: null,
      invalidSamples: [],
    })
    expect(endingOf({ kind: 'BATCH', batch: many }, open, [])).toEqual({
      outcome: 'PARTIAL',
      errorCode: 'COST_STOP',
      errorMessage: 'second',
    })
  })

  it('a thrown setup refusal keeps its own sentence, redacted', () => {
    expect(
      endingOf({ kind: 'THREW', error: new RunSetupError('setup with sekrit-key') }, open, [
        'sekrit-key',
      ]),
    ).toEqual({
      outcome: 'FAILED',
      errorCode: 'ADAPTER_INVARIANT',
      errorMessage: 'setup with [REDACTED]',
    })
    expect(
      endingOf(
        { kind: 'THREW', error: Object.assign(new Error('x'), { code: 'NOT_MARKED_SENT' }) },
        open,
        [],
      ).errorCode,
    ).toBe('NOT_MARKED_SENT')
  })
})
