import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createStrictSchema } from '../internal/strict-schema'
import {
  ALIVE,
  G1,
  G2,
  geminiListing,
  groqListing,
  limitedCap,
  managedDoc,
  NEW,
  NOON,
  Q1,
  Q2,
  refreshWorld,
} from './__test-helpers__/refresh-world'
import {
  config,
  countingCap,
  deps as routerDeps,
  GEMINI,
  GOOD,
  GROQ,
  hostOf,
  KEY_MARKER,
  LOCAL,
  REQ,
  scriptedFetch,
  type Reply,
  type Sent,
} from './__test-helpers__/router-harness'
import { HOSTED_BASE_URLS, type HostedRouteConfig, type RouterConfig } from './config'
import {
  MODEL_PROBE_PROMPT,
  probeAll,
  PROBE_CAP,
  PROBE_MAX_TOKENS,
  PROBE_PAUSE_MS,
  runDailyModelRefresh,
  runModelChainCheck,
  runStartupModelRefresh,
  STARTUP_REFRESH_MIN_GAP_MS,
} from './model-refresh'
import { createRouter } from './router'
import {
  EMPTY_ROUTE_STATE,
  markAuth,
  markRetired,
  markSpent,
  markStartupRefresh,
  providerDay,
  setJobFailed,
  setStaleModels,
  type RouteStatePort,
} from './state'

const BIG = 1_000_000
const GEMINI_ONLY = [GEMINI, LOCAL]
const GROQ_ONLY = [GROQ, LOCAL]
const PROBE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'extraction',
    strict: true,
    schema: createStrictSchema(z.object({ ok: z.boolean() })).jsonSchema,
  },
}
const probeBody = (model: string, format: object | null = PROBE_FORMAT) => ({
  model,
  messages: [
    { role: 'system', content: MODEL_PROBE_PROMPT },
    { role: 'user', content: MODEL_PROBE_PROMPT },
  ],
  temperature: 0.1,
  max_tokens: PROBE_MAX_TOKENS,
  ...(format !== null && { response_format: format }),
})
const ids = (n: number, from = 4) =>
  Array.from({ length: n }, (_, i) => `gemini-${i + from}.0-flash`)
const stateText = (w: ReturnType<typeof refreshWorld>) => JSON.stringify(w.state.snapshot())

