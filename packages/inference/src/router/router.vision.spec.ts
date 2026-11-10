import { describe, expect, it } from 'vitest'
import {
  answer,
  config,
  deps,
  GEMINI,
  GOOD,
  GROQ,
  hostOf,
  LOCAL,
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
    const r = await createRouter(config([GROQ, GEMINI, LOCAL]), deps(f.fetchImpl)).run({
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

  it('never falls to the local floor when every vision pair fails', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.local ? GOOD : BAD))
    const d = deps(f.fetchImpl)
    const r = await createRouter(config([GROQ, GEMINI, LOCAL]), d).run({ ...REQ, images: IMAGES })
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(new Set(hosts(f.sent))).toEqual(new Set([hostOf.gemini]))
    expect(d.events.some((e) => e.type === 'FELL_TO_LOCAL')).toBe(false)
  })

  it('with no vision route configured sends nothing and answers NOT_CONFIGURED', async () => {
    const f = scriptedFetch(() => GOOD)
    const r = await createRouter(config([GROQ, LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      images: IMAGES,
    })
    expect(r).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
    expect(f.sent).toHaveLength(0)
  })

  it('a local-only config never receives the pages', async () => {
    const f = scriptedFetch(() => GOOD)
    const r = await createRouter(config([LOCAL]), deps(f.fetchImpl)).run({ ...REQ, images: IMAGES })
    expect(r).toEqual({ ok: false, code: 'NOT_CONFIGURED' })
    expect(f.sent).toHaveLength(0)
  })

  it('without images the order and the floor are unchanged, content stays a string', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.local ? GOOD : BAD))
    const r = await createRouter(config([GROQ, GEMINI, LOCAL]), deps(f.fetchImpl)).run(REQ)
    expect(r.ok).toBe(true)
    // Two models per route, each asked once and corrected once, then the floor.
    expect(hosts(f.sent)).toEqual([
      ...Array<string>(4).fill(hostOf.groq),
      ...Array<string>(4).fill(hostOf.gemini),
      hostOf.local,
    ])
    expect(f.sent.every((s) => typeof userContent(s.body) === 'string')).toBe(true)
  })

  it('Gemini first and failing: nothing reaches the later text-only route or the floor', async () => {
    const f = scriptedFetch((s) => (s.host === hostOf.gemini ? BAD : GOOD))
    const r = await createRouter(config([GEMINI, GROQ, LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      images: IMAGES,
    })
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(new Set(hosts(f.sent))).toEqual(new Set([hostOf.gemini]))
  })

  it('largest preference with images still goes only to Gemini', async () => {
    const f = scriptedFetch(() => GOOD)
    const r = await createRouter(config([GROQ, GEMINI, LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      images: IMAGES,
      modelPreference: 'largest',
    })
    expect(r.ok).toBe(true)
    expect(hosts(f.sent)).toEqual([hostOf.gemini])
  })

  it('an image call does not advance the rotation of text calls', async () => {
    const f = scriptedFetch(() => GOOD)
    const router = createRouter(config([GROQ, GEMINI, LOCAL]), deps(f.fetchImpl))
    await router.run(REQ)
    await router.run({ ...REQ, images: IMAGES })
    await router.run(REQ)
    expect(hosts(f.sent)).toEqual([hostOf.groq, hostOf.gemini, hostOf.gemini])
  })

  it('a configured Gemini route with every model spent is PROVIDER_ERROR, not NOT_CONFIGURED', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { routeState: createMemoryRouteStatePort() })
    const router = createRouter(config([GEMINI, LOCAL]), d)
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
      config([GEMINI, LOCAL]),
      deps(spent.fetchImpl, { routeState: d.routeState }),
    ).run({ ...REQ, images: IMAGES })
    expect(r1).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    const r2 = await router.run({ ...REQ, images: IMAGES })
    expect(r2).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(f.sent).toHaveLength(0)
  })

  it('a configured Gemini route whose prompt does not fit is PROVIDER_ERROR', async () => {
    const f = scriptedFetch(() => GOOD)
    const tiny = { ...GEMINI, contextTokens: 100 }
    const r = await createRouter(config([tiny, LOCAL]), deps(f.fetchImpl)).run({
      ...REQ,
      images: IMAGES,
    })
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(f.sent).toHaveLength(0)
  })

  it.each([
    ['an image outside the base64 alphabet', ['iVBOR*0KGgo=']],
    ['an image whose length is not a multiple of 4', ['iVBORw0KGgo']],
    ['an empty image', ['']],
    [
      'images over the request cap',
      ['A'.repeat(MAX_IMAGE_REQUEST_CHARS / 2), 'A'.repeat(MAX_IMAGE_REQUEST_CHARS / 2 + 4)],
    ],
  ])('%s sends nothing', async (_name, images) => {
    const f = scriptedFetch(() => GOOD)
    const r = await createRouter(config([GEMINI, LOCAL]), deps(f.fetchImpl)).run({ ...REQ, images })
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(f.sent).toHaveLength(0)
  })

  it('images exactly at the request cap still go', async () => {
    const f = scriptedFetch(() => GOOD)
    const images = [
      'A'.repeat(MAX_IMAGE_REQUEST_CHARS / 2),
      'A'.repeat(MAX_IMAGE_REQUEST_CHARS / 2),
    ]
    const r = await createRouter(config([GEMINI, LOCAL]), deps(f.fetchImpl)).run({ ...REQ, images })
    expect(r.ok).toBe(true)
    expect(hosts(f.sent)).toEqual([hostOf.gemini])
  })
})
