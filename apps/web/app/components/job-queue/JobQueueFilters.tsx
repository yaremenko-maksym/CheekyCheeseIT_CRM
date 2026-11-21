import { useState, type ReactNode } from 'react'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { MessageDescriptor } from '@lingui/core'
import { SlidersHorizontal } from 'lucide-react'
import {
  JOB_QUEUE_SALARY_MIN_MONTHLY_MAX,
  JOB_QUEUE_SENIOR_FILTER_MAX,
  JOB_QUEUE_SENIOR_OPTIONS_MAX,
  jobAvailabilitySchema,
  jobQueueEligibilitySchema,
  jobQueueSalaryStatedSchema,
  jobSourceTypeSchema,
  type JobQueueListQuery,
} from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { sourceLabel } from './JobQueueRow'
import { formatSalary } from './salary-format'

/** The bounded multi-select filters of the list; tabs carry the submission axis (spec §4.1a). */
export type JobQueueFilterValue = Partial<
  Pick<
    JobQueueListQuery,
    | 'source'
    | 'eligibility'
    | 'availability'
    | 'seniorIds'
    | 'salary'
    | 'salaryCurrency'
    | 'salaryMinMonthly'
  >
>
/** The multi-select groups; the salary currency and minimum are scalars inside the salary group. */
type Group = 'source' | 'eligibility' | 'availability' | 'seniorIds' | 'salary'

type SeniorOption = { id: string; name: string; teamName: string | null }
/** The picker's load state: `items` is absent until the first answer, and survives a failed refetch. */
type SeniorPicker = {
  items: ReadonlyArray<SeniorOption> | undefined
  isError: boolean
  onRetry: () => void
}

const ELIGIBILITY_LABEL: Record<'LEAD' | 'TRIAGE', MessageDescriptor> = {
  LEAD: msg`Збіг за стеком`,
  TRIAGE: msg`Потребує розгляду`,
}
const AVAILABILITY_LABEL: Record<'OPEN' | 'UNKNOWN' | 'CLOSED' | 'EXPIRED', MessageDescriptor> = {
  OPEN: msg`Відкрита`,
  UNKNOWN: msg`Невідомо`,
  CLOSED: msg`Закрита`,
  EXPIRED: msg`Прострочена`,
}
// Module-level `msg` plural, not the `plural()` macro (breaks under Stryker, see TxDateField).
const SENIOR_COUNT = msg`{n, plural, one {# сеньйор} few {# сеньйори} many {# сеньйорів} other {# сеньйора}}`
// The summary names the chosen seniors after a prefix (spec §4.1a): one is «Сеньйор:», more «Сеньйори:».
const SENIOR_ONE = msg`Сеньйор: {names}`
const SENIOR_MANY = msg`Сеньйори: {names}`
/** The ADMIN picker's last group: seniors with no live team membership. */
const NO_TEAM = msg`Без команди`
const SALARY_LABEL: Record<'STATED' | 'NOT_STATED', MessageDescriptor> = {
  STATED: msg`Зарплату вказано`,
  NOT_STATED: msg`Без зарплати`,
}
/**
 * shortcut: a fixed list of the currencies the sources state most; the API takes any ISO 4217 code,
 * so grow the list (or derive it from the data) when a recruiter needs another one.
 */
const SALARY_CURRENCIES = ['EUR', 'USD', 'PLN', 'GBP', 'UAH'] as const

/** Salary stated, and nothing else: the only selection a currency or a minimum narrows. */
const statedOnly = (v: JobQueueFilterValue) => v.salary?.length === 1 && v.salary[0] === 'STATED'

/**
 * Drops the salary bounds the API would refuse: a currency or minimum outside "stated only", and a
 * monthly minimum without its currency (there is no exchange rate to compare across currencies).
 */
export function coherentSalary(value: JobQueueFilterValue): JobQueueFilterValue {
  const { salaryCurrency, salaryMinMonthly, ...rest } = value
  if (!statedOnly(rest) || salaryCurrency === undefined) return rest
  return salaryMinMonthly === undefined
    ? { ...rest, salaryCurrency }
    : { ...rest, salaryCurrency, salaryMinMonthly }
}

