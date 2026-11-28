import type { I18n, MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { JobQueueSalary } from '@crm/shared'

const PER: Record<JobQueueSalary['period'], MessageDescriptor> = {
  HOUR: msg`{amount} / год`,
  MONTH: msg`{amount} / міс`,
  YEAR: msg`{amount} / рік`,
}
const FROM = msg`від {amount}`
const UP_TO = msg`до {amount}`

/**
 * A stated salary as one line: `€4,000 – €5,500 / month`, `from €4,000 / month`, `up to €5,500 / month`.
 * Whole units only; the range is the locale's own (`formatRange`, so uk reads `4 000–5 500 EUR`).
 * The schema guarantees at least one bound; equal bounds read as one amount, never as `~€4,000`.
 */
export function formatSalary(salary: JobQueueSalary, locale: string, i18n: I18n): string {
  const money = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: salary.currency,
    maximumFractionDigits: 0,
  })
  const { min, max } = salary
  const amount =
    min !== null && max !== null
      ? min === max
        ? money.format(min)
        : money.formatRange(min, max)
      : min !== null
        ? i18n._(FROM.id, { amount: money.format(min) })
        : i18n._(UP_TO.id, { amount: money.format(max as number) })
  return i18n._(PER[salary.period].id, { amount })
}
