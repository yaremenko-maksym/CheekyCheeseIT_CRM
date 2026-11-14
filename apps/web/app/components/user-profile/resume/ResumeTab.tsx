/**
 * ResumeTab — the senior's canonical resume on their profile card
 * (task-resume-base §3; verified base resume design §3/§4).
 *
 * WHY THIS TAB, ON THIS CARD: the profile card is already the single place
 * where everything about one person lives (finances, projects, contract,
 * requisites), it already carries the exact RBAC surface this feature needs
 * (per-target, not per-role), and it is where HR already goes to look someone
 * up. The tab is registered LAST in the bar so no existing tab shifts position
 * (muscle memory), and only on a SENIOR card — see UsersAccessService.
 *
 * Editing model: HR edits FACTS (`ResumeFactsForm`), never the resume text. The
 * writer turns the facts into the text during the check, and HR confirms the
 * result. An upload or a pasted text only PREFILLS the facts. Unsaved facts are
 * protected by the profile shell's dirty-guard dialog plus one `beforeunload`
 * handler here. A viewer without write access sees the resume text read-only.
 */
import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, FileText, History, Trash2 } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import { EMPTY_RESUME_CONTENT, EMPTY_RESUME_FACTS } from '@crm/shared'
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
import { Skeleton } from '@/components/ui/skeleton'
import {
  resumePdfUrl,
  useDeleteResume,
  useIngestResumeText,
  useResumeSourceUrl,
  useSaveResumeFacts,
  useSaveResumeLayout,
  useSeniorResume,
  useSetResumeTemplate,
  useSubmitResume,
  useUploadResumeSource,
} from '@/hooks/use-senior-resume'
import { PROGRESS_FOCUS_IDS, useFocusAfterRender } from './ResumeConfirmStep'
import { ResumeFactsForm } from './ResumeFactsForm'
import { ResumeIntake } from './ResumeIntake'
import { ResumeLayoutPanel } from './ResumeLayoutPanel'
import { ResumePdfPreview } from './ResumePdfPreview'
import { ResumeReadOnlyView } from './ResumeReadOnlyView'
import { ResumeStatusPanel } from './ResumeStatusPanel'
import { ResumeVerificationPanel, VerificationBadge } from './ResumeVerificationPanel'

export interface ResumeTabProps {
  userId: string
  /** The senior's profile name: the completeness check needs it (R32). */
  displayName: string
  /** Bubbles unsaved-edit state to UserProfileShell's tab-switch guard. */
  onDirtyChange?: (dirty: boolean) => void
}

