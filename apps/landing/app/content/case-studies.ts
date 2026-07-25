/**
 * "Selected work" case-study copy moved into the `Dictionary` shape
 * (`i18n/dictionary.ts` `home.caseStudies` + `i18n/dictionaries/*.ts`,
 * task-landing-i18n.md) — it's locale-dependent marketing text, same as
 * `services`/`processSteps`/`stats` (see `content/home.ts`'s module doc).
 * This file re-exports the TYPES so `CaseStudyCard` keeps importing from
 * `@/content/case-studies` unchanged.
 */
export type { CaseStudy, CaseStudyMetric } from '@/i18n/dictionary'
