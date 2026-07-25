/**
 * Pure helpers exported from `scripts/prerender.mjs` — task-landing-seo-
 * prerender.md AC3 (robots.txt/sitemap.xml/JSON-LD structural validation).
 * Vitest (Vite-powered) can import a plain `.mjs` module directly, so this
 * runs the ACTUAL build-script code, not a duplicated copy.
 */
import { describe, expect, it } from 'vitest'
import {
  assertHtmlLang,
  assertJsonLd,
  buildRobotsTxt,
  buildRoutes,
  buildSitemapXml,
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
    const routes = buildRoutes([{ slug: 'a', publishedAt: '2026-07-01T00:00:00.000Z' }])
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
    const withVacancies = buildRoutes([{ slug: 'a', publishedAt: '2026-07-01T00:00:00.000Z' }])
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
    const routes = buildRoutes([{ slug: 'a', publishedAt: '2026-07-01T00:00:00.000Z' }])
    for (const locale of LOCALES) {
      const url = locale === 'en' ? '/careers/a' : `/${locale}/careers/a`
      expect(routes.find((r) => r.url === url)?.requireJsonLd).toBe('job-posting-breadcrumb')
    }
  })
})

describe('vacancyHreflangExcludes', () => {
  it('excludes every non-default locale when there is no translations field at all (pre-Block-C safe default)', () => {
    expect(vacancyHreflangExcludes({ slug: 'a', publishedAt: '2026-07-01T00:00:00.000Z' })).toEqual(
      NON_DEFAULT_LOCALES,
    )
  })

  it('only excludes locales without a real translation entry', () => {
    const vacancy = {
      slug: 'a',
      publishedAt: '2026-07-01T00:00:00.000Z',
      translations: { ru: { title: 'Т', description: 'О' } },
    }
    expect(vacancyHreflangExcludes(vacancy)).toEqual(NON_DEFAULT_LOCALES.filter((l) => l !== 'ru'))
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
      [{ slug: 'senior-ml-engineer', publishedAt: '2026-07-01T00:00:00.000Z' }],
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
      [
        {
          slug: 'senior-ml-engineer',
          publishedAt: '2026-07-01T00:00:00.000Z',
          translations: { ru: { title: 'Т', description: 'О' } },
        },
      ],
      '2026-07-23T00:00:00.000Z',
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
        requireJsonLd: null,
      }),
    ).not.toThrow()
  })

  it('throws when organization+website JSON-LD is required but missing', () => {
    expect(() =>
      assertJsonLd('<html><head></head><body></body></html>', {
        url: '/',
        file: 'index.html',
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
  const jobPostingRoute = {
    url: '/careers/senior-ml-engineer',
    file: 'careers/senior-ml-engineer/index.html',
    requireJsonLd: 'job-posting-breadcrumb' as const,
  }

  it('throws when a TELECOMMUTE JobPosting is missing applicantLocationRequirements', () => {
    const { applicantLocationRequirements: _drop, ...withoutLocationReq } = validJobPosting
    const html = jsonLdHtml([withoutLocationReq, validBreadcrumb])
    expect(() => assertJsonLd(html, jobPostingRoute)).toThrow(/applicantLocationRequirements/)
  })

  it('throws when validThrough is missing', () => {
    const { validThrough: _drop, ...withoutValidThrough } = validJobPosting
    const html = jsonLdHtml([withoutValidThrough, validBreadcrumb])
    expect(() => assertJsonLd(html, jobPostingRoute)).toThrow(/validThrough/)
  })

  it('throws when directApply is not true', () => {
    const html = jsonLdHtml([{ ...validJobPosting, directApply: false }, validBreadcrumb])
    expect(() => assertJsonLd(html, jobPostingRoute)).toThrow(/directApply/)
  })

  it('throws when description is missing/too short', () => {
    const html = jsonLdHtml([{ ...validJobPosting, description: '' }, validBreadcrumb])
    expect(() => assertJsonLd(html, jobPostingRoute)).toThrow(/description/)
  })

  it('throws when BreadcrumbList is missing', () => {
    const html = jsonLdHtml([validJobPosting])
    expect(() => assertJsonLd(html, jobPostingRoute)).toThrow(/JobPosting\+BreadcrumbList/)
  })

  it('throws when BreadcrumbList does not have exactly 3 items', () => {
    const html = jsonLdHtml([
      validJobPosting,
      { ...validBreadcrumb, itemListElement: validBreadcrumb.itemListElement.slice(0, 2) },
    ])
    expect(() => assertJsonLd(html, jobPostingRoute)).toThrow(/exactly 3 items/)
  })

  it('passes for a complete, valid JobPosting+BreadcrumbList pair (remote role)', () => {
    const html = jsonLdHtml([validJobPosting, validBreadcrumb])
    expect(() => assertJsonLd(html, jobPostingRoute)).not.toThrow()
  })

  it('passes for a JobPosting with no jobLocationType at all (on-site role)', () => {
    const { jobLocationType: _lt, applicantLocationRequirements: _alr, ...onSite } = validJobPosting
    const html = jsonLdHtml([onSite, validBreadcrumb])
    expect(() => assertJsonLd(html, jobPostingRoute)).not.toThrow()
  })

  it('throws when ItemList is missing/empty on a route that requires one', () => {
    const itemListRoute = {
      url: '/careers',
      file: 'careers/index.html',
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