export function ResumeTab({ userId, displayName, onDirtyChange }: ResumeTabProps) {
  const { t } = useLingui()
  const { data, isLoading, isError } = useSeniorResume(userId)
  const saveFacts = useSaveResumeFacts(userId)
  const submit = useSubmitResume(userId)
  const focusAfterRender = useFocusAfterRender()
  const uploadMutation = useUploadResumeSource(userId)
  const textMutation = useIngestResumeText(userId)
  const deleteMutation = useDeleteResume(userId)
  const layoutMutation = useSaveResumeLayout(userId)
  const templateMutation = useSetResumeTemplate(userId)
  // `resume` is null until the senior has one; `canEdit` sits OUTSIDE it
  // precisely so the empty state still knows whether to offer the upload UI.
  const resume = data?.resume ?? null
  const sourceQuery = useResumeSourceUrl(userId, Boolean(resume?.hasSourceFile))

  const content = resume?.content ?? EMPTY_RESUME_CONTENT
  const canEdit = data?.canEdit ?? false
  const isBusy = uploadMutation.isPending || textMutation.isPending
  // Busy comes ONLY from `verificationBusy` (design §4), never from the status.
  // While it is set, the facts are locked, so erase and re-upload are locked too.
  const verificationBusy = resume?.verificationBusy === true

  const [isDirty, setIsDirty] = useState(false)
  const [showIntake, setShowIntake] = useState(false)
  /** Set when the user chooses to type the facts instead of uploading a resume. */
  const [manualMode, setManualMode] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  /** "Back" from the empty manual form with typed facts: confirm before dropping them. */
  const [confirmBack, setConfirmBack] = useState(false)
  /** Set on the way back from the manual form, so focus lands on "Заповнити вручну", not <body>. */
  const [backFromManual, setBackFromManual] = useState(false)
  const leaveManual = () => {
    setBackFromManual(true)
    setManualMode(false)
  }
  /**
   * The staged run whose facts the user reopened from the confirm step. Keyed by
   * `runId`, so a new run (or a confirm) closes the form again on its own.
   */
  const [changingFactsFor, setChangingFactsFor] = useState<string | null>(null)

  useEffect(() => {
    onDirtyChange?.(isDirty)
    return () => onDirtyChange?.(false)
  }, [isDirty, onDirtyChange])
  // The form's flag goes to the profile guard in the same commit, not after a
  // re-render of this tab: a tab click right after an edit must still be guarded.
  const handleFactsDirty = useCallback(
    (dirty: boolean) => {
      setIsDirty(dirty)
      onDirtyChange?.(dirty)
    },
    [onDirtyChange],
  )

  /** ONE `beforeunload` handler for the whole tab. */
  useEffect(() => {
    if (!isDirty) return undefined
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      // Chrome requires returnValue to be set for the native prompt to show.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isDirty])

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="resume-tab-loading">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (isError) {
    return (
      <p className="rounded-lg border bg-muted/30 px-6 py-10 text-center text-sm text-muted-foreground">
        <Trans>Не вдалося відкрити резюме. Оновіть сторінку.</Trans>
      </p>
    )
  }

  const hasContent =
    resume !== null &&
    (content.summary.trim() !== '' ||
      content.skills.length > 0 ||
      content.experience.length > 0 ||
      content.education.length > 0 ||
      content.languages.length > 0 ||
      content.links.length > 0)

  /**
   * The stored original + its erase control.
   *
   * Rendered wherever a row exists, including the read-only "not filled in"
   * screen: an extraction that produces nothing usable still leaves a file in
   * storage, and a right-to-erasure control has to be reachable from there.
   */
  const sourceAndDangerActions =
    resume && (resume.hasSourceFile || canEdit) ? (
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
        {resume.hasSourceFile && sourceQuery.data?.url && (
          <Button asChild variant="outline" className="min-h-11">
            <a
              href={sourceQuery.data.url}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="resume-download-source"
            >
              <FileText className="mr-2 h-4 w-4" aria-hidden />
              <Trans>Вихідний файл</Trans>
            </a>
          </Button>
        )}
        {canEdit && (
          <Button
            variant="outline"
            onClick={() => setConfirmDelete(true)}
            disabled={verificationBusy}
            data-testid="resume-delete"
            className="min-h-11 text-destructive hover:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" aria-hidden />
            <Trans>Видалити</Trans>
          </Button>
        )}
      </div>
    ) : null

  const deleteDialog = (
    <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <AlertDialogContent data-testid="resume-delete-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>
            <Trans>Видалити резюме?</Trans>
          </AlertDialogTitle>
          <AlertDialogDescription>
            {resume?.sourceFileName ? (
              <Trans>
                Буде видалено заповнені розділи та завантажений вихідний файл («
                {resume.sourceFileName}»). Відновити їх не можна — резюме доведеться завантажити або
                заповнити заново.
              </Trans>
            ) : (
              <Trans>
                Буде видалено заповнені розділи та завантажений вихідний файл. Відновити їх не можна
                — резюме доведеться завантажити або заповнити заново.
              </Trans>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="resume-delete-cancel">
            <Trans>Скасувати</Trans>
          </AlertDialogCancel>
          <AlertDialogAction
            data-testid="resume-delete-confirm"
            disabled={deleteMutation.isPending}
            onClick={() => {
              setConfirmDelete(false)
              setManualMode(false)
              deleteMutation.mutate()
            }}
          >
            {deleteMutation.isPending ? t`Видаляємо…` : t`Видалити`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  // No resume yet: the two-choice empty state. "Fill in by hand" opens an empty facts form.
  if (resume === null && !(canEdit && manualMode)) {
    return (
      <div className="space-y-4" data-testid="resume-tab">
        {canEdit ? (
          <ResumeIntake
            onUploadFile={(file) => uploadMutation.mutate(file)}
            onSubmitText={(text) => textMutation.mutate(text)}
            onFillManually={() => setManualMode(true)}
            focusFillManually={backFromManual}
            isBusy={isBusy}
          />
        ) : (
          <EmptyReadOnly />
        )}
      </div>
    )
  }

  if (!canEdit && !hasContent) {
    return (
      <div className="space-y-4" data-testid="resume-tab">
        {sourceAndDangerActions}
        <EmptyReadOnly />
      </div>
    )
  }

  const isDraft = resume?.verificationStatus === 'DRAFT'
  const staged = resume?.staged ?? null
  const changingFacts = staged !== null && changingFactsFor === staged.runId

  return (
    <div className="space-y-4 pb-4" data-testid="resume-tab">
      {/* No resume yet and the form was chosen by hand: the way back to the upload choice. */}
      {resume === null && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 sm:h-9"
            onClick={() => (isDirty ? setConfirmBack(true) : leaveManual())}
            data-testid="resume-manual-back"
          >
            <ArrowLeft className="mr-2 size-4" aria-hidden />
            <Trans>Назад</Trans>
          </Button>
          <AlertDialog open={confirmBack} onOpenChange={setConfirmBack}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  <Trans>Незбережені зміни</Trans>
                </AlertDialogTitle>
                <AlertDialogDescription>
                  <Trans>Є незбережені зміни — якщо перейти, їх буде втрачено</Trans>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  <Trans>Залишитися</Trans>
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => {
                    setConfirmBack(false)
                    leaveManual()
                  }}
                >
                  <Trans>Покинути</Trans>
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
      {/* Extraction banner: progress or an actionable failure. Never blocks the form. */}
      {resume && (
        <ResumeStatusPanel
          status={resume.status}
          errorCode={resume.errorCode}
          errorMessage={resume.errorMessage}
          quotaResetsAt={resume.quotaResetsAt}
          canEdit={canEdit}
          onRetry={() => setShowIntake(true)}
        />
      )}

      {/* Toolbar. Below lg the actions take their own row (design §9; QA-3: Delete overflowed at 768). */}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 space-y-1">
          {resume && (
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <VerificationBadge resume={resume} />
              {/* `max-w-full` keeps the line inside the bar; it wraps, never truncates (QA-11). */}
              <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
                <History className="h-3.5 w-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 break-words">
                  {resume.updatedByName ? (
                    <Trans>
                      Версія {resume.version} · останній редактор: {resume.updatedByName}
                    </Trans>
                  ) : (
                    <Trans>Версія {resume.version}</Trans>
                  )}
                </span>
              </span>
            </div>
          )}
          {isDraft && resume?.verifiedVersion !== null && resume?.verifiedVersion !== undefined && (
            <p className="text-sm">
              <Trans>Факти змінено. Надішліть резюме на перевірку знову.</Trans>
            </p>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
          {/* Source download + erase: the SAME fragment the empty state renders. */}
          {sourceAndDangerActions}
        </div>
      </div>

      {deleteDialog}

      {canEdit && (showIntake || resume?.status === 'FAILED') && (
        <ResumeIntake
          variant="compact"
          onUploadFile={(file) => {
            setShowIntake(false)
            uploadMutation.mutate(file)
          }}
          onSubmitText={(text) => {
            setShowIntake(false)
            textMutation.mutate(text)
          }}
          isBusy={isBusy || verificationBusy}
        />
      )}

      {/* Progress, the confirm step and the failure panel (design §4/§5). */}
      {canEdit && resume && (
        <ResumeVerificationPanel
          userId={userId}
          resume={resume}
          canConfirm={data?.canConfirm ?? false}
          changingFacts={changingFacts}
          onChangeFacts={() =>
            setChangingFactsFor(changingFacts || staged === null ? null : staged.runId)
          }
        />
      )}

      {canEdit && changingFacts && isDirty && (
        <p className="text-sm text-amber-700 dark:text-amber-400" role="status">
          <Trans>Зміна фактів скасує цей результат.</Trans>
        </p>
      )}

      {/* With a staged result the confirm step replaces the form until the user
          chooses "Change the facts". Ruling R56: collapsed, the form is hidden,
          not unmounted, so a draft survives collapse and reopen. */}
      {canEdit ? (
        <div hidden={staged !== null && !changingFacts}>
          <ResumeFactsForm
            facts={resume?.facts ?? EMPTY_RESUME_FACTS}
            displayName={displayName}
            disabled={verificationBusy}
            onSave={(facts, { silent }) => saveFacts.mutateAsync({ facts, silent })}
            onSubmit={async () => {
              const answer = await submit.mutateAsync()
              // The completeness panel with the Submit button unmounts while a check runs (design §8).
              if (!answer.resume?.verificationBusy) return false
              focusAfterRender(PROGRESS_FOCUS_IDS)
              return true
            }}
            onDirtyChange={handleFactsDirty}
          />
        </div>
      ) : (
        <ResumeReadOnlyView content={content} />
      )}

      {/* ── Layout + the finished document ───────────────────────────────── */}

      {resume && (
        <ResumeLayoutPanel
          layout={resume.layout}
          canEdit={canEdit}
          isSaving={layoutMutation.isPending}
          isSavingTemplate={templateMutation.isPending}
          onSave={(layout) => layoutMutation.mutate(layout)}
          templateName={resume.templateName}
          hasCustomTemplate={resume.hasCustomTemplate}
          verified={resume.verificationStatus === 'VERIFIED'}
          busy={verificationBusy}
          staged={resume.staged !== null}
          onTemplateChange={(name) => templateMutation.mutate(name)}
        />
      )}

      {/* Only once there is something to typeset: an empty resume renders a page
          with a name on it — a download that wastes a click and looks broken. */}
      {resume && hasContent && <ResumePdfPreview resume={resume} pdfUrl={resumePdfUrl(userId)} />}
    </div>
  )
}

function EmptyReadOnly() {
  return (
    <p
      className="rounded-lg border bg-muted/30 px-6 py-10 text-center text-sm text-muted-foreground"
      data-testid="resume-empty-readonly"
    >
      <Trans>Резюме ще не заповнено.</Trans>
    </p>
  )
}
