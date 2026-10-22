import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fakeCollectionContext } from '../../test/fake-collection-context'
import { fixtureText } from '../../test/xml-corpus'
import { DEFAULT_USER_AGENT } from '../http/bounded-fetch'
import { baseSourceConfigSchema } from './api-json.provider'
import { isBuiltBatch, UnvalidatedConfigError } from './reporting-provider'
import { collectFeedPages, defineRssProvider, type RssSourceSpec } from './rss.provider'

/**
 * The RSS/Atom base, through the interface phase 3's feed adapters use. Each describe block is one
 * acceptance criterion of r5 Task 2.4, acceptance side first and then the refusal side.
 *
 * The feeds are the synthetic corpus from Task 2.4a plus inline documents. Authentic Djinni / WWR /
 * EU Remote Jobs captures are PENDING OWNER AUTHORISATION (an outbound GET to a job board is an A3
 * external send), so nothing here claims to prove what those boards emit.
 */

const configSchema = baseSourceConfigSchema.extend({})
type Config = z.infer<typeof configSchema>
const config = (overrides: Record<string, unknown> = {}): Config =>
  configSchema.parse({ namespace: 'board', configVersion: 3, ...overrides })

const NOW = new Date('2026-10-20T10:00:00Z')
const DAY = 24 * 60 * 60 * 1000

function spec(overrides: Partial<RssSourceSpec<Config>> = {}): RssSourceSpec<Config> {
  return {
    type: 'WWR_RSS',
    adapterVersion: 'wwr-test-1',
    configSchema,
    inventory: { kind: 'COMPLETE' },
    feedRequest: () => ({ url: 'https://weworkremotely.example/remote-jobs.rss' }),
    mapEntry: (entry, cfg) => ({
      namespace: cfg.namespace,
      url: entry.link,
      title: entry.title,
      companyName: entry.authors[0] ?? 'Unknown employer',
      description: entry.content ?? entry.summary,
      descriptionKind: 'html',
      dates: [...entry.dates],
    }),
    ...overrides,
  }
}

const rss = (items: string) =>
  `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Jobs</title>${items}</channel></rss>`
const item = (guid: string, link: string, extra = '') =>
  `<item><title>Engineer ${guid}</title><link>${link}</link><guid isPermaLink="false">${guid}</guid><author>Acme</author>${extra}</item>`

const collect = async (bodyText: string, s = spec(), cfg = config()) => {
  const f = fakeCollectionContext({ responses: [{ bodyText }], now: NOW })
  return { batch: await collectFeedPages(s, cfg, f.ctx), f }
}

describe('AC1 — the same CollectionBatch as the API providers', () => {
  it('returns a batch built by buildCollectionBatch, never a hand-made literal', async () => {
    const { batch } = await collect(fixtureText('rss-cdata-entities.xml'))
    expect(isBuiltBatch(batch)).toBe(true)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations).toHaveLength(2)
    expect(batch.scope).toEqual({ namespace: 'board', query: null, configVersion: 3, window: null })
    expect(batch.checkpoint?.position).toEqual({ kind: 'RESTART', page: 1 })
  })

  it('stamps the spec`s own type and adapter version on every observation', async () => {
    const { batch } = await collect(fixtureText('rss-cdata-entities.xml'))
    expect(batch.observations.map((o) => [o.identity.provider, o.adapterVersion])).toEqual([
      ['WWR_RSS', 'wwr-test-1'],
      ['WWR_RSS', 'wwr-test-1'],
    ])
  })
})

