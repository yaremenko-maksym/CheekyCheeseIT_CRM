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

export function useClickDelegation(): void {
  useEffect(() => {
    if (!isTelemetryEnabled()) return

    const onClick = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const trackedEl = target.closest('[data-track]')
      if (!trackedEl) return
      const id = trackedEl.getAttribute('data-track')
      if (id) trackFeatureClick(id)
    }

    // Capture phase: still fires even if a descendant handler calls
    // `stopPropagation()` on the bubble phase (e.g. Radix primitives).
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])
}
