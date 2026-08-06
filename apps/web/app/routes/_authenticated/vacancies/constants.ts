/**
 * task-crm-vacancies-ui — labels / colors / small pure helpers shared by the
 * list route, detail route and the card components. Kept separate from the
 * route files so tests can import (slug generation, label maps) without
 * mounting the full page. Русский UI everywhere EXCEPT domain badges and
 * seniority (spec §0 / §3.5 / §3.6 — deliberate exceptions, not oversights).
 */
import type { z } from 'zod'
import type {
  CreateVacancyInput,
  Vacancy,
  VacancyApplicationStatus,
  VacancyDomain,
  VacancyEmploymentType,
  VacancySalaryCurrency,
  VacancySalaryPeriod,
  VacancySeniority,
  VacancyStatus,
  VacancyTranslationLocale,
  VacancyTranslations,
} from '@crm/shared'
import { VACANCY_DOMAINS, VACANCY_TRANSLATION_LOCALES } from '@crm/shared'

// ---------------------------------------------------------------------------
// task-vacancy-i18n-jobposting — translation tab labels. Driven by
// `VacancyTranslationLocale` (imported from `@crm/shared`, itself built off
// `VACANCY_TRANSLATION_LOCALES`) so a 6th language only needs an entry here,
// never a new tab/field wired by hand.
// ---------------------------------------------------------------------------

export const VACANCY_TRANSLATION_LOCALE_LABELS: Record<VacancyTranslationLocale, string> = {
  uk: 'Українська',
  ru: 'Русский',
  es: 'Español',
  pt: 'Português',
}

// ---------------------------------------------------------------------------
// task-vacancy-i18n-jobposting — form <-> DTO conversion for translations
// (C1) + JobPosting SEO enrichment (C3). Shared by `VacancySheet` (create/
// edit Sheet) AND `$vacancyId.tsx` (detail-page inline edit) — this
// particular logic is non-trivial (filtering/parsing), unlike the simpler
// per-file `emptyValues()`/`valuesFromVacancy()` duplication already
// established for the base fields (golden rule #8: no duplicated
// non-trivial logic).
// ---------------------------------------------------------------------------

export interface VacancyTranslationFormValues {
  title: string
  description: string
}

export type VacancyTranslationsFormValues = Record<
  VacancyTranslationLocale,
  VacancyTranslationFormValues
>

export function emptyTranslationsFormValues(): VacancyTranslationsFormValues {
  return Object.fromEntries(
    VACANCY_TRANSLATION_LOCALES.map((locale) => [locale, { title: '', description: '' }]),
  ) as VacancyTranslationsFormValues
}

export function translationsFormValuesFromVacancy(
  vacancy: Pick<Vacancy, 'translations'>,
): VacancyTranslationsFormValues {
  const values = emptyTranslationsFormValues()
  if (!vacancy.translations) return values
  for (const locale of VACANCY_TRANSLATION_LOCALES) {
    const translation = vacancy.translations[locale]
    if (translation)
      values[locale] = { title: translation.title, description: translation.description }
  }
  return values
}

/**
 * A locale is included ONLY when BOTH title AND description are non-empty —
 * `vacancyTranslationSchema` requires both together (min-length 3/10 chars
 * respectively), so a half-filled tab is simply not sent as a translation
 * rather than surfacing a separate partial-fill validation error.
 */
export function buildTranslationsDto(
  values: VacancyTranslationsFormValues,
): VacancyTranslations | null {
  const result: VacancyTranslations = {}
  for (const locale of VACANCY_TRANSLATION_LOCALES) {
    const { title, description } = values[locale]
    if (title.trim() && description.trim()) {
      result[locale] = { title: title.trim(), description: description.trim() }
    }
  }
  return Object.keys(result).length > 0 ? result : null
}

export interface VacancySeoFormValues {
  skills: string
  experienceMonths: string
  qualifications: string
  responsibilities: string
  jobBenefits: string
  workHours: string
}

