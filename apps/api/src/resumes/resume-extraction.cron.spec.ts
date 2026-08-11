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
import { describe, expect, it, vi } from 'vitest'
import { ResumeExtractionCronService } from './resume-extraction.cron'
import type { SeniorResumesService } from './resumes.service'

function buildCron(overrides: Partial<Record<'sweep' | 'requeue', unknown>> = {}) {
  const sweepStuckExtractions = vi.fn().mockResolvedValue(0)
  const requeueAbandoned = vi.fn().mockResolvedValue(0)
  const sweepStuckRenders = vi.fn().mockResolvedValue(0)
  if (overrides.sweep) sweepStuckExtractions.mockImplementation(overrides.sweep as () => never)
  if (overrides.requeue) requeueAbandoned.mockImplementation(overrides.requeue as () => never)

  const resumes = { sweepStuckExtractions, requeueAbandoned, sweepStuckRenders }
  const cron = new ResumeExtractionCronService(resumes as unknown as SeniorResumesService)
  return { cron, sweepStuckExtractions, requeueAbandoned, sweepStuckRenders }
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
})
