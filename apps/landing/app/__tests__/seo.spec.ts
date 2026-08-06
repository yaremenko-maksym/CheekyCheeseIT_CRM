/**
 * task-landing-seo-prerender.md AC3 "JSON-LD проходит структурную валидацию
 * (скриптом/тестом)" — this file is the "тестом" half (pure builder
 * functions, no DOM needed). The "скриптом" half is the runtime
 * `assertJsonLd()` check inside `scripts/prerender.mjs` itself, covered by
 * app/__tests__/prerender-seo.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import type { PublicVacancy, PublicVacancyDetail, VacancyLocale } from '@crm/shared'
import { VACANCY_DOMAINS, VACANCY_LOCALES } from '@crm/shared'
import {
  SITE_NAME,
  SITE_ORIGIN,
  buildBreadcrumbListJsonLd,
  buildFAQPageJsonLd,
  buildHreflangAlternates,
  buildItemListJsonLd,
  buildJobPostingJsonLd,
  buildOrganizationJsonLd,
  buildWebSiteJsonLd,
  canonicalUrl,
  markdownToPlainText,
  parseRemoteLocation,
  truncateForMetaDescription,
} from '@/lib/seo'
import { LOCALES } from '@/i18n/locale'

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

describe('buildHreflangAlternates (task-landing-i18n.md A4)', () => {
  it('builds one alternate per locale plus x-default, x-default pointing at the en URL', () => {
    const alternates = buildHreflangAlternates('/careers')
    expect(alternates).toHaveLength(LOCALES.length + 1)
    for (const locale of LOCALES) {
      const entry = alternates.find((a) => a.hreflang === locale)
      expect(entry).toBeTruthy()
    }
    const xDefault = alternates.find((a) => a.hreflang === 'x-default')
    const en = alternates.find((a) => a.hreflang === 'en')
    expect(xDefault?.href).toBe(en?.href)
    expect(xDefault?.href).toBe(`${SITE_ORIGIN}/careers/`)
  })

  it('is reciprocal — every locale route calling this with the SAME path emits the identical cluster', () => {
    const path = '/careers/senior-ml-engineer'
    const clusters = LOCALES.map(() => buildHreflangAlternates(path))
    for (const cluster of clusters.slice(1)) {
      expect(cluster).toEqual(clusters[0])
    }
  })

  it('produces locale-prefixed hrefs for non-default locales, unprefixed for en', () => {
    const alternates = buildHreflangAlternates('/careers/my-slug')
    expect(alternates.find((a) => a.hreflang === 'en')?.href).toBe(
      `${SITE_ORIGIN}/careers/my-slug/`,
    )
    expect(alternates.find((a) => a.hreflang === 'ru')?.href).toBe(
      `${SITE_ORIGIN}/ru/careers/my-slug/`,
    )
    expect(alternates.find((a) => a.hreflang === 'pt')?.href).toBe(
      `${SITE_ORIGIN}/pt/careers/my-slug/`,
    )
  })

  it('omits locales passed in excludeLocales (A10 fallback-vacancy case), keeps x-default', () => {
    const alternates = buildHreflangAlternates('/careers/my-slug', ['uk', 'es', 'pt'])
    expect(alternates.map((a) => a.hreflang).sort()).toEqual(['en', 'ru', 'x-default'])
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
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    salaryPeriod: null,
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

  // task-vacancy-salary-range (AC3/AC4, owner decision 2026-07-31) — baseSalary
  // is present in the JSON-LD whenever the vacancy has a filled range, and
  // ABSENT (not a fake/partial value) for a legacy vacancy that doesn't.
  describe('baseSalary', () => {
    it('omits baseSalary entirely when the vacancy has no salary range (AC3 — legacy vacancy)', () => {
      const jsonLd = buildJobPostingJsonLd(vacancy, descriptionHtml)
      expect(jsonLd.baseSalary).toBeUndefined()
      expect(JSON.stringify(jsonLd)).not.toContain('baseSalary')
    })

    it('includes a Google-spec-shaped baseSalary MonetaryAmount when the range is filled', () => {
      const jsonLd = buildJobPostingJsonLd(
        {
          ...vacancy,
          salaryMin: '3000.00',
          salaryMax: '5000.00',
          salaryCurrency: 'USD',
          salaryPeriod: 'MONTH',
        },
        descriptionHtml,
      )
      expect(jsonLd.baseSalary).toEqual({
        '@type': 'MonetaryAmount',
        currency: 'USD',
        value: {
          '@type': 'QuantitativeValue',
          minValue: 3000,
          maxValue: 5000,
          unitText: 'MONTH',
        },
      })
    })

    it('maps USDT to USD for the JSON-LD currency (ISO 4217 requirement; USDT is pegged 1:1 to USD)', () => {
      const jsonLd = buildJobPostingJsonLd(
        {
          ...vacancy,
          salaryMin: '3000.00',
          salaryMax: '5000.00',
          salaryCurrency: 'USDT',
          salaryPeriod: 'MONTH',
        },
        descriptionHtml,
      )
      expect(jsonLd.baseSalary?.currency).toBe('USD')
    })

    it('passes EUR/UAH through unchanged (already ISO 4217)', () => {
      const eurJsonLd = buildJobPostingJsonLd(
        {
          ...vacancy,
          salaryMin: '2500',
          salaryMax: '4000',
          salaryCurrency: 'EUR',
          salaryPeriod: 'MONTH',
        },
        descriptionHtml,
      )
      expect(eurJsonLd.baseSalary?.currency).toBe('EUR')

      const uahJsonLd = buildJobPostingJsonLd(
        {
          ...vacancy,
          salaryMin: '80000',
          salaryMax: '120000',
          salaryCurrency: 'UAH',
          salaryPeriod: 'MONTH',
        },
        descriptionHtml,
      )
      expect(uahJsonLd.baseSalary?.currency).toBe('UAH')
    })

    it('passes unitText through unchanged for every Google-valid period', () => {
      for (const period of ['HOUR', 'DAY', 'WEEK', 'MONTH', 'YEAR'] as const) {
        const jsonLd = buildJobPostingJsonLd(
          {
            ...vacancy,
            salaryMin: '10',
            salaryMax: '20',
            salaryCurrency: 'USD',
            salaryPeriod: period,
          },
          descriptionHtml,
        )
        expect(jsonLd.baseSalary?.value.unitText).toBe(period)
      }
    })

    it('omits baseSalary when only SOME of the 4 fields are set (never a fake/partial value)', () => {
      const jsonLd = buildJobPostingJsonLd(
        { ...vacancy, salaryMin: '3000', salaryMax: '5000' }, // currency/period still null
        descriptionHtml,
      )
      expect(jsonLd.baseSalary).toBeUndefined()
    })
  })

  // task-vacancy-i18n-jobposting C3 — enrichment fields.
  describe('C3 enrichment', () => {
    it('always includes industry (derived from domain) and the constant occupationalCategory', () => {
      const jsonLd = buildJobPostingJsonLd(vacancy, descriptionHtml)
      expect(jsonLd.industry).toBe('Artificial Intelligence')
      expect(jsonLd.occupationalCategory).toBe('15-1252.00')
    })

    it('derives industry per domain', () => {
      expect(
        buildJobPostingJsonLd({ ...vacancy, domain: 'EDTECH' }, descriptionHtml).industry,
      ).toBe('Education Technology')
      expect(
        buildJobPostingJsonLd({ ...vacancy, domain: 'ECOMMERCE' }, descriptionHtml).industry,
      ).toBe('E-Commerce')
      expect(buildJobPostingJsonLd({ ...vacancy, domain: 'OTHER' }, descriptionHtml).industry).toBe(
        'Information Technology',
      )
    })

    // task-domains-expansion — `industry` is read by a jobs crawler, so every
    // one of the 17 domains must resolve to a real classification string. A
    // missing entry would emit `industry: undefined` into the JSON-LD, which
    // is worse than the pre-expansion state (Google then guesses again).
    it('derives a non-empty industry for EVERY domain, never the raw enum value', () => {
      for (const domain of VACANCY_DOMAINS) {
        const industry = buildJobPostingJsonLd({ ...vacancy, domain }, descriptionHtml).industry
        expect(industry, `no industry mapped for ${domain}`).toBeTruthy()
        expect(industry).not.toBe(domain)
      }
    })

    it('omits skills/experienceRequirements/qualifications/responsibilities/jobBenefits/workHours when the vacancy has none set (never invented)', () => {
      const jsonLd = buildJobPostingJsonLd(vacancy, descriptionHtml)
      expect(jsonLd.skills).toBeUndefined()
      expect(jsonLd.experienceRequirements).toBeUndefined()
      expect(jsonLd.qualifications).toBeUndefined()
      expect(jsonLd.responsibilities).toBeUndefined()
      expect(jsonLd.jobBenefits).toBeUndefined()
      expect(jsonLd.workHours).toBeUndefined()
    })

    it('joins skills into a comma-separated Text property when present', () => {
      const jsonLd = buildJobPostingJsonLd(
        { ...vacancy, skills: ['TypeScript', 'React', 'Node.js'] },
        descriptionHtml,
      )
      expect(jsonLd.skills).toBe('TypeScript, React, Node.js')
    })

    it('builds experienceRequirements.monthsOfExperience when experienceMonths is set (including 0)', () => {
      const jsonLd = buildJobPostingJsonLd({ ...vacancy, experienceMonths: 36 }, descriptionHtml)
      expect(jsonLd.experienceRequirements).toEqual({
        '@type': 'OccupationalExperienceRequirements',
        monthsOfExperience: 36,
      })
      // 0 is a real, meaningful value ("no prior experience required") — must
      // not be treated as falsy/absent.
      const zeroJsonLd = buildJobPostingJsonLd({ ...vacancy, experienceMonths: 0 }, descriptionHtml)
      expect(zeroJsonLd.experienceRequirements?.monthsOfExperience).toBe(0)
    })

    it('includes qualifications/responsibilities/jobBenefits/workHours verbatim when set', () => {
      const jsonLd = buildJobPostingJsonLd(
        {
          ...vacancy,
          qualifications: '3+ years commercial experience.',
          responsibilities: 'Own the frontend architecture.',
          jobBenefits: 'Remote-first, flexible hours.',
          workHours: '40 hours per week',
        },
        descriptionHtml,
      )
      expect(jsonLd.qualifications).toBe('3+ years commercial experience.')
      expect(jsonLd.responsibilities).toBe('Own the frontend architecture.')
      expect(jsonLd.jobBenefits).toBe('Remote-first, flexible hours.')
      expect(jsonLd.workHours).toBe('40 hours per week')
    })
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
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      salaryPeriod: null,
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
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      salaryPeriod: null,
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

// task-vacancy-i18n-jobposting C6 — FAQPage, localized to all 5 site locales.
describe('buildFAQPageJsonLd', () => {
  it('defaults to en when no locale is passed', () => {
    const jsonLd = buildFAQPageJsonLd()
    expect(jsonLd['@context']).toBe('https://schema.org')
    expect(jsonLd['@type']).toBe('FAQPage')
    expect(jsonLd.mainEntity[0]?.name).toMatch(/hiring process/i)
  })

  it.each(VACANCY_LOCALES)('builds 3-5 valid Question/Answer pairs for locale %s', (locale) => {
    const jsonLd = buildFAQPageJsonLd(locale)
    expect(jsonLd.mainEntity.length).toBeGreaterThanOrEqual(3)
    expect(jsonLd.mainEntity.length).toBeLessThanOrEqual(5)
    for (const entry of jsonLd.mainEntity) {
      expect(entry['@type']).toBe('Question')
      expect(entry.name.length).toBeGreaterThan(0)
      expect(entry.acceptedAnswer['@type']).toBe('Answer')
      expect(entry.acceptedAnswer.text.length).toBeGreaterThan(0)
    }
  })

  it('every locale has genuinely distinct (translated, not copy-pasted) content', () => {
    const byLocale = new Map<VacancyLocale, string>()
    for (const locale of VACANCY_LOCALES) {
      byLocale.set(locale, JSON.stringify(buildFAQPageJsonLd(locale)))
    }
    const values = [...byLocale.values()]
    expect(new Set(values).size).toBe(values.length)
  })

  it('all locales answer the same number of questions (parity — no locale silently drops a question)', () => {
    const counts = VACANCY_LOCALES.map((locale) => buildFAQPageJsonLd(locale).mainEntity.length)
    expect(new Set(counts).size).toBe(1)
  })
})
