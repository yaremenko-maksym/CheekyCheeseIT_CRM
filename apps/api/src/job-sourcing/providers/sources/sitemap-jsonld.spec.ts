import { describe, expect, it } from 'vitest'
import { fakeCollectionContext } from '../../../test/fake-collection-context'
import { DEFAULT_XML_LIMITS } from '../../xml/xml-limits'
import type { JsonLdJobPosting } from '../../structuring/json-ld'
import {
  canonicalUrlOf,
  collectSitemapJsonLd,
  lastmodCreatedAtMs,
  MAX_SITEMAP_PARTS,
  oneAtsHostedJob,
  parseSitemapOf,
  selectByCanonical,
  type SitemapJob,
  type SitemapJsonLdSite,
  sitemapLimits,
  detailsToReadOf,
  DRIFT_WINDOW_MS,
  hexIdCreatedAtMs,
} from './sitemap-jsonld'

/** The generic sitemap + JSON-LD core, on a synthetic site (task sources-13). */
const SITE: SitemapJsonLdSite = {
  type: 'JUSTJOIN_HTML',
  adapterVersion: 'test-1',
  namespace: 'justjoin',
  sitemapUrl: 'https://justjoin.it/index.xml',
  sitemapLimits: sitemapLimits(1024 * 1024),
  jobUrl: /^https:\/\/justjoin\.it\/job-offer\/([a-z0-9-]+)$/,
  order: 'LASTMOD',
  sitemapPart: /^https:\/\/justjoin\.it\/part\d\.xml$/,
  descriptionKind: 'html',
  createdAtMs: lastmodCreatedAtMs,
  select: selectByCanonical,
}

const job = (id: string, lastmod?: string): string =>
  `<url><loc>https://justjoin.it/job-offer/${id}</loc>${lastmod === undefined ? '' : `<lastmod>${lastmod}</lastmod>`}</url>`
const urlset = (...entries: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.join('')}</urlset>`
const index = (...locs: string[]) =>
  `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<sitemap><loc>${l}</loc></sitemap>`)
    .join('')}</sitemapindex>`
const part = (n: number) => `https://justjoin.it/part${n}.xml`

describe('LASTMOD order', () => {
  it('reads each lastmod, and an absent or unparseable one as null', () => {
    const parsed = parseSitemapOf(
      SITE,
      urlset(
        job('a', '2026-11-20'),
        job('b'),
        job('c', 'soon'),
        job('d', '\n  2026-11-20T03:00:05+00:00\n  '),
      ),
    )
    expect(parsed).toEqual({
      ok: true,
      jobs: [
        { id: 'a', url: 'https://justjoin.it/job-offer/a', lastmod: Date.parse('2026-11-20') },
        { id: 'b', url: 'https://justjoin.it/job-offer/b', lastmod: null },
        { id: 'c', url: 'https://justjoin.it/job-offer/c', lastmod: null },
        // A pretty-printed lastmod is trimmed: untrimmed, Date.parse reads it as NaN.
        {
          id: 'd',
          url: 'https://justjoin.it/job-offer/d',
          lastmod: Date.parse('2026-11-20T03:00:05+00:00'),
        },
      ],
    })
  })

  it('orders newest first, a null lastmod last, a tie in document order, and caps', () => {
    const jobs: SitemapJob[] = [
      { id: 'old', url: 'u1', lastmod: 1 },
      { id: 'none', url: 'u2', lastmod: null },
      { id: 'new', url: 'u3', lastmod: 3 },
      { id: 'tie-a', url: 'u4', lastmod: 2 },
      { id: 'tie-b', url: 'u5', lastmod: 2 },
    ]
    const ids = (max: number) => detailsToReadOf(SITE, jobs, new Set(), max, 0).map((j) => j.id)
    expect(ids(10)).toEqual(['new', 'tie-a', 'tie-b', 'old', 'none'])
    expect(ids(2)).toEqual(['new', 'tie-a'])
  })
})

