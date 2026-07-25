/**
 * Pure helpers exported from `scripts/prerender.mjs` — task-landing-seo-
 * prerender.md AC3 (robots.txt/sitemap.xml/JSON-LD structural validation).
 * Vitest (Vite-powered) can import a plain `.mjs` module directly, so this
 * runs the ACTUAL build-script code, not a duplicated copy.
 */
import { describe, expect, it } from 'vitest'
import {
  assertAlternatesMatch,
  assertCanonicalSelf,
  assertHtmlLang,
  assertJsonLd,
  assertNoHomeJsonLdLeak,
  buildRobotsTxt,
  buildRoutes,
  buildSitemapXml,
  computeAlternateHrefs,
  extractJsonLd,
  LOCALES,
  vacancyHreflangExcludes,
} from '../../scripts/prerender.mjs'

const NON_DEFAULT_LOCALES = LOCALES.filter((l) => l !== 'en')

describe('buildRobotsTxt', () => {
  it('allows everything for the wildcard agent and every named AI crawler, and links the sitemap', () => {
    const txt = buildRobotsTxt()
    expect(txt).toMatch(/User-agent: \*\nAllow: \//)
    for (const bot of [
      'GPTBot',
      'ClaudeBot',
      'Claude-Web',
      'PerplexityBot',
      'Google-Extended',
      'CCBot',
      'Bytespider',
    ]) {
      expect(txt).toMatch(new RegExp(`User-agent: ${bot}\\nAllow: /`))
    }
    expect(txt).toContain('Sitemap: https://cheekycheese.tech/sitemap.xml')
  })
})

describe('buildRoutes', () => {
  it('task-landing-i18n.md A1 — one home + careers-list per locale, plus one vacancy route per locale when the API is reachable (9+ total with 1 vacancy across 5 locales)', () => {
    const routes = buildRoutes([
      { slug: 'a', publishedAt: '2026-07-01T00:00:00.000Z', isFallback: false },
    ])
    expect(routes.length).toBeGreaterThanOrEqual(9)
    expect(routes.map((r) => r.url)).toEqual([
      '/',
      '/careers',
      '/careers/a',
      '/uk',
      '/uk/careers',
      '/uk/careers/a',
      '/ru',
      '/ru/careers',
      '/ru/careers/a',
      '/es',
      '/es/careers',
      '/es/careers/a',
      '/pt',
      '/pt/careers',
      '/pt/careers/a',
    ])
    expect(routes.map((r) => r.file)).toEqual([
      'index.html',
      'careers/index.html',
      'careers/a/index.html',
      'uk/index.html',
      'uk/careers/index.html',
      'uk/careers/a/index.html',
      'ru/index.html',
      'ru/careers/index.html',
      'ru/careers/a/index.html',
      'es/index.html',
      'es/careers/index.html',
      'es/careers/a/index.html',
      'pt/index.html',
      'pt/careers/index.html',
      'pt/careers/a/index.html',
    ])
    // Every route carries its own locale (A5 — drives <html lang> validation).
    for (const locale of LOCALES) {
      expect(routes.filter((r) => r.locale === locale).length).toBe(3)
    }
  })

  it('produces only the 5 home + 5 careers-list routes when the API was unreachable (vacancies === null)', () => {
    const routes = buildRoutes(null)
    expect(routes.length).toBe(LOCALES.length * 2)
    expect(routes.every((r) => !r.url.includes('/careers/a'))).toBe(true)
  })

  it('marks every locale/careers-list route as requiring ItemList JSON-LD only when there are vacancies to list', () => {
    const withVacancies = buildRoutes([
      { slug: 'a', publishedAt: '2026-07-01T00:00:00.000Z', isFallback: false },
    ])
    for (const locale of LOCALES) {
      expect(
        withVacancies.find((r) => r.locale === locale && r.url.endsWith('/careers'))?.requireJsonLd,
      ).toBe('item-list')
    }

    const withoutVacancies = buildRoutes([])
    expect(withoutVacancies.find((r) => r.url === '/careers')?.requireJsonLd).toBeNull()

    const unreachable = buildRoutes(null)
    expect(unreachable.find((r) => r.url === '/careers')?.requireJsonLd).toBeNull()
  })

  it('marks every vacancy route (every locale) as requiring JobPosting+BreadcrumbList JSON-LD', () => {
    const routes = buildRoutes([
      { slug: 'a', publishedAt: '2026-07-01T00:00:00.000Z', isFallback: false },
    ])
    for (const locale of LOCALES) {
      const url = locale === 'en' ? '/careers/a' : `/${locale}/careers/a`
      expect(routes.find((r) => r.url === url)?.requireJsonLd).toBe('job-posting-breadcrumb')
    }
  })
})

describe('vacancyHreflangExcludes', () => {
  it('excludes every non-default locale when perLocaleVacancies is empty/omitted (safe default — no data yet)', () => {
    expect(vacancyHreflangExcludes('a')).toEqual(NON_DEFAULT_LOCALES)
    expect(vacancyHreflangExcludes('a', {})).toEqual(NON_DEFAULT_LOCALES)
  })

  it('only excludes locales whose OWN list marks this slug isFallback (round-4 — real API contract, no translations field is ever public)', () => {
    const perLocaleVacancies = {
      uk: [{ slug: 'a', publishedAt: '2026-07-01T00:00:00.000Z', isFallback: true }],
      ru: [{ slug: 'a', publishedAt: '2026-07-01T00:00:00.000Z', isFallback: false }],
      es: [{ slug: 'a', publishedAt: '2026-07-01T00:00:00.000Z', isFallback: true }],
      pt: [{ slug: 'a', publishedAt: '2026-07-01T00:00:00.000Z', isFallback: true }],
    }
    expect(vacancyHreflangExcludes('a', perLocaleVacancies).sort()).toEqual(
      NON_DEFAULT_LOCALES.filter((l) => l !== 'ru').sort(),
    )
  })

  it('conservatively excludes a locale whose list does not contain this slug at all', () => {
    const perLocaleVacancies = {
      uk: [{ slug: 'a', publishedAt: '2026-07-01T00:00:00.000Z', isFallback: false }],
      ru: [{ slug: 'a', publishedAt: '2026-07-01T00:00:00.000Z', isFallback: false }],
      es: [{ slug: 'a', publishedAt: '2026-07-01T00:00:00.000Z', isFallback: false }],
      // pt's list is missing entirely (fetch failed) — treated as fallback.
      pt: null,
    }
    expect(vacancyHreflangExcludes('a', perLocaleVacancies)).toEqual(['pt'])
  })

  it('never excludes en (always the source language)', () => {
    expect(vacancyHreflangExcludes('a', {})).not.toContain('en')
  })
})

describe('assertHtmlLang', () => {
  it('passes when <html lang> matches the expected locale', () => {
    expect(() => assertHtmlLang('<html lang="ru"><body></body></html>', 'ru', '/ru')).not.toThrow()
  })

  it('throws when <html lang> does not match', () => {
    expect(() => assertHtmlLang('<html lang="en"><body></body></html>', 'ru', '/ru')).toThrow(
      /expected "ru"/,
    )
  })
})

describe('buildSitemapXml', () => {
  it('task-landing-i18n.md A7 — includes / and /careers for every locale with the build time, and one <url> per vacancy per locale with its own publishedAt', () => {
    const xml = buildSitemapXml(
      [{ slug: 'senior-ml-engineer', publishedAt: '2026-07-01T00:00:00.000Z', isFallback: false }],
      '2026-07-23T00:00:00.000Z',
    )
    expect(xml).toContain('<loc>https://cheekycheese.tech/</loc>')
    expect(xml).toContain('<loc>https://cheekycheese.tech/ru/</loc>')
    expect(xml).toContain('<loc>https://cheekycheese.tech/es/careers/</loc>')
    expect(xml).toContain('<lastmod>2026-07-23T00:00:00.000Z</lastmod>')
    expect(xml).toContain('<loc>https://cheekycheese.tech/careers/senior-ml-engineer/</loc>')
    expect(xml).toContain('<loc>https://cheekycheese.tech/pt/careers/senior-ml-engineer/</loc>')
    expect(xml).toContain('<lastmod>2026-07-01T00:00:00.000Z</lastmod>')
  })

  it('carries a reciprocal xhtml:link alternate cluster (every locale + x-default) on / and /careers', () => {
    const xml = buildSitemapXml([], '2026-07-23T00:00:00.000Z')
    for (const locale of LOCALES) {
      expect(xml).toContain(`hreflang="${locale}" href="https://cheekycheese.tech/`)
    }
    expect(xml).toContain('hreflang="x-default" href="https://cheekycheese.tech/"')
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"')
  })

  it("omits the untranslated locale from a vacancy URL block's xhtml:link cluster (A10)", () => {
    const xml = buildSitemapXml(
      [{ slug: 'senior-ml-engineer', publishedAt: '2026-07-01T00:00:00.000Z', isFallback: false }],
      '2026-07-23T00:00:00.000Z',
      {
        // ru has a real translation (isFallback: false); uk/es/pt don't
        // (round-4 — real API shape, per-locale list with isFallback, not a
        // single translations object).
        ru: [
          {
            slug: 'senior-ml-engineer',
            publishedAt: '2026-07-01T00:00:00.000Z',
            isFallback: false,
          },
        ],
        uk: [
          { slug: 'senior-ml-engineer', publishedAt: '2026-07-01T00:00:00.000Z', isFallback: true },
        ],
        es: [
          { slug: 'senior-ml-engineer', publishedAt: '2026-07-01T00:00:00.000Z', isFallback: true },
        ],
        pt: [
          { slug: 'senior-ml-engineer', publishedAt: '2026-07-01T00:00:00.000Z', isFallback: true },
        ],
      },
    )
    const block = xml.slice(
      xml.indexOf('<loc>https://cheekycheese.tech/careers/senior-ml-engineer/</loc>'),
      xml.indexOf(
        '</url>',
        xml.indexOf('<loc>https://cheekycheese.tech/careers/senior-ml-engineer/</loc>'),
      ),
    )
    expect(block).toContain('hreflang="ru"')
    expect(block).not.toContain('hreflang="uk"')
    expect(block).not.toContain('hreflang="es"')
    expect(block).not.toContain('hreflang="pt"')
  })

  it('is valid XML with no vacancies — 2 <url> entries per locale (home + careers-list)', () => {
    const xml = buildSitemapXml(null, '2026-07-23T00:00:00.000Z')
    const urlCount = xml.match(/<url>/g)?.length ?? 0
    expect(urlCount).toBe(LOCALES.length * 2)
  })
})

describe('extractJsonLd + assertJsonLd', () => {
  const jsonLdHtml = (payload: unknown) =>
    `<html><head><script id="seo-json-ld" type="application/ld+json">${JSON.stringify(payload)}</script></head><body></body></html>`

  it('extracts JSON-LD regardless of attribute order in the serialized HTML', () => {
    const html = jsonLdHtml([{ '@type': 'Organization' }, { '@type': 'WebSite' }])
    expect(extractJsonLd(html)).toEqual([{ '@type': 'Organization' }, { '@type': 'WebSite' }])
  })

  it('returns null when no json-ld script tag is present', () => {
    expect(extractJsonLd('<html><head></head><body></body></html>')).toBeNull()
  })

  it('passes for a route with requireJsonLd: null regardless of content', () => {
    expect(() =>
      assertJsonLd('<html><head></head><body></body></html>', {
        url: '/careers',
        file: 'careers/index.html',
        path: '/careers',
        pageType: 'careers',
        hreflangExcludes: [],
        requireJsonLd: null,
      }),
    ).not.toThrow()
  })

  it('throws when organization+website JSON-LD is required but missing', () => {
    expect(() =>
      assertJsonLd('<html><head></head><body></body></html>', {
        url: '/',
        file: 'index.html',
        path: '/',
        pageType: 'home',
        hreflangExcludes: [],
        requireJsonLd: 'organization+website',
      }),
    ).toThrow(/Organization\+WebSite/)
  })

  const validJobPosting = {
    '@type': 'JobPosting',
    title: 'Senior ML Engineer',
    description: '<h2>About</h2><p>Build things that matter to real users.</p>',
    datePosted: '2026-07-01T00:00:00.000Z',
    validThrough: '2026-08-30T00:00:00.000Z',
    hiringOrganization: { name: 'CheekyCheeseIT' },
    directApply: true,
    jobLocationType: 'TELECOMMUTE',
    applicantLocationRequirements: { '@type': 'Country', name: 'Worldwide' },
  }
  const validBreadcrumb = {
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: 'https://cheekycheese.tech/' },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Careers',
        item: 'https://cheekycheese.tech/careers/',
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: 'Senior ML Engineer',
        item: 'https://cheekycheese.tech/careers/senior-ml-engineer/',
      },
    ],
  }
  // task-vacancy-i18n-jobposting C6 / round-4 "дорезка" — VacancyDetailContent's
  // `jsonLd` array is [JobPosting, BreadcrumbList, FAQPage], a THIRD entry
  // this fixture (and `assertJsonLd`'s length check) originally predated.
  const validFaq = {
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'What does the hiring process look like?',
        acceptedAnswer: { '@type': 'Answer', text: 'Submit your application through the form.' },
      },
      {
        '@type': 'Question',
        name: 'What happens after I submit my application?',
        acceptedAnswer: { '@type': 'Answer', text: 'Our team reviews it and reaches out.' },
      },
      {
        '@type': 'Question',
        name: 'Can I apply to more than one open role?',
        acceptedAnswer: { '@type': 'Answer', text: 'Yes, submit a separate application each.' },
      },
    ],
  }
  const jobPostingRoute = {
    url: '/careers/senior-ml-engineer',
    file: 'careers/senior-ml-engineer/index.html',
    path: '/careers/senior-ml-engineer',
    pageType: 'vacancy' as const,
    hreflangExcludes: [],
    requireJsonLd: 'job-posting-breadcrumb' as const,
  }

  it('throws when a TELECOMMUTE JobPosting is missing applicantLocationRequirements', () => {
    const { applicantLocationRequirements: _drop, ...withoutLocationReq } = validJobPosting
    const html = jsonLdHtml([withoutLocationReq, validBreadcrumb, validFaq])
    expect(() => assertJsonLd(html, jobPostingRoute)).toThrow(/applicantLocationRequirements/)
  })

  it('throws when validThrough is missing', () => {
    const { validThrough: _drop, ...withoutValidThrough } = validJobPosting
    const html = jsonLdHtml([withoutValidThrough, validBreadcrumb, validFaq])
    expect(() => assertJsonLd(html, jobPostingRoute)).toThrow(/validThrough/)
  })

  it('throws when directApply is not true', () => {
    const html = jsonLdHtml([{ ...validJobPosting, directApply: false }, validBreadcrumb, validFaq])
    expect(() => assertJsonLd(html, jobPostingRoute)).toThrow(/directApply/)
  })

  it('throws when description is missing/too short', () => {
    const html = jsonLdHtml([{ ...validJobPosting, description: '' }, validBreadcrumb, validFaq])
    expect(() => assertJsonLd(html, jobPostingRoute)).toThrow(/description/)
  })

  it('throws when BreadcrumbList is missing', () => {
    const html = jsonLdHtml([validJobPosting, validFaq])
    expect(() => assertJsonLd(html, jobPostingRoute)).toThrow(/JobPosting\+BreadcrumbList/)
  })

  it('throws when BreadcrumbList does not have exactly 3 items', () => {
    const html = jsonLdHtml([
      validJobPosting,
      { ...validBreadcrumb, itemListElement: validBreadcrumb.itemListElement.slice(0, 2) },
      validFaq,
    ])
    expect(() => assertJsonLd(html, jobPostingRoute)).toThrow(/exactly 3 items/)
  })

  it('throws when FAQPage is missing entirely (only 2 entries)', () => {
    const html = jsonLdHtml([validJobPosting, validBreadcrumb])
    expect(() => assertJsonLd(html, jobPostingRoute)).toThrow(/JobPosting\+BreadcrumbList\+FAQPage/)
  })

  it('throws when FAQPage has fewer than 3 questions', () => {
    const html = jsonLdHtml([
      validJobPosting,
      validBreadcrumb,
      { ...validFaq, mainEntity: validFaq.mainEntity.slice(0, 2) },
    ])
    expect(() => assertJsonLd(html, jobPostingRoute)).toThrow(/at least 3 questions/)
  })

  it('throws when a FAQPage question is malformed (missing acceptedAnswer)', () => {
    const html = jsonLdHtml([
      validJobPosting,
      validBreadcrumb,
      {
        ...validFaq,
        mainEntity: [
          { '@type': 'Question', name: 'Q?' },
          ...validFaq.mainEntity.slice(1),
        ],
      },
    ])
    expect(() => assertJsonLd(html, jobPostingRoute)).toThrow(/malformed Question/)
  })

  it('passes for a complete, valid JobPosting+BreadcrumbList+FAQPage triple (remote role)', () => {
    const html = jsonLdHtml([validJobPosting, validBreadcrumb, validFaq])
    expect(() => assertJsonLd(html, jobPostingRoute)).not.toThrow()
  })

  it('passes for a JobPosting with no jobLocationType at all (on-site role)', () => {
    const { jobLocationType: _lt, applicantLocationRequirements: _alr, ...onSite } = validJobPosting
    const html = jsonLdHtml([onSite, validBreadcrumb, validFaq])
    expect(() => assertJsonLd(html, jobPostingRoute)).not.toThrow()
  })

  it('throws when ItemList is missing/empty on a route that requires one', () => {
    const itemListRoute = {
      url: '/careers',
      file: 'careers/index.html',
      path: '/careers',
      pageType: 'careers' as const,
      hreflangExcludes: [],
      requireJsonLd: 'item-list' as const,
    }
    expect(() =>
      assertJsonLd(jsonLdHtml({ '@type': 'ItemList', itemListElement: [] }), itemListRoute),
    ).toThrow(/non-empty ItemList/)
  })

  it('passes for a non-empty ItemList', () => {
    const itemListRoute = {
      url: '/careers',
      file: 'careers/index.html',
      path: '/careers',
      pageType: 'careers' as const,
      hreflangExcludes: [],
      requireJsonLd: 'item-list' as const,
    }
    const html = jsonLdHtml({
      '@type': 'ItemList',
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          url: 'https://cheekycheese.tech/careers/a/',
          name: 'A',
        },
      ],
    })
    expect(() => assertJsonLd(html, itemListRoute)).not.toThrow()
  })
})

