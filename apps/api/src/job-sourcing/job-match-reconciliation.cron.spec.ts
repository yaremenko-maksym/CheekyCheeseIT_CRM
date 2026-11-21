import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reconcile = vi.fn()
const recover = vi.fn()
const rekey = vi.fn()
const invalidate = vi.fn()
vi.mock('./queue/queue-generation', async (orig) => ({
  ...(await orig<typeof import('./queue/queue-generation')>()),
  invalidateGenerationsForNewJobs: (...a: unknown[]) => invalidate(...a),
}))
vi.mock('./ownership/dirty-work.store', async (orig) => ({
  ...(await orig<typeof import('./ownership/dirty-work.store')>()),
  recoverExpiredDirty: (...a: unknown[]) => recover(...a),
  enqueueIdentityRekey: (...a: unknown[]) => rekey(...a),
}))
vi.mock('./runtime/reconciliation', async (orig) => ({
  ...(await orig<typeof import('./runtime/reconciliation')>()),
  reconcileOnce: (...a: unknown[]) => reconcile(...a),
}))

import {
  JobMatchReconciliationCronService,
  MATCH_DRAIN_BUDGET_MS,
  MATCH_RECONCILIATION_CRON,
  RECONCILE_RECOVER_BATCH,
} from './job-match-reconciliation.cron'
import { RECONCILE_MAX_DRAIN_BATCHES } from './runtime/reconciliation'

const report = (over: Record<string, unknown> = {}) => ({
  scanned: 5,
  stale: 2,
  enqueued: 2,
  failed: 0,
  skipped: 0,
  gaveUp: 0,
  gaveUpIds: [] as string[],
  pages: 1,
  cursor: null,
  ...over,
})

function make(enabled: boolean | null = true, claimedPerRun: number[] = [0]) {
  const db = { db: { execute: vi.fn() } }
  const runOnce = vi.fn()
  for (const c of claimedPerRun) runOnce.mockResolvedValueOnce({ claimed: c, done: c })
  runOnce.mockResolvedValue({ claimed: 0, done: 0 })
  const config = { get: vi.fn(() => enabled ?? undefined) }
  const svc = new JobMatchReconciliationCronService(
    db as never,
    { runOnce } as never,
    config as never,
  )
  return { svc, db, runOnce }
}

