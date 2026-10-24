import type { JobSourceAdminState, JobSourceTriggerMode, JobSourceType } from '@crm/shared'
import type { ActivationFacts } from '../registry/activation'

/**
 * The due policy of a job source (r5 Task 2.5 T4): WHICH sources a collection may run, as a pure
 * predicate over a row, the clock and the facts other tasks own. Nothing here reads a database, a
 * manifest file or the stored `job_sources.readiness` column, and nothing here makes a source
 * runnable: merging this changes no behaviour of the running service.
 *
 * Architecture: docs/architecture/2026-10-24-job-source-run-ownership.md ("The due predicate").
 * The same scalar terms exist in SQL in `due-sources.query.ts`; the integration spec compares the
 * two over one seeded mix, so they cannot drift.
 */

/**
 * Consecutive failed runs after which a source is never due again, until an ADMIN resets it (T9).
 * The ADR fixes it at 3 with a ceiling of 5. Defined ONCE, here: T3's failure accounting counts
 * toward it and imports this constant.
 */
export const MAX_CONSECUTIVE_FAILURES = 3

/**
 * The legacy early-due slack: a scheduled tick may pick a source up to this long BEFORE its
 * `next_attempt_at`, so a cron firing a few seconds ahead of a day-old attempt does not skip a
 * whole day. It widens the CADENCE term and nothing else (`isDue` applies it to that one
 * comparison): it never overrides a cooldown, the failure cap, a cost block or any other term.
 * Callers opt in; the default slack is zero.
 */
export const LEGACY_EARLY_DUE_SLACK_MS = 10 * 60 * 1000

/**
 * Whether a source configured as `mode` may be collected by `trigger`. Moved from
 * `job-sourcing.service.ts` unchanged (T4 moves it, it does not rewrite it).
 *
 * Exported and pure so the rule is testable on its own: it is the whole of §5, and a mistake here is
 * either a wasted paid quota (scheduled collection of a manual-only source) or a source that never
 * runs at all.
 */
export function sourceAcceptsTrigger(
  mode: JobSourceTriggerMode,
  trigger: JobSourceTriggerMode,
): boolean {
  if (mode === 'BOTH') return true
  return mode === trigger
}

/** Which source types a collection may touch. Both lists apply when both are given. */
export interface TypeFilter {
  /** Only these types run. An empty list selects nothing. */
  readonly onlyTypes?: readonly JobSourceType[]
  /** These types never run. */
  readonly excludeTypes?: readonly JobSourceType[]
}

/**
 * Whether `type` passes `filter`. NEW in T4: the two schedules (05:00 API, 02:30 HTML) each select
 * their own type set. `onlyTypes` is an allow-list (absent = everything), `excludeTypes` a
 * deny-list; a type must pass both.
 */
export function typePassesFilter(type: JobSourceType, filter: TypeFilter = {}): boolean {
  if (filter.onlyTypes !== undefined && !filter.onlyTypes.includes(type)) return false
  if (filter.excludeTypes?.includes(type) === true) return false
  return true
}

/** The columns of a `job_sources` row the due policy reads. */
export interface DueRow {
  readonly type: JobSourceType
  readonly enabled: boolean
  readonly adminState: JobSourceAdminState
  readonly manifestId: string | null
  readonly triggerMode: JobSourceTriggerMode
  readonly nextAttemptAt: Date | null
  readonly cooldownUntil: Date | null
  readonly consecutiveFailures: number
}

/**
 * Why a source is not due. The order is the order `isDue` checks, and the first refusal wins, so a
 * reason is stable for a given row.
 */
export const DUE_REFUSALS = [
  'DISABLED',
  'NOT_ACTIVE',
  'NO_MANIFEST_ENTRY',
  'TRIGGER_MODE',
  'READINESS_BLOCKED',
  'FAILURE_CAP',
  'COOLING_DOWN',
  'COST_BLOCKED',
  'HOST_PAUSED',
  'ALREADY_RUNNING',
  'NOT_YET_DUE',
] as const
export type DueRefusal = (typeof DUE_REFUSALS)[number]

