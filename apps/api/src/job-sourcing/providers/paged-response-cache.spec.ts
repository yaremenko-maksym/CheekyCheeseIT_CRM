import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fakeCollectionContext } from '../../test/fake-collection-context'
import {
  baseSourceConfigSchema,
  collectPages,
  type DecodedEnvelope,
  type PagedSourceSpec,
} from './api-json.provider'
import type { CachedResponse, CollectionBatch, FetchRequest } from './reporting-provider'

/**
 * THE RESPONSE CACHE KEY, pinned at the one seam every binding shares (`collectPages`).
 *
 * The acceptance side first, from the specification — "a conditional request revalidates the body
 * stored for THIS request" — and then the refusal side the finding names: a request that differs
 * from the stored one in ANY dimension must not be able to revalidate it (SR-H-1).
 *
 * Why the refusals are written as "a 304 does not replay the other request's body" rather than as
 * "the keys differ": a key is an implementation detail and a test on its shape would pass while the
 * loop looked the entry up by something else. The observable harm is the one the security axis
 * reproduced — two sources on one board, `query=python` and `query=java`, where a 304 on the second
 * returned the first's postings and the batch reported SUCCEEDED with the wrong inventory stored —
 * so each case below asserts exactly that cannot happen.
 */

const configSchema = baseSourceConfigSchema.extend({})
type Config = z.infer<typeof configSchema>

const config = (overrides: Record<string, unknown> = {}): Config =>
  configSchema.parse({ namespace: 'board', configVersion: 1, ...overrides })

const NOW = new Date('2026-10-20T10:00:00Z')
const BODY = JSON.stringify({ ids: ['first-source-posting'] })
const OTHER_BODY = JSON.stringify({ ids: ['second-source-posting'] })

const envelopeSchema = z.object({ ids: z.array(z.string()) })

/**
 * One adapter whose request is built from the config, and whose cache SLOT is the page — which is
 * what the feed base and the JSON spec harness both do, and what made the collision possible.
 */
function spec(overrides: Partial<PagedSourceSpec<Config, { ids: string[] }, string>> = {}) {
  const built: PagedSourceSpec<Config, { ids: string[] }, string> = {
    type: 'REMOTEOK_API',
    adapterVersion: 'cache-test-1',
    decodeEnvelope: (bodyText): DecodedEnvelope<{ ids: string[] }> => {
      const parsed = envelopeSchema.safeParse(JSON.parse(bodyText))
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, code: 'PARSE_DRIFT', message: 'not the envelope' }
    },
    itemSchema: z.string(),
    pageRequest: (cfg, at) => ({
      request: {
        url: `https://api.example.com/jobs?q=${cfg.query ?? ''}&from=${cfg.window?.from.toISOString() ?? ''}`,
      },
      // ONE slot for the page, deliberately: it is the slot an adapter would reasonably choose and
      // the one under which every case below would have collided.
      cacheKey: `page-${at.page}`,
    }),
    extractItems: (envelope) => envelope.ids,
    nextCursor: () => null,
    nativeIdOf: (id) => id,
    mapItem: (id, cfg) => ({
      namespace: cfg.namespace,
      nativeId: id,
      url: `https://jobs.example.com/j/${id}`,
      title: `Engineer ${id}`,
      companyName: 'Acme',
    }),
    scopeOf: (cfg) => ({
      namespace: cfg.namespace,
      query: cfg.query ?? null,
      configVersion: cfg.configVersion,
      window: cfg.window ?? null,
    }),
    limits: { maxPages: 3, maxItemsPerPage: 50 },
    ...overrides,
  }
  return built
}

/** A first attempt that stores a validated body, and the cache it leaves behind. */
async function storeBody(opts: {
  spec?: PagedSourceSpec<Config, { ids: string[] }, string>
  config?: Config
  bodyText?: string
}): Promise<Record<string, CachedResponse>> {
  const f = fakeCollectionContext({
    now: NOW,
    responses: [{ bodyText: opts.bodyText ?? BODY, etag: '"v1"' }],
  })
  const batch = await collectPages(opts.spec ?? spec(), opts.config ?? config(), f.ctx)
  // The premise of every case below: the first attempt really did cache something.
  expect(batch.outcome).toBe('SUCCEEDED')
  expect(f.cache.size).toBe(1)
  return Object.fromEntries(f.cache)
}