export function emptySeoFormValues(): VacancySeoFormValues {
  return {
    skills: '',
    experienceMonths: '',
    qualifications: '',
    responsibilities: '',
    jobBenefits: '',
    workHours: '',
  }
}

export function seoFormValuesFromVacancy(
  vacancy: Pick<
    Vacancy,
    | 'skills'
    | 'experienceMonths'
    | 'qualifications'
    | 'responsibilities'
    | 'jobBenefits'
    | 'workHours'
  >,
): VacancySeoFormValues {
  return {
    skills: vacancy.skills?.join(', ') ?? '',
    experienceMonths: vacancy.experienceMonths !== null ? String(vacancy.experienceMonths) : '',
    qualifications: vacancy.qualifications ?? '',
    responsibilities: vacancy.responsibilities ?? '',
    jobBenefits: vacancy.jobBenefits ?? '',
    workHours: vacancy.workHours ?? '',
  }
}

type VacancySeoDto = Pick<
  CreateVacancyInput,
  | 'skills'
  | 'experienceMonths'
  | 'qualifications'
  | 'responsibilities'
  | 'jobBenefits'
  | 'workHours'
>

/** Empty text -> `null` (cleared/unset); a non-numeric experienceMonths is treated as unset, not a hard error. */
export function buildSeoFieldsDto(values: VacancySeoFormValues): VacancySeoDto {
  const skills = values.skills
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const experienceMonths =
    values.experienceMonths.trim() === '' ? NaN : Number(values.experienceMonths)
  return {
    skills: skills.length > 0 ? skills : null,
    experienceMonths: Number.isFinite(experienceMonths) ? experienceMonths : null,
    qualifications: values.qualifications.trim() || null,
    responsibilities: values.responsibilities.trim() || null,
    jobBenefits: values.jobBenefits.trim() || null,
    workHours: values.workHours.trim() || null,
  }
}

// ---------------------------------------------------------------------------
// task-vacancy-salary-range (owner decision 2026-07-31) — the salary range
// form fields, MANDATORY for a new vacancy (createVacancySchema) and for
// publishing any vacancy (VacanciesService.assertSalaryFilled). Unlike
// `VacancySeoFormValues` above, min/max are OMITTED (not sent as `null`) from
// the PATCH dto when their text input is empty — see `buildSalaryFieldsDto`'s
// doc for why: a legacy vacancy's still-missing range must not be force-set
// to `null` on every unrelated field edit, whereas `create` naturally fails
// its own "required" schema check when they're missing.
// ---------------------------------------------------------------------------

export interface VacancySalaryFormValues {
  salaryMin: string
  salaryMax: string
  salaryCurrency: VacancySalaryCurrency
  salaryPeriod: VacancySalaryPeriod
}

/** `USDT`/`MONTH` — same defaults the DB migration/manual-fill flow nudges the owner toward (owner already pays most SENIORs in USDT). */
export function emptySalaryFormValues(): VacancySalaryFormValues {
  return { salaryMin: '', salaryMax: '', salaryCurrency: 'USDT', salaryPeriod: 'MONTH' }
}

export function salaryFormValuesFromVacancy(
  vacancy: Pick<Vacancy, 'salaryMin' | 'salaryMax' | 'salaryCurrency' | 'salaryPeriod'>,
): VacancySalaryFormValues {
  return {
    salaryMin: vacancy.salaryMin ?? '',
    salaryMax: vacancy.salaryMax ?? '',
    salaryCurrency: vacancy.salaryCurrency ?? 'USDT',
    salaryPeriod: vacancy.salaryPeriod ?? 'MONTH',
  }
}

/**
 * `salaryCurrency`/`salaryPeriod` are ALWAYS sent (the Select always has SOME
 * value selected, same as domain/employmentType above) — only `salaryMin`/
 * `salaryMax` are conditionally OMITTED when their text input is empty, so a
 * legacy vacancy's still-missing amounts stay `undefined` (PATCH no-op) on an
 * edit that never touched them, instead of being force-written to an invalid
 * value. On `create`, an omitted salaryMin/salaryMax correctly fails
 * `createVacancySchema`'s "required" check (AC1) — the same UX as an empty
 * title/slug.
 */
