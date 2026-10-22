import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fakeCollectionContext } from '../../test/fake-collection-context'
import {
  baseSourceConfigSchema,
  collectPages,
  type DecodedEnvelope,
  type PagedSourceSpec,
} from './api-json.provider'

/**
 * Two guards on the shared loop, each for a slot that could end the attempt without reporting.
 *
 * Both are latent in production today — no shipped decoder throws, and no shipped response sends
 * an empty validator — so each case states the behaviour the code promises and then the one it
 * used to deliver instead.
 */

const configSchema = baseSourceConfigSchema.extend({})
type Config = z.infer<typeof configSchema>
const config = (): Config => configSchema.parse({ namespace: 'board', configVersion: 1 })
const NOW = new Date('2026-10-20T10:00:00Z')

const BODY = JSON.stringify({ ids: ['a'] })

function spec(
  overrides: Partial<PagedSourceSpec<Config, { ids: string[] }, string>> = {},
): PagedSourceSpec<Config, { ids: string[] }, string> {
  return {
    type: 'REMOTEOK_API',
    adapterVersion: 'guards-1',
    decodeEnvelope: (bodyText): DecodedEnvelope<{ ids: string[] }> => ({
      ok: true,
      value: z.object({ ids: z.array(z.string()) }).parse(JSON.parse(bodyText)),
    }),
    itemSchema: z.string(),
    pageRequest: (_cfg, at) => ({
      request: { url: `https://api.example.com/jobs?page=${at.page}` },
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
      query: null,
      configVersion: cfg.configVersion,
      window: null,
    }),
    limits: { maxPages: 3, maxItemsPerPage: 50 },
    ...overrides,
  }
}

/**
 * AN EMPTY PRECONDITION IS NEVER SENT (CR-M-3).
 *
 * The acceptance side is the rule itself, stated on `conditionalHeaders`: a validator that is
 * absent sends no header, because `If-Modified-Since:` with no value is a malformed precondition.
 * The refusal side is the one value that slipped past the old check, which asked `!== undefined` —
 * and an empty header IS defined, so it was stored and replayed verbatim.
 */
describe('an empty validator is not a validator', () => {
  it('stores nothing for a 200 whose only validator is an empty last-modified', async () => {
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ bodyText: BODY, etag: null, headers: { 'last-modified': '' } }],
    })
    const batch = await collectPages(spec(), config(), f.ctx)

    expect(batch.outcome).toBe('SUCCEEDED')
    // There is nothing a later 304 could be an answer to, so there is nothing to remember.
    expect(f.cache.size).toBe(0)
  })

  it('sends no if-modified-since for a cached entry whose last-modified is empty', async () => {
    // Reached by seeding the entry directly: this is what a cache written before the fix holds,
    // and it must not produce `if-modified-since: ""` on the wire now.
    const f = fakeCollectionContext({
      now: NOW,
      responses: [{ status: 304 }],
      cacheSeed: { 'ignored-key': { etag: null, lastModified: '', bodyText: BODY } },
    })
    f.ctx.cache.get = async () => ({ etag: null, lastModified: '', bodyText: BODY })
    const batch = await collectPages(spec(), config(), f.ctx)

    expect(f.sent[0]?.headers?.['if-modified-since']).toBeUndefined()
    // No validator was sent, so the 304 answers nothing and the stored body is not replayed.
    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('PARSE_DRIFT')
  })

  it('sends no if-none-match for a cached entry whose etag is whitespace', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ status: 304 }] })
    f.ctx.cache.get = async () => ({ etag: '  ', bodyText: BODY })
    await collectPages(spec(), config(), f.ctx)

    expect(f.sent[0]?.headers?.['if-none-match']).toBeUndefined()
  })

  it('still stores and replays a validator that has a value', async () => {
    // The acceptance side, so the guard cannot be satisfied by storing nothing ever.
    const first = fakeCollectionContext({
      now: NOW,
      responses: [
        { bodyText: BODY, headers: { 'last-modified': 'Tue, 20 Oct 2026 09:00:00 GMT' } },
      ],
    })
    await collectPages(spec(), config(), first.ctx)
    expect(first.cache.size).toBe(1)

    const second = fakeCollectionContext({
      now: NOW,
      responses: [{ status: 304 }],
      cacheSeed: Object.fromEntries(first.cache),
    })
    const batch = await collectPages(spec(), config(), second.ctx)

    expect(second.sent[0]?.headers?.['if-modified-since']).toBe('Tue, 20 Oct 2026 09:00:00 GMT')
    expect(batch.outcome).toBe('SUCCEEDED')
  })
})

