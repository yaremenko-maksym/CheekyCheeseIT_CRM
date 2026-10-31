import { z } from 'zod'
import { jobCollectionOutcomeSchema, jobSourceTypeSchema } from './job-sourcing'

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

// ---------------------------------------------------------------------------
// Source-fetch-strategy U7 — the ADMIN source page
//
// Three read/write shapes behind `job-sourcing/admin`:
//   - the operational LIST (current health state + freshness + cadence summary);
//   - one source's DETAIL (run timeline + the health-event log + correlation hint);
//   - the NOTE write (the one untrusted input — bounded, non-blank like the column).
//
// The health STATE / REASON vocabularies mirror `HEALTH_STATE_VALUES` /
// `HEALTH_REASON_VALUES` in apps/api/src/database/schema/job-health.ts, and the
// TS side `job-sourcing/health/types.ts`; `job-source-health-schema.spec.ts` holds
// the database + TS lists to each other, and this one is pinned against them by
// the api controller spec.
// ---------------------------------------------------------------------------

/** The eight health states (ADR section 10). */
export const jobHealthStateSchema = z.enum([
  'BLOCKED',
  'CAPPED',
  'PAUSED',
  'FAILING',
  'EMPTY',
  'DEGRADED',
  'SILENT',
  'HEALTHY',
])

/** The eleven detector reasons (ADR section 10). */
export const jobHealthReasonSchema = z.enum([
  'VOLUME_DROP',
  'NO_NEW_ITEMS',
  'EMPTY_RESPONSE',
  'SCHEMA_DRIFT',
  'ACCESS_CHANGED',
  'THROTTLED',
  'SLOW',
  'PAYLOAD_GROWTH',
  'STALE_FEED',
  'BOARD_GONE',
  'DEADLINE_NEAR',
])

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
const dayOfWeekSchema = z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'])

/**
 * A source's fetch cadence, in a shape the page renders directly — the profile summary that
 * REPLACES the stale `minIntervalHours` (U1b stopped the old field from driving cadence; U7 removes
 * it from `jobSourceSchema`). Structured, not a prebuilt string, so the web localizes it (uk/en).
 * `null` as the field value = the source is never scheduled (the three deferred types, owner Q8).
 * Mirrors `FetchProfile` in apps/api/src/job-sourcing/scheduling/next-slot.ts.
 */
export const jobSourceProfileSummarySchema = z.object({
  intervalMinutes: z.number().int().positive(),
  offIntervalMinutes: z.number().int().positive().nullable(),
  window: z
    .object({
      timeZone: z.string().min(1).max(100),
      days: z.array(dayOfWeekSchema).min(1).max(7),
      from: z.string().regex(HHMM),
      to: z.string().regex(HHMM),
    })
    .nullable(),
  fixedSlotTimes: z.array(z.string().regex(HHMM)).min(1).nullable(),
  floorHours: z.number().int().nonnegative(),
})

/** One row of the operational list: what state the source is in, how fresh, and on what cadence. */
export const jobSourceOperationalRowSchema = z.object({
  id: z.string().uuid(),
  type: jobSourceTypeSchema,
  enabled: z.boolean(),
  /** Current health = `to_state` of the latest TRANSITION; `null` = no event recorded yet. */
  state: jobHealthStateSchema.nullable(),
  /** The reason of that latest TRANSITION, when it carried one. */
  reasonCode: jobHealthReasonSchema.nullable(),
  /** Freshness: when the collector last ran, and the newest item the provider has published. */
  lastCollectedAt: z.string().datetime().nullable(),
  newestItemPublishedAt: z.string().datetime().nullable(),
  profileSummary: jobSourceProfileSummarySchema.nullable(),
})

export const jobSourceOperationalListSchema = z.object({
  items: z.array(jobSourceOperationalRowSchema),
})

const runCountSchema = z.number().int().nonnegative().nullable()

/** One run on the source's timeline (a `job_collection_runs` row, projected). */
export const jobSourceRunSchema = z.object({
  id: z.string().uuid(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  outcome: jobCollectionOutcomeSchema,
  received: runCountSchema,
  created: runCountSchema,
  invalid: runCountSchema,
  requestCount: runCountSchema,
  bytesRead: runCountSchema,
  lastHttpStatus: z.number().int().nullable(),
  newestItemPublishedAt: z.string().datetime().nullable(),
  adapterVersion: z.string().max(100).nullable(),
  configVersion: z.number().int().nullable(),
})

/**
 * The correlation hint on a TRANSITION (ADR section 10): did the health change coincide with a
 * change ON OUR SIDE. Derived by comparing the event's adapter/config version to the PREVIOUS
 * transition's. `NO_CHANGE` = nothing moved on our side, i.e. a provider-side change.
 */
export const jobSourceCorrelationSchema = z.enum(['ADAPTER_CHANGE', 'CONFIG_CHANGE', 'NO_CHANGE'])

/** One row of the health-event log: a TRANSITION the detector pass wrote, or an ADMIN NOTE. */
export const jobSourceTimelineEventSchema = z.object({
  id: z.string().uuid(),
  at: z.string().datetime(),
  kind: z.enum(['TRANSITION', 'NOTE']),
  fromState: jobHealthStateSchema.nullable(),
  toState: jobHealthStateSchema.nullable(),
  reasonCode: jobHealthReasonSchema.nullable(),
  adapterVersion: z.string().max(100).nullable(),
  configVersion: z.number().int().nullable(),
  httpStatus: z.number().int().nullable(),
  errorSample: z.string().max(500).nullable(),
  /** NOTE only: the ADMIN who wrote it (display name) and the note text. */
  actorName: z.string().max(255).nullable(),
  note: z.string().max(500).nullable(),
  /** TRANSITION only; `null` on a NOTE and on the first transition (no previous to compare). */
  correlation: jobSourceCorrelationSchema.nullable(),
})

export const jobSourceDetailSchema = z.object({
  source: jobSourceOperationalRowSchema,
  runs: z.array(jobSourceRunSchema),
  events: z.array(jobSourceTimelineEventSchema),
})

/**
 * Body of `POST /job-sourcing/admin/sources/:id/notes`. The note is UNTRUSTED ADMIN input written
 * verbatim into the append-only `job_source_health_events.note` column, so it is bounded to the
 * column's 500 (`JOB_SANITIZED_TEXT_MAX`) and refused when blank. Unknown keys are refused.
 */
export const JOB_SOURCE_NOTE_MAX = 500
export const createJobSourceNoteSchema = z
  .object({
    note: z.string().trim().min(1).max(JOB_SOURCE_NOTE_MAX),
  })
  .strict()

export type JobHealthState = z.infer<typeof jobHealthStateSchema>
export type JobHealthReason = z.infer<typeof jobHealthReasonSchema>
export type JobSourceProfileSummary = z.infer<typeof jobSourceProfileSummarySchema>
export type JobSourceOperationalRowDto = z.infer<typeof jobSourceOperationalRowSchema>
export type JobSourceOperationalListDto = z.infer<typeof jobSourceOperationalListSchema>
export type JobSourceRunDto = z.infer<typeof jobSourceRunSchema>
export type JobSourceCorrelation = z.infer<typeof jobSourceCorrelationSchema>
export type JobSourceTimelineEventDto = z.infer<typeof jobSourceTimelineEventSchema>
export type JobSourceDetailDto = z.infer<typeof jobSourceDetailSchema>
export type CreateJobSourceNoteDto = z.infer<typeof createJobSourceNoteSchema>
