/**
 * task-crm-vacancies-ui — labels / colors / small pure helpers shared by the
 * list route, detail route and the card components. Kept separate from the
 * route files so tests can import (slug generation, label maps) without
 * mounting the full page. Русский UI everywhere EXCEPT domain badges and
 * seniority (spec §0 / §3.5 / §3.6 — deliberate exceptions, not oversights).
 */
import type {
  VacancyApplicationStatus,
  VacancyDomain,
  VacancyEmploymentType,
  VacancySeniority,
  VacancyStatus,
} from '@crm/shared'

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
