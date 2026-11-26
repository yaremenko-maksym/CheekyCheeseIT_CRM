import { describe, expect, it } from 'vitest'
import {
  config,
  countingCap,
  deps,
  GOOD,
  GROQ,
  hostOf,
  KEY_MARKER,
  OPENROUTER,
  REQ,
  scriptedFetch,
  type Reply,
} from './__test-helpers__/router-harness'
import { OPENROUTER_FIXTURES } from '../internal/__fixtures__/openrouter.fixtures'
import type { ProviderFixture } from '../internal/__fixtures__/provider-fixture'
import { createRouter, type RouterEvent } from './router'
import {
  createMemoryRouteStatePort,
  EMPTY_ROUTE_STATE,
  markCredit,
  markFlagRejected,
  providerDay,
  providerRecord,
} from './state'

/** The OpenRouter route, free models only (ADR §3.5, Amendment 2026-11-08 H.5 and H.9). */
const NOON = Date.parse('2026-11-04T12:00:00Z')
const NEXT_NOON = NOON + 86_400_000
const at = (ms: number) => () => ms
const [M1] = OPENROUTER.models as [string, string]
const reply = (name: string): Reply => {
  const fx = OPENROUTER_FIXTURES.find((f) => f.name === name) as ProviderFixture
  return {
    status: fx.status,
    body: fx.body,
    ...(fx.headers !== undefined && { headers: fx.headers }),
  }
}
const ofType = <K extends RouterEvent['type']>(events: RouterEvent[], type: K) =>
  events.filter((e): e is Extract<RouterEvent, { type: K }> => e.type === type)
const FREE_FIELDS = {
  max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
  require_parameters: true,
  data_collection: 'allow',
  ignore: [],
}

describe('router: the OpenRouter request (§3.5 check 3)', () => {
  it('sends the first model to openrouter.ai with every routing field, the key only in the header', async () => {
    const f = scriptedFetch(() => GOOD)
    const r = await createRouter(config([OPENROUTER]), deps(f.fetchImpl)).run(REQ)
    expect(r.ok).toBe(true)
    expect(f.sent).toHaveLength(1)
    const s = f.sent[0]!
    expect(s.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    expect(s.model).toBe(M1)
    expect(s.headers.Authorization).toBe(`Bearer ${KEY_MARKER}`)
    expect(s.body.provider).toStrictEqual(FREE_FIELDS)
    expect(JSON.stringify(s.body)).not.toContain(KEY_MARKER)
  })

  it('never sends `models`, `route` or `transforms`: OpenRouter picks no model the checks never saw', async () => {
    const f = scriptedFetch(() => GOOD)
    await createRouter(config([OPENROUTER]), deps(f.fetchImpl)).run(REQ)
    for (const key of ['models', 'route', 'transforms'])
      expect(f.sent[0]!.body).not.toHaveProperty(key)
  })

  it('a call without effort sends no reasoning field to openrouter.ai', async () => {
    const f = scriptedFetch(() => GOOD)
    await createRouter(config([OPENROUTER]), deps(f.fetchImpl)).run(REQ)
    expect(f.sent[0]!.body).not.toHaveProperty('reasoning')
    expect(f.sent[0]!.body).not.toHaveProperty('reasoning_effort')
  })

  it('a call with effort minimal sends reasoning.effort to openrouter.ai', async () => {
    const f = scriptedFetch(() => GOOD)
    await createRouter(config([OPENROUTER]), deps(f.fetchImpl)).run({
      ...REQ,
      reasoningEffort: 'minimal',
    })
    expect(f.sent[0]!.body.reasoning).toEqual({ effort: 'minimal' })
    expect(f.sent[0]!.body).not.toHaveProperty('reasoning_effort')
  })

  it('a call with effort low sends no reasoning field to openrouter.ai (resume-tailor stays compatible with free models)', async () => {
    const f = scriptedFetch(() => GOOD)
    await createRouter(config([OPENROUTER]), deps(f.fetchImpl)).run({
      ...REQ,
      reasoningEffort: 'low',
    })
    expect(f.sent[0]!.body).not.toHaveProperty('reasoning')
    expect(f.sent[0]!.body).not.toHaveProperty('reasoning_effort')
  })

  it('carries the route’s own `data_collection` and `ignore`', async () => {
    const f = scriptedFetch(() => GOOD)
    const route = { ...OPENROUTER, dataCollection: 'deny', providerIgnore: ['some-host'] }
    await createRouter(config([route]), deps(f.fetchImpl)).run(REQ)
    expect(f.sent[0]!.body.provider).toStrictEqual({
      ...FREE_FIELDS,
      data_collection: 'deny',
      ignore: ['some-host'],
    })
  })

  it('no other provider’s request carries a `provider` object', async () => {
    const f = scriptedFetch(() => GOOD)
    await createRouter(config([GROQ]), deps(f.fetchImpl)).run(REQ)
    expect(f.sent[0]!.body).not.toHaveProperty('provider')
  })

  it.each([
    ['no dataCollection', { ...OPENROUTER, dataCollection: undefined }],
    ['an unknown dataCollection', { ...OPENROUTER, dataCollection: 'maybe' }],
    ['a bad ignore slug', { ...OPENROUTER, providerIgnore: ['Not A Slug'] }],
    ['providerIgnore on another provider', { ...GROQ, providerIgnore: [] }],
  ])('%s: the config is refused and nothing is sent', async (_l, route) => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl)
    const r = await createRouter(config([route]), d).run(REQ)
    expect(r.ok).toBe(false)
    expect(f.sent).toEqual([])
    expect(ofType(d.events, 'CONFIG_REFUSED')).toHaveLength(1)
  })

  it('egress goes to openrouter.ai only', async () => {
    const f = scriptedFetch((s) =>
      s.model === M1 ? reply('429 with neither marker is BUSY') : GOOD,
    )
    await createRouter(config([OPENROUTER]), deps(f.fetchImpl)).run(REQ)
    expect(f.sent.length).toBeGreaterThan(0)
    expect(new Set(f.sent.map((s) => s.host))).toEqual(new Set([hostOf.openrouter]))
  })
})

