import { describe, expect, it } from 'vitest'
import { GROQ_FIXTURES } from '../internal/__fixtures__/groq.fixtures'
import { OPENROUTER_FIXTURES } from '../internal/__fixtures__/openrouter.fixtures'
import type { ProviderFixture } from '../internal/__fixtures__/provider-fixture'
import { ALIVE, limitedCap, NOON, O1, O2, refreshWorld } from './__test-helpers__/refresh-world'
import { countingCap, GROQ, OPENROUTER, type Reply } from './__test-helpers__/router-harness'
import type { HostedRouteConfig } from './config'
import {
  probeAll,
  runDailyModelRefresh,
  runModelChainCheck,
  runStartupModelRefresh,
} from './model-refresh'
import {
  EMPTY_ROUTE_STATE,
  markAuth,
  markCredit,
  markFlagRejected,
  markRetired,
  markSpent,
  providerBlock,
  providerDay,
  providerRecord,
  type RouteState,
} from './state'

/** The OpenRouter proof probe end to end (ADR §3.5): what a 2xx clears, what a refusal keeps out. */
const reply = (name: string): Reply => {
  const fx = OPENROUTER_FIXTURES.find((f) => f.name === name) as ProviderFixture
  return { status: fx.status, body: fx.body }
}
const today = providerDay('openrouter', NOON)
const world = (state: RouteState, chat: (model: string) => Reply = () => ALIVE) =>
  refreshWorld({ routes: [OPENROUTER], state, chat: (s) => chat(s.model) })

describe('the OpenRouter proof probe (§3.5)', () => {
  it('start-up: the flagged model is probed first, and its 2xx clears the flag', async () => {
    const w = world(markFlagRejected('openrouter', O2)(EMPTY_ROUTE_STATE))
    await runStartupModelRefresh(w.deps)
    expect(w.chatModels()[0]).toBe(O2)
    const r = providerRecord(w.state.snapshot(), 'openrouter')
    expect(r).not.toHaveProperty('flagModel')
    expect(providerBlock(w.state.snapshot(), 'openrouter', today)).toBeNull()
  })

  it('chain check: a 2xx of another model leaves the flag on the provider', async () => {
    const w = world(markFlagRejected('openrouter', O2)(EMPTY_ROUTE_STATE), (m) =>
      m === O2 ? reply('429 with neither marker is BUSY') : ALIVE,
    )
    await runModelChainCheck(w.deps)
    expect(w.chatModels()).toContain(O1)
    expect(providerRecord(w.state.snapshot(), 'openrouter').flagModel).toBe(O2)
  })

  it('daily: a CREDIT bit from an earlier day gets its one proof probe, and a 2xx clears it', async () => {
    const w = world(markCredit('openrouter', '2026-11-01')(EMPTY_ROUTE_STATE))
    await runDailyModelRefresh(w.deps)
    expect(w.chats()).toHaveLength(1)
    expect(providerRecord(w.state.snapshot(), 'openrouter')).not.toHaveProperty('creditDay')
  })

  it('daily: with no bit to prove, OpenRouter sends no chat', async () => {
    const w = world(EMPTY_ROUTE_STATE)
    await runDailyModelRefresh(w.deps)
    expect(w.chats()).toEqual([])
    expect(w.sent.length).toBeGreaterThan(0)
  })

  it('a probe refused by a routing field keeps that model off the list, and sets no provider bit', async () => {
    const w = world(markAuth('openrouter')(EMPTY_ROUTE_STATE), (m) =>
      m === O1 ? reply('404 data policy is FLAG_REJECTED, before RETIRED') : ALIVE,
    )
    await runStartupModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([O1])
    expect(w.fileList('openrouter')).toEqual([O2])
    expect(providerRecord(w.state.snapshot(), 'openrouter')).not.toHaveProperty('flagModel')
    expect(w.ofType('MODEL_PROBED')).toContainEqual({
      type: 'MODEL_PROBED',
      provider: 'openrouter',
      model: O1,
      verdict: 'dead',
    })
  })

  it('a 402 stops the sweep as CREDIT, held until a proof', async () => {
    // An old CREDIT bit asks for the proof probe; AUTH would outrank the CREDIT under test.
    const w = world(markCredit('openrouter', '2026-11-01')(EMPTY_ROUTE_STATE), () =>
      reply('402 insufficient credits'),
    )
    const result = await runStartupModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([O1])
    expect(result.providers).toContainEqual({
      provider: 'openrouter',
      outcome: 'failed',
      reason: 'CREDIT',
    })
    expect(providerBlock(w.state.snapshot(), 'openrouter', '2026-11-30')).toBe('CREDIT')
  })
})

const O3 = 'vendor/model-x:free'
const GONE = 'vendor/model-gone:free'
const GROQ_402 = ((): Reply => {
  const fx = GROQ_FIXTURES.find((f) => f.status === 402) as ProviderFixture
  return { status: fx.status, body: fx.body }
})()
const REJECT = '404 data policy is FLAG_REJECTED, before RETIRED'
const openRouterReserved = (w: ReturnType<typeof world>): number =>
  (w.cap as ReturnType<typeof countingCap>).reserved.filter((p) => p === 'openrouter').length

