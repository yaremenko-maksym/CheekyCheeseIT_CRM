import type { PublicVacancy, PublicVacancyDetail, VacancyEmploymentType } from '@crm/shared'
import { CONTACT_EMAIL } from '@/content/home'

/**
 * task-landing-seo-prerender.md — SEO constants + schema.org JSON-LD builders.
 *
 * Kept as pure functions (no `document`/`window`) so they are usable from
 * BOTH the live SPA (`useDocumentHead` injects the result into
 * `<script type="application/ld+json">`, see `use-document-head.ts`) and
 * plain unit tests (`__tests__/seo.spec.ts`) — no browser environment needed.
 *
 * `SITE_ORIGIN` here MUST be kept in sync with the identical literal in
 * `scripts/prerender.mjs` (plain Node ESM — cannot import this `.ts` module
 * without a build step, so the domain is duplicated in exactly those two
 * places; both call this out in a comment).
 */
export const SITE_ORIGIN = 'https://cheekycheese.tech'
export const SITE_NAME = 'CheekyCheeseIT'

/**
 * Absolute canonical/OG URL for a given site-relative pathname (e.g.
 * `/careers`). Always trailing-slash-terminated — matches the router's
 * `trailingSlash: 'always'` (see `router.tsx`) and the directory-per-route
 * layout `scripts/prerender.mjs` writes (`/careers/<slug>` ->
 * `dist/careers/<slug>/index.html`), so the canonical URL is exactly what
 * prod nginx serves as a 200 with no redirect hop in between.
 */
export function canonicalUrl(pathname: string): string {
  const withSlash = pathname.endsWith('/') ? pathname : `${pathname}/`
  return `${SITE_ORIGIN}${withSlash}`
}

export interface OrganizationJsonLd {
  '@context': 'https://schema.org'
  '@type': 'Organization'
  name: string
  url: string
  email: string
}

/** `/` — Organization structured data (task §2). */
export function buildOrganizationJsonLd(): OrganizationJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE_NAME,
    url: SITE_ORIGIN,
    email: CONTACT_EMAIL,
  }
}

export interface WebSiteJsonLd {
  '@context': 'https://schema.org'
  '@type': 'WebSite'
  name: string
  url: string
}

/** `/` — WebSite structured data (task §2). */
export function buildWebSiteJsonLd(): WebSiteJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    url: SITE_ORIGIN,
  }
}

// -----------------------------------------------------------------------------
// JobPosting (Google Jobs) — owner requirement 2026-07-24: full compliance so
// vacancies actually surface in Google Jobs + rank for title-bearing queries.
// -----------------------------------------------------------------------------

// schema.org/Google's EmploymentType enum uses CONTRACTOR, not CONTRACT — our
// internal enum (packages/shared vacancyEmploymentTypeSchema, used by the
// admin CRM's data-entry UI + already-live prod rows) intentionally stays
// CONTRACT; renaming it is out of this task's apps/landing-only scope and is
// a breaking schema change elsewhere. Map only at this JSON-LD boundary.
const GOOGLE_EMPLOYMENT_TYPE: Record<VacancyEmploymentType, string> = {
  FULL_TIME: 'FULL_TIME',
  PART_TIME: 'PART_TIME',
  CONTRACT: 'CONTRACTOR',
}

const VALID_THROUGH_DAYS = 60

/**
 * `validThrough` = generation time + 60 days, ROLLING — owner decision
 * 2026-07-24: every prerender rebuild recomputes this from `Date.now()` at
 * the moment this function runs, which (when driven by
 * `scripts/prerender.mjs`'s headless snapshot, not a live visitor's
 * browser) IS "prerender generation time" — the snapshot freezes whatever
 * this evaluates to at build time into the static file. A stale
 * `validThrough` that keeps slipping into the past is exactly what makes
 * Google stop showing a listing, so this must be recomputed on every build,
 * not hardcoded once.
 */
