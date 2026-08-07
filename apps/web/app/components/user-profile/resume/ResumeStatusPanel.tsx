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
import type { ResumeFailureCode, ResumeExtractionStatus } from '@crm/shared'
import { Button } from '@/components/ui/button'

interface ResumeStatusPanelProps {
  status: ResumeExtractionStatus
  errorCode: ResumeFailureCode | null
  errorMessage: string | null
  quotaResetsAt: string | null
  canEdit: boolean
  onRetry: () => void
}

const RUNNING_COPY: Record<'QUEUED' | 'RUNNING', { title: string; hint: string }> = {
  QUEUED: {
    title: 'Резюме в очереди на распознавание',
    hint: 'Можно закрыть вкладку — распознавание идёт на сервере, результат появится здесь.',
  },
  RUNNING: {
    title: 'Распознаём резюме',
    hint: 'Обычно занимает несколько секунд. Страница обновится сама.',
  },
}

/** Actionable next step per failure reason — never a generic apology. */
function failureHint(code: ResumeFailureCode | null, quotaResetsAt: string | null): string {
  switch (code) {
    case 'NO_TEXT':
      return 'Похоже, в файле нет текстового слоя (скан или картинка). Вставьте текст резюме — распознавание сработает так же.'
    case 'UNREADABLE_FILE':
      return 'Файл не удалось прочитать. Загрузите другой PDF/DOCX или вставьте текст.'
    case 'MODEL_INVALID_JSON':
      return 'Модель не смогла разобрать это резюме. Заполните разделы вручную — форма ниже полностью рабочая.'
    case 'QUOTA_EXCEEDED':
      return quotaResetsAt
        ? `Суточный лимит бесплатных запросов исчерпан. Лимит обнулится ${formatResetTime(quotaResetsAt)} — до этого заполните резюме вручную, форма ниже работает.`
        : 'Суточный лимит бесплатных запросов исчерпан. Заполните резюме вручную — форма ниже работает.'
    case 'AI_NOT_CONFIGURED':
      return 'Автоматическое распознавание пока не подключено. Заполните разделы вручную.'
    case 'STALLED':
      return 'Распознавание прервалось на стороне сервера. Загрузите файл ещё раз или заполните резюме вручную.'
    default:
      return 'Заполните разделы вручную или попробуйте загрузить файл ещё раз.'
  }
}

export function formatResetTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'в ближайшее время'
  return at.toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function ResumeStatusPanel({
  status,
  errorCode,
  errorMessage,
  quotaResetsAt,
  canEdit,
  onRetry,
}: ResumeStatusPanelProps) {
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
          <p className="text-sm font-medium">{copy.title}</p>
          <p className="text-xs text-muted-foreground">{copy.hint}</p>
        </div>
      </div>
    )
  }

  if (status !== 'FAILED') return null

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 sm:flex-row sm:items-start"
      data-testid="resume-failed"
      role="status"
      aria-live="polite"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">Резюме не распознано автоматически</p>
        {/* Server copy is plain text; React escapes it. Never dangerouslySetInnerHTML. */}
        {errorMessage && <p className="text-xs text-muted-foreground">{errorMessage}</p>}
        <p className="text-xs text-muted-foreground">{failureHint(errorCode, quotaResetsAt)}</p>
      </div>
      {canEdit && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRetry}
          className="shrink-0"
          data-testid="resume-retry-upload"
        >
          Загрузить заново
        </Button>
      )}
    </div>
  )
}
