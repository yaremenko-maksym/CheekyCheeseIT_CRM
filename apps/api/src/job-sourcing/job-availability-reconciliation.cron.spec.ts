import { Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const recover = vi.fn()
vi.mock('./ownership/dirty-work.store', async (orig) => ({
  ...(await orig<typeof import('./ownership/dirty-work.store')>()),
  recoverExpiredDirty: (...a: unknown[]) => recover(...a),
}))

import {
  AVAILABILITY_MAX_DRAIN_BATCHES,
  AVAILABILITY_RECONCILE_RECOVER_BATCH,
  AVAILABILITY_RECONCILIATION_CRON,
  JobAvailabilityReconciliationCronService,
} from './job-availability-reconciliation.cron'

const rep = (claimed: number) => ({
  claimed,
  done: claimed,
  deferred: 0,
  retried: 0,
  failed: 0,
  fenced: 0,
})

function make(enabled: boolean | null = true, claimedPerRun: number[] = [0]) {
  const db = { db: { execute: vi.fn() } }
  const runOnce = vi.fn()
  for (const c of claimedPerRun) runOnce.mockResolvedValueOnce(rep(c))
  runOnce.mockResolvedValue(rep(0))
  const config = { get: vi.fn(() => enabled ?? undefined) }
  const svc = new JobAvailabilityReconciliationCronService(
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
  recover.mockReset()
  recover.mockResolvedValue({ requeued: 0, failed: 0 })
  log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
  error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

describe('JobAvailabilityReconciliationCronService', () => {
  it('runs on a six-hour cadence at minute 37', () => {
    expect(AVAILABILITY_RECONCILIATION_CRON).toBe('37 */6 * * *')
  })

  it('AC3: does nothing while the flag is off or absent (no recover, no drain)', async () => {
    for (const flag of [false, null]) {
      const { svc, runOnce } = make(flag)
      await svc.handleReconciliation()
      expect(runOnce).not.toHaveBeenCalled()
    }
    expect(recover).not.toHaveBeenCalled()
  })

  it('does nothing without a config service', async () => {
    const svc = new JobAvailabilityReconciliationCronService(
      { db: {} } as never,
      { runOnce: vi.fn() } as never,
    )
    await svc.handleReconciliation()
    expect(recover).not.toHaveBeenCalled()
  })

  it('reads the flag by its name with infer', async () => {
    const get = vi.fn(() => false)
    const svc = new JobAvailabilityReconciliationCronService(
      { db: {} } as never,
      {} as never,
      { get } as never,
    )
    await svc.handleReconciliation()
    expect(get).toHaveBeenCalledWith('JOB_AVAILABILITY_RECONCILE_ENABLED', { infer: true })
  })

  it('AC4: drains until a short batch and logs the exact aggregated counts + duration', async () => {
    const db = { db: { execute: vi.fn() } }
    const runOnce = vi
      .fn()
      .mockResolvedValueOnce({
        claimed: 200,
        done: 5,
        deferred: 2,
        retried: 3,
        failed: 4,
        fenced: 6,
      })
      .mockResolvedValue({ claimed: 0, done: 0, deferred: 0, retried: 0, failed: 0, fenced: 0 })
    const svc = new JobAvailabilityReconciliationCronService(
      db as never,
      { runOnce } as never,
      { get: vi.fn(() => true) } as never,
    )
    const now = vi.spyOn(performance, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1250)
    await svc.handleReconciliation()
    expect(runOnce).toHaveBeenCalledTimes(2)
    const line = String(log.mock.calls[0]?.[0])
    // Distinct per-field values: an `-=` aggregation or an emptied label breaks this substring.
    expect(line).toContain('claimed=200 done=5 deferred=2 retried=3 failed=4 fenced=6 batches=2')
    expect(line).toContain('recoveredRequeued=0 recoveredFailed=0')
    expect(line).toContain('durationMs=250')
    expect(now).toHaveBeenCalledTimes(2)
  })

  it('AC4: caps the drain at the batch limit', async () => {
    const { svc, runOnce } = make(true, Array(50).fill(200))
    await svc.handleReconciliation()
    expect(runOnce).toHaveBeenCalledTimes(AVAILABILITY_MAX_DRAIN_BATCHES)
  })

  it('a full batch continues the drain and a short one stops it', async () => {
    const { svc, runOnce } = make(true, [200, 200, 199, 200])
    await svc.handleReconciliation()
    expect(runOnce).toHaveBeenCalledTimes(3)
  })

  it('AC4: skips a tick while a sweep is running, then runs again', async () => {
    const { svc } = make()
    let release!: () => void
    recover.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ requeued: 0, failed: 0 }))),
    )
    const first = svc.handleReconciliation()
    await svc.handleReconciliation()
    expect(recover).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('still running')
    release()
    await first
    await svc.handleReconciliation()
    expect(recover).toHaveBeenCalledTimes(2)
  })

  it('SR-M-1: recovers expired leases first, before draining', async () => {
    const order: string[] = []
    recover.mockImplementation(async () => {
      order.push('recover')
      return { requeued: 3, failed: 1 }
    })
    const db = { db: { execute: vi.fn() } }
    const runOnce = vi.fn(async () => {
      order.push('drain')
      return rep(0)
    })
    const svc = new JobAvailabilityReconciliationCronService(
      db as never,
      { runOnce } as never,
      { get: vi.fn(() => true) } as never,
    )
    await svc.handleReconciliation()
    expect(order).toEqual(['recover', 'drain'])
    expect(recover).toHaveBeenCalledWith(db.db, { batchSize: AVAILABILITY_RECONCILE_RECOVER_BATCH })
    expect(String(log.mock.calls[0]?.[0])).toContain('recoveredRequeued=3 recoveredFailed=1')
  })

  it('AC5: an infrastructure error is logged, never thrown, and the next tick retries', async () => {
    const { svc, runOnce } = make()
    runOnce
      .mockReset()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValue(rep(0))
    await expect(svc.handleReconciliation()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[0])).toContain(
      'Availability reconciliation failed; will retry next tick',
    )
    await svc.handleReconciliation()
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('a recovery failure is logged like any tick failure and the drain does not run', async () => {
    recover.mockRejectedValueOnce(new Error('db down'))
    const { svc, runOnce } = make()
    await svc.handleReconciliation()
    expect(runOnce).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledTimes(1)
  })
})