/** A second attempt against the cache the first left, answered 304 — the replay opportunity. */
async function revalidate(
  cacheSeed: Record<string, CachedResponse>,
  opts: { spec?: PagedSourceSpec<Config, { ids: string[] }, string>; config?: Config } = {},
): Promise<{ batch: CollectionBatch; sentValidators: Record<string, string> | undefined }> {
  const f = fakeCollectionContext({ now: NOW, responses: [{ status: 304 }], cacheSeed })
  const batch = await collectPages(opts.spec ?? spec(), opts.config ?? config(), f.ctx)
  return { batch, sentValidators: f.sent[0]?.headers }
}

const storedIds = (batch: CollectionBatch): string[] =>
  batch.observations.map((o) => o.identity.nativeId ?? '')

describe('the response cache revalidates the body stored for this very request', () => {
  it('replays the stored body when the request is the same in every dimension', async () => {
    const cacheSeed = await storeBody({})
    const { batch, sentValidators } = await revalidate(cacheSeed)

    expect(sentValidators?.['if-none-match']).toBe('"v1"')
    expect(batch.outcome).toBe('SUCCEEDED')
    expect(storedIds(batch)).toEqual(['first-source-posting'])
  })
})

/**
 * Each case changes exactly ONE thing and nothing else. The assertion is the same three lines
 * every time, because the harm is the same every time: no validator is sent (there is nothing
 * stored for this request), so the provider's 304 answers a precondition nobody asked, and the
 * loop reports drift instead of handing back someone else's inventory.
 */