function buildValidThrough(): string {
  return new Date(Date.now() + VALID_THROUGH_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

export interface RemoteLocationInfo {
  jobLocationType: 'TELECOMMUTE'
  applicantLocationRequirements: { '@type': 'Country'; name: string }
}

/**
 * Best-effort remote-location parsing for Google Jobs' `jobLocationType` +
 * `applicantLocationRequirements` (owner decision 2026-07-24). Google flags
 * a TELECOMMUTE listing as a Search Console error if
 * `applicantLocationRequirements` is missing, so the two always travel
 * together — https://developers.google.com/search/docs/appearance/structured-data/job-posting.
 *
 * Returns `null` (no jobLocationType at all — correct for a real on-site
 * role, matching Google's guidance that the field is remote-only) unless
 * `location` mentions "remote". Every current vacancy does — CheekyCheeseIT
 * is remote-first by business model — so this is effectively always
 * TELECOMMUTE today; the on-site branch exists for correctness, not because
 * it's exercised by real data yet.
 *
 * "Best-effort" per owner's own framing — this is intentionally simple
 * regex parsing of a free-text admin-entered field, not a geocoder:
 *   - exactly "Remote" (no qualifier)  -> Worldwide (honest: no stated restriction)
 *   - "Remote (Region)"                -> Region, verbatim (owner's own example)
 *   - anything else mentioning remote  -> Country: UA fallback (owner's explicit
 *     instruction for the unparseable case — CheekyCheeseIT is Ukraine-based, so
 *     this is a safe floor, not a guess at an unstated restriction)
 */
export function parseRemoteLocation(location: string): RemoteLocationInfo | null {
  if (!/remote/i.test(location)) return null

  const regionMatch = location.match(/\(([^)]+)\)/)
  const name = regionMatch
    ? regionMatch[1]!.trim()
    : /^remote$/i.test(location.trim())
      ? 'Worldwide'
      : 'UA'

  return {
    jobLocationType: 'TELECOMMUTE',
    applicantLocationRequirements: { '@type': 'Country', name },
  }
}

export interface JobPostingJsonLd {
  '@context': 'https://schema.org'
  '@type': 'JobPosting'
  title: string
  description: string
  datePosted: string
  validThrough: string
  employmentType: string
  hiringOrganization: { '@type': 'Organization'; name: string; sameAs: string }
  directApply: true
  identifier: { '@type': 'PropertyValue'; name: string; value: string }
  url: string
  jobLocationType?: 'TELECOMMUTE'
  applicantLocationRequirements?: { '@type': 'Country'; name: string }
}

/**
 * `/careers/:slug` — JobPosting structured data for Google Jobs (task §2,
 * extended to full compliance 2026-07-24). Deliberately has NO salary field
 * — by product design (see `packages/shared/src/schemas/vacancies.ts`
 * module doc), not an omission.
 *
 * `descriptionHtml` — the FULL rendered vacancy description as HTML, not
 * the raw Markdown source or a truncated snippet (Google explicitly accepts
 * HTML-formatted descriptions and recommends the complete posting text, not
 * an excerpt). The caller (`routes/careers_.$slug.tsx`, a `.tsx` file with
 * JSX available) computes this via
 * `renderToStaticMarkup(<MarkdownBody markdown={...} />)` — the SAME
 * markdown renderer/plugins that render the visible page, so the JSON-LD
 * description can never drift from what a human sees. `seo.ts` stays a
 * plain `.ts` module (no JSX) on purpose, so this function takes the
 * pre-rendered string rather than doing that conversion itself.
 */
export function buildJobPostingJsonLd(
  vacancy: PublicVacancyDetail,
  descriptionHtml: string,
): JobPostingJsonLd {
  const remote = parseRemoteLocation(vacancy.location)
  return {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: vacancy.title,
    description: descriptionHtml,
    datePosted: vacancy.publishedAt,
    validThrough: buildValidThrough(),
    employmentType: GOOGLE_EMPLOYMENT_TYPE[vacancy.employmentType],
    hiringOrganization: { '@type': 'Organization', name: SITE_NAME, sameAs: SITE_ORIGIN },
    // We accept applications directly through our own form (VacancyApplyForm)
    // with no external redirect — the literal condition Google's docs define
    // `directApply` for.
    directApply: true,
    identifier: { '@type': 'PropertyValue', name: SITE_NAME, value: vacancy.slug },
    url: canonicalUrl(`/careers/${vacancy.slug}`),
    ...(remote ?? {}),
  }
}

export interface BreadcrumbListJsonLd {
  '@context': 'https://schema.org'
  '@type': 'BreadcrumbList'
  itemListElement: Array<{ '@type': 'ListItem'; position: number; name: string; item: string }>
}

/** `/careers/:slug` — Home → Careers → <Job Title> (owner decision 2026-07-24). */
export function buildBreadcrumbListJsonLd(
  vacancy: Pick<PublicVacancyDetail, 'title' | 'slug'>,
): BreadcrumbListJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: canonicalUrl('/') },
      { '@type': 'ListItem', position: 2, name: 'Careers', item: canonicalUrl('/careers') },
      {
        '@type': 'ListItem',
        position: 3,
        name: vacancy.title,
        item: canonicalUrl(`/careers/${vacancy.slug}`),
      },
    ],
  }
}

export interface ItemListJsonLd {
  '@context': 'https://schema.org'
  '@type': 'ItemList'
  itemListElement: Array<{ '@type': 'ListItem'; position: number; url: string; name: string }>
}

/** `/careers` — the live PUBLISHED roles as a schema.org list (owner decision 2026-07-24). */
export function buildItemListJsonLd(vacancies: PublicVacancy[]): ItemListJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: vacancies.map((vacancy, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      url: canonicalUrl(`/careers/${vacancy.slug}`),
      name: vacancy.title,
    })),
  }
}

// -----------------------------------------------------------------------------
// Markdown -> plain-text meta description (owner decision 2026-07-24: real
// content instead of a synthesized sentence, for title-bearing search queries).
// -----------------------------------------------------------------------------

/**
 * Deliberately simple regex-based Markdown stripping (no new dependency —
 * version-pins.md — and not meant to be a full CommonMark parser). Good
 * enough to turn a vacancy's real description into readable plain-text
 * search-snippet copy instead of hand-synthesized boilerplate.
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [text](url) -> text
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/^\s*[-*+]\s+/gm, '') // bullet markers
    .replace(/^\s*\d+\.\s+/gm, '') // numbered-list markers
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1') // bold/italic/strikethrough
    .replace(/\s+/g, ' ')
    .trim()
}

const META_DESCRIPTION_MAX_LENGTH = 155

/** Truncates on a word boundary + adds an ellipsis, never mid-word. */
export function truncateForMetaDescription(
  text: string,
  maxLength: number = META_DESCRIPTION_MAX_LENGTH,
): string {
  if (text.length <= maxLength) return text
  const truncated = text.slice(0, maxLength)
  const lastSpace = truncated.lastIndexOf(' ')
  const clipped = lastSpace > maxLength * 0.6 ? truncated.slice(0, lastSpace) : truncated
  return `${clipped.trimEnd()}…`
}
