import type { JobSourceType } from '@crm/shared'

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
export class JobSourceBudgetExhaustedError extends Error {
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
