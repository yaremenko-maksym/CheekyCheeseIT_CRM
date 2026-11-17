/**
 * ResumeExtractionCronService — the scheduled half of AC3.
 *
 * This file exists because the class had NO test of any kind: it was declared,
 * registered in the module, and never executed by anything except production.
 * The two sweeps it drives are what stop a container restart from parking a
 * resume in RUNNING (or QUEUED) forever, so "it is registered" is not evidence
 * that it works.
 *
 * No DB here — `SeniorResumesService` is stubbed. What is under test is the
 * WIRING and the failure behaviour, both of which are pure logic:
 *   - both halves of the sweep run, every tick, in order;
 *   - one half throwing never prevents the handler from returning cleanly.
 * The sweeps' own SQL is covered against a real Postgres in
 * `resumes-rbac.integration.spec.ts` (R-INT-9 / R-INT-11).
 */
import { Logger } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { ResumeExtractionCronService } from './resume-extraction.cron'
import type { SeniorResumesService } from './resumes.service'
import type { ResumeVerificationService } from './verification/resume-verification.service'

function buildCron(overrides: Partial<Record<'sweep' | 'requeue' | 'stalled', unknown>> = {}) {
  const sweepStuckExtractions = vi.fn().mockResolvedValue(0)
  const requeueAbandoned = vi.fn().mockResolvedValue(0)
  const sweepStuckRenders = vi.fn().mockResolvedValue(0)
  if (overrides.sweep) sweepStuckExtractions.mockImplementation(overrides.sweep as () => never)
  if (overrides.requeue) requeueAbandoned.mockImplementation(overrides.requeue as () => never)

  const sweepStalledVerifications = vi.fn().mockResolvedValue(0)
  if (overrides.stalled)
    sweepStalledVerifications.mockImplementation(overrides.stalled as () => never)

  const resumes = { sweepStuckExtractions, requeueAbandoned, sweepStuckRenders }
  const cron = new ResumeExtractionCronService(
    resumes as unknown as SeniorResumesService,
    { sweepStalledVerifications } as unknown as ResumeVerificationService,
  )
  return {
    cron,
    sweepStuckExtractions,
    requeueAbandoned,
    sweepStuckRenders,
    sweepStalledVerifications,
  }
}

describe('ResumeExtractionCronService', () => {
  /**
   * MUTATION: delete the `requeueAbandoned()` call from the handler — this goes
   * red. Before this file, that deletion changed nothing anywhere in the suite.
   */
  it('runs ALL THREE sweeps on every tick', async () => {
    const { cron, sweepStuckExtractions, requeueAbandoned, sweepStuckRenders } = buildCron()

    await cron.handleStuckExtractions()

    expect(sweepStuckExtractions).toHaveBeenCalledTimes(1)
    expect(requeueAbandoned).toHaveBeenCalledTimes(1)
    // The render sweep. `sweepStuckRenders` existed, was invoked from NOWHERE,
    // and had no test — so a render abandoned by a container restart (i.e. by
    // every deploy) stayed RUNNING for ever while the tab polled it every
    // 2.5 s. Nothing in the suite noticed, because nothing asked.
    expect(sweepStuckRenders).toHaveBeenCalledTimes(1)
  })

  /**
   * The handler wraps everything in try/catch so a failing sweep cannot kill
   * the scheduler. That is right, and it also means a MISSING method would be
   * swallowed as "sweep failed" and every assertion above would still pass on a
   * fake service that never had it. This pins the real shape.
   */
  it('calls a method the real service actually exposes', async () => {
    const { SeniorResumesService: RealService } = await import('./resumes.service')
    for (const name of ['sweepStuckExtractions', 'requeueAbandoned', 'sweepStuckRenders']) {
      expect(typeof RealService.prototype[name as keyof typeof RealService.prototype]).toBe(
        'function',
      )
    }
  })

  it('still re-drives abandoned rows when the stuck sweep swept nothing', async () => {
    const { cron, sweepStuckExtractions, requeueAbandoned } = buildCron()
    sweepStuckExtractions.mockResolvedValue(0)
    requeueAbandoned.mockResolvedValue(3)

    await cron.handleStuckExtractions()

    expect(requeueAbandoned).toHaveBeenCalledTimes(1)
  })

  /**
   * An unhandled rejection inside a @nestjs/schedule task kills the scheduler
   * silently — the SalaryCron precedent. The handler must absorb failures.
   */
  it('does not reject when the stuck sweep throws', async () => {
    const { cron } = buildCron({
      sweep: () => {
        throw new Error('DB connection lost')
      },
    })

    await expect(cron.handleStuckExtractions()).resolves.toBeUndefined()
  })

  it('does not reject when the re-drive throws', async () => {
    const { cron } = buildCron({
      requeue: () => Promise.reject(new Error('S3 unreachable')),
    })

    await expect(cron.handleStuckExtractions()).resolves.toBeUndefined()
  })

  // ── The stalled verification sweep (Task 16) ──────────────────────────────

  it('runs the stalled verification sweep on every tick, with the current time', async () => {
    const { cron, sweepStalledVerifications } = buildCron()
    const before = Date.now()
    await cron.handleStuckExtractions()
    expect(sweepStalledVerifications).toHaveBeenCalledTimes(1)
    const now = sweepStalledVerifications.mock.calls[0]?.[0] as Date
    expect(now).toBeInstanceOf(Date)
    expect(now.getTime()).toBeGreaterThanOrEqual(before)
    expect(now.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('a failing extraction pass does not stop the verification sweep', async () => {
    const { cron, sweepStalledVerifications } = buildCron({
      sweep: () => Promise.reject(new Error('DB connection lost')),
    })
    await cron.handleStuckExtractions()
    expect(sweepStalledVerifications).toHaveBeenCalledTimes(1)
  })

  it('a failing verification sweep neither rejects nor stops the extraction pass', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    const warns = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const { cron, sweepStuckExtractions, sweepStuckRenders } = buildCron({
      stalled: () => Promise.reject(new Error('lock timeout')),
    })
    await expect(cron.handleStuckExtractions()).resolves.toBeUndefined()
    expect(sweepStuckExtractions).toHaveBeenCalledTimes(1)
    expect(sweepStuckRenders).toHaveBeenCalledTimes(1)
    expect(errors.mock.calls.map((c) => c[0])).toEqual([
      'Resume verification sweep failed: lock timeout',
    ])
    expect(warns).not.toHaveBeenCalled()
    errors.mockRestore()
    warns.mockRestore()
  })

  it('logs the stalled count only when a run was swept', async () => {
    const warns = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const { cron, sweepStalledVerifications } = buildCron()
    await cron.handleStuckExtractions()
    expect(warns).not.toHaveBeenCalled()
    sweepStalledVerifications.mockResolvedValueOnce(2)
    await cron.handleStuckExtractions()
    expect(warns.mock.calls.map((c) => c[0])).toEqual([
      'Swept 2 stalled resume verification run(s)',
    ])
    warns.mockRestore()
  })

  it('the verification service really exposes the sweep', async () => {
    const { ResumeVerificationService: Real } =
      await import('./verification/resume-verification.service')
    expect(typeof Real.prototype.sweepStalledVerifications).toBe('function')
  })
})
