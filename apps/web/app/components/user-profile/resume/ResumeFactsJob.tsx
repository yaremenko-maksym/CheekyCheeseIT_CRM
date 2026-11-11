/**
 * Building blocks of the facts form (`ResumeFactsForm`): one work-experience
 * block and the small row / icon-button primitives the list cards share.
 * Split out so the form file stays under the 800-line limit.
 */
import { useId, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { RESUME_LIMITS, type CompletenessCode, type ResumeFactsExperience } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MonthPickerField } from '@/components/ui/month-picker'
import { Switch } from '@/components/ui/switch'
import { TechAutocompleteInput } from '@/components/ui/tech-autocomplete-input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { COMPLETENESS_MESSAGES, factsFieldId } from './ResumeCompletenessPanel'

/** The error line under one field; shown once the field was touched. */
export function FieldError({
  field,
  errors,
  touched,
}: {
  field: string
  errors: ReadonlyMap<string, CompletenessCode[]>
  touched: ReadonlySet<string>
}) {
  const { i18n } = useLingui()
  const codes = errors.get(field)
  if (!touched.has(field) || !codes) return null
  return (
    <p id={`${factsFieldId(field)}-error`} className="text-xs text-destructive">
      {codes.map((code) => i18n._(COMPLETENESS_MESSAGES[code])).join(' ')}
    </p>
  )
}

export type A11y = (
  field: string,
  extraDescribedBy?: string,
) => {
  id: string
  'aria-invalid': boolean | undefined
  'aria-describedby': string | undefined
  onBlur: () => void
}