export function buildSalaryFieldsDto(values: VacancySalaryFormValues): {
  salaryMin?: number
  salaryMax?: number
  salaryCurrency: VacancySalaryCurrency
  salaryPeriod: VacancySalaryPeriod
} {
  const min = values.salaryMin.trim() === '' ? NaN : Number(values.salaryMin)
  const max = values.salaryMax.trim() === '' ? NaN : Number(values.salaryMax)
  return {
    ...(Number.isFinite(min) ? { salaryMin: min } : {}),
    ...(Number.isFinite(max) ? { salaryMax: max } : {}),
    salaryCurrency: values.salaryCurrency,
    salaryPeriod: values.salaryPeriod,
  }
}

// ---------------------------------------------------------------------------
// task-vacancy-salary-range — publish gate. Mirrors `VacanciesService.
// assertSalaryFilled` (apps/api/src/vacancies/vacancies.service.ts) so the
// «Опубликовать»/«Восстановить» buttons are disabled+tooltipped BEFORE the
// request round-trips to the 400 the backend would return anyway (same
// "source of truth = backend, UI mirrors it" convention as
// `getVacancyDeleteGate`).
// ---------------------------------------------------------------------------

export interface VacancyPublishGate {
  canPublish: boolean
  /** Only meaningful when `canPublish` is false — reason shown in the Tooltip. */
  tooltip: string
}

export function getVacancyPublishGate(
  vacancy: Pick<Vacancy, 'salaryMin' | 'salaryMax' | 'salaryCurrency' | 'salaryPeriod'>,
): VacancyPublishGate {
  // `!= null` (loose) — NOT `!== null` — deliberately: the shared salary
  // fields schema is `.nullish()` (nullable AND optional), so a field can be
  // `undefined` as well as `null` on a READ DTO. Both mean "not filled in".
  const hasSalaryRange =
    vacancy.salaryMin != null &&
    vacancy.salaryMax != null &&
    vacancy.salaryCurrency != null &&
    vacancy.salaryPeriod != null
  return {
    canPublish: hasSalaryRange,
    tooltip: 'Укажите вилку зарплаты в форме редактирования перед публикацией',
  }
}

// ---------------------------------------------------------------------------
// design-review round 1 (PR #422, HIGH-2) — shared Zod-issue → Russian
// message mapping. Was a private copy inside `VacancyFormFields.tsx`; moved
// here (single source) now that `VacancyTranslationFields.tsx` AND
// `collectVacancyValidationErrors` below both need the exact same mapping —
// duplicating it a 2nd/3rd time would violate golden rule #8.
//
// Zod's default `.message` is raw English ("Invalid string: must match
// pattern /^[a-z0-9]+.../", "Too small: expected string to have >=10
// characters") — leaking that straight into the UI violates the project's
// hard "always Russian UI" rule (rules/common/russian-language.md). Maps the
// small set of issue codes these fields can actually produce (regex/min/max
// on plain strings) to Russian text instead of relying on the schema's
// message. `patternMsg` lets a field give a field-specific hint (e.g. slug's
// "латиница/цифры/дефис") instead of a generic "неверный формат".
// ---------------------------------------------------------------------------

export function zodIssueRu(
  issue: z.core.$ZodIssue | undefined,
  patternMsg?: string,
): string | undefined {
  if (!issue) return undefined
  if (issue.code === 'too_small' && 'minimum' in issue) return `Минимум ${issue.minimum} символов`
  if (issue.code === 'too_big' && 'maximum' in issue) return `Максимум ${issue.maximum} символов`
  if (issue.code === 'invalid_format') return patternMsg ?? 'Недопустимый формат'
  return 'Недопустимое значение'
}

