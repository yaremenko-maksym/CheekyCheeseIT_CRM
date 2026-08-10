/**
 * ResumeTab — the senior's canonical resume on their profile card
 * (task-resume-base §3).
 *
 * WHY THIS TAB, ON THIS CARD: the profile card is already the single place
 * where everything about one person lives (finances, projects, contract,
 * requisites), it already carries the exact RBAC surface this feature needs
 * (per-target, not per-role), and it is where HR already goes to look someone
 * up. A separate top-level page would have duplicated that access model and
 * split "the senior" across two screens. The tab is registered LAST in the
 * bar so no existing tab shifts position (muscle memory), and only on a SENIOR
 * card — see UsersAccessService.
 *
 * Editing model: in place, per section, with an explicit Save. The task left
 * the choice between autosave and a button to the implementer with one hard
 * condition — unsaved edits must not be lost on navigation. An explicit button
 * won because a resume is a document people rewrite in passes (delete a line,
 * retype it, change their mind), and autosave would persist every intermediate
 * state, bump `version` dozens of times, and — since `version` is exactly what
 * task-resume-tailoring uses to detect a stale base — invalidate tailored
 * variants on every keystroke. Unsaved work is protected by the profile
 * shell's dirty-guard dialog plus a `beforeunload` handler.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, History, PencilLine, Trash2 } from 'lucide-react'
import {
  EMPTY_RESUME_CONTENT,
  isSafeResumeUrl,
  type ResumeContent,
  type ResumeExperienceItem,
  type ResumeLink,
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
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  resumePdfUrl,
  useDeleteResume,
  useIngestResumeText,
  useResumeSourceUrl,
  useSaveResumeContent,
  useSaveResumeLayout,
  useSeniorResume,
  useUploadResumeSource,
} from '@/hooks/use-senior-resume'
import { ResumeExperienceEditor } from './ResumeExperienceEditor'
import { ResumeIntake } from './ResumeIntake'
import { ResumeLayoutPanel } from './ResumeLayoutPanel'
import { ResumePdfPreview } from './ResumePdfPreview'
import { ResumeSectionCard } from './ResumeSectionCard'
import { ResumeStatusPanel } from './ResumeStatusPanel'

type SectionId = 'summary' | 'skills' | 'experience' | 'education' | 'languages' | 'links'

/**
 * May `requested` be opened for editing while `current` is open?
 *
 * THE SINGLE SOURCE for that decision. Both the handler (`startEdit`) and the
 * button's `disabled` prop call it, so there is one condition to get right
 * rather than two hand-written copies that can drift apart.
 *
 * Why it is a named export rather than an inline check: the visible half of the
 * behaviour is the disabled button, and a disabled button cannot be driven from
 * a test — React reads `disabled` from its own props, so stripping the DOM
 * attribute never reaches the handler. Any rule expressed only inside
 * `startEdit` is therefore unfalsifiable. Naming it makes the decision
 * assertable on its own terms, and routing the UI through it means a mutation
 * to this function shows up in the interface tests too.
 */
export function mayStartEditing(current: SectionId | null, requested: SectionId): boolean {
  // Re-opening the section already open is a no-op, not a switch.
  if (current === null || current === requested) return true
  // Anything else would silently discard the draft being typed.
  return false
}

export interface ResumeTabProps {
  userId: string
  /** Bubbles unsaved-edit state to UserProfileShell's tab-switch guard. */
  onDirtyChange?: (dirty: boolean) => void
}

