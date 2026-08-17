import type { JobSourceType } from '@crm/shared'

/**
 * Common base for every "we stopped on purpose" refusal `chargeBudget` can
 * throw — as opposed to a genuinely broken feed or an unreachable database.
 * PR #544 review, H1: `collectAll` used to tell the two families apart by
 * `instanceof JobSourceBudgetExhaustedError` alone, which is exactly the type
 * check that made {@link JobSourceBudgetContentionError} (added for backlog
 * #61 as a SEPARATE class on purpose — see its own doc comment) fall through
 * to the `logger.error` + stack-trace branch: a deliberate, mechanism-working
 * stop dressed up as an incident, the opposite of what #61 exists to fix.
 *
 * `collectAll` now branches on THIS base (`instanceof
 * JobSourceDeliberateStopError`) for the log-level decision (`warn` +
 * `continue`, never `error`), and separately reads the per-subclass
 * `budgetExhausted` field for the DTO flag — the two axes stay independent:
 * every deliberate stop is logged the same non-incident way, but only a
 * genuinely exhausted budget is `budgetExhausted: true` in the response.
 */
export abstract class JobSourceDeliberateStopError extends Error {
  abstract readonly budgetExhausted: boolean
}

/**
 * Raised when a source is asked to collect with its request budget spent —
 * task-vacancy-matching §4.
 *
 * A DISTINCT error type rather than a generic `Error`, because "we stopped on
 * purpose" and "the feed broke" are opposite facts that happen to look identical
 * in a log line, and the collector treats them differently: a broken feed is an
 * incident, an exhausted budget is the mechanism working. `collectAll` reads the
 * flag off this type to mark the failure `budgetExhausted: true`, which is what
 * lets the UI say "лимит исчерпан, обновится 1 сентября" instead of dressing a
 * routine stop up as an outage.
 *
 * The message names the numbers on purpose. "Бюджет исчерпан" alone sends an
 * operator to the database to find out how much of what; naming the limit, the
 * window and the reset instant answers it in the notification itself.
 */
export class JobSourceBudgetExhaustedError extends JobSourceDeliberateStopError {
  readonly budgetExhausted = true

  constructor(
    readonly sourceType: JobSourceType,
    readonly limit: number,
    readonly resetsAt: Date | null,
  ) {
    const resets = resetsAt ? ` Обновится ${resetsAt.toISOString()}.` : ''
    super(
      `Источник ${sourceType}: бюджет запросов исчерпан (лимит ${limit}, остаток 0).` +
        `${resets} Сбор не выполнялся.`,
    )
    this.name = 'JobSourceBudgetExhaustedError'
  }
}

/**
 * Raised when `chargeBudget`'s bounded compare-and-set retry (backlog #53)
 * outlives `CHARGE_BUDGET_MAX_ATTEMPTS` WITHOUT the row actually being spent
 * — backlog #61.
 *
 * Deliberately a DIFFERENT type from {@link JobSourceBudgetExhaustedError}.
 * The tail of the retry loop used to throw the exhausted error unconditionally
 * whenever attempts ran out, whether or not a fresh re-read actually showed the
 * budget spent. That told the operator "лимит исчерпан" when the real cause
 * was several writers hammering the SAME row faster than the bounded retry
 * could win a compare-and-set — a fact that sends whoever reads the log
 * looking at the wrong number (the budget) instead of the right one
 * (concurrent load on one source). The outcome stays identical either way —
 * `collectSource` still refuses and the paid provider is never called (AC5,
 * this is not a retry fix) — only the REASON told to the operator changes.
 *
 * Still extends {@link JobSourceDeliberateStopError}, NOT
 * `JobSourceBudgetExhaustedError` — contention and exhaustion must keep
 * different `budgetExhausted` values (this one is `false`; the UI's "лимит
 * исчерпан, обновится …" copy would be a lie for contention). The shared base
 * is what lets `collectAll` treat both as the same non-incident LOG level
 * without collapsing that DTO distinction — see the base class's doc comment.
 */
export class JobSourceBudgetContentionError extends JobSourceDeliberateStopError {
  readonly budgetExhausted = false

  constructor(
    readonly sourceType: JobSourceType,
    readonly attempts: number,
  ) {
    super(
      `Источник ${sourceType}: не удалось начислить бюджет за ${attempts} попыток — ` +
        'конкуренция за строку, а не исчерпание лимита. Сбор отменён (запрос к ' +
        'провайдеру не выполнялся); попробуйте ещё раз.',
    )
    this.name = 'JobSourceBudgetContentionError'
  }
}