// ---------------------------------------------------------------------------
// design-review round 1 (PR #422, HIGH-2) — the base (`title`/`slug`/
// `descriptionMd`/domain/employmentType) + translations + SEO fields are
// composed into the SAME dto shape identically in `VacancySheet.tsx` and
// `$vacancyId.tsx` — factored out here (was copy-pasted in both onSubmit
// handlers) so there is exactly ONE place that assembles the API payload.
// ---------------------------------------------------------------------------

export interface VacancyDtoFormValues {
  title: string
  slug: string
  descriptionMd: string
  domain: VacancyDomain
  employmentType: VacancyEmploymentType
  translations: VacancyTranslationsFormValues
  skills: VacancySeoFormValues['skills']
  experienceMonths: VacancySeoFormValues['experienceMonths']
  qualifications: VacancySeoFormValues['qualifications']
  responsibilities: VacancySeoFormValues['responsibilities']
  jobBenefits: VacancySeoFormValues['jobBenefits']
  workHours: VacancySeoFormValues['workHours']
  salaryMin: VacancySalaryFormValues['salaryMin']
  salaryMax: VacancySalaryFormValues['salaryMax']
  salaryCurrency: VacancySalaryFormValues['salaryCurrency']
  salaryPeriod: VacancySalaryFormValues['salaryPeriod']
}

export function buildVacancyDto(value: VacancyDtoFormValues) {
  return {
    title: value.title.trim(),
    slug: value.slug.trim(),
    descriptionMd: value.descriptionMd,
    domain: value.domain,
    employmentType: value.employmentType,
    translations: buildTranslationsDto(value.translations),
    ...buildSeoFieldsDto(value),
    ...buildSalaryFieldsDto(value),
  }
}

/**
 * design-review round 1 (PR #422, HIGH-2) — "ошибка валидации абсолютно
 * беззвучна": `VacancySheet`/`$vacancyId.tsx` used to `safeParse` the dto and
 * just `return` on failure — no toast, no field highlight, no console entry.
 * Worse with translation tabs: an invalid field could be sitting in a
 * currently-hidden tab, so the (already-silent) failure was now also
 * invisible even if the user DID look at the form.
 *
 * Turns a failed `safeParse` into:
 *   - `fields`: a `{ 'translations.uk.title': 'Минимум 3 символа', ... }` map
 *     (dot-path keyed, matching nested field names) — consumed by
 *     `computeVacancySubmitErrors` below.
 *   - `firstTranslationLocale`: which locale (if any) the FIRST issue
 *     belongs to, so the caller can switch the active tab to it.
 */
export interface VacancyValidationErrors {
  fields: Record<string, string>
  firstTranslationLocale: VacancyTranslationLocale | null
}

const TRANSLATION_LOCALE_SET: ReadonlySet<string> = new Set(VACANCY_TRANSLATION_LOCALES)

export function collectVacancyValidationErrors(
  dto: unknown,
  schema: z.ZodType,
): VacancyValidationErrors | null {
  const parsed = schema.safeParse(dto)
  if (parsed.success) return null

  const fields: Record<string, string> = {}
  let firstTranslationLocale: VacancyTranslationLocale | null = null
  for (const issue of parsed.error.issues) {
    const path = issue.path.join('.')
    if (!(path in fields)) fields[path] = zodIssueRu(issue) ?? 'Недопустимое значение'
    if (
      !firstTranslationLocale &&
      issue.path[0] === 'translations' &&
      typeof issue.path[1] === 'string' &&
      TRANSLATION_LOCALE_SET.has(issue.path[1])
    ) {
      firstTranslationLocale = issue.path[1] as VacancyTranslationLocale
    }
  }
  return { fields, firstTranslationLocale }
}

/** Bumping `nonce` while setting `locale` imperatively switches the active translation tab — used on a failed submit to surface an error hiding in an inactive tab (HIGH-2). */
export interface VacancyTranslationFocusRequest {
  locale: VacancyTranslationLocale
  nonce: number
}

