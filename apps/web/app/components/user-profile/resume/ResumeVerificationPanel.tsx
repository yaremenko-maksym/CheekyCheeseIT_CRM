/**
 * The verification half of the resume tab (verified base resume design §4):
 * which of progress / confirm step / failure panel / warning a DTO state shows.
 *
 * Busy is ONLY `verificationBusy` (never inferred from the report or the
 * status). A run with `staged !== null` (a staged edit or regenerate) keeps the
 * confirm step on screen read-only instead of the progress card. A busy
 * VERIFIED row is a template / formatting run: the DTO has no run-kind field,
 * so `isTemplateRun = verificationStatus === 'VERIFIED' && verificationBusy`.
 */
import { useState, type ReactNode } from 'react'
import { Check, Loader2, Lock } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import type {
  ResumeVerificationErrorCode,
  ResumeVerificationStatus,
  SeniorResumeDto,
} from '@crm/shared'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useSubmitResume } from '@/hooks/use-senior-resume'
import { cn } from '@/lib/utils'
import { focusFactsField } from './ResumeCompletenessPanel'
import {
  BUSY_LOCK_ID,
  CheckingBadge,
  PROGRESS_FOCUS_IDS,
  ProgressBar,
  ResumeConfirmStep,
  TEMPLATE_RUN_STATUS_ID,
  useFocusAfterRender,
} from './ResumeConfirmStep'
import { templateTileId } from './ResumeTemplatePicker'
import { ResumeVerificationFailure, VERIFICATION_CODES } from './ResumeVerificationFailure'

export interface ResumeVerificationPanelProps {
  userId: string
  resume: SeniorResumeDto
  canConfirm: boolean
  /** The facts form is open below the confirm step. */
  changingFacts?: boolean
  onChangeFacts: () => void
  /** The facts form has unsaved changes: Retry would check the saved facts, so it waits for Save (FR-W-1). */
  isDirty?: boolean
}

export function ResumeVerificationPanel({
  userId,
  resume,
  canConfirm,
  changingFacts = false,
  onChangeFacts,
  isDirty = false,
}: ResumeVerificationPanelProps) {
  const submit = useSubmitResume(userId)
  const { verificationStatus: status, verificationBusy: busy, staged } = resume
  const code = resume.verificationErrorCode
  const isTemplateRun = status === 'VERIFIED' && busy
  const focusAfterRender = useFocusAfterRender()
  // The 409 "resume changed" notice (design §8); a new run starting clears it.
  const [stale, setStale] = useState<string | null>(null)
  if (busy && stale !== null) setStale(null)
  const showStale = (message: string | null) => {
    setStale(message)
    if (message !== null) focusAfterRender([STALE_NOTICE_ID])
  }
  const retry = () => {
    setStale(null)
    void submit.mutateAsync().then(
      (data) => {
        if (data.resume?.verificationBusy) focusAfterRender(PROGRESS_FOCUS_IDS)
      },
      () => {},
    )
  }
  // The picker's current tile (the first one under a personal template), as Radix focuses it.
  const chooseTemplate = () => {
    const tile = templateTileId(resume.hasCustomTemplate ? 'classic' : resume.templateName)
    document.getElementById(tile)?.scrollIntoView?.({ block: 'center' })
    focusAfterRender([tile])
  }

  return (
    <div className="space-y-4 empty:hidden" data-testid="resume-verification-panel">
      {stale !== null && (
        <p
          id={STALE_NOTICE_ID}
          tabIndex={-1}
          className="text-sm text-amber-700 dark:text-amber-400"
          data-testid="resume-verification-stale"
        >
          {stale}
        </p>
      )}

      {busy && staged === null && (
        <ResumeVerificationProgress status={status} isTemplateRun={isTemplateRun} />
      )}

      {staged !== null && (
        <ResumeConfirmStep
          userId={userId}
          resume={resume}
          staged={staged}
          canConfirm={canConfirm}
          changingFacts={changingFacts}
          onChangeFacts={onChangeFacts}
          onStale={showStale}
          onConfirmed={() => focusAfterRender([VERIFICATION_STATUS_ID])}
        />
      )}

      {status === 'AWAITING_CONFIRM' &&
        staged !== null &&
        !busy &&
        code !== null &&
        KEPT_ON.has(code) && (
          <KeptResultNotice code={code} onRetry={retry} disabled={submit.isPending || isDirty} />
        )}

      {/* Should not happen (staged comes with a staged PDF), but never a dead end. */}
      {status === 'AWAITING_CONFIRM' && staged === null && !busy && (
        <Button
          type="button"
          className="h-11 sm:h-9"
          disabled={submit.isPending || isDirty}
          onClick={retry}
        >
          <Trans>Перевірити ще раз</Trans>
        </Button>
      )}

      {code !== null && !busy && (status === 'FAILED' || status === 'VERIFIED') && (
        <ResumeVerificationFailure
          code={code}
          report={resume.verificationReport}
          variant={status === 'FAILED' ? 'failed' : 'warning'}
          onFocusField={focusFactsField}
          onRetry={retry}
          onChooseTemplate={chooseTemplate}
          disabled={submit.isPending}
          retryDisabled={isDirty}
        />
      )}
    </div>
  )
}

