import { z } from 'zod'
import { jobSourceTypeSchema } from './job-sourcing'

/**
 * ADMIN controls over the run ledger (r5 Task 2.5 T9; ADR
 * docs/architecture/2026-10-24-job-source-run-ownership.md, section T9).
 *
 * Two endpoints only: a read-only listing of the sources the ledger is not running, and a reset of
 * one source's failure cap. The pause clear and the manual UNCERTAIN settle were deleted from the
 * ADR, so there is nothing here for them.
 */

/** The ledger's own bound on a reset reason (`resetFailures`): 1..500 characters. */
export const JOB_SOURCE_RESET_REASON_MAX = 500

/** Body of `POST /job-sourcing/admin/sources/:id/reset-failures`. Unknown keys are refused. */
export const resetJobSourceFailuresSchema = z
  .object({
    reason: z.string().trim().min(1).max(JOB_SOURCE_RESET_REASON_MAX),
  })
  .strict()

/**
 * Why a source is listed; one source may carry several.
 *  - FAILURE_CAP: `consecutive_failures` reached the cap (three LEASE_EXPIRED endings included).
 *  - HOST_PAUSED: its host's ban pause has not expired.
 *  - CLAIM_REFUSED: the last claim was refused; `lastErrorCode` is the refusal.
 *  - OVERDUE: an active source whose `next_attempt_at` is older than two cadences (starved).
 */
export const jobSourceExclusionReasonSchema = z.enum([
  'FAILURE_CAP',
  'HOST_PAUSED',
  'CLAIM_REFUSED',
  'OVERDUE',
])

/** An allow-list projection: config, credentials and the admin history never leave the API. */
export const excludedJobSourceSchema = z.object({
  sourceId: z.string().uuid(),
  type: jobSourceTypeSchema,
  hostKey: z.string().max(253).nullable(),
  reasons: z.array(jobSourceExclusionReasonSchema).min(1),
  consecutiveFailures: z.number().int().nonnegative(),
  lastErrorCode: z.string().max(64).nullable(),
  nextAttemptAt: z.string().datetime().nullable(),
  /** The host pause, when one is in force: until when, why (a typed code) and which source drew it. */
  pausedUntil: z.string().datetime().nullable(),
  pauseReason: z.string().max(64).nullable(),
  pauseSourceId: z.string().uuid().nullable(),
})

export const excludedJobSourceListSchema = z.object({
  items: z.array(excludedJobSourceSchema),
})

export type ResetJobSourceFailuresDto = z.infer<typeof resetJobSourceFailuresSchema>
export type JobSourceExclusionReason = z.infer<typeof jobSourceExclusionReasonSchema>
export type ExcludedJobSourceDto = z.infer<typeof excludedJobSourceSchema>
export type ExcludedJobSourceListDto = z.infer<typeof excludedJobSourceListSchema>
