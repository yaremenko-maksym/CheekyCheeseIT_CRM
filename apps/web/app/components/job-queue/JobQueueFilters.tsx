import { useState, type ReactNode } from 'react'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { MessageDescriptor } from '@lingui/core'
import { SlidersHorizontal } from 'lucide-react'
import {
  jobAvailabilitySchema,
  jobQueueEligibilitySchema,
  jobSourceTypeSchema,
  type JobQueueListQuery,
} from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { sourceLabel } from './JobQueueRow'

/** The bounded multi-select filters of the list; tabs carry the submission axis (spec §4.1a). */
export type JobQueueFilterValue = Partial<
  Pick<JobQueueListQuery, 'source' | 'eligibility' | 'availability'>
>
type Group = keyof JobQueueFilterValue

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

/** The number of filter groups in use — the badge counts groups, not options (spec §4.1a). */
export function appliedFilterCount(value: JobQueueFilterValue): number {
  return [value.source, value.eligibility, value.availability].filter((g) => g?.length).length
}

/** «Застосовано: DOU, Djinni · Відкрита» + a reset, shown only while a filter group is applied. */
export function JobQueueAppliedFilters({
  value,
  onReset,
}: {
  value: JobQueueFilterValue
  onReset: () => void
}) {
  const { i18n } = useLingui()
  const summary = [
    value.source?.map(sourceLabel),
    value.eligibility?.map((o) => i18n._(ELIGIBILITY_LABEL[o])),
    value.availability?.map((o) => i18n._(AVAILABILITY_LABEL[o])),
  ]
    .flatMap((g) => (g?.length ? [g.join(', ')] : []))
    .join(' · ')
  if (!summary) return null
  return (
    <div
      data-testid="job-queue-applied"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground"
    >
      <p className="min-w-0 break-words text-pretty">
        <Trans>Застосовано: {summary}</Trans>
      </p>
      <Button variant="link" className="min-h-11 px-0" onClick={onReset}>
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
  children,
}: {
  checked: boolean
  onChange: () => void
  children: ReactNode
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 text-sm hover:bg-muted/50">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="size-4 accent-primary"
      />
      <span className="min-w-0 truncate">{children}</span>
    </label>
  )
}

function FilterGroup({
  legend,
  children,
  scroll,
}: {
  legend: ReactNode
  children: ReactNode
  scroll?: boolean
}) {
  return (
    <fieldset className="flex flex-col gap-0.5">
      <legend className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {legend}
      </legend>
      <div className={scroll ? 'max-h-48 overflow-y-auto' : undefined}>{children}</div>
    </fieldset>
  )
}

export function JobQueueFilters({
  value,
  onApply,
}: {
  value: JobQueueFilterValue
  onApply: (next: JobQueueFilterValue) => void
}) {
  const { i18n } = useLingui()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<JobQueueFilterValue>(value)
  const applied = appliedFilterCount(value)

  function onOpenChange(next: boolean) {
    if (next) setDraft(value)
    setOpen(next)
  }

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
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          data-testid="job-queue-filters-button"
          variant="outline"
          className="min-h-11 min-w-11 gap-2 self-start px-0 min-[560px]:px-4"
        >
          <SlidersHorizontal aria-hidden="true" className="size-4" />
          {/* below 560 px an icon-only 44x44 button; the label stays for screen readers */}
          <span className="sr-only min-[560px]:not-sr-only">
            <Trans>Фільтри</Trans>
          </span>
          {applied > 0 && (
            <span className="rounded-full bg-primary px-1.5 text-xs tabular-nums text-primary-foreground">
              {applied}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        data-testid="job-queue-filters-panel"
        align="end"
        className="flex w-[min(20rem,calc(100vw-2rem))] flex-col gap-4"
      >
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
        <FilterGroup legend={<Trans>Джерело</Trans>} scroll>
          {jobSourceTypeSchema.options.map((o) => row('source', o, sourceLabel(o)))}
        </FilterGroup>
        <div className="flex gap-2">
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
            onClick={() => {
              onApply(draft)
              setOpen(false)
            }}
          >
            <Trans>Застосувати</Trans>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