const STALE_NOTICE_ID = 'resume-verification-stale'

/** The codes a staged run ends on with the previous result kept (FR-A-2): a check was unavailable. */
const KEPT_ON: ReadonlySet<ResumeVerificationErrorCode> = new Set([
  'VISUAL_CHECK_UNAVAILABLE',
  'WRITER_UNAVAILABLE',
  'ENTAILMENT_UNAVAILABLE',
  'STALLED',
])

/** One line beside the kept result: which check was unavailable, that nothing was lost, Retry. */
function KeptResultNotice({
  code,
  onRetry,
  disabled,
}: {
  code: ResumeVerificationErrorCode
  onRetry: () => void
  disabled: boolean
}) {
  const { i18n } = useLingui()
  const title = i18n._(VERIFICATION_CODES[code].title)
  return (
    <p
      role="status"
      className="flex flex-wrap items-center gap-2 text-sm text-amber-700 dark:text-amber-400"
      data-testid="resume-verification-kept"
    >
      <span>
        <Trans>{title}. Попередній результат збережено.</Trans>
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-11 sm:h-9"
        disabled={disabled}
        onClick={onRetry}
      >
        <Trans>Перевірити ще раз</Trans>
      </Button>
    </p>
  )
}
/** The toolbar badge wrapper: where focus lands after Confirm (design §8). */
export const VERIFICATION_STATUS_ID = 'resume-verification-status'

export interface ResumeVerificationProgressProps {
  status: ResumeVerificationStatus
  /** `verificationStatus === 'VERIFIED' && verificationBusy`: a template / formatting run. */
  isTemplateRun: boolean
}

/** Queued vs Checking only (R43): the DTO has no stage field, so the five steps are not ticked. */
export function ResumeVerificationProgress({
  status,
  isTemplateRun,
}: ResumeVerificationProgressProps) {
  if (isTemplateRun) {
    return (
      <div
        role="status"
        id={TEMPLATE_RUN_STATUS_ID}
        tabIndex={-1}
        className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="resume-verification-template-run"
      >
        <CheckingBadge>
          <Trans>Перевіряємо нове оформлення</Trans>
        </CheckingBadge>
        <Trans>Резюме лишається перевіреним, поки триває перевірка.</Trans>
      </div>
    )
  }

  const queued = status === 'QUEUED'
  return (
    <div className="space-y-3">
      <Card
        role="status"
        aria-live="polite"
        className="space-y-4 p-4"
        data-testid="resume-verification-progress"
      >
        <div className="flex flex-wrap items-center gap-2">
          <Loader2
            className="size-5 animate-spin text-primary motion-reduce:animate-none"
            aria-hidden
          />
          <h3
            tabIndex={-1}
            className="text-base font-semibold"
            id="resume-verification-progress-title"
          >
            {queued ? <Trans>У черзі на перевірку</Trans> : <Trans>Перевіряємо резюме</Trans>}
          </h3>
          <CheckingBadge />
        </div>
        <ProgressBar />
        <ol className="space-y-2 text-sm">
          <Stage state={queued ? 'current' : 'done'}>
            <Trans>У черзі</Trans>
          </Stage>
          <Stage state={queued ? 'pending' : 'current'}>
            <Trans>Перевірка</Trans>
            <span className="block text-xs text-muted-foreground">
              <Trans>
                Пишемо текст · Звіряємо з фактами · Збираємо PDF · ATS-перевірка · Візуальна
                перевірка
              </Trans>
            </span>
          </Stage>
          <Stage state="pending">
            <Trans>Підтвердження HR</Trans>
          </Stage>
        </ol>
        <p className="text-xs text-muted-foreground">
          <Trans>Вкладку можна закрити: перевірка йде на сервері, результат буде тут.</Trans>
        </p>
      </Card>
      <p
        id={BUSY_LOCK_ID}
        tabIndex={-1}
        className="flex items-center gap-2 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="resume-verification-busy-lock"
      >
        <Lock className="size-4 shrink-0" aria-hidden />
        <Trans>Поки триває перевірка, редагування недоступне.</Trans>
      </p>
    </div>
  )
}