describe('probe hygiene: refresh and chain check alike (SR-M-3)', () => {
  it.each([
    ['the daily refresh', runDailyModelRefresh],
    ['the chain check', runModelChainCheck],
  ])('%s sends only the fixed probe', async (_label, job) => {
    const w = refreshWorld({ routes: GEMINI_ONLY })
    await job(w.deps)
    expect(w.chats().map((s) => s.body)).toEqual([probeBody(G1), probeBody(G2)])
  })

  it('the fixed schema only allows the fixed answer', () => {
    expect(PROBE_FORMAT.json_schema.schema).toMatchObject({
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    })
    expect(MODEL_PROBE_PROMPT).toBe('Reply only with the JSON {"ok":true}.')
    expect(PROBE_MAX_TOKENS).toBe(16)
  })

  it.each([
    ['json_object', { type: 'json_object' }],
    ['none', null],
  ])('a route with %s structured output keeps its own mode', async (mode, format) => {
    const w = refreshWorld({
      routes: [{ ...GEMINI, models: [G1], structuredOutput: mode }, LOCAL],
      listing: { gemini: geminiListing([[G1, BIG]]) },
    })
    await runDailyModelRefresh(w.deps)
    expect(w.chats().map((s) => s.body)).toEqual([probeBody(G1, format)])
  })

  it('a probe goes to the hosted endpoint with the keyed header', async () => {
    const w = refreshWorld({ routes: GEMINI_ONLY })
    await runDailyModelRefresh(w.deps)
    const [probe] = w.chats()
    expect(probe?.url).toBe(`${HOSTED_BASE_URLS.gemini}chat/completions`)
    expect(probe?.headers['Authorization'] ?? probe?.headers['authorization']).toBe(
      `Bearer ${KEY_MARKER}`,
    )
  })

  it('no provider gets more than PROBE_CAP probes in a sweep, with a pause between each', async () => {
    const many = ids(10)
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      listing: { gemini: geminiListing([G1, G2, ...many].map((id) => [id, BIG] as const)) },
    })
    await runDailyModelRefresh(w.deps)
    expect(w.chats()).toHaveLength(PROBE_CAP)
    expect(w.sleeps).toEqual(Array.from({ length: PROBE_CAP - 1 }, () => PROBE_PAUSE_MS))
    expect(PROBE_CAP).toBe(6)
    expect(PROBE_PAUSE_MS).toBe(6_000)
  })

  it('probes current models first, then candidates by the largest effective context', async () => {
    const [SMALL, LARGE] = ids(2)
    const w = refreshWorld({
      routes: [{ ...GEMINI, models: [G1], contextTokens: 100_000 }, LOCAL],
      listing: {
        gemini: geminiListing([
          [G1, BIG],
          [SMALL!, 50_000],
          [LARGE!, 90_000],
        ]),
      },
    })
    await runDailyModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([G1, LARGE, SMALL])
    expect(w.fileList('gemini')).toEqual([G1, LARGE, SMALL])
  })

  it('the daily job sends Groq no chat request, only its listing', async () => {
    const w = refreshWorld({ routes: GROQ_ONLY })
    await runDailyModelRefresh(w.deps)
    expect(w.sent.map((s) => s.host)).toEqual([hostOf.groq])
    expect(w.chats()).toEqual([])
    expect(w.sleeps).toEqual([])
  })

  it('never contacts the local route, in any job', async () => {
    const auth = markAuth('gemini')(EMPTY_ROUTE_STATE)
    const w = refreshWorld({ state: auth })
    await runDailyModelRefresh(w.deps)
    await runModelChainCheck(w.deps)
    w.clock.ms += STARTUP_REFRESH_MIN_GAP_MS
    await runStartupModelRefresh(w.deps)
    expect(w.sent.length).toBeGreaterThan(0)
    expect(w.sent.map((s) => s.host)).not.toContain(hostOf.local)
  })

  it.each([
    ['the daily refresh', runDailyModelRefresh],
    ['the chain check', runModelChainCheck],
  ])('%s sends nothing for a provider with no route or no key', async (_label, job) => {
    const w = refreshWorld({ routes: [LOCAL] })
    const r = await job(w.deps)
    expect(w.sent).toEqual([])
    expect(r.providers.map((p) => p.outcome)).toEqual(['skipped', 'skipped'])
  })

  it('a provider outside the allowlist is never reached, whatever the config says', async () => {
    const w = refreshWorld({ routes: GROQ_ONLY })
    const foreign = { ...w.deps.config.routes[0]!, provider: 'openrouter' }
    w.deps.config = {
      ...w.deps.config,
      routes: [foreign as unknown as RouterConfig['routes'][number]],
    }
    const r = await runDailyModelRefresh(w.deps)
    expect(w.sent).toEqual([])
    expect(r.providers.map((p) => p.provider)).toEqual(['gemini', 'groq'])
  })

  it('a cap refusal skips the provider with no request, and the chain check too', async () => {
    const w = refreshWorld({ cap: countingCap(false) })
    const daily = await runDailyModelRefresh(w.deps)
    const chain = await runModelChainCheck(w.deps)
    expect(w.sent).toEqual([])
    for (const r of [daily, chain]) {
      expect(r.ok).toBe(true)
      expect(r.providers.map((p) => p.outcome)).toEqual(['skipped', 'skipped'])
    }
  })
})