describe('router: OpenRouter classification (§5.1, H.5)', () => {
  it.each([
    '404 data policy is FLAG_REJECTED, before RETIRED',
    '400 naming max_price is FLAG_REJECTED',
  ])('%s: releases the unit, moves to the next route and sets the provider bit', async (name) => {
    const f = scriptedFetch((s) => (s.host === hostOf.openrouter ? reply(name) : GOOD))
    const cap = countingCap()
    const d = deps(f.fetchImpl, { now: at(NOON), ownCap: cap })
    const router = createRouter(config([OPENROUTER, GROQ]), d)
    expect((await router.run(REQ)).ok).toBe(true)
    expect(f.sent.map((s) => s.host)).toEqual([hostOf.openrouter, hostOf.groq])
    expect(cap.released).toEqual(['openrouter'])
    expect(providerRecord(d.routeState.snapshot(), 'openrouter').flagModel).toBe(M1)
    expect(ofType(d.events, 'RETIRED')).toEqual([])
    expect(ofType(d.events, 'PROVIDER_DISABLED')).toEqual([])
    // The bit holds the whole provider: the next call goes straight to Groq.
    await router.run(REQ)
    expect(f.sent.map((s) => s.host)).toEqual([hostOf.openrouter, hostOf.groq, hostOf.groq])
  })

  it('a persisted FLAG_REJECTED bit is not limit-blocked, and holds on the next day', async () => {
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, {
      now: at(NEXT_NOON),
      routeState: createMemoryRouteStatePort(markFlagRejected('openrouter', M1)(EMPTY_ROUTE_STATE)),
    })
    const r = await createRouter(config([OPENROUTER]), d).run(REQ)
    expect(f.sent).toEqual([])
    expect(r).not.toEqual({ ok: false, code: 'LIMITS_EXHAUSTED' })
    expect(ofType(d.events, 'EXHAUSTED')).toEqual([
      { type: 'EXHAUSTED', reasons: [{ route: 'openrouter', code: 'FLAG_REJECTED' }] },
    ])
  })

  it('free-models-per-day spends the whole provider: the second model is never tried', async () => {
    const f = scriptedFetch((s) =>
      s.host === hostOf.openrouter ? reply('429 free-models-per-day is SPENT_DAY') : GOOD,
    )
    const d = deps(f.fetchImpl, { now: at(NOON) })
    const router = createRouter(config([OPENROUTER, GROQ]), d)
    expect((await router.run(REQ)).ok).toBe(true)
    expect(f.sent.map((s) => `${s.host} ${s.model}`)).toEqual([
      `${hostOf.openrouter} ${M1}`,
      `${hostOf.groq} ${GROQ.models[0]}`,
    ])
    expect(providerRecord(d.routeState.snapshot(), 'openrouter').spentDay).toBe(
      providerDay('openrouter', NOON),
    )
    await router.run(REQ)
    expect(f.sent.filter((s) => s.host === hostOf.openrouter)).toHaveLength(1)
  })

  it('a spent provider takes requests again on the next provider day', async () => {
    const f = scriptedFetch((_s, n) =>
      n === 0 ? reply('429 free-models-per-day is SPENT_DAY') : GOOD,
    )
    const clock = { ms: NOON }
    const d = deps(f.fetchImpl, { now: () => clock.ms })
    const router = createRouter(config([OPENROUTER]), d)
    await router.run(REQ)
    clock.ms = NEXT_NOON
    expect((await router.run(REQ)).ok).toBe(true)
    expect(f.sent.map((s) => s.model)).toEqual([M1, M1])
  })

  it('free-models-per-min is BUSY: a retry after the pause, then the route cools and the next one answers', async () => {
    const f = scriptedFetch((s) =>
      s.model === M1 ? reply('429 free-models-per-min is BUSY with retry-after') : GOOD,
    )
    const d = deps(f.fetchImpl, { now: at(NOON) })
    expect((await createRouter(config([OPENROUTER, GROQ]), d).run(REQ)).ok).toBe(true)
    // A 429 cools every OpenRouter model, so the sibling `:free` model is not asked.
    expect(f.sent.map((s) => s.model)).toEqual([M1, M1, 'openai/gpt-oss-120b'])
    expect(providerRecord(d.routeState.snapshot(), 'openrouter').spentDay).toBeUndefined()
  })

  it.each(['402 insufficient credits', '403 key limit is CREDIT'])(
    '%s: disables the provider until a proof probe, past the day turn',
    async (name) => {
      const f = scriptedFetch((s) => (s.host === hostOf.openrouter ? reply(name) : GOOD))
      const clock = { ms: NOON }
      const d = deps(f.fetchImpl, { now: () => clock.ms })
      const router = createRouter(config([OPENROUTER, GROQ]), d)
      await router.run(REQ)
      expect(ofType(d.events, 'PROVIDER_DISABLED')).toEqual([
        { type: 'PROVIDER_DISABLED', route: 'openrouter', code: 'CREDIT' },
      ])
      clock.ms = NEXT_NOON
      await router.run(REQ)
      expect(f.sent.filter((s) => s.host === hostOf.openrouter)).toHaveLength(1)
    },
  )

  it('a Groq CREDIT bit still lapses with its day: only OpenRouter waits for a proof', async () => {
    const f = scriptedFetch(() => GOOD)
    const state = markCredit('groq', providerDay('groq', NOON))(EMPTY_ROUTE_STATE)
    const d = deps(f.fetchImpl, {
      now: at(NEXT_NOON),
      routeState: createMemoryRouteStatePort(state),
    })
    expect((await createRouter(config([GROQ]), d).run(REQ)).ok).toBe(true)
  })

  it('401 disables the provider as AUTH', async () => {
    const f = scriptedFetch((s) =>
      s.host === hostOf.openrouter ? reply('401 key missing or invalid') : GOOD,
    )
    const d = deps(f.fetchImpl, { now: at(NOON) })
    await createRouter(config([OPENROUTER, GROQ]), d).run(REQ)
    expect(ofType(d.events, 'PROVIDER_DISABLED')).toEqual([
      { type: 'PROVIDER_DISABLED', route: 'openrouter', code: 'AUTH' },
    ])
  })
})
