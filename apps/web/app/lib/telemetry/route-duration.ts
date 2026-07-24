/**
 * telemetry/route-duration — task-telemetry-web AC1 ("route duration —
 * чистая функция тестируема без DOM-хаков").
 *
 * Pure reducer for the TanStack Router `onResolved` subscription (spec §3):
 * given the previously-tracked route (or `null` on first load) and the new
 * pathname, returns the `route_leave` event for the OLD route (with dwell
 * time) — `null` on the very first navigation, nothing to leave yet — plus
 * the `route_enter` event for the NEW route. Kept side-effect-free (no
 * `Date.now()`/router access inside) so both branches are unit-testable
 * without a live router or fake timers — see `use-route-telemetry.ts` for
 * the DOM-facing wiring and `route-duration.test.ts` for coverage.
 */

/** Clamped, rounded dwell time in ms — never negative even if callers race a stale `enteredAtMs`. */
export function computeDurationMs(enteredAtMs: number, leftAtMs: number): number {
  return Math.max(0, Math.round(leftAtMs - enteredAtMs))
}

export interface RouteEnteredAt {
  route: string
  enteredAtMs: number
}

export interface RouteTransition {
  leave: { route: string; durationMs: number } | null
  enter: { route: string }
}

/**
 * `previous` — the currently-tracked route + its enter timestamp, or `null`
 * before the first navigation has been seeded. `nextRoute` — the pathname
 * (query/hash-free — TanStack `location.pathname` already is) being entered.
 * `nowMs` — injected clock reading for the transition instant.
 */
export function computeRouteTransition(
  previous: RouteEnteredAt | null,
  nextRoute: string,
  nowMs: number,
): RouteTransition {
  const leave =
    previous === null
      ? null
      : { route: previous.route, durationMs: computeDurationMs(previous.enteredAtMs, nowMs) }
  return { leave, enter: { route: nextRoute } }
}
