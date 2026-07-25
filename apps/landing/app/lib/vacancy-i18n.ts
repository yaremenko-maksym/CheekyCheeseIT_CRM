import { NON_DEFAULT_LOCALES, type Locale } from '@/i18n/locale'

/**
 * plan-landing-i18n-seo.md §3 — `vacancies.translations` contract (Block C /
 * T3 owns the DB column + API; this file is the CONSUMER-side pure-function
 * half, usable the moment `lib/api.ts` starts returning the field — see that
 * file's module doc for the "мокай по контракту" note, task-landing-i18n.md).
 *
 * `en` is always the SOURCE language — a vacancy's `title`/`descriptionMd`
 * ARE the English content; `translations` only ever carries the 4
 * non-default locales.
 */
export interface VacancyTranslation {
  title: string
  description: string
}

export type VacancyTranslations = Partial<Record<Exclude<Locale, 'en'>, VacancyTranslation>>

export interface LocalizableVacancyFields {
  title: string
  translations?: VacancyTranslations | null | undefined
}

export interface LocalizableVacancyDetailFields extends LocalizableVacancyFields {
  descriptionMd: string
}

/** True when `locale` has no real translation for this vacancy — the fallback (original `en`) content is shown instead. `en` itself is never a fallback (it IS the source). */
export function isVacancyFallbackLocale(
  vacancy: LocalizableVacancyFields,
  locale: Locale,
): boolean {
  if (locale === 'en') return false
  return !vacancy.translations?.[locale]
}

/** Resolves the DISPLAYED title for `locale` — the real translation if present, else the original `en` title (plan §3 "при отсутствии перевода отдают оригинал"). */
export function resolveVacancyTitle(vacancy: LocalizableVacancyFields, locale: Locale): string {
  if (locale === 'en') return vacancy.title
  return vacancy.translations?.[locale]?.title ?? vacancy.title
}

/** Resolves the DISPLAYED Markdown description for `locale` — same fallback rule as `resolveVacancyTitle`. */
export function resolveVacancyDescription(
  vacancy: LocalizableVacancyDetailFields,
  locale: Locale,
): string {
  if (locale === 'en') return vacancy.descriptionMd
  return vacancy.translations?.[locale]?.description ?? vacancy.descriptionMd
}

/**
 * Locales with NO real translation for this vacancy — feed straight into
 * `lib/seo.ts` `buildHreflangAlternates()`'s `excludeLocales` (plan §3/A10:
 * "непереведённая — оригинал БЕЗ hreflang на неё" — duplicate/fallback
 * content must never be advertised as a genuine locale alternate). Always
 * the SAME set regardless of which locale is currently being viewed, so
 * every locale's own page for this vacancy prints the identical (reciprocal)
 * exclusion.
 */
export function vacancyHreflangExcludes(vacancy: LocalizableVacancyFields): Locale[] {
  return NON_DEFAULT_LOCALES.filter((locale) => !vacancy.translations?.[locale])
}
