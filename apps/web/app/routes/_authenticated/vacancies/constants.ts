/**
 * task-crm-vacancies-ui — labels / colors / small pure helpers shared by the
 * list route, detail route and the card components. Kept separate from the
 * route files so tests can import (slug generation, label maps) without
 * mounting the full page. Русский UI everywhere EXCEPT domain badges and
 * seniority (spec §0 / §3.5 / §3.6 — deliberate exceptions, not oversights).
 */
import type {
  CreateVacancyInput,
  Vacancy,
  VacancyApplicationStatus,
  VacancyDomain,
  VacancyEmploymentType,
  VacancySeniority,
  VacancyStatus,
  VacancyTranslationLocale,
  VacancyTranslations,
} from '@crm/shared'
import { VACANCY_TRANSLATION_LOCALES } from '@crm/shared'

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
// §3.4 — domain badge text (latin) + dot color (fixed hue, not theme-derived)
// ---------------------------------------------------------------------------

export const DOMAIN_LABELS: Record<VacancyDomain, string> = {
  AI: 'AI',
  EDTECH: 'EdTech',
  ECOMMERCE: 'E-Commerce',
  OTHER: 'Other',
}

/** `null` for OTHER — no colored dot, spec §3.4 (falls back to muted-foreground text only). */
export const DOMAIN_DOT_COLOR: Record<VacancyDomain, string | null> = {
  AI: 'var(--tag-ai)',
  EDTECH: 'var(--tag-edtech)',
  ECOMMERCE: 'var(--tag-ecommerce)',
  OTHER: null,
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
