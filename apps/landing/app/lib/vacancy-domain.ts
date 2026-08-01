import type { PublicVacancy, VacancyDomain } from '@crm/shared'
import type { TagVariant } from '@/components/ui/tag'
import type { Dictionary } from '@/i18n/dictionary'

/**
 * Maps the API's `VacancyDomain` enum (AI | EDTECH | ECOMMERCE | OTHER) to the
 * marketing `Tag` variant + display label used on VacancyCard and the vacancy
 * detail page. `OTHER` renders as the neutral tag style (landing-redesign.md
 * §3.3 only defines 3 domain hues on purpose).
 *
 * Domain/employment-type LABELS are locale-aware (task-landing-i18n.md) —
 * `domainLabel`/`employmentTypeLabel` take a REQUIRED `dict` slice
 * (`Dictionary['vacancy']`). No default here on purpose (review round 1,
 * HIGH-1b): a default value referencing ANY concrete locale dictionary would
 * force-import that dictionary's module into every file that imports this
 * one, regardless of whether the default is ever hit — the exact
 * non-code-split bug this same review round fixed for the `Dictionary`
 * barrel itself. Every real call site (`vacancy-card.tsx`,
 * `vacancy-detail-page-content.tsx`) already threads its own `dict` through.
 */
const DOMAIN_TAG_VARIANT: Record<VacancyDomain, TagVariant> = {
  AI: 'ai',
  EDTECH: 'edtech',
  ECOMMERCE: 'ecommerce',
  OTHER: 'neutral',
}

export function domainTagVariant(domain: VacancyDomain): TagVariant {
  return DOMAIN_TAG_VARIANT[domain]
}

export function domainLabel(domain: VacancyDomain, dict: Dictionary['vacancy']): string {
  return dict.domainLabels[domain]
}

export function employmentTypeLabel(type: string, dict: Dictionary['vacancy']): string {
  const labels = dict.employmentTypeLabels as Record<string, string>
  return labels[type] ?? type
}

/**
 * task-vacancy-salary-range (owner decision 2026-07-31) — "3000–5000 USDT ·
 * per month" style range for VacancyCard/vacancy-detail-page-content. `null`
 * (caller renders nothing) unless ALL 4 salary fields are set — a legacy
 * vacancy without a range (AC3) must not show a fabricated/partial one.
 *
 * Numbers/currency are deliberately NOT locale-formatted (owner: "Сами числа
 * и валюта не переводятся") — plain digits, no `Intl.NumberFormat` grouping,
 * so the figure reads identically on every one of the 5 site locales; only
 * the trailing period word is localized (`dict.salaryPeriodLabels`).
 */
export function formatSalaryRange(
  vacancy: Pick<PublicVacancy, 'salaryMin' | 'salaryMax' | 'salaryCurrency' | 'salaryPeriod'>,
  dict: Dictionary['vacancy'],
): string | null {
  const { salaryMin, salaryMax, salaryCurrency, salaryPeriod } = vacancy
  if (
    salaryMin === null ||
    salaryMax === null ||
    salaryCurrency === null ||
    salaryPeriod === null
  ) {
    return null
  }
  const min = formatSalaryAmount(salaryMin)
  const max = formatSalaryAmount(salaryMax)
  if (min === null || max === null) return null
  const period = dict.salaryPeriodLabels[salaryPeriod]
  return `${min}–${max} ${salaryCurrency} · ${period}`
}

/** `'3000.00'` -> `'3000'`; `'3250.50'` -> `'3250.5'` (Number() drops trailing zeros). */
function formatSalaryAmount(raw: string): string | null {
  const n = Number(raw)
  return Number.isFinite(n) ? String(n) : null
}
