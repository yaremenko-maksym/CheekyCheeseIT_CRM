import { JobSourceDeliberateStopError } from '../source-budget.error'

/** A refusal by the host (T6): unauthorised, forbidden, unavailable for legal reasons. */
export const REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403, 451])

/** Why a response counts as the host refusing us: its status, or an interstitial challenge. */
export type RefusalKind = 'STATUS' | 'CHALLENGE'

/**
 * THE refusal predicate (CR-M-3): one owner for both the house transport (`bounded-fetch`) and any
 * adapter that fetches on its own, so a new refusal shape is gained by every source at once.
 *
 * A `cf-mitigated: challenge` is checked FIRST and under ANY status: the header is the fact, and a
 * CDN is free to serve the interstitial as a 200 or a 503. jobs.dou.ua serves it as a 403 today —
 * reading the status alone would have classified that one case right and every other one wrong.
 */
export function refusalKind(response: {
  readonly status: number
  readonly headers: Headers
}): RefusalKind | null {
  if (response.headers.get('cf-mitigated') === 'challenge') return 'CHALLENGE'
  return REFUSAL_STATUSES.has(response.status) ? 'STATUS' : null
}

/**
 * HTTP 401, 403 or 451 from a source, or an interstitial challenge — "we were refused". The
 * collector treats it as a deliberate stop (warn, not incident); the row is paused (A1k:
 * `ACCESS_POLICY` in `last_error_code`, cleared by an ADMIN `resetFailures`) and no workaround is
 * attempted. Until Task 2.5 T6 a 401 and a 451 were a plain `Error`.
 *
 * `retryAfter` is the response's raw `Retry-After` header (delay-seconds or an HTTP-date), or
 * `null`. It is untrusted text: `parseRetryAfter` (host-state) is what reads it, against the
 * database clock.
 *
 * `refusal` names which half of `refusalKind` fired, because `message` is persisted (the failures
 * DTO and `job_sources.last_error_message`): "refused access (HTTP 200)" would read as a
 * contradiction where "served a challenge" reads as the fact it is.
 *
 * Not `SourceNotPermittedError` (an adapter's own refusal to run a config): this one is a live
 * HTTP refusal or challenge from the host.
 */
export class SourceBlockedError extends JobSourceDeliberateStopError {
  readonly budgetExhausted = false

  constructor(
    readonly host: string,
    readonly status: number,
    readonly retryAfter: string | null = null,
    readonly refusal: RefusalKind = 'STATUS',
  ) {
    super(
      refusal === 'CHALLENGE'
        ? `Source ${host} served an anti-bot challenge (HTTP ${status}) — the row is paused, no workaround is attempted`
        : `Source ${host} refused access (HTTP ${status}) — the row is paused, no workaround is attempted`,
    )
    this.name = 'SourceBlockedError'
  }
}

/** HTTP 429 from a source — rate limit; the row stays enabled, retry on cadence. */
export class SourceRateLimitedError extends JobSourceDeliberateStopError {
  readonly budgetExhausted = false

  constructor(
    readonly host: string,
    /** The raw `Retry-After` header, or `null` (see `SourceBlockedError.retryAfter`). */
    readonly retryAfter: string | null = null,
  ) {
    super(`Источник ${host} ответил HTTP 429 — лимит; повтор по каденции`)
    this.name = 'SourceRateLimitedError'
  }
}

/**
 * Any other non-2xx answer (Task 2.5 T6). Typed so the production context can hand the STATUS to
 * the adapter, which classifies it (a detail 404 is an answer; a 5xx is `UPSTREAM`), instead of the
 * adapter reading a network failure. The body is never kept: the transport cancels it unread.
 */
export class SourceHttpStatusError extends Error {
  constructor(
    readonly host: string,
    readonly status: number,
  ) {
    super(`${host} responded ${status}`)
    this.name = 'SourceHttpStatusError'
  }
}

/**
 * A response larger than the cap the request was allowed. Typed (and not a bare `Error`) so the
 * collection loop can report it as `PAYLOAD_TOO_LARGE` - the code a reader acts on - instead of as a
 * network failure. Thrown BEFORE any body reaches a caller: the transport cancels the stream, so
 * nothing partial is ever returned.
 */
export class SourcePayloadTooLargeError extends Error {
  constructor(
    readonly host: string,
    readonly maxBytes: number,
    detail: string,
  ) {
    super(`${host} response too large: ${detail}`)
    this.name = 'SourcePayloadTooLargeError'
  }
}
