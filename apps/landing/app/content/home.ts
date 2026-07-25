/**
 * Locale-INVARIANT "/" content only (task-landing-i18n.md) — technology
 * names, the contact email and the teaser limit don't change per locale, so
 * they stay as plain exports here rather than being duplicated into all 5
 * `i18n/dictionaries/*.ts` files. Everything that DOES vary per locale
 * (stats/aboutBullets/services/processSteps copy) moved into the
 * `Dictionary` shape (`i18n/dictionary.ts` + `i18n/dictionaries/*.ts`) —
 * this file re-exports their TYPES so existing presentational components
 * (`StatStrip`, `ServiceCard`, `ProcessStep`, `CaseStudyCard`, ...) keep
 * importing from `@/content/home` unchanged.
 */
export type { StatItem, ServiceItem, ProcessStepItem } from '@/i18n/dictionary'

export const techStack: string[] = [
  'TypeScript',
  'React',
  'Next.js',
  'Node.js',
  'Python',
  'PyTorch',
  'TensorFlow',
  'Go',
  'PostgreSQL',
  'Redis',
  'GraphQL',
  'Kubernetes',
  'Docker',
  'AWS',
  'GCP',
  'Terraform',
  'Stripe',
  'Kafka',
]

/** Единственный контактный имейл на всём лендинге (task-landing-redesign.md AC3). */
export const CONTACT_EMAIL = 'hr@cheekycheese.tech'

/** Careers-тизер на "/" показывает максимум 3 живые вакансии (AC2). */
export const HOME_CAREERS_TEASER_LIMIT = 3
