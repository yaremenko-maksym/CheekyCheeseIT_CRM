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
  if (overrides.sweep) sweepStuckExtractions.mockImplementation(overrides.sweep as () => never)
  if (overrides.requeue) requeueAbandoned.mockImplementation(overrides.requeue as () => never)

  const resumes = { sweepStuckExtractions, requeueAbandoned }
  const cron = new ResumeExtractionCronService(resumes as unknown as SeniorResumesService)
  return { cron, sweepStuckExtractions, requeueAbandoned }
}

describe('ResumeExtractionCronService', () => {
  /**
   * MUTATION: delete the `requeueAbandoned()` call from the handler — this goes
   * red. Before this file, that deletion changed nothing anywhere in the suite.
   */
  it('runs BOTH sweeps on every tick', async () => {
    const { cron, sweepStuckExtractions, requeueAbandoned } = buildCron()

    await cron.handleStuckExtractions()

    expect(sweepStuckExtractions).toHaveBeenCalledTimes(1)
    expect(requeueAbandoned).toHaveBeenCalledTimes(1)
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