describe('one builder (SR-M-3)', () => {
  async function production(routes: unknown[]): Promise<Sent> {
    const fake = scriptedFetch(() => GOOD)
    await createRouter(config(routes), routerDeps(fake.fetchImpl)).run(REQ)
    return fake.sent[0]!
  }
  async function probe(routes: unknown[]): Promise<Sent> {
    const w = refreshWorld({ routes })
    await runDailyModelRefresh(w.deps)
    return w.chats()[0]!
  }
  const without = (s: Sent, ...keys: string[]) =>
    Object.fromEntries(Object.entries(s.body).filter(([k]) => !keys.includes(k)))
  const roles = (s: Sent) =>
    (s.body['messages'] as { role: string }[]).map((message) => message.role)

  it.each([
    ['json_object', { ...GEMINI, structuredOutput: 'json_object' }],
    ['none', { ...GEMINI, structuredOutput: 'none' }],
  ])('with %s every field matches but prompt and max_tokens', async (_mode, route) => {
    const routes = [route, LOCAL]
    const [real, fixed] = [await production(routes), await probe(routes)]
    expect(without(fixed, 'messages', 'max_tokens')).toEqual(
      without(real, 'messages', 'max_tokens'),
    )
    expect(roles(fixed)).toEqual(roles(real))
    expect(fixed.url).toBe(real.url)
    expect(fixed.headers).toEqual(real.headers)
    expect(fixed.body['max_tokens']).toBeLessThan(real.body['max_tokens'] as number)
  })

  it('with json_schema only the prompt, the schema and max_tokens differ', async () => {
    const routes = [GEMINI, LOCAL]
    const [real, fixed] = [await production(routes), await probe(routes)]
    expect(without(fixed, 'messages', 'max_tokens', 'response_format')).toEqual(
      without(real, 'messages', 'max_tokens', 'response_format'),
    )
    const format = (s: Sent) => {
      const f = s.body['response_format'] as { json_schema: { schema: unknown } }
      return { ...f, json_schema: { ...f.json_schema, schema: 'schema' } }
    }
    expect(format(fixed)).toEqual(format(real))
    expect(roles(fixed)).toEqual(roles(real))
    expect(fixed.url).toBe(real.url)
    expect(fixed.headers).toEqual(real.headers)
  })
})

describe('hostile ids from a listing never get anywhere (SR-M-3)', () => {
  const HOSTILE = [
    '../../etc/passwd',
    'models/../secret',
    'https://evil.example/x',
    'gemini-2.5-flash\nX-Injected: 1',
    'gemini 2.5 flash',
    'gemini-2.5-flash\u0000',
    'gemini-2.5-фlash',
    '/gemini-2.5-flash',
    'gemini-2.5-flash:one:two',
    `gemini-2.5-${'a'.repeat(300)}`,
  ]
  const raw = (s: string) => JSON.stringify(s).slice(1, -1)

  it.each([
    ['gemini', 'daily', runDailyModelRefresh],
    ['groq', 'daily', runDailyModelRefresh],
  ] as const)('%s %s: dropped and counted, never probed, stored or logged', async (p, _j, job) => {
    const w = refreshWorld({
      listing:
        p === 'gemini'
          ? {
              gemini: geminiListing([[G1, BIG], ...HOSTILE.map((id) => [id, BIG] as const)]),
            }
          : {
              groq: groqListing([[Q1, 131_072], ...HOSTILE.map((id) => [id, 262_144] as const)]),
            },
    })
    await job(w.deps)
    expect(w.ofType('MODEL_IDS_DROPPED')).toEqual([
      { type: 'MODEL_IDS_DROPPED', provider: p, dropped: HOSTILE.length, beyondCap: 0 },
    ])
    const seen = [
      JSON.stringify(w.sent),
      w.fileText() ?? '',
      JSON.stringify(w.events),
      JSON.stringify(w.storeEvents),
      stateText(w),
    ].join('\n')
    for (const id of HOSTILE) expect(seen).not.toContain(raw(id))
    expect(seen).not.toContain('evil.example')
    expect(seen).not.toContain('X-Injected')
    expect(seen).not.toContain('passwd')
  })

  it('reports nothing when nothing was dropped', async () => {
    const w = refreshWorld()
    await runDailyModelRefresh(w.deps)
    expect(w.ofType('MODEL_IDS_DROPPED')).toEqual([])
  })

  it('reports ids beyond the listing cap on their own', async () => {
    const over = Array.from({ length: 201 }, (_, i) => [`gemini-${i + 4}.0-flash`, BIG] as const)
    const w = refreshWorld({ routes: GEMINI_ONLY, listing: { gemini: geminiListing(over) } })
    await runDailyModelRefresh(w.deps)
    expect(w.ofType('MODEL_IDS_DROPPED')).toEqual([
      { type: 'MODEL_IDS_DROPPED', provider: 'gemini', dropped: 0, beyondCap: 1 },
    ])
  })
})

describe('probeAll', () => {
  it('an empty sweep answers nothing', async () => {
    const w = refreshWorld({ routes: GEMINI_ONLY })
    expect(await probeAll(GEMINI as HostedRouteConfig, [], w.deps)).toEqual({
      answers: [],
      stopped: null,
    })
    expect(w.sent).toEqual([])
  })
})

