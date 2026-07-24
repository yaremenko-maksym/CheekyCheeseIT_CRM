/**
 * telemetry/transport — low-level HTTP delivery for the SDK.
 *
 * Deliberately NOT built on the shared `lib/axios.ts` `api` instance: that
 * instance's response interceptor force-navigates to `/login` on any 401
 * (see `apps/web/app/lib/axios.ts`). Telemetry must be fail-silent (spec §3
 * "сбой отправки НИКОГДА не всплывает") — an error reported from an
 * unauthenticated page (e.g. `/login` itself) would otherwise trigger a
 * telemetry-caused navigation, which is exactly the kind of visible
 * side-effect the spec forbids. Plain `fetch`/`sendBeacon` below never
 * touch that interceptor.
 */
import type { ReportErrorDto, TelemetryEventDto, TelemetryEventsBatchDto } from '@crm/shared'

/** Mirrors `lib/axios.ts`'s `baseURL` resolution so both transports hit the same API origin. */
function apiBase(): string {
  const v: unknown = import.meta.env['VITE_API_URL']
  return typeof v === 'string' && v.length > 0 ? v : '/api'
}

function logDeliveryFailure(kind: 'events' | 'error'): void {
  // fail-silent (spec §3): no toast, no console.error spam — one console.debug.
  console.debug(`[telemetry] ${kind} delivery failed`)
}

/**
 * Sends a batch of UX events via `navigator.sendBeacon` — the ONLY delivery
 * mechanism that reliably survives page unload/hide (spec §4:
 * "visibilitychange(hidden)/pagehide — navigator.sendBeacon остатка"), which
 * `fetch`/XHR do not once the tab is gone. `sendBeacon` always includes
 * cookies for same-origin requests (no `credentials` option exists on it —
 * there's nothing to opt into), matching axios's `withCredentials: true`
 * for the same-origin `/api` proxy this app always uses.
 *
 * Falls back to a fire-and-forget `fetch(..., keepalive:true)` when
 * `sendBeacon` is unavailable (non-browser test env) or the browser rejects
 * the payload (returns `false` — e.g. its send queue is full).
 */
export function sendEventsBeacon(events: TelemetryEventDto[]): void {
  const body: TelemetryEventsBatchDto = { events }
  const json = JSON.stringify(body)
  const url = `${apiBase()}/telemetry/events`

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const blob = new Blob([json], { type: 'application/json' })
      if (navigator.sendBeacon(url, blob)) return
    }
  } catch {
    // fall through to the fetch fallback below
  }

  void fetch(url, {
    method: 'POST',
    credentials: 'include',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: json,
  }).catch(() => logDeliveryFailure('events'))
}

/** Errors are sent immediately, never batched (spec §3: "Ошибки — сразу (без батча)"). */
export function sendErrorImmediate(payload: ReportErrorDto): void {
  const url = `${apiBase()}/telemetry/errors`
  void fetch(url, {
    method: 'POST',
    credentials: 'include',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => logDeliveryFailure('error'))
}