/** The number of filter groups in use — the badge counts groups, not options (spec §4.1a). */
export function appliedFilterCount(value: JobQueueFilterValue): number {
  return [
    value.source,
    value.eligibility,
    value.availability,
    value.seniorIds,
    value.salary,
  ].filter((g) => g?.length).length
}

/** «Застосовано: DOU, Djinni · Відкрита» + a reset, shown only while a filter group is applied. */
export function JobQueueAppliedFilters({
  value,
  seniors,
  onReset,
}: {
  value: JobQueueFilterValue
  /** Names for the applied seniors; one missing name turns them into a count, never a raw id. */
  seniors?: ReadonlyArray<SeniorOption> | undefined
  onReset: () => void
}) {
  const { i18n } = useLingui()
  const seniorIds = value.seniorIds ?? []
  const seniorNames = seniorIds.flatMap((id) => seniors?.find((s) => s.id === id)?.name || [])
  const named = seniorIds.length === 1 ? SENIOR_ONE : SENIOR_MANY
  const summary = [
    seniorIds.length === 0
      ? []
      : [
          seniorNames.length === seniorIds.length
            ? i18n._(named.id, { names: seniorNames.join(', ') })
            : i18n._(SENIOR_COUNT.id, { n: seniorIds.length }),
        ],
    value.source?.map(sourceLabel),
    value.eligibility?.map((o) => i18n._(ELIGIBILITY_LABEL[o])),
    value.availability?.map((o) => i18n._(AVAILABILITY_LABEL[o])),
    value.salary && [
      ...value.salary.map((o) => i18n._(SALARY_LABEL[o])),
      ...(value.salaryCurrency === undefined
        ? []
        : value.salaryMinMonthly === undefined
          ? [value.salaryCurrency]
          : [
              formatSalary(
                {
                  min: value.salaryMinMonthly,
                  max: null,
                  currency: value.salaryCurrency,
                  period: 'MONTH',
                },
                i18n.locale,
                i18n,
              ),
            ]),
    ],
  ]
    .flatMap((g) => (g?.length ? [g.join(', ')] : []))
    .join(' · ')
  if (!summary) return null
  return (
    <div
      data-testid="job-queue-applied"
      className="flex items-baseline justify-between gap-x-3 text-sm text-muted-foreground"
    >
      <p className="min-w-0 flex-1 break-words text-pretty">
        <Trans>Застосовано: {summary}</Trans>
      </p>
      <Button variant="link" className="min-h-11 shrink-0 whitespace-nowrap px-0" onClick={onReset}>
        <Trans>Скинути фільтри</Trans>
      </Button>
    </div>
  )
}

function toggle(draft: JobQueueFilterValue, group: Group, option: string): JobQueueFilterValue {
  const current: readonly string[] = draft[group] ?? []
  const next = current.includes(option) ? current.filter((v) => v !== option) : [...current, option]
  const { [group]: _dropped, ...rest } = draft
  return next.length === 0 ? rest : { ...rest, [group]: next }
}

function CheckRow({
  checked,
  onChange,
  title,
  disabled,
  children,
}: {
  checked: boolean
  onChange: () => void
  title?: string
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 text-sm hover:bg-muted/50 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="size-4 shrink-0 accent-primary"
      />
      <span title={title} className="min-w-0 truncate">
        {children}
      </span>
    </label>
  )
}

function FilterGroup({
  legend,
  busy,
  children,
}: {
  legend: ReactNode
  busy?: boolean
  children: ReactNode
}) {
  return (
    <fieldset aria-busy={busy ? true : undefined} className="flex min-w-0 flex-col gap-0.5">
      <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {legend}
      </legend>
      <div>{children}</div>
    </fieldset>
  )
}

/** The options by team, in the server's order (team, team-less last, then name): the group order. */
function byTeam(items: ReadonlyArray<SeniorOption>): Array<[string | null, SeniorOption[]]> {
  const teams = new Map<string | null, SeniorOption[]>()
  for (const item of items) teams.set(item.teamName, [...(teams.get(item.teamName) ?? []), item])
  return [...teams]
}