describe('a CREDIT probe outside OpenRouter keeps the behaviour of main (FR-3)', () => {
  it('chain check: a Groq probe answered 402 sets no bit and the sweep runs on', async () => {
    const w = refreshWorld({ routes: [GROQ], chat: () => GROQ_402 })
    const result = await runModelChainCheck(w.deps)
    expect(w.chatModels()).toEqual(GROQ.models)
    expect(result.providers).toContainEqual({ provider: 'groq', outcome: 'done' })
    expect(providerRecord(w.state.snapshot(), 'groq')).toEqual({ provider: 'groq', auth: false })
    expect(w.ofType('MODEL_PROBED').map((e) => e.verdict)).toEqual(['unknown', 'unknown'])
  })

  it('start-up: a Groq AUTH proof probe answered 402 keeps AUTH, sets no CREDIT, and the refresh is done', async () => {
    const w = refreshWorld({
      routes: [GROQ],
      state: markAuth('groq')(EMPTY_ROUTE_STATE),
      chat: () => GROQ_402,
    })
    const result = await runStartupModelRefresh(w.deps)
    expect(w.chats()).toHaveLength(1)
    expect(result.providers).toContainEqual({ provider: 'groq', outcome: 'done' })
    const r = providerRecord(w.state.snapshot(), 'groq')
    expect(r.auth).toBe(true)
    expect(r).not.toHaveProperty('creditDay')
  })
})

describe('the FLAG_REJECTED proof model (FR-4, §3.5)', () => {
  it('the flagged model spent for the day stays the proof model: a 2xx of another model keeps the flag', async () => {
    const s = markSpent(
      'openrouter',
      O2,
      today,
    )(markFlagRejected('openrouter', O2)(EMPTY_ROUTE_STATE))
    const w = world(s)
    await runStartupModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([O1])
    expect(providerRecord(w.state.snapshot(), 'openrouter').flagModel).toBe(O2)
  })

  it('a flagged model in the vetted list but not among the probed models stays the proof model', async () => {
    const w = world(markFlagRejected('openrouter', O2)(EMPTY_ROUTE_STATE))
    await probeAll(OPENROUTER as HostedRouteConfig, [O1], w.deps, { vetted: [O1, O2] })
    expect(w.chatModels()).toEqual([O1])
    expect(providerRecord(w.state.snapshot(), 'openrouter').flagModel).toBe(O2)
  })

  it('daily: the proof probe goes to the flagged model even after it had an OK call', async () => {
    const w = refreshWorld({
      routes: [OPENROUTER],
      state: markFlagRejected('openrouter', O2)(EMPTY_ROUTE_STATE),
      hadOkCall: (_p, m) => m === O2,
    })
    await runDailyModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([O2])
    expect(providerRecord(w.state.snapshot(), 'openrouter')).not.toHaveProperty('flagModel')
  })

  it('the flagged model retired: the current first model is the proof model, and its 2xx clears the flag', async () => {
    const s = markRetired(
      'openrouter',
      O1,
      NOON,
    )(markFlagRejected('openrouter', O1)(EMPTY_ROUTE_STATE))
    const w = world(s)
    await runStartupModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([O2])
    expect(providerRecord(w.state.snapshot(), 'openrouter')).not.toHaveProperty('flagModel')
  })

  it('the flagged model gone from the vetted list: the first model is the proof model', async () => {
    const w = world(markFlagRejected('openrouter', GONE)(EMPTY_ROUTE_STATE))
    await runStartupModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([O1])
    expect(providerRecord(w.state.snapshot(), 'openrouter')).not.toHaveProperty('flagModel')
  })

  it('a rejected proof probe gets one more, to the model now first: its 2xx clears the flag', async () => {
    const w = world(markFlagRejected('openrouter', O1)(EMPTY_ROUTE_STATE), (m) =>
      m === O1 ? reply(REJECT) : ALIVE,
    )
    await runStartupModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([O1, O2])
    expect(openRouterReserved(w)).toBe(3)
    expect(providerRecord(w.state.snapshot(), 'openrouter')).not.toHaveProperty('flagModel')
    expect(w.fileList('openrouter')).toEqual([O2])
  })

  it('both proof probes rejected: the flag stays, and exactly two probes go out', async () => {
    const route = { ...OPENROUTER, models: [O1, O2, O3] }
    const w = refreshWorld({
      routes: [route],
      state: markFlagRejected('openrouter', O1)(EMPTY_ROUTE_STATE),
      chat: () => reply(REJECT),
    })
    await runStartupModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([O1, O2])
    expect(providerRecord(w.state.snapshot(), 'openrouter').flagModel).toBe(O1)
  })

  it('the second proof probe takes its own unit: a full cap stops it', async () => {
    const w = refreshWorld({
      routes: [OPENROUTER],
      state: markFlagRejected('openrouter', O1)(EMPTY_ROUTE_STATE),
      chat: (s) => (s.model === O1 ? reply(REJECT) : ALIVE),
      cap: limitedCap(2),
    })
    const result = await runStartupModelRefresh(w.deps)
    expect(w.chatModels()).toEqual([O1])
    expect(result.providers).toContainEqual({
      provider: 'openrouter',
      outcome: 'skipped',
      reason: 'CAP',
    })
    expect(providerRecord(w.state.snapshot(), 'openrouter').flagModel).toBe(O1)
  })

  it('the chain check sends no second proof probe', async () => {
    const w = world(markFlagRejected('openrouter', O1)(EMPTY_ROUTE_STATE), (m) =>
      m === O1 ? reply(REJECT) : ALIVE,
    )
    await runModelChainCheck(w.deps)
    expect(w.chatModels()).toEqual([O1, O2])
    // The list keeps the flagged model, so it stays the proof model: the 2xx of O2 clears nothing.
    expect(providerRecord(w.state.snapshot(), 'openrouter').flagModel).toBe(O1)
  })
})
