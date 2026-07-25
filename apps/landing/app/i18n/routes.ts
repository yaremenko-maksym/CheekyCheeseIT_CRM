import type { Locale } from './locale'

/**
 * Typed, per-locale `<Link to>` targets (task-landing-i18n.md) — TanStack
 * Router's generated `Register`/`FileRouteTypes` (see `router.tsx`) type-
 * checks `to` against the EXACT set of registered route paths, so a plain
 * `localizedPath()`-computed string does not satisfy it. These 3 tiny
 * switches are the single place that maps `Locale` -> the literal route
 * path strings the 5 parallel route FILES register (`routes/index.tsx` +
 * `routes/uk.tsx`/`ru.tsx`/`es.tsx`/`pt.tsx`, and their `.careers`/
 * `.careers_.$slug` siblings) — every internal `<Link>` in `nav.tsx`/
 * `footer.tsx`/`vacancy-card.tsx`/etc. goes through these instead of
 * hand-writing the prefix per call site.
 *
 * Trailing-slash-terminated — matches the router's `trailingSlash: 'always'`
 * (`router.tsx`): TanStack's generated `to` union is the EXACT registered
 * path strings, always WITH the trailing slash (verified against the real
 * `routeTree.gen.ts` after `vite build`).
 */
export type HomeRoutePath = '/' | '/uk/' | '/ru/' | '/es/' | '/pt/'
export type CareersRoutePath =
  | '/careers/'
  | '/uk/careers/'
  | '/ru/careers/'
  | '/es/careers/'
  | '/pt/careers/'
export type CareersSlugRoutePath =
  | '/careers/$slug/'
  | '/uk/careers/$slug/'
  | '/ru/careers/$slug/'
  | '/es/careers/$slug/'
  | '/pt/careers/$slug/'

export function homeRoutePath(locale: Locale): HomeRoutePath {
  switch (locale) {
    case 'uk':
      return '/uk/'
    case 'ru':
      return '/ru/'
    case 'es':
      return '/es/'
    case 'pt':
      return '/pt/'
    default:
      return '/'
  }
}

export function careersRoutePath(locale: Locale): CareersRoutePath {
  switch (locale) {
    case 'uk':
      return '/uk/careers/'
    case 'ru':
      return '/ru/careers/'
    case 'es':
      return '/es/careers/'
    case 'pt':
      return '/pt/careers/'
    default:
      return '/careers/'
  }
}

export function careersSlugRoutePath(locale: Locale): CareersSlugRoutePath {
  switch (locale) {
    case 'uk':
      return '/uk/careers/$slug/'
    case 'ru':
      return '/ru/careers/$slug/'
    case 'es':
      return '/es/careers/$slug/'
    case 'pt':
      return '/pt/careers/$slug/'
    default:
      return '/careers/$slug/'
  }
}
