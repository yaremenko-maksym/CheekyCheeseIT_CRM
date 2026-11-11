import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { JobMeterUnit } from '@crm/shared'
import { useLocale } from '@/lib/i18n'
import { formatCount, formatUsdMicros } from './quota-format'

/**
 * Three-segment quota bar — docs/design/vacancy-queue.md §7. Used (`primary`), reserved
 * (`yellow-muted`, 60 %) and uncertain (hatched, so the bar is not colour-only) over the limit, with
 * a legend that carries the numbers and an `aria-label` that names all three.
 *
 * The headline number is used + reserved + uncertain (design.html `quota()`): everything the limit
 * has already committed, which is what the filled part of the bar adds up to.
 */

export interface QuotaFigures {
  used: number
  reserved: number
  uncertain: number
  /** The limit; always greater than zero (the caller draws no bar otherwise). */
  total: number
  unit: JobMeterUnit
}

// One ICU plural per unit, keyed on the limit, so the unit word agrees with the number.
// Module-level `msg`, not `t({ message })` / `plural()`: Stryker rewrites what those macros read.
const QUOTA_LINE = {
  REQUEST: msg`Ліміт: {used} / {total, plural, one {# запит} few {# запити} many {# запитів} other {# запиту}}`,
  RECORD: msg`Ліміт: {used} / {total, plural, one {# запис} few {# записи} many {# записів} other {# запису}}`,
  MODEL_CALL: msg`Ліміт: {used} / {total, plural, one {# виклик моделі} few {# виклики моделі} many {# викликів моделі} other {# виклику моделі}}`,
  USD_MICROS: msg`Ліміт: {used} / {total}`,
} satisfies Record<JobMeterUnit, ReturnType<typeof msg>>

export function QuotaBar({ used, reserved, uncertain, total, unit }: QuotaFigures) {
  const { i18n, t } = useLingui()
  const locale = useLocale()

  const amount = (n: number) =>
    unit === 'USD_MICROS' ? formatUsdMicros(locale, n) : formatCount(locale, n)
  const width = (n: number) => `${Math.min(100, (n * 100) / total)}%`

  const usedText = amount(used)
  const reservedText = amount(reserved)
  const uncertainText = amount(uncertain)
  const totalText = amount(total)

  const line = i18n._(QUOTA_LINE[unit].id, {
    used: amount(used + reserved + uncertain),
    // The plural needs the number; money has no unit word to agree, so it is the formatted text.
    total: unit === 'USD_MICROS' ? totalText : total,
  })

  return (
    <div className="flex flex-col gap-1">
      <p data-testid="job-source-quota-limit" className="tabular-nums text-muted-foreground">
        {line}
      </p>
      <div
        role="img"
        aria-label={t`Використано ${usedText}, зарезервовано ${reservedText}, невизначено ${uncertainText} з ${totalText}`}
        className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          data-testid="job-source-quota-used"
          className="h-full bg-primary"
          style={{ width: width(used) }}
        />
        <div
          data-testid="job-source-quota-reserved"
          className="h-full bg-yellow-muted/60"
          style={{ width: width(reserved) }}
        />
        <div
          data-testid="job-source-quota-uncertain"
          className="h-full bg-[repeating-linear-gradient(135deg,var(--color-muted-foreground)_0_2px,transparent_2px_4px)]"
          style={{ width: width(uncertain) }}
        />
      </div>
      <ul
        data-testid="job-source-quota-legend"
        className="flex flex-wrap gap-x-3 gap-y-0.5 tabular-nums text-muted-foreground"
      >
        <li data-testid="job-source-quota-legend-used" className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-sm bg-primary" />
          <Trans>Використано {usedText}</Trans>
        </li>
        <li data-testid="job-source-quota-legend-reserved" className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-sm bg-yellow-muted/60" />
          <Trans>Зарезервовано {reservedText}</Trans>
        </li>
        <li data-testid="job-source-quota-legend-uncertain" className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2 rounded-sm bg-[repeating-linear-gradient(135deg,var(--color-muted-foreground)_0_2px,transparent_2px_4px)]"
          />
          <Trans>Невизначено {uncertainText}</Trans>
        </li>
      </ul>
    </div>
  )
}
