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
