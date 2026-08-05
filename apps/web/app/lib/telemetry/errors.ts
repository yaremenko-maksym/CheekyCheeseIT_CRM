/**
 * telemetry/errors — client error capture → dedupe → immediate POST (spec §3).
 *
 * The three entry points that funnel into `reportClientError`:
 *   - `window.onerror` (uncaught sync errors) — `use-global-error-handlers.ts`
 *   - `unhandledrejection` (uncaught promise rejections) — `use-global-error-handlers.ts`
 *   - React render errors via `ErrorBoundary.tsx`'s `componentDidCatch`
 *
 * fail-silent end-to-end (spec §3): a malformed payload, a schema-parse
 * failure, or a network failure all resolve to nothing more than one
 * `console.debug` — never a thrown error, toast, or `console.error`.
 */
import axios from 'axios'
import { reportErrorSchema, type ReportErrorDto } from '@crm/shared'
import { stripQueryString } from '../axios-utils'
import { currentAppVersion, isTelemetryEnabled } from './config'
import { errorDedupeKey } from './error-dedupe'
import { getErrorDedupe } from './state'
import { sendErrorImmediate } from './transport'

const MESSAGE_MAX = 500
const STACK_MAX = 8000

/**
 * Turns an arbitrary caught/uncaught JS value into what's safe to hand to
 * `reportClientError`. ALL THREE entry points funnel through this ONE
 * function (security-review round 2, MED-1: the "never forward
 * backend-echoed text to telemetry" invariant must live at the shared
 * funnel, not be re-implemented — and possibly forgotten — per entry
 * point).
 *
 * Axios errors: `axios.ts`'s response interceptor rewrites `.message` to a
 * user-facing string that may echo backend response-body text (which can
 * carry whatever the user submitted — an email, a name). That's correct
 * for the toast the SAME user sees, but telemetry is a separate,
 * persistent, multi-access datastore (later republished into a GitHub
 * issue digest — see `apps/api/src/telemetry`) — so for axios errors we
 * report only structural, PII-free detail: method + path (query string
 * stripped, same `stripQueryString` policy as `axios.ts`'s console.error)
 * + status. `stack` is intentionally dropped for axios errors even though
 * `axios.ts` now freezes its header safely (HIGH-1 fix) — defense in
 * depth, so this invariant doesn't depend on every possible axios error
 * having gone through that exact interceptor.
 *
 * Everything else: message + stack forwarded as-is (unchanged behavior).
 */
export function sanitizeErrorForReport(reason: unknown): {
  message: string
  stack: string | undefined
} {
  if (axios.isAxiosError(reason)) {
    const status = reason.response?.status ?? 'network'
    const method = reason.config?.method?.toUpperCase() ?? '?'
    const path = stripQueryString(reason.config?.url)
    return { message: `API error: ${method} ${path} → ${status}`, stack: undefined }
  }
  if (reason instanceof Error) return { message: reason.message, stack: reason.stack }
  return { message: String(reason), stack: undefined }
}

function currentMeta(): { ua?: string; viewport?: string; appVersion?: string } {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : undefined
  const viewport =
    typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : undefined
  const appVersion = currentAppVersion()
  // `exactOptionalPropertyTypes` — only include keys that actually have a
  // value; assigning `key: undefined` explicitly is a type error against
  // `meta?: string` (as opposed to `meta?: string | undefined`).
  return {
    ...(ua !== undefined ? { ua } : {}),
    ...(viewport !== undefined ? { viewport } : {}),
    ...(appVersion !== undefined ? { appVersion } : {}),
  }
}

export function reportClientError(
  message: string,
  // `stack?: string | undefined` (not just `stack?: string`) — callers
  // routinely compute the stack from an `?? undefined` chain (e.g.
  // `error.stack ?? info.componentStack ?? undefined` in `ErrorBoundary.tsx`)
  // which types as `string | undefined`; `exactOptionalPropertyTypes` treats
  // that as distinct from a plain optional `string`.
  opts: { stack?: string | undefined } = {},
): void {
  if (!isTelemetryEnabled()) return

  const trimmedMessage = message.trim().slice(0, MESSAGE_MAX)
  if (trimmedMessage.length === 0) return

  const key = errorDedupeKey(trimmedMessage, 'WEB')
  if (!getErrorDedupe().shouldSend(key)) return

  try {
    const payload: ReportErrorDto = reportErrorSchema.parse({
      message: trimmedMessage,
      stack: opts.stack?.slice(0, STACK_MAX),
      route: typeof window !== 'undefined' ? window.location.pathname : undefined,
      meta: currentMeta(),
    })
    sendErrorImmediate(payload)
  } catch {
    // Malformed payload (shouldn't happen given the trims above, but the
    // contract is fail-silent — never let a telemetry bug become a SECOND
    // uncaught error) — one console.debug, matching transport.ts's failure logging.
    console.debug('[telemetry] error report build failed')
  }
}