export function ResumeTab({ userId, onDirtyChange }: ResumeTabProps) {
  const { data, isLoading, isError } = useSeniorResume(userId)
  const saveMutation = useSaveResumeContent(userId)
  const uploadMutation = useUploadResumeSource(userId)
  const textMutation = useIngestResumeText(userId)
  const deleteMutation = useDeleteResume(userId)
  const layoutMutation = useSaveResumeLayout(userId)
  // `resume` is null until the senior has one; `canEdit` sits OUTSIDE it
  // precisely so the empty state still knows whether to offer the upload UI.
  const resume = data?.resume ?? null
  const sourceQuery = useResumeSourceUrl(userId, Boolean(resume?.hasSourceFile))

  const serverContent = resume?.content ?? EMPTY_RESUME_CONTENT
  const canEdit = data?.canEdit ?? false
  const isBusy = uploadMutation.isPending || textMutation.isPending

  // `draft` holds the in-progress edit of ONE section; `editing` says which.
  const [editing, setEditing] = useState<SectionId | null>(null)
  const [draft, setDraft] = useState<ResumeContent>(serverContent)
  const [showIntake, setShowIntake] = useState(false)
  /** Set when the user chooses to type the resume instead of uploading one. */
  const [manualMode, setManualMode] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Reset the draft whenever the server content changes and nothing is being
  // edited — so a finished extraction shows up immediately, but never wipes
  // an edit in progress.
  const serverVersionKey = `${resume?.version ?? -1}:${resume?.status ?? 'none'}`
  const lastSyncedRef = useRef<string>('')
  useEffect(() => {
    if (editing !== null) return
    if (lastSyncedRef.current === serverVersionKey) return
    lastSyncedRef.current = serverVersionKey
    setDraft(serverContent)
  }, [serverVersionKey, serverContent, editing])

  const isDirty = useMemo(
    () => editing !== null && JSON.stringify(draft) !== JSON.stringify(serverContent),
    [editing, draft, serverContent],
  )

  useEffect(() => {
    onDirtyChange?.(isDirty)
    return () => onDirtyChange?.(false)
  }, [isDirty, onDirtyChange])

  /**
   * ONE `beforeunload` handler for the whole tab.
   *
   * It used to live inside `ResumeSectionCard`, which meant six identical
   * listeners registered and torn down on every dirty-state change — six
   * subscriptions to say one thing.
   */
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

  /**
   * Open a section for editing.
   *
   * Refuses while ANOTHER section is open: `setDraft(serverContent)` would
   * throw away whatever is being typed there, and it did so silently — no
   * prompt, no undo. The decision itself lives in `mayStartEditing`, which the
   * section cards' `disabled` prop also consults, so the handler and the
   * interface cannot disagree about what is allowed.
   */
  const startEdit = useCallback(
    (section: SectionId) => {
      if (!mayStartEditing(editing, section)) return
      setDraft(serverContent)
      setEditing(section)
    },
    [editing, serverContent],
  )

  const cancelEdit = useCallback(() => {
    setDraft(serverContent)
    setEditing(null)
  }, [serverContent])

  const saveSection = useCallback(() => {
    saveMutation.mutate(draft, { onSuccess: () => setEditing(null) })
  }, [draft, saveMutation])

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
        Не удалось загрузить резюме.
      </p>
    )
  }

  const hasContent =
    resume !== null &&
    (serverContent.summary.trim() !== '' ||
      serverContent.skills.length > 0 ||
      serverContent.experience.length > 0 ||
      serverContent.education.length > 0 ||
      serverContent.languages.length > 0 ||
      serverContent.links.length > 0)

  const isExtracting = resume?.status === 'QUEUED' || resume?.status === 'RUNNING'

  // Empty + never uploaded + not extracting -> invitation screen.
  //
  // `manualMode` is the way OUT of it. Without it this branch was a dead end
  // whenever the resume was empty for a reason the banner does not cover — a
  // READY row whose extraction produced nothing usable, or a resume someone
  // cleared: the screen offered a file and a paste box and no way to simply
  // type the resume in, even though the section editors below work perfectly
  // well on empty content.
  /**
   * The stored original + its erase control.
   *
   * Rendered in BOTH the empty state and the filled one. An extraction that
   * produces nothing usable leaves a READY row with empty content and a file
   * still in storage — and that combination used to render the invitation
   * screen ONLY, with no toolbar. So the user could see (via the intake copy)
   * that a file had been uploaded, and had no way to download or erase it
   * short of going through «Заполнить вручную» first. For a right-to-erasure
   * control that is not an acceptable path.
   */
  const sourceAndDangerActions =
    resume && (resume.hasSourceFile || canEdit) ? (
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        {resume.hasSourceFile && sourceQuery.data?.url && (
          <Button asChild variant="outline" className="min-h-11">
            <a
              href={sourceQuery.data.url}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="resume-download-source"
            >
              <FileText className="mr-2 h-4 w-4" aria-hidden />
              Исходный файл
            </a>
          </Button>
        )}
        {canEdit && (
          <Button
            variant="outline"
            onClick={() => setConfirmDelete(true)}
            data-testid="resume-delete"
            className="min-h-11 text-destructive hover:text-destructive"
          >
            <Trash2 className="mr-2 h-4 w-4" aria-hidden />
            Удалить
          </Button>
        )}
      </div>
    ) : null

  const deleteDialog = (
    <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <AlertDialogContent data-testid="resume-delete-confirm-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Удалить резюме?</AlertDialogTitle>
          <AlertDialogDescription>
            Будут удалены и заполненные разделы, и загруженный исходный файл
            {resume?.sourceFileName ? ` («${resume.sourceFileName}»)` : ''}. Восстановить их будет
            нельзя — резюме придётся загрузить или заполнить заново.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="resume-delete-cancel">Отмена</AlertDialogCancel>
          <AlertDialogAction
            data-testid="resume-delete-confirm"
            disabled={deleteMutation.isPending}
            onClick={() => {
              setConfirmDelete(false)
              setEditing(null)
              setManualMode(false)
              deleteMutation.mutate()
            }}
          >
            {deleteMutation.isPending ? 'Удаляем…' : 'Удалить'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  if (!hasContent && !isExtracting && resume?.status !== 'FAILED' && !manualMode) {
    return (
      <div className="space-y-4" data-testid="resume-tab">
        {sourceAndDangerActions}
        {canEdit ? (
          <>
            <ResumeIntake
              onUploadFile={(file) => uploadMutation.mutate(file)}
              onSubmitText={(text) => textMutation.mutate(text)}
              isBusy={isBusy}
            />
            <div className="text-center">
              <Button
                variant="outline"
                onClick={() => setManualMode(true)}
                data-testid="resume-fill-manually"
                className="min-h-11 w-full sm:w-auto"
              >
                <PencilLine className="mr-2 h-4 w-4" aria-hidden />
                Заполнить вручную
              </Button>
              <p className="mt-2 text-xs text-muted-foreground">
                Те же разделы и тот же экспорт в PDF — распознавание просто экономит время.
              </p>
            </div>
          </>
        ) : (
          <p
            className="rounded-lg border bg-muted/30 px-6 py-10 text-center text-sm text-muted-foreground"
            data-testid="resume-empty-readonly"
          >
            Резюме ещё не заполнено.
          </p>
        )}
        {deleteDialog}
      </div>
    )
  }

  const sectionProps = (id: SectionId) => ({
    sectionId: id,
    canEdit,
    isEditing: editing === id,
    isDirty,
    isSaving: saveMutation.isPending,
    // One section at a time — see `startEdit`.
    // Derived from the SAME rule the handler consults — see `mayStartEditing`.
    // These were two hand-written copies of one condition, and the copy that
    // drives the UI was the only one anything could observe.
    disableEdit: !mayStartEditing(editing, id),
    onStartEdit: () => startEdit(id),
    onCancel: cancelEdit,
    onSave: saveSection,
  })

  const view = editing === null ? serverContent : draft

  return (
    <div className="space-y-4 pb-4" data-testid="resume-tab">
      {/* State banner: progress or an actionable failure. Never blocks the form. */}
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

      {/* Toolbar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 text-xs text-muted-foreground">
          {resume && (
            // `max-w-full` IS THE FIX. `min-w-0` is inert here and is kept only
            // for symmetry with the row above.
            //
            // Measured across four variants in a browser: with `min-w-0` alone
            // the row still overflowed to 510 px with no truncation — exactly as
            // before the change. `truncate` already sets `overflow: hidden`, so
            // this item's automatic minimum size was zero to begin with and
            // there was nothing for `min-w-0` to relax; what the span lacked was
            // an upper bound, which `max-w-full` supplies.
            //
            // Written out because the earlier comment here credited `min-w-0`,
            // and the next person to tidy a "redundant" `max-w-full` on that
            // authority would silently bring the overflow back.
            <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
              <History className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">
                Версия {resume.version}
                {resume.updatedByName ? ` · последним менял ${resume.updatedByName}` : ''}
              </span>
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
          {/* Source download + erase: the SAME fragment the empty state renders,
              so neither control can go missing in one branch only. */}
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
          isBusy={isBusy}
        />
      )}

      {/* ── Sections ─────────────────────────────────────────────────────── */}

      <ResumeSectionCard title="О себе" {...sectionProps('summary')}>
        {editing === 'summary' ? (
          <Textarea
            value={draft.summary}
            onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
            rows={5}
            aria-label="О себе"
            data-testid="resume-summary-input"
          />
        ) : (
          <TextOrPlaceholder value={view.summary} testid="resume-summary-view" />
        )}
      </ResumeSectionCard>

      <ResumeSectionCard title="Навыки" {...sectionProps('skills')}>
        {editing === 'skills' ? (
          <Textarea
            value={draft.skills.join('\n')}
            onChange={(e) => setDraft({ ...draft, skills: e.target.value.split('\n') })}
            rows={6}
            placeholder="По одному навыку в строке"
            aria-label="Навыки"
            data-testid="resume-skills-input"
          />
        ) : view.skills.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" data-testid="resume-skills-view">
            {view.skills.map((skill, i) => (
              <li key={i} className="rounded-full bg-muted px-2.5 py-1 text-xs">
                {skill}
              </li>
            ))}
          </ul>
        ) : (
          <Placeholder />
        )}
      </ResumeSectionCard>

      <ResumeSectionCard title="Опыт работы" {...sectionProps('experience')}>
        {editing === 'experience' ? (
          <ResumeExperienceEditor
            items={draft.experience}
            onChange={(experience) => setDraft({ ...draft, experience })}
          />
        ) : view.experience.length > 0 ? (
          // divide-y (not a bordered box per item, per foundation.md §6 "не
          // карточка в карточке") — a real resume runs to 6-8+ jobs, and
          // without a rule between them a dense mobile column reads as one
          // undifferentiated ribbon of bullets with no landmark for where
          // one job ends and the next begins.
          <ol className="divide-y divide-border" data-testid="resume-experience-view">
            {view.experience.map((item, i) => (
              <ExperienceRow key={i} item={item} index={i} />
            ))}
          </ol>
        ) : (
          <Placeholder />
        )}
      </ResumeSectionCard>

      <ResumeSectionCard title="Образование" {...sectionProps('education')}>
        {editing === 'education' ? (
          <PairListEditor
            rows={draft.education.map((e) => [e.degree, e.institution, e.period])}
            labels={['Степень / специальность', 'Учебное заведение', 'Период']}
            idPrefix="education"
            addLabel="Добавить образование"
            onChange={(rows) =>
              setDraft({
                ...draft,
                education: rows.map(([degree, institution, period]) => ({
                  degree: degree ?? '',
                  institution: institution ?? '',
                  period: period ?? '',
                })),
              })
            }
          />
        ) : view.education.length > 0 ? (
          <ul className="space-y-2" data-testid="resume-education-view">
            {view.education.map((item, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium">{item.degree}</span>
                {item.institution && (
                  <span className="text-muted-foreground"> · {item.institution}</span>
                )}
                {item.period && <div className="text-xs text-muted-foreground">{item.period}</div>}
              </li>
            ))}
          </ul>
        ) : (
          <Placeholder />
        )}
      </ResumeSectionCard>

      <ResumeSectionCard title="Языки" {...sectionProps('languages')}>
        {editing === 'languages' ? (
          <PairListEditor
            rows={draft.languages.map((l) => [l.name, l.level])}
            labels={['Язык', 'Уровень']}
            idPrefix="languages"
            addLabel="Добавить язык"
            onChange={(rows) =>
              setDraft({
                ...draft,
                languages: rows.map(([name, level]) => ({ name: name ?? '', level: level ?? '' })),
              })
            }
          />
        ) : view.languages.length > 0 ? (
          <ul className="flex flex-wrap gap-2 text-sm" data-testid="resume-languages-view">
            {view.languages.map((item, i) => (
              <li key={i} className="rounded-md border px-2.5 py-1">
                {item.name}
                {item.level && <span className="text-muted-foreground"> — {item.level}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <Placeholder />
        )}
      </ResumeSectionCard>

      <ResumeSectionCard title="Ссылки" {...sectionProps('links')}>
        {editing === 'links' ? (
          <ResumeLinksEditor
            links={draft.links}
            onChange={(links) => setDraft({ ...draft, links })}
          />
        ) : view.links.length > 0 ? (
          <ul className="space-y-1.5 text-sm" data-testid="resume-links-view">
            {view.links.map((item, i) => (
              <li key={i}>
                {/* Belt and braces: the server already rejects non-https/mailto
                    schemes, and the renderer refuses to make anything else a
                    link — an unsafe URL degrades to plain text (AC7). */}
                {isSafeResumeUrl(item.url) ? (
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-primary underline underline-offset-2"
                  >
                    {item.label || item.url}
                  </a>
                ) : (
                  <span className="text-muted-foreground">{item.label || item.url}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Placeholder />
        )}
      </ResumeSectionCard>

      {/* ── Layout + the finished document ───────────────────────────────── */}

      {resume && (
        <ResumeLayoutPanel
          layout={resume.layout}
          canEdit={canEdit}
          isSaving={layoutMutation.isPending}
          onSave={(layout) => layoutMutation.mutate(layout)}
        />
      )}

      {/* Only once there is something to typeset. An empty resume renders a
          page with a name on it — a download that wastes a click and looks
          broken. */}
      {resume && hasContent && <ResumePdfPreview resume={resume} pdfUrl={resumePdfUrl(userId)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function Placeholder() {
  return <p className="text-sm italic text-muted-foreground">Не заполнено</p>
}

function TextOrPlaceholder({ value, testid }: { value: string; testid: string }) {
  if (value.trim() === '') return <Placeholder />
  // `whitespace-pre-wrap` keeps the author's line breaks without any markup
  // pass — resume text is untrusted and is never interpreted, only escaped.
  return (
    <p className="whitespace-pre-wrap text-sm" data-testid={testid}>
      {value}
    </p>
  )
}

function ExperienceRow({ item, index }: { item: ResumeExperienceItem; index: number }) {
  return (
    <li
      className="space-y-1 py-3 first:pt-0 last:pb-0"
      data-testid={`resume-experience-row-${index}`}
    >
      <p className="text-sm font-medium">
        {item.role}
        {item.company && <span className="text-muted-foreground"> — {item.company}</span>}
      </p>
      {item.period && <p className="text-xs text-muted-foreground">{item.period}</p>}
      {item.bullets.filter((b) => b.trim() !== '').length > 0 && (
        <ul className="list-inside list-disc space-y-0.5 text-sm text-muted-foreground">
          {item.bullets
            .filter((b) => b.trim() !== '')
            .map((bullet, i) => (
              <li key={i}>{bullet}</li>
            ))}
        </ul>
      )}
    </li>
  )
}

/**
 * Links editor — kept SEPARATE from the generic `PairListEditor` even though
 * the layout is nearly identical, because a URL field is not free text: it
 * needs `type="url"` (URL keyboard on mobile) plus the anti-autocorrect trio,
 * or iOS will happily capitalise and "correct" a pasted address into garbage.
 * The project's mobile-keyboard registry enforces exactly this distinction,
 * and a shared component with dynamically-forwarded props could not satisfy
 * it statically.
 */
function ResumeLinksEditor({
  links,
  onChange,
}: {
  links: ResumeLink[]
  onChange: (links: ResumeLink[]) => void
}) {
  function patch(index: number, changes: Partial<ResumeLink>) {
    onChange(links.map((link, i) => (i === index ? { ...link, ...changes } : link)))
  }

  return (
    <div className="space-y-3">
      {links.map((link, index) => (
        <div
          key={index}
          className="flex flex-col gap-2 rounded-md border bg-muted/20 p-3 sm:flex-row sm:items-center"
          data-testid={`resume-links-item-${index}`}
        >
          <div className="grid flex-1 gap-2 sm:grid-cols-2">
            <Input
              value={link.label}
              onChange={(e) => patch(index, { label: e.target.value })}
              placeholder="Название"
              aria-label={`Название ссылки, строка ${index + 1}`}
              data-testid={`resume-links-label-${index}`}
              // Static `name` (inert — no <form>) so the mobile-keyboard
              // registry gets a stable key; the testid is a template literal
              // and cannot be resolved statically.
              name="resumeLinkLabel"
            />
            <Input
              type="url"
              value={link.url}
              onChange={(e) => patch(index, { url: e.target.value })}
              placeholder="https://… или mailto:…"
              aria-label={`Ссылка, строка ${index + 1}`}
              data-testid={`resume-links-url-${index}`}
              name="resumeLinkUrl"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onChange(links.filter((_, i) => i !== index))}
            aria-label={`Удалить ссылку ${index + 1}`}
            data-testid={`resume-links-remove-${index}`}
            className="h-11 w-11 shrink-0 self-end text-destructive sm:h-9 sm:w-9 sm:self-auto"
          >
            <span aria-hidden>×</span>
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        onClick={() => onChange([...links, { label: '', url: '' }])}
        data-testid="resume-links-add"
        className="min-h-11 w-full sm:w-auto"
      >
        Добавить ссылку
      </Button>
    </div>
  )
}

/**
 * Generic editor for the small "list of N free-text fields" sections
 * (education, languages). One component instead of two near-identical ones —
 * they differ only in labels and arity. Links are NOT handled here: see
 * `ResumeLinksEditor`.
 */
function PairListEditor({
  rows,
  labels,
  idPrefix,
  addLabel,
  onChange,
}: {
  rows: string[][]
  labels: string[]
  idPrefix: string
  addLabel: string
  onChange: (rows: string[][]) => void
}) {
  return (
    <div className="space-y-3">
      {rows.map((row, rowIndex) => (
        <div
          key={rowIndex}
          className="flex flex-col gap-2 rounded-md border bg-muted/20 p-3 sm:flex-row sm:items-center"
          data-testid={`resume-${idPrefix}-item-${rowIndex}`}
        >
          <div className="grid flex-1 gap-2 sm:grid-cols-2">
            {labels.map((label, colIndex) => (
              <Input
                key={colIndex}
                value={row[colIndex] ?? ''}
                onChange={(e) =>
                  onChange(
                    rows.map((r, i) =>
                      i === rowIndex
                        ? labels.map((_, c) => (c === colIndex ? e.target.value : (r[c] ?? '')))
                        : r,
                    ),
                  )
                }
                placeholder={label}
                aria-label={`${label}, строка ${rowIndex + 1}`}
                data-testid={`resume-${idPrefix}-${colIndex}-${rowIndex}`}
                // Static `name` (inert — no <form>) so the mobile-keyboard
                // registry gets a stable key rather than a positional one.
                name="resumePairField"
              />
            ))}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onChange(rows.filter((_, i) => i !== rowIndex))}
            aria-label={`Удалить строку ${rowIndex + 1}`}
            data-testid={`resume-${idPrefix}-remove-${rowIndex}`}
            className="h-11 w-11 shrink-0 self-end text-destructive sm:h-9 sm:w-9 sm:self-auto"
          >
            <span aria-hidden>×</span>
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        onClick={() => onChange([...rows, labels.map(() => '')])}
        data-testid={`resume-${idPrefix}-add`}
        className="min-h-11 w-full sm:w-auto"
      >
        {addLabel}
      </Button>
    </div>
  )
}