function Stage({
  state,
  children,
}: {
  state: 'done' | 'current' | 'pending'
  children: ReactNode
}) {
  return (
    <li
      aria-current={state === 'current' ? 'step' : undefined}
      className={cn('flex items-start gap-2', state === 'pending' && 'text-muted-foreground')}
    >
      {/* progress-*.png: done = check, current = primary ring, pending = empty outline. */}
      <span
        aria-hidden
        className={cn(
          'flex size-5 shrink-0 items-center justify-center rounded-full',
          state === 'done' && 'bg-secondary text-foreground',
          state === 'current' && 'border-2 border-primary',
          state === 'pending' && 'border border-border',
        )}
      >
        {state === 'done' && <Check className="size-3.5" />}
      </span>
      <span className={cn('min-w-0', state === 'current' && 'font-medium')}>
        <span className="sr-only">
          {state === 'done' ? (
            <Trans>готово</Trans>
          ) : state === 'current' ? (
            <Trans>триває</Trans>
          ) : (
            <Trans>очікує</Trans>
          )}
          {': '}
        </span>
        {children}
      </span>
    </li>
  )
}

/** The status badge for the tab toolbar (design §4 "Bar badge"), plus the verified meta line. */
export function VerificationBadge({ resume }: { resume: SeniorResumeDto }) {
  const { i18n } = useLingui()
  switch (resume.verificationStatus) {
    case 'DRAFT':
      return (
        <Badge variant="outline" data-testid="resume-verification-badge">
          <Trans>Чернетка</Trans>
        </Badge>
      )
    case 'QUEUED':
    case 'CHECKING':
      return <CheckingBadge />
    case 'AWAITING_CONFIRM':
      return (
        <Badge
          className="border-transparent bg-yellow-subtle text-primary"
          data-testid="resume-verification-badge"
        >
          <Trans>Чекає підтвердження</Trans>
        </Badge>
      )
    case 'FAILED':
      return (
        <Badge
          variant="outline"
          className="border-amber-500/40 bg-amber-500/10 text-amber-300"
          data-testid="resume-verification-badge"
        >
          <Trans>Не пройшло перевірку</Trans>
        </Badge>
      )
    case 'VERIFIED': {
      const date = resume.verifiedAt ? i18n.date(resume.verifiedAt, { dateStyle: 'medium' }) : null
      const name = resume.verifiedByName
      return (
        <span
          id={VERIFICATION_STATUS_ID}
          tabIndex={-1}
          className="inline-flex min-w-0 flex-wrap items-center gap-2"
          data-testid="resume-verification-status"
        >
          <Badge
            variant="outline"
            className="border-emerald-500/30 bg-emerald-500/15 text-emerald-300"
            data-testid="resume-verification-badge"
          >
            <Trans>Перевірено</Trans>
          </Badge>
          {date && (
            <span className="tabular-nums" data-testid="resume-verified-meta">
              {name ? (
                <Trans>
                  Перевірено {date} · {name}
                </Trans>
              ) : (
                <Trans>Перевірено {date}</Trans>
              )}
            </span>
          )}
        </span>
      )
    }
  }
}
