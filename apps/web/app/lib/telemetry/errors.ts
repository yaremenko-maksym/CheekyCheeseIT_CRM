/**
 * telemetry/errors — client error capture → dedupe → immediate POST (spec §3).
 *
 * The three entry points that funnel into `reportClientError`:
 *   - `window.onerror` (uncaught sync errors) — `global-handlers.ts`
 *   - `unhandledrejection` (uncaught promise rejections) — `global-handlers.ts`
 *   - React render errors via `ErrorBoundary.tsx`'s `componentDidCatch`
 *
 * fail-silent end-to-end (spec §3): a malformed payload, a schema-parse
 * failure, or a network failure all resolve to nothing more than one
 * `console.debug` — never a thrown error, toast, or `console.error`.
 */
import { reportErrorSchema, type ReportErrorDto } from '@crm/shared'
import { currentAppVersion, isTelemetryEnabled } from './config'
import { errorDedupeKey } from './error-dedupe'
import { getErrorDedupe } from './state'
import { sendErrorImmediate } from './transport'

const MESSAGE_MAX = 500
const STACK_MAX = 8000

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