describe('the AUTH bit (§3.2)', () => {
  it('a daily 2xx probe clears a persisted AUTH of that provider only', async () => {
    const both = markAuth('gemini')(markAuth('groq')(EMPTY_ROUTE_STATE))
    const w = refreshWorld({ state: both })
    await runDailyModelRefresh(w.deps)
    const auth = (p: string) => w.state.snapshot().providers.find((r) => r.provider === p)?.auth
    expect(auth('gemini')).toBe(false)
    expect(auth('groq')).toBe(true)
  })

  it('touches no record when no AUTH is persisted', async () => {
    const w = refreshWorld()
    await runDailyModelRefresh(w.deps)
    expect(w.state.snapshot().providers).toEqual([])
  })

  it.each<[string, Reply]>([
    ['500', { status: 500, body: 'x' }],
    ['404', { status: 404, body: 'x' }],
    ['429', { status: 429, body: 'x' }],
    ['no response', 'network'],
    ['401', { status: 401, body: 'x' }],
  ])('a %s does not clear it', async (_label, reply) => {
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      state: markAuth('gemini')(EMPTY_ROUTE_STATE),
      chat: () => reply,
    })
    await runDailyModelRefresh(w.deps)
    expect(w.state.snapshot().providers[0]?.auth).toBe(true)
  })
})

