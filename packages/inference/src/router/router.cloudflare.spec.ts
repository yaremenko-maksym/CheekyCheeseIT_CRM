import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARE,
  CLOUDFLARE_ACCOUNT_ID,
  config,
  deps,
  GOOD,
  GROQ,
  hostOf,
  KEY_MARKER,
  REQ,
  scriptedFetch,
  TEXT_MARKER,
  type Reply,
} from './__test-helpers__/router-harness'
import { CLOUDFLARE_FIXTURES } from '../internal/__fixtures__/cloudflare.fixtures'
import type { ProviderFixture } from '../internal/__fixtures__/provider-fixture'
import { createRouter, type RouterEvent } from './router'
import {
  createMemoryRouteStatePort,
  createOwnCapPort,
  isRetired,
  isSpent,
  providerDay,
} from './state'

const NOON = Date.parse('2026-11-04T12:00:00Z')
const MISTRAL = '@cf/mistralai/mistral-small-3.1-24b-instruct'
const OSS = '@cf/openai/gpt-oss-20b'
const CF_HOST = 'api.cloudflare.com'
const at = (ms: number) => () => ms
const reply = (name: string): Reply => {
  const fx = CLOUDFLARE_FIXTURES.find((f) => f.name === name) as ProviderFixture
  return {
    status: fx.status,
    body: fx.body,
    ...(fx.headers !== undefined && { headers: fx.headers }),
  }
}
const ofType = <K extends RouterEvent['type']>(events: RouterEvent[], type: K) =>
  events.filter((e): e is Extract<RouterEvent, { type: K }> => e.type === type)
const route = () => createMemoryRouteStatePort()

describe('router: the Cloudflare route (amendment 2026-11-17)', () => {
  it('sends the first pinned model to the account chat endpoint, the key only in the header', async () => {
    const f = scriptedFetch(() => GOOD)
    const r = await createRouter(config([CLOUDFLARE]), deps(f.fetchImpl)).run(REQ)
    expect(r.ok).toBe(true)
    expect(f.sent).toHaveLength(1)
    expect(f.sent[0]!.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`,
    )
    expect(f.sent[0]!.model).toBe(MISTRAL)
    expect(f.sent[0]!.headers.Authorization).toBe(`Bearer ${KEY_MARKER}`)
  })

  it.each([
    '410 model deprecated (5028) in the v4 envelope',
    '410 model deprecated, the verified live body (2026-11-17)',
    '404 with an OpenAI-shaped error naming the model',
  ])('%s: retires the model and moves to the next one in the same call', async (name) => {
    const f = scriptedFetch((s) => (s.model === MISTRAL ? reply(name) : GOOD))
    const d = deps(f.fetchImpl, { routeState: route(), now: at(NOON) })
    const router = createRouter(config([CLOUDFLARE]), d)
    expect((await router.run(REQ)).ok).toBe(true)
    await router.run(REQ)
    expect(f.sent.map((s) => `${s.host} ${s.model}`)).toEqual([
      `${CF_HOST} ${MISTRAL}`,
      `${CF_HOST} ${OSS}`,
      `${CF_HOST} ${OSS}`,
    ])
    expect(ofType(d.events, 'RETIRED')).toEqual([
      { type: 'RETIRED', route: 'cloudflare', model: MISTRAL },
    ])
    expect(isRetired(d.routeState.snapshot(), 'cloudflare', MISTRAL)).toBe(true)
  })

  it.each([
    '404 invalid model id (3042) does not name the model: a wrong URL',
    '410 with a plain-text body (no v4 envelope, defensive) is TRANSPORT: no code 5028',
    '410 with no body is TRANSPORT',
  ])('%s: retires nothing, the next route', async (name) => {
    const f = scriptedFetch((s) => (s.host === CF_HOST ? reply(name) : GOOD))
    const d = deps(f.fetchImpl, { routeState: route() })
    await createRouter(config([CLOUDFLARE, GROQ]), d).run(REQ)
    expect(f.sent.map((s) => s.host)).toEqual([CF_HOST, hostOf.groq])
    expect(d.routeState.snapshot().retired).toEqual([])
  })

  it('the verified live 401 body disables the provider once and moves to the next route', async () => {
    const f = scriptedFetch((s) =>
      s.host === CF_HOST ? reply('401 invalid bearer, the verified live body (2026-11-17)') : GOOD,
    )
    const d = deps(f.fetchImpl, { routeState: route() })
    const router = createRouter(config([CLOUDFLARE, GROQ]), d)
    await router.run(REQ)
    await router.run(REQ)
    expect(f.sent.map((s) => s.host)).toEqual([CF_HOST, hostOf.groq, hostOf.groq])
    expect(ofType(d.events, 'PROVIDER_DISABLED')).toEqual([
      { type: 'PROVIDER_DISABLED', route: 'cloudflare', code: 'AUTH' },
    ])
  })

  it('a used daily allocation (3036) spends the model for the UTC day', async () => {
    const f = scriptedFetch((s) =>
      s.model === MISTRAL ? reply('429 daily free allocation used (3036)') : GOOD,
    )
    const d = deps(f.fetchImpl, { routeState: route(), now: at(NOON) })
    await createRouter(config([CLOUDFLARE]), d).run(REQ)
    expect(isSpent(d.routeState.snapshot(), 'cloudflare', MISTRAL, '2026-11-04')).toBe(true)
    expect(f.sent.map((s) => s.model)).toEqual([MISTRAL, OSS])
  })

  it('the day resets at 00:00 UTC', () => {
    expect(providerDay('cloudflare', Date.parse('2026-11-04T23:59:59Z'))).toBe('2026-11-04')
    expect(providerDay('cloudflare', Date.parse('2026-11-05T00:00:00Z'))).toBe('2026-11-05')
  })

  it('the own cap is 50 % of the request count mapped from the Neurons day', async () => {
    const routeState = route()
    const ownCap = createOwnCapPort({ state: routeState, now: at(NOON) })
    const f = scriptedFetch(() => GOOD)
    const router = createRouter(
      config([CLOUDFLARE]),
      deps(f.fetchImpl, { routeState, ownCap, now: at(NOON) }),
    )
    const results = []
    for (let i = 0; i < 10; i++) results.push(await router.run(REQ))
    expect(f.sent.filter((s) => s.host === CF_HOST)).toHaveLength(8)
    expect(f.sent).toHaveLength(8)
    // H.1: no floor behind the cap; the refused runs end with today's code.
    expect(results.slice(8)).toEqual([
      { ok: false, code: 'PROVIDER_ERROR' },
      { ok: false, code: 'PROVIDER_ERROR' },
    ])
  })

  it('neither the account id, the key nor the text reaches an event or a result', async () => {
    const f = scriptedFetch((s) =>
      s.model === MISTRAL ? reply('410 model deprecated (5028) in the v4 envelope') : GOOD,
    )
    const d = deps(f.fetchImpl, { routeState: route() })
    const r = await createRouter(config([CLOUDFLARE]), d).run(REQ)
    const seen = JSON.stringify({ r, events: d.events })
    for (const marker of [CLOUDFLARE_ACCOUNT_ID, KEY_MARKER, TEXT_MARKER]) {
      expect(seen).not.toContain(marker)
    }
  })
})
