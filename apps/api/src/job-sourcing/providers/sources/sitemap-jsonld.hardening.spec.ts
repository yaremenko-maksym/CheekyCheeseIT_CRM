import { describe, expect, it } from 'vitest'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { selectByIdentity } from '../../structuring/json-ld'
import { hasDeclaredSitemap, ROBOTS_MAX_BYTES } from './robots-file'
import {
  collectSitemapJsonLd,
  lastmodCreatedAtMs,
  siteIdentityKey,
  type SitemapJsonLdSite,
  sitemapLimits,
} from './sitemap-jsonld'

/**
 * Task sources-16: robots.txt read in code before every sitemap and detail URL (H-1), no redirect
 * followed (H-2), a 410 detail is gone like a 404 (H-4), one request report per fetch (H-5). On a
 * synthetic site, so each rule is pinned once for all four sitemap sources.
 */
const NOW = new Date('2026-11-21T09:00:00Z')
const ORIGIN = 'https://jobs.example'
const ROBOTS = `${ORIGIN}/robots.txt`
const SITEMAP = `${ORIGIN}/sitemap.xml`
const urlOf = (id: string) => `${ORIGIN}/job/${id}`
const partOf = (n: number) => `${ORIGIN}/part${n}.xml`

const SITE: SitemapJsonLdSite = {
  type: 'JUSTJOIN_HTML',
  adapterVersion: 'test-1',
  namespace: 'justjoin',
  sitemapUrl: SITEMAP,
  sitemapLimits: sitemapLimits(1024 * 1024),
  jobUrl: /^https:\/\/jobs\.example\/job\/([a-z0-9-]+)$/,
  order: 'LASTMOD',
  descriptionKind: 'text',
  createdAtMs: lastmodCreatedAtMs,
  select: (postings, job) => selectByIdentity(postings, { url: job.url }),
}
const WITH_PARTS: SitemapJsonLdSite = {
  ...SITE,
  sitemapPart: /^https:\/\/jobs\.example\/part\d\.xml$/,
}

