import { describe, expect, it } from 'vitest'
import {
  answer,
  config,
  deps,
  GEMINI,
  GOOD,
  GROQ,
  hostOf,
  REQ,
  scriptedFetch,
} from './__test-helpers__/router-harness'
import { MAX_IMAGE_REQUEST_CHARS } from '../contracts/extraction'
import { createMemoryRouteStatePort } from './state'
import { createRouter } from './router'

const IMAGES = ['iVBORw0KGgo=']
const BAD = answer('not json at all')
const hosts = (sent: { host: string }[]) => sent.map((s) => s.host)
const userContent = (body: Record<string, unknown>) =>
  (body.messages as { role: string; content: unknown }[])[1]!.content

describe('router: image requests go only to vision-capable pairs', () => {
  it('skips the text-only route and sends the pages to Gemini as image parts', async () => {
    const f = scriptedFetch(() => GOOD)
    const r = await createRouter(config([GROQ, GEMINI]), deps(f.fetchImpl)).run({
      ...REQ,
      images: IMAGES,
    })
    expect(r.ok).toBe(true)
    expect(hosts(f.sent)).toEqual([hostOf.gemini])
    expect(userContent(f.sent[0]!.body)).toEqual([
      { type: 'text', text: REQ.input },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGES[0]}` } },
    ])
  })

  it('every vision pair failing is PROVIDER_ERROR, the text-only route never asked', async () => {
    const f = scriptedFetch(() => BAD)
    const r = await createRouter(config([GROQ, GEMINI]), deps(f.fetchImpl)).run({
      ...REQ,
      images: IMAGES,
    })
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(new Set(hosts(f.sent))).toEqual(new Set([hostOf.gemini]))
  })

  it('with no vision route configured sends nothing and answers NOT_CONFIGURED', async () => {
    const f = scriptedFetch(() => GOOD)
    const r = await createRouter(config([GROQ]), deps(f.fetchImpl)).run({
      ...REQ,
      images: IMAGES,
    })
    expect(r).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
    expect(f.sent).toHaveLength(0)
  })

  it('without images the order is unchanged and content stays a string', async () => {
    const f = scriptedFetch(() => BAD)
    const r = await createRouter(config([GROQ, GEMINI]), deps(f.fetchImpl)).run(REQ)
    expect(r).toEqual({ ok: false, code: 'INVALID_OUTPUT' })
    // Two models per route, each asked once and corrected once.
    expect(hosts(f.sent)).toEqual([
      ...Array<string>(4).fill(hostOf.groq),
      ...Array<string>(4).fill(hostOf.gemini),
    ])
    expect(f.sent.every((s) => typeof userContent(s.body) === 'string')).toBe(true)
  })

  it('Gemini first and failing: nothing reaches the later text-only route', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.gemini ? BAD : GOOD))
    const r = await createRouter(config([GEMINI, GROQ]), deps(f.fetchImpl)).run({
      ...REQ,
      images: IMAGES,
    })
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(new Set(hosts(f.sent))).toEqual(new Set([hostOf.gemini]))
  })

  it('largest preference with images still goes only to Gemini', async () => {
    const f = scriptedFetch(() => GOOD)
    const r = await createRouter(config([GROQ, GEMINI]), deps(f.fetchImpl)).run({
      ...REQ,
      images: IMAGES,
      modelPreference: 'largest',
    })
    expect(r.ok).toBe(true)
    expect(hosts(f.sent)).toEqual([hostOf.gemini])
  })

  it('an image call does not advance the rotation of text calls', async () => {
    const f = scriptedFetch(() => GOOD)
    const router = createRouter(config([GROQ, GEMINI]), deps(f.fetchImpl))
    await router.run(REQ)
    await router.run({ ...REQ, images: IMAGES })
    await router.run(REQ)
    expect(hosts(f.sent)).toEqual([hostOf.groq, hostOf.gemini, hostOf.gemini])
  })

  it('a configured Gemini route with every model spent is LIMITS_EXHAUSTED, not NOT_CONFIGURED', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { routeState: createMemoryRouteStatePort() })
    const router = createRouter(config([GEMINI]), d)
    // A 429 with a daily quota body marks each model spent for the day.
    const spent = scriptedFetch(() => ({
      status: 429,
      body: JSON.stringify({
        error: {
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
            },
          ],
        },
      }),
    }))
    const r1 = await createRouter(
      config([GEMINI]),
      deps(spent.fetchImpl, { routeState: d.routeState }),
    ).run({ ...REQ, images: IMAGES })
    expect(r1).toEqual({ ok: false, code: 'LIMITS_EXHAUSTED' })
    const r2 = await router.run({ ...REQ, images: IMAGES })
    expect(r2).toEqual({ ok: false, code: 'LIMITS_EXHAUSTED' })
    expect(f.sent).toHaveLength(0)
  })

  it('a configured Gemini route whose prompt does not fit is PROVIDER_ERROR', async () => {
    const f = scriptedFetch(() => GOOD)
    const tiny = { ...GEMINI, contextTokens: 100 }
    const r = await createRouter(config([tiny]), deps(f.fetchImpl)).run({
      ...REQ,
      images: IMAGES,
    })
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(f.sent).toHaveLength(0)
  })

  it.each([
    ['an empty image list', []],
    ['an image outside the base64 alphabet', ['iVBOR*0KGgo=']],
    ['an image whose length is not a multiple of 4', ['iVBORw0KGgo']],
    ['an empty image', ['']],
    [
      'images over the request cap',
      ['A'.repeat(MAX_IMAGE_REQUEST_CHARS / 2), 'A'.repeat(MAX_IMAGE_REQUEST_CHARS / 2 + 4)],
    ],
  ])('%s sends nothing', async (_name, images) => {
    const f = scriptedFetch(() => GOOD)
    const r = await createRouter(config([GEMINI]), deps(f.fetchImpl)).run({ ...REQ, images })
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(f.sent).toHaveLength(0)
  })

  it('images exactly at the request cap still go', async () => {
    const f = scriptedFetch(() => GOOD)
    const images = [
      'A'.repeat(MAX_IMAGE_REQUEST_CHARS / 2),
      'A'.repeat(MAX_IMAGE_REQUEST_CHARS / 2),
    ]
    const r = await createRouter(config([GEMINI]), deps(f.fetchImpl)).run({ ...REQ, images })
    expect(r.ok).toBe(true)
    expect(hosts(f.sent)).toEqual([hostOf.gemini])
  })
})