/**
 * design-review round 1 (PR #422, HIGH-2 follow-up) — TWO earlier approaches
 * were tried and empirically disproven against a live scratch stack before
 * landing on this one:
 *
 *   1. A bare `{ fields }` return from `validators.onSubmit` — TanStack Form
 *      gives a field's OWN validator precedence over a form-level one for
 *      the same field, but a field's own validator only runs while that
 *      field is MOUNTED, so an inactive-tab field never got validated this
 *      way at all.
 *   2. Imperatively calling `formApi.setFieldMeta(path, ...)` from
 *      `onSubmitInvalid` — this DOES correctly write the error into
 *      TanStack's central `fieldMetaBase`, and it IS visible if the field
 *      happens to already be mounted. But `focusRequest`-driven tab
 *      switching mounts a BRAND NEW `<form.Field>` for that path right
 *      after, and (verified by reading `@tanstack/form-core`'s `FieldApi`
 *      source) that field's `mount()` cleanup unconditionally resets
 *      `errorMap` on ANY unmount, INCLUDING React StrictMode's dev-only
 *      double-invoke of a fresh mount's effects (mount→cleanup→mount) — the
 *      cleanup from that phantom unmount wiped the error before the field
 *      ever settled. (Confirmed this specific approach DOES work in a
 *      production build, where StrictMode's double-invoke doesn't happen —
 *      but `pnpm dev`, i.e. what Coder/Owner/User-Testing actually use
 *      day-to-day, is exactly where StrictMode IS active, so relying on it
 *      would have silently broken the fix for every local session.)
 *
 * This version sidesteps BOTH problems: submit-time errors are kept in the
 * PARENT form's own plain React state (`submitFieldErrors`, set in
 * `onSubmitInvalid`), never written into TanStack's `fieldMetaBase` at all —
 * so they're immune to any field's mount/unmount lifecycle. Each translation
 * field's rendered `err` falls back to `submitFieldErrors[path]` whenever
 * TanStack's own (mount-dependent) `field.state.meta.errors` is empty; see
 * `VacancyTranslationFields.tsx`. The caller is responsible for clearing the
 * relevant entry out of `submitFieldErrors` once the user edits that field
 * again (`onFieldEdited` prop) so a stale error doesn't linger forever.
 */
export function computeVacancySubmitErrors(
  value: VacancyDtoFormValues,
  schema: z.ZodType,
): VacancyValidationErrors | null {
  const dto = buildVacancyDto(value)
  return collectVacancyValidationErrors(dto, schema)
}

// ---------------------------------------------------------------------------
// §3.4 — domain badge text (latin) + dot color (fixed hue, not theme-derived)
// ---------------------------------------------------------------------------

/**
 * Latin on purpose (spec §3.4 — domain names are industry terms, unlike
 * `EMPLOYMENT_TYPE_LABELS` which are ordinary Russian words). The map is
 * `Record<VacancyDomain, …>`, so adding a value to `VACANCY_DOMAINS`
 * (`@crm/shared`) fails typecheck here until it has a label — the compiler,
 * not a reviewer, is what keeps a new domain from rendering as a raw
 * `HEALTHTECH` in the badge.
 */
export const DOMAIN_LABELS: Record<VacancyDomain, string> = {
  AI: 'AI',
  EDTECH: 'EdTech',
  ECOMMERCE: 'E-Commerce',
  FINTECH: 'FinTech',
  IGAMING: 'iGaming',
  ADULT: 'Adult',
  SAAS: 'SaaS',
  HEALTHTECH: 'HealthTech',
  ADTECH: 'AdTech',
  LOGISTICS: 'Logistics',
  PROPTECH: 'PropTech',
  TRAVEL: 'Travel',
  MEDIA: 'Media',
  WEB3: 'Web3',
  HRTECH: 'HR Tech',
  CYBERSEC: 'Cybersecurity',
  OTHER: 'Other',
}

