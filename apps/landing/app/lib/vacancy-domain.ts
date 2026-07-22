import type { VacancyDomain } from '@crm/shared'
import type { TagVariant } from '@/components/ui/tag'

/**
 * Maps the API's `VacancyDomain` enum (AI | EDTECH | ECOMMERCE | OTHER) to the
 * marketing `Tag` variant + display label used on VacancyCard and the vacancy
 * detail page. `OTHER` renders as the neutral tag style (landing-redesign.md
 * §3.3 only defines 3 domain hues on purpose).
 */
const DOMAIN_TAG_VARIANT: Record<VacancyDomain, TagVariant> = {
  AI: 'ai',
  EDTECH: 'edtech',
  ECOMMERCE: 'ecommerce',
  OTHER: 'neutral',
}

const DOMAIN_LABEL: Record<VacancyDomain, string> = {
  AI: 'AI / ML',
  EDTECH: 'EdTech',
  ECOMMERCE: 'E-Commerce',
  OTHER: 'Other',
}

export function domainTagVariant(domain: VacancyDomain): TagVariant {
  return DOMAIN_TAG_VARIANT[domain]
}

export function domainLabel(domain: VacancyDomain): string {
  return DOMAIN_LABEL[domain]
}

const EMPLOYMENT_TYPE_LABEL: Record<string, string> = {
  FULL_TIME: 'Full-time',
  PART_TIME: 'Part-time',
  CONTRACT: 'Contract',
}

export function employmentTypeLabel(type: string): string {
  return EMPLOYMENT_TYPE_LABEL[type] ?? type
}
