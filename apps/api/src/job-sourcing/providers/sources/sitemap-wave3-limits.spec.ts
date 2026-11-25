import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { xmlPort } from '../../xml/bounded-xml-port'
import { itemCeiling, MAX_XML_ELEMENTS } from '../../xml/xml-limits'
import { decodeXmlBody } from '../xml-source.provider'
import { JOBSPRESSO_BOUNDS, JOBSPRESSO_SITE, createJobspressoProvider } from './jobspresso.provider'
import { REACTJOBS_SITE } from './reactjobs.provider'
import { REMOTEFIRSTJOBS_SITE } from './remotefirstjobs.provider'
import { REMOTEIO_BOUNDS, REMOTEIO_SITE, createRemoteIoProvider } from './remoteio.provider'
import {
  detailsToReadOf,
  identityUrlOf,
  parseSitemapOf,
  siteIdentityKey,
  type SitemapJob,
  sitemapLimits,
  sitemapPartsOf,
} from './sitemap-jsonld'

/**
 * Wave-3 sitemap limits and ordering (second-opinion round so1 on PR #1498): the parse budget
 * against the full-size sitemaps, ReactJobs' numeric-id order, Jobspresso's newest parts first, and
 * the `g` / `y` flags of a shared indexed `jobUrl`.
 */

const NOW = new Date('2026-11-24T12:00:00Z')
const ROBOTS_OK = { bodyText: 'User-agent: *\nAllow: /\n' }
const deps = { sleep: async () => {}, random: () => 0 }

const urlset = (entries: string[], xmlns = 1): string => {
  const extra = xmlns > 1 ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${extra}>\n${entries.join('\n')}\n</urlset>\n`
}

/** The captured Remote.io shape: 5 elements a URL (url, loc, lastmod, changefreq, priority). */
const REMOTEIO_CATEGORIES = ['software-development', 'marketing', 'data', 'sales'] as const
const remoteIoEntry = (i: number): string =>
  `  <url>\n    <loc>https://remote.io/remote-jobs/${REMOTEIO_CATEGORIES[i % 4]}/senior-engineer-at-company-${i}-${3_000_000 + i}</loc>\n    <lastmod>2026-11-24</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.8</priority>\n  </url>`

describe('wave-3 sitemap parse budgets clear the full-size sitemaps', () => {
  it('Remote.io: a full-size sitemap (7 600 URLs of the captured shape) is read through the collector', async () => {
    const count = 7_600
    const xml = urlset(Array.from({ length: count }, (_, i) => remoteIoEntry(i)))
    const items = count * 5 + 1 + 1 // the elements, the urlset, its xmlns attribute
    // The default 250 ms budget (25 000 items) refused this on every run.
    expect(items).toBeGreaterThan(25_000)
    expect(itemCeiling(REMOTEIO_SITE.sitemapLimits)).toBe(90_000)
    expect(itemCeiling(REMOTEIO_SITE.sitemapLimits) / items).toBeGreaterThan(2.3)

    const listed = parseSitemapOf(REMOTEIO_SITE, xml)
    if (!listed.ok) throw new Error(listed.message)
    // Only the IT categories (software-development, data): half of the URLs.
    expect(listed.jobs).toHaveLength(count / 2)

    // Every IT job is held, so the run reads robots.txt and the sitemap only.
    const held = new Set(listed.jobs.map((j) => siteIdentityKey(REMOTEIO_SITE, j.id)))
    const f = fakeCollectionContext({ now: NOW, responses: [ROBOTS_OK, { bodyText: xml }] })
    f.ctx.heldIdentityKeys = async () => held
    const provider = createRemoteIoProvider(REMOTEIO_BOUNDS, deps)
    const batch = await provider.collectReport(provider.parseConfig({ configVersion: 1 }), f.ctx)
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://remote.io/robots.txt',
      'https://remote.io/sitemap-active-jobs.xml',
    ])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.requests.every((r) => r.error === undefined || r.error === null)).toBe(true)
  })

  it('ReactJobs: a full-size job part (3 523 URLs, 5 elements each, 3 xmlns) parses with about 2.3x headroom', () => {
    const count = 3_523
    const entries = Array.from(
      { length: count },
      (_, i) =>
        `    <url>\n        <loc>https://reactjobs.io/react-jobs/company-${i}/${i + 1}-frontend-developer-typescript-react</loc>\n        <lastmod>2026-11-23T23:00:10-05:00</lastmod>\n        <changefreq>daily</changefreq>\n        <priority>0.8</priority>\n        </url>`,
    )
    const listed = parseSitemapOf(REACTJOBS_SITE, urlset(entries, 2))
    if (!listed.ok) throw new Error(listed.message)
    expect(listed.jobs).toHaveLength(count)
    const items = count * 5 + 1 + 3 // the elements, the urlset, three xmlns attributes
    expect(itemCeiling(REACTJOBS_SITE.sitemapLimits)).toBe(40_000)
    expect(itemCeiling(REACTJOBS_SITE.sitemapLimits) / items).toBeGreaterThan(2.2)
  })

  it('Remote First Jobs: 400 ms = 40 000 items, about 4.6x the captured ~2 161 URLs of 4 elements', () => {
    const items = 2_161 * 4 + 1 + 1 // the elements, the urlset, its xmlns attribute
    expect(itemCeiling(REMOTEFIRSTJOBS_SITE.sitemapLimits)).toBe(40_000)
    expect(itemCeiling(REMOTEFIRSTJOBS_SITE.sitemapLimits) / items).toBeGreaterThan(4.5)
  })
})

