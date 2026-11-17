import { describe, expect, it } from 'vitest'
import { fakeFs } from './__test-helpers__/fake-fs'
import {
  clearByProof,
  createFileRouteStatePort,
  EMPTY_ROUTE_STATE,
  markAuth,
  markCredit,
  markFlagRejected,
  markProviderSpent,
  needsProofProbe,
  providerBlock,
  providerDay,
  providerRecord,
  type RouteState,
} from './state'

/** The OpenRouter provider bits of ADR §3.5: `SPENT_DAY`, `FLAG_REJECTED` and a proof-held `CREDIT`. */
const PATH = '/data/route-state.json'
const DAY = '2026-11-04'
const NEXT = '2026-11-05'
const M1 = 'meta-llama/llama-3.3-70b-instruct:free'
const M2 = 'qwen/qwen3-235b-a22b:free'
const apply = (...changes: ((s: RouteState) => RouteState)[]) =>
  changes.reduce((s, f) => f(s), EMPTY_ROUTE_STATE)

describe('providerBlock (§3.5)', () => {
  it('a clean provider is not blocked', () => {
    expect(providerBlock(EMPTY_ROUTE_STATE, 'openrouter', DAY)).toBeNull()
  })

  it('SPENT_DAY holds for its provider day only', () => {
    const s = apply(markProviderSpent('openrouter', DAY))
    expect(providerBlock(s, 'openrouter', DAY)).toBe('SPENT_DAY')
    expect(providerBlock(s, 'openrouter', NEXT)).toBeNull()
    // A provider spent bit is the provider's own: another provider is untouched.
    expect(providerBlock(s, 'groq', DAY)).toBeNull()
  })

  it('FLAG_REJECTED holds across days', () => {
    const s = apply(markFlagRejected('openrouter', M1))
    expect(providerBlock(s, 'openrouter', DAY)).toBe('FLAG_REJECTED')
    expect(providerBlock(s, 'openrouter', NEXT)).toBe('FLAG_REJECTED')
  })

  it('an OpenRouter CREDIT bit holds past its day; a Groq one lapses with it', () => {
    expect(providerBlock(apply(markCredit('openrouter', DAY)), 'openrouter', NEXT)).toBe('CREDIT')
    expect(providerBlock(apply(markCredit('groq', DAY)), 'groq', DAY)).toBe('CREDIT')
    expect(providerBlock(apply(markCredit('groq', DAY)), 'groq', NEXT)).toBeNull()
  })

  it('the order is AUTH, CREDIT, FLAG_REJECTED, SPENT_DAY', () => {
    const all = apply(
      markProviderSpent('openrouter', DAY),
      markFlagRejected('openrouter', M1),
      markCredit('openrouter', DAY),
      markAuth('openrouter'),
    )
    expect(providerBlock(all, 'openrouter', DAY)).toBe('AUTH')
    const noAuth = apply(
      markProviderSpent('openrouter', DAY),
      markFlagRejected('openrouter', M1),
      markCredit('openrouter', DAY),
    )
    expect(providerBlock(noAuth, 'openrouter', DAY)).toBe('CREDIT')
    const flagAndSpent = apply(
      markProviderSpent('openrouter', DAY),
      markFlagRejected('openrouter', M1),
    )
    expect(providerBlock(flagAndSpent, 'openrouter', DAY)).toBe('FLAG_REJECTED')
  })
})

describe('needsProofProbe (§3.2, §3.5)', () => {
  it.each([
    ['AUTH', apply(markAuth('openrouter')), 'openrouter', true],
    ['FLAG_REJECTED', apply(markFlagRejected('openrouter', M1)), 'openrouter', true],
    ['an OpenRouter CREDIT', apply(markCredit('openrouter', DAY)), 'openrouter', true],
    ['a Groq CREDIT', apply(markCredit('groq', DAY)), 'groq', false],
    ['SPENT_DAY', apply(markProviderSpent('openrouter', DAY)), 'openrouter', false],
    ['nothing', EMPTY_ROUTE_STATE, 'openrouter', false],
  ] as const)('%s: %s', (_l, s, p, expected) => {
    expect(needsProofProbe(s, p)).toBe(expected)
  })
})

describe('clearByProof (§3.2, §3.5)', () => {
  it('a proof of the flagged model clears AUTH, the OpenRouter CREDIT and the flag', () => {
    const s = apply(
      markAuth('openrouter'),
      markCredit('openrouter', DAY),
      markFlagRejected('openrouter', M1),
    )
    const r = providerRecord(clearByProof('openrouter', M1, M1)(s), 'openrouter')
    expect(r.auth).toBe(false)
    expect(r).not.toHaveProperty('creditDay')
    expect(r).not.toHaveProperty('flagModel')
  })

  it('a proof of another model keeps the flag', () => {
    const s = apply(markFlagRejected('openrouter', M1))
    const r = providerRecord(clearByProof('openrouter', M2, M1)(s), 'openrouter')
    expect(r.flagModel).toBe(M1)
  })

  it('a Groq CREDIT is not a proof bit: it stays until its day turns', () => {
    const s = apply(markAuth('groq'), markCredit('groq', DAY))
    const r = providerRecord(clearByProof('groq', 'openai/gpt-oss-20b', undefined)(s), 'groq')
    expect(r.auth).toBe(false)
    expect(r.creditDay).toBe(DAY)
  })

  it('leaves the spent day alone: a proof is not a new free day', () => {
    const s = apply(markProviderSpent('openrouter', DAY))
    expect(
      providerRecord(clearByProof('openrouter', M1, undefined)(s), 'openrouter').spentDay,
    ).toBe(DAY)
  })
})

describe('the OpenRouter bits persist (§3.5)', () => {
  it('spentDay and flagModel survive a reload of the state file', async () => {
    const s = apply(markProviderSpent('openrouter', DAY), markFlagRejected('openrouter', M1))
    const fs = fakeFs({ [PATH]: JSON.stringify(s) })
    const port = await createFileRouteStatePort({
      path: PATH,
      fs,
      now: () => Date.parse(`${DAY}T12:00:00Z`),
      onEvent: () => undefined,
    })
    const r = providerRecord(port.snapshot(), 'openrouter')
    expect(r.spentDay).toBe(DAY)
    expect(r.flagModel).toBe(M1)
  })

  it('OpenRouter resets at midnight UTC', () => {
    expect(providerDay('openrouter', Date.parse('2026-11-04T23:59:00Z'))).toBe(DAY)
    expect(providerDay('openrouter', Date.parse('2026-11-05T00:00:00Z'))).toBe(NEXT)
  })
})