/**
 * A DECODER THAT THROWS IS REPORTED, NOT PROPAGATED (CR-M-1).
 *
 * `decodeEnvelope` is contracted to RETURN its refusal, and the two shipped decoders do. It was
 * the last adapter slot the loop called outside a catch, so a decoder that broke its contract
 * rejected `collectPages` — and the pages already persisted went unreported, which is the one
 * thing the loop's error handling exists to prevent.
 */
describe('a decodeEnvelope that throws ends the attempt with a report', () => {
  it('reports the throw as ADAPTER_INVARIANT instead of rejecting', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: BODY }] })
    const batch = await collectPages(
      spec({
        decodeEnvelope: () => {
          throw new TypeError('cannot read properties of undefined')
        },
      }),
      config(),
      f.ctx,
    )

    expect(batch.outcome).toBe('FAILED')
    expect(batch.requests.at(-1)?.error?.code).toBe('ADAPTER_INVARIANT')
    expect(batch.requests.at(-1)?.error?.message).toContain(
      'decodeEnvelope threw outside its contract: cannot read properties of undefined',
    )
  })

  it('keeps the pages that already landed when a later page`s decode throws', async () => {
    // The half the rejection destroyed: page one is persisted and reported, and the attempt is
    // PARTIAL rather than FAILED, because it did collect something.
    let decodes = 0
    const f = fakeCollectionContext({
      now: NOW,
      responses: [
        { bodyText: JSON.stringify({ ids: ['a'] }) },
        { bodyText: JSON.stringify({ ids: ['b'] }) },
      ],
    })
    const batch = await collectPages(
      spec({
        nextCursor: (_envelope, at) => (at.page === 1 ? 'p2' : null),
        decodeEnvelope: (bodyText) => {
          decodes += 1
          if (decodes > 1) throw new Error('the second page broke the decoder')
          return {
            ok: true,
            value: z.object({ ids: z.array(z.string()) }).parse(JSON.parse(bodyText)),
          }
        },
      }),
      config(),
      f.ctx,
    )

    expect(batch.outcome).toBe('PARTIAL')
    expect(batch.observations.map((o) => o.identity.nativeId)).toEqual(['a'])
    expect(batch.requests.at(-1)?.error?.code).toBe('ADAPTER_INVARIANT')
  })

  it('names a non-Error throw without pretending it has a message', async () => {
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: BODY }] })
    const batch = await collectPages(
      spec({
        decodeEnvelope: () => {
          throw 'a string, as some libraries do'
        },
      }),
      config(),
      f.ctx,
    )

    expect(batch.requests.at(-1)?.error?.message).toBe(
      'decodeEnvelope threw outside its contract: a non-Error value',
    )
  })

  it('a decoder that RETURNS its refusal still reports the code it chose', async () => {
    // The acceptance side: the guard must not flatten every decode failure to ADAPTER_INVARIANT.
    const f = fakeCollectionContext({ now: NOW, responses: [{ bodyText: 'not json' }] })
    const batch = await collectPages(
      spec({
        decodeEnvelope: () => ({ ok: false, code: 'PAYLOAD_TOO_LARGE', message: 'over the bound' }),
      }),
      config(),
      f.ctx,
    )

    expect(batch.requests.at(-1)?.error).toEqual({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'over the bound',
    })
  })
})
