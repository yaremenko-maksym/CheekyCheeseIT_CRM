/**
 * telemetry/use-global-error-handlers — `window.onerror` + `unhandledrejection`
 * (spec §3). React render errors are covered separately by `ErrorBoundary.tsx`.
 *
 * MED-2 (code review round 1): this hook's effect body — and the listeners
 * it registers — run OUTSIDE `TelemetryErrorBoundary`'s subtree (see
 * `safe-call.ts`), so every entry point here is routed through `safeCall`.
 *
 * security-review round 2, MED-1: both entry points below route their raw
 * `reason`/`event.error` through `sanitizeErrorForReport` (errors.ts) —
 * the SAME funnel `ErrorBoundary.tsx` uses — instead of reading
 * `.message`/`.stack` directly. That's what makes the "never forward a
 * possibly backend-echoed axios message to telemetry" invariant not
 * depend on any ONE of these three entry points remembering to check.
 */
import { useEffect } from 'react'
import { isTelemetryEnabled } from './config'
import { reportClientError, sanitizeErrorForReport } from './errors'
import { safeCall } from './safe-call'

export function useGlobalErrorHandlers(): void {
  useEffect(() => {
    if (!isTelemetryEnabled()) return

    const onError = (event: ErrorEvent) => {
      safeCall(() => {
        const fromErrorObj = event.error instanceof Error ? event.error : undefined
        if (!fromErrorObj) {
          reportClientError(event.message || 'window.onerror', {})
          return
        }
        const { message, stack } = sanitizeErrorForReport(fromErrorObj)
        reportClientError(message, { stack })
      }, 'use-global-error-handlers:onError')
    }

    const onRejection = (event: PromiseRejectionEvent) => {
      safeCall(() => {
        const { message, stack } = sanitizeErrorForReport(event.reason)
        reportClientError(`Unhandled rejection: ${message}`, { stack })
      }, 'use-global-error-handlers:onRejection')
    }

    safeCall(() => {
      window.addEventListener('error', onError)
      window.addEventListener('unhandledrejection', onRejection)
    }, 'use-global-error-handlers:setup')

    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])
}