export type DueVerdict =
  { readonly due: true } | { readonly due: false; readonly reason: DueRefusal }

/**
 * What `isDue` is told about the world. Everything that is not a column of the row is an input:
 * the clock, the readiness of the row's type AT that clock, and the terms other tasks own.
 */
export interface DueContext {
  /** The trigger of this collection. `MANUAL` skips the cadence term and nothing else. */
  readonly trigger: JobSourceTriggerMode
  /** The clock. `readiness` must have been evaluated at this same instant. */
  readonly now: Date
  /**
   * The row's type's readiness AT `now` -- the manifest's `readinessAt(subject, now)`, passed in as
   * the plain facts the registry already uses (`activationFactsByType`), because production code
   * must not import the manifest. NEVER the stored `job_sources.readiness` column, a snapshot of
   * the seed clock that goes stale on its own. Absent = the manifest knows nothing of the type =
   * not due.
   */
  readonly readiness: Pick<ActivationFacts, 'readiness'> | undefined
  /** Slack added to the cadence comparison only. Default 0; see `LEGACY_EARLY_DUE_SLACK_MS`. */
  readonly cadenceSlackMs?: number
  /** Ceiling for `consecutive_failures`. Default `MAX_CONSECUTIVE_FAILURES`. */
  readonly maxConsecutiveFailures?: number
  /** T3's meter: the quota is spent, or the type declares one and the source has no meter. */
  readonly costBlocked?: boolean
  /** T8's host state: the source's host is paused by a ban. */
  readonly hostPaused?: boolean
  /** T3's ledger: a run of this source (or its account) is already active. */
  readonly alreadyRunning?: boolean
}

function refuse(reason: DueRefusal): DueVerdict {
  return { due: false, reason }
}

/**
 * Is this source due, and if not, why not.
 *
 * Terms, all required: `enabled` (administrative permission, nothing more); `admin_state` ACTIVE
 * (PAUSED and RETIRED are never due); a manifest entry; the trigger policy; readiness at the clock;
 * under the failure cap; not cooling down; and the inputs of T3 and T8 (cost, host pause, already
 * running). Then the CADENCE term -- `next_attempt_at <= now (+ slack)` -- which a MANUAL trigger
 * skips and which is the only thing it skips: a manual run is due exactly when the scheduled
 * predicate minus the cadence term is true. A NULL `next_attempt_at` is not yet due on a schedule,
 * as in the ADR's SQL (`NULL <= now` is not true).
 */
export function isDue(row: DueRow, ctx: DueContext): DueVerdict {
  if (!row.enabled) return refuse('DISABLED')
  if (row.adminState !== 'ACTIVE') return refuse('NOT_ACTIVE')
  if (row.manifestId === null) return refuse('NO_MANIFEST_ENTRY')
  if (!sourceAcceptsTrigger(row.triggerMode, ctx.trigger)) return refuse('TRIGGER_MODE')
  if (ctx.readiness?.readiness !== 'CANDIDATE') return refuse('READINESS_BLOCKED')
  const cap = ctx.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES
  if (row.consecutiveFailures >= cap) return refuse('FAILURE_CAP')
  if (row.cooldownUntil !== null && row.cooldownUntil.getTime() > ctx.now.getTime()) {
    return refuse('COOLING_DOWN')
  }
  if (ctx.costBlocked === true) return refuse('COST_BLOCKED')
  if (ctx.hostPaused === true) return refuse('HOST_PAUSED')
  if (ctx.alreadyRunning === true) return refuse('ALREADY_RUNNING')
  if (ctx.trigger !== 'MANUAL') {
    const horizon = ctx.now.getTime() + (ctx.cadenceSlackMs ?? 0)
    if (row.nextAttemptAt === null || row.nextAttemptAt.getTime() > horizon) {
      return refuse('NOT_YET_DUE')
    }
  }
  return { due: true }
}
