import { describe, expect, it } from 'vitest'
import {
  answer,
  CLOUDFLARE,
  CLOUDFLARE_ACCOUNT_ID,
  config,
  countingCap,
  deps,
  GEMINI,
  GOOD,
  GROQ,
  KEY_MARKER,
  OPENROUTER,
  PROVIDER_BODY_MARKER,
  REQ,
  scriptedFetch,
  TEXT_MARKER,
  type Reply,
} from './__test-helpers__/router-harness'
import { createRouter, type RouterEvent } from './router'
import { createFileRouteStatePort, type StateEvent } from './state'
import { fakeFs } from './__test-helpers__/fake-fs'

const REPLY_MARKER = 'REPLY-MARKER-3b8c'
const MARKERS = [
  KEY_MARKER,
  TEXT_MARKER,
  PROVIDER_BODY_MARKER,
  REPLY_MARKER,
  'Bearer',
  CLOUDFLARE_ACCOUNT_ID,
]
const body = (extra: object = {}) =>
  JSON.stringify({ error: { message: PROVIDER_BODY_MARKER, type: 'x', ...extra } })

/** Every failure shape a provider can send, each body carrying the provider marker. */
const FAILURES: Reply[] = [
  { status: 401, body: body() },
  { status: 402, body: body() },
  { status: 403, body: body() },
  { status: 403, body: `<html>${PROVIDER_BODY_MARKER}</html>` },
  { status: 404, body: body({ code: 'model_not_found' }) },
  { status: 410, body: `AiError: Model has been deprecated ${PROVIDER_BODY_MARKER}` },
  {
    status: 429,
    body: JSON.stringify({
      success: false,
      errors: [{ code: 3036, message: PROVIDER_BODY_MARKER }],
    }),
  },
  { status: 429, body: body(), headers: { 'x-ratelimit-remaining-requests': '0' } },
  { status: 429, body: body(), headers: { 'retry-after': PROVIDER_BODY_MARKER } },
  { status: 500, body: body() },
  { status: 503, body: body() },
  answer(`not json ${REPLY_MARKER}`),
  answer(REPLY_MARKER, {}, 'length'),
  answer(REPLY_MARKER, {}, 'content_filter'),
  answer({ wrong: REPLY_MARKER }),
  answer({ wrong: REPLY_MARKER }, { model: `gemini-9.9-pro ${PROVIDER_BODY_MARKER}` }),
  answer({ wrong: REPLY_MARKER }, { model: 'gemini-9.9-pro' }),
  'network',
]

function assertClean(label: string, value: unknown): void {
  const text = JSON.stringify(value)
  for (const m of MARKERS) expect(text, `${label} carries ${m}`).not.toContain(m)
}

describe('router privacy (AC5, ADR §3.3, §4 item 2)', () => {
  it.each(FAILURES.map((f, i) => [i, f] as const))(
    'failure shape %i: no key, header, input, instruction, body or reply text in any event or result',
    async (_i, failure) => {
      const f = scriptedFetch(() => failure)
      const stateEvents: StateEvent[] = []
      const routeState = await createFileRouteStatePort({
        path: '/data/s.json',
        fs: fakeFs(),
        now: Date.now,
        onEvent: (e) => stateEvents.push(e),
      })
      const d = deps(f.fetchImpl, { routeState })
      const req = { ...REQ, instruction: `instruction ${TEXT_MARKER}` }
      const r = await createRouter(config([GROQ, GEMINI, CLOUDFLARE, OPENROUTER]), d).run(req)
      expect(r.ok).toBe(false)
      // The OpenRouter route was reached, so its failure went through the same assertions.
      expect(f.sent.some((s) => new URL(s.url).host === 'openrouter.ai')).toBe(true)
      assertClean('result', r)
      assertClean('events', d.events)
      assertClean('state events', stateEvents)
      assertClean('state', routeState.snapshot())
      expect(d.events.length).toBeGreaterThan(0)
    },
  )

  it('a fetch that throws an error carrying the key and the text leaks neither', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(async () => {
      throw new Error(`${KEY_MARKER} ${TEXT_MARKER}`)
    })
    const r = await createRouter(config([GROQ]), d).run(REQ)
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    assertClean('events', d.events)
    expect(f.sent).toHaveLength(0)
  })

  it('a throwing port adapter never escapes and leaks nothing', async () => {
    const f = scriptedFetch(() => GOOD)
    const cap = countingCap()
    cap.reserve = async () => {
      throw new Error(`${KEY_MARKER} ${TEXT_MARKER}`)
    }
    const d = deps(f.fetchImpl, { ownCap: cap })
    const r = await createRouter(config([GROQ]), d).run(REQ)
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    assertClean('events', d.events)
    expect(d.events.at(-1)).toEqual({
      type: 'CALL',
      code: 'PROVIDER_ERROR',
      latencyMs: 0,
    })
  })

  it('a refused config leaks nothing, a key in it included', async () => {
    const d = deps(scriptedFetch(() => GOOD).fetchImpl)
    const r = await createRouter(config([{ ...GROQ, baseUrl: TEXT_MARKER }]), d).run(REQ)
    assertClean('result', r)
    assertClean('events', d.events)
  })

  it('the key travels only in the Authorization header of its own hosted request, never in a URL or body', async () => {
    const f = scriptedFetch(() => ({ status: 500, body: '' }))
    await createRouter(config([GROQ, GEMINI, CLOUDFLARE, OPENROUTER]), deps(f.fetchImpl)).run(REQ)
    expect(f.sent).toHaveLength(4)
    expect(f.sent.map((s) => new URL(s.url).host)).toContain('openrouter.ai')
    for (const s of f.sent) {
      expect(s.url).not.toContain(KEY_MARKER)
      expect(JSON.stringify(s.body)).not.toContain(KEY_MARKER)
      expect(s.url.startsWith('https://')).toBe(true)
      expect(s.headers.Authorization).toBe(`Bearer ${KEY_MARKER}`)
    }
  })

  it('every event field is a code, an id, a count or a timing', async () => {
    const f = scriptedFetch((s, n) =>
      n === 1
        ? { status: 404, body: body({ code: 'model_not_found' }) }
        : { status: 401, body: body() },
    )
    const d = deps(f.fetchImpl)
    await createRouter(config([GROQ, GEMINI]), d).run(REQ)
    const allowed = new Set([
      'type',
      'route',
      'model',
      'servedModel',
      'code',
      'inputChars',
      'status',
      'latencyMs',
      'totalTokens',
      'reasons',
    ])
    const keys = new Set(d.events.flatMap((e: RouterEvent) => Object.keys(e)))
    expect([...keys].filter((k) => !allowed.has(k))).toEqual([])
    // An EXHAUSTED reason is a route and an internal code, nothing else (H.2).
    const reasons = d.events.flatMap((e) => (e.type === 'EXHAUSTED' ? e.reasons : []))
    expect(reasons.length).toBeGreaterThan(0)
    for (const r of reasons) expect(Object.keys(r).sort()).toEqual(['code', 'route'])
    expect(new Set(d.events.map((e) => e.type))).toEqual(
      new Set(['ATTEMPT', 'RETIRED', 'PROVIDER_DISABLED', 'EXHAUSTED', 'CALL']),
    )
  })
})