describe('a sitemap index', () => {
  const run = async (
    responses: { bodyText?: string; status?: number }[],
    maxDetails = 5,
    site: SitemapJsonLdSite = SITE,
  ) => {
    const f = fakeCollectionContext({ now: new Date('2026-11-21T09:00:00Z'), responses })
    const sleeps: number[] = []
    const batch = await collectSitemapJsonLd(
      site,
      { maxDetails, minGapMs: 3000 },
      {
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        random: () => 0,
      },
      { namespace: 'justjoin', configVersion: 1 },
      f.ctx,
    )
    return { batch, f, sleeps }
  }
  const { sitemapPart: _ignored, ...PLAIN } = SITE

  it('waits the gap before every part, and numbers each sitemap document as its own page', async () => {
    const { batch, sleeps } = await run(
      [
        { bodyText: index(part(0), part(1)) },
        { bodyText: urlset(job('a', '2026-11-19')) },
        { bodyText: urlset() },
        { status: 404 },
      ],
      1,
    )
    // Two parts and one detail, each after a 3 s gap; the index itself is not delayed.
    expect(sleeps).toEqual([3000, 3000, 3000])
    expect(batch.requests.slice(0, 3).map((r) => r.page)).toEqual([1, 2, 3])
  })

  it('a cancelled wait before a part ends the run CANCELLED without requesting the part', async () => {
    const f = fakeCollectionContext({
      now: new Date('2026-11-21T09:00:00Z'),
      responses: [{ bodyText: index(part(0)) }],
    })
    const batch = await collectSitemapJsonLd(
      SITE,
      { maxDetails: 5, minGapMs: 3000 },
      {
        sleep: async () => {
          throw new Error('aborted')
        },
        random: () => 0,
      },
      { namespace: 'justjoin', configVersion: 1 },
      f.ctx,
    )
    expect(f.sent).toHaveLength(1)
    expect(batch.outcome).toBe('CANCELLED')
    expect(batch.requests.at(-1)).toMatchObject({
      page: 2,
      url: part(0),
      status: null,
      error: { code: 'CANCELLED', message: 'the run was cancelled before this request' },
    })
  })

  it('reads a part <loc> trimmed, and skips a <sitemap> without one', async () => {
    const xml = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><lastmod>2026-11-20</lastmod></sitemap><sitemap><loc>\n  ${part(0)}\n</loc></sitemap></sitemapindex>`
    const { f } = await run([{ bodyText: xml }, { bodyText: urlset() }])
    expect(f.sent.map((r) => r.url)).toEqual(['https://justjoin.it/index.xml', part(0)])
  })

  it('an index body that is not XML fails the run as drift', async () => {
    const { batch, f } = await run([{ bodyText: 'not xml at all' }])
    expect(f.sent).toHaveLength(1)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests[0]?.error?.code).toBe('PARSE_DRIFT')
  })

  it('a site without parts reads an index at its sitemap URL as drift, not as an index', async () => {
    const { batch, f } = await run([{ bodyText: index(part(0)) }], 5, PLAIN)
    expect(f.sent).toHaveLength(1)
    expect(batch.requests[0]?.error?.message).toBe('sitemap: root is <sitemapindex>')
  })

  it('reads at most two allowed parts, each once, and merges their jobs once each', async () => {
    const { f } = await run(
      [
        { bodyText: index(part(0), 'https://evil.example/part1.xml', part(0), part(1), part(2)) },
        { bodyText: urlset(job('a', '2026-11-19'), job('b', '2026-11-18')) },
        { bodyText: urlset(job('a', '2026-11-19'), job('c', '2026-11-20')) },
        { status: 404 },
        { status: 404 },
        { status: 404 },
      ],
      5,
    )
    expect(MAX_SITEMAP_PARTS).toBe(2)
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://justjoin.it/index.xml',
      part(0),
      part(1),
      'https://justjoin.it/job-offer/c',
      'https://justjoin.it/job-offer/a',
      'https://justjoin.it/job-offer/b',
    ])
  })

  it('caps the run at the index, two parts and maxDetails requests', async () => {
    const many = urlset(...Array.from({ length: 10 }, (_, i) => job(`j${i}`)))
    const { f, batch } = await run(
      [
        { bodyText: index(part(0)) },
        { bodyText: many },
        { status: 404 },
        { status: 404 },
        { status: 404 },
      ],
      3,
    )
    expect(f.sent).toHaveLength(5)
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('a plain urlset at the index URL is read as the job list', async () => {
    const { f } = await run([{ bodyText: urlset(job('a')) }, { status: 404 }])
    expect(f.sent.map((r) => r.url)).toEqual([
      'https://justjoin.it/index.xml',
      'https://justjoin.it/job-offer/a',
    ])
  })

  it('a failed part ends the run before any detail request', async () => {
    const { f, batch } = await run([{ bodyText: index(part(0)) }, { status: 403 }])
    expect(f.sent).toHaveLength(2)
    expect(batch.outcome).toBe('FAILED')
  })

  it('a site without parts reads an index as drift', () => {
    expect(parseSitemapOf(PLAIN, index(part(0)))).toEqual({
      ok: false,
      message: 'root is <sitemapindex>',
    })
  })
})

describe('drift counts only bad pages of recent postings (CR-L-1)', () => {
  const NOW = new Date('2026-11-21T09:00:00Z')
  const { sitemapPart: _ignored, ...PLAIN } = SITE
  const run = async (...lastmods: (string | undefined)[]) => {
    const ids = lastmods.map((_, i) => `p${i}`)
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        { bodyText: urlset(...ids.map((id, i) => job(id, lastmods[i]))) },
        ...ids.map(() => ({ bodyText: '<html><body>no posting</body></html>' })),
      ],
    })
    return collectSitemapJsonLd(
      PLAIN,
      { maxDetails: 3, minGapMs: 0 },
      { sleep: async () => {}, random: () => 0 },
      { namespace: 'justjoin', configVersion: 1 },
      f.ctx,
    )
  }

  it('three bad pages of postings changed within a day, or of unknown age, are drift', async () => {
    const batch = await run('2026-11-21T08:00:00Z', undefined, '2026-11-20T09:00:01Z')
    expect(batch.counts.invalid).toBe(3)
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: '3 of 3 job pages had no matching JSON-LD JobPosting',
    })
  })

  it('a bad page of a posting a day old or more leaves its sample, never drift', async () => {
    const batch = await run('2026-11-21T08:00:00Z', '2026-11-20T09:00:00Z', undefined)
    expect(batch.counts.invalid).toBe(3)
    expect(batch.invalidSamples).toHaveLength(3)
    expect(batch.requests.every((r) => r.error === null)).toBe(true)
  })

  it('reads the age from the lastmod, or from the seconds a hex id starts with', () => {
    expect(DRIFT_WINDOW_MS).toBe(86_400_000)
    expect(lastmodCreatedAtMs({ id: 'a', url: 'u', lastmod: 5 })).toBe(5)
    expect(lastmodCreatedAtMs({ id: 'a', url: 'u', lastmod: null })).toBeNull()
    expect(lastmodCreatedAtMs({ id: 'a', url: 'u' })).toBeNull()
    expect(hexIdCreatedAtMs({ id: '6aff948bc0b7b1e5e0d27bfb', url: 'u' })).toBe(0x6aff948b * 1000)
  })

  it('lists an upper-case id as its lower-case form, keeping the URL as listed', () => {
    const upper = { ...SITE, jobUrl: /^https:\/\/justjoin\.it\/job-offer\/([a-zA-Z0-9-]+)$/ }
    expect(parseSitemapOf(upper, urlset(job('AbC'), job('abc')))).toEqual({
      ok: true,
      jobs: [{ id: 'abc', url: 'https://justjoin.it/job-offer/AbC', lastmod: null }],
    })
  })
})

describe('selection by canonical link', () => {
  const JOB: SitemapJob = { id: 'a', url: 'https://justjoin.it/job-offer/a' }
  const page = (href: string) => `<head><link rel="canonical" href="${href}"/></head>`
  const posting = { title: 't' } as JsonLdJobPosting

  it('reads the href of the canonical link only', () => {
    expect(canonicalUrlOf(page(JOB.url))).toBe(JOB.url)
    expect(canonicalUrlOf(`<link data-x="1" rel="canonical" href="${JOB.url}">`)).toBe(JOB.url)
    expect(canonicalUrlOf('<link rel="alternate" href="https://x.example/"/>')).toBeNull()
    expect(canonicalUrlOf('<link rel="canonical"/>')).toBeNull()
    expect(canonicalUrlOf('')).toBeNull()
  })

  it('matches the one posting of a page whose canonical link is the sitemap URL', () => {
    expect(selectByCanonical([posting], JOB, page(JOB.url))).toEqual({ kind: 'match', posting })
    expect(selectByCanonical([posting], JOB, page('https://justjoin.it/job-offer/b'))).toEqual({
      kind: 'none',
    })
    expect(selectByCanonical([], JOB, page(JOB.url))).toEqual({ kind: 'none' })
    expect(selectByCanonical([posting, posting], JOB, page(JOB.url))).toEqual({
      kind: 'ambiguous',
      count: 2,
    })
  })
})

describe('the employer ATS link', () => {
  const ASHBY = 'https://jobs.ashbyhq.com/acme/0b6f3c1e-1111-4222-8333-444455556666'
  const OTHER = 'https://jobs.ashbyhq.com/acme/9b6f3c1e-1111-4222-8333-444455556666'

  it('is the one ATS-hosted job every link names, else null', () => {
    expect(oneAtsHostedJob([])).toBeNull()
    expect(oneAtsHostedJob([ASHBY])).toBe(ASHBY)
    expect(oneAtsHostedJob([ASHBY, `${ASHBY}/application`])).toBe(ASHBY)
    expect(oneAtsHostedJob([ASHBY, OTHER])).toBeNull()
    expect(oneAtsHostedJob([ASHBY, 'https://acme.example/careers'])).toBeNull()
    expect(oneAtsHostedJob(['https://boards.greenhouse.io/acme'])).toBeNull()
  })
})

describe('limits', () => {
  it('replaces the byte cap, and the parse budget only when given', () => {
    expect(sitemapLimits(5)).toEqual({ ...DEFAULT_XML_LIMITS, maxBytes: 5 })
    expect(sitemapLimits(5, 7)).toEqual({ ...DEFAULT_XML_LIMITS, maxBytes: 5, maxWallClockMs: 7 })
    expect(sitemapLimits(5, 7, 9)).toEqual({
      ...DEFAULT_XML_LIMITS,
      maxBytes: 5,
      maxWallClockMs: 7,
      maxElements: 9,
    })
  })
})
