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

/** The ADR's ceiling for the failure cap: a caller may tighten the cap, never go above this. */
export const MAX_CONSECUTIVE_FAILURES_CEILING = 5

/**
 * The most the cadence comparison may be widened by (10 minutes, the plan's value). A scheduled tick
 * may pick a source up to this long BEFORE its `next_attempt_at`, so a cron firing a few seconds
 * ahead of a day-old attempt does not skip a whole day. It widens the CADENCE term and nothing else:
 * it never overrides a cooldown, the failure cap, a cost block or any other term. Callers opt in;
 * the default slack is zero. Nothing on main uses a slack yet: this names a bound, not an existing
 * behaviour.
 */
export const MAX_EARLY_DUE_SLACK_MS = 10 * 60 * 1000

/** A valid failure cap: an integer from 1 to the ceiling. */
export function isValidFailureCap(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_CONSECUTIVE_FAILURES_CEILING
}

/** A valid slack: an integer number of milliseconds from 0 to `MAX_EARLY_DUE_SLACK_MS`. */
export function isValidCadenceSlackMs(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= MAX_EARLY_DUE_SLACK_MS
}

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
 * reason is stable for a given row. `INVALID_INPUT` is a NaN, an invalid date or an out-of-bounds
 * number anywhere in the row or the context: it fails closed, as the SQL does.
 */
export const DUE_REFUSALS = [
  'INVALID_INPUT',
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
 * the clock, the activation facts of the row's type AT that clock, and the terms other tasks own.
 */
export interface DueContext {
  /** The trigger of this collection. `MANUAL` skips the cadence term and nothing else. */
  readonly trigger: JobSourceTriggerMode
  /** The clock. `readiness` must have been evaluated at this same instant. */
  readonly now: Date
  /**
   * The row's type's activation facts AT `now`: the manifest's `readinessAt(subject, now)` plus the
   * payload flag, as T2's `activationFactsByType(manifest, now)` builds them. Passed in as a plain
   * value because production code must not import the manifest. NEVER the stored
   * `job_sources.readiness` column, a snapshot of the seed clock that goes stale on its own.
   * Absent = the manifest knows nothing of the type = not due. `factsActivate` is the ONLY
   * readiness term.
   */
  readonly readiness: ActivationFacts | undefined
  /** Slack added to the cadence comparison only. Default 0; at most `MAX_EARLY_DUE_SLACK_MS`. */
  readonly cadenceSlackMs?: number
  /** Ceiling for `consecutive_failures`. Default 3; at most `MAX_CONSECUTIVE_FAILURES_CEILING`. */
  readonly maxConsecutiveFailures?: number
  // The three terms below are REQUIRED, with no default: a caller that forgets one must not
  // compile, because omission would read as "not blocked" and make the source due.
  /** T3's meter: the quota is spent, or the type declares one and the source has no meter. */
  readonly costBlocked: boolean
  /** T8's host state: the source's host is paused by a ban. */
  readonly hostPaused: boolean
  /** T3's ledger: a run of this source (or its account) is already active. */
  readonly alreadyRunning: boolean
}

/**
 * Whether the facts amount to T2's `ACTIVATABLE` for a REPORTING adapter (`activationOf` in
 * `registry/activation.ts`): readiness `CANDIDATE`, no blocker of any kind, payload verified. The
 * spec pins this against `activationOf` for every combination, so the two cannot drift. LEGACY (DOU,
 * outside the ledger) is not activatable here.
 */
export function factsActivate(facts: ActivationFacts | undefined): boolean {
  if (facts === undefined) return false
  return facts.readiness === 'CANDIDATE' && facts.blockerCodes.length === 0 && facts.payloadVerified
}

function refuse(reason: DueRefusal): DueVerdict {
  return { due: false, reason }
}

const validDate = (d: Date): boolean => d instanceof Date && Number.isFinite(d.getTime())

/** True when every number and date `isDue` is about to compare is usable. */
function inputsValid(row: DueRow, ctx: DueContext): boolean {
  if (!validDate(ctx.now)) return false
  if (!Number.isInteger(row.consecutiveFailures) || row.consecutiveFailures < 0) return false
  if (row.cooldownUntil !== null && !validDate(row.cooldownUntil)) return false
  if (row.nextAttemptAt !== null && !validDate(row.nextAttemptAt)) return false
  if (ctx.cadenceSlackMs !== undefined && !isValidCadenceSlackMs(ctx.cadenceSlackMs)) return false
  if (ctx.maxConsecutiveFailures !== undefined && !isValidFailureCap(ctx.maxConsecutiveFailures)) {
    return false
  }
  return true
}

/**
 * Is this source due, and if not, why not.
 *
 * Terms, all required: `enabled` (administrative permission, nothing more); `admin_state` ACTIVE
 * (PAUSED and RETIRED are never due); a manifest entry; the trigger policy; activation facts that
 * amount to ACTIVATABLE at the clock; under the failure cap; not cooling down; and the inputs of T3
 * and T8 (cost, host pause, already running). Then the CADENCE term -- `next_attempt_at <= now (+
 * slack)` -- which a MANUAL trigger skips and which is the only thing it skips: a manual run is due
 * exactly when the scheduled predicate minus the cadence term is true. A NULL `next_attempt_at` is
 * not yet due on a schedule, as in the ADR's SQL (`NULL <= now` is not true). Every invalid input
 * (NaN, invalid date, a cap above its ceiling, a slack above its maximum) refuses with
 * `INVALID_INPUT`: the predicate fails closed. So do the three block inputs at runtime: only a
 * strictly `false` means "not blocked"; undefined, null, 0, '' or true refuse with their reason.
 *
 * REQUIREMENT ON THE CALLER (T7): this is a pre-check, not the permission. The caller must build
 * the activation facts itself, from the registry and the manifest, at the SAME clock it passes as
 * `now` (never from anything a request supplied), and must still run T2's activation check on the
 * locked row at claim time. `due: true` authorises nothing on its own.
 */
export function isDue(row: DueRow, ctx: DueContext): DueVerdict {
  if (!inputsValid(row, ctx)) return refuse('INVALID_INPUT')
  if (!row.enabled) return refuse('DISABLED')
  if (row.adminState !== 'ACTIVE') return refuse('NOT_ACTIVE')
  if (row.manifestId === null) return refuse('NO_MANIFEST_ENTRY')
  if (!sourceAcceptsTrigger(row.triggerMode, ctx.trigger)) return refuse('TRIGGER_MODE')
  if (!factsActivate(ctx.readiness)) return refuse('READINESS_BLOCKED')
  const cap = ctx.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES
  if (row.consecutiveFailures >= cap) return refuse('FAILURE_CAP')
  if (row.cooldownUntil !== null && row.cooldownUntil.getTime() > ctx.now.getTime()) {
    return refuse('COOLING_DOWN')
  }
  // Strict: only a literal `false` means "not blocked". A cast or untyped JS that drops the field, or
  // passes null / 0 / '' / anything else, is treated as blocked: the types are not the only guard.
  if (ctx.costBlocked !== false) return refuse('COST_BLOCKED')
  if (ctx.hostPaused !== false) return refuse('HOST_PAUSED')
  if (ctx.alreadyRunning !== false) return refuse('ALREADY_RUNNING')
  if (ctx.trigger !== 'MANUAL') {
    const horizon = ctx.now.getTime() + (ctx.cadenceSlackMs ?? 0)
    if (row.nextAttemptAt === null || row.nextAttemptAt.getTime() > horizon) {
      return refuse('NOT_YET_DUE')
    }
  }
  return { due: true }
}