describe('AC2 — malformed feed is drift; a valid empty feed is success', () => {
  it('a valid feed with no items succeeds with the full inventory: nothing, honestly', async () => {
    const { batch } = await collect(fixtureText('rss-empty.xml'))
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('FULL_INVENTORY')
    expect(batch.observations).toEqual([])
    expect(batch.requests.map((r) => r.error)).toEqual([null])
  })

  it('a truncated feed is drift, not an empty feed', async () => {
    const { batch } = await collect(fixtureText('rss-broken-envelope.xml'))
    expect(batch.outcome).toBe('FAILED')
    expect(batch.coverage).toBe('PARTIAL')
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
    expect(batch.requests.at(-1)?.error?.message).toMatch(/^MALFORMED: /)
  })

  it('well-formed XML that is not a feed is drift, and says what it found', async () => {
    const { batch } = await collect('<html><body>Please enable JavaScript</body></html>')
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PARSE_DRIFT',
      message: 'feed: the document root {}html is not RSS 2.0, RSS 1.0 or Atom',
    })
  })

  it('a hostile document is refused before parsing, as drift', async () => {
    const { batch } = await collect(fixtureText('attack-billion-laughs.xml'))
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
    expect(batch.requests.at(-1)?.error?.message).toMatch(/^DOCTYPE_FORBIDDEN: /)
  })

  it('one item without a link is quarantined; the rest of the feed stands', async () => {
    const { batch } = await collect(
      fixtureText('boards-synthetic.xml'),
      spec({
        mapEntry: (entry, cfg) => ({
          namespace: cfg.namespace,
          url: entry.link,
          title: entry.title,
          companyName: 'Acme',
        }),
      }),
    )
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.counts).toEqual({
      raw: 3,
      normalized: 2,
      invalid: 0,
      quarantined: 1,
      discarded: 0,
    })
    // A quarantined item means the inventory we report is demonstrably incomplete.
    expect(batch.coverage).toBe('PARTIAL')
  })
})

describe('AC3 — validators are saved, and a 304 reuses the cached inventory', () => {
  const FEED = rss(item('g-1', 'https://example.com/j/1') + item('g-2', 'https://example.com/j/2'))

  it('a 200 stores its body with both validators, under a key per source, version and page', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        {
          bodyText: FEED,
          etag: '"abc"',
          headers: { 'last-modified': 'Tue, 20 Oct 2026 09:00:00 GMT' },
        },
      ],
    })
    await collectFeedPages(spec(), config(), f.ctx)

    expect([...f.cache.entries()]).toEqual([
      [
        '["WWR_RSS","board",3,1,null]',
        { etag: '"abc"', lastModified: 'Tue, 20 Oct 2026 09:00:00 GMT', bodyText: FEED },
      ],
    ])
  })

  it('a 304 replays the cached feed: the same observations, not an empty feed', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ status: 304 }],
      cacheSeed: {
        '["WWR_RSS","board",3,1,null]': {
          etag: '"abc"',
          lastModified: 'Tue, 20 Oct 2026 09:00:00 GMT',
          bodyText: FEED,
        },
      },
    })
    const batch = await collectFeedPages(spec(), config(), f.ctx)

    expect(f.sent[0]?.headers).toEqual({
      'user-agent': DEFAULT_USER_AGENT,
      'if-none-match': '"abc"',
      'if-modified-since': 'Tue, 20 Oct 2026 09:00:00 GMT',
    })
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['g-1', 'g-2'])
    expect(batch.requests.map((r) => [r.status, r.error])).toEqual([[304, null]])
  })

  it('a 304 with nothing cached is drift, never an empty feed', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ status: 304 }] })
    const batch = await collectFeedPages(spec(), config(), f.ctx)
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })

  it('a config change keys a different cache entry, so it cannot revalidate the old feed', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: FEED, etag: '"v"' }],
      cacheSeed: { '["WWR_RSS","board",3,1,null]': { etag: '"old"', bodyText: FEED } },
    })
    await collectFeedPages(spec(), config({ configVersion: 4 }), f.ctx)
    expect(f.sent[0]?.headers?.['if-none-match']).toBeUndefined()
    expect(f.cache.has('["WWR_RSS","board",4,1,null]')).toBe(true)
  })
})

