/**
 * task-landing-seo-prerender.md AC3 "JSON-LD проходит структурную валидацию
 * (скриптом/тестом)" — this file is the "тестом" half (pure builder
 * functions, no DOM needed). The "скриптом" half is the runtime
 * `assertJsonLd()` check inside `scripts/prerender.mjs` itself, covered by
 * app/__tests__/prerender-seo.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import type { PublicVacancy, PublicVacancyDetail } from '@crm/shared'
import {
  SITE_NAME,
  SITE_ORIGIN,
  buildBreadcrumbListJsonLd,
  buildItemListJsonLd,
  buildJobPostingJsonLd,
  buildOrganizationJsonLd,
  buildWebSiteJsonLd,
  canonicalUrl,
  markdownToPlainText,
  parseRemoteLocation,
  truncateForMetaDescription,
} from '@/lib/seo'

describe('canonicalUrl', () => {
  it('builds an absolute URL under SITE_ORIGIN for the home path', () => {
    expect(canonicalUrl('/')).toBe(`${SITE_ORIGIN}/`)
  })

  it('builds a trailing-slash-terminated URL for a nested path (matches router trailingSlash: always + the prerendered directory-per-route layout)', () => {
    expect(canonicalUrl('/careers/senior-ml-engineer')).toBe(
      `${SITE_ORIGIN}/careers/senior-ml-engineer/`,
    )
  })

  it('is idempotent — does not double the trailing slash if already present', () => {
    expect(canonicalUrl('/careers/')).toBe(`${SITE_ORIGIN}/careers/`)
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

describe('parseRemoteLocation', () => {
  it('returns null when location does not mention remote (correct: on-site roles get no jobLocationType)', () => {
    expect(parseRemoteLocation('Kyiv office')).toBeNull()
  })

  it('maps plain "Remote" (no qualifier) to Worldwide — no stated restriction', () => {
    const info = parseRemoteLocation('Remote')
    expect(info?.jobLocationType).toBe('TELECOMMUTE')
    expect(info?.applicantLocationRequirements).toEqual({ '@type': 'Country', name: 'Worldwide' })
  })

  it('extracts the region from "Remote (Region)" verbatim', () => {
    const info = parseRemoteLocation('Remote (Europe)')
    expect(info?.applicantLocationRequirements).toEqual({ '@type': 'Country', name: 'Europe' })
  })

  it('falls back to Country UA for an unparseable remote-mentioning format', () => {
    const info = parseRemoteLocation('Fully remote, EU timezones preferred')
    expect(info?.applicantLocationRequirements).toEqual({ '@type': 'Country', name: 'UA' })
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
    isFallback: false,
    relatedVacancies: [],
    skills: null,
    experienceMonths: null,
    qualifications: null,
    responsibilities: null,
    jobBenefits: null,
    workHours: null,
  }
  const descriptionHtml = '<h2>About</h2><p>Build things.</p>'

  it('maps the vacancy onto the required Google Jobs JobPosting fields', () => {
    const jsonLd = buildJobPostingJsonLd(vacancy, descriptionHtml)
    expect(jsonLd['@context']).toBe('https://schema.org')
    expect(jsonLd['@type']).toBe('JobPosting')
    expect(jsonLd.title).toBe(vacancy.title)
    expect(jsonLd.description).toBe(descriptionHtml)
    expect(jsonLd.datePosted).toBe(vacancy.publishedAt)
    expect(jsonLd.hiringOrganization.name).toBeTruthy()
    expect(jsonLd.url).toBe(canonicalUrl(`/careers/${vacancy.slug}`))
    expect(jsonLd.directApply).toBe(true)
    expect(jsonLd.identifier).toEqual({
      '@type': 'PropertyValue',
      name: SITE_NAME,
      value: vacancy.slug,
    })
  })

  it("maps our internal CONTRACT enum value to schema.org/Google's CONTRACTOR", () => {
    const jsonLd = buildJobPostingJsonLd(
      { ...vacancy, employmentType: 'CONTRACT' },
      descriptionHtml,
    )
    expect(jsonLd.employmentType).toBe('CONTRACTOR')
  })

  it('passes FULL_TIME/PART_TIME through unchanged (already Google-compliant)', () => {
    expect(buildJobPostingJsonLd(vacancy, descriptionHtml).employmentType).toBe('FULL_TIME')
    expect(
      buildJobPostingJsonLd({ ...vacancy, employmentType: 'PART_TIME' }, descriptionHtml)
        .employmentType,
    ).toBe('PART_TIME')
  })

  it('sets jobLocationType=TELECOMMUTE with applicantLocationRequirements (Google requirement for remote roles)', () => {
    const jsonLd = buildJobPostingJsonLd(vacancy, descriptionHtml)
    expect(jsonLd.jobLocationType).toBe('TELECOMMUTE')
    expect(jsonLd.applicantLocationRequirements).toEqual({ '@type': 'Country', name: 'Worldwide' })
  })

  it('omits jobLocationType/applicantLocationRequirements for a non-remote location', () => {
    const jsonLd = buildJobPostingJsonLd({ ...vacancy, location: 'Kyiv office' }, descriptionHtml)
    expect(jsonLd.jobLocationType).toBeUndefined()
    expect(jsonLd.applicantLocationRequirements).toBeUndefined()
  })

  it('sets validThrough ~60 days in the future, recomputed fresh on every call', () => {
    const before = Date.now()
    const jsonLd = buildJobPostingJsonLd(vacancy, descriptionHtml)
    const after = Date.now()
    const validThroughMs = new Date(jsonLd.validThrough).getTime()
    const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000
    expect(validThroughMs).toBeGreaterThanOrEqual(before + sixtyDaysMs - 1000)
    expect(validThroughMs).toBeLessThanOrEqual(after + sixtyDaysMs + 1000)
  })

  it('never includes a salary field (by product design, see packages/shared vacancies schema)', () => {
    const jsonLd = buildJobPostingJsonLd(vacancy, descriptionHtml)
    expect(JSON.stringify(jsonLd).toLowerCase()).not.toContain('salary')
  })
})

describe('buildBreadcrumbListJsonLd', () => {
  it('builds Home -> Careers -> <Job Title> in order', () => {
    const jsonLd = buildBreadcrumbListJsonLd({
      title: 'Senior ML Engineer',
      slug: 'senior-ml-engineer',
    })
    expect(jsonLd['@context']).toBe('https://schema.org')
    expect(jsonLd['@type']).toBe('BreadcrumbList')
    expect(jsonLd.itemListElement).toEqual([
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_ORIGIN}/` },
      { '@type': 'ListItem', position: 2, name: 'Careers', item: `${SITE_ORIGIN}/careers/` },
      {
        '@type': 'ListItem',
        position: 3,
        name: 'Senior ML Engineer',
        item: `${SITE_ORIGIN}/careers/senior-ml-engineer/`,
      },
    ])
  })
})

describe('buildItemListJsonLd', () => {
  const vacancies: PublicVacancy[] = [
    {
      slug: 'senior-ml-engineer',
      title: 'Senior ML Engineer',
      domain: 'AI',
      seniority: 'SENIOR',
      employmentType: 'FULL_TIME',
      location: 'Remote',
      publishedAt: '2026-07-01T00:00:00.000Z',
      isFallback: false,
    },
    {
      slug: 'lead-ecommerce-backend',
      title: 'Lead E-Commerce Backend Engineer',
      domain: 'ECOMMERCE',
      seniority: 'LEAD',
      employmentType: 'CONTRACT',
      location: 'Remote',
      publishedAt: '2026-07-02T00:00:00.000Z',
      isFallback: false,
    },
  ]

  it('lists every vacancy as a positioned ListItem with its canonical URL', () => {
    const jsonLd = buildItemListJsonLd(vacancies)
    expect(jsonLd['@type']).toBe('ItemList')
    expect(jsonLd.itemListElement).toEqual([
      {
        '@type': 'ListItem',
        position: 1,
        url: `${SITE_ORIGIN}/careers/senior-ml-engineer/`,
        name: 'Senior ML Engineer',
      },
      {
        '@type': 'ListItem',
        position: 2,
        url: `${SITE_ORIGIN}/careers/lead-ecommerce-backend/`,
        name: 'Lead E-Commerce Backend Engineer',
      },
    ])
  })
})

describe('markdownToPlainText', () => {
  it('strips headings, bullets, bold/italic, links and code markers', () => {
    const markdown = [
      '## About the role',
      '',
      'We need a **Senior Engineer** with _RAG_ experience.',
      '',
      '- Own the [roadmap](https://example.com)',
      '- Ship `production` code',
    ].join('\n')
    const plain = markdownToPlainText(markdown)
    expect(plain).not.toMatch(/[#*_`[\]]/)
    expect(plain).toContain('Senior Engineer')
    expect(plain).toContain('Own the roadmap')
  })
})

describe('truncateForMetaDescription', () => {
  it('leaves short text untouched', () => {
    expect(truncateForMetaDescription('Short description.')).toBe('Short description.')
  })

  it('truncates long text on a word boundary with an ellipsis, never mid-word', () => {
    const long = 'A '.repeat(100) + 'wordboundarycanary'
    const truncated = truncateForMetaDescription(long, 50)
    expect(truncated.length).toBeLessThanOrEqual(51)
    expect(truncated.endsWith('…')).toBe(true)
    expect(truncated).not.toContain('wordboundarycanary')
  })
})