const urlset = (...ids: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${ids
    .map((id) => `<url><loc>${urlOf(id)}</loc></url>`)
    .join('')}</urlset>`
const index = (...locs: string[]) =>
  `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<sitemap><loc>${l}</loc></sitemap>`)
    .join('')}</sitemapindex>`
const page = (id: string) => ({
  bodyText: `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: `Engineer ${id}`,
    url: urlOf(id),
    hiringOrganization: { '@type': 'Organization', name: 'Acme' },
    description: 'Build things.',
  })}</script></head></html>`,
})
const robots = (body = 'User-agent: *\nDisallow: /secret\n', headers?: Record<string, string>) => ({
  bodyText: body,
  ...(headers === undefined ? {} : { headers }),
})
const sitemap = (...ids: string[]) => ({ bodyText: urlset(...ids) })

async function run(
  responses: FakeResponse[],
  opts: {
    site?: SitemapJsonLdSite
    maxDetails?: number
    savePage?: 'throws'
    sleep?: (ms: number) => Promise<void>
    heldKeys?: ReadonlySet<string>
  } = {},
) {
  const f = fakeCollectionContext({ now: NOW, responses })
  if (opts.heldKeys !== undefined) {
    f.ctx.heldIdentityKeys = async (keys) => {
      const held = new Set<string>()
      for (const k of keys) {
        if (opts.heldKeys!.has(k)) held.add(k)
      }
      return held
    }
  }
  if (opts.savePage === 'throws') {
    f.ctx.checkpoints.savePage = () => Promise.reject(new Error('disk full'))
  }
  const sleeps: number[] = []
  const batch = await collectSitemapJsonLd(
    opts.site ?? SITE,
    { maxDetails: opts.maxDetails ?? 5, minGapMs: 3000 },
    {
      sleep:
        opts.sleep ??
        (async (ms) => {
          sleeps.push(ms)
        }),
      random: () => 0,
    },
    { namespace: 'justjoin', configVersion: 1 },
    f.ctx,
  )
  return { batch, f, sleeps }
}
const urls = (f: { sent: { url: string }[] }) => f.sent.map((r) => r.url)

describe('H-1: robots.txt, once per run, before anything else', () => {
  it("is the run's first request: the sitemap origin's robots.txt, capped, never redirected", async () => {
    const { batch, f, sleeps } = await run([robots(), sitemap('a'), page('a')])
    expect(urls(f)).toEqual([ROBOTS, SITEMAP, urlOf('a')])
    expect(f.sent[0]).toEqual({
      url: ROBOTS,
      headers: { accept: 'text/plain' },
      maxBytes: ROBOTS_MAX_BYTES,
      followRedirects: false,
    })
    expect(ROBOTS_MAX_BYTES).toBe(500 * 1024)
    expect(batch.requests[0]).toMatchObject({ page: 1, url: ROBOTS, status: 200, error: null })
    // The sitemap now comes after a request too, so it waits the gap like every later one.
    expect(sleeps).toEqual([3000, 3000])
    expect(batch.observations).toHaveLength(1)
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('a detail robots disallows is never requested: skipped, and counted by its sample', async () => {
    const { batch, f } = await run([
      robots('User-agent: *\nDisallow: /job/b\n'),
      sitemap('a', 'b', 'c'),
      page('a'),
      page('c'),
    ])
    expect(urls(f)).toEqual([ROBOTS, SITEMAP, urlOf('a'), urlOf('c')])
    expect(batch.observations).toHaveLength(2)
    expect(batch.invalidSamples.map((s) => s.reason)).toEqual([
      'robots: DISALLOWED_BY_ROBOTS (1 jobs)',
    ])
    expect(JSON.stringify(batch.invalidSamples[0])).toContain(urlOf('b'))
    // Nothing was fetched for it: no request report, no raw page.
    expect(batch.requests).toHaveLength(f.sent.length)
    expect(batch.counts.raw).toBe(2)
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('newest disallowed jobs do not starve the allowed ones', async () => {
    const { batch, f } = await run(
      [
        robots('User-agent: *\nDisallow: /job/c\nDisallow: /job/d\n'),
        sitemap('d', 'c', 'b', 'a'),
        page('b'),
        page('a'),
      ],
      { maxDetails: 2 },
    )
    expect(urls(f)).toEqual([ROBOTS, SITEMAP, urlOf('b'), urlOf('a')])
    expect(batch.observations).toHaveLength(2)
    expect(batch.invalidSamples.map((s) => s.reason)).toEqual([
      'robots: DISALLOWED_BY_ROBOTS (2 jobs)',
    ])
    expect(JSON.stringify(batch.invalidSamples[0])).toContain(urlOf('d'))
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('every detail disallowed: ends ACCESS_POLICY with zero observations and one aggregated sample', async () => {
    const { batch, f } = await run([robots('User-agent: *\nDisallow: /job/\n'), sitemap('a', 'b')])
    expect(urls(f)).toEqual([ROBOTS, SITEMAP])
    expect(batch.invalidSamples.map((s) => s.reason)).toEqual([
      'robots: DISALLOWED_BY_ROBOTS (2 jobs)',
    ])
    expect(JSON.stringify(batch.invalidSamples[0])).toContain(urlOf('a'))
    expect(batch.observations).toEqual([])
    expect(batch.requests.at(-1)).toMatchObject({
      url: SITEMAP,
      status: null,
      error: { code: 'ACCESS_POLICY', message: 'robots: every job page disallowed' },
    })
    expect(batch.outcome).toBe('FAILED')
  })

  it('held jobs are not counted in disallowed sample', async () => {
    const { batch, f } = await run(
      [
        robots('User-agent: *\nDisallow: /job/a\nDisallow: /job/b\n'),
        sitemap('a', 'b', 'c'),
        page('c'),
      ],
      { heldKeys: new Set([siteIdentityKey(SITE, 'a')]) },
    )
    expect(urls(f)).toEqual([ROBOTS, SITEMAP, urlOf('c')])
    expect(batch.observations).toHaveLength(1)
    expect(batch.invalidSamples.map((s) => s.reason)).toEqual([
      'robots: DISALLOWED_BY_ROBOTS (1 jobs)',
    ])
    expect(JSON.stringify(batch.invalidSamples[0])).toContain(urlOf('b'))
  })

  it('held allowed + unseen disallowed: run succeeds, one sample, zero detail requests', async () => {
    const { batch, f } = await run(
      [robots('User-agent: *\nDisallow: /job/b\n'), sitemap('a', 'b')],
      { heldKeys: new Set([siteIdentityKey(SITE, 'a')]) },
    )
    expect(urls(f)).toEqual([ROBOTS, SITEMAP])
    expect(batch.observations).toHaveLength(0)
    expect(batch.invalidSamples.map((s) => s.reason)).toEqual([
      'robots: DISALLOWED_BY_ROBOTS (1 jobs)',
    ])
    expect(JSON.stringify(batch.invalidSamples[0])).toContain(urlOf('b'))
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('every listed job disallowed (held and unseen): ends ACCESS_POLICY', async () => {
    const { batch, f } = await run(
      [robots('User-agent: *\nDisallow: /job/\n'), sitemap('a', 'b')],
      { heldKeys: new Set([siteIdentityKey(SITE, 'a')]) },
    )
    expect(urls(f)).toEqual([ROBOTS, SITEMAP])
    expect(batch.invalidSamples.map((s) => s.reason)).toEqual([
      'robots: DISALLOWED_BY_ROBOTS (1 jobs)',
    ])
    expect(JSON.stringify(batch.invalidSamples[0])).toContain(urlOf('b'))
    expect(batch.observations).toEqual([])
    expect(batch.requests.at(-1)).toMatchObject({
      url: SITEMAP,
      status: null,
      error: { code: 'ACCESS_POLICY', message: 'robots: every job page disallowed' },
    })
    expect(batch.outcome).toBe('FAILED')
  })

  it('every listed job disallowed (all held): ends ACCESS_POLICY', async () => {
    const { batch, f } = await run([robots('User-agent: *\nDisallow: /job/\n'), sitemap('a')], {
      heldKeys: new Set([siteIdentityKey(SITE, 'a')]),
    })
    expect(urls(f)).toEqual([ROBOTS, SITEMAP])
    expect(batch.invalidSamples).toEqual([])
    expect(batch.observations).toHaveLength(0)
    expect(batch.requests.at(-1)).toMatchObject({
      url: SITEMAP,
      status: null,
      error: { code: 'ACCESS_POLICY', message: 'robots: every job page disallowed' },
    })
    expect(batch.outcome).toBe('FAILED')
  })

  it('when all jobs are held and allowed, the run finishes without ACCESS_POLICY', async () => {
    const { batch, f } = await run([robots(), sitemap('a')], {
      heldKeys: new Set([siteIdentityKey(SITE, 'a')]),
    })
    expect(urls(f)).toEqual([ROBOTS, SITEMAP])
    expect(batch.observations).toHaveLength(0)
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('when sitemap is empty, the run finishes without ACCESS_POLICY', async () => {
    const { batch, f } = await run([robots('User-agent: *\nDisallow: /job/\n'), sitemap()])
    expect(urls(f)).toEqual([ROBOTS, SITEMAP])
    expect(batch.observations).toHaveLength(0)
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('a cross-origin child sitemap is rejected as ACCESS_POLICY', async () => {
    const { batch, f } = await run(
      [robots(), { bodyText: index('https://other-domain.com/part0.xml') }],
      { site: { ...WITH_PARTS, sitemapPart: /^https:\/\/[^/]+\/part\d\.xml$/ } },
    )
    expect(urls(f)).toEqual([ROBOTS, SITEMAP])
    expect(batch.requests.at(-1)).toMatchObject({
      url: 'https://other-domain.com/part0.xml',
      error: { code: 'ACCESS_POLICY', message: 'robots: CROSS_ORIGIN' },
    })
    expect(batch.outcome).toBe('FAILED')
  })

  it('a cross-origin job page in sitemap is rejected as ACCESS_POLICY', async () => {
    const { batch, f } = await run(
      [
        robots(),
        { bodyText: `<urlset><url><loc>https://other-domain.com/job/a</loc></url></urlset>` },
      ],
      {
        site: { ...SITE, jobUrl: /^https:\/\/[^/]+\/job\/([a-z0-9-]+)$/ },
        maxDetails: 0,
      },
    )
    expect(urls(f)).toEqual([ROBOTS, SITEMAP])
    expect(batch.requests.at(-1)).toMatchObject({
      url: 'https://other-domain.com/job/a',
      error: { code: 'ACCESS_POLICY', message: 'robots: CROSS_ORIGIN' },
    })
    expect(batch.outcome).toBe('FAILED')
  })

  it('robots for our own product token binds too, not only the wildcard', async () => {
    const { f } = await run([
      robots('User-agent: CheekyCheeseIT-CRM\nDisallow: /job/a\n\nUser-agent: *\nAllow: /\n'),
      sitemap('a', 'b'),
      page('b'),
    ])
    expect(urls(f)).toEqual([ROBOTS, SITEMAP, urlOf('b')])
  })

  it('a disallowed sitemap is never requested: the run fails closed as ACCESS_POLICY', async () => {
    const { batch, f } = await run([robots('User-agent: *\nDisallow: /sitemap.xml\n')])
    expect(urls(f)).toEqual([ROBOTS])
    expect(batch.requests.at(-1)).toMatchObject({
      url: SITEMAP,
      status: null,
      error: { code: 'ACCESS_POLICY', message: 'robots: DISALLOWED_BY_ROBOTS' },
    })
    expect(batch.outcome).toBe('FAILED')
  })

  it('a disallowed child sitemap is never requested either', async () => {
    const { batch, f } = await run(
      [
        robots('User-agent: *\nDisallow: /part1.xml\n'),
        { bodyText: index(partOf(0), partOf(1)) },
        sitemap(),
      ],
      { site: WITH_PARTS },
    )
    expect(urls(f)).toEqual([ROBOTS, SITEMAP, partOf(0)])
    expect(batch.requests.at(-1)).toMatchObject({
      url: partOf(1),
      error: { code: 'ACCESS_POLICY', message: 'robots: DISALLOWED_BY_ROBOTS' },
    })
    expect(batch.outcome).toBe('FAILED')
  })

  it('a Crawl-delay longer than the gap is honoured before every later request', async () => {
    const { sleeps } = await run([
      robots('User-agent: *\nCrawl-delay: 10\n'),
      sitemap('a'),
      page('a'),
    ])
    expect(sleeps).toEqual([10_000, 10_000])
  })

  it('a Crawl-delay no scheduler can honour pauses the run before the sitemap', async () => {
    const { batch, f } = await run([robots('User-agent: *\nCrawl-delay: 99999999\n')])
    expect(urls(f)).toEqual([ROBOTS])
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'ACCESS_POLICY',
      message: 'robots: CRAWL_DELAY_TOO_LONG',
    })
    expect(batch.outcome).toBe('FAILED')
  })

  it('a job URL on another origin is judged by no robots file read: it fails closed, unrequested', async () => {
    const other: SitemapJsonLdSite = {
      ...SITE,
      jobUrl: /^https:\/\/other\.example\/job\/([a-z]+)$/,
    }
    const { batch, f } = await run(
      [
        robots(),
        {
          bodyText: `<?xml version="1.0"?><urlset><url><loc>https://other.example/job/a</loc></url></urlset>`,
        },
      ],
      { site: other },
    )
    expect(urls(f)).toEqual([ROBOTS, SITEMAP])
    expect(batch.requests.at(-1)).toMatchObject({
      url: 'https://other.example/job/a',
      error: { code: 'ACCESS_POLICY', message: 'robots: CROSS_ORIGIN' },
    })
    expect(batch.outcome).toBe('FAILED')
  })

  describe('fails closed on a robots answer that is not a robots file (as the listing collector)', () => {
    it.each([
      ['a redirect', { status: 301 }, 'UPSTREAM'],
      ['a refusal', { status: 403 }, 'ACCESS_POLICY'],
      ['a 410 (as today: only a detail may be gone)', { status: 410 }, 'UPSTREAM'],
      ['a server error', { status: 503 }, 'UPSTREAM'],
    ])('%s ends the run on robots alone', async (_name, response, code) => {
      const { batch, f } = await run([response])
      expect(urls(f)).toEqual([ROBOTS])
      expect(batch.requests).toHaveLength(1)
      expect(batch.requests[0]?.error?.code).toBe(code)
      expect(batch.outcome).toBe('FAILED')
    })

    it.each([
      ['an HTML page', robots('<!doctype html><html>hi</html>')],
      ['a body with no directive line', robots('{"blocked": true}')],
      ['a non-text type', robots('User-agent: *\nAllow: /\n', { 'content-type': 'text/html' })],
    ])('%s is drift, and nothing else is requested', async (_name, response) => {
      const { batch, f } = await run([response])
      expect(urls(f)).toEqual([ROBOTS])
      expect(batch.requests).toEqual([
        expect.objectContaining({
          url: ROBOTS,
          status: 200,
          error: { code: 'PARSE_DRIFT', message: 'robots: the body is not a robots.txt file' },
        }),
      ])
      expect(batch.outcome).toBe('FAILED')
    })

    it('an empty robots.txt, a text/plain one, or none at all (404) allows all', async () => {
      for (const first of [
        robots(''),
        robots('User-agent: *\nAllow: /\n', { 'content-type': 'text/plain; charset=utf-8' }),
        { status: 404 },
        // A 404 page is HTML: only a 200 body is judged as a robots file.
        {
          status: 404,
          ...robots('<!doctype html><html>Not found</html>', { 'content-type': 'text/html' }),
        },
      ]) {
        const { batch, f } = await run([first, sitemap('a'), page('a')])
        expect(urls(f)).toEqual([ROBOTS, SITEMAP, urlOf('a')])
        expect(batch.requests[0]?.error).toBeNull()
        expect(batch.observations).toHaveLength(1)
      }
    })
  })

  it('a cancelled gap before the sitemap ends the run CANCELLED without requesting it', async () => {
    const { batch, f } = await run([robots()], {
      sleep: () => Promise.reject(new Error('aborted')),
    })
    expect(urls(f)).toEqual([ROBOTS])
    expect(batch.requests.at(-1)).toMatchObject({
      page: 1,
      url: SITEMAP,
      error: { code: 'CANCELLED', message: 'the run was cancelled before this request' },
    })
    expect(batch.outcome).toBe('CANCELLED')
  })

  it('the request cap counts robots: a full run still reaches its last detail', async () => {
    const { batch, f } = await run(
      [
        robots(),
        { bodyText: index(partOf(0), partOf(1)) },
        sitemap('a', 'b'),
        sitemap('c'),
        page('a'),
        page('b'),
        page('c'),
      ],
      { site: WITH_PARTS, maxDetails: 3 },
    )
    expect(f.sent).toHaveLength(7)
    expect(batch.requests.every((r) => r.error === null)).toBe(true)
    expect(batch.observations).toHaveLength(3)
  })
})

describe('H-2: no redirect is followed', () => {
  it('asks the transport not to follow redirects on every request', async () => {
    const { f } = await run([robots(), sitemap('a'), page('a')])
    expect(f.sent.map((r) => r.followRedirects)).toEqual([false, false, false])
  })

  it('a sitemap that answers a redirect fails closed as drift; its target is never requested', async () => {
    const { batch, f } = await run([robots(), { status: 301 }])
    expect(urls(f)).toEqual([ROBOTS, SITEMAP])
    expect(batch.requests.at(-1)).toMatchObject({
      url: SITEMAP,
      status: 301,
      error: { code: 'PARSE_DRIFT', message: 'sitemap: redirected (HTTP 301)' },
    })
    expect(batch.outcome).toBe('FAILED')
  })

  it('a 300 is a redirect too: the lowest 3xx is drift on a sitemap, skipped on a detail', async () => {
    const onSitemap = await run([robots(), { status: 300 }])
    expect(onSitemap.batch.requests.at(-1)?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: 'sitemap: redirected (HTTP 300)',
    })
    const onDetail = await run([robots(), sitemap('a', 'b'), { status: 300 }, page('b')])
    expect(onDetail.batch.requests[2]).toMatchObject({ status: 300, error: null })
    expect(onDetail.batch.counts).toMatchObject({ raw: 1, normalized: 1, invalid: 0 })
    expect(onDetail.batch.invalidSamples).toEqual([])
    expect(onDetail.batch.outcome).toBe('SUCCEEDED')
  })

  it('a child sitemap that answers a redirect fails closed too', async () => {
    const { batch, f } = await run([robots(), { bodyText: index(partOf(0)) }, { status: 307 }], {
      site: WITH_PARTS,
    })
    expect(urls(f)).toEqual([ROBOTS, SITEMAP, partOf(0)])
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: 'sitemap: redirected (HTTP 307)',
    })
    expect(batch.outcome).toBe('FAILED')
  })

  it('a detail that answers a redirect is skipped like a 404: reported, nothing recorded', async () => {
    const { batch, f } = await run([robots(), sitemap('a', 'b'), { status: 302 }, page('b')])
    expect(urls(f)).toEqual([ROBOTS, SITEMAP, urlOf('a'), urlOf('b')])
    expect(batch.requests[2]).toMatchObject({ url: urlOf('a'), status: 302, error: null })
    expect(batch.counts).toMatchObject({ raw: 1, normalized: 1, invalid: 0 })
    expect(batch.invalidSamples).toEqual([])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('two detail redirects in a row are a block: the run ends ACCESS_POLICY', async () => {
    const { batch, f } = await run([
      robots(),
      sitemap('a', 'b', 'c'),
      { status: 301 },
      { status: 308 },
    ])
    expect(urls(f)).toEqual([ROBOTS, SITEMAP, urlOf('a'), urlOf('b')])
    expect(batch.requests).toHaveLength(4)
    expect(batch.requests.at(-1)).toMatchObject({
      url: urlOf('b'),
      status: 308,
      error: {
        code: 'ACCESS_POLICY',
        message: '2 job pages in a row answered with a redirect (HTTP 308)',
      },
    })
    expect(batch.outcome).toBe('FAILED')
  })

  it('a 404, a 410 or a page between two redirects resets the count', async () => {
    for (const between of [{ status: 404 }, { status: 410 }, page('b')]) {
      const { batch, f } = await run([
        robots(),
        sitemap('a', 'b', 'c', 'd'),
        { status: 301 },
        between,
        { status: 301 },
        page('d'),
      ])
      expect(urls(f)).toHaveLength(6)
      expect(batch.requests.every((r) => r.error === null)).toBe(true)
      expect(batch.outcome).toBe('SUCCEEDED')
    }
  })
})

describe('H-4: a 410 Gone detail is gone, like a 404', () => {
  it('is skipped and the run goes on: nothing counted, no drift', async () => {
    const { batch, f } = await run([robots(), sitemap('a', 'b'), { status: 410 }, page('b')])
    expect(urls(f)).toEqual([ROBOTS, SITEMAP, urlOf('a'), urlOf('b')])
    expect(batch.requests[2]).toMatchObject({ url: urlOf('a'), status: 410, error: null })
    expect(batch.counts).toMatchObject({ raw: 1, normalized: 1, invalid: 0 })
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('many gone details are never drift', async () => {
    const { batch } = await run([
      robots(),
      sitemap('a', 'b', 'c', 'd'),
      { status: 410 },
      { status: 410 },
      { status: 404 },
      { status: 410 },
    ])
    expect(batch.requests.every((r) => r.error === null)).toBe(true)
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('a sitemap that answers 410 still fails the run (UPSTREAM), as before', async () => {
    const { batch } = await run([robots(), { status: 410 }])
    expect(batch.requests.at(-1)).toMatchObject({
      url: SITEMAP,
      status: 410,
      error: { code: 'UPSTREAM' },
    })
    expect(batch.outcome).toBe('FAILED')
  })
})

describe('H-5: one request report per fetch', () => {
  it('a page that cannot be persisted is reported once, with the persistence error', async () => {
    const { batch, f } = await run([robots(), sitemap('a', 'b'), page('a')], { savePage: 'throws' })
    expect(urls(f)).toEqual([ROBOTS, SITEMAP, urlOf('a')])
    expect(batch.requests).toHaveLength(f.sent.length)
    expect(batch.requests.at(-1)).toMatchObject({
      url: urlOf('a'),
      status: 200,
      error: { code: 'PERSISTENCE', message: 'disk full' },
    })
    expect(batch.counts.discarded).toBe(1)
    expect(batch.outcome).toBe('FAILED')
  })

  it('every kind of detail answer leaves exactly one report', async () => {
    const { batch, f } = await run([
      robots(),
      sitemap('a', 'b', 'c', 'd', 'e'),
      page('a'),
      { status: 404 },
      { bodyText: '<html>no posting</html>' },
      { status: 302 },
      { status: 410 },
    ])
    expect(f.sent).toHaveLength(7)
    expect(batch.requests).toHaveLength(f.sent.length)
    expect(batch.requests.map((r) => r.url)).toEqual(urls(f))
  })
})

describe('a site whose own sitemap URL redirects (JustJoin.it, to its CDN)', () => {
  const CDN = 'https://cdn.example/site'
  const mapped: SitemapJsonLdSite = {
    ...WITH_PARTS,
    sitemapRequestUrl: (listed) => listed.replace(ORIGIN, CDN),
  }

  it('when sitemapRequestUrl is set, missing Sitemap line in robots ends ACCESS_POLICY before any sitemap request', async () => {
    const { batch, f } = await run([robots()], { site: mapped })
    expect(urls(f)).toEqual([ROBOTS])
    expect(batch.requests.at(-1)).toMatchObject({
      url: mapped.sitemapUrl,
      status: null,
      error: { code: 'ACCESS_POLICY', message: 'robots: sitemap not declared' },
    })
    expect(batch.outcome).toBe('FAILED')
  })

  it('when sitemapRequestUrl is set, a 404 robots ends ACCESS_POLICY before any sitemap request', async () => {
    const { batch, f } = await run([{ status: 404 }], { site: mapped })
    expect(urls(f)).toEqual([ROBOTS])
    expect(batch.requests.at(-1)).toMatchObject({
      url: mapped.sitemapUrl,
      status: null,
      error: { code: 'ACCESS_POLICY', message: 'robots: sitemap not declared' },
    })
    expect(batch.outcome).toBe('FAILED')
  })

  it('when sitemapRequestUrl is set, an empty robots body ends ACCESS_POLICY before any sitemap request', async () => {
    const { batch, f } = await run([robots('')], { site: mapped })
    expect(urls(f)).toEqual([ROBOTS])
    expect(batch.requests.at(-1)).toMatchObject({
      url: mapped.sitemapUrl,
      status: null,
      error: { code: 'ACCESS_POLICY', message: 'robots: sitemap not declared' },
    })
    expect(batch.outcome).toBe('FAILED')
  })

  it.each([
    ['the site form', mapped.sitemapUrl],
    ['the request form', `${CDN}/sitemap.xml`],
  ])(
    'when sitemapRequestUrl is set, a robots Sitemap line with %s allows the run to proceed',
    async (_name, line) => {
      const { batch, f } = await run(
        [
          robots(`User-agent: *\nSitemap: ${line}\n`),
          { bodyText: index(partOf(0)) },
          sitemap('a'),
          page('a'),
        ],
        { site: mapped },
      )
      expect(urls(f)).toEqual([ROBOTS, `${CDN}/sitemap.xml`, `${CDN}/part0.xml`, urlOf('a')])
      expect(batch.observations).toHaveLength(1)
      expect(batch.outcome).toBe('SUCCEEDED')
    },
  )

  it('requests the canonical URL itself, judged by the site origin robots, and reports what it sent', async () => {
    const { batch, f } = await run(
      [
        robots(`User-agent: *\nSitemap: ${mapped.sitemapUrl}\n`),
        { bodyText: index(partOf(0)) },
        sitemap('a'),
        page('a'),
      ],
      { site: mapped },
    )
    expect(urls(f)).toEqual([ROBOTS, `${CDN}/sitemap.xml`, `${CDN}/part0.xml`, urlOf('a')])
    expect(f.sent.every((r) => r.followRedirects === false)).toBe(true)
    expect(batch.requests.map((r) => r.url)).toEqual(urls(f))
    expect(batch.observations).toHaveLength(1)
  })

  it('robots is read on the site form: a part the site disallows is not requested at the CDN', async () => {
    const { batch, f } = await run(
      [
        robots(`User-agent: *\nSitemap: ${mapped.sitemapUrl}\nDisallow: /part0.xml\n`),
        { bodyText: index(partOf(0)) },
      ],
      { site: mapped },
    )
    expect(urls(f)).toEqual([ROBOTS, `${CDN}/sitemap.xml`])
    expect(batch.requests.at(-1)?.error?.code).toBe('ACCESS_POLICY')
  })
})

describe('hasDeclaredSitemap', () => {
  it('strips BOM and recognizes declared sitemap', () => {
    expect(
      hasDeclaredSitemap('\uFEFFSitemap: https://target.com/s.xml', ['https://target.com/s.xml']),
    ).toBe(true)
  })

  it('splits on newlines even without spaces', () => {
    expect(
      hasDeclaredSitemap('User-agent:*\nDisallow:/\nSitemap:https://target.com/s.xml', [
        'https://target.com/s.xml',
      ]),
    ).toBe(true)
  })

  it('handles CRLF and CR line breaks', () => {
    expect(
      hasDeclaredSitemap('Sitemap: https://other.com\r\nSitemap: https://target.com/s.xml\r', [
        'https://target.com/s.xml',
      ]),
    ).toBe(true)
  })

  it('strips comments with hash', () => {
    expect(
      hasDeclaredSitemap('Sitemap: https://target.com/s.xml # trailing comment', [
        'https://target.com/s.xml',
      ]),
    ).toBe(true)
  })

  it('handles lines without colons and lines without comments', () => {
    expect(
      hasDeclaredSitemap('plain text line\nSitemap: https://target.com/s.xml', [
        'https://target.com/s.xml',
      ]),
    ).toBe(true)
    expect(hasDeclaredSitemap('sitemap-no-colon', ['sitemap-no-colon'])).toBe(false)
    expect(hasDeclaredSitemap('sitemapx', ['sitemapx'])).toBe(false)
  })

  it('trims whitespace before colon in sitemap directive', () => {
    expect(
      hasDeclaredSitemap('Sitemap : https://target.com/s.xml', ['https://target.com/s.xml']),
    ).toBe(true)
  })

  it('matches only sitemap directive, not other directives', () => {
    expect(
      hasDeclaredSitemap('User-agent: https://target.com/s.xml', ['https://target.com/s.xml']),
    ).toBe(false)
  })

  it('returns false when no declared sitemap matches', () => {
    expect(
      hasDeclaredSitemap('Sitemap: https://different.com/s.xml', ['https://target.com/s.xml']),
    ).toBe(false)
  })

  it('returns false for empty body', () => {
    expect(hasDeclaredSitemap('', ['https://target.com/s.xml'])).toBe(false)
  })
})

describe('CR-M-2: the listing is the inventory only when held postings can be told apart', () => {
  it('a capped run reading the sitemap whole claims FULL_INVENTORY when the held lookup exists', async () => {
    const { batch } = await run([robots(), sitemap('a', 'b', 'c'), page('a')], {
      maxDetails: 1,
      heldKeys: new Set(),
    })
    expect(batch.coverage).toBe('FULL_INVENTORY')
  })

  it('without the held lookup the same run is PARTIAL: an unread held posting would read as gone', async () => {
    const { batch } = await run([robots(), sitemap('a', 'b', 'c'), page('a')], { maxDetails: 1 })
    expect(batch.coverage).toBe('PARTIAL')
  })
})