// -----------------------------------------------------------------------
// task-landing-i18n.md orchestrator finding (PR #421 issuecomment-
// 5080204989) — page-identity checks. Every case below is a direct repro
// of the actual bug (a non-EN locale's careers/vacancy route rendering the
// HOME page instead), phrased as the exact captured-HTML shape that bug
// produced, to prove these three functions (which existing assertions
// above do NOT) would have caught it.
// -----------------------------------------------------------------------
describe('computeAlternateHrefs', () => {
  it('returns one absolute href per non-excluded locale (LOCALES order) plus x-default (== en) appended last', () => {
    expect(computeAlternateHrefs('/careers', [])).toEqual([
      'https://cheekycheese.tech/careers/',
      'https://cheekycheese.tech/uk/careers/',
      'https://cheekycheese.tech/ru/careers/',
      'https://cheekycheese.tech/es/careers/',
      'https://cheekycheese.tech/pt/careers/',
      'https://cheekycheese.tech/careers/',
    ])
  })

  it('omits excluded locales from the per-locale list but still appends x-default', () => {
    expect(computeAlternateHrefs('/careers/a', ['uk', 'es', 'pt'])).toEqual([
      'https://cheekycheese.tech/careers/a/',
      'https://cheekycheese.tech/ru/careers/a/',
      'https://cheekycheese.tech/careers/a/',
    ])
  })
})

