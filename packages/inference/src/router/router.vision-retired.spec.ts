import { describe, expect, it, vi } from 'vitest'
import {
  config,
  deps,
  GEMINI,
  GOOD,
  GROQ,
  REQ,
  scriptedFetch,
} from './__test-helpers__/router-harness'
import { createRouter } from './router'
import {
  createMemoryRouteStatePort,
  EMPTY_ROUTE_STATE,
  markRetired,
  markSpent,
  providerDay,
} from './state'

// Today only Gemini takes images and each provider is configured once, so two vision routes cannot
// meet. This spec makes Groq vision-capable to reach the H.2 case a second vision provider opens.
vi.mock('../internal/model-id', async (original) => {
  const real = await original<typeof import('../internal/model-id')>()
  return { ...real, isVisionCapable: () => true }
})

const NOON = Date.parse('2026-11-04T12:00:00Z')

describe('an image call, two vision routes (R1, CR-M-1)', () => {
  it('a route whose vision models are all retired in state is transient next to a spent one', async () => {
    let s = EMPTY_ROUTE_STATE
    for (const m of GEMINI.models) s = markSpent('gemini', m, providerDay('gemini', NOON))(s)
    for (const m of GROQ.models) s = markRetired('groq', m, NOON)(s)
    const f = scriptedFetch(() => GOOD)
    const d = deps(f.fetchImpl, { now: () => NOON, routeState: createMemoryRouteStatePort(s) })
    const r = await createRouter(config([GROQ, GEMINI]), d).run({ ...REQ, images: ['AAAA'] })
    expect(r).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(f.sent).toEqual([])
  })
})
