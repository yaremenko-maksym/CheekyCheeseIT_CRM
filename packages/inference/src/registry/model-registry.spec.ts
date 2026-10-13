import { describe, expect, it } from 'vitest'
import { selectModel, isModelUnavailable, type OpenRouterModel } from './model-registry'

const catalog: OpenRouterModel[] = [
  { id: 'cheap/ok', promptPriceUsdPerMTok: 0.2, contextTokens: 32000 },
  { id: 'pricey/ok', promptPriceUsdPerMTok: 5, contextTokens: 128000 },
  { id: 'cheap/tiny', promptPriceUsdPerMTok: 0.1, contextTokens: 4000 },
]
const guard = { maxPromptPriceUsdPerMTok: 1, minContextTokens: 16000 }

describe('selectModel (guardrailed)', () => {
  it('picks the cheapest model passing BOTH guardrails', () =>
    expect(selectModel(catalog, guard)?.id).toBe('cheap/ok'))
  it('honours a preferred id when it qualifies', () =>
    expect(
      selectModel(catalog, { ...guard, preferredModelIds: ['pricey/ok', 'cheap/ok'] })?.id,
    ).toBe('cheap/ok'))
  it('prefers a qualifying preferred id over a cheaper qualifying model', () => {
    const c: OpenRouterModel[] = [
      { id: 'a/cheaper', promptPriceUsdPerMTok: 0.1, contextTokens: 32000 },
      { id: 'b/preferred', promptPriceUsdPerMTok: 0.9, contextTokens: 32000 },
    ]
    expect(selectModel(c, { ...guard, preferredModelIds: ['b/preferred'] })?.id).toBe('b/preferred')
  })
  it('breaks price ties by lexicographic id', () => {
    const c: OpenRouterModel[] = [
      { id: 'z/m', promptPriceUsdPerMTok: 0.5, contextTokens: 32000 },
      { id: 'a/m', promptPriceUsdPerMTok: 0.5, contextTokens: 32000 },
    ]
    expect(selectModel(c, guard)?.id).toBe('a/m')
  })
  it('accepts boundary values (price == max, context == min)', () => {
    const c: OpenRouterModel[] = [{ id: 'b/edge', promptPriceUsdPerMTok: 1, contextTokens: 16000 }]
    expect(selectModel(c, guard)?.id).toBe('b/edge')
  })
  it('NEVER selects a model over the price ceiling or under min context', () => {
    expect(
      selectModel([{ id: 'x/pricey', promptPriceUsdPerMTok: 9, contextTokens: 200000 }], guard),
    ).toBeNull()
    expect(
      selectModel([{ id: 'x/tiny', promptPriceUsdPerMTok: 0.01, contextTokens: 2000 }], guard),
    ).toBeNull()
  })
  it('never selects a failing preferred id', () =>
    expect(selectModel(catalog, { ...guard, preferredModelIds: ['pricey/ok'] })?.id).toBe(
      'cheap/ok',
    ))
  it('returns null for an empty catalog', () => expect(selectModel([], guard)).toBeNull())
})

describe('isModelUnavailable', () => {
  it('true on 404', () => expect(isModelUnavailable({ kind: 'transport', status: 404 })).toBe(true))
  it('true on 400 with a model-missing body', () =>
    expect(
      isModelUnavailable({
        kind: 'transport',
        status: 400,
        text: 'No endpoints found for model foo/bar',
      }),
    ).toBe(true))
  it('false on a plain 400 and on 503', () => {
    expect(isModelUnavailable({ kind: 'transport', status: 400, text: 'bad request' })).toBe(false)
    expect(isModelUnavailable({ kind: 'transport', status: 503 })).toBe(false)
  })
  it('false on a 400 that mentions model but not a missing marker', () =>
    expect(
      isModelUnavailable({ kind: 'transport', status: 400, text: 'model parameter malformed' }),
    ).toBe(false))
  it('false on a 400 with a marker but no model mention', () =>
    expect(isModelUnavailable({ kind: 'transport', status: 400, text: 'route not found' })).toBe(
      false,
    ))
  it('false when status is absent', () =>
    expect(isModelUnavailable({ kind: 'transport' })).toBe(false))
})
