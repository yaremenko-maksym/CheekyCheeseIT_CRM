/**
 * task-landing-seo-prerender.md AC3 "JSON-LD проходит структурную валидацию
 * (скриптом/тестом)" — this file is the "тестом" half (pure builder
 * functions, no DOM needed). The "скриптом" half is the runtime
 * `assertJsonLd()` check inside `scripts/prerender.mjs` itself, covered by
 * app/__tests__/prerender-seo.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import type { PublicVacancyDetail } from '@crm/shared'
import {
  SITE_ORIGIN,
  buildJobPostingJsonLd,
  buildOrganizationJsonLd,
  buildWebSiteJsonLd,
  canonicalUrl,
} from '@/lib/seo'

describe('canonicalUrl', () => {
  it('builds an absolute URL under SITE_ORIGIN for the home path', () => {
    expect(canonicalUrl('/')).toBe(`${SITE_ORIGIN}/`)
  })

  it('builds an absolute URL for a nested path', () => {
    expect(canonicalUrl('/careers/senior-ml-engineer')).toBe(
      `${SITE_ORIGIN}/careers/senior-ml-engineer`,
    )
  })
})

describe('buildOrganizationJsonLd', () => {
  it('has the required schema.org Organization fields', () => {
    const jsonLd = buildOrganizationJsonLd()
    expect(jsonLd['@context']).toBe('https://schema.org')
    expect(jsonLd['@type']).toBe('Organization')
    expect(jsonLd.name).toBeTruthy()
    expect(jsonLd.url).toBe(SITE_ORIGIN)
    expect(jsonLd.email).toContain('@')
  })
})

describe('buildWebSiteJsonLd', () => {
  it('has the required schema.org WebSite fields', () => {
    const jsonLd = buildWebSiteJsonLd()
    expect(jsonLd['@context']).toBe('https://schema.org')
    expect(jsonLd['@type']).toBe('WebSite')
    expect(jsonLd.name).toBeTruthy()
    expect(jsonLd.url).toBe(SITE_ORIGIN)
  })
})

describe('buildJobPostingJsonLd', () => {
  const vacancy: PublicVacancyDetail = {
    slug: 'senior-ml-engineer',
    title: 'Senior ML Engineer',
    domain: 'AI',
    seniority: 'SENIOR',
    employmentType: 'FULL_TIME',
    location: 'Remote',
    publishedAt: '2026-07-01T00:00:00.000Z',
    descriptionMd: '## About\n\nBuild things.',
  }

  it('maps the vacancy onto the required Google Jobs JobPosting fields', () => {
    const jsonLd = buildJobPostingJsonLd(vacancy)
    expect(jsonLd['@context']).toBe('https://schema.org')
    expect(jsonLd['@type']).toBe('JobPosting')
    expect(jsonLd.title).toBe(vacancy.title)
    expect(jsonLd.datePosted).toBe(vacancy.publishedAt)
    expect(jsonLd.employmentType).toBe(vacancy.employmentType)
    expect(jsonLd.hiringOrganization.name).toBeTruthy()
    expect(jsonLd.url).toBe(canonicalUrl(`/careers/${vacancy.slug}`))
  })

  it('sets jobLocationType=TELECOMMUTE with applicantLocationRequirements (Google requirement for remote roles)', () => {
    const jsonLd = buildJobPostingJsonLd(vacancy)
    expect(jsonLd.jobLocationType).toBe('TELECOMMUTE')
    expect(jsonLd.applicantLocationRequirements['@type']).toBe('Country')
    expect(jsonLd.applicantLocationRequirements.name).toBeTruthy()
  })

  it('never includes a salary field (by product design, see packages/shared vacancies schema)', () => {
    const jsonLd = buildJobPostingJsonLd(vacancy)
    expect(JSON.stringify(jsonLd).toLowerCase()).not.toContain('salary')
  })
})
