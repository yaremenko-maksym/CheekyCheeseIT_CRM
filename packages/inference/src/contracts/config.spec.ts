import { describe, expect, it } from 'vitest'
import { inferenceConfigSchema, extractionModelGuardrailsSchema } from './config'

describe('inference config', () => {
  it('accepts an openrouter extraction config with guardrails', () => {
    const cfg = inferenceConfigSchema.parse({
      extraction: {
        provider: 'openrouter',
        openrouter: {
          apiKey: 'k',
          guardrails: { maxPromptPriceUsdPerMTok: 1, minContextTokens: 16000 },
        },
      },
    })
    expect(cfg.extraction?.provider).toBe('openrouter')
  })
  it('rejects guardrails with a non-positive price ceiling', () =>
    expect(() =>
      extractionModelGuardrailsSchema.parse({
        maxPromptPriceUsdPerMTok: 0,
        minContextTokens: 16000,
      }),
    ).toThrow())
  it('accepts an empty config (nothing configured)', () =>
    expect(inferenceConfigSchema.parse({})).toEqual({}))
})
