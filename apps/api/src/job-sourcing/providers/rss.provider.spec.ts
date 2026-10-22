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

  /**
   * The slot the feed base names, read out of the loop's `[slot, request digest]` key (SR-H-1).
   * Asserted as the SLOT and not as the whole key: the digest is a function of the request, so
   * writing it out here would pin a hash rather than a behaviour. That two different requests
   * sharing one slot cannot share an entry is pinned in `paged-response-cache.spec.ts`.
   */
  const slots = (cache: Map<string, unknown>): unknown[] =>
    [...cache.keys()].map((key) => JSON.parse(key)[0])

  it('a 200 stores its body with both validators, under a slot per source, version and page', async () => {
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

    expect(slots(f.cache)).toEqual(['["WWR_RSS","board",3,1,null]'])
    expect([...f.cache.values()]).toEqual([
      { etag: '"abc"', lastModified: 'Tue, 20 Oct 2026 09:00:00 GMT', bodyText: FEED },
    ])
  })

  /**
   * SEEDED BY A FIRST ATTEMPT rather than by a hand-written key, which is the only way to pin the
   * two halves of this AC against each other: the entry a 200 wrote is the entry the next
   * attempt's conditional request finds. A hand-written key tests our arithmetic against itself.
   */
  const storedByA200 = async (cfg = config()) => {
    const first = fakeCollectionContext({
      now: NOW,
      responses: [
        {
          bodyText: FEED,
          etag: '"abc"',
          headers: { 'last-modified': 'Tue, 20 Oct 2026 09:00:00 GMT' },
        },
      ],
    })
    await collectFeedPages(spec(), cfg, first.ctx)
    expect(first.cache.size).toBe(1)
    return Object.fromEntries(first.cache)
  }

  it('a 304 replays the cached feed: the same observations, not an empty feed', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ status: 304 }],
      cacheSeed: await storedByA200(),
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
      cacheSeed: await storedByA200(config()),
    })
    await collectFeedPages(spec(), config({ configVersion: 4 }), f.ctx)
    expect(f.sent[0]?.headers?.['if-none-match']).toBeUndefined()
    // The old entry stands and a second one is written beside it, under the new version's slot.
    expect(slots(f.cache)).toEqual(['["WWR_RSS","board",3,1,null]', '["WWR_RSS","board",4,1,null]'])
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

  it('collecting directly — without defineRssProvider — refuses an impossible window too', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: fixtureText('rss-empty.xml') }],
    })
    expect(() =>
      collectFeedPages(spec({ inventory: { kind: 'RECENT', windowMs: 0 } }), config(), f.ctx),
    ).toThrow(/windowMs must be a positive, finite number of milliseconds, got 0/)
    expect(f.sent).toEqual([])
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

/**
 * COVERAGE HONESTY ON A RESTART, and the one configured-window decision (CR-H-1, CR-M-2).
 *
 * Acceptance first, from the specification: a RECENT feed's scope IS `[now - windowMs, now]` —
 * stated without exception, so it holds on a restart as much as on a fresh run. Then the refusal
 * from the finding: not one millisecond wider.
 */
