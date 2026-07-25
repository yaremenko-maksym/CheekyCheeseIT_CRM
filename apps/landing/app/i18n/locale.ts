/**
 * task-landing-i18n.md / plan-landing-i18n-seo.md §1 — locale + URL-scheme
 * constants. `en` is the default locale AND the `x-default` hreflang target
 * (unprefixed URLs: `/`, `/careers/`, `/careers/<slug>/`); `ru`/`uk` are
 * prefixed (`/ru/…`, `/uk/…`).
 *
 * Locale is determined EXCLUSIVELY by which route file matched the URL (see
 * `routes/index.tsx` vs `routes/ru.tsx` vs `routes/uk.tsx` etc.) — every
 * consumer of `Locale` in this app receives it as a plain prop/argument
 * hardcoded at the route-file level, never derived from `navigator.language`,
 * `Accept-Language`, or any other client-side signal (plan §2 "без
 * моргания" — the hard requirement that locale is decided ONLY at render
 * time from the URL, never after hydration).
 */
export const LOCALES = ['en', 'ru', 'uk'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'

/** Locales other than the default — used to build hreflang alternate sets. */
export const NON_DEFAULT_LOCALES = LOCALES.filter((l) => l !== DEFAULT_LOCALE) as Exclude<
  Locale,
  typeof DEFAULT_LOCALE
>[]

/** Human-readable per-locale label for the language switcher UI. */
export const LOCALE_LABEL: Record<Locale, string> = {
  en: 'EN',
  ru: 'RU',
  uk: 'UA',
}

/** `document.cookie` name the switcher writes (plan §2, read by nginx edge-detection, Block B). */
export const LOCALE_COOKIE_NAME = 'pref_locale'

/** One year, in seconds — matches plan §2 "cookie `pref_locale` (`en|ru|uk`, 1 год)". */
export const LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

/** URL path prefix for a locale — `''` for `en` (unprefixed), `/ru` / `/uk` otherwise. */
export function localePrefix(locale: Locale): string {
  return locale === DEFAULT_LOCALE ? '' : `/${locale}`
}

/**
 * Builds this-locale's version of a locale-agnostic, ROOT-RELATIVE path
 * (e.g. `/careers` or `/careers/my-slug`, no trailing slash — same
 * convention `canonicalUrl()` normalizes at the end). Always trailing-
 * slash-terminated, matching `router.tsx`'s `trailingSlash: 'always'`.
 */
export function localizedPath(locale: Locale, path: string): string {
  const prefix = localePrefix(locale)
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`
  const withoutTrailingSlash =
    withLeadingSlash.length > 1 && withLeadingSlash.endsWith('/')
      ? withLeadingSlash.slice(0, -1)
      : withLeadingSlash
  if (withoutTrailingSlash === '/') return prefix === '' ? '/' : `${prefix}/`
  return `${prefix}${withoutTrailingSlash}/`
}

/** Writes the `pref_locale` cookie (language-switcher click, plan §2). Same-origin, `Lax` is the safe default for a top-level nav link. */
export function writeLocaleCookie(locale: Locale): void {
  if (typeof document === 'undefined') return
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`
}
