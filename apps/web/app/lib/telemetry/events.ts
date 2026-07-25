/**
 * telemetry/events — public UX-event tracking API (spec §3).
 *
 * Every function here is a thin, fail-fast-disabled wrapper around
 * `state.ts`'s batcher: when `VITE_TELEMETRY` isn't `'on'` (AC2), NOTHING
 * is enqueued — zero network calls, not even a buffered-then-dropped item.
 */
import type { TelemetryEventDto, TelemetryEventType } from '@crm/shared'
import { isTelemetryEnabled } from './config'
import { enqueueEvent } from './state'

/** Route from the current location, pathname-only (no query/hash — `location.pathname` already excludes both). */
function currentRoute(): string {
  return typeof window !== 'undefined' ? window.location.pathname : ''
}

function enqueue(
  event: TelemetryEventType,
  opts: { route?: string; target?: string; durationMs?: number } = {},
): void {
  if (!isTelemetryEnabled()) return
  const dto: TelemetryEventDto = {
    event,
    route: opts.route ?? currentRoute(),
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
  }
  enqueueEvent(dto)
}

/** Fires for `[data-track]` delegated clicks AND for non-click feature signals that can't use a DOM click (drag, filter `onValueChange`) — call this directly from the handler in those cases. `target` is a short kebab feature id, never user input. */
export function trackFeatureClick(target: string): void {
  enqueue('feature_click', { target })
}

/** @internal wired by `use-route-telemetry.ts` */
export function trackRouteEnter(route: string): void {
  enqueue('route_enter', { route })
}

/** @internal wired by `use-route-telemetry.ts` */
export function trackRouteLeave(route: string, durationMs: number): void {
  enqueue('route_leave', { route, durationMs })
}

/** @internal wired by `use-form-abandon-tracking.ts` */
export function trackFormSubmit(formName: string): void {
  enqueue('form_submit', { target: formName })
}

/** @internal wired by `use-form-abandon-tracking.ts` */
export function trackFormAbandon(formName: string): void {
  enqueue('form_abandon', { target: formName })
}
