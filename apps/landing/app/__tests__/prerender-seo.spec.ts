/**
 * Pure helpers exported from `scripts/prerender.mjs` — task-landing-seo-
 * prerender.md AC3 (robots.txt/sitemap.xml/JSON-LD structural validation).
 * Vitest (Vite-powered) can import a plain `.mjs` module directly, so this
 * runs the ACTUAL build-script code, not a duplicated copy.
 */
import { describe, expect, it } from 'vitest'
import {
  assertJsonLd,
  buildRobotsTxt,
  buildRoutes,
  buildSitemapXml,
  extractJsonLd,
} from '../../scripts/prerender.mjs'

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
  it('always includes / and /careers, plus one entry per vacancy when the API is reachable', () => {
    const routes = buildRoutes([
      { slug: 'a', publishedAt: '2026-07-01T00:00:00.000Z' },
      { slug: 'b', publishedAt: '2026-07-02T00:00:00.000Z' },
    ])
    expect(routes.map((r) => r.url)).toEqual(['/', '/careers', '/careers/a', '/careers/b'])
    expect(routes.map((r) => r.file)).toEqual([
      'index.html',
      'careers/index.html',
      'careers/a/index.html',
      'careers/b/index.html',
    ])
  })

  it('produces only / and /careers when the API was unreachable (vacancies === null)', () => {
    const routes = buildRoutes(null)
    expect(routes.map((r) => r.url)).toEqual(['/', '/careers'])
  })
})

describe('buildSitemapXml', () => {
  it('includes / and /careers with the build time, and one <url> per vacancy with its own publishedAt', () => {
    const xml = buildSitemapXml(
      [{ slug: 'senior-ml-engineer', publishedAt: '2026-07-01T00:00:00.000Z' }],
      '2026-07-23T00:00:00.000Z',
    )
    expect(xml).toContain('<loc>https://cheekycheese.tech/</loc>')
    expect(xml).toContain('<lastmod>2026-07-23T00:00:00.000Z</lastmod>')
    expect(xml).toContain('<loc>https://cheekycheese.tech/careers/senior-ml-engineer/</loc>')
    expect(xml).toContain('<lastmod>2026-07-01T00:00:00.000Z</lastmod>')
  })

  it('is valid XML with no vacancies', () => {
    const xml = buildSitemapXml(null, '2026-07-23T00:00:00.000Z')
    const urlCount = xml.match(/<url>/g)?.length ?? 0
    expect(urlCount).toBe(2) // just / and /careers
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

  it('throws when a JobPosting is missing applicantLocationRequirements', () => {
    const html = jsonLdHtml({
      '@type': 'JobPosting',
      title: 'Senior ML Engineer',
      datePosted: '2026-07-01T00:00:00.000Z',
      hiringOrganization: { name: 'CheekyCheeseIT' },
      jobLocationType: 'TELECOMMUTE',
    })
    expect(() =>
      assertJsonLd(html, {
        url: '/careers/senior-ml-engineer',
        file: 'careers/senior-ml-engineer/index.html',
        requireJsonLd: 'job-posting',
      }),
    ).toThrow(/applicantLocationRequirements/)
  })

  it('passes for a complete, valid JobPosting', () => {
    const html = jsonLdHtml({
      '@type': 'JobPosting',
      title: 'Senior ML Engineer',
      datePosted: '2026-07-01T00:00:00.000Z',
      hiringOrganization: { name: 'CheekyCheeseIT' },
      jobLocationType: 'TELECOMMUTE',
      applicantLocationRequirements: { '@type': 'Country', name: 'Worldwide' },
    })
    expect(() =>
      assertJsonLd(html, {
        url: '/careers/senior-ml-engineer',
        file: 'careers/senior-ml-engineer/index.html',
        requireJsonLd: 'job-posting',
      }),
    ).not.toThrow()
  })
})
