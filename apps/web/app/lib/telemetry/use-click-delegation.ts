/**
 * telemetry/use-click-delegation — a SINGLE document-level, capture-phase
 * click listener that resolves `feature_click` for ANY `[data-track]`
 * element anywhere in the CRM (spec §3 "делегированный click-хендлер по
 * `[data-track]`"). Point markup is then just `data-track="vacancy-create"`
 * on a button — no per-component handler wiring needed for plain clicks
 * (non-click feature signals — drag, `Select.onValueChange` — call
 * `trackFeatureClick()` directly from their own handler; see PR body's
 * data-track table for which is which).
 */
import { useEffect } from 'react'
import { isTelemetryEnabled } from './config'
import { trackFeatureClick } from './events'
import { safeCall } from './safe-call'

export function useClickDelegation(): void {
  useEffect(() => {
    if (!isTelemetryEnabled()) return

    // MED-2 (code review round 1): this listener fires on EVERY click
    // anywhere in the CRM, outside `TelemetryErrorBoundary`'s subtree (see
    // `safe-call.ts`) — a throw here (e.g. a hostile `data-track` DOM
    // shape) must never break the user's actual click.
    const onClick = (event: MouseEvent) => {
      safeCall(() => {
        const target = event.target
        if (!(target instanceof Element)) return
        const trackedEl = target.closest('[data-track]')
        if (!trackedEl) return
        const id = trackedEl.getAttribute('data-track')
        if (id) trackFeatureClick(id)
      }, 'use-click-delegation:onClick')
    }

    safeCall(() => {
      // Capture phase: still fires even if a descendant handler calls
      // `stopPropagation()` on the bubble phase (e.g. Radix primitives).
      document.addEventListener('click', onClick, true)
    }, 'use-click-delegation:setup')

    return () => document.removeEventListener('click', onClick, true)
  }, [])
}