describe('ReactJobs details the highest id first (NUMERIC_ID)', () => {
  // Every captured <lastmod> is the same regeneration time; the id rises with each posting.
  const job = (id: string): SitemapJob => ({
    id,
    url: `https://reactjobs.io/react-jobs/acme/${id}-frontend-developer`,
  })

  it('compares the ids as numbers, not as text: 8320, then 1000, then 999', () => {
    // As text, 999 would sort above 8320. The input order is neither ascending nor descending, so a
    // comparator that ignores its operands cannot land on the right order by accident.
    const jobs = [job('1000'), job('8320'), job('999')]
    const picked = detailsToReadOf(REACTJOBS_SITE, jobs, new Set(), 3, 0)
    expect(picked.map((j) => j.id)).toEqual(['8320', '1000', '999'])
  })

  it('stores no creation date: the <lastmod> is not read, and a job carrying one is still unknown', () => {
    const xml = urlset([
      '<url><loc>https://reactjobs.io/react-jobs/acme/8320-frontend-developer</loc><lastmod>2026-11-23T23:00:10-05:00</lastmod></url>',
    ])
    const listed = parseSitemapOf(REACTJOBS_SITE, xml)
    if (!listed.ok) throw new Error(listed.message)
    expect(listed.jobs[0]).toEqual({ id: '8320', url: job('8320').url })
    expect(REACTJOBS_SITE.createdAtMs(listed.jobs[0]!)).toBeNull()
    expect(REACTJOBS_SITE.createdAtMs({ ...job('8320'), lastmod: NOW.getTime() })).toBeNull()
  })
})

