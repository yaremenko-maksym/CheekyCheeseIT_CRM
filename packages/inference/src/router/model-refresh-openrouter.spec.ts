import { describe, expect, it } from 'vitest'
import { OPENROUTER_FIXTURES } from '../internal/__fixtures__/openrouter.fixtures'
import type { ProviderFixture } from '../internal/__fixtures__/provider-fixture'
import { ALIVE, NOON, O1, O2, refreshWorld } from './__test-helpers__/refresh-world'
import { OPENROUTER, type Reply } from './__test-helpers__/router-harness'
import { runDailyModelRefresh, runModelChainCheck, runStartupModelRefresh } from './model-refresh'
import {
  EMPTY_ROUTE_STATE,
  markAuth,
  markCredit,
  markFlagRejected,
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
