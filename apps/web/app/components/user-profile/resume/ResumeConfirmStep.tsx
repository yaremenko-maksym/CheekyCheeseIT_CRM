/**
 * The confirm step (verified base resume design §5.4): the text the check run
 * wrote, next to the facts it came from, and the staged PDF. HR/ADMIN confirm
 * it; anyone who can edit may rewrite or regenerate one block, which starts a
 * staged run. While that run is in flight the step stays on screen read-only.
 *
 * Every action sends `staged.runId`; a stale one answers 409 and the hook
 * refetches, so the step always shows the server's current result.
 */
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Check, Download, Pencil, RefreshCw, TriangleAlert } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  mergeSkills,
  type ResumeTemplateName,
  type SeniorResumeDto,
  type SeniorResumeResponse,
} from '@crm/shared'
import { PdfPreview } from '@/components/documents/pdf-preview'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import {
  API_BASE_URL,
  useConfirmResume,
  useEditStagedField,
  useRegenerateStagedField,
  useResumePdfBlob,
} from '@/hooks/use-senior-resume'
import { getApiErrorCode, getUserFacingErrorMessage } from '@/lib/axios-utils'
import { cn } from '@/lib/utils'
import { useTemplateLabel } from './ResumeTemplatePicker'

type Staged = NonNullable<SeniorResumeDto['staged']>

/** Focus targets after an action (design §8): the progress heading, else the busy confirm line. */
export const PROGRESS_FOCUS_IDS = [
  'resume-verification-progress-title',
  'resume-confirm-checking',
] as const

/** A focus request older than this is dropped: its target was never going to render. */
export const FOCUS_REQUEST_TTL_MS = 1000

/**
 * Focus the first of the requested ids that exists after a render (design §8).
 * The target appears only once the action's response is rendered, so the
 * request waits for it instead of guessing a frame, but only for
 * FOCUS_REQUEST_TTL_MS: a later run's heading must never take focus out of the blue.
 */
export function useFocusAfterRender() {
  const [ids, setIds] = useState<readonly string[] | null>(null)
  useEffect(() => {
    if (ids === null) return
    const target = ids.map((id) => document.getElementById(id)).find((el) => el !== null)
    // A disabled button cannot take focus yet: wait for the render that enables it.
    if (!target || target.matches(':disabled')) return
    target.focus()
    setIds(null)
  })
  useEffect(() => {
    if (ids === null) return
    const timer = setTimeout(() => setIds(null), FOCUS_REQUEST_TTL_MS)
    return () => clearTimeout(timer)
  }, [ids])
  return setIds
}

/** Badge "Checking" (design §7). */
export function CheckingBadge({ children }: { children?: ReactNode }) {
  return (
    <Badge variant="outline" className="border-primary/30 text-primary">
      {children ?? <Trans>Перевіряється</Trans>}
    </Badge>
  )
}

/** Indeterminate progress: the DTO has no percentage. Static under reduced motion. */
export function ProgressBar() {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-secondary" aria-hidden>
      <div className="h-full w-full animate-pulse bg-primary motion-reduce:animate-none motion-reduce:opacity-40" />
    </div>
  )
}

export interface ResumeConfirmStepProps {
  userId: string
  resume: SeniorResumeDto
  staged: Staged
  canConfirm: boolean
  /** The facts form is open below the step. */
  changingFacts: boolean
  onChangeFacts: () => void
  /** A 409 "resume changed" message to show and focus; `null` when a new action starts. */
  onStale: (message: string | null) => void
  onConfirmed: () => void
}

