/**
 * The live "what is still missing" list next to the facts form (design §5.1).
 *
 * Issues come from `checkResumeCompleteness`, the same function the server runs
 * at Submit, so the list here is the list the server would answer with. Each
 * row is a button that focuses its field; Submit stays disabled while any row
 * exists. The row labels and code texts are exported for the failure panel.
 */
import { useId, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import type { CompletenessCode, CompletenessIssue } from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** One text per completeness code; a new code fails the type check. */
export const COMPLETENESS_MESSAGES: Record<CompletenessCode, MessageDescriptor> = {
  HEADLINE_MISSING: msg`Вкажіть цільову посаду`,
  NO_EXPERIENCE: msg`Додайте хоча б одне місце роботи`,
  COMPANY_MISSING: msg`Вкажіть компанію`,
  ROLE_MISSING: msg`Вкажіть посаду`,
  START_MISSING: msg`Вкажіть місяць початку`,
  END_MISSING: msg`Вкажіть місяць завершення або позначте «Працюю тут зараз»`,
  END_BEFORE_START: msg`Кінець не може бути раніше за початок`,
  START_IN_FUTURE: msg`Початок не може бути в майбутньому`,
  END_IN_FUTURE: msg`Кінець не може бути в майбутньому. Якщо ви ще тут працюєте, позначте «Працюю тут зараз»`,
  NO_NOTES: msg`Додайте хоча б одну нотатку про досягнення`,
  TOO_FEW_SKILLS: msg`Потрібно щонайменше 5 навичок разом із технологіями з досвіду`,
  ENGLISH_MISSING: msg`Додайте англійську до мов`,
  NON_LATIN: msg`Пишіть лише латиницею — резюме англійською`,
  NAME_NON_LATIN: msg`Ім’я в профілі має бути латиницею. Змініть його в профілі`,
  CONTACT_IN_TEXT: msg`Приберіть ім’я, email або телефон — контакти не потрапляють у текст резюме`,
  LINK_INVALID: msg`Вкажіть назву й адресу https:// або mailto:`,
  YEAR_INVALID: msg`Рік має бути між 1950 і 2100`,
}

/**
 * The form field an issue path points at, or null when the field lives
 * elsewhere (the profile name). List-level paths point at the list's field or
 * its "Add" button; item-level `notes.<j>` / `technologies.<j>` at the job's
 * notes textarea / technologies input.
 */
export function issueFieldPath(path: string): string | null {
  if (path === 'displayName' || path === '') return null
  if (path === 'experience' || path === 'languages') return `${path}.add`
  const parts = path.split('.')
  if (parts[0] === 'skills') return 'skills'
  if (parts[0] === 'experience' && parts.length === 4) return parts.slice(0, 3).join('.')
  return path
}

/** The DOM id of a facts field, shared by the form (render) and the panel (focus). */
export function factsFieldId(fieldPath: string): string {
  return `resume-facts-${fieldPath.replaceAll('.', '-')}`
}

/**
 * Focus a facts field (or the first control inside its wrapper) and scroll it
 * into view. False when the field is not on screen.
 */
export function focusFactsField(fieldPath: string): boolean {
  const el = document.getElementById(factsFieldId(fieldPath))
  if (!el) return false
  const target = el.matches('input, textarea, button')
    ? el
    : (el.querySelector<HTMLElement>('input, textarea, button') ?? el)
  target.scrollIntoView?.({ block: 'center' })
  target.focus()
  return true
}

/** Row label, design §10.6: `{section} · {field}`, positions are index + 1. */
export function useIssueLabel(): (path: string) => string {
  const { t } = useLingui()
  const sections: Record<string, string> = {
    headline: t`Цільова посада`,
    skills: t`Навички`,
    experience: t`Досвід роботи`,
    education: t`Освіта`,
    languages: t`Мови`,
    links: t({ message: 'Посилання', context: 'resume' }),
    summary: t`Про себе`,
    displayName: t`Ім’я в профілі`,
    email: t`Email у профілі`,
  }
  const jobFields: Record<string, string> = {
    company: t`Компанія`,
    role: t`Посада`,
    location: t`Локація (необов’язково)`,
    start: t`Початок`,
    end: t`Кінець`,
    period: t`Період`,
    notes: t`Нотатки`,
    technologies: t({ message: 'Технології', context: 'resume' }),
    bullets: t`Пункти`,
  }
  const educationFields: Record<string, string> = {
    institution: t`Навчальний заклад`,
    degree: t`Ступінь / спеціальність`,
    startYear: t`Початок`,
    endYear: t`Кінець`,
    period: t`Період`,
  }
  return (path) => {
    const [section = '', index, field] = path.split('.')
    const n = Number(index) + 1
    if (path === 'location.city') return t`Місто`
    if (path === 'location.country') return t`Країна`
    if (section === 'experience' && index !== undefined) {
      const job = t`Місце роботи ${n}`
      const label = field === undefined ? undefined : jobFields[field]
      return label ? `${job} · ${label}` : job
    }
    if (section === 'education' && index !== undefined) {
      const item = t`Освіта ${n}`
      const label = field === undefined ? undefined : educationFields[field]
      return label ? `${item} · ${label}` : item
    }
    if (section === 'skills' && index !== undefined)
      return `${sections.skills} · ${t`Навичка ${n}`}`
    if (section === 'languages' && index !== undefined) {
      return `${sections.languages} · ${t`Мова ${n}`}`
    }
    if (section === 'links' && index !== undefined)
      return `${sections.links} · ${t`Посилання ${n}`}`
    // Report-only (render / ATS / visual gates): a page of the PDF, not a field.
    if (section === 'pages' && index !== undefined) return t`Сторінка ${n}`
    return sections[section] ?? t`Резюме загалом`
  }
}

/** One issue row: a button when the path maps to a field, a plain row otherwise. */
export function IssueRow({
  label,
  text,
  onFocus,
  tone = 'destructive',
}: {
  label: string
  text: string
  onFocus: (() => void) | null
  tone?: 'destructive' | 'amber'
}) {
  const body = (
    <>
      <span
        aria-hidden
        className={cn(
          'mt-1.5 size-1.5 shrink-0 rounded-full',
          tone === 'amber' ? 'bg-amber-500' : 'bg-destructive',
        )}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium break-words">{label}</span>
        <span className="block text-xs text-muted-foreground break-words">{text}</span>
      </span>
    </>
  )
  const rowClass = 'flex min-h-11 w-full items-start gap-2 rounded-md px-2 py-1.5 text-left'
  return (
    <li>
      {onFocus ? (
        <button
          type="button"
          onClick={onFocus}
          className={cn(
            rowClass,
            'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          {body}
        </button>
      ) : (
        <div className={rowClass}>{body}</div>
      )}
    </li>
  )
}

export interface ResumeCompletenessPanelProps {
  issues: CompletenessIssue[]
  onFocusPath: (path: string) => void
  onSubmit: () => void
  onSaveDraft: () => void
  /** The draft differs from the saved facts. */
  canSave: boolean
  /** A check is running (or the viewer cannot write): no action is possible. */
  disabled: boolean
  pending: 'save' | 'submit' | null
}

export function ResumeCompletenessPanel({
  issues,
  onFocusPath,
  onSubmit,
  onSaveDraft,
  canSave,
  disabled,
  pending,
}: ResumeCompletenessPanelProps) {
  const { i18n } = useLingui()
  const issueLabel = useIssueLabel()
  const listId = useId()
  const hintId = useId()
  // Collapsed by default on long lists; the toggle only shows below lg.
  const [open, setOpen] = useState(issues.length <= 5)
  const clean = issues.length === 0
  const submitDisabled = !clean || disabled || pending !== null

  return (
    <section
      aria-labelledby={`${listId}-title`}
      className="rounded-xl border bg-card p-4 shadow-sm lg:sticky lg:top-4"
      data-testid="resume-completeness-panel"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id={`${listId}-title`} className="text-base font-semibold">
          {clean ? <Trans>Усе заповнено — можна надсилати</Trans> : <Trans>Що ще потрібно</Trans>}
        </h3>
        {/* One live region that stays mounted, so the clean state is announced too. */}
        <p className="sr-only" aria-live="polite" data-testid="resume-completeness-live">
          {clean ? (
            <Trans>Усе заповнено — можна надсилати</Trans>
          ) : (
            <Plural value={issues.length} one="# поле" few="# поля" many="# полів" other="# поля" />
          )}
        </p>
        {!clean && (
          <div className="flex items-center gap-1">
            <Badge variant="secondary" className="tabular-nums" aria-hidden>
              <Plural
                value={issues.length}
                one="# поле"
                few="# поля"
                many="# полів"
                other="# поля"
              />
            </Badge>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-11 sm:h-9 lg:hidden"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? <Trans>Сховати</Trans> : <Trans>Показати</Trans>}
            </Button>
          </div>
        )}
      </div>

      {!clean && (
        <ul
          id={listId}
          aria-label={i18n._(msg`Незаповнені поля`)}
          className={cn(
            'mt-3 space-y-1 lg:block lg:max-h-[60vh] lg:overflow-auto',
            open ? 'block' : 'hidden',
          )}
        >
          {issues.map((issue, i) => {
            const field = issueFieldPath(issue.path)
            return (
              <IssueRow
                key={`${issue.path}:${issue.code}:${i}`}
                label={issueLabel(issue.path)}
                text={i18n._(COMPLETENESS_MESSAGES[issue.code])}
                onFocus={field === null ? null : () => onFocusPath(issue.path)}
              />
            )
          })}
        </ul>
      )}

      <div className="mt-4 space-y-2">
        <Button
          type="button"
          className="h-11 w-full sm:h-9"
          disabled={submitDisabled}
          aria-describedby={clean ? undefined : hintId}
          onClick={onSubmit}
          data-testid="resume-facts-submit"
        >
          {pending === 'submit' && (
            <Loader2 className="mr-2 size-4 animate-spin motion-reduce:animate-none" aria-hidden />
          )}
          <Trans>Надіслати на перевірку</Trans>
        </Button>
        {!clean && (
          <p id={hintId} className="text-xs text-muted-foreground">
            <Trans>Спершу заповніть поля зі списку</Trans>
          </p>
        )}
        <Button
          type="button"
          variant="outline"
          className="h-11 w-full sm:h-9"
          disabled={!canSave || disabled || pending !== null}
          onClick={onSaveDraft}
          data-testid="resume-facts-save"
        >
          {pending === 'save' && (
            <Loader2 className="mr-2 size-4 animate-spin motion-reduce:animate-none" aria-hidden />
          )}
          <Trans context="resume">Зберегти чернетку</Trans>
        </Button>
      </div>
    </section>
  )
}