let log: ReturnType<typeof vi.spyOn>
let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  reconcile.mockReset()
  recover.mockReset()
  rekey.mockReset()
  rekey.mockResolvedValue(0)
  invalidate.mockReset()
  invalidate.mockResolvedValue(3)
  recover.mockResolvedValue({ requeued: 0, failed: 0 })
  reconcile.mockResolvedValue(report())
  log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
  error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe('JobMatchReconciliationCronService', () => {
  it('runs on a six-hour cadence at minute 17', () => {
    expect(MATCH_RECONCILIATION_CRON).toBe('17 */6 * * *')
  })

  it('does nothing while the flag is off or absent', async () => {
    for (const flag of [false, null]) {
      const { svc, runOnce } = make(flag)
      await svc.handleReconciliation()
      expect(runOnce).not.toHaveBeenCalled()
    }
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('does nothing without a config service', async () => {
    const svc = new JobMatchReconciliationCronService(
      { db: {} } as never,
      { runOnce: vi.fn() } as never,
    )
    await svc.handleReconciliation()
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('sweeps, drains until a short batch, and logs counts only', async () => {
    const { svc, db, runOnce } = make(true, [200, 7])
    await svc.handleReconciliation()
    expect(reconcile).toHaveBeenCalledWith(db.db, { cursor: null })
    expect(runOnce).toHaveBeenCalledTimes(2)
    const line = String(log.mock.calls[0]?.[0])
    expect(line).toContain('scanned=5 stale=2 enqueued=2 skipped=0 failed=0 pages=1')
    expect(line).toContain('recomputed=207')
    expect(line).toMatch(/durationMs=\d+/)
  })

  it('caps the drain', async () => {
    const { svc, runOnce } = make(true, Array(50).fill(200))
    await svc.handleReconciliation()
    expect(runOnce).toHaveBeenCalledTimes(RECONCILE_MAX_DRAIN_BATCHES)
  })

  it('keeps the cursor of an unfinished sweep and resumes from it', async () => {
    const { svc } = make()
    reconcile.mockResolvedValueOnce(report({ cursor: 'abc' }))
    await svc.handleReconciliation()
    await svc.handleReconciliation()
    expect(reconcile.mock.calls[1]?.[1]).toEqual({ cursor: 'abc' })
    await svc.handleReconciliation()
    expect(reconcile.mock.calls[2]?.[1]).toEqual({ cursor: null })
  })

  it('AC6: skips a tick while a sweep is running, then runs again', async () => {
    const { svc } = make()
    let release!: () => void
    reconcile.mockImplementationOnce(() => new Promise((r) => (release = () => r(report()))))
    const first = svc.handleReconciliation()
    await svc.handleReconciliation()
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    release()
    await first
    await svc.handleReconciliation()
    expect(reconcile).toHaveBeenCalledTimes(2)
  })

  it('AC5: an infrastructure error is logged, never thrown, and the next tick retries', async () => {
    const { svc } = make()
    reconcile.mockRejectedValueOnce(new Error('connection lost'))
    await expect(svc.handleReconciliation()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledTimes(1)
    await svc.handleReconciliation()
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledTimes(1)
  })
  it('reads the flag by its name with infer', async () => {
    const db = { db: {} }
    const get = vi.fn(() => false)
    const svc = new JobMatchReconciliationCronService(db as never, {} as never, { get } as never)
    await svc.handleReconciliation()
    expect(get).toHaveBeenCalledWith('JOB_MATCH_RECONCILIATION_ENABLED', { infer: true })
  })

  it('logs the skipped tick, the resume marker and the elapsed time', async () => {
    const { svc } = make()
    let release!: () => void
    reconcile.mockImplementationOnce(
      () => new Promise((r) => (release = () => r(report({ cursor: 'c' })))),
    )
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1250)
    const first = svc.handleReconciliation()
    await svc.handleReconciliation()
    expect(String(warn.mock.calls[0]?.[0])).toContain('still running')
    release()
    await first
    const line = String(log.mock.calls[0]?.[0])
    expect(line).toContain('resumeCursor=set')
    expect(line).toContain('durationMs=250')
    expect(now).toHaveBeenCalledTimes(2)
  })

  it('logs resumeCursor=none for a finished sweep and names the failure', async () => {
    const { svc } = make()
    await svc.handleReconciliation()
    expect(String(log.mock.calls[0]?.[0])).toContain('resumeCursor=none')
    reconcile.mockRejectedValueOnce(new Error('x'))
    await svc.handleReconciliation()
    expect(String(error.mock.calls[0]?.[0])).toContain(
      'Match reconciliation failed; will retry next tick',
    )
  })

  it('a full batch continues the drain and a short one stops it', async () => {
    const { svc, runOnce } = make(true, [200, 200, 199, 200])
    await svc.handleReconciliation()
    expect(runOnce).toHaveBeenCalledTimes(3)
  })

  it('SR-M-1: recovers expired leases first, in the same tick, before sweeping', async () => {
    const order: string[] = []
    recover.mockImplementation(async () => {
      order.push('recover')
      return { requeued: 3, failed: 1 }
    })
    reconcile.mockImplementation(async () => {
      order.push('sweep')
      return report()
    })
    const { svc, db } = make()
    await svc.handleReconciliation()
    expect(order).toEqual(['recover', 'sweep'])
    expect(recover).toHaveBeenCalledWith(db.db, { batchSize: RECONCILE_RECOVER_BATCH })
    const line = String(log.mock.calls[0]?.[0])
    expect(line).toContain('recoveredRequeued=3 recoveredFailed=1')
  })

  it('a recovery failure is logged like any tick failure and the sweep does not run', async () => {
    recover.mockRejectedValueOnce(new Error('db down'))
    const { svc } = make()
    await svc.handleReconciliation()
    expect(reconcile).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('warns once with ids and counts when the sweep gave up on opportunities', async () => {
    reconcile.mockResolvedValue(report({ gaveUp: 2, gaveUpIds: ['a', 'b'] }))
    const { svc } = make()
    await svc.handleReconciliation()
    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0]?.[0])
    expect(line).toContain('gave up on 2 opportunity(ies)')
    expect(line).toContain('ids: a,b')
  })

  it('does not warn when nothing was given up', async () => {
    const { svc } = make()
    await svc.handleReconciliation()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('requestDrain: the post-run match drain', () => {
  it('does nothing while the flag is off, absent, or without a config service', async () => {
    for (const flag of [false, null]) {
      const { svc, runOnce } = make(flag, [200])
      await svc.requestDrain()
      expect(runOnce).not.toHaveBeenCalled()
    }
    const runOnce = vi.fn()
    await new JobMatchReconciliationCronService(
      { db: {} } as never,
      { runOnce } as never,
    ).requestDrain()
    expect(runOnce).not.toHaveBeenCalled()
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('drains until idle, retires the queue snapshots and logs counts only', async () => {
    const { svc, db, runOnce } = make(true, [200, 200, 13])
    await svc.requestDrain()
    // the short batch completed rows (their OPPORTUNITY follow-ups are new work): one more, empty
    expect(runOnce).toHaveBeenCalledTimes(4)
    expect(invalidate).toHaveBeenCalledWith(db.db)
    const line = String(log.mock.calls[0]?.[0])
    expect(line).toContain(
      'Match drain: recomputed=413 done=413 batches=4 generationsInvalidated=3',
    )
    expect(line).toMatch(/durationMs=\d+/)
    expect(reconcile).not.toHaveBeenCalled()
    expect(recover).not.toHaveBeenCalled()
  })

  it('is not capped by a batch count: a large backlog drains in one request', async () => {
    const { svc, runOnce } = make(true, Array(30).fill(200))
    await svc.requestDrain()
    expect(runOnce).toHaveBeenCalledTimes(31)
  })

  it('starts no new batch once the time budget has passed; the first always runs', async () => {
    const { svc, runOnce } = make(true, Array(10).fill(200))
    // start, after batch 1 (just under the budget), after batch 2 (exactly at it), then the log
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1000 + MATCH_DRAIN_BUDGET_MS - 1)
      .mockReturnValueOnce(1000 + MATCH_DRAIN_BUDGET_MS)
      .mockReturnValue(1000 + MATCH_DRAIN_BUDGET_MS)
    await svc.requestDrain()
    expect(runOnce).toHaveBeenCalledTimes(2)
    expect(MATCH_DRAIN_BUDGET_MS).toBe(60_000)
    // the pass's own duration: the last reading minus its start
    expect(String(log.mock.calls[0]?.[0])).toContain('durationMs=60000')
  })

  it('nothing recomputed: no retire and no log line', async () => {
    const { svc, runOnce } = make(true, [0])
    await svc.requestDrain()
    expect(runOnce).toHaveBeenCalledTimes(1)
    expect(invalidate).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('claimed but nothing done (all stale or failed): no retire, the counts are logged', async () => {
    const runOnce = vi.fn().mockResolvedValue({ claimed: 5, done: 0 })
    const svc = new JobMatchReconciliationCronService(
      { db: {} } as never,
      { runOnce } as never,
      { get: () => true } as never,
    )
    await svc.requestDrain()
    expect(invalidate).not.toHaveBeenCalled()
    expect(String(log.mock.calls[0]?.[0])).toContain('recomputed=5 done=0 batches=1')
  })

  it('single-flight: a request during a drain is not a second drainer; it asks for one more pass', async () => {
    const { svc, runOnce } = make(true, [])
    let release!: () => void
    runOnce.mockReset()
    runOnce
      .mockImplementationOnce(
        () => new Promise((r) => (release = () => r({ claimed: 4, done: 4 }))),
      )
      .mockResolvedValue({ claimed: 0, done: 0 })
    const first = svc.requestDrain()
    const second = svc.requestDrain()
    expect(second).toBe(first)
    expect(runOnce).toHaveBeenCalledTimes(1)
    release()
    await first
    // first pass: 4 done, then an empty batch; the second request bought exactly one more pass
    expect(runOnce).toHaveBeenCalledTimes(3)
    await svc.requestDrain()
    expect(runOnce).toHaveBeenCalledTimes(4)
  })

  it('a drain failure never rejects, is logged, and still retires for what was done', async () => {
    const { svc, runOnce } = make(true, [200])
    runOnce.mockRejectedValueOnce(new Error('connection lost'))
    await expect(svc.requestDrain()).resolves.toBeUndefined()
    expect(String(error.mock.calls[0]?.[0])).toContain(
      'Match drain failed after recomputed=200 batches=1; the rest stays pending for the next run or the sweep',
    )
    expect(invalidate).toHaveBeenCalledTimes(1)
    // the next request drains again
    await svc.requestDrain()
    expect(runOnce).toHaveBeenCalledTimes(3)
  })

  it('a failed retire never rejects and is logged', async () => {
    const { svc } = make(true, [3])
    invalidate.mockRejectedValueOnce(new Error('lock timeout'))
    await expect(svc.requestDrain()).resolves.toBeUndefined()
    expect(String(error.mock.calls[0]?.[0])).toContain('queue snapshots not retired')
    expect(String(log.mock.calls[0]?.[0])).toContain('generationsInvalidated=0')
  })

  it('a request while a sweep runs is deferred: the sweep drains, then one fresh-only drain runs after it', async () => {
    const { svc, runOnce } = make(true, [])
    let release!: () => void
    reconcile.mockImplementationOnce(() => new Promise((r) => (release = () => r(report()))))
    const sweep = svc.handleReconciliation()
    await Promise.resolve()
    await Promise.resolve()
    await svc.requestDrain()
    expect(runOnce).not.toHaveBeenCalled()
    release()
    await sweep
    await new Promise((r) => setImmediate(r))
    // the sweep's own drain claims retries too; the deferred post-run drain only fresh rows
    expect(runOnce.mock.calls).toEqual([[{ freshOnly: false }], [{ freshOnly: true }]])
    // the deferral is spent: the next sweep drains once and starts no drain after it
    await svc.handleReconciliation()
    await new Promise((r) => setImmediate(r))
    expect(runOnce).toHaveBeenCalledTimes(3)
  })

  it('item 7: a request while the sweep is in its retire step still gets a drain pass', async () => {
    const { svc, runOnce } = make(true, [3])
    let release!: (n: number) => void
    invalidate.mockImplementationOnce(() => new Promise((r) => (release = r)))
    const sweep = svc.handleReconciliation()
    for (let k = 0; k < 20 && invalidate.mock.calls.length === 0; k++) await Promise.resolve()
    expect(invalidate).toHaveBeenCalledTimes(1)
    // the sweep's drain is over: this run's rows would wait for the next run or sweep
    const calls = runOnce.mock.calls.length
    await svc.requestDrain()
    expect(runOnce).toHaveBeenCalledTimes(calls)
    release(1)
    await sweep
    await new Promise((r) => setImmediate(r))
    expect(runOnce).toHaveBeenCalledTimes(calls + 1)
    expect(runOnce).toHaveBeenLastCalledWith({ freshOnly: true })
  })

  it('a sweep tick waits for an in-flight drain, then runs (never skipped, never concurrent)', async () => {
    const { svc, runOnce } = make(true, [])
    const order: string[] = []
    let release!: () => void
    runOnce.mockReset()
    runOnce
      .mockImplementationOnce(
        () =>
          new Promise(
            (r) => (release = () => (order.push('drain-end'), r({ claimed: 1, done: 1 }))),
          ),
      )
      .mockResolvedValue({ claimed: 0, done: 0 })
    reconcile.mockImplementation(async () => {
      order.push('sweep')
      return report()
    })
    const drain = svc.requestDrain()
    const sweep = svc.handleReconciliation()
    await new Promise((r) => setImmediate(r))
    expect(reconcile).not.toHaveBeenCalled()
    release()
    await Promise.all([drain, sweep])
    expect(order).toEqual(['drain-end', 'sweep'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('a short batch that completed rows continues: the follow-ups of resolved records are drained', async () => {
    const { svc, runOnce } = make(true, [])
    runOnce.mockReset()
    runOnce
      .mockResolvedValueOnce({ claimed: 50, done: 50 })
      .mockResolvedValueOnce({ claimed: 50, done: 50 })
      .mockResolvedValueOnce({ claimed: 0, done: 0 })
      .mockResolvedValue({ claimed: 9, done: 9 })
    await svc.requestDrain()
    expect(runOnce).toHaveBeenCalledTimes(3)
  })

  it('a short batch of retries only (nothing done) stops it: no spin on rows back in PENDING', async () => {
    const { svc, runOnce } = make(true, [])
    runOnce.mockReset()
    runOnce
      .mockResolvedValueOnce({ claimed: 7, done: 2 })
      .mockResolvedValueOnce({ claimed: 5, done: 0 })
      .mockResolvedValue({ claimed: 5, done: 5 })
    await svc.requestDrain()
    expect(runOnce).toHaveBeenCalledTimes(2)
  })

  it('CR-M-1: a request after the budget was spent gets its own pass, with a fresh budget', async () => {
    const { svc, runOnce } = make(true, [])
    let release!: () => void
    runOnce.mockReset()
    runOnce
      .mockImplementationOnce(
        () => new Promise((r) => (release = () => r({ claimed: 0, done: 0 }))),
      )
      .mockResolvedValue({ claimed: 0, done: 0 })
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValue(1000 + MATCH_DRAIN_BUDGET_MS)
    const first = svc.requestDrain()
    expect(svc.requestDrain()).toBe(first)
    release()
    await first
    expect(runOnce).toHaveBeenCalledTimes(2)
  })

  it('SPEC-L-1: a request during the retire step gets one more pass, then the drain settles', async () => {
    const { svc, runOnce } = make(true, [3])
    let release!: (n: number) => void
    invalidate.mockImplementationOnce(() => new Promise((r) => (release = r)))
    const first = svc.requestDrain()
    for (let k = 0; k < 20 && invalidate.mock.calls.length === 0; k++) await Promise.resolve()
    expect(invalidate).toHaveBeenCalledTimes(1)
    // pass 1: the short batch completed rows, then an empty one
    expect(runOnce).toHaveBeenCalledTimes(2)
    expect(svc.requestDrain()).toBe(first)
    release(1)
    await first
    // pass 2 (nothing done: no second retire), and no third
    expect(runOnce).toHaveBeenCalledTimes(3)
    expect(invalidate).toHaveBeenCalledTimes(1)
    // settled: a later request starts a new drain
    const next = svc.requestDrain()
    expect(next).not.toBe(first)
    await next
    expect(runOnce).toHaveBeenCalledTimes(4)
  })

  it('CR-H-1: the post-run drain claims fresh rows only; the sweep claims retries too', async () => {
    const { svc, runOnce } = make(true, [200, 13])
    await svc.requestDrain()
    expect(runOnce.mock.calls.length).toBeGreaterThan(0)
    for (const call of runOnce.mock.calls) expect(call).toEqual([{ freshOnly: true }])
    runOnce.mockClear()
    await svc.handleReconciliation()
    expect(runOnce.mock.calls).toEqual([[{ freshOnly: false }]])
  })

  it('the sweep retires the queue snapshots when its own drain completed rows, not otherwise', async () => {
    const { svc, db } = make(true, [3])
    await svc.handleReconciliation()
    expect(invalidate).toHaveBeenCalledWith(db.db)
    expect(String(log.mock.calls[0]?.[0])).toContain('recomputed=3 generationsInvalidated=3')
    invalidate.mockClear()
    await make(true, [0]).svc.handleReconciliation()
    expect(invalidate).not.toHaveBeenCalled()
  })
})

describe('JobMatchReconciliationCronService.onApplicationBootstrap (senior roles PR 4)', () => {
  const settle = () => new Promise((r) => setImmediate(r))

  it('starts exactly one sweep when JOB_MATCH_RECONCILIATION_ENABLED is true', async () => {
    const { svc } = make(true)
    svc.onApplicationBootstrap()
    await settle()
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]?.[0])).toContain('Match reconciliation: scanned=5')
  })

  it('is a no-op when the flag is not true, or without a config service', async () => {
    for (const flag of [false, null]) {
      const { svc, runOnce } = make(flag)
      svc.onApplicationBootstrap()
      await settle()
      expect(runOnce).not.toHaveBeenCalled()
    }
    new JobMatchReconciliationCronService({ db: {} } as never, {} as never).onApplicationBootstrap()
    await settle()
    expect(reconcile).not.toHaveBeenCalled()
    expect(recover).not.toHaveBeenCalled()
  })

  it('returns before the sweep resolves (startup not blocked)', async () => {
    const { svc } = make(true)
    let release!: () => void
    reconcile.mockImplementationOnce(() => new Promise((r) => (release = () => r(report()))))
    expect(svc.onApplicationBootstrap()).toBeUndefined()
    await settle()
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()
    release()
    await settle()
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('a failing boot sweep is logged and never rejects bootstrap', async () => {
    const { svc } = make(true)
    reconcile.mockRejectedValueOnce(new Error('connection lost'))
    expect(() => svc.onApplicationBootstrap()).not.toThrow()
    await settle()
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[0])).toContain('Match reconciliation failed')
  })

  it('a cron tick during the boot sweep is skipped; a requestDrain during it is deferred', async () => {
    const { svc, runOnce } = make(true, [])
    let release!: () => void
    reconcile.mockImplementationOnce(() => new Promise((r) => (release = () => r(report()))))
    svc.onApplicationBootstrap()
    await settle()
    await svc.handleReconciliation()
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('previous sweep still running, tick skipped')
    await svc.requestDrain()
    expect(runOnce).not.toHaveBeenCalled()
    release()
    await settle()
    await settle()
    expect(runOnce.mock.calls).toEqual([[{ freshOnly: false }], [{ freshOnly: true }]])
  })

  it('the boot sweep enqueues the identity rekey before it reconciles (sources-18)', async () => {
    const { svc, db } = make(true)
    rekey.mockImplementationOnce(async () => {
      expect(reconcile).not.toHaveBeenCalled()
      return 4
    })
    svc.onApplicationBootstrap()
    await settle()
    expect(rekey).toHaveBeenCalledTimes(1)
    expect(rekey).toHaveBeenCalledWith(db.db)
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(log.mock.calls.map((c) => String(c[0]))).toContain('Identity rekey: enqueued=4')
  })

  it('an empty identity rekey logs nothing of its own', async () => {
    const { svc } = make(true)
    svc.onApplicationBootstrap()
    await settle()
    expect(rekey).toHaveBeenCalledTimes(1)
    expect(log.mock.calls.some((c) => String(c[0]).includes('Identity rekey'))).toBe(false)
  })

  it('no identity rekey while the flag is off or absent', async () => {
    for (const flag of [false, null]) {
      const { svc } = make(flag)
      svc.onApplicationBootstrap()
      await settle()
    }
    expect(rekey).not.toHaveBeenCalled()
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('a failed identity rekey warns once and the sweep still runs', async () => {
    const { svc } = make(true)
    rekey.mockRejectedValueOnce(new Error('relation missing'))
    expect(() => svc.onApplicationBootstrap()).not.toThrow()
    await settle()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'Identity rekey failed, the sweep runs without it',
    )
    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(error).not.toHaveBeenCalled()
  })

  it('the boot sweep retires queue snapshots when it recomputed rows', async () => {
    const { svc, db } = make(true, [3])
    svc.onApplicationBootstrap()
    await settle()
    expect(invalidate).toHaveBeenCalledWith(db.db)
    expect(String(log.mock.calls[0]?.[0])).toContain('recomputed=3 generationsInvalidated=3')
  })
})