export function ResumeConfirmStep({
  userId,
  resume,
  staged,
  canConfirm,
  changingFacts,
  onChangeFacts,
  onStale,
  onConfirmed,
}: ResumeConfirmStepProps) {
  const { t } = useLingui()
  const confirm = useConfirmResume(userId)
  const edit = useEditStagedField(userId)
  const regenerate = useRegenerateStagedField(userId)
  const busy = resume.verificationBusy
  const locked = busy || confirm.isPending || edit.isPending || regenerate.isPending
  const runId = staged.runId
  // Keyed by run: a new run closes the open inline edit, whose path may be gone.
  const [editingAt, setEditingAt] = useState<{ runId: string; path: string } | null>(null)
  const editing = editingAt?.runId === runId ? editingAt.path : null
  const setEditing = (path: string | null) => setEditingAt(path === null ? null : { runId, path })
  // Ruling R55: a staged write starts a new run and would discard the facts being changed.
  const blockLocked = locked || editing !== null || changingFacts
  const focusAfterRender = useFocusAfterRender()

  const editedPaths = staged.editedPaths.map((p) => p.path)
  const edited = new Set(editedPaths)
  const fallbacks = resume.verificationReport?.fallbacks ?? []
  const editError =
    getApiErrorCode(edit.error) === 'RESUME_STAGED_TEXT_INVALID'
      ? getUserFacingErrorMessage(edit.error)
      : null

  // Errors are toasted by the hooks; here only the stale run gets its focused notice.
  const act = <T,>(request: Promise<T>, then?: (data: T) => void) => {
    onStale(null)
    void request.then(then, (e: unknown) => {
      if (getApiErrorCode(e) === 'RESUME_CONFIRM_STALE') onStale(getUserFacingErrorMessage(e))
    })
  }

  const openEdit = (path: string) => {
    edit.reset()
    setEditing(path)
  }
  const closeEdit = (path: string) => {
    setEditing(null)
    // Give focus back to the block's Edit button once it is rendered again.
    focusAfterRender([editButtonId(path)])
  }
  // Ruling R54: a busy answer focuses the checking line, as Submit focuses the progress heading.
  const focusChecking = (data: SeniorResumeResponse) => {
    if (data.resume?.verificationBusy) focusAfterRender(['resume-confirm-checking'])
  }
  const inlineEdit = (path: string, label: string, text: string) => (
    <InlineEdit
      label={label}
      initial={text}
      error={editError}
      saveDisabled={edit.isPending || changingFacts}
      onCancel={() => closeEdit(path)}
      onSave={(next) =>
        act(edit.mutateAsync({ runId, path, text: next }), (data) => {
          if (data.resume?.verificationBusy) {
            setEditing(null)
            focusChecking(data)
          } else closeEdit(path)
        })
      }
    />
  )
  const regenerateButton = (path: string, ariaLabel?: string) => (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-11 sm:h-9"
      disabled={blockLocked}
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={() => act(regenerate.mutateAsync({ runId, path }), focusChecking)}
    >
      <RefreshCw className="mr-1.5 size-4" aria-hidden />
      <Trans>Згенерувати заново</Trans>
    </Button>
  )

  const { facts } = resume
  const topSkills = mergeSkills(
    facts.skills,
    facts.experience.map((job) => job.technologies),
  ).slice(0, 5)
  const summaryFacts = [facts.headline, topSkills.join(', ')].filter(Boolean).join(' · ')

  return (
    <div className="space-y-4" data-testid="resume-confirm-step">
      <Card className="space-y-3 p-4">
        {busy && (
          <div
            role="status"
            id="resume-confirm-checking"
            tabIndex={-1}
            className="space-y-2"
            data-testid="resume-confirm-checking"
          >
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <CheckingBadge />
              <Trans>Оновлюємо й перевіряємо текст…</Trans>
            </div>
            <ProgressBar />
          </div>
        )}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="border-transparent bg-yellow-subtle text-primary">
                <Trans>Чекає підтвердження</Trans>
              </Badge>
              <h3 className="text-base font-semibold">
                <Trans>Перегляньте текст резюме</Trans>
              </h3>
            </div>
            <p className="text-sm text-muted-foreground">
              {canConfirm ? (
                <Trans>
                  Текст згенеровано з ваших фактів. Підтвердьте, відредагуйте або згенеруйте заново.
                </Trans>
              ) : (
                <Trans>
                  Текст згенеровано з ваших фактів. Відредагуйте його або згенеруйте заново.
                </Trans>
              )}
            </p>
            {!canConfirm && (
              <p className="text-sm">
                <Trans>Резюме підтверджує HR. Ви можете змінити факти й надіслати знову.</Trans>
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Button
              type="button"
              variant="outline"
              className="h-11 sm:h-9"
              disabled={locked}
              aria-expanded={changingFacts}
              onClick={onChangeFacts}
              data-testid="resume-confirm-change-facts"
            >
              <Trans>Змінити факти</Trans>
            </Button>
            {canConfirm && (
              <Button
                type="button"
                className="h-11 sm:h-9"
                disabled={locked}
                onClick={() =>
                  act(confirm.mutateAsync({ runId, version: resume.version }), onConfirmed)
                }
                data-testid="resume-confirm"
              >
                <Check className="mr-1.5 size-4" aria-hidden />
                <Trans>Підтвердити</Trans>
              </Button>
            )}
          </div>
        </div>
        {busy && (
          <p className="text-sm">
            <Trans>Усі дії недоступні, поки триває перевірка.</Trans>
          </p>
        )}
      </Card>

      <Tabs
        defaultValue="text"
        className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)] lg:items-start lg:gap-4"
      >
        <TabsList className="grid w-full grid-cols-2 lg:hidden" aria-label={t`Перегляд`}>
          <TabsTrigger value="text" className="h-11 sm:h-9">
            <Trans>Текст</Trans>
          </TabsTrigger>
          <TabsTrigger value="pdf" className="h-11 sm:h-9">
            PDF
          </TabsTrigger>
        </TabsList>

        <TabsContent
          value="text"
          forceMount
          className="space-y-4 data-[state=inactive]:hidden lg:data-[state=inactive]:block"
        >
          <WrittenBlock
            testId="resume-confirm-block-summary"
            title={<Trans>Про себе</Trans>}
            edited={edited.has('summary')}
            fallback={underPath(fallbacks, 'summary')}
            actions={
              <>
                <Button
                  id={editButtonId('summary')}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-11 sm:h-9"
                  disabled={blockLocked}
                  onClick={() => openEdit('summary')}
                >
                  <Pencil className="mr-1.5 size-4" aria-hidden />
                  <Trans>Редагувати</Trans>
                </Button>
                {regenerateButton('summary')}
              </>
            }
            fromFacts={<p>{summaryFacts}</p>}
            generated={
              editing === 'summary' ? (
                inlineEdit('summary', t`Про себе`, staged.content.summary)
              ) : (
                <p className="whitespace-pre-line">{staged.content.summary}</p>
              )
            }
          />

          {staged.content.experience.map((item, i) => {
            const position = i + 1
            const prefix = `experience.${i}.bullets`
            const notes = facts.experience[i]?.notes ?? []
            return (
              <WrittenBlock
                key={i}
                testId={`resume-confirm-block-experience-${i}`}
                title={[item.role, item.company].filter(Boolean).join(' · ')}
                period={item.period}
                edited={underPath(editedPaths, prefix)}
                fallback={underPath(fallbacks, `experience.${i}`)}
                actions={regenerateButton(
                  prefix,
                  t`Згенерувати заново пункти, місце роботи ${position}`,
                )}
                fromFacts={
                  <ul className="list-disc space-y-1 pl-4">
                    {notes.map((note, j) => (
                      <li key={j}>{note}</li>
                    ))}
                  </ul>
                }
                generated={
                  <ul className="space-y-2">
                    {item.bullets.map((bullet, j) => {
                      const path = `${prefix}.${j}`
                      const bulletN = j + 1
                      const editLabel = t`Редагувати пункт ${bulletN}, місце роботи ${position}`
                      return (
                        <li
                          key={j}
                          className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2"
                        >
                          {editing === path ? (
                            <div className="col-span-2">
                              {inlineEdit(
                                path,
                                t`Пункт ${bulletN}, місце роботи ${position}`,
                                bullet,
                              )}
                            </div>
                          ) : (
                            <>
                              <p className="break-words">
                                {bullet} {edited.has(path) && <EditedBadge small />}
                              </p>
                              <Button
                                id={editButtonId(path)}
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-11 sm:size-9"
                                disabled={blockLocked}
                                aria-label={editLabel}
                                title={editLabel}
                                onClick={() => openEdit(path)}
                              >
                                <Pencil className="size-4" aria-hidden />
                              </Button>
                            </>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                }
              />
            )
          })}
        </TabsContent>

        <TabsContent
          value="pdf"
          forceMount
          className="data-[state=inactive]:hidden lg:sticky lg:top-4 lg:data-[state=inactive]:block"
        >
          {/* The run writes the new staged PDF without a new runId or updatedAt:
              never fetch mid-run, and key on the status so the finished run refetches. */}
          <StagedPdf
            userId={userId}
            busy={busy}
            fingerprint={`${runId}:${resume.verificationStatus}`}
            templateName={staged.templateName}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}

/** True when a report path is `prefix` itself or sits under it. */
const underPath = (paths: readonly string[], prefix: string) =>
  paths.some((p) => p === prefix || p.startsWith(`${prefix}.`))

const editButtonId = (path: string) => `resume-confirm-edit-${path.replaceAll('.', '-')}`

function EditedBadge({ small = false }: { small?: boolean }) {
  const { t } = useLingui()
  return (
    <Badge
      variant="outline"
      className={cn('border-dashed font-medium', small && 'px-1.5 py-0 text-[11px]')}
      title={t`Цей текст змінила людина — перевірку фактів для нього не запускали.`}
    >
      <Trans>Змінено вручну</Trans>
    </Badge>
  )
}

function WrittenBlock({
  testId,
  title,
  period,
  edited,
  fallback,
  actions,
  fromFacts,
  generated,
}: {
  testId: string
  title: ReactNode
  period?: string
  edited: boolean
  fallback: boolean
  actions: ReactNode
  fromFacts: ReactNode
  generated: ReactNode
}) {
  const label = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground'
  return (
    <Card className="space-y-3 p-4" data-testid={testId}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="font-semibold break-words">{title}</h4>
            {edited && <EditedBadge />}
          </div>
          {period && (
            <p className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">{period}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-1">{actions}</div>
      </div>
      {fallback && (
        <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" aria-hidden />
          <Trans>Згенерований текст не пройшов звірку з фактами — тут ваші нотатки як є.</Trans>
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-[2fr_3fr]">
        <div className="min-w-0 space-y-1 border-l-2 border-border pl-3 text-sm text-muted-foreground">
          <p className={label}>
            <Trans>З фактів</Trans>
          </p>
          {fromFacts}
        </div>
        <div className="min-w-0 space-y-1 border-l-2 border-primary pl-3 text-sm">
          <p className={label}>
            <Trans>Згенеровано</Trans>
          </p>
          {generated}
        </div>
      </div>
    </Card>
  )
}

function InlineEdit({
  label,
  initial,
  error,
  saveDisabled,
  onSave,
  onCancel,
}: {
  label: string
  initial: string
  error: string | null
  saveDisabled: boolean
  onSave: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(initial)
  const id = useId()
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        name="resumeStagedText"
        autoFocus
        value={text}
        rows={3}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          // The Save button's guard, for the shortcut: one request, never a repeat.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !saveDisabled && !e.repeat)
            onSave(text)
        }}
      />
      {/* The catalog text only: the server never echoes the matched text, and neither do we. */}
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          className="h-11 sm:h-9"
          disabled={saveDisabled}
          onClick={() => onSave(text)}
        >
          <Trans>Зберегти</Trans>
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-11 sm:h-9"
          onClick={onCancel}
        >
          <Trans>Скасувати</Trans>
        </Button>
        <p className="text-xs text-muted-foreground">
          <Trans>Після збереження перевіримо PDF ще раз.</Trans>
        </p>
      </div>
    </div>
  )
}

function StagedPdf({
  userId,
  busy,
  fingerprint,
  templateName,
}: {
  userId: string
  busy: boolean
  fingerprint: string
  templateName: ResumeTemplateName
}) {
  const { t } = useLingui()
  // The DTO carries no page count, so the meta line names the template only.
  const template = useTemplateLabel()(templateName)
  const { blobUrl, isLoading, hasError } = useResumePdfBlob(
    userId,
    !busy,
    fingerprint,
    'staged-pdf',
  )
  return (
    <Card className="space-y-3 p-4" data-testid="resume-staged-pdf">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-semibold">
            <Trans>PDF до підтвердження</Trans>
          </h4>
          <p className="text-xs text-muted-foreground" data-testid="resume-staged-pdf-template">
            <Trans>Шаблон: {template}</Trans>
          </p>
        </div>
        {!busy && (
          <Button asChild size="sm" variant="outline" className="h-11 sm:h-9">
            <a href={`${API_BASE_URL}/users/${userId}/resume/staged-pdf`} download>
              <Download className="mr-1.5 size-4" aria-hidden />
              <Trans>Завантажити PDF</Trans>
            </a>
          </Button>
        )}
      </div>
      <PdfPreview
        blobUrl={blobUrl}
        isLoading={busy || isLoading}
        hasError={hasError}
        filename={t`Резюме перед підтвердженням.pdf`}
        className="h-[60vh] max-h-[720px] min-h-[320px]"
        testId="resume-staged-pdf-object"
      />
    </Card>
  )
}
