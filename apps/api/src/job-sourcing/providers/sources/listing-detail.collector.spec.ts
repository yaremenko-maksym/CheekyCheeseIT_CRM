import { describe, expect, it } from 'vitest'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { selectByIdentity } from '../../structuring/json-ld'
import { siteIdentityKey } from './sitemap-jsonld'
import { DEFAULT_USER_AGENT } from '../../http/bounded-fetch'
import {
  collectListingDetail,
  isNotRobotsFile,
  jsonLdDates,
  listingOf,
  MAX_PAGES_WITHOUT_POSTING,
  roundRobin,
  type ListingDetailSource,
  type ListingItem,
  requestsOf,
  ROBOTS_PRODUCT_TOKEN,
} from './listing-detail.collector'

/**
 * The shared listing + detail run, through a synthetic source: the listing body is a comma list
 * of ids, each detail page one hand-written JSON-LD JobPosting. The real parsers are pinned in the
 * Dice and No Fluff Jobs specs against their captures.
 */
const NOW = new Date('2026-11-21T10:00:00Z')
const HOST = 'https://jobs.example.test'
const ROBOTS = `${HOST}/robots.txt`
const LIST_A = `${HOST}/list?page=1`
const LIST_B = `${HOST}/list?page=2`
const urlOf = (id: string) => `${HOST}/job/${id}`

const source = (over: Partial<ListingDetailSource<ListingItem>> = {}) =>
  ({
    type: 'DICE_HTML',
    namespace: 'dice',
    adapterVersion: 'synthetic-1',
    robotsUrl: ROBOTS,
    listingUrls: [LIST_A, LIST_B],
    listingMaxBytes: 1000,
    detailMaxBytes: 2000,
    parseListing: (body: string) =>
      body.startsWith('ids:')
        ? {
            ok: true as const,
            items: body
              .slice(4)
              .split(',')
              .filter((id) => id !== '')
              .map((id) => ({ id, url: urlOf(id) })),
          }
        : { ok: false as const, message: 'not a list' },
    select: (postings, _html, item) => selectByIdentity(postings, { url: item.url }),
    map: (posting, item) => ({
      provider: 'DICE_HTML' as const,
      adapterVersion: 'synthetic-1',
      namespace: 'dice',
      nativeId: item.id,
      url: item.url,
      title: posting.title,
      companyName: posting.hiringOrganization,
      dates: jsonLdDates(posting),
    }),
    createdAtMs: () => null,
    ...over,
  }) satisfies ListingDetailSource<ListingItem>

const page = (id: string, extra: Record<string, unknown> = {}) =>
  `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'JobPosting',
    title: `Engineer ${id}`,
    url: urlOf(id),
    hiringOrganization: { '@type': 'Organization', name: 'Acme' },
    description: 'Build things.',
    ...extra,
  })}</script></head></html>`

const robots = (body = 'User-agent: *\nDisallow: /secret\n') => ({ bodyText: body })
const list = (ids: string) => ({ bodyText: `ids:${ids}` })
const cfg = { namespace: 'dice', configVersion: 1 }

async function run(
  responses: FakeResponse[],
  opts: {
    held?: ReadonlySet<string> | 'throws' | 'throws-text'
    maxDetails?: number
    over?: Partial<ListingDetailSource<ListingItem>>
    sleep?: (ms: number) => Promise<void>
    savePage?: 'throws' | 'throws-text'
    now?: Date
  } = {},
) {
  const f = fakeCollectionContext({ now: opts.now ?? NOW, responses })
  const asked: string[][] = []
  if (opts.held !== undefined) {
    const held = opts.held
    f.ctx.heldIdentityKeys = async (keys) => {
      asked.push([...keys])
      if (held === 'throws') throw new Error('connection reset')
      if (held === 'throws-text') throw 'reset'
      return held
    }
  }
  if (opts.savePage === 'throws') {
    f.ctx.checkpoints.savePage = () => Promise.reject(new Error('disk full'))
  }
  if (opts.savePage === 'throws-text') {
    f.ctx.checkpoints.savePage = () => Promise.reject('disk full')
  }
  const sleeps: number[] = []
  const batch = await collectListingDetail(
    source(opts.over),
    { maxDetails: opts.maxDetails ?? 5, minGapMs: 3000 },
    {
      sleep:
        opts.sleep ??
        (async (ms) => {
          sleeps.push(ms)
        }),
      random: () => 0.5,
    },
    cfg,
    f.ctx,
  )
  return { batch, f, sleeps, asked }
}

