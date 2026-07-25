/**
 * telemetry/use-visibility-flush — spec §4: "на visibilitychange(hidden)/
 * pagehide — navigator.sendBeacon остатка". Flushes the batcher (see
 * `state.ts` → `transport.ts`'s `sendEventsBeacon`) so buffered-but-not-yet-
 * sent events aren't lost when the tab is backgrounded or closed.
 */
import { useEffect } from 'react'
import { isTelemetryEnabled } from './config'
import { flushEvents } from './state'
import { safeCall } from './safe-call'

export function useVisibilityFlush(): void {
  useEffect(() => {
    if (!isTelemetryEnabled()) return

    // MED-2 (code review round 1): these fire on tab-hide/unload, outside
    // `TelemetryErrorBoundary`'s subtree (see `safe-call.ts`) — a throw here
    // must never block the browser's own unload sequence.
    const onVisibilityChange = () => {
      safeCall(() => {
        if (document.visibilityState === 'hidden') flushEvents()
      }, 'use-visibility-flush:onVisibilityChange')
    }
    const onPageHide = () => {
      safeCall(flushEvents, 'use-visibility-flush:onPageHide')
    }

    safeCall(() => {
      window.addEventListener('visibilitychange', onVisibilityChange)
      window.addEventListener('pagehide', onPageHide)
    }, 'use-visibility-flush:setup')

    return () => {
      window.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [])
}