describe('a request that differs in any dimension cannot revalidate another request`s body', () => {
  const expectNoReplay = (
    batch: CollectionBatch,
    sentValidators: Record<string, string> | undefined,
  ): void => {
    expect(sentValidators?.['if-none-match']).toBeUndefined()
    expect(storedIds(batch)).toEqual([])
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  }

  it('differs in the query — the collision the finding reproduced', async () => {
    const cacheSeed = await storeBody({ config: config({ query: 'python' }) })
    const { batch, sentValidators } = await revalidate(cacheSeed, {
      config: config({ query: 'java' }),
    })
    expectNoReplay(batch, sentValidators)
  })

  it('differs in the window', async () => {
    const cacheSeed = await storeBody({
      config: config({ window: { from: '2026-10-01T00:00:00Z', to: '2026-10-20T00:00:00Z' } }),
    })
    const { batch, sentValidators } = await revalidate(cacheSeed, {
      config: config({ window: { from: '2026-09-01T00:00:00Z', to: '2026-10-20T00:00:00Z' } }),
    })
    expectNoReplay(batch, sentValidators)
  })

  it('differs in the request URL, with query and window identical', async () => {
    const cacheSeed = await storeBody({})
    const { batch, sentValidators } = await revalidate(cacheSeed, {
      spec: spec({
        pageRequest: (cfg, at) => ({
          ...spec().pageRequest(cfg, at),
          request: { url: 'https://api.example.com/v2/jobs' },
        }),
      }),
    })
    expectNoReplay(batch, sentValidators)
  })

  it('differs in the adapter version, the request being byte-identical', async () => {
    const cacheSeed = await storeBody({})
    const { batch, sentValidators } = await revalidate(cacheSeed, {
      spec: spec({ adapterVersion: 'cache-test-2' }),
    })
    expectNoReplay(batch, sentValidators)
  })

  it('differs in a request header', async () => {
    const cacheSeed = await storeBody({
      spec: spec({
        pageRequest: (cfg, at) => ({
          ...spec().pageRequest(cfg, at),
          request: { url: 'https://api.example.com/jobs', headers: { accept: 'application/json' } },
        }),
      }),
    })
    const { batch, sentValidators } = await revalidate(cacheSeed, {
      spec: spec({
        pageRequest: (cfg, at) => ({
          ...spec().pageRequest(cfg, at),
          request: { url: 'https://api.example.com/jobs', headers: { accept: 'application/xml' } },
        }),
      }),
    })
    expectNoReplay(batch, sentValidators)
  })

  // Titled for what it varies. It was `differs in the method and body`, and it varied only the
  // body: both sides were POST, so `request.method` could leave the digest with every test in this
  // file still green — its passing and its subject's absence were indistinguishable (CR-M-2). The
  // method now has its own case below.
  it('differs in the body of a POST-shaped search', async () => {
    const cacheSeed = await storeBody({
      spec: spec({
        pageRequest: (cfg, at) => ({
          ...spec().pageRequest(cfg, at),
          request: { url: 'https://api.example.com/search', method: 'POST', body: '{"q":"rust"}' },
        }),
      }),
    })
    const { batch, sentValidators } = await revalidate(cacheSeed, {
      spec: spec({
        pageRequest: (cfg, at) => ({
          ...spec().pageRequest(cfg, at),
          request: { url: 'https://api.example.com/search', method: 'POST', body: '{"q":"go"}' },
        }),
      }),
    })
    expectNoReplay(batch, sentValidators)
  })

  /**
   * ONLY the method differs — one URL, no body, no headers (CR-M-2).
   *
   * This is the case that fails if `request.method` leaves the digest, and the only one: every
   * other case in this file varies a second dimension that would carry the key on its own. A
   * provider for which `GET /search` and `POST /search` are different operations is ordinary, and
   * replaying one's body for the other is the SR-H-1 harm with the verb as the parameter.
   */
  it('differs only in the method, GET versus POST on one URL', async () => {
    const at = (method: 'GET' | 'POST') =>
      spec({
        pageRequest: (cfg, page) => ({
          ...spec().pageRequest(cfg, page),
          request: { url: 'https://api.example.com/search', method },
        }),
      })
    const cacheSeed = await storeBody({ spec: at('GET') })
    const { batch, sentValidators } = await revalidate(cacheSeed, { spec: at('POST') })
    expectNoReplay(batch, sentValidators)
  })

  /**
   * A FIELD THE DIGEST NEVER NAMED (CR-M-1 = SR-M-2).
   *
   * `responseCacheKey` hashes the whole `request` object, so a dimension added to `FetchRequest`
   * later joins the key by construction. This case is what keeps that true: it sends a request
   * carrying a field outside today's interface — standing in for the per-source timeout or
   * redirect policy a future task adds — and asserts the two requests do not share an entry. Go
   * back to hashing a list of fields and only this case fails.
   *
   * The cast is the point rather than a shortcut: the field cannot be declared, because if it
   * could it would already be in the interface and the case would prove nothing about fields that
   * are not.
   */
  it('keys on a request field the digest never enumerated', async () => {
    const withExtra = (value: string) =>
      spec({
        pageRequest: (cfg, page) => ({
          ...spec().pageRequest(cfg, page),
          request: { url: 'https://api.example.com/jobs', redirect: value } as FetchRequest,
        }),
      })
    const cacheSeed = await storeBody({ spec: withExtra('follow') })
    const { batch, sentValidators } = await revalidate(cacheSeed, { spec: withExtra('error') })
    expectNoReplay(batch, sentValidators)
  })

  it('differs in the source type, with one board and one slot', async () => {
    const cacheSeed = await storeBody({})
    const { batch, sentValidators } = await revalidate(cacheSeed, {
      spec: spec({ type: 'WWR_RSS' }),
    })
    expectNoReplay(batch, sentValidators)
  })
})

describe('the key is a digest, not the request', () => {
  it('does not carry a credential from the request it keys', async () => {
    const cacheSeed = await storeBody({
      spec: spec({
        pageRequest: (cfg, at) => ({
          ...spec().pageRequest(cfg, at),
          request: {
            url: 'https://api.example.com/jobs?api_key=s3cret-in-url',
            headers: { authorization: 'Bearer s3cret-in-header' },
          },
        }),
      }),
    })
    const keys = Object.keys(cacheSeed).join('|')

    // A cache key is stored, and a request carries credentials. The SLOT stays readable so an
    // operator can still tell which page an entry belongs to.
    expect(keys).not.toContain('s3cret-in-url')
    expect(keys).not.toContain('s3cret-in-header')
    expect(keys).toContain('page-1')
  })

  it('stores one entry per request, not one per slot, when two requests share a slot', async () => {
    // The arithmetic behind every refusal above: two attempts under the same slot leave two
    // entries, where the old key left one that the second attempt overwrote.
    const first = await storeBody({ config: config({ query: 'python' }) })
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: OTHER_BODY, etag: '"v2"' }],
      cacheSeed: first,
    })
    await collectPages(spec(), config({ query: 'java' }), f.ctx)

    expect(f.cache.size).toBe(2)
    expect([...f.cache.values()].map((e) => e.bodyText).sort()).toEqual([BODY, OTHER_BODY].sort())
  })
})