describe('a RECENT feed reports its own window, restart or not', () => {
  /**
   * A checkpoint stored under a config version that no longer exists — `decideCheckpoint`'s
   * RESTART_WITH_OVERLAP path, which is the one that widens. A well-formed checkpoint with a stale
   * version rather than a junk object: the restart we are testing is the ordinary one an operator
   * causes by editing a source's config, and it needs no cast to express.
   */
  const withStaleCheckpoint = (f: ReturnType<typeof fakeCollectionContext>) => {
    f.ctx.checkpoints.load = async () => ({
      configVersion: 2,
      policyVersion: 1,
      adapterVersion: 'wwr-test-1',
      position: { kind: 'CURSOR' as const, page: 4, cursor: 'from-the-old-config' },
      completedAt: new Date('2026-10-19T10:00:00Z'),
    })
    return f
  }

  /**
   * BOTH ARMS IN ONE TEST, because the RECENT arm alone would be vacuous: a RECENT feed's window
   * is the same seven days whether or not a restart happened, so a test asserting only that cannot
   * tell "the overlap was suppressed" from "the stale checkpoint never reached the restart path".
   * The COMPLETE arm, through the identical harness, is the control that proves the path is live —
   * it widens — and the RECENT arm then means something.
   */
  it('covers exactly [now - windowMs, now] when a stale checkpoint restarts the attempt', async () => {
    const feed = { bodyText: fixtureText('rss-empty.xml') }
    const recent = withStaleCheckpoint(fakeCollectionContext({ now: NOW, responses: [feed] }))
    const complete = withStaleCheckpoint(fakeCollectionContext({ now: NOW, responses: [feed] }))

    const recentBatch = await collectFeedPages(
      spec({ inventory: { kind: 'RECENT', windowMs: 7 * DAY }, overlapMs: DAY }),
      config(),
      recent.ctx,
    )
    const completeBatch = await collectFeedPages(
      spec({ overlapMs: DAY }),
      config({ window: { from: '2026-10-13T10:00:00Z', to: '2026-10-20T10:00:00Z' } }),
      complete.ctx,
    )

    // The control: the restart path IS live in this harness, and it widened by the day asked for.
    expect(completeBatch.scope.window?.from).toEqual(new Date('2026-10-12T10:00:00Z'))
    // The finding: the same restart, on a feed that cannot be asked for more, claims no extra day.
    expect(recentBatch.coverage).toBe('WINDOW')
    expect(recentBatch.scope.window).toEqual({ from: new Date('2026-10-13T10:00:00Z'), to: NOW })
  })

  it('does not report a day it cannot have read, whatever overlap the adapter asks for', async () => {
    // The refusal side: an adapter setting its own overlap cannot widen a feed's claim either,
    // because a feed cannot be asked for more history than it shows.
    const s = spec({ inventory: { kind: 'RECENT', windowMs: 7 * DAY }, overlapMs: 3 * DAY })
    const f = withStaleCheckpoint(
      fakeCollectionContext({ now: NOW, responses: [{ bodyText: fixtureText('rss-empty.xml') }] }),
    )
    const batch = await collectFeedPages(s, config(), f.ctx)

    expect(batch.scope.window?.from).toEqual(new Date('2026-10-13T10:00:00Z'))
  })

  it('a COMPLETE feed, which can be asked for more history, still widens on a restart', async () => {
    // The acceptance side of the loop's overlap, kept: this is paginated history, not a window of
    // whatever the feed happens to show, so re-reading across the old boundary is real coverage.
    const window = { from: '2026-10-10T00:00:00Z', to: '2026-10-20T00:00:00Z' }
    const f = withStaleCheckpoint(
      fakeCollectionContext({ now: NOW, responses: [{ bodyText: fixtureText('rss-empty.xml') }] }),
    )
    const batch = await collectFeedPages(spec({ overlapMs: DAY }), config({ window }), f.ctx)

    expect(batch.scope.window).toEqual({
      from: new Date('2026-10-09T00:00:00Z'),
      to: new Date(window.to),
    })
  })
})

/**
 * THE CONFIGURED WINDOW ON A RECENT FEED IS REFUSED — both cases, for the reason in
 * `assertConfigWindow`: whether it overlaps the feed's window is an accident of the clock, so a
 * rule that treated the two differently would make the behaviour a function of when the run
 * happens. Overlapping and disjoint are therefore the same test twice, deliberately.
 */
