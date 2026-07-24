/**
 * telemetry/use-global-error-handlers — `window.onerror` + `unhandledrejection`
 * (spec §3). React render errors are covered separately by `ErrorBoundary.tsx`.
 */
import { useEffect } from 'react'
import { isTelemetryEnabled } from './config'
import { reportClientError } from './errors'

function messageOf(reason: unknown): { message: string; stack: string | undefined } {
  if (reason instanceof Error) return { message: reason.message, stack: reason.stack }
  return { message: String(reason), stack: undefined }
}

export function useGlobalErrorHandlers(): void {
  useEffect(() => {
    if (!isTelemetryEnabled()) return

    const onError = (event: ErrorEvent) => {
      const fromErrorObj = event.error instanceof Error ? event.error : undefined
      reportClientError(fromErrorObj?.message || event.message || 'window.onerror', {
        stack: fromErrorObj?.stack,
      })
    }

    const onRejection = (event: PromiseRejectionEvent) => {
      const { message, stack } = messageOf(event.reason)
      reportClientError(`Unhandled rejection: ${message}`, { stack })
    }

    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])
}