const urls = (f: { sent: { url: string }[] }) => f.sent.map((r) => r.url)
const identityKeyOf = (id: string) => siteIdentityKey({ type: 'DICE_HTML', namespace: 'dice' }, id)
/** A page whose JSON-LD posting is another job's: a posting exists, it is not the listed one. */
const foreign = { bodyText: page('zz') }

describe('collectListingDetail', () => {
  it('reads robots, every listing, then the unseen details round-robin across the listings', async () => {
    const { batch, f, sleeps } = await run([
      robots(),
      list('a,b'),
      list('b,c'),
      { bodyText: page('a', { datePosted: '2026-11-20T08:00:00Z' }) },
      { bodyText: page('c') },
      { bodyText: page('b') },
    ])
    expect(urls(f)).toEqual([ROBOTS, LIST_A, LIST_B, urlOf('a'), urlOf('c'), urlOf('b')])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['a', 'c', 'b'])
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 3,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    // No gap before robots; 3000 ms floor, jittered by +25% (random 0.5 of a 50% spread) before every other request.
    expect(sleeps).toEqual([3750, 3750, 3750, 3750, 3750])
    expect(batch.requests.map((r) => [r.page, r.url, r.status])).toEqual([
      [1, ROBOTS, 200],
      [2, LIST_A, 200],
      [3, LIST_B, 200],
      [4, urlOf('a'), 200],
      [5, urlOf('c'), 200],
      [6, urlOf('b'), 200],
    ])
    expect(batch.checkpoint?.position).toEqual({ kind: 'RESTART', page: 6 })
    expect(batch.checkpoint?.adapterVersion).toBe('synthetic-1')
    expect(f.sent[1]?.maxBytes).toBe(1000)
    expect(f.sent[3]?.maxBytes).toBe(2000)
    expect(f.sent[0]?.headers).toEqual({ accept: 'text/plain' })
    expect(f.sent[0]?.maxBytes).toBe(500 * 1024)
    expect(f.sent[1]?.headers).toEqual({ accept: 'text/html' })
    // CR-M-1: no request of the run follows a redirect; robots is checked on the URL asked for.
    expect(f.sent.map((r) => r.followRedirects)).toEqual(Array(6).fill(false))
  })

  it('asks the store about every listed id once and skips the held ones', async () => {
    const { f, asked } = await run([robots(), list('a,b'), list('c'), { bodyText: page('b') }], {
      held: new Set([identityKeyOf('a'), identityKeyOf('c')]),
    })
    // Round-robin: a (list A), c (list B), b (list A).
    expect(asked).toEqual([['a', 'c', 'b'].map((id) => identityKeyOf(id))])
    expect(urls(f).slice(3)).toEqual([urlOf('b')])
  })

  it('fetches at most maxDetails details', async () => {
    const { f, batch } = await run([robots(), list('a,b,c'), list(''), { bodyText: page('a') }], {
      maxDetails: 1,
    })
    expect(urls(f).slice(3)).toEqual([urlOf('a')])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('honours a robots Crawl-delay larger than the floor', async () => {
    const { sleeps } = await run(
      [robots('User-agent: *\nCrawl-delay: 10\n'), list(''), list('')],
      {},
    )
    expect(sleeps).toEqual([12500, 12500])
  })

  it('fails closed when robots cannot be read: nothing else is fetched', async () => {
    const { batch, f } = await run([{ status: 500 }])
    expect(urls(f)).toEqual([ROBOTS])
    expect(batch.outcome).toBe('FAILED')
  })

  it('a 404 robots allows everything', async () => {
    const { batch, f } = await run([{ status: 404 }, list(''), list('')])
    expect(urls(f)).toEqual([ROBOTS, LIST_A, LIST_B])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('a 404 robots with an HTML error page still allows everything: only a 200 is judged', async () => {
    const notFound = { status: 404, bodyText: '<html>Not found</html>' }
    const { batch, f } = await run([notFound, list(''), list('')])
    expect(urls(f)).toEqual([ROBOTS, LIST_A, LIST_B])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('stops on a URL robots refuses, without fetching it', async () => {
    const { batch, f } = await run([robots('User-agent: *\nDisallow: /list\n')])
    expect(urls(f)).toEqual([ROBOTS])
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)).toMatchObject({ page: 2, url: LIST_A, status: null })
    expect(batch.requests.at(-1)?.error?.code).toBe('ACCESS_POLICY')
    expect(batch.requests.at(-1)?.error?.message).toMatch(/^robots: /)
  })

  it('a refused detail stops the run but keeps what was recorded', async () => {
    const { batch, f } = await run([
      robots('User-agent: *\nDisallow: /job/b\n'),
      list('a,b,c'),
      list(''),
      { bodyText: page('a') },
    ])
    expect(urls(f).slice(3)).toEqual([urlOf('a')])
    expect(batch.observations).toHaveLength(1)
    expect(batch.requests.at(-1)?.error?.code).toBe('ACCESS_POLICY')
    expect(batch.outcome).not.toBe('SUCCEEDED')
  })

  it('robots groups are matched by our own product token', () => {
    expect(ROBOTS_PRODUCT_TOKEN).toBe('CheekyCheeseIT-CRM')
    expect(DEFAULT_USER_AGENT.startsWith(`${ROBOTS_PRODUCT_TOKEN}/`)).toBe(true)
  })

  it('a 403 on a listing ends the run (no retry, no evasion)', async () => {
    const { batch, f } = await run([robots(), { status: 403 }])
    expect(urls(f)).toEqual([ROBOTS, LIST_A])
    expect(batch.outcome).toBe('FAILED')
  })

  it('fails on listing drift before any detail request', async () => {
    const { batch, f } = await run([robots(), { bodyText: '<html>challenge</html>' }])
    expect(urls(f)).toHaveLength(2)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)).toMatchObject({ page: 2, url: LIST_A, status: 200 })
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: 'listing: not a list',
    })
  })

  it('fails without any detail request when the held postings cannot be read', async () => {
    const { batch, f } = await run([robots(), list('a'), list('')], { held: 'throws' })
    expect(urls(f)).toHaveLength(3)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PERSISTENCE')
    expect(batch.requests.at(-1)?.error?.message).toContain('connection reset')
  })

  it('counts a 404 detail as an answer and goes on', async () => {
    const { batch } = await run([
      robots(),
      list('a,b'),
      list(''),
      { status: 404 },
      { bodyText: page('b') },
    ])
    expect(batch.counts).toEqual({
      raw: 1,
      normalized: 1,
      invalid: 0,
      quarantined: 0,
      discarded: 0,
    })
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('a page without the posting is invalid with a sample; two of them are not drift', async () => {
    const { batch } = await run([robots(), list('a,b'), list(''), foreign, foreign])
    expect(batch.counts.invalid).toBe(2)
    expect(batch.invalidSamples[0]?.reason).toBe('json-ld: none')
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('three unusable pages, most of those read, is drift', async () => {
    const { batch } = await run([
      robots(),
      list('a,b,c,d'),
      list(''),
      foreign,
      foreign,
      foreign,
      { bodyText: page('d') },
    ])
    // The good page is still recorded, so the failed run is PARTIAL.
    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.observations).toHaveLength(1)
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: '3 of 4 job pages had no matching JSON-LD JobPosting',
    })
  })

  it('three unusable pages with as many good ones is not drift', async () => {
    const good = (id: string) => ({ bodyText: page(id) })
    const { batch } = await run(
      [
        robots(),
        list('a,b,c,d,e,f'),
        list(''),
        foreign,
        foreign,
        foreign,
        good('d'),
        good('e'),
        good('f'),
      ],
      { maxDetails: 6 },
    )
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('quarantines a posting the observation builder refuses', async () => {
    const { batch } = await run([
      robots(),
      list('a'),
      list(''),
      { bodyText: page('a', { title: '' }) },
    ])
    expect(batch.counts.quarantined).toBe(1)
    expect(batch.invalidSamples[0]?.reason).toBe('MISSING_TITLE')
  })

  it('stops on a page that cannot be persisted', async () => {
    const { batch, f } = await run(
      [robots(), list('a,b'), list(''), { bodyText: page('a') }, { bodyText: page('b') }],
      { savePage: 'throws' },
    )
    expect(urls(f)).toHaveLength(4)
    expect(batch.counts.discarded).toBe(1)
    expect(batch.requests.at(-1)?.error).toEqual({ code: 'PERSISTENCE', message: 'disk full' })
    expect(batch.outcome).toBe('FAILED')
  })

  it('a cancelled gap ends the run before the request', async () => {
    const { batch, f } = await run([robots()], {
      sleep: () => Promise.reject(new Error('aborted')),
    })
    expect(urls(f)).toEqual([ROBOTS])
    expect(batch.requests.at(-1)?.error?.code).toBe('CANCELLED')
    expect(batch.outcome).toBe('CANCELLED')
  })

  it('reports its scope: the namespace and config version, no query, no window', async () => {
    const { batch } = await run([robots(), list(''), list('')])
    expect(batch.scope).toEqual({ namespace: 'dice', query: null, configVersion: 1, window: null })
  })

  it('names the cancellation in the request report', async () => {
    const { batch } = await run([robots()], { sleep: () => Promise.reject(new Error('aborted')) })
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'CANCELLED',
      message: 'the run was cancelled before this request',
    })
  })

  it('a 404 listing is a failure, not an empty page', async () => {
    const { batch, f } = await run([robots(), { status: 404 }, list('')])
    expect(urls(f)).toEqual([ROBOTS, LIST_A])
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('UPSTREAM')
  })

  it('keeps the first listing entry of an id seen twice', async () => {
    const twice = (path: string) => ({
      ok: true as const,
      items: [{ id: 'x', url: `${HOST}/job/${path}` }],
    })
    const { f } = await run([robots(), list(''), { bodyText: 'B' }, { bodyText: page('x1') }], {
      over: { parseListing: (body) => (body === 'ids:' ? twice('x1') : twice('x2')) },
    })
    expect(urls(f).slice(3)).toEqual([`${HOST}/job/x1`])
  })

  it('stops at maxDetails without asking for a request past the bound', async () => {
    const { batch, sleeps } = await run(
      [robots(), list('a,b,c'), list(''), { bodyText: page('a') }],
      { maxDetails: 1 },
    )
    expect(batch.requests).toHaveLength(4)
    expect(batch.requests.every((r) => r.error === null)).toBe(true)
    expect(sleeps).toHaveLength(3)
  })

  it('asks for every detail page as html', async () => {
    const { f } = await run([robots(), list('a'), list(''), { bodyText: page('a') }])
    expect(f.sent[3]?.headers).toEqual({ accept: 'text/html' })
  })

  it('an invalid sample carries the page url', async () => {
    const { batch } = await run([robots(), list('a'), list(''), { bodyText: '<html></html>' }])
    expect(JSON.stringify(batch.invalidSamples[0])).toContain(urlOf('a'))
  })

  it('a quarantine sample carries the page url', async () => {
    const { batch } = await run([
      robots(),
      list('a'),
      list(''),
      { bodyText: page('a', { title: '' }) },
    ])
    expect(JSON.stringify(batch.invalidSamples[0])).toContain(urlOf('a'))
  })

  it('judges posting dates against the run clock, not the wall clock', async () => {
    const { batch } = await run(
      [
        robots(),
        list('a'),
        list(''),
        { bodyText: page('a', { datePosted: '2020-06-01T00:00:00Z' }) },
      ],
      { now: new Date('2020-01-01T00:00:00Z') },
    )
    expect(JSON.stringify(batch.observations[0])).toContain('FUTURE')
  })

  it('persists each observation with its checkpoint', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [robots(), list('a'), list(''), { bodyText: page('a') }],
    })
    const pages: { observations: unknown[]; checkpoint: unknown }[] = []
    f.ctx.checkpoints.savePage = async (p) => {
      pages.push(p)
    }
    const batch = await collectListingDetail(
      source(),
      { maxDetails: 5, minGapMs: 0 },
      { sleep: async () => {}, random: () => 0 },
      cfg,
      f.ctx,
    )
    expect(pages).toEqual([{ observations: batch.observations, checkpoint: batch.checkpoint }])
    expect(pages[0]?.observations).toHaveLength(1)
  })

  it('a run that already failed is not re-labelled drift', async () => {
    const { batch } = await run([
      robots('User-agent: *\nDisallow: /job/d\n'),
      list('a,b,c,d'),
      list(''),
      foreign,
      foreign,
      foreign,
    ])
    expect(batch.counts.invalid).toBe(3)
    expect(batch.requests.at(-1)?.error?.code).toBe('ACCESS_POLICY')
  })

  it('names a held-postings failure that is not an Error', async () => {
    const { batch } = await run([robots(), list('a'), list('')], { held: 'throws-text' })
    expect(batch.requests.at(-1)?.error?.message).toBe(
      'the held postings could not be read: the store failed',
    )
  })

  it('names a persistence failure that is not an Error', async () => {
    const { batch } = await run([robots(), list('a'), list(''), { bodyText: page('a') }], {
      savePage: 'throws-text',
    })
    expect(batch.requests.at(-1)?.error?.message).toBe('the page could not be persisted')
  })

  it('a detail 3xx is an answer like a 404: reported, nothing recorded, its target never asked for', async () => {
    const { batch, f } = await run([
      robots('User-agent: *\nDisallow: /secret\n'),
      list('a,b'),
      list(''),
      { status: 301, headers: { location: `${HOST}/secret/a` } },
      { bodyText: page('b') },
    ])
    expect(urls(f)).toEqual([ROBOTS, LIST_A, LIST_B, urlOf('a'), urlOf('b')])
    expect(urls(f).some((u) => u.includes('/secret'))).toBe(false)
    expect(batch.requests[3]).toMatchObject({ url: urlOf('a'), status: 301, error: null })
    expect(batch.counts).toMatchObject({ raw: 1, normalized: 1, invalid: 0 })
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it.each([300, 302, 307, 308])('a detail %i is skipped too', async (status) => {
    const { batch } = await run([robots(), list('a'), list(''), { status }])
    expect(batch.counts.raw).toBe(0)
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('a detail 400 is no redirect: the run stops there as UPSTREAM', async () => {
    const { batch } = await run([robots(), list('a,b'), list(''), { status: 400 }])
    expect(batch.counts.raw).toBe(0)
    expect(batch.requests.at(-1)).toMatchObject({ url: urlOf('a'), status: 400 })
    expect(batch.requests.at(-1)?.error?.code).toBe('UPSTREAM')
  })

  it.each([300, 301])('a listing %i fails closed as drift, before any detail', async (status) => {
    const { batch, f } = await run([robots(), { status }])
    expect(urls(f)).toEqual([ROBOTS, LIST_A])
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)).toMatchObject({ url: LIST_A, status })
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: `listing: redirected (HTTP ${status})`,
    })
  })

  it('a robots 3xx is unreadable: nothing else is fetched', async () => {
    const { batch, f } = await run([{ status: 301 }])
    expect(urls(f)).toEqual([ROBOTS])
    expect(batch.outcome).toBe('FAILED')
  })

  it.each([
    ['an HTML body', { bodyText: '  <!DOCTYPE html><html>challenge</html>' }],
    ['an html body in capitals', { bodyText: '<HTML>' }],
    ['a text/html type', { bodyText: 'User-agent: *\n', headers: { 'content-type': 'text/html' } }],
    ['a JSON body', { bodyText: '{"error":"forbidden","code":403}' }],
    ['a plain-text sentence', { bodyText: 'Access denied. Your request was blocked.\n' }],
  ])('a 200 robots with %s is unreadable: the run stops', async (_label, response) => {
    const { batch, f } = await run([response, list(''), list('')])
    expect(urls(f)).toEqual([ROBOTS])
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests).toHaveLength(1)
    expect(batch.requests[0]).toMatchObject({ url: ROBOTS, status: 200 })
    expect(batch.requests[0]?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: 'robots: the body is not a robots.txt file',
    })
  })

  it('a text/plain robots with a charset is read', async () => {
    const response = {
      bodyText: 'User-agent: *\nDisallow:\n',
      headers: { 'content-type': 'Text/Plain; charset=utf-8' },
    }
    const { batch } = await run([response, list(''), list('')])
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('judges a robots body by its type only when there is one', () => {
    expect(isNotRobotsFile('User-agent: *', undefined)).toBe(false)
    expect(isNotRobotsFile('User-agent: *', 'text/plain')).toBe(false)
    expect(isNotRobotsFile('User-agent: *', ' text/plain')).toBe(false)
    expect(isNotRobotsFile('User-agent: *', 'text/plainx')).toBe(true)
    expect(isNotRobotsFile('User-agent: *', 'application/text/plain')).toBe(true)
    expect(isNotRobotsFile('\n\t <html>', undefined)).toBe(true)
    expect(isNotRobotsFile('', undefined)).toBe(false)
    expect(isNotRobotsFile(' \n\t\n', undefined)).toBe(false)
    // FL2-L-1: production passes no headers, so a body without one robots directive is not robots.
    expect(isNotRobotsFile('{"blocked":true}', undefined)).toBe(true)
    expect(isNotRobotsFile('Access denied.', undefined)).toBe(true)
    expect(isNotRobotsFile('# only a comment\n\n', undefined)).toBe(true)
    expect(isNotRobotsFile('# rules\n\nUSER-AGENT: *\n', undefined)).toBe(false)
    expect(isNotRobotsFile('\t disallow : /x', undefined)).toBe(false)
    expect(isNotRobotsFile('x\nAllow: /', undefined)).toBe(false)
    expect(isNotRobotsFile('Sitemap: https://x.example/s.xml', undefined)).toBe(false)
    expect(isNotRobotsFile('crawl-delay: 5', undefined)).toBe(false)
    expect(isNotRobotsFile('disallowed: /x', undefined)).toBe(true)
    expect(isNotRobotsFile('a user-agent: *', undefined)).toBe(true)
  })

  it('two detail pages in a row with no JSON-LD posting, then a bad tiebreaker, end the run as drift', async () => {
    const challenge = { bodyText: '<html>Just a moment...</html>' }
    const { batch, f } = await run([
      robots(),
      list('a,b,c,d,e'),
      list(''),
      { bodyText: page('a') },
      challenge,
      challenge,
      challenge,
    ])
    expect(MAX_PAGES_WITHOUT_POSTING).toBe(2)
    // The tiebreaker is the far end of what is still unread: e, before d.
    expect(urls(f).slice(3)).toEqual([urlOf('a'), urlOf('b'), urlOf('c'), urlOf('e')])
    expect(batch.observations).toHaveLength(1)
    expect(batch.counts).toMatchObject({ raw: 4, normalized: 1, invalid: 3 })
    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.requests.at(-1)).toMatchObject({ url: urlOf('e'), status: 200 })
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: '3 job pages in a row had no JSON-LD JobPosting at all',
    })
    // One report per fetch (BP2-L-1) and one invalid sample per bad page (BP2-L-2).
    expect(batch.requests).toHaveLength(f.sent.length)
    expect(batch.invalidSamples.map((s) => s.reason)).toEqual([
      'json-ld: none',
      'json-ld: none',
      'json-ld: none',
    ])
    expect(JSON.stringify(batch.invalidSamples.at(-1))).toContain(urlOf('e'))
  })

  it('stops at the streak when nothing is left unread to break the tie', async () => {
    const challenge = { bodyText: '<html></html>' }
    const { batch, f } = await run([robots(), list('a,b'), list(''), challenge, challenge])
    expect(urls(f).slice(3)).toEqual([urlOf('a'), urlOf('b')])
    expect(batch.requests).toHaveLength(f.sent.length)
    expect(batch.requests.at(-1)).toMatchObject({ url: urlOf('b'), status: 200 })
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: '2 job pages in a row had no JSON-LD JobPosting at all',
    })
    expect(batch.invalidSamples).toHaveLength(2)
    expect(batch.counts).toMatchObject({ raw: 2, invalid: 2 })
  })

  it('two bad head pages cannot starve the run: a good tiebreaker resets and the rest is read', async () => {
    const challenge = { bodyText: '<html></html>' }
    // maxDetails 5: head a,b,c,d, turning slot f (of e,f at turn 0.5).
    const { batch, f } = await run([
      robots(),
      list('a,b,c,d,e,f'),
      list(''),
      challenge,
      challenge,
      { bodyText: page('f') },
      { bodyText: page('c') },
      { bodyText: page('d') },
    ])
    expect(urls(f).slice(3)).toEqual(['a', 'b', 'f', 'c', 'd'].map(urlOf))
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['f', 'c', 'd'])
    expect(batch.counts).toMatchObject({ raw: 5, normalized: 3, invalid: 2 })
    expect(batch.requests.every((r) => r.error === null)).toBe(true)
  })

  it('a second streak after a good tiebreaker takes a new tiebreaker', async () => {
    const challenge = { bodyText: '<html></html>' }
    const { batch, f } = await run(
      [
        robots(),
        list('a,b,c,d,e,f'),
        list(''),
        challenge,
        challenge,
        { bodyText: page('f') },
        challenge,
        challenge,
        { bodyText: page('e') },
      ],
      { maxDetails: 6 },
    )
    // maxDetails 6: head a..e, turning f. a,b bad -> f; c,d bad -> e (the far end again).
    expect(urls(f).slice(3)).toEqual(['a', 'b', 'f', 'c', 'd', 'e'].map(urlOf))
    expect(batch.counts).toMatchObject({ raw: 6, normalized: 2, invalid: 4 })
  })

  it('a challenge on every page stops early at production bounds', async () => {
    const challenge = { bodyText: '<html></html>' }
    const ids = Array.from({ length: 30 }, (_, i) => `j${i}`)
    const { batch, f } = await run(
      [robots(), list(ids.join(',')), list(''), challenge, challenge, challenge],
      { maxDetails: 25 },
    )
    expect(urls(f)).toHaveLength(6)
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
    expect(batch.requests).toHaveLength(f.sent.length)
  })

  it('two detail redirects in a row end the run as an access block, with one report each', async () => {
    const { batch, f } = await run([
      robots(),
      list('a,b,c,d'),
      list(''),
      { bodyText: page('a') },
      { status: 301 },
      { status: 302 },
    ])
    expect(urls(f).slice(3)).toEqual([urlOf('a'), urlOf('b'), urlOf('c')])
    expect(batch.requests).toHaveLength(f.sent.length)
    expect(batch.requests[4]).toMatchObject({ url: urlOf('b'), status: 301, error: null })
    expect(batch.requests.at(-1)).toMatchObject({ url: urlOf('c'), status: 302 })
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'ACCESS_POLICY',
      message: '2 job pages in a row answered with a redirect (HTTP 302)',
    })
    expect(batch.observations).toHaveLength(1)
    expect(batch.counts).toMatchObject({ raw: 1, normalized: 1 })
    expect(batch.outcome).toBe('PARTIAL')
  })

  it('a 404 or a page between two redirects resets the redirect streak', async () => {
    const viaNotFound = await run(
      [
        robots(),
        list('a,b,c,d'),
        list(''),
        { status: 301 },
        { status: 404 },
        { status: 301 },
        { bodyText: page('d') },
      ],
      { maxDetails: 4 },
    )
    expect(urls(viaNotFound.f)).toHaveLength(7)
    expect(viaNotFound.batch.outcome).toBe('SUCCEEDED')
    const viaPage = await run(
      [
        robots(),
        list('a,b,c'),
        list(''),
        { status: 307 },
        { bodyText: page('b') },
        { status: 308 },
      ],
      { maxDetails: 4 },
    )
    expect(urls(viaPage.f)).toHaveLength(6)
    expect(viaPage.batch.outcome).toBe('SUCCEEDED')
  })

  it('a page with a posting resets the streak; a 404 or 3xx between leaves it', async () => {
    const challenge = { bodyText: '<html></html>' }
    const reset = await run(
      [robots(), list('a,b,c,d'), list(''), challenge, foreign, challenge, { bodyText: page('d') }],
      { maxDetails: 4 },
    )
    // All four were read: the streak never reached two. The end-of-run drift rule still applies.
    expect(urls(reset.f)).toHaveLength(7)
    expect(reset.batch.requests.at(-1)?.error?.message).toBe(
      '3 of 4 job pages had no matching JSON-LD JobPosting',
    )
    const kept = await run(
      [robots(), list('a,b,c,d'), list(''), challenge, { status: 404 }, challenge, challenge],
      {
        maxDetails: 4,
      },
    )
    // a and c make the streak (the 404 leaves it); d breaks the tie and is bad too.
    expect(urls(kept.f).slice(3)).toEqual([urlOf('a'), urlOf('b'), urlOf('c'), urlOf('d')])
    expect(kept.batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })

  it('a bad page of a posting older than the drift window does not count toward drift', async () => {
    const day = 24 * 3_600_000
    const ages: Record<string, number> = { a: 2 * day, b: 2 * day, c: 2 * day, d: 0 }
    const over = { createdAtMs: (item: ListingItem) => NOW.getTime() - ages[item.id]! }
    const stale = await run(
      [robots(), list('a,b,c,d'), list(''), foreign, foreign, foreign, { bodyText: page('d') }],
      { over },
    )
    expect(stale.batch.counts.invalid).toBe(3)
    expect(stale.batch.outcome).toBe('SUCCEEDED')
    expect(stale.batch.invalidSamples).toHaveLength(3)
  })

  it('skips a malformed listing item with an invalid sample and reads the rest', async () => {
    const { batch, f } = await run([robots(), list('a'), list(''), { bodyText: page('a') }], {
      over: {
        parseListing: (body) =>
          body === 'ids:a'
            ? { ok: true, items: [{ id: 'a', url: urlOf('a') }], skipped: ['job 1 is malformed'] }
            : { ok: true, items: [] },
      },
    })
    expect(urls(f).slice(3)).toEqual([urlOf('a')])
    expect(batch.invalidSamples).toHaveLength(1)
    expect(batch.invalidSamples[0]?.reason).toBe('listing: job 1 is malformed')
    expect(JSON.stringify(batch.invalidSamples[0])).toContain(LIST_A)
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('a listing fails only with no valid item or most items malformed', () => {
    const one = [{ id: 'a', url: urlOf('a') }]
    expect(listingOf(one, [])).toEqual({ ok: true, items: one, skipped: [] })
    expect(listingOf(one, ['x'])).toEqual({ ok: true, items: one, skipped: ['x'] })
    expect(listingOf(one, ['x', 'y'])).toEqual({ ok: false, message: '2 of 3 jobs malformed' })
    expect(listingOf([], [])).toEqual({ ok: false, message: 'no valid job of 0' })
    expect(listingOf([], ['x'])).toEqual({ ok: false, message: 'no valid job of 1' })
  })

  it('takes the listings round-robin, then the turning share below the newest', async () => {
    expect(roundRobin([['a1', 'a2', 'a3'], [], ['b1']])).toEqual(['a1', 'b1', 'a2', 'a3'])
    expect(roundRobin([])).toEqual([])
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6']
    const { f } = await run(
      [robots(), list(ids.join(',')), list('b1'), ...Array(5).fill(foreign)],
      { maxDetails: 5 },
    )
    // Interleaved a1,b1,a2,a3,a4,a5,a6: 4 newest, then one of [a4,a5,a6] at turn 0.5 -> a5.
    expect(urls(f).slice(3)).toEqual(['a1', 'b1', 'a2', 'a3', 'a5'].map(urlOf))
  })

  it('draws its turn once per run, before any request', async () => {
    const draws: string[] = []
    const f = fakeCollectionContext({ now: NOW, responses: [robots(), list(''), list('')] })
    f.ctx.fetchText = ((orig) => async (r) => {
      draws.push('fetch')
      return orig(r)
    })(f.ctx.fetchText.bind(f.ctx))
    await collectListingDetail(
      source(),
      { maxDetails: 5, minGapMs: 0 },
      {
        sleep: async () => {},
        random: () => {
          draws.push('random')
          return 0
        },
      },
      cfg,
      f.ctx,
    )
    expect(draws[0]).toBe('random')
  })

  it('states its request budget', () => {
    expect(requestsOf(3, { maxDetails: 25, minGapMs: 0 })).toBe(29)
  })

  it('maps JSON-LD dates as zoned ISO, published then expiry', () => {
    const posting = { datePosted: { raw: 'P' }, validThrough: { raw: 'V' } }
    expect(jsonLdDates(posting as never)).toEqual([
      { raw: 'P', contract: 'ISO_ZONED', semantics: 'PUBLISHED' },
      { raw: 'V', contract: 'ISO_ZONED', semantics: 'EXPIRY' },
    ])
    expect(jsonLdDates({ datePosted: null, validThrough: null } as never)).toEqual([])
  })
})
