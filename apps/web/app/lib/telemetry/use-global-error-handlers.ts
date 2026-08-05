/**
 * telemetry/use-global-error-handlers — `window.onerror` + `unhandledrejection`
 * (spec §3). React render errors are covered separately by `ErrorBoundary.tsx`.
 *
 * MED-2 (code review round 1): this hook's effect body — and the listeners
 * it registers — run OUTSIDE `TelemetryErrorBoundary`'s subtree (see
 * `safe-call.ts`), so every entry point here is routed through `safeCall`.
 */
import { useEffect } from 'react'
import axios from 'axios'
import { isTelemetryEnabled } from './config'
import { reportClientError } from './errors'
import { safeCall } from './safe-call'

/**
 * task fix/api-error-messages security check: `axios.ts`'s response
 * interceptor now rewrites a rejected request's `.message` to a
 * user-facing string that MAY echo backend-supplied text sourced from the
 * response body (`response.data.message` — request-scoped, can contain
 * whatever the user submitted, e.g. an email). That's fine for the toast
 * the SAME user sees, but telemetry is a SEPARATE datastore with its own
 * retention/access policy — an unhandled rejection here must never forward
 * that body-derived text. Report only structural, PII-free detail instead:
 * method + path (no query string, which could itself carry PII) + status.
 */
function messageOf(reason: unknown): { message: string; stack: string | undefined } {
  if (axios.isAxiosError(reason)) {
    const status = reason.response?.status ?? 'network'
    const method = reason.config?.method?.toUpperCase() ?? '?'
    const path = reason.config?.url?.split('?')[0] ?? '?'
    return { message: `Unhandled API error: ${method} ${path} → ${status}`, stack: reason.stack }
  }
  if (reason instanceof Error) return { message: reason.message, stack: reason.stack }
  return { message: String(reason), stack: undefined }
}

export function useGlobalErrorHandlers(): void {
  useEffect(() => {
    if (!isTelemetryEnabled()) return

    const onError = (event: ErrorEvent) => {
      safeCall(() => {
        const fromErrorObj = event.error instanceof Error ? event.error : undefined
        reportClientError(fromErrorObj?.message || event.message || 'window.onerror', {
          stack: fromErrorObj?.stack,
        })
      }, 'use-global-error-handlers:onError')
    }

    const onRejection = (event: PromiseRejectionEvent) => {
      safeCall(() => {
        const { message, stack } = messageOf(event.reason)
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
