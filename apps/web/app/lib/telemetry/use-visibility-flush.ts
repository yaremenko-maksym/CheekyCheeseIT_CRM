/**
 * telemetry/use-visibility-flush — spec §4: "на visibilitychange(hidden)/
 * pagehide — navigator.sendBeacon остатка". Flushes the batcher (see
 * `state.ts` → `transport.ts`'s `sendEventsBeacon`) so buffered-but-not-yet-
 * sent events aren't lost when the tab is backgrounded or closed.
 */
import { useEffect } from 'react'
import { isTelemetryEnabled } from './config'
import { flushEvents } from './state'

export function useVisibilityFlush(): void {
  useEffect(() => {
    if (!isTelemetryEnabled()) return

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushEvents()
    }

    window.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pagehide', flushEvents)
    return () => {
      window.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pagehide', flushEvents)
    }
  }, [])
}