describe('AC4 — a time-limited feed never claims FULL_INVENTORY', () => {
  it('a feed that shows only the last N days covers exactly [now - N days, now], as a WINDOW', async () => {
    const s = spec({ inventory: { kind: 'RECENT', windowMs: 30 * DAY } })
    const { batch } = await collect(rss(item('g-1', 'https://example.com/j/1')), s)

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.coverage).toBe('WINDOW')
    expect(batch.scope.window).toEqual({ from: new Date('2026-09-20T10:00:00Z'), to: NOW })
  })

  it('an EMPTY time-limited feed is still a WINDOW, not a full inventory of nothing', async () => {
    const s = spec({ inventory: { kind: 'RECENT', windowMs: 7 * DAY } })
    const { batch } = await collect(fixtureText('rss-empty.xml'), s)
    expect(batch.coverage).toBe('WINDOW')
  })

  it('a complete feed keeps a window its config asked for', async () => {
    const window = { from: '2026-10-01T00:00:00Z', to: '2026-10-10T00:00:00Z' }
    const { batch } = await collect(fixtureText('rss-empty.xml'), spec(), config({ window }))
    expect(batch.coverage).toBe('WINDOW')
    expect(batch.scope.window).toEqual({ from: new Date(window.from), to: new Date(window.to) })
  })

  it('a complete feed under a query is a WINDOW too', async () => {
    const { batch } = await collect(fixtureText('rss-empty.xml'), spec(), config({ query: 'rust' }))
    expect(batch.scope.query).toBe('rust')
    expect(batch.coverage).toBe('WINDOW')
  })

  it('a one-millisecond window is a window', () => {
    expect(() =>
      defineRssProvider(spec({ inventory: { kind: 'RECENT', windowMs: 1 } })),
    ).not.toThrow()
  })

  it.each([0, -DAY, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a RECENT window of %s at definition time',
    (windowMs) => {
      expect(() => defineRssProvider(spec({ inventory: { kind: 'RECENT', windowMs } }))).toThrow(
        /windowMs must be a positive, finite number of milliseconds/,
      )
    },
  )
})

describe('AC5 — the GUID is opaque identity', () => {
  it('an isPermaLink="false" guid is the native id, verbatim', async () => {
    const { batch } = await collect(fixtureText('rss-cdata-entities.xml'))
    expect(batch.observations[0]?.identity).toMatchObject({
      identityKind: 'NATIVE_ID',
      nativeId: 'opaque-id-001',
    })
  })

  it('a permalink guid is identity as written — no query stripped, no canonicalisation', async () => {
    const guid = 'https://example.com/jobs/7?ts=1729418400'
    const { batch } = await collect(
      rss(
        `<item><title>T</title><link>https://example.com/jobs/7?utm_source=rss</link><guid>${guid}</guid><author>Acme</author></item>`,
      ),
    )
    expect(batch.observations[0]?.identity).toMatchObject({
      identityKind: 'NATIVE_ID',
      nativeId: guid,
    })
  })

  it('an Atom id is the native id', async () => {
    const { batch } = await collect(fixtureText('atom-namespaced.xml'))
    expect(batch.observations[0]?.identity.nativeId).toBe(
      'urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a',
    )
  })

  it('the base sets the native id — an adapter cannot key identity on something else', async () => {
    const s = spec({
      mapEntry: (entry, cfg) =>
        ({
          namespace: cfg.namespace,
          url: entry.link,
          title: 't',
          companyName: 'c',
          nativeId: 'chosen-by-adapter',
        }) as ReturnType<RssSourceSpec<Config>['mapEntry']>,
    })
    const { batch } = await collect(rss(item('g-1', 'https://example.com/j/1')), s)
    expect(batch.observations[0]?.identity.nativeId).toBe('g-1')
  })

  it('an item without a guid falls back to its link', async () => {
    const { batch } = await collect(
      rss('<item><title>T</title><link>https://example.com/j/9</link><author>Acme</author></item>'),
    )
    expect(batch.observations[0]?.identity).toMatchObject({
      identityKind: 'URL_FALLBACK',
      nativeId: null,
    })
  })

  it('two guids sharing one link are two postings', async () => {
    const { batch } = await collect(
      rss(item('g-1', 'https://example.com/j/1') + item('g-2', 'https://example.com/j/1')),
    )
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(new Set(batch.observations.map((o) => o.identity.identityKey)).size).toBe(2)
  })

  it('the same guid twice — an updated description — is one identity, not a collision', async () => {
    const { batch } = await collect(
      fixtureText('boards-synthetic.xml'),
      spec({
        mapEntry: (entry, cfg) => ({
          namespace: cfg.namespace,
          url: entry.link,
          title: entry.title,
          companyName: 'Acme',
          description: entry.content,
        }),
      }),
    )
    const rust = batch.observations.filter((o) => o.identity.nativeId === 'rust-1')
    expect(rust).toHaveLength(2)
    expect(rust[0]?.identity.identityKey).toBe(rust[1]?.identity.identityKey)
    expect(rust[0]?.contentHash).not.toBe(rust[1]?.contentHash)
  })
})

