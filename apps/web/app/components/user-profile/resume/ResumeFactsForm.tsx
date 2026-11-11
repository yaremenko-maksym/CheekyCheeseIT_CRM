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
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
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
import { MonthPickerField } from '@/components/ui/month-picker'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { TechAutocompleteInput } from '@/components/ui/tech-autocomplete-input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  COMPLETENESS_MESSAGES,
  ResumeCompletenessPanel,
  factsFieldId,
  issueFieldPath,
} from './ResumeCompletenessPanel'

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
  const { t, i18n } = useLingui()
  const [draft, setDraft] = useState(facts)
  const [baseline, setBaseline] = useState(facts)
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const [pending, setPending] = useState<'save' | 'submit' | null>(null)

  // A new server value replaces the draft only when nothing unsaved is in it.
  if (facts !== baseline) {
    if (same(cleanFacts(draft), cleanFacts(baseline))) setDraft(facts)
    setBaseline(facts)
  }

  const dirty = !same(cleanFacts(draft), cleanFacts(baseline))
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

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

  function FieldError({ field }: { field: string }) {
    const codes = errorsByField.get(field)
    if (!touched.has(field) || !codes) return null
    return (
      <p id={`${factsFieldId(field)}-error`} className="text-xs text-destructive">
        {codes.map((code) => i18n._(COMPLETENESS_MESSAGES[code])).join(' ')}
      </p>
    )
  }

  function focusPath(path: string) {
    const field = issueFieldPath(path)
    if (field === null) return
    const el = document.getElementById(factsFieldId(field))
    if (!el) return
    const target = el.matches('input, textarea, button')
      ? el
      : (el.querySelector<HTMLElement>('input, textarea, button') ?? el)
    target.scrollIntoView?.({ block: 'center' })
    target.focus()
    touch(field)
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
  const save = () => run('save', () => onSave(cleanFacts(draft), { silent: false }))
  const submit = () =>
    run('submit', async () => {
      if (dirty) await onSave(cleanFacts(draft), { silent: true })
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
              <FieldError field="headline" />
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
                <FieldError field="location.city" />
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
                <FieldError field="location.country" />
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
            <FieldError field="skills" />
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
            <FieldError field="experience.add" />
            {draft.experience.map((job, index) => (
              <JobBlock
                key={index}
                job={job}
                index={index}
                count={draft.experience.length}
                nowMonth={nowMonth}
                a11y={a11y}
                FieldError={FieldError}
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
                      <Input
                        {...a11y(`${base}.institution`)}
                        aria-label={t`Навчальний заклад, освіта ${position}`}
                        placeholder={t`Навчальний заклад`}
                        value={item.institution}
                        maxLength={RESUME_LIMITS.shortText}
                        onChange={(e) => set({ institution: e.target.value })}
                        name="resumeFactsInstitution"
                      />
                      <Input
                        {...a11y(`${base}.degree`)}
                        aria-label={t`Ступінь / спеціальність, освіта ${position}`}
                        placeholder={t`Ступінь / спеціальність`}
                        value={item.degree}
                        maxLength={RESUME_LIMITS.shortText}
                        onChange={(e) => set({ degree: e.target.value })}
                        name="resumeFactsDegree"
                      />
                      <Input
                        {...a11y(`${base}.startYear`)}
                        type="number"
                        inputMode="numeric"
                        min={1950}
                        max={2100}
                        aria-label={t`Рік початку, освіта ${position}`}
                        placeholder={t`Рік початку`}
                        value={item.startYear ?? ''}
                        onChange={(e) => set({ startYear: year(e.target.value) })}
                        name="resumeFactsEducationStartYear"
                      />
                      <Input
                        {...a11y(`${base}.endYear`)}
                        type="number"
                        inputMode="numeric"
                        min={1950}
                        max={2100}
                        aria-label={t`Рік завершення, освіта ${position}`}
                        placeholder={t`Рік завершення`}
                        value={item.endYear ?? ''}
                        onChange={(e) => set({ endYear: year(e.target.value) })}
                        name="resumeFactsEducationEndYear"
                      />
                    </div>
                    <FieldError field={`${base}.institution`} />
                    <FieldError field={`${base}.degree`} />
                    <FieldError field={`${base}.endYear`} />
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
            <FieldError field="languages.add" />
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
                      <Input
                        {...a11y(`languages.${index}.name`)}
                        aria-label={t`Мова, рядок ${position}`}
                        placeholder={t`Мова`}
                        value={language.name}
                        maxLength={RESUME_LIMITS.shortText}
                        onChange={(e) => set({ name: e.target.value })}
                        name="resumeFactsLanguage"
                      />
                      <FieldError field={`languages.${index}.name`} />
                    </div>
                    <Select
                      value={language.level}
                      onValueChange={(level) =>
                        set({ level: level as (typeof RESUME_LANGUAGE_LEVELS)[number] })
                      }
                      disabled={disabled}
                    >
                      <SelectTrigger
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
              <Trans>Посилання</Trans>
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
                      <Input
                        aria-label={t`Назва посилання, рядок ${position}`}
                        placeholder={t`Назва`}
                        value={link.label}
                        maxLength={RESUME_LIMITS.shortText}
                        onChange={(e) => set({ label: e.target.value })}
                        name="resumeFactsLinkLabel"
                      />
                      <Input
                        type="url"
                        aria-label={t`Посилання, рядок ${position}`}
                        placeholder={t`https://… або mailto:…`}
                        value={link.url}
                        onChange={(e) => set({ url: e.target.value })}
                        name="resumeFactsLinkUrl"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                      />
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

type A11y = (
  field: string,
  extraDescribedBy?: string,
) => {
  id: string
  'aria-invalid': boolean | undefined
  'aria-describedby': string | undefined
  onBlur: () => void
}

function JobBlock({
  job,
  index,
  count,
  nowMonth,
  a11y,
  FieldError,
  onPatch,
  onMove,
  onRemove,
}: {
  job: ResumeFactsExperience
  index: number
  count: number
  nowMonth: string
  a11y: A11y
  FieldError: (props: { field: string }) => ReactNode
  onPatch: (changes: Partial<ResumeFactsExperience>) => void
  onMove: (to: number) => void
  onRemove: () => void
}) {
  const { t } = useLingui()
  const position = index + 1
  const base = `experience.${index}`
  const notesHintId = useId()
  const currentId = useId()
  const startA11y = a11y(`${base}.start`)
  const endA11y = a11y(`${base}.end`)

  return (
    <div className="space-y-3 rounded-lg border p-3" data-testid={`resume-facts-job-${index}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          <Trans>Місце роботи {position}</Trans>
        </p>
        <div className="flex shrink-0 gap-1">
          <IconButton
            label={t`Перемістити місце роботи ${position} вгору`}
            disabled={index === 0}
            onClick={() => onMove(index - 1)}
          >
            <ArrowUp className="size-4" aria-hidden />
          </IconButton>
          <IconButton
            label={t`Перемістити місце роботи ${position} вниз`}
            disabled={index === count - 1}
            onClick={() => onMove(index + 1)}
          >
            <ArrowDown className="size-4" aria-hidden />
          </IconButton>
          <IconButton label={t`Видалити місце роботи ${position}`} destructive onClick={onRemove}>
            <Trash2 className="size-4" aria-hidden />
          </IconButton>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={factsFieldId(`${base}.company`)}>
            <Trans>Компанія</Trans>
          </Label>
          <Input
            {...a11y(`${base}.company`)}
            aria-label={t`Компанія, місце роботи ${position}`}
            value={job.company}
            maxLength={RESUME_LIMITS.shortText}
            onChange={(e) => onPatch({ company: e.target.value })}
            name="resumeFactsCompany"
          />
          <FieldError field={`${base}.company`} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={factsFieldId(`${base}.role`)}>
            <Trans>Посада</Trans>
          </Label>
          <Input
            {...a11y(`${base}.role`)}
            aria-label={t`Посада, місце роботи ${position}`}
            value={job.role}
            maxLength={RESUME_LIMITS.shortText}
            onChange={(e) => onPatch({ role: e.target.value })}
            name="resumeFactsRole"
          />
          <FieldError field={`${base}.role`} />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={factsFieldId(`${base}.location`)}>
            <Trans>Локація (необов’язково)</Trans>
          </Label>
          <Input
            {...a11y(`${base}.location`)}
            aria-label={t`Локація, місце роботи ${position}`}
            value={job.location ?? ''}
            maxLength={RESUME_LIMITS.shortText}
            onChange={(e) => onPatch({ location: e.target.value === '' ? null : e.target.value })}
            name="resumeFactsJobLocation"
          />
          <FieldError field={`${base}.location`} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={startA11y.id}>
            <Trans>Початок</Trans>
          </Label>
          <MonthPickerField
            id={startA11y.id}
            value={job.start ?? ''}
            minMonth="1970-01"
            maxMonth={nowMonth}
            onChange={(start) => onPatch({ start })}
            aria-invalid={startA11y['aria-invalid']}
            aria-describedby={startA11y['aria-describedby']}
            monthAriaLabel={t`Місяць початку, місце роботи ${position}`}
            yearAriaLabel={t`Рік початку, місце роботи ${position}`}
          />
          <FieldError field={`${base}.start`} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={endA11y.id}>
            <Trans>Кінець</Trans>
          </Label>
          <MonthPickerField
            id={endA11y.id}
            value={job.end ?? ''}
            minMonth="1970-01"
            maxMonth={nowMonth}
            disabled={job.current}
            onChange={(end) => onPatch({ end })}
            aria-invalid={endA11y['aria-invalid']}
            aria-describedby={endA11y['aria-describedby']}
            monthAriaLabel={t`Місяць завершення, місце роботи ${position}`}
            yearAriaLabel={t`Рік завершення, місце роботи ${position}`}
          />
          <FieldError field={`${base}.end`} />
        </div>
      </div>

      <div className="flex min-h-11 items-center gap-2">
        <Switch
          id={currentId}
          checked={job.current}
          onCheckedChange={(current) => onPatch(current ? { current, end: null } : { current })}
        />
        <Label htmlFor={currentId}>
          <Trans>Працюю тут зараз</Trans>
        </Label>
      </div>

      <div className="space-y-1.5" id={factsFieldId(`${base}.technologies`)}>
        <p className="text-sm font-medium">
          <Trans>Технології</Trans>
        </p>
        <TechAutocompleteInput
          value={job.technologies}
          onChange={(technologies) => onPatch({ technologies })}
          maxItems={RESUME_LIMITS.skills}
          placeholder={t`Технології, місце роботи ${position}`}
          errorId={
            a11y(`${base}.technologies`)['aria-invalid']
              ? `${factsFieldId(`${base}.technologies`)}-error`
              : undefined
          }
        />
        <FieldError field={`${base}.technologies`} />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={factsFieldId(`${base}.notes`)}>
          <Trans>Нотатки про досягнення</Trans>
        </Label>
        <p id={notesHintId} className="text-xs text-muted-foreground">
          <Trans>По одній нотатці в рядку</Trans>
        </p>
        <Textarea
          {...a11y(`${base}.notes`, notesHintId)}
          aria-label={t`Нотатки, місце роботи ${position}`}
          rows={4}
          placeholder={t`Що ви зробили і з яким результатом`}
          value={job.notes.join('\n')}
          onChange={(e) => onPatch({ notes: lines(e.target.value) })}
          data-testid={`resume-facts-notes-${index}`}
        />
        <FieldError field={`${base}.notes`} />
      </div>
    </div>
  )
}

/** A bordered sub-block inside a card (not a card in a card). */
function RowBlock({
  title,
  removeLabel,
  onRemove,
  children,
}: {
  title: string
  removeLabel: string
  onRemove: () => void
  children: ReactNode
}) {
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{title}</p>
        <IconButton label={removeLabel} destructive onClick={onRemove}>
          <Trash2 className="size-4" aria-hidden />
        </IconButton>
      </div>
      {children}
    </div>
  )
}

/** Icon-only button: aria-label AND title (design §8), 44px on mobile. */
function IconButton({
  label,
  destructive = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string
  destructive?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn('size-11 shrink-0 sm:size-9', destructive && 'text-destructive')}
    >
      {children}
    </Button>
  )
}
