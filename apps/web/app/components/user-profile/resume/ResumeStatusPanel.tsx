/**
 * Extraction-state panel (task-resume-base §3, AC3/AC5).
 *
 * Two hard requirements from the task drive this component:
 *   - while recognition runs the user sees NAMED progress, not a bare spinner,
 *     and the rest of the screen stays usable (they can leave and come back —
 *     the state lives on the server and the tab polls it),
 *   - a failure says WHAT happened and WHAT to do next. "Что-то пошло не так"
 *     is explicitly called out as unacceptable, especially for the daily-quota
 *     case, which must name the reset time and still leave manual editing open.
 */
import { AlertTriangle, Loader2 } from 'lucide-react'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { MessageDescriptor } from '@lingui/core'
import type { ResumeFailureCode, ResumeExtractionStatus, Locale } from '@crm/shared'
import { formatDate } from '@crm/shared'
import { Button } from '@/components/ui/button'
import { useLocale } from '@/lib/i18n'

const DEFAULT_FAILURE_HINT = msg`Заповніть розділи вручну або спробуйте завантажити файл ще раз.`

interface ResumeStatusPanelProps {
  status: ResumeExtractionStatus
  errorCode: ResumeFailureCode | null
  errorMessage: string | null
  quotaResetsAt: string | null
  canEdit: boolean
  onRetry: () => void
}

const RUNNING_COPY: Record<
  'QUEUED' | 'RUNNING',
  { title: MessageDescriptor; hint: MessageDescriptor }
> = {
  QUEUED: {
    title: msg`Резюме в черзі на розпізнавання`,
    hint: msg`Вкладку можна закрити — розпізнавання триває на сервері, результат з’явиться тут.`,
  },
  RUNNING: {
    title: msg`Розпізнаємо резюме`,
    hint: msg`Зазвичай займає кілька секунд. Сторінка оновиться сама.`,
  },
} satisfies Record<'QUEUED' | 'RUNNING', { title: MessageDescriptor; hint: MessageDescriptor }>

/** Actionable next step per failure reason — never a generic apology. */
const FAILURE_HINTS: Record<ResumeFailureCode, MessageDescriptor> = {
  NO_TEXT: msg`Схоже, у файлі немає текстового шару (скан або картинка). Вставте текст резюме — розпізнавання спрацює так само.`,
  UNREADABLE_FILE: msg`Файл не вдалося прочитати. Завантажте інший PDF/DOCX або вставте текст.`,
  MODEL_INVALID_JSON: msg`Не вдалося автоматично розібрати це резюме. Заповніть розділи вручну — форма нижче повністю робоча.`,
  // task-i18n-stage3b-pr3 (Step 4): the quota-reset time is appended by the
  // caller (`failureHint` below) via `<Trans>Ліміт оновиться {when}</Trans>`
  // — no time here, that half is the `else` branch of `failureHint`.
  QUOTA_EXCEEDED: msg`Добовий ліміт автоматичного розпізнавання вичерпано. Заповніть резюме вручну — форма нижче працює.`,
  // The server message already says "не налаштовано" — this line must ADD
  // something, not restate it: what the user gets if they type it in.
  AI_NOT_CONFIGURED: msg`Заповнене вручну резюме нічим не відрізняється: ті самі розділи, той самий експорт у PDF.`,
  // Any other model/transport failure — same fallback the original switch's
  // `default:` branch gave this code (no dedicated case before this wave).
  MODEL_ERROR: DEFAULT_FAILURE_HINT,
  STALLED: msg`Розпізнавання перервалося на боці сервера. Завантажте файл ще раз або заповніть резюме вручну.`,
} satisfies Record<ResumeFailureCode, MessageDescriptor>

// COPY-M-5 (copy-review PR #720 round A): an unparseable reset time used to
// fall back to a vague "soon" spliced into `{when}` — which, combined with
// the en translation's added "on" (COPY-M-5), rendered as the broken
// "resets on soon". Returning `null` instead lets the caller fall through
// to `FAILURE_HINTS[QUOTA_EXCEEDED]`, which makes no time claim at all.
export function formatResetTime(iso: string, locale: Locale): string | null {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  return formatDate(at, locale, 'dateTime')
}

export function ResumeStatusPanel({
  status,
  errorCode,
  errorMessage,
  quotaResetsAt,
  canEdit,
  onRetry,
}: ResumeStatusPanelProps) {
  const { i18n } = useLingui()
  const locale = useLocale()

  if (status === 'QUEUED' || status === 'RUNNING') {
    const copy = RUNNING_COPY[status]
    return (
      <div
        className="flex flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 sm:flex-row sm:items-center"
        data-testid="resume-progress"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="h-5 w-5 shrink-0 animate-spin text-primary" aria-hidden />
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{i18n._(copy.title)}</p>
          <p className="text-xs text-muted-foreground">{i18n._(copy.hint)}</p>
        </div>
      </div>
    )
  }

  if (status !== 'FAILED') return null

  const when = quotaResetsAt ? formatResetTime(quotaResetsAt, locale) : undefined

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 sm:flex-row sm:items-start"
      data-testid="resume-failed"
      role="status"
      aria-live="polite"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">
          <Trans>Резюме не розпізнано автоматично</Trans>
        </p>
        {/* Server copy is plain text; React escapes it. Never dangerouslySetInnerHTML. */}
        {errorMessage && <p className="text-xs text-muted-foreground">{errorMessage}</p>}
        <p className="text-xs text-muted-foreground">
          {errorCode === 'QUOTA_EXCEEDED' && when ? (
            <Trans>
              Добовий ліміт автоматичного розпізнавання вичерпано. Ліміт оновиться {when} — до того
              часу заповніть резюме вручну, форма нижче працює.
            </Trans>
          ) : (
            i18n._((errorCode && FAILURE_HINTS[errorCode]) || DEFAULT_FAILURE_HINT)
          )}
        </p>
      </div>
      {canEdit && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          // min-h-11: every other actionable control in this feature is
          // ≥44px on mobile (foundation.md §10) — `size="sm"` alone renders
          // at 32px, the one control here that missed it.
          className="min-h-11 shrink-0"
          data-testid="resume-retry-upload"
        >
          <Trans>Завантажити ще раз</Trans>
        </Button>
      )}
    </div>
  )
}