describe('a RECENT feed cannot be asked for a window', () => {
  const overlapping = { from: '2026-10-15T00:00:00Z', to: '2026-10-25T00:00:00Z' }
  const disjoint = { from: '2026-08-01T00:00:00Z', to: '2026-08-10T00:00:00Z' }

  it.each([
    ['overlapping the feed`s own window', overlapping],
    ['disjoint from the feed`s own window', disjoint],
  ])('refuses a configured window %s, before any request goes out', async (_name, window) => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: fixtureText('rss-empty.xml') }],
    })
    expect(
      () =>
        collectFeedPages(
          spec({ inventory: { kind: 'RECENT', windowMs: 7 * DAY } }),
          config({ window }),
          f.ctx,
        ),
      // The WHOLE message, both of its halves: the second half is the part that tells an operator
      // what to do about it, and an assertion on the first half alone cannot tell it is there.
    ).toThrow(
      'a RECENT feed shows only its own window and cannot be asked for another: ' +
        'remove `window` from the source config, or declare the feed COMPLETE',
    )
    expect(f.sent).toEqual([])
  })

  it('refuses it through the provider interface too', async () => {
    const provider = defineRssProvider(spec({ inventory: { kind: 'RECENT', windowMs: 7 * DAY } }))
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: fixtureText('rss-empty.xml') }],
    })
    await expect(
      provider.collectReport(
        provider.parseConfig({ namespace: 'board', configVersion: 3, window: disjoint }),
        f.ctx,
      ),
    ).rejects.toThrow(/a RECENT feed shows only its own window/)
  })

  it('a RECENT feed with no configured window collects, and reports its own', async () => {
    // The acceptance side: the refusal is about a window that was ASKED for, not about every
    // RECENT feed.
    const s = spec({ inventory: { kind: 'RECENT', windowMs: 7 * DAY } })
    const { batch } = await collect(fixtureText('rss-empty.xml'), s, config())
    expect(batch.scope.window).toEqual({ from: new Date('2026-10-13T10:00:00Z'), to: NOW })
  })
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

  it('two distinct guids too long to be native ids, sharing a link, are an invariant failure — not one posting', async () => {
    // The identity seam refuses a native id over 256 characters and falls back to the URL, so
    // both entries key on the SAME link. The provider issued two different ids, so collapsing them
    // would silently merge two postings: the loop's collision check catches it, and it can only
    // do so because the base reports the GUID as the provider's id.
    const long = (tag: string) => `${tag}-${'x'.repeat(300)}`
    const { batch } = await collect(
      rss(item(long('a'), 'https://example.com/j/1') + item(long('b'), 'https://example.com/j/1')),
    )
    expect(batch.outcome).toBe('FAILED')
    expect(batch.observations).toEqual([])
    expect(batch.requests.at(-1)?.error?.code).toBe('ADAPTER_INVARIANT')
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

/**
 * ONE SPELLING OF AN ID ON BOTH PATHS (SR-M-3).
 *
 * Acceptance first, from the specification: the GUID is identity, and the identity seam spells an
 * id NFC + trimmed — so two Unicode spellings of one id ARE one id, and one posting. Then the
 * refusal the finding reproduced: that sameness must not read as a collision.
 */
describe('a GUID is one id however it is spelled', () => {
  // 'José' precomposed (U+00E9) and decomposed (e + U+0301). One id, two spellings.
  const PRECOMPOSED = 'jos\u00e9-1'
  const DECOMPOSED = 'jose\u0301-1'

  it('treats two spellings of one guid as one identity, not as a collision', async () => {
    const { batch } = await collect(
      rss(
        item(PRECOMPOSED, 'https://example.com/j/1') + item(DECOMPOSED, 'https://example.com/j/2'),
      ),
    )

    // Without the fix this was FAILED / ADAPTER_INVARIANT: the loop compared the raw guid against
    // the normalised one already recorded against that identity key, and the whole page — both
    // postings — was discarded.
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.requests.map((r) => r.error)).toEqual([null])
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual([PRECOMPOSED, PRECOMPOSED])
    expect(new Set(batch.observations.map((o) => o.identity.identityKey)).size).toBe(1)
  })

  it('still refuses two genuinely different ids that collapse to one identity key', async () => {
    // THE REFUSAL SIDE, and it had to be reachable: normalising the comparison must not switch the
    // AC5 guard off. Two entries whose guids are PAST the usable length both fall back to URL
    // identity, so one shared link gives them one identity key — while `nativeIdOf` reports two
    // different provider ids. That is the collapse AC5 exists for, and it is still reported.
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        {
          bodyText: rss(
            item('a'.repeat(257), 'https://example.com/one-and-only') +
              item('b'.repeat(257), 'https://example.com/one-and-only'),
          ),
        },
      ],
    })
    const batch = await collectFeedPages(spec(), config(), f.ctx)

    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('ADAPTER_INVARIANT')
    // The reported message is bounded, so the assertion is on its head rather than its tail.
    expect(batch.requests.at(-1)?.error?.message).toMatch(/^adapter invariant: native ids a{20}/)
  })

  it('an over-long guid falls back to URL identity, and a changed link splits the posting', async () => {
    // The inverse the review found uncovered. A guid past MAX_NATIVE_ID_CHARS is unusable, so
    // identity is the URL — and the URL is the provider's to change, so the SAME posting under a
    // new link is a NEW record. That is the cost of the fallback, and it is a fact about the
    // source rather than a defect: with no usable id there is nothing stable left to key on.
    const huge = 'g'.repeat(257)
    const first = await collect(rss(item(huge, 'https://example.com/j/old')))
    const second = await collect(rss(item(huge, 'https://example.com/j/new')))

    for (const batch of [first.batch, second.batch]) {
      expect(batch.outcome).toBe('SUCCEEDED')
      expect(batch.observations[0]?.identity.identityKind).toBe('URL_FALLBACK')
      expect(batch.observations[0]?.identity.nativeId).toBeNull()
    }
    expect(first.batch.observations[0]?.identity.identityKey).not.toBe(
      second.batch.observations[0]?.identity.identityKey,
    )
  })
})

