import { useState } from 'react'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import type { MessageDescriptor } from '@lingui/core'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type {
  TailoredEligibility,
  TailoredResumeErrorCode,
  TailoredResumeRowDto,
  TailoredRunStage,
} from '@crm/shared'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import type { QueueScopeSignature } from '@/hooks/use-job-queue'
import { getUserFacingErrorMessage } from '@/lib/axios-utils'
import { TailoredResumeEditDialog } from './TailoredResumeEditDialog'
import {
  downloadTailoredPdf,
  renderActive,
  runActive,
  useEditTailored,
  useGenerateTailored,
  useTailoredDetail,
} from './useTailoredResumes'

const REASONS: Record<Exclude<TailoredEligibility, 'READY'>, MessageDescriptor> = {
  NO_VERIFIED_RESUME: msg`Немає перевіреного базового резюме`,
  NON_ENGLISH: msg`Базове резюме не англійською мовою`,
  NON_LATIN_NAME: msg`Ім’я в резюме не латиницею`,
  POSTING_PENDING: msg`Опис вакансії ще завантажується`,
}

const STAGES: Record<TailoredRunStage, MessageDescriptor> = {
  FETCHING_POSTING: msg`Завантажуємо опис вакансії…`,
  ANALYSING: msg`Аналізуємо вакансію…`,
  TAILORING: msg`Адаптуємо резюме…`,
  CHECKING: msg`Перевіряємо факти…`,
  RENDERING: msg`Створюємо PDF…`,
  VISUAL_CHECK: msg`Візуальна перевірка PDF…`,
}

const UNAVAILABLE = msg`Сервіс генерації тимчасово недоступний. Спробуйте пізніше.`

const ERRORS: Record<TailoredResumeErrorCode, MessageDescriptor> = {
  BASE_NOT_VERIFIED: msg`Базове резюме ще не перевірене.`,
  BASE_CHANGED: msg`Базове резюме змінилося під час генерації. Спробуйте ще раз.`,
  NON_ENGLISH: msg`Базове резюме не англійською мовою.`,
  NON_LATIN_NAME: msg`Ім’я в резюме не латиницею.`,
  WRITER_UNAVAILABLE: UNAVAILABLE,
  DECISION_UNAVAILABLE: UNAVAILABLE,
  ENTAILMENT_UNAVAILABLE: UNAVAILABLE,
  VISUAL_CHECK_UNAVAILABLE: UNAVAILABLE,
  LIMITS_EXHAUSTED: msg`Вичерпано ліміт запитів до моделей. Спробуйте пізніше.`,
  COVER_LETTER_UNGROUNDED: msg`Супровідний лист не пройшов перевірку фактів.`,
  RENDER_FAILED: msg`Не вдалося створити PDF.`,
  ATS_CHECK_FAILED: msg`PDF не пройшов перевірку читабельності для ATS.`,
  GLYPH_CHECK_FAILED: msg`PDF містить символи, що не відображаються.`,
  LAYOUT_UNFIXABLE: msg`Резюме не вдалося вмістити в макет.`,
  VISUAL_CHECK_FAILED: msg`PDF не пройшов візуальну перевірку.`,
  STALLED: msg`Генерація зависла й була зупинена. Спробуйте ще раз.`,
  INTERNAL_ERROR: msg`Внутрішня помилка. Спробуйте ще раз.`,
}

const BUTTON = 'min-h-11 sm:min-h-9'

/**
 * The tailored CV + cover letter controls of one senior row (spec §4). `row` comes from the card's
 * batch GET; the per-senior GET adds the cover letter and the editable fields, and polls only while
 * a run or render moves, or while this session waits for one.
 *
 * The PDF downloads once, on a transition this session saw (spec §4 steps 4 and 6): a run seen in
 * progress reaching SUCCEEDED, or the edit's own render reaching READY. A row that mounts already
 * published downloads nothing.
 */