describe('assertCanonicalSelf', () => {
  const ruCareersRoute = {
    url: '/ru/careers',
    file: 'ru/careers/index.html',
    locale: 'ru',
    path: '/careers',
    pageType: 'careers' as const,
    hreflangExcludes: [],
    requireJsonLd: null,
  }

  it("passes when canonical equals the route's own absolute URL", () => {
    const html =
      '<html><head><link rel="canonical" href="https://cheekycheese.tech/ru/careers/"></head></html>'
    expect(() => assertCanonicalSelf(html, ruCareersRoute)).not.toThrow()
  })

  it('throws — bug repro: canonical points at the RU locale HOME instead of /ru/careers/', () => {
    const html =
      '<html><head><link rel="canonical" href="https://cheekycheese.tech/ru/"></head></html>'
    expect(() => assertCanonicalSelf(html, ruCareersRoute)).toThrow(
      /canonical for \/ru\/careers is "https:\/\/cheekycheese\.tech\/ru\/", expected "https:\/\/cheekycheese\.tech\/ru\/careers\/"/,
    )
  })

  it('throws when the canonical tag is missing entirely', () => {
    expect(() => assertCanonicalSelf('<html><head></head></html>', ruCareersRoute)).toThrow(
      /\(missing\)/,
    )
  })
})

