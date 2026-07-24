/**
 * telemetry/use-form-abandon-tracking — wires a Sheet/Dialog-with-form's
 * open/dirty state to `FormAbandonTracker` (spec §3). Reusable across any
 * dialog: pass the Sheet/Dialog's own `open` boolean and the underlying
 * form's dirty flag (e.g. TanStack Form's `useSelector(form.store, (s) =>
 * s.isDirty)`); call the returned `markSubmitted()` right before a
 * successful submit so the subsequent close is recorded as `form_submit`,
 * not `form_abandon`.
 *
 * Wired into `VacancySheet.tsx` as the reference implementation for T2 —
 * see the PR body for the full data-track table and which dialogs still
 * need this hook adopted (tracked as a natural follow-up, not part of this
 * task's explicit scope).
 */
import { useEffect, useRef } from 'react'
import { isTelemetryEnabled } from './config'
import { trackFormAbandon, trackFormSubmit } from './events'
import { getFormTracker } from './state'

export interface UseFormAbandonTrackingOptions {
  /** Sheet/Dialog open state. */
  open: boolean
  /** Form-level dirty flag — true once the user has changed/typed anything. */
  isDirty: boolean
}

export interface UseFormAbandonTrackingResult {
  /** Call right before/at a successful submit. */
  markSubmitted: () => void
}

export function useFormAbandonTracking(
  formName: string,
  { open, isDirty }: UseFormAbandonTrackingOptions,
): UseFormAbandonTrackingResult {
  const wasOpenRef = useRef(false)

  useEffect(() => {
    if (!isTelemetryEnabled()) return
    const tracker = getFormTracker()

    if (open && !wasOpenRef.current) {
      tracker.open(formName)
    } else if (!open && wasOpenRef.current) {
      const outcome = tracker.close(formName)
      if (outcome === 'abandon') trackFormAbandon(formName)
      else if (outcome === 'submitted') trackFormSubmit(formName)
    }
    wasOpenRef.current = open
  }, [open, formName])

  useEffect(() => {
    if (!isTelemetryEnabled()) return
    if (open && isDirty) getFormTracker().markDirty(formName)
  }, [open, isDirty, formName])

  return {
    markSubmitted: () => {
      if (!isTelemetryEnabled()) return
      getFormTracker().markSubmitted(formName)
    },
  }
}