export function JobBlock({
  job,
  index,
  count,
  nowMonth,
  a11y,
  fieldError,
  onPatch,
  onMove,
  onRemove,
}: {
  job: ResumeFactsExperience
  index: number
  count: number
  nowMonth: string
  a11y: A11y
  fieldError: (field: string) => ReactNode
  onPatch: (changes: Partial<ResumeFactsExperience>) => void
  onMove: (to: number) => void
  onRemove: () => void
}) {
  const { t } = useLingui()
  const position = index + 1
  const base = `experience.${index}`
  const notesHintId = useId()
  const currentId = useId()
  const startA11y = a11y(`${base}.start`)
  const endA11y = a11y(`${base}.end`)
  const techA11y = a11y(`${base}.technologies`)

  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid={`resume-facts-job-${index}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          <Trans>Місце роботи {position}</Trans>
        </p>
        <div className="flex shrink-0 gap-1">
          <IconButton
            label={t`Перемістити місце роботи ${position} вгору`}
            disabled={index === 0}
            onClick={() => onMove(index - 1)}
          >
            <ArrowUp className="size-4" aria-hidden />
          </IconButton>
          <IconButton
            label={t`Перемістити місце роботи ${position} вниз`}
            disabled={index === count - 1}
            onClick={() => onMove(index + 1)}
          >
            <ArrowDown className="size-4" aria-hidden />
          </IconButton>
          <IconButton label={t`Видалити місце роботи ${position}`} destructive onClick={onRemove}>
            <Trash2 className="size-4" aria-hidden />
          </IconButton>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={factsFieldId(`${base}.company`)}>
            <Trans>Компанія</Trans>
          </Label>
          <Input
            {...a11y(`${base}.company`)}
            aria-label={t`Компанія, місце роботи ${position}`}
            value={job.company}
            maxLength={RESUME_LIMITS.shortText}
            onChange={(e) => onPatch({ company: e.target.value })}
            name="resumeFactsCompany"
          />
          {fieldError(`${base}.company`)}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={factsFieldId(`${base}.role`)}>
            <Trans>Посада</Trans>
          </Label>
          <Input
            {...a11y(`${base}.role`)}
            aria-label={t`Посада, місце роботи ${position}`}
            value={job.role}
            maxLength={RESUME_LIMITS.shortText}
            onChange={(e) => onPatch({ role: e.target.value })}
            name="resumeFactsRole"
          />
          {fieldError(`${base}.role`)}
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={factsFieldId(`${base}.location`)}>
            <Trans>Локація (необов’язково)</Trans>
          </Label>
          <Input
            {...a11y(`${base}.location`)}
            aria-label={t`Локація, місце роботи ${position}`}
            value={job.location ?? ''}
            maxLength={RESUME_LIMITS.shortText}
            onChange={(e) => onPatch({ location: e.target.value === '' ? null : e.target.value })}
            name="resumeFactsJobLocation"
          />
          {fieldError(`${base}.location`)}
        </div>
        <div className="space-y-1.5" onBlur={startA11y.onBlur}>
          <Label htmlFor={startA11y.id}>
            <Trans>Початок</Trans>
          </Label>
          <MonthPickerField
            id={startA11y.id}
            value={job.start ?? ''}
            minMonth="1970-01"
            maxMonth={nowMonth}
            onChange={(start) => onPatch({ start })}
            aria-invalid={startA11y['aria-invalid']}
            aria-describedby={startA11y['aria-describedby']}
            monthAriaLabel={t`Місяць початку, місце роботи ${position}`}
            yearAriaLabel={t`Рік початку, місце роботи ${position}`}
          />
          {fieldError(`${base}.start`)}
        </div>
        <div className="space-y-1.5" onBlur={endA11y.onBlur}>
          <Label htmlFor={endA11y.id}>
            <Trans>Кінець</Trans>
          </Label>
          <MonthPickerField
            id={endA11y.id}
            value={job.end ?? ''}
            minMonth="1970-01"
            maxMonth={nowMonth}
            disabled={job.current}
            onChange={(end) => onPatch({ end })}
            aria-invalid={endA11y['aria-invalid']}
            aria-describedby={endA11y['aria-describedby']}
            monthAriaLabel={t`Місяць завершення, місце роботи ${position}`}
            yearAriaLabel={t`Рік завершення, місце роботи ${position}`}
          />
          {fieldError(`${base}.end`)}
        </div>
      </div>

      <div className="flex min-h-11 items-center gap-2">
        <Switch
          id={currentId}
          checked={job.current}
          onCheckedChange={(current) => onPatch(current ? { current, end: null } : { current })}
        />
        <Label htmlFor={currentId}>
          <Trans>Працюю тут зараз</Trans>
        </Label>
      </div>

      <div className="space-y-1.5" id={factsFieldId(`${base}.technologies`)}>
        <p className="text-sm font-medium">
          <Trans context="resume">Технології</Trans>
        </p>
        <TechAutocompleteInput
          value={job.technologies}
          onChange={(technologies) => onPatch({ technologies })}
          maxItems={RESUME_LIMITS.skills}
          onBlur={techA11y.onBlur}
          placeholder={t`Технології, місце роботи ${position}`}
          errorId={
            techA11y['aria-invalid'] ? `${factsFieldId(`${base}.technologies`)}-error` : undefined
          }
        />
        {fieldError(`${base}.technologies`)}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={factsFieldId(`${base}.notes`)}>
          <Trans>Нотатки про досягнення</Trans>
        </Label>
        <p id={notesHintId} className="text-xs text-muted-foreground">
          <Trans>По одній нотатці в рядку</Trans>
        </p>
        <Textarea
          {...a11y(`${base}.notes`, notesHintId)}
          aria-label={t`Нотатки, місце роботи ${position}`}
          rows={4}
          placeholder={t`Що ви зробили і з яким результатом`}
          value={job.notes.join('\n')}
          onChange={(e) => onPatch({ notes: e.target.value.split('\n') })}
          name="resumeFactsNotes"
          data-testid={`resume-facts-notes-${index}`}
        />
        {fieldError(`${base}.notes`)}
      </div>
    </div>
  )
}

/** A bordered sub-block inside a card (not a card in a card). */
export function RowBlock({
  title,
  removeLabel,
  onRemove,
  children,
}: {
  title: string
  removeLabel: string
  onRemove: () => void
  children: ReactNode
}) {
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{title}</p>
        <IconButton label={removeLabel} destructive onClick={onRemove}>
          <Trash2 className="size-4" aria-hidden />
        </IconButton>
      </div>
      {children}
    </div>
  )
}

/** Icon-only button: aria-label AND title (design §8), 44px on mobile. */
export function IconButton({
  label,
  destructive = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string
  destructive?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn('size-11 shrink-0 sm:size-9', destructive && 'text-destructive')}
    >
      {children}
    </Button>
  )
}