describe('Jobspresso reads its newest job-listing parts first', () => {
  const part = (n: number) => `https://jobspresso.co/job_listing-sitemap${n}.xml`
  const index = (ns: number[]): string =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${ns
      .map((n) => `<sitemap><loc>${part(n)}</loc></sitemap>`)
      .join('')}</sitemapindex>\n`
  const EMPTY = { bodyText: urlset([]) }

  it.each([
    ['multi-digit, by number, within the cap', [2, 10, 1, 3], [10, 3]],
    ['a duplicate part is read once', [3, 3, 1], [3, 1]],
  ])('reads the newest parts: %s', async (_label, listed, read) => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [ROBOTS_OK, { bodyText: index(listed) }, EMPTY, EMPTY],
    })
    f.ctx.heldIdentityKeys = async () => new Set()
    const provider = createJobspressoProvider(JOBSPRESSO_BOUNDS, deps)
    await provider.collectReport(provider.parseConfig({ configVersion: 1 }), f.ctx)
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://jobspresso.co/robots.txt',
      'https://jobspresso.co/sitemap_index.xml',
      ...read.map(part),
    ])
  })

  it('the part pattern names the part number as group 1', () => {
    expect(JOBSPRESSO_SITE.sitemapPart?.exec(part(12))?.[1]).toBe('12')
  })

  it('the part number is at most 4 digits (SR4-H-1)', () => {
    expect(JOBSPRESSO_SITE.sitemapPart?.test(part(9999))).toBe(true)
    expect(JOBSPRESSO_SITE.sitemapPart?.test(part(10000))).toBe(false)
  })
})

describe('sitemapPartsOf: linear de-dup and a total order', () => {
  const LIMITS = sitemapLimits(8 * 1024 * 1024, 10_000, MAX_XML_ELEMENTS)
  const rootOf = (locs: string[]) => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
      .map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`)
      .join('')}</sitemapindex>\n`
    const decoded = decodeXmlBody(xml, LIMITS, xmlPort)
    if (!decoded.ok) throw new Error(decoded.message)
    return decoded.value.root
  }
  const NUMBERED = /^https:\/\/x\.example\/part(\d+)\.xml$/
  const p = (n: number | string) => `https://x.example/part${n}.xml`

  it('an index of 40 000 distinct matching parts returns fast and keeps the two newest', () => {
    // 40 000 parts: 80 001 elements (under MAX_XML_ELEMENTS) and ~2.4 MB (under the 8 MiB cap).
    const root = rootOf(Array.from({ length: 40_000 }, (_, i) => p(i + 1)))
    const started = performance.now()
    const parts = sitemapPartsOf(NUMBERED, root)
    const elapsedMs = performance.now() - started
    expect(parts).toEqual([p(40_000), p(39_999)])
    // Linear: tens of ms. The quadratic `parts.includes` de-dup took over 10 s here (SR4-H-1);
    // the bound leaves wide room for a slow or instrumented runner and still fails the quadratic one.
    expect(elapsedMs).toBeLessThan(3_000)
  })

  // Each row lists the numbered parts ascending before the one that cannot be sorted on, so a sort
  // that ran anyway (the guard removed or weakened) would put the higher number first.
  it.each([
    ['a part the pattern does not number', /^https:\/\/x\.example\/part(\d+)?\.xml$/, ''],
    ["an empty number group (`Number('')` is 0)", /^https:\/\/x\.example\/part(\d*)\.xml$/, ''],
    ['an unsafe but finite number (17 digits)', NUMBERED, '9'.repeat(17)],
    ['a number past the finite range (400 digits)', NUMBERED, '9'.repeat(400)],
  ])('%s keeps every part in index order', (_label, pattern, odd) => {
    expect(sitemapPartsOf(pattern, rootOf([p(1), p(3), p(odd)]))).toEqual([p(1), p(3)])
  })

  it('a pattern with no number group keeps the index order (the fallback only; the rows above pin the guard)', () => {
    const pattern = /^https:\/\/x\.example\/part[0-9]\.xml$/
    expect(sitemapPartsOf(pattern, rootOf([p(1), p(3), p(2)]))).toEqual([p(1), p(3)])
  })
})

describe('identityUrlOf drops the g and y flags of the shared indexed copy', () => {
  it.each(['g', 'y', 'gy', 'dgy'])(
    'a jobUrl with flags "%s" lower-cases the id on every call, not only the first',
    (flags) => {
      const site = {
        ...REACTJOBS_SITE,
        jobUrl: new RegExp('^https://reactjobs\\.io/j/([A-Z0-9]+)-[a-z-]+$', flags),
      }
      const url = 'https://reactjobs.io/j/AB12-front-end-react'
      for (let call = 0; call < 3; call += 1) {
        expect(identityUrlOf(site, url)).toBe('https://reactjobs.io/j/ab12-front-end-react')
      }
    },
  )
})