export function TailoredResumeControls({
  scope,
  opportunityId,
  seniorId,
  row,
}: {
  scope: QueueScopeSignature
  opportunityId: string
  seniorId: string
  row: TailoredResumeRowDto
}) {
  const { i18n, t } = useLingui()
  // null: no run awaited; false: the POST answered, its run not seen yet; true: seen in progress
  const [run, setRun] = useState<boolean | null>(null)
  // the PUT's render, awaited until it settles
  const [render, setRender] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const generate = useGenerateTailored(scope, opportunityId, seniorId)
  const edit = useEditTailored(scope, opportunityId, seniorId)
  const download = () => downloadTailoredPdf(scope, opportunityId, seniorId)
  const onFetched = (d: TailoredResumeRowDto) => {
    if (runActive(d)) {
      setRun(true)
      return
    }
    // `false`: this answer predates the POST's run, so it is not that run's outcome
    if (run) {
      setRun(null)
      if (d.runStatus === 'SUCCEEDED' && d.pdfStatus === 'READY') download()
    }
    if (d.pdfRenderId === render && !renderActive(d)) {
      setRender(null)
      if (d.pdfStatus === 'READY') download()
    }
  }
  const detail = useTailoredDetail(scope, opportunityId, seniorId, {
    enabled: row.published || runActive(row) || renderActive(row) || run !== null,
    poll: (d) => run !== null || render !== null || runActive(d) || renderActive(d),
    onFetched,
  })
  const view = detail.data ?? row
  // the published variant's editable fields and letter, once the per-senior GET has them
  const variant =
    detail.data?.editable && detail.data.coverLetter !== null
      ? { editable: detail.data.editable, coverLetter: detail.data.coverLetter }
      : null

  const start = (overwrite: boolean) =>
    generate.mutate(overwrite, { onSuccess: () => setRun(false) })

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text)
    toast.success(t`Лист скопійовано`)
  }

  const eligible = view.eligibility === 'READY'
  const reason = !eligible && (
    <p data-testid={`tailored-reason-${seniorId}`} className="text-xs text-muted-foreground">
      {i18n._(REASONS[view.eligibility as Exclude<TailoredEligibility, 'READY'>])}
    </p>
  )
  const writeError = generate.error ?? edit.error

  let body
  if (runActive(view)) {
    body = (
      <p role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
        {view.runStage === null ? <Trans>У черзі…</Trans> : i18n._(STAGES[view.runStage])}
      </p>
    )
  } else if (!view.published) {
    body = (
      <>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className={BUTTON}
          disabled={!eligible || generate.isPending}
          onClick={() => start(false)}
        >
          <Trans>Згенерувати CV і лист</Trans>
        </Button>
        {reason}
      </>
    )
  } else {
    const rendering = renderActive(view)
    body = (
      <>
        {rendering && (
          <p role="status" className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 aria-hidden="true" className="size-4 shrink-0 motion-safe:animate-spin" />
            <Trans>Оновлюємо PDF…</Trans>
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={BUTTON}
            disabled={view.pdfStatus !== 'READY'}
            onClick={download}
          >
            <Trans>Завантажити CV</Trans>
          </Button>
          {variant && (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={BUTTON}
                onClick={() => void copy(variant.coverLetter)}
              >
                <Trans>Копіювати лист</Trans>
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className={BUTTON}
                disabled={rendering}
                onClick={() => setEditOpen(true)}
              >
                <Trans>Редагувати</Trans>
              </Button>
            </>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={BUTTON}
            disabled={!eligible || generate.isPending}
            onClick={() => setConfirmOpen(true)}
          >
            <Trans>Перегенерувати</Trans>
          </Button>
        </div>
        {reason}
        {view.pdfStatus === 'FAILED' && (
          <p
            data-testid={`tailored-render-failed-${seniorId}`}
            className="text-sm text-destructive"
          >
            <Trans>Не вдалося оновити PDF після редагування. Спробуйте зберегти ще раз.</Trans>
          </p>
        )}
        {view.baseChanged && (
          <p data-testid={`tailored-base-changed-${seniorId}`} className="text-xs text-primary">
            <Trans>Резюме або вакансія змінилися після генерації — перегенерувати?</Trans>
          </p>
        )}
        {variant && (
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              <Trans>Супровідний лист</Trans>
            </summary>
            <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {variant.coverLetter}
            </p>
          </details>
        )}
      </>
    )
  }

  return (
    <div data-testid={`tailored-${seniorId}`} className="flex min-w-0 flex-col items-start gap-2">
      {body}
      {view.runStatus === 'FAILED' && view.runErrorCode !== null && (
        <p data-testid={`tailored-error-${seniorId}`} className="text-sm text-destructive">
          {i18n._(ERRORS[view.runErrorCode])}
        </p>
      )}
      {writeError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {getUserFacingErrorMessage(writeError)}
        </p>
      )}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Перегенерувати CV і лист?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>Це замінить поточне CV і супровідний лист, разом із вашими правками.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={BUTTON}>
              <Trans>Скасувати</Trans>
            </AlertDialogCancel>
            <AlertDialogAction className={BUTTON} onClick={() => start(true)}>
              <Trans>Замінити</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {/* mounted per open: the form starts from the published variant, never an abandoned draft */}
      {editOpen && variant && (
        <TailoredResumeEditDialog
          onClose={() => setEditOpen(false)}
          editable={variant.editable}
          coverLetter={variant.coverLetter}
          saving={edit.isPending}
          onSave={(body) =>
            edit.mutate(body, {
              onSuccess: ({ renderId }) => {
                setEditOpen(false)
                setRender(renderId)
              },
            })
          }
        />
      )}
    </div>
  )
}
