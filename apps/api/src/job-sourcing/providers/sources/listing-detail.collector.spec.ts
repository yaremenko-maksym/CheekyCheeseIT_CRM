import { describe, expect, it } from 'vitest'
import { fakeCollectionContext, type FakeResponse } from '../../../test/fake-collection-context'
import { selectByIdentity } from '../../structuring/json-ld'
import { DEFAULT_USER_AGENT } from '../../http/bounded-fetch'
import {
  collectListingDetail,
  identityKeyOf,
  jsonLdDates,
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

describe('collectListingDetail', () => {
  it('reads robots, every listing, then the unseen details in listing order', async () => {
    const { batch, f, sleeps } = await run([
      robots(),
      list('a,b'),
      list('b,c'),
      { bodyText: page('a', { datePosted: '2026-11-20T08:00:00Z' }) },
      { bodyText: page('b') },
      { bodyText: page('c') },
    ])
    expect(urls(f)).toEqual([ROBOTS, LIST_A, LIST_B, urlOf('a'), urlOf('b'), urlOf('c')])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['a', 'b', 'c'])
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
      [5, urlOf('b'), 200],
      [6, urlOf('c'), 200],
    ])
    expect(batch.checkpoint?.position).toEqual({ kind: 'RESTART', page: 6 })
    expect(batch.checkpoint?.adapterVersion).toBe('synthetic-1')
    expect(f.sent[1]?.maxBytes).toBe(1000)
    expect(f.sent[3]?.maxBytes).toBe(2000)
    expect(f.sent[0]?.headers).toEqual({ accept: 'text/plain' })
    expect(f.sent[0]?.maxBytes).toBe(500 * 1024)
    expect(f.sent[1]?.headers).toEqual({ accept: 'text/html' })
  })

  it('asks the store about every listed id once and skips the held ones', async () => {
    const { f, asked } = await run([robots(), list('a,b'), list('c'), { bodyText: page('b') }], {
      held: new Set([
        identityKeyOf('DICE_HTML', 'dice', 'a'),
        identityKeyOf('DICE_HTML', 'dice', 'c'),
      ]),
    })
    expect(asked).toEqual([['a', 'b', 'c'].map((id) => identityKeyOf('DICE_HTML', 'dice', id))])
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
    const empty = { bodyText: '<html></html>' }
    const { batch } = await run([robots(), list('a,b'), list(''), empty, empty])
    expect(batch.counts.invalid).toBe(2)
    expect(batch.invalidSamples[0]?.reason).toBe('json-ld: none')
    expect(batch.outcome).toBe('SUCCEEDED')
  })

  it('three unusable pages, most of those read, is drift', async () => {
    const empty = { bodyText: '<html></html>' }
    const { batch } = await run([
      robots(),
      list('a,b,c,d'),
      list(''),
      empty,
      empty,
      empty,
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
    const empty = { bodyText: '<html></html>' }
    const good = (id: string) => ({ bodyText: page(id) })
    const { batch } = await run(
      [
        robots(),
        list('a,b,c,d,e,f'),
        list(''),
        empty,
        empty,
        empty,
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
    const empty = { bodyText: '<html></html>' }
    const { batch } = await run([
      robots('User-agent: *\nDisallow: /job/d\n'),
      list('a,b,c,d'),
      list(''),
      empty,
      empty,
      empty,
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