describe('the weekly chain check (§3.4 layer 3)', () => {
  const NOT_FOUND: Reply = { status: 404, body: 'x' }
  const managed = managedDoc({ gemini: [G1, G2], groq: [Q1, Q2] })

  it('probes each model in use once, Groq too, with no listing and no edit', async () => {
    const w = refreshWorld({ managed })
    const r = await runModelChainCheck(w.deps)
    expect(r).toEqual({
      ok: true,
      providers: [
        { provider: 'gemini', outcome: 'done' },
        { provider: 'groq', outcome: 'done' },
      ],
    })
    expect(w.sent.map((s) => s.model)).toEqual([G1, G2, Q1, Q2])
    expect(w.fileText()).toBe(managed)
    expect(w.fs.calls.filter((c) => c.startsWith('rename '))).toEqual([])
    expect(w.sleeps).toEqual([PROBE_PAUSE_MS, PROBE_PAUSE_MS])
  })

  it('earns no streak, keeps no busy day and clears no retirement', async () => {
    const retired = markRetired('gemini', G1, NOON)(EMPTY_ROUTE_STATE)
    const w = refreshWorld({ state: retired, routes: GEMINI_ONLY })
    await runModelChainCheck(w.deps)
    expect(w.state.snapshot().probation).toBeUndefined()
    expect(w.state.snapshot().busy).toBeUndefined()
    expect(w.state.snapshot().retired).toEqual(retired.retired)
  })

  it('never probes more than PROBE_CAP models', async () => {
    const w = refreshWorld({ routes: GEMINI_ONLY })
    w.deps.managedModels = async () => ids(PROBE_CAP + 2)
    await runModelChainCheck(w.deps)
    expect(w.chats()).toHaveLength(PROBE_CAP)
  })

  it('a dead model raises MODEL_LIST_STALE durably, naming only the dead', async () => {
    const w = refreshWorld({
      managed,
      chat: (s) => (s.model === G2 ? NOT_FOUND : ALIVE),
    })
    await runModelChainCheck(w.deps)
    expect(w.ofType('MODEL_LIST_STALE')).toEqual([
      { type: 'MODEL_LIST_STALE', provider: 'gemini', models: [G2] },
    ])
    expect(w.state.snapshot().modelListStale).toEqual([{ provider: 'gemini', model: G2 }])
    expect(w.fileText()).toBe(managed)
  })

  it.each<[string, Reply]>([
    ['a 503', { status: 503, body: 'x' }],
    ['a 429', { status: 429, body: 'x' }],
    ['a 500', { status: 500, body: 'x' }],
    ['no response', 'network'],
  ])('%s is not dead', async (_label, reply) => {
    const w = refreshWorld({ routes: GEMINI_ONLY, chat: () => reply })
    const r = await runModelChainCheck(w.deps)
    expect(w.ofType('MODEL_LIST_STALE')).toEqual([])
    expect(w.state.snapshot().modelListStale).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('a finished run replaces the warning, and leaves the other provider alone', async () => {
    const stale = setStaleModels('groq', [Q1])(setStaleModels('gemini', [G1])(EMPTY_ROUTE_STATE))
    const w = refreshWorld({ routes: GEMINI_ONLY, state: stale })
    await runModelChainCheck(w.deps)
    expect(w.state.snapshot().modelListStale).toEqual([{ provider: 'groq', model: Q1 }])
  })

  it('a run the cap cut short only adds: a model it never reached is not proven alive', async () => {
    const stale = setStaleModels('gemini', [G2])(EMPTY_ROUTE_STATE)
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      state: stale,
      cap: limitedCap(1),
      chat: () => NOT_FOUND,
    })
    const r = await runModelChainCheck(w.deps)
    expect(w.chatModels()).toEqual([G1])
    expect(r.providers[0]).toEqual({ provider: 'gemini', outcome: 'skipped', reason: 'CAP' })
    expect(w.state.snapshot().modelListStale).toEqual([
      { provider: 'gemini', model: G2 },
      { provider: 'gemini', model: G1 },
    ])
  })

  it('AUTH stops the sweep, fails the provider and keeps the warning', async () => {
    const stale = setStaleModels('gemini', [G2])(EMPTY_ROUTE_STATE)
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      state: stale,
      chat: () => ({ status: 401, body: 'x' }),
    })
    const r = await runModelChainCheck(w.deps)
    expect(w.chatModels()).toEqual([G1])
    expect(r.providers[0]).toEqual({ provider: 'gemini', outcome: 'failed', reason: 'AUTH' })
    expect(w.state.snapshot().modelListStale).toEqual([{ provider: 'gemini', model: G2 }])
    expect(w.state.snapshot().failedJobs).toEqual(['chain'])
    expect(w.ofType('MODEL_REFRESH_FAILED')).toEqual([
      { type: 'MODEL_REFRESH_FAILED', job: 'chain' },
    ])
  })

  it('a clean run clears only its own durable failure', async () => {
    const failed = setJobFailed('daily', true)(setJobFailed('chain', true)(EMPTY_ROUTE_STATE))
    const w = refreshWorld({ routes: GEMINI_ONLY, state: failed })
    await runModelChainCheck(w.deps)
    expect(w.state.snapshot().failedJobs).toEqual(['daily'])
    expect(w.ofType('MODEL_REFRESH_PROVIDER')[0]).toEqual({
      type: 'MODEL_REFRESH_PROVIDER',
      job: 'chain',
      provider: 'gemini',
      outcome: 'done',
    })
  })

  it('an exception in one provider fails it and the next still runs', async () => {
    const w = refreshWorld()
    const read = w.deps.managedModels
    w.deps.managedModels = async (p, fallback) => {
      if (p === 'gemini') throw new Error('boom')
      return read(p, fallback)
    }
    const r = await runModelChainCheck(w.deps)
    expect(r.providers).toEqual([
      { provider: 'gemini', outcome: 'failed', reason: 'INTERNAL' },
      { provider: 'groq', outcome: 'done' },
    ])
  })
})

