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
import { Download, FileText, History } from 'lucide-react'
import {
  EMPTY_RESUME_CONTENT,
  isSafeResumeUrl,
  type ResumeContent,
  type ResumeExperienceItem,
  type ResumeLink,
} from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  resumePdfUrl,
  useIngestResumeText,
  useResumeSourceUrl,
  useSaveResumeContent,
  useSeniorResume,
  useUploadResumeSource,
} from '@/hooks/use-senior-resume'
import { ResumeExperienceEditor } from './ResumeExperienceEditor'
import { ResumeIntake } from './ResumeIntake'
import { ResumeSectionCard } from './ResumeSectionCard'
import { ResumeStatusPanel } from './ResumeStatusPanel'

type SectionId = 'summary' | 'skills' | 'experience' | 'education' | 'languages' | 'links'

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

  const startEdit = useCallback(
    (section: SectionId) => {
      setDraft(serverContent)
      setEditing(section)
    },
    [serverContent],
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

  // Empty + never uploaded + not extracting -> pure invitation screen.
  if (!hasContent && !isExtracting && resume?.status !== 'FAILED') {
    return (
      <div className="space-y-4" data-testid="resume-tab">
        {canEdit ? (
          <ResumeIntake
            onUploadFile={(file) => uploadMutation.mutate(file)}
            onSubmitText={(text) => textMutation.mutate(text)}
            isBusy={isBusy}
          />
        ) : (
          <p
            className="rounded-lg border bg-muted/30 px-6 py-10 text-center text-sm text-muted-foreground"
            data-testid="resume-empty-readonly"
          >
            Резюме ещё не заполнено.
          </p>
        )}
      </div>
    )
  }

  const sectionProps = (id: SectionId) => ({
    sectionId: id,
    canEdit,
    isEditing: editing === id,
    isDirty,
    isSaving: saveMutation.isPending,
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
            <span className="inline-flex items-center gap-1.5">
              <History className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">
                Версия {resume.version}
                {resume.updatedByName ? ` · последним менял ${resume.updatedByName}` : ''}
              </span>
            </span>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          {resume?.hasSourceFile && sourceQuery.data?.url && (
            // Plain <a>: the presigned URL is already in hand, so no
            // post-await window.open (which mobile browsers block).
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
          <Button asChild className="min-h-11">
            <a href={resumePdfUrl(userId)} data-testid="resume-download-pdf">
              <Download className="mr-2 h-4 w-4" aria-hidden />
              Скачать PDF
            </a>
          </Button>
        </div>
      </div>

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
