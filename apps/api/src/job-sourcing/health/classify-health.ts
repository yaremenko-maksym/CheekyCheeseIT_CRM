/**
 * Source-fetch-strategy U4 — the state classifier (section 10's precedence table).
 *
 * Pure. The detectors (`detectors.ts`) produce the reasons; this turns the reasons plus a few
 * source facts into the single `{ state, reasonCode }` the pass compares against the latest
 * event. `SCHEMA_DRIFT` is a reason within `DEGRADED`, never its own state.
 */
import type { HealthReason, HealthStateFacts, HealthVerdict } from './types'

/**
 * Which reasons point at which state, in the order the reason is reported when several of a
 * group fired. `ACCESS_CHANGED` enriches a `FAILING`/`CAPPED` state (a 401/403/451 run fails),
 * so it is not in a state group of its own.
 */
const EMPTY_REASONS: readonly HealthReason[] = ['EMPTY_RESPONSE', 'BOARD_GONE']
const DEGRADED_REASONS: readonly HealthReason[] = [
  // SCHEMA_DRIFT first: it is the one DEGRADED reason section 11 alerts on.
  'SCHEMA_DRIFT',
  'THROTTLED',
  'SLOW',
  'PAYLOAD_GROWTH',
  'VOLUME_DROP',
  'DEADLINE_NEAR',
]
const SILENT_REASONS: readonly HealthReason[] = ['NO_NEW_ITEMS', 'STALE_FEED']

/**
 * The state of a source and the dominant reason for it, by the precedence of section 10:
 * `BLOCKED > CAPPED > PAUSED > FAILING > EMPTY > DEGRADED > SILENT > HEALTHY`.
 */
export function classifyHealth(facts: HealthStateFacts): HealthVerdict {
  const firstOf = (group: readonly HealthReason[]): HealthReason | null =>
    group.find((reason) => facts.reasons.includes(reason)) ?? null

  // A source is BLOCKED when its admin state is not ACTIVE, or when a policy / passed deadline /
  // missing evidence blocks it. No detector reason carries this; the reason stays null.
  if (facts.adminState !== 'ACTIVE' || facts.blocked) {
    return { state: 'BLOCKED', reasonCode: null }
  }
  if (facts.atFailureCap) {
    return { state: 'CAPPED', reasonCode: firstOf(['ACCESS_CHANGED']) }
  }
  if (facts.hostPaused) {
    return { state: 'PAUSED', reasonCode: firstOf(['THROTTLED']) }
  }
  if (facts.consecutiveFailures > 0) {
    return { state: 'FAILING', reasonCode: firstOf(['ACCESS_CHANGED']) }
  }
  const empty = firstOf(EMPTY_REASONS)
  if (empty) return { state: 'EMPTY', reasonCode: empty }
  const degraded = firstOf(DEGRADED_REASONS)
  if (degraded) return { state: 'DEGRADED', reasonCode: degraded }
  const silent = firstOf(SILENT_REASONS)
  if (silent) return { state: 'SILENT', reasonCode: silent }
  return { state: 'HEALTHY', reasonCode: null }
}
