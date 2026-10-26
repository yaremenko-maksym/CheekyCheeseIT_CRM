import { useMemo } from 'react'
import { useLingui } from '@lingui/react/macro'
import { cn } from '@/lib/utils'
import { useLocale } from '@/lib/i18n'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface MonthPickerFieldProps {
  /** 'YYYY-MM' or '' (nothing chosen). */
  value: string
  /** Only ever emits a complete 'YYYY-MM'. */
  onChange: (v: string) => void
  /** 'YYYY-MM' inclusive; undefined = unbounded. */
  minMonth?: string | undefined
  /** 'YYYY-MM' inclusive; undefined = unbounded. */
  maxMonth?: string | undefined
  disabled?: boolean | undefined
  /** Applied to the month trigger (label target). */
  id?: string | undefined
  'aria-invalid'?: boolean | undefined
  'aria-describedby'?: string | undefined
  'aria-labelledby'?: string | undefined
  'data-testid'?: string | undefined
}

// 'YYYY-MM' -> months since year 0; split() on purpose, a Date round-trip drifts with TZ.
function toIndex(ym: string): number {
  const [y = 0, m = 1] = ym.split('-').map(Number)
  return y * 12 + (m - 1)
}

function fromIndex(i: number): string {
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`
}

const pad = (n: number) => String(n).padStart(2, '0')

export function MonthPickerField({
  value,
  onChange,
  minMonth,
  maxMonth,
  disabled,
  id,
  'aria-invalid': invalid,
  'aria-describedby': describedBy,
  'aria-labelledby': labelledBy,
  'data-testid': testId,
}: MonthPickerFieldProps) {
  const { t } = useLingui()
  const locale = useLocale()

  const now = new Date()
  const curYear = now.getFullYear()
  const curMonth = now.getMonth() + 1
  const [selYear, selMonth] = value ? value.split('-').map(Number) : [undefined, undefined]

  const lo = minMonth ? toIndex(minMonth) : -Infinity
  const hi = maxMonth ? toIndex(maxMonth) : Infinity

  const monthNames = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' })
    return Array.from({ length: 12 }, (_, m) => {
      const name = fmt.format(new Date(Date.UTC(2026, m, 1)))
      return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1)
    })
  }, [locale])

  const years = useMemo(() => {
    const first = minMonth ? Number(minMonth.slice(0, 4)) : curYear - 3
    const last = maxMonth ? Number(maxMonth.slice(0, 4)) : curYear + 1
    const set = new Set<number>()
    for (let y = first; y <= last; y++) set.add(y)
    if (selYear) set.add(selYear)
    return [...set].sort((a, b) => a - b)
  }, [minMonth, maxMonth, curYear, selYear])

  const emit = (y: number, m: number) => {
    const clamped = Math.min(Math.max(y * 12 + (m - 1), lo), hi)
    onChange(fromIndex(clamped))
  }

  const monthYear = selYear ?? curYear
  const invalidCls = invalid && 'border-destructive'

  return (
    <div role="group" aria-labelledby={labelledBy} className="flex gap-2" data-testid={testId}>
      <Select
        value={selMonth ? pad(selMonth) : ''}
        onValueChange={(m) => emit(monthYear, Number(m))}
        disabled={disabled ?? false}
      >
        <SelectTrigger
          id={id}
          aria-label={t`Місяць зарплати`}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className={cn('h-9 min-w-0 flex-1 text-sm', invalidCls)}
          data-testid="create-transaction-salary-month-select"
        >
          <SelectValue placeholder={t`Місяць`} />
        </SelectTrigger>
        <SelectContent>
          {monthNames.map((name, i) => {
            const idx = monthYear * 12 + i
            return (
              <SelectItem
                key={i}
                value={pad(i + 1)}
                disabled={idx < lo || idx > hi}
                className="text-sm"
                data-testid={`salary-month-option-${pad(i + 1)}`}
              >
                {name}
              </SelectItem>
            )
          })}
        </SelectContent>
      </Select>
      <Select
        value={selYear ? String(selYear) : ''}
        onValueChange={(y) => emit(Number(y), selMonth ?? curMonth)}
        disabled={disabled ?? false}
      >
        <SelectTrigger
          aria-label={t`Рік зарплати`}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          className={cn('h-9 w-[5.5rem] shrink-0 text-sm tabular-nums', invalidCls)}
          data-testid="create-transaction-salary-year-select"
        >
          <SelectValue placeholder={t`Рік`} />
        </SelectTrigger>
        <SelectContent>
          {years.map((y) => (
            <SelectItem
              key={y}
              value={String(y)}
              className="text-sm tabular-nums"
              data-testid={`salary-year-option-${y}`}
            >
              {y}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
