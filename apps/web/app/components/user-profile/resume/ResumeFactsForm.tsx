/**
 * The facts form of the verified base resume (design §5.1).
 *
 * HR types FACTS here, never the resume text: the writer turns them into the
 * summary and bullets later, and HR confirms that result. The completeness
 * panel next to the form runs `checkResumeCompleteness` — the same function the
 * server runs at Submit — on the local draft on every change, so the list on
 * screen is the list the server would answer with.
 *
 * Draft model: one draft for the whole form, an explicit Save, and Submit that
 * saves unsaved facts first (one action, ruling R45). A server refresh replaces
 * the draft only while nothing is typed — that is how an upload's extraction
 * result lands in the fields — and never wipes an edit in progress. A failed
 * write (409 while a check runs) leaves the draft as it is.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  RESUME_LANGUAGE_LEVELS,
  RESUME_LIMITS,
  RESUME_WORK_FORMATS,
  checkResumeCompleteness,
  mergeSkills,
  type CompletenessCode,
  type ResumeFacts,
  type ResumeFactsExperience,
} from '@crm/shared'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  ResumeCompletenessPanel,
  factsFieldId,
  focusFactsField,
  issueFieldPath,
} from './ResumeCompletenessPanel'
import { FieldError, IconButton, JobBlock, RowBlock } from './ResumeFactsJob'

/** Pure move helper — exported so the reorder rule is unit-testable. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return [...items]
  }
  const next = [...items]
  const [moved] = next.splice(from, 1)
  if (moved === undefined) return [...items]
  next.splice(to, 0, moved)
  return next
}

const EMPTY_JOB: ResumeFactsExperience = {
  company: '',
  role: '',
  location: null,
  start: null,
  end: null,
  current: false,
  technologies: [],
  notes: [],
}

/** One item per line while typing; the blank lines go at save time. */
function cleanFacts(facts: ResumeFacts): ResumeFacts {
  const nonBlank = (lines: string[]) => lines.filter((line) => line.trim() !== '')
  return {
    ...facts,
    skills: nonBlank(facts.skills),
    experience: facts.experience.map((job) => ({ ...job, notes: nonBlank(job.notes) })),
  }
}

const same = (a: ResumeFacts, b: ResumeFacts) => JSON.stringify(a) === JSON.stringify(b)

const lines = (value: string) => value.split('\n')

function monthOf(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
}

export interface ResumeFactsFormProps {
  facts: ResumeFacts
  /** The profile name: the check needs it, the form cannot change it. */
  displayName: string
  /** A check is running: values stay readable, nothing is editable. */
  disabled: boolean
  onSave: (facts: ResumeFacts, options: { silent: boolean }) => Promise<unknown>
  onSubmit: () => Promise<unknown>
  onDirtyChange?: (dirty: boolean) => void
  /** Injected in tests; the live form reads the clock. */
  now?: Date
}

