import type { PublicVacancyDetail } from '@crm/shared'
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

/** Absolute canonical/OG URL for a given site-relative pathname (e.g. `/careers`). */
export function canonicalUrl(pathname: string): string {
  return `${SITE_ORIGIN}${pathname}`
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

export interface JobPostingJsonLd {
  '@context': 'https://schema.org'
  '@type': 'JobPosting'
  title: string
  description: string
  datePosted: string
  employmentType: string
  hiringOrganization: { '@type': 'Organization'; name: string; sameAs: string }
  jobLocationType: 'TELECOMMUTE'
  // Google requires applicantLocationRequirements when jobLocationType is
  // TELECOMMUTE (a listing without it is flagged as an error in Search
  // Console) — https://developers.google.com/search/docs/appearance/structured-data/job-posting.
  // CheekyCheeseIT hires remote-first with no country restriction (site copy:
  // "Remote-first, senior-only"), so "Worldwide" is the correct, honest value
  // for every vacancy — not a per-vacancy field in the data model.
  applicantLocationRequirements: { '@type': 'Country'; name: 'Worldwide' }
  identifier: { '@type': 'PropertyValue'; name: string; value: string }
  url: string
}

/**
 * `/careers/:slug` — JobPosting structured data for Google Jobs (task §2).
 * Deliberately has NO salary field — by product design (see
 * `packages/shared/src/schemas/vacancies.ts` module doc), not an omission.
 */
export function buildJobPostingJsonLd(vacancy: PublicVacancyDetail): JobPostingJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: vacancy.title,
    description: vacancy.descriptionMd,
    datePosted: vacancy.publishedAt,
    employmentType: vacancy.employmentType,
    hiringOrganization: { '@type': 'Organization', name: SITE_NAME, sameAs: SITE_ORIGIN },
    jobLocationType: 'TELECOMMUTE',
    applicantLocationRequirements: { '@type': 'Country', name: 'Worldwide' },
    identifier: { '@type': 'PropertyValue', name: SITE_NAME, value: vacancy.slug },
    url: canonicalUrl(`/careers/${vacancy.slug}`),
  }
}