/** Rows win over the error: a failed refetch keeps the list the recruiter is already using. */
function SeniorRows({
  picker,
  selected,
  onToggle,
}: {
  picker: SeniorPicker
  selected: readonly string[] | undefined
  onToggle: (id: string) => void
}) {
  const { i18n } = useLingui()
  if (picker.items) {
    if (picker.items.length === 0) {
      return (
        <p className="px-2 py-3 text-sm text-muted-foreground">
          <Trans>Немає сеньйорів</Trans>
        </p>
      )
    }
    const atLimit = (selected?.length ?? 0) >= JOB_QUEUE_SENIOR_FILTER_MAX
    const check = ({ id, name }: SeniorOption) => {
      const checked = selected?.includes(id) ?? false
      return (
        <CheckRow
          key={id}
          checked={checked}
          title={name}
          disabled={atLimit && !checked}
          onChange={() => onToggle(id)}
        >
          {name}
        </CheckRow>
      )
    }
    const teams = byTeam(picker.items)
    const max = JOB_QUEUE_SENIOR_OPTIONS_MAX
    return (
      <>
        {/* One team (every HR) is a flat list; the studio (ADMIN) gets a heading per team. */}
        {teams.length === 1
          ? picker.items.map(check)
          : teams.map(([team, rows]) => {
              const heading = team ?? i18n._(NO_TEAM.id)
              return (
                <div key={heading} role="group" aria-label={heading}>
                  <p
                    aria-hidden
                    className="truncate px-2 pt-2 text-xs font-medium text-muted-foreground"
                  >
                    {heading}
                  </p>
                  {rows.map(check)}
                </div>
              )
            })}
        {picker.items.length >= max && (
          <p
            data-testid="job-queue-filters-seniors-truncated"
            className="px-2 pt-1 text-xs text-muted-foreground"
          >
            <Trans>Показано перших {max} сеньйорів</Trans>
          </p>
        )}
      </>
    )
  }
  if (picker.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-1 px-2 text-sm">
        <p className="text-pretty text-muted-foreground">
          <Trans>Не вдалося завантажити сеньйорів</Trans>
        </p>
        <Button variant="outline" className="min-h-11" onClick={picker.onRetry}>
          <Trans>Спробувати ще раз</Trans>
        </Button>
      </div>
    )
  }
  return <Skeleton data-testid="job-queue-filters-seniors-loading" className="h-11 w-full" />
}

const SELECT_CLASS =
  'min-h-11 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring'

