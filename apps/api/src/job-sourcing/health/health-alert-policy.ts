/**
 * Source-fetch-strategy U5a — which health transitions alert an ADMIN (ADR 2026-10-25 section 11).
 *
 * Pure. A source ENTERS an alerting state when its new `(state, reason)` is alerting and its old one
 * was not the same alerting state. The detector pass writes an event only on a change, and this
 * decides, per event, whether the change is an entry. A source that stays in the state writes no
 * event at all, so it sends nothing more; a new alert needs recovery plus a new breakage.
 */

/** The states that alert as such; `DEGRADED` alerts only with a reason in `DEGRADED_ALERT_REASONS`. */
const PLAIN_ALERT_STATES = ['FAILING', 'CAPPED', 'BLOCKED', 'EMPTY', 'PAUSED'] as const

/**
 * `SCHEMA_DRIFT` (ADR section 11) and `PAYLOAD_GROWTH` (sources-10, owner decision 2026-11-20:
 * "Limit 24 MiB + alert": a page near its declared cap must reach the operator before the cap fails
 * the run). `PAYLOAD_GROWTH` also covers bytes over 3x the 14-day median, which now alerts too: the
 * near-cap signal has no reason code of its own because `reason_code` is pinned by a CHECK
 * (`ck_job_source_health_events_states`) and a new code needs DDL. Accepted widening (fix round 2).
 */
// Typed with `null` so `includes(ref.reason)` needs no separate null guard.
const DEGRADED_ALERT_REASONS: readonly (string | null)[] = ['SCHEMA_DRIFT', 'PAYLOAD_GROWTH']

export const ALERT_STATES = [...PLAIN_ALERT_STATES, 'DEGRADED'] as const
export type AlertState = (typeof ALERT_STATES)[number]

/** Owner decision Q6 (2026-10-26): further alerting transitions that day are in-app only. */
export const MAX_ALERT_EMAILS_PER_KYIV_DAY = 3

export interface StateRef {
  readonly state: string | null
  readonly reason: string | null
}

/** The alerting state a `(state, reason)` pair represents, or `null` when it does not alert. */
export function alertStateOf(ref: StateRef): AlertState | null {
  if (ref.state === 'DEGRADED') {
    return DEGRADED_ALERT_REASONS.includes(ref.reason) ? 'DEGRADED' : null
  }
  return PLAIN_ALERT_STATES.find((s) => s === ref.state) ?? null
}

/**
 * What makes two alerting refs "the same alert": the state, plus the reason for DEGRADED, which
 * alerts for two reasons, so SCHEMA_DRIFT -> PAYLOAD_GROWTH is a new alert (fix round 3, R3-1).
 */
function alertKeyOf(ref: StateRef): string | null {
  const state = alertStateOf(ref)
  return state === 'DEGRADED' ? `${state}:${ref.reason}` : state
}

/** The state entered, or `null` when this transition is not an entry into an alerting state. */
export function isAlertEntry(from: StateRef, to: StateRef): AlertState | null {
  // The key is null for a non-alerting target, and so is `alertStateOf(to)`, the answer then.
  return alertKeyOf(from) === alertKeyOf(to) ? null : alertStateOf(to)
}

/** `earlierAlertsToday` = alerting entries of the same source earlier in the same Kyiv day. */
export function emailBudgetLeft(earlierAlertsToday: number): boolean {
  return earlierAlertsToday < MAX_ALERT_EMAILS_PER_KYIV_DAY
}
