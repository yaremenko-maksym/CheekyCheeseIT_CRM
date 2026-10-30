import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reconcile = vi.fn()
const recover = vi.fn()
vi.mock('./ownership/dirty-work.store', async (orig) => ({
  ...(await orig<typeof import('./ownership/dirty-work.store')>()),
  recoverExpiredDirty: (...a: unknown[]) => recover(...a),
}))
vi.mock('./runtime/reconciliation', async (orig) => ({
  ...(await orig<typeof import('./runtime/reconciliation')>()),
  reconcileOnce: (...a: unknown[]) => reconcile(...a),
}))

import {
  JobMatchReconciliationCronService,
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
  for (const c of claimedPerRun) runOnce.mockResolvedValueOnce({ claimed: c })
  runOnce.mockResolvedValue({ claimed: 0 })
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
