/**
 * telemetry/use-route-telemetry — `route_enter`/`route_leave` via the
 * TanStack Router `onResolved` subscription (spec §3), same event shape
 * `apps/landing`'s root already uses for its own `onResolved`/
 * `onBeforeNavigate` orchestration (`router.subscribe(...)`).
 *
 * `router.state.location.pathname` / `toLocation.pathname` are already
 * query/hash-free (TanStack splits those into separate `search`/`hash`
 * fields) — no extra stripping needed on the client; the API applies its
 * own `toPathname()` defensively regardless (`apps/api/src/telemetry/route.ts`).
 */
import { useEffect, useRef } from 'react'
import { useRouter } from '@tanstack/react-router'
import { isTelemetryEnabled } from './config'
import { trackRouteEnter, trackRouteLeave } from './events'
import { computeRouteTransition, type RouteEnteredAt } from './route-duration'

export function useRouteTelemetry(): void {
  const router = useRouter()
  const previousRef = useRef<RouteEnteredAt | null>(null)

  useEffect(() => {
    if (!isTelemetryEnabled()) return

    // `onResolved` doesn't fire for the very first render — seed the
    // initial route (and its enter timestamp) directly so the FIRST route
    // the user lands on also gets a `route_enter` + a correct dwell time
    // once they navigate away.
    const initialRoute = router.state.location.pathname
    previousRef.current = { route: initialRoute, enteredAtMs: Date.now() }
    trackRouteEnter(initialRoute)

    const unsubscribe = router.subscribe('onResolved', ({ toLocation, pathChanged }) => {
      if (!pathChanged) return
      const now = Date.now()
      const { leave, enter } = computeRouteTransition(previousRef.current, toLocation.pathname, now)
      if (leave) trackRouteLeave(leave.route, leave.durationMs)
      trackRouteEnter(enter.route)
      previousRef.current = { route: enter.route, enteredAtMs: now }
    })
    return unsubscribe
  }, [router])
}
