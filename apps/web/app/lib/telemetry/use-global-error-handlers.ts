/**
 * telemetry/use-global-error-handlers — `window.onerror` + `unhandledrejection`
 * (spec §3). React render errors are covered separately by `ErrorBoundary.tsx`.
 *
 * MED-2 (code review round 1): this hook's effect body — and the listeners
 * it registers — run OUTSIDE `TelemetryErrorBoundary`'s subtree (see
 * `safe-call.ts`), so every entry point here is routed through `safeCall`.
 */
import { useEffect } from 'react'
import { isTelemetryEnabled } from './config'
import { reportClientError } from './errors'
import { safeCall } from './safe-call'

function messageOf(reason: unknown): { message: string; stack: string | undefined } {
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
