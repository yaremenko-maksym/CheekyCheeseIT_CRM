import { JobSourceDeliberateStopError } from '../source-budget.error'

/**
 * HTTP 401, 403 or 451 from a source — "we were refused". The collector treats it as a
 * deliberate stop (warn, not incident); the row is auto-disabled later (A1k)
 * and no workaround is attempted. Until Task 2.5 T6 a 401 and a 451 were a plain `Error`.
 *
 * `retryAfter` is the response's raw `Retry-After` header (delay-seconds or an HTTP-date), or
 * `null`. It is untrusted text: `parseRetryAfter` (host-state) is what reads it, against the
 * database clock.
 */
export class SourceBlockedError extends JobSourceDeliberateStopError {
  readonly budgetExhausted = false

  constructor(
    readonly host: string,
    readonly status: number,
    readonly retryAfter: string | null = null,
  ) {
    super(
      `Источник ${host} отказал в доступе (HTTP ${status}) — строка будет отключена, обход не предпринимается`,
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