export function ResumeFactsForm({
  facts,
  displayName,
  disabled,
  onSave,
  onSubmit,
  onDirtyChange,
  now,
}: ResumeFactsFormProps) {
  const { t } = useLingui()
  const [draft, setDraft] = useState(facts)
  const [baseline, setBaseline] = useState(facts)
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const [pending, setPending] = useState<'save' | 'submit' | null>(null)
  /** The server facts moved while the draft had unsaved edits (e.g. an extraction landed). */
  const [serverChanged, setServerChanged] = useState(false)
  /** The last payload this form sent; its echo from the server is not an outside change. */
  const [sent, setSent] = useState<ResumeFacts | null>(null)

  // A new server value replaces the draft only when nothing unsaved is in it.
  // Otherwise the draft stays and the user is told the saved version moved,
  // unless the new value is this form's own save (edits typed meanwhile stay).
  if (facts !== baseline) {
    const draftClean = same(cleanFacts(draft), cleanFacts(baseline))
    const ownSave = sent !== null && same(cleanFacts(facts), sent)
    if (draftClean) setDraft(facts)
    if (ownSave || draftClean || same(cleanFacts(draft), cleanFacts(facts))) setServerChanged(false)
    else if (!same(cleanFacts(facts), cleanFacts(baseline))) setServerChanged(true)
    setBaseline(facts)
  }

  const dirty = !same(cleanFacts(draft), cleanFacts(baseline))
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  // Unmount clears the flag. Under a staged result the form stays mounted but
  // `hidden` (R56) and keeps its draft, so a hidden form still reports dirty.
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  const nowMonth = monthOf(now ?? new Date())
  const issues = useMemo(
    () => checkResumeCompleteness(draft, { displayName, now: now ?? new Date() }),
    [draft, displayName, now],
  )

  const errorsByField = useMemo(() => {
    const map = new Map<string, CompletenessCode[]>()
    for (const issue of issues) {
      const field = issueFieldPath(issue.path)
      if (field === null) continue
      map.set(field, [...(map.get(field) ?? []), issue.code])
    }
    return map
  }, [issues])

  const touch = (field: string) =>
    setTouched((prev) => (prev.has(field) ? prev : new Set(prev).add(field)))

  /** Props that tie a control to its error line; errors show once the field was touched. */
  function a11y(field: string, extraDescribedBy?: string) {
    const shown = touched.has(field) && errorsByField.has(field)
    const describedBy = [extraDescribedBy, shown ? `${factsFieldId(field)}-error` : undefined]
      .filter(Boolean)
      .join(' ')
    return {
      id: factsFieldId(field),
      'aria-invalid': shown ? true : undefined,
      'aria-describedby': describedBy || undefined,
      onBlur: () => touch(field),
    }
  }

  const fieldError = (field: string) => (
    <FieldError field={field} errors={errorsByField} touched={touched} />
  )

  function focusPath(path: string) {
    const field = issueFieldPath(path)
    if (field !== null && focusFactsField(field)) touch(field)
  }

  const patch = (changes: Partial<ResumeFacts>) => setDraft((d) => ({ ...d, ...changes }))
  const patchJob = (index: number, changes: Partial<ResumeFactsExperience>) =>
    setDraft((d) => ({
      ...d,
      experience: d.experience.map((job, i) => (i === index ? { ...job, ...changes } : job)),
    }))

  async function run(kind: 'save' | 'submit', action: () => Promise<unknown>) {
    setPending(kind)
    try {
      await action()
    } catch {
      // The hook already toasted the catalog text and refetched; the draft stays.
    } finally {
      setPending(null)
    }
  }
  const send = (silent: boolean) => {
    const payload = cleanFacts(draft)
    setSent(payload)
    return onSave(payload, { silent })
  }
  const save = () => run('save', () => send(false))
  const submit = () =>
    run('submit', async () => {
      if (dirty) await send(true)
      await onSubmit()
    })

  const ownSkills = mergeSkills(draft.skills, []).length
  const totalSkills = mergeSkills(
    draft.skills,
    draft.experience.map((job) => job.technologies),
  ).length
  const fromJobs = totalSkills - ownSkills
  const skillsHintId = useId()
  const workFormatLabels: Record<(typeof RESUME_WORK_FORMATS)[number], string> = {
    remote: t`Віддалено`,
    hybrid: t`Гібридно`,
    onsite: t`В офісі`,
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_304px] lg:items-start">
      <div className="lg:order-2">
        <ResumeCompletenessPanel
          issues={issues}
          onFocusPath={focusPath}
          onSubmit={() => void submit()}
          onSaveDraft={() => void save()}
          canSave={dirty}
          disabled={disabled}
          pending={pending}
        />
      </div>

      <fieldset
        disabled={disabled}
        className={cn('min-w-0 space-y-4 lg:order-1', disabled && 'opacity-50')}
        data-testid="resume-facts-form"
      >
        <legend className="sr-only">
          <Trans>Факти резюме</Trans>
        </legend>

        {serverChanged && (
          <div
            role="status"
            className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between"
            data-testid="resume-facts-server-changed"
          >
            <span>
              <Trans>Збережена версія змінилася.</Trans>
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-11 sm:h-9"
              onClick={() => {
                setDraft(baseline)
                setServerChanged(false)
              }}
            >
              <Trans>Завантажити збережену</Trans>
            </Button>
          </div>
        )}

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              <Trans>Основне</Trans>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor={factsFieldId('headline')}>
                <Trans>Цільова посада</Trans>
              </Label>
              <Input
                {...a11y('headline')}
                value={draft.headline}
                maxLength={RESUME_LIMITS.shortText}
                onChange={(e) => patch({ headline: e.target.value })}
                name="resumeFactsHeadline"
              />
              {fieldError('headline')}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={factsFieldId('location.city')}>
                  <Trans>Місто</Trans>
                </Label>
                <Input
                  {...a11y('location.city')}
                  value={draft.location.city}
                  maxLength={RESUME_LIMITS.shortText}
                  onChange={(e) => patch({ location: { ...draft.location, city: e.target.value } })}
                  name="resumeFactsCity"
                />
                {fieldError('location.city')}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={factsFieldId('location.country')}>
                  <Trans>Країна</Trans>
                </Label>
                <Input
                  {...a11y('location.country')}
                  value={draft.location.country}
                  maxLength={RESUME_LIMITS.shortText}
                  onChange={(e) =>
                    patch({ location: { ...draft.location, country: e.target.value } })
                  }
                  name="resumeFactsCountry"
                />
                {fieldError('location.country')}
              </div>
            </div>
            <div className="space-y-1.5 sm:w-1/2 sm:pr-1.5">
              <Label htmlFor={factsFieldId('workFormat')}>
                <Trans>Формат роботи</Trans>
              </Label>
              <Select
                value={draft.workFormat ?? ''}
                onValueChange={(value) =>
                  patch({ workFormat: value as (typeof RESUME_WORK_FORMATS)[number] })
                }
                disabled={disabled}
              >
                <SelectTrigger id={factsFieldId('workFormat')} className="h-11 sm:h-9">
                  <SelectValue placeholder={t`Формат роботи`} />
                </SelectTrigger>
                <SelectContent>
                  {RESUME_WORK_FORMATS.map((format) => (
                    <SelectItem key={format} value={format}>
                      {workFormatLabels[format]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex flex-wrap items-baseline gap-2 text-base">
              <Trans>Навички</Trans>
              {totalSkills < 5 && (
                <span className="text-xs font-normal text-muted-foreground tabular-nums">
                  <Trans>
                    {ownSkills} + {fromJobs} з досвіду = {totalSkills} з 5
                  </Trans>
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            <p id={skillsHintId} className="text-xs text-muted-foreground">
              <Trans>По одній навичці в рядку</Trans>
            </p>
            <Textarea
              {...a11y('skills', skillsHintId)}
              aria-label={t`Навички`}
              rows={5}
              value={draft.skills.join('\n')}
              onChange={(e) => patch({ skills: lines(e.target.value) })}
              data-testid="resume-facts-skills"
            />
            {fieldError('skills')}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
            <CardTitle className="text-base">
              <Trans>Досвід роботи</Trans>
            </CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              id={factsFieldId('experience.add')}
              className="h-11 sm:h-9"
              disabled={draft.experience.length >= RESUME_LIMITS.experience}
              onClick={() => patch({ experience: [...draft.experience, { ...EMPTY_JOB }] })}
              data-testid="resume-facts-experience-add"
            >
              <Plus className="mr-1.5 size-4" aria-hidden />
              <Trans>Додати місце роботи</Trans>
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {fieldError('experience.add')}
            {draft.experience.map((job, index) => (
              <JobBlock
                key={index}
                job={job}
                index={index}
                count={draft.experience.length}
                nowMonth={nowMonth}
                a11y={a11y}
                fieldError={fieldError}
                onPatch={(changes) => patchJob(index, changes)}
                onMove={(to) => patch({ experience: moveItem(draft.experience, index, to) })}
                onRemove={() =>
                  patch({ experience: draft.experience.filter((_, i) => i !== index) })
                }
              />
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
            <CardTitle className="text-base">
              <Trans>Освіта</Trans>
            </CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-11 sm:h-9"
              disabled={draft.education.length >= RESUME_LIMITS.education}
              onClick={() =>
                patch({
                  education: [
                    ...draft.education,
                    { institution: '', degree: '', startYear: null, endYear: null },
                  ],
                })
              }
            >
              <Plus className="mr-1.5 size-4" aria-hidden />
              <Trans>Додати освіту</Trans>
            </Button>
          </CardHeader>
          {draft.education.length > 0 && (
            <CardContent className="space-y-3">
              {draft.education.map((item, index) => {
                const position = index + 1
                const base = `education.${index}`
                const set = (changes: Partial<typeof item>) =>
                  patch({
                    education: draft.education.map((e, i) =>
                      i === index ? { ...e, ...changes } : e,
                    ),
                  })
                const year = (value: string) => (value === '' ? null : Number(value))
                return (
                  <RowBlock
                    key={index}
                    title={t`Освіта ${position}`}
                    removeLabel={t`Видалити освіту ${position}`}
                    onRemove={() =>
                      patch({ education: draft.education.filter((_, i) => i !== index) })
                    }
                  >
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor={factsFieldId(`${base}.institution`)}>
                          <Trans>Навчальний заклад</Trans>
                        </Label>
                        <Input
                          {...a11y(`${base}.institution`)}
                          aria-label={t`Навчальний заклад, освіта ${position}`}
                          value={item.institution}
                          maxLength={RESUME_LIMITS.shortText}
                          onChange={(e) => set({ institution: e.target.value })}
                          name="resumeFactsInstitution"
                        />
                        {fieldError(`${base}.institution`)}
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={factsFieldId(`${base}.degree`)}>
                          <Trans>Ступінь / спеціальність</Trans>
                        </Label>
                        <Input
                          {...a11y(`${base}.degree`)}
                          aria-label={t`Ступінь / спеціальність, освіта ${position}`}
                          value={item.degree}
                          maxLength={RESUME_LIMITS.shortText}
                          onChange={(e) => set({ degree: e.target.value })}
                          name="resumeFactsDegree"
                        />
                        {fieldError(`${base}.degree`)}
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={factsFieldId(`${base}.startYear`)}>
                          <Trans>Рік початку</Trans>
                        </Label>
                        <Input
                          {...a11y(`${base}.startYear`)}
                          type="number"
                          inputMode="numeric"
                          min={1950}
                          max={2100}
                          aria-label={t`Рік початку, освіта ${position}`}
                          value={item.startYear ?? ''}
                          onChange={(e) => set({ startYear: year(e.target.value) })}
                          name="resumeFactsEducationStartYear"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={factsFieldId(`${base}.endYear`)}>
                          <Trans>Рік завершення</Trans>
                        </Label>
                        <Input
                          {...a11y(`${base}.endYear`)}
                          type="number"
                          inputMode="numeric"
                          min={1950}
                          max={2100}
                          aria-label={t`Рік завершення, освіта ${position}`}
                          value={item.endYear ?? ''}
                          onChange={(e) => set({ endYear: year(e.target.value) })}
                          name="resumeFactsEducationEndYear"
                        />
                        {fieldError(`${base}.endYear`)}
                      </div>
                    </div>
                  </RowBlock>
                )
              })}
            </CardContent>
          )}
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
            <CardTitle className="text-base">
              <Trans>Мови</Trans>
            </CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              id={factsFieldId('languages.add')}
              className="h-11 sm:h-9"
              disabled={draft.languages.length >= RESUME_LIMITS.languages}
              onClick={() => patch({ languages: [...draft.languages, { name: '', level: 'B2' }] })}
              data-testid="resume-facts-languages-add"
            >
              <Plus className="mr-1.5 size-4" aria-hidden />
              <Trans>Додати мову</Trans>
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            {fieldError('languages.add')}
            {draft.languages.map((language, index) => {
              const position = index + 1
              const set = (changes: Partial<typeof language>) =>
                patch({
                  languages: draft.languages.map((l, i) =>
                    i === index ? { ...l, ...changes } : l,
                  ),
                })
              return (
                <div key={index} className="flex items-start gap-2">
                  <div className="grid flex-1 gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor={factsFieldId(`languages.${index}.name`)}>
                        <Trans>Мова</Trans>
                      </Label>
                      <Input
                        {...a11y(`languages.${index}.name`)}
                        aria-label={t`Мова, рядок ${position}`}
                        value={language.name}
                        maxLength={RESUME_LIMITS.shortText}
                        onChange={(e) => set({ name: e.target.value })}
                        name="resumeFactsLanguage"
                      />
                      {fieldError(`languages.${index}.name`)}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor={factsFieldId(`languages.${index}.level`)}>
                        <Trans>Рівень</Trans>
                      </Label>
                      <Select
                        value={language.level}
                        onValueChange={(level) =>
                          set({ level: level as (typeof RESUME_LANGUAGE_LEVELS)[number] })
                        }
                        disabled={disabled}
                      >
                        <SelectTrigger
                          id={factsFieldId(`languages.${index}.level`)}
                          aria-label={t`Рівень, рядок ${position}`}
                          className="h-11 sm:h-9"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {RESUME_LANGUAGE_LEVELS.map((level) => (
                            <SelectItem key={level} value={level}>
                              {level === 'native' ? t`Рідна` : level}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <IconButton
                    label={t`Видалити мову ${position}`}
                    destructive
                    onClick={() =>
                      patch({ languages: draft.languages.filter((_, i) => i !== index) })
                    }
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </IconButton>
                </div>
              )
            })}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
            <CardTitle className="text-base">
              <Trans context="resume">Посилання</Trans>
            </CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-11 sm:h-9"
              disabled={draft.links.length >= RESUME_LIMITS.links}
              onClick={() => patch({ links: [...draft.links, { label: '', url: '' }] })}
            >
              <Plus className="mr-1.5 size-4" aria-hidden />
              <Trans>Додати посилання</Trans>
            </Button>
          </CardHeader>
          {draft.links.length > 0 && (
            <CardContent className="space-y-3">
              {draft.links.map((link, index) => {
                const position = index + 1
                const set = (changes: Partial<typeof link>) =>
                  patch({
                    links: draft.links.map((l, i) => (i === index ? { ...l, ...changes } : l)),
                  })
                return (
                  <div key={index} className="flex items-start gap-2">
                    <div className="grid flex-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor={factsFieldId(`links.${index}.label`)}>
                          <Trans context="resume">Назва</Trans>
                        </Label>
                        <Input
                          {...a11y(`links.${index}.label`)}
                          aria-label={t`Назва, посилання ${position}`}
                          value={link.label}
                          maxLength={RESUME_LIMITS.shortText}
                          onChange={(e) => set({ label: e.target.value })}
                          name="resumeFactsLinkLabel"
                        />
                        {fieldError(`links.${index}.label`)}
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor={factsFieldId(`links.${index}.url`)}>
                          <Trans>Адреса посилання</Trans>
                        </Label>
                        <Input
                          {...a11y(`links.${index}.url`)}
                          type="url"
                          aria-label={t`Адреса посилання, рядок ${position}`}
                          placeholder={t`https://… або mailto:…`}
                          value={link.url}
                          onChange={(e) => set({ url: e.target.value })}
                          name="resumeFactsLinkUrl"
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                        />
                        {fieldError(`links.${index}.url`)}
                      </div>
                    </div>
                    <IconButton
                      label={t`Видалити посилання ${position}`}
                      destructive
                      onClick={() => patch({ links: draft.links.filter((_, i) => i !== index) })}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </IconButton>
                  </div>
                )
              })}
            </CardContent>
          )}
        </Card>
      </fieldset>
    </div>
  )
}