describe('assertAlternatesMatch', () => {
  const ruCareersRoute = {
    url: '/ru/careers',
    file: 'ru/careers/index.html',
    locale: 'ru',
    path: '/careers',
    pageType: 'careers' as const,
    hreflangExcludes: [],
    requireJsonLd: null,
  }
  const alternatesHtml = (hrefs: string[]) =>
    `<html><head>${hrefs
      .map((href) => `<link rel="alternate" hreflang="x" href="${href}">`)
      .join('')}</head></html>`

  it('passes when every expected alternate href (computeAlternateHrefs) is present', () => {
    const html = alternatesHtml(
      computeAlternateHrefs(ruCareersRoute.path, ruCareersRoute.hreflangExcludes),
    )
    expect(() => assertAlternatesMatch(html, ruCareersRoute)).not.toThrow()
  })

  it("throws — bug repro: alternates point at every locale ROOT instead of that locale's /careers/", () => {
    const html = alternatesHtml(
      LOCALES.map((l) =>
        l === 'en' ? 'https://cheekycheese.tech/' : `https://cheekycheese.tech/${l}/`,
      ),
    )
    expect(() => assertAlternatesMatch(html, ruCareersRoute)).toThrow(
      /alternate hrefs for \/ru\/careers do not match/,
    )
  })

  it('throws when an expected alternate is missing', () => {
    const hrefs = computeAlternateHrefs(
      ruCareersRoute.path,
      ruCareersRoute.hreflangExcludes,
    ).filter((href) => !href.includes('/uk/'))
    expect(() => assertAlternatesMatch(alternatesHtml(hrefs), ruCareersRoute)).toThrow(/missing:/)
  })
})