describe('the start-up refresh, the clearing proof (SR-M-7, SR-M-11)', () => {
  const FAIL_500: Reply = { status: 500, body: 'x' }
  const authOn = (...providers: ('gemini' | 'groq')[]) =>
    providers.reduce((s, p) => markAuth(p)(s), EMPTY_ROUTE_STATE)
  const authOf = (w: ReturnType<typeof refreshWorld>, p: string) =>
    w.state.snapshot().providers.find((r) => r.provider === p)?.auth

  it('a persisted AUTH gets a refresh with exactly one chat probe, and a 2xx clears it', async () => {
    const w = refreshWorld({ routes: GEMINI_ONLY, state: authOn('gemini') })
    const r = await runStartupModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([G1])
    expect(w.sent).toHaveLength(2)
    expect(authOf(w, 'gemini')).toBe(false)
    expect(r.providers[0]).toEqual({ provider: 'gemini', outcome: 'done' })
    expect(w.fileList('gemini')).toEqual([G1, G2])
    expect(w.sleeps).toEqual([])
  })

  it('Groq gets its one chat probe too, though its daily job sends none', async () => {
    const w = refreshWorld({ routes: GROQ_ONLY, state: authOn('groq') })
    await runStartupModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([Q1])
    expect(authOf(w, 'groq')).toBe(false)
  })

  describe('every model already spent or used still leaves the one proof (SPEC-L-3)', () => {
    it('a Groq model with an OK call takes the proof, and no candidate is added', async () => {
      const w = refreshWorld({
        routes: [{ ...GROQ, models: [Q1] }, LOCAL],
        state: authOn('groq'),
        hadOkCall: (_p, m) => m === Q1,
      })
      await runStartupModelRefresh(w.deps)
      expect(w.chatModels()).toEqual([Q1])
      expect(authOf(w, 'groq')).toBe(false)
    })

    it('a Gemini list used in full sends one proof to its first model', async () => {
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        state: authOn('gemini'),
        hadOkCall: () => true,
      })
      await runStartupModelRefresh(w.deps)
      expect(w.chatModels()).toEqual([G1])
      expect(authOf(w, 'gemini')).toBe(false)
    })

    it('a Gemini list spent in full sends one proof to its first model', async () => {
      const spent = markSpent(
        'gemini',
        G2,
        providerDay('gemini', NOON),
      )(markSpent('gemini', G1, providerDay('gemini', NOON))(authOn('gemini')))
      const w = refreshWorld({ routes: GEMINI_ONLY, state: spent })
      await runStartupModelRefresh(w.deps)
      expect(w.chatModels()).toEqual([G1])
      expect(authOf(w, 'gemini')).toBe(false)
    })

    it('a spent first model hands the proof to the next eligible one', async () => {
      const spent = markSpent('gemini', G1, providerDay('gemini', NOON))(authOn('gemini'))
      const w = refreshWorld({ routes: GEMINI_ONLY, state: spent })
      await runStartupModelRefresh(w.deps)
      expect(w.chatModels()).toEqual([G2])
      expect(authOf(w, 'gemini')).toBe(false)
    })

    it('the daily job on a list used in full sends no probe at all', async () => {
      const w = refreshWorld({ routes: GEMINI_ONLY, hadOkCall: () => true })
      await runDailyModelRefresh(w.deps)
      expect(w.chats()).toEqual([])
    })
  })

  it('a successful listing alone leaves the bit set', async () => {
    const w = refreshWorld({ routes: GEMINI_ONLY, state: authOn('gemini'), chat: () => FAIL_500 })
    const r = await runStartupModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([G1])
    expect(authOf(w, 'gemini')).toBe(true)
    expect(r.providers[0]?.outcome).toBe('done')
  })

  it('a failed listing sends no probe and leaves the bit set', async () => {
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      state: authOn('gemini'),
      listing: { gemini: FAIL_500 },
    })
    const r = await runStartupModelRefresh(w.deps)
    expect(w.chats()).toEqual([])
    expect(authOf(w, 'gemini')).toBe(true)
    expect(r.ok).toBe(false)
    expect(w.ofType('MODEL_REFRESH_FAILED')).toEqual([
      { type: 'MODEL_REFRESH_FAILED', job: 'startup' },
    ])
  })

  it('a provider without AUTH sends nothing', async () => {
    const w = refreshWorld()
    const r = await runStartupModelRefresh(w.deps)
    expect(w.sent).toEqual([])
    expect(r).toEqual({
      ok: true,
      providers: [
        { provider: 'gemini', outcome: 'skipped', reason: 'NOT_NEEDED' },
        { provider: 'groq', outcome: 'skipped', reason: 'NOT_NEEDED' },
      ],
    })
    expect(w.state.snapshot().providers).toEqual([])
  })

  it('only the provider with the bit is refreshed', async () => {
    const w = refreshWorld({ state: authOn('groq') })
    await runStartupModelRefresh(w.deps)
    expect(new Set(w.sent.map((s) => s.host))).toEqual(new Set([hostOf.groq]))
  })

  it('stamps the attempt durably before the first request', async () => {
    const w = refreshWorld({ routes: GEMINI_ONLY, state: authOn('gemini') })
    const fetchImpl = w.deps.fetchImpl!
    const stamps: (string | undefined)[] = []
    w.deps.fetchImpl = (url, init) => {
      stamps.push(w.state.snapshot().providers[0]?.lastStartupRefreshAt)
      return fetchImpl(url, init)
    }
    await runStartupModelRefresh(w.deps)
    expect(stamps[0]).toBe(new Date(NOON).toISOString())
  })

  it('a stamp that cannot be stored sends no request', async () => {
    const w = refreshWorld({ routes: GEMINI_ONLY, state: authOn('gemini') })
    const refusing: RouteStatePort = { snapshot: w.state.snapshot, update: async () => false }
    const r = await runStartupModelRefresh({ ...w.deps, state: refusing })
    expect(w.sent).toEqual([])
    expect(r.providers[0]).toEqual({ provider: 'gemini', outcome: 'skipped', reason: 'STATE' })
    expect(r.ok).toBe(true)
  })

  describe('at most once an hour', () => {
    const stamped = (ms: number) => markStartupRefresh('gemini', ms)(authOn('gemini'))
    const within = refreshWorld

    it('a second start inside the hour sends no request', async () => {
      const w = within({ routes: GEMINI_ONLY, state: authOn('gemini'), chat: () => FAIL_500 })
      await runStartupModelRefresh(w.deps)
      const sent = w.sent.length
      w.clock.ms += STARTUP_REFRESH_MIN_GAP_MS - 1
      const r = await runStartupModelRefresh(w.deps)
      expect(w.sent).toHaveLength(sent)
      expect(r.providers[0]).toEqual({ provider: 'gemini', outcome: 'skipped', reason: 'RECENT' })
      expect(STARTUP_REFRESH_MIN_GAP_MS).toBe(3_600_000)
    })

    it('exactly an hour later it runs again and moves the stamp', async () => {
      const w = within({
        routes: GEMINI_ONLY,
        state: stamped(NOON - STARTUP_REFRESH_MIN_GAP_MS),
        chat: () => FAIL_500,
      })
      await runStartupModelRefresh(w.deps)
      expect(w.chats()).toHaveLength(1)
      expect(w.state.snapshot().providers[0]?.lastStartupRefreshAt).toBe(
        new Date(NOON).toISOString(),
      )
    })

    it('a clock gone back reads as recent', async () => {
      const w = within({ routes: GEMINI_ONLY, state: stamped(NOON + 86_400_000) })
      const r = await runStartupModelRefresh(w.deps)
      expect(w.sent).toEqual([])
      expect(r.providers[0]).toEqual({ provider: 'gemini', outcome: 'skipped', reason: 'RECENT' })
    })

    it('the stamp is per provider', async () => {
      const state = markAuth('groq')(stamped(NOON - 1))
      const w = within({ state })
      const r = await runStartupModelRefresh(w.deps)
      expect(r.providers.map((p) => p.outcome)).toEqual(['skipped', 'done'])
      expect(w.chatModels()).toEqual([Q1])
    })
  })

  describe('and the durable job failure', () => {
    it('a failure marks the daily job, never the chain', async () => {
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        state: authOn('gemini'),
        listing: { gemini: FAIL_500 },
      })
      await runStartupModelRefresh(w.deps)
      expect(w.state.snapshot().failedJobs).toEqual(['daily'])
    })

    it('a success on one provider does not clear the daily failure', async () => {
      const w = refreshWorld({
        routes: GEMINI_ONLY,
        state: setJobFailed('daily', true)(authOn('gemini')),
      })
      const r = await runStartupModelRefresh(w.deps)
      expect(r.ok).toBe(true)
      expect(w.state.snapshot().failedJobs).toEqual(['daily'])
    })

    it('a clean start marks nothing', async () => {
      const w = refreshWorld({ routes: GEMINI_ONLY, state: authOn('gemini') })
      await runStartupModelRefresh(w.deps)
      expect(w.state.snapshot().failedJobs).toBeUndefined()
    })
  })

  it('AUTH on the start-up probe keeps the bit and the file', async () => {
    const managed = managedDoc({ gemini: [G1, NEW] })
    const w = refreshWorld({
      routes: GEMINI_ONLY,
      state: authOn('gemini'),
      managed,
      chat: () => ({ status: 401, body: 'x' }),
    })
    const r = await runStartupModelRefresh(w.deps)
    expect(r.providers[0]).toEqual({ provider: 'gemini', outcome: 'failed', reason: 'AUTH' })
    expect(authOf(w, 'gemini')).toBe(true)
    expect(w.fileText()).toBe(managed)
  })
})
