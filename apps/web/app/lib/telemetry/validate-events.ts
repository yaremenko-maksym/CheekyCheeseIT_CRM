/**
 * telemetry/validate-events — code-review round 1 (MED-1).
 *
 * `errors.ts` already runs every outbound error payload through
 * `reportErrorSchema.parse()` before sending (see `reportClientError`).
 * UX events had TS-typing only up to the network boundary — this module
 * gives them the same schema defense-in-depth right "перед отправкой"
 * (before send), reusing the SAME `@crm/shared` schemas the API validates
 * against, so a client-side bug can never silently ship a malformed batch.
 *
 * Pure / DOM-free on purpose — testable without a `navigator.sendBeacon` or
 * `fetch` mock, unlike `transport.ts` itself (see `validate-events.test.ts`).
 * fail-silent (spec §3): invalid rows are DROPPED with one `console.debug`
 * each, never thrown — the batcher already has the data, throwing here would
 * just crash whatever caller flushed it (e.g. a `pagehide` handler).
 */
import {
  telemetryEventSchema,
  telemetryEventsBatchSchema,
  type TelemetryEventDto,
  type TelemetryEventsBatchDto,
} from '@crm/shared'

/**
 * Filters `events` down to schema-valid rows (per-event `safeParse`), then
 * validates the resulting batch shape as a whole (e.g. the ≤50 cap — always
 * trivially true here since `EventBatcher`'s default `maxSize` is 10, but
 * checked anyway for defense-in-depth against a future config change).
 * Returns `null` when nothing survives — callers should send NOTHING rather
 * than an empty `{ events: [] }` batch (the API schema requires `min(1)`).
 */
export function buildValidatedEventsBatch(
  events: readonly TelemetryEventDto[],
): TelemetryEventsBatchDto | null {
  const validEvents = events.filter((event) => {
    const result = telemetryEventSchema.safeParse(event)
    if (!result.success) {
      console.debug('[telemetry] dropped invalid event before send', result.error.issues)
    }
    return result.success
  })

  if (validEvents.length === 0) return null

  const batchResult = telemetryEventsBatchSchema.safeParse({ events: validEvents })
  if (!batchResult.success) {
    console.debug('[telemetry] dropped invalid event batch before send', batchResult.error.issues)
    return null
  }

  return batchResult.data
}