/** Currency, then a monthly minimum in it; mounted only while "salary stated" alone is chosen. */
function SalaryBounds({
  value,
  onChange,
}: {
  value: JobQueueFilterValue
  onChange: (next: JobQueueFilterValue) => void
}) {
  const { t } = useLingui()
  // the typed text, so a half-typed or out-of-range number stays visible instead of snapping away
  const [minText, setMinText] = useState(String(value.salaryMinMonthly ?? ''))
  const { salaryCurrency: _currency, salaryMinMonthly: _min, ...rest } = value
  const withMin = (text: string) => {
    const n = Number(text)
    return text !== '' && Number.isInteger(n) && n >= 1 && n <= JOB_QUEUE_SALARY_MIN_MONTHLY_MAX
      ? { salaryMinMonthly: n }
      : {}
  }
  return (
    <div className="flex flex-col gap-3 px-2 pt-2">
      <label className="flex flex-col gap-1 text-sm">
        <Trans>Валюта</Trans>
        <select
          data-testid="job-queue-filters-salary-currency"
          className={SELECT_CLASS}
          value={value.salaryCurrency ?? ''}
          onChange={(e) => {
            const currency = e.target.value
            if (currency === '') setMinText('')
            onChange(
              currency === '' ? rest : { ...rest, salaryCurrency: currency, ...withMin(minText) },
            )
          }}
        >
          <option value="">{t`Будь-яка`}</option>
          {SALARY_CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm has-[:disabled]:opacity-50">
        <Trans>Мінімум на місяць</Trans>
        <Input
          data-testid="job-queue-filters-salary-min"
          type="number"
          inputMode="numeric"
          min={1}
          max={JOB_QUEUE_SALARY_MIN_MONTHLY_MAX}
          step={1}
          className="min-h-11 tabular-nums"
          disabled={value.salaryCurrency === undefined}
          value={minText}
          onChange={(e) => {
            setMinText(e.target.value)
            onChange({ ...rest, salaryCurrency: value.salaryCurrency, ...withMin(e.target.value) })
          }}
        />
      </label>
    </div>
  )
}

/**
 * The panel body. The popover unmounts it on close, so every open starts a fresh draft from the
 * applied value and an unapplied draft is discarded.
 */
function FilterPanel({
  value,
  seniors,
  onApply,
}: {
  value: JobQueueFilterValue
  seniors?: SeniorPicker | undefined
  onApply: (next: JobQueueFilterValue) => void
}) {
  const { i18n } = useLingui()
  const [draft, setDraft] = useState<JobQueueFilterValue>(value)

  const row = (group: Group, option: string, label: ReactNode) => (
    <CheckRow
      key={option}
      checked={(draft[group] as readonly string[] | undefined)?.includes(option) ?? false}
      onChange={() => setDraft((d) => toggle(d, group, option))}
    >
      {label}
    </CheckRow>
  )

  return (
    <>
      {/* One scroll region (the list is too long for a phone); the footer stays pinned below it. */}
      <div
        data-testid="job-queue-filters-body"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain"
      >
        {seniors && (
          <FilterGroup
            legend={<Trans>Підходить сеньйору</Trans>}
            busy={!seniors.items && !seniors.isError}
          >
            <SeniorRows
              picker={seniors}
              selected={draft.seniorIds}
              onToggle={(id) => setDraft((d) => toggle(d, 'seniorIds', id))}
            />
          </FilterGroup>
        )}
        <FilterGroup legend={<Trans>Тип збігу</Trans>}>
          {jobQueueEligibilitySchema.options.map((o) =>
            row('eligibility', o, i18n._(ELIGIBILITY_LABEL[o])),
          )}
        </FilterGroup>
        <FilterGroup legend={<Trans>Статус на джерелі</Trans>}>
          {jobAvailabilitySchema.options.map((o) =>
            row('availability', o, i18n._(AVAILABILITY_LABEL[o])),
          )}
        </FilterGroup>
        <FilterGroup legend={<Trans>Зарплата</Trans>}>
          {jobQueueSalaryStatedSchema.options.map((o) => row('salary', o, i18n._(SALARY_LABEL[o])))}
          {statedOnly(draft) && <SalaryBounds value={draft} onChange={setDraft} />}
        </FilterGroup>
        <FilterGroup legend={<Trans>Джерело</Trans>}>
          {jobSourceTypeSchema.options.map((o) => row('source', o, sourceLabel(o)))}
        </FilterGroup>
      </div>
      <div data-testid="job-queue-filters-footer" className="flex shrink-0 gap-2">
        <Button
          data-testid="job-queue-filters-clear"
          variant="ghost"
          className="min-h-11 flex-1"
          onClick={() => setDraft({})}
        >
          <Trans>Скинути вибір</Trans>
        </Button>
        <Button
          data-testid="job-queue-filters-apply"
          className="min-h-11 flex-1"
          onClick={() => onApply(coherentSalary(draft))}
        >
          <Trans>Застосувати</Trans>
        </Button>
      </div>
    </>
  )
}

export function JobQueueFilters({
  value,
  seniors,
  onApply,
}: {
  value: JobQueueFilterValue
  seniors?: SeniorPicker | undefined
  onApply: (next: JobQueueFilterValue) => void
}) {
  const [open, setOpen] = useState(false)
  const applied = appliedFilterCount(value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          data-testid="job-queue-filters-button"
          variant="outline"
          className="min-h-11 min-w-11 shrink-0 gap-2 self-start px-0 @min-[560px]:px-4"
        >
          <SlidersHorizontal aria-hidden="true" className="size-4" />
          {/* below 560 px of content an icon-only 44x44 button; the label stays for screen readers */}
          <span className="sr-only @min-[560px]:not-sr-only">
            <Trans>Фільтри</Trans>
          </span>
          {applied > 0 && (
            <>
              <span
                aria-hidden="true"
                className="rounded-full bg-primary px-1.5 text-xs tabular-nums text-primary-foreground"
              >
                {applied}
              </span>
              <span className="sr-only">
                <Trans>Активних фільтрів: {applied}</Trans>
              </span>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        data-testid="job-queue-filters-panel"
        align="end"
        collisionPadding={8}
        className="flex max-h-[var(--radix-popover-content-available-height)] w-[min(20rem,calc(100vw-2rem))] flex-col gap-4 overflow-hidden"
      >
        <FilterPanel
          value={value}
          seniors={seniors}
          onApply={(next) => {
            onApply(next)
            setOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}