/**
 * The feed base shares the XML binding's header policy, so the allowlist holds here too — and
 * feeds are where browser impersonation is tempting, which is why it is asserted on both bindings
 * rather than once (SR-M-2 = CR-M-4).
 */
describe('AC6 — the feed base sends only the headers an adapter may send', () => {
  it.each(['referer', 'cookie', 'origin', 'x-forwarded-for', 'x-device-user-agent'])(
    'drops %s',
    async (name) => {
      const s = spec({
        feedRequest: () => ({
          url: 'https://weworkremotely.example/remote-jobs.rss',
          headers: { [name]: 'something a browser would send' },
        }),
      })
      const { f } = await collect(fixtureText('rss-empty.xml'), s)
      expect(f.sent[0]?.headers).toEqual({ 'user-agent': DEFAULT_USER_AGENT })
    },
  )
})

/**
 * The mojibake refusal reaches feeds through the same decode (SPEC-M-1 = SR-M-1): a feed is the
 * binding where a windows-1251 body is actually likely.
 */
describe('a feed whose bytes were decoded as the wrong encoding is drift', () => {
  it('refuses a windows-1251 feed that arrived full of replacement characters', async () => {
    const body = `<?xml version="1.0" encoding="windows-1251"?><rss version="2.0"><channel><title>\ufffd\ufffd\ufffd</title>${item('g-1', 'https://example.com/j/1')}</channel></rss>`
    const { batch } = await collect(body)

    expect(batch.outcome).toBe('FAILED')
    expect(batch.observations).toEqual([])
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })

  it('accepts a windows-1251 feed the fetch decoded correctly', async () => {
    const body = `<?xml version="1.0" encoding="windows-1251"?><rss version="2.0"><channel><title>Вакансії</title>${item('g-1', 'https://example.com/j/1')}</channel></rss>`
    const { batch } = await collect(body)

    expect(batch.outcome).toBe('SUCCEEDED')
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['g-1'])
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
    // Each page under its own slot, the cursor included, so the two never share a cached body.
    expect([...f.cache.keys()].map((key) => JSON.parse(key)[0])).toEqual([
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