describe('assertNoHomeJsonLdLeak', () => {
  const ruCareersRoute = {
    url: '/ru/careers',
    file: 'ru/careers/index.html',
    locale: 'ru',
    path: '/careers',
    pageType: 'careers' as const,
    hreflangExcludes: [],
    requireJsonLd: null,
  }
  const ruHomeRoute = {
    url: '/ru',
    file: 'ru/index.html',
    locale: 'ru',
    path: '/',
    pageType: 'home' as const,
    hreflangExcludes: [],
    requireJsonLd: 'organization+website' as const,
  }
  const jsonLdHtml = (payload: unknown) =>
    `<html><head><script id="seo-json-ld" type="application/ld+json">${JSON.stringify(payload)}</script></head></html>`

  it('passes on the home route even though it legitimately carries Organization+WebSite JSON-LD', () => {
    const html = jsonLdHtml([{ '@type': 'Organization' }, { '@type': 'WebSite' }])
    expect(() => assertNoHomeJsonLdLeak(html, ruHomeRoute)).not.toThrow()
  })

  it('passes on a careers route with no JSON-LD at all (0-vacancy build — assertJsonLd alone would no-op here)', () => {
    expect(() => assertNoHomeJsonLdLeak('<html><head></head></html>', ruCareersRoute)).not.toThrow()
  })

  it('throws — bug repro: /ru/careers/ carries Organization+WebSite JSON-LD (home rendered instead)', () => {
    const html = jsonLdHtml([{ '@type': 'Organization' }, { '@type': 'WebSite' }])
    expect(() => assertNoHomeJsonLdLeak(html, ruCareersRoute)).toThrow(
      /\/ru\/careers \(pageType=careers\) carries Organization\/WebSite JSON-LD/,
    )
  })
})
