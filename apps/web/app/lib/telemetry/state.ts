/**
 * telemetry/state — module-scoped singletons for the SPA session.
 *
 * A browser tab IS the "session" the spec refers to (§3 error dedupe "за
 * сессию", §4 batching) — one `EventBatcher`/`ErrorDedupe`/
 * `FormAbandonTracker` per page load, created lazily on first use so a
 * disabled SDK (`VITE_TELEMETRY` off) never even allocates them. Kept in
 * their own module (rather than inline in `events.ts`/`errors.ts`) so
 * `batcher.ts`/`error-dedupe.ts`/`form-abandon.ts` themselves stay pure,
 * dependency-free, and independently unit-testable (AC1).
 */
import type { TelemetryEventDto } from '@crm/shared'
import { EventBatcher } from './batcher'
import { ErrorDedupe } from './error-dedupe'
import { FormAbandonTracker } from './form-abandon'
import { sendEventsBeacon } from './transport'

let batcher: EventBatcher<TelemetryEventDto> | null = null
let errorDedupe: ErrorDedupe | null = null
let formTracker: FormAbandonTracker | null = null

function getBatcher(): EventBatcher<TelemetryEventDto> {
  if (!batcher) {
    batcher = new EventBatcher<TelemetryEventDto>({ send: sendEventsBeacon })
  }
  return batcher
}

export function enqueueEvent(event: TelemetryEventDto): void {
  getBatcher().add(event)
}

/** Flushes whatever's buffered right now — used on `visibilitychange(hidden)`/`pagehide`. */
export function flushEvents(): void {
  batcher?.flush()
}

export function getErrorDedupe(): ErrorDedupe {
  if (!errorDedupe) errorDedupe = new ErrorDedupe()
  return errorDedupe
}

export function getFormTracker(): FormAbandonTracker {
  if (!formTracker) formTracker = new FormAbandonTracker()
  return formTracker
}
