/**
 * Source-fetch-strategy U5a — which health transitions alert an ADMIN (ADR 2026-10-25 section 11).
 *
 * Pure. A source ENTERS an alerting state when its new `(state, reason)` is alerting and its old one
 * was not the same alerting state. The detector pass writes an event only on a change, and this
 * decides, per event, whether the change is an entry. A source that stays in the state writes no
 * event at all, so it sends nothing more; a new alert needs recovery plus a new breakage.
 */

/** The states that alert as such; `DEGRADED` alerts only with reason `SCHEMA_DRIFT`. */
const PLAIN_ALERT_STATES = ['FAILING', 'CAPPED', 'BLOCKED', 'EMPTY', 'PAUSED'] as const

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
  if (ref.state === 'DEGRADED') return ref.reason === 'SCHEMA_DRIFT' ? 'DEGRADED' : null
  return PLAIN_ALERT_STATES.find((s) => s === ref.state) ?? null
}

/** The state entered, or `null` when this transition is not an entry into an alerting state. */
export function isAlertEntry(from: StateRef, to: StateRef): AlertState | null {
  const entered = alertStateOf(to)
  // `entered` is null for a non-alerting target, and so is the answer in that case.
  return alertStateOf(from) === entered ? null : entered
}

/** `earlierAlertsToday` = alerting entries of the same source earlier in the same Kyiv day. */
export function emailBudgetLeft(earlierAlertsToday: number): boolean {
  return earlierAlertsToday < MAX_ALERT_EMAILS_PER_KYIV_DAY
}