describe('AC6 — honest user agent, no browser impersonation', () => {
  it('sends our user agent whatever the adapter asked for, and no client hints', async () => {
    const s = spec({
      feedRequest: () => ({
        url: 'https://weworkremotely.example/remote-jobs.rss',
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0',
          'sec-ch-ua-platform': '"Windows"',
          accept: 'application/rss+xml',
        },
      }),
    })
    const { f } = await collect(fixtureText('rss-empty.xml'), s)
    expect(f.sent[0]?.headers).toEqual({
      accept: 'application/rss+xml',
      'user-agent': DEFAULT_USER_AGENT,
    })
  })
})

describe('pagination', () => {
  it('a feed paginates only when the adapter says how, and then through the shared loop', async () => {
    const s = spec({
      feedRequest: (_cfg, at) => ({ url: `https://example.com/feed?page=${at.cursor ?? '1'}` }),
      nextCursor: (feed) => (feed.title === 'Jobs' ? '2' : null),
    })
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        { bodyText: rss(item('g-1', 'https://example.com/j/1')), etag: '"p1"' },
        {
          bodyText: rss(item('g-2', 'https://example.com/j/2')).replace(
            '<title>Jobs</title>',
            '<title>Last</title>',
          ),
          etag: '"p2"',
        },
      ],
    })
    const batch = await collectFeedPages(s, config(), f.ctx)

    expect(f.sent.map((r) => r.url)).toEqual([
      'https://example.com/feed?page=1',
      'https://example.com/feed?page=2',
    ])
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['g-1', 'g-2'])
    // Each page under its own key, the cursor included, so the two never share a cached body.
    expect([...f.cache.keys()]).toEqual([
      '["WWR_RSS","board",3,1,null]',
      '["WWR_RSS","board",3,2,"2"]',
    ])
  })

  it('without nextCursor a feed is one document, and the attempt is complete', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: fixtureText('rss-empty.xml') }],
    })
    const batch = await collectFeedPages(spec(), config(), f.ctx)
    expect(f.sent).toHaveLength(1)
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.requests.map((r) => r.error)).toEqual([null])
  })
})

describe('metering', () => {
  it('a metered feed reserves before its one request', async () => {
    const reserved: Array<[string, number]> = []
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: fixtureText('rss-empty.xml') }],
    })
    const reserve = f.ctx.meter.reserve.bind(f.ctx.meter)
    f.ctx.meter.reserve = async (unit, amount) => {
      reserved.push([unit, amount])
      return reserve(unit, amount)
    }
    const batch = await collectFeedPages(
      spec({ meter: { unit: 'REQUEST', amountPerRequest: 1 } }),
      config(),
      f.ctx,
    )
    expect(reserved).toEqual([['REQUEST', 1]])
    expect(batch.requests[0]?.cost).toEqual({ unit: 'REQUEST', amount: 1 })
  })
})

describe('defineRssProvider', () => {
  it('validates its config and refuses one it never validated', async () => {
    const provider = defineRssProvider(spec())
    expect(provider.type).toBe('WWR_RSS')
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: fixtureText('rss-empty.xml') }],
    })
    await expect(
      provider.collectReport(provider.parseConfig({ namespace: 'board', configVersion: 3 }), f.ctx),
    ).resolves.toMatchObject({ outcome: 'SUCCEEDED' })
    await expect(
      provider.collectReport(config() as ReturnType<typeof provider.parseConfig>, f.ctx),
    ).rejects.toThrow(UnvalidatedConfigError)
  })
})