/**
 * Select options for the domain field. DERIVED from `VACANCY_DOMAINS` rather
 * than hand-listed (a second copy of 17 values would drift the first time
 * someone appends a domain — this used to be a literal tuple in
 * `VacancyFormFields.tsx`), sorted by visible label so a 17-item Select can
 * be scanned alphabetically, with «Other» pinned last where a catch-all
 * belongs.
 */
export const DOMAIN_OPTIONS: readonly VacancyDomain[] = [
  ...VACANCY_DOMAINS.filter((d) => d !== 'OTHER').sort((a, b) =>
    DOMAIN_LABELS[a].localeCompare(DOMAIN_LABELS[b], 'en'),
  ),
  'OTHER',
]

/**
 * Only the three domains the brand actually has a hue for (`--tag-ai` /
 * `--tag-edtech` / `--tag-ecommerce`, landing-redesign.md §3.3). Everything
 * else — including the 13 domains added by task-domains-expansion — renders
 * dotless, exactly as `OTHER` always has (spec §3.4: falls back to
 * muted-foreground text only). Inventing 13 more badge hues is a design
 * decision, not a side effect of widening an enum; deliberately left to the
 * designer.
 */
const DOMAIN_DOT_COLORS: Partial<Record<VacancyDomain, string>> = {
  AI: 'var(--tag-ai)',
  EDTECH: 'var(--tag-edtech)',
  ECOMMERCE: 'var(--tag-ecommerce)',
}

/** `null` when the domain has no brand hue — the caller renders no dot. */
export function domainDotColor(domain: VacancyDomain): string | null {
  return DOMAIN_DOT_COLORS[domain] ?? null
}

// ---------------------------------------------------------------------------
// §3.6 — seniority stays latin (public job-title convention, not an internal
// CRM role — do not confuse with RoleSelect's SENIOR → «Синьор» translation).
// ---------------------------------------------------------------------------

export const SENIORITY_LABELS: Record<VacancySeniority, string> = {
  SENIOR: 'Senior',
  LEAD: 'Lead',
}

// ---------------------------------------------------------------------------
// §4.2 — employment type IS translated (ordinary Russian words, no clash).
// ---------------------------------------------------------------------------

export const EMPLOYMENT_TYPE_LABELS: Record<VacancyEmploymentType, string> = {
  FULL_TIME: 'Полная занятость',
  PART_TIME: 'Частичная занятость',
  CONTRACT: 'Проектная работа',
}

// ---------------------------------------------------------------------------
// task-vacancy-salary-range — period Select labels (Russian, translated —
// same convention as EMPLOYMENT_TYPE_LABELS above). Currency codes are shown
// verbatim (USDT/USD/EUR/UAH) — universal codes, not translated.
// ---------------------------------------------------------------------------

export const SALARY_PERIOD_LABELS: Record<VacancySalaryPeriod, string> = {
  HOUR: 'Час',
  DAY: 'День',
  WEEK: 'Неделя',
  MONTH: 'Месяц',
  YEAR: 'Год',
}

// ---------------------------------------------------------------------------
// §3.5 — vacancy status: label + badge variant + optional className override
// ---------------------------------------------------------------------------

export const VACANCY_STATUS_LABELS: Record<VacancyStatus, string> = {
  DRAFT: 'Черновик',
  PUBLISHED: 'Опубликовано',
  CLOSED: 'Закрыто',
}

export const VACANCY_STATUS_BADGE: Record<
  VacancyStatus,
  { variant: 'secondary' | 'status-active'; className?: string }
> = {
  DRAFT: { variant: 'secondary' },
  PUBLISHED: { variant: 'status-active' },
  CLOSED: { variant: 'secondary', className: 'border-red-500/30 bg-red-500/15 text-red-400' },
}

