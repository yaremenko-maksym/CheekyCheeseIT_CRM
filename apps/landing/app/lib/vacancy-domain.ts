import type { VacancyDomain } from '@crm/shared'
import type { TagVariant } from '@/components/ui/tag'
import type { Dictionary } from '@/i18n/dictionary'
import { DEFAULT_LOCALE } from '@/i18n/locale'
import { getDictionary } from '@/i18n/dictionaries'

/**
 * Maps the API's `VacancyDomain` enum (AI | EDTECH | ECOMMERCE | OTHER) to the
 * marketing `Tag` variant + display label used on VacancyCard and the vacancy
 * detail page. `OTHER` renders as the neutral tag style (landing-redesign.md
 * §3.3 only defines 3 domain hues on purpose).
 *
 * Domain/employment-type LABELS are locale-aware (task-landing-i18n.md) —
 * `domainLabel`/`employmentTypeLabel` take an optional `dict` slice
 * (`Dictionary['vacancy']`, defaulting to `en`) so every call site not yet
 * threading a locale (existing tests) keeps working unchanged.
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

const DEFAULT_VACANCY_DICT = getDictionary(DEFAULT_LOCALE).vacancy

export function domainLabel(
  domain: VacancyDomain,
  dict: Dictionary['vacancy'] = DEFAULT_VACANCY_DICT,
): string {
  return dict.domainLabels[domain]
}

export function employmentTypeLabel(
  type: string,
  dict: Dictionary['vacancy'] = DEFAULT_VACANCY_DICT,
): string {
  const labels = dict.employmentTypeLabels as Record<string, string>
  return labels[type] ?? type
}
