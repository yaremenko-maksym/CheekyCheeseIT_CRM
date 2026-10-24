import { JobSourceDeliberateStopError } from '../source-budget.error'

/**
 * HTTP 403 from a source — "we were blocked". The collector treats it as a
 * deliberate stop (warn, not incident); the row is auto-disabled later (A1k)
 * and no workaround is attempted.
 */
export class SourceBlockedError extends JobSourceDeliberateStopError {
  readonly budgetExhausted = false

  constructor(
    readonly host: string,
    readonly status: number,
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

  constructor(readonly host: string) {
    super(`Источник ${host} ответил HTTP 429 — лимит; повтор по каденции`)
    this.name = 'SourceRateLimitedError'
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