// ---------------------------------------------------------------------------
// task-vacancy-delete-closed — delete gate, mirrors `VacanciesService.remove`
// (apps/api/src/vacancies/vacancies.service.ts). DRAFT or CLOSED with zero
// applications may be deleted; PUBLISHED must be closed first; anything with
// applications never can (R2 resume files + history, cleaned only by the
// retention cron). Shared by `VacancyCard` (list) and `$vacancyId` (Опасная
// зона) instead of duplicating the same two-branch logic in both files.
// ---------------------------------------------------------------------------

export interface VacancyDeleteGate {
  canDelete: boolean
  /** Only meaningful when `canDelete` is false — reason shown in the Tooltip. */
  tooltip: string
}

export function getVacancyDeleteGate(
  vacancy: Pick<Vacancy, 'status' | 'applicationsCount'>,
): VacancyDeleteGate {
  if (vacancy.status === 'PUBLISHED') {
    return { canDelete: false, tooltip: 'Опубликованную вакансию нужно сначала закрыть' }
  }
  return {
    canDelete: vacancy.applicationsCount === 0,
    tooltip: 'Нельзя удалить вакансию с откликами',
  }
}

// ---------------------------------------------------------------------------
// §3.5 — application status: label + SegmentedToggle option order
// ---------------------------------------------------------------------------

export const APPLICATION_STATUS_LABELS: Record<VacancyApplicationStatus, string> = {
  NEW: 'Новый',
  VIEWED: 'Просмотрено',
  REJECTED: 'Отклонено',
}

export const APPLICATION_STATUS_ORDER: readonly VacancyApplicationStatus[] = [
  'NEW',
  'VIEWED',
  'REJECTED',
]

// ---------------------------------------------------------------------------
// §4.2 — slug auto-generation. Only for LATIN titles — transliterating
// Cyrillic → readable latin slugs is a whole feature on its own (spec:
// "не тривиально"), so a Cyrillic title just leaves the slug field empty
// for manual entry instead of emitting a wrong/unreadable slug.
// ---------------------------------------------------------------------------

const CYRILLIC_RE = /[а-яёіїєґ]/i
const SLUG_MAX_LEN = 80

/**
 * Kebab-case slug from a latin vacancy title, matching
 * `createVacancySchema.slug` (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, 3-80 chars).
 * Returns `''` when the title contains Cyrillic or reduces to nothing.
 */
export function slugifyTitle(title: string): string {
  const trimmed = title.trim()
  if (!trimmed || CYRILLIC_RE.test(trimmed)) return ''
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LEN)
    .replace(/-+$/g, '')
  return slug
}

// ---------------------------------------------------------------------------
// security-MED (PR #396 review) — read-side href guard for candidate-supplied
// external URLs (linkedinUrl/githubUrl). The WRITE-side schema
// (`applyVacancyFieldsSchema.linkedinUrl`/`.githubUrl`) already enforces
// `.url().startsWith('https://')`, but `vacancyApplicationSchema` (the READ
// DTO `CandidateCard` renders) does not re-assert the protocol — a legacy row
// or a future write path that skips the strict schema could carry
// `javascript:...`, and React does not block `javascript:` in a rendered
// `href`. This is defense-in-depth on the READ side only; the shared Zod
// schemas are intentionally NOT touched here (per review scope).
// ---------------------------------------------------------------------------

/**
 * Returns `url` unchanged when it starts with `http://` or `https://`,
 * otherwise `undefined` — callers render plain (non-clickable) text instead
 * of an `<a href>` for anything that fails the check.
 */
export function safeExternalHref(url: string): string | undefined {
  return /^https?:\/\//.test(url) ? url : undefined
}

// task-candidate-card-resume §3 / code-review round 2 — the telegram-handle
// validator (`safeTelegramHref`) moved to `@/lib/tg-url` — it is now also
// reused by UserProfileHeader.tsx/UserRow.tsx (see that file's doc comment
// for why), which sit outside the vacancies module and shouldn't reach into
// a route-scoped constants file. Import it from `@/lib/tg-url` directly.
