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
  it('accepts a local extraction block', () => {
    const cfg = inferenceConfigSchema.parse({
      extraction: {
        provider: 'local',
        local: { baseUrl: 'http://localhost:8080/v1', model: 'm', apiKey: 'k', timeoutMs: 5000 },
      },
    })
    expect(cfg.extraction?.local?.model).toBe('m')
  })
  it('accepts preferredModelIds, baseUrl and timeoutMs on openrouter', () => {
    const cfg = inferenceConfigSchema.parse({
      extraction: {
        provider: 'openrouter',
        openrouter: {
          apiKey: 'k',
          baseUrl: 'https://openrouter.ai/api/v1',
          timeoutMs: 30000,
          guardrails: {
            maxPromptPriceUsdPerMTok: 1,
            minContextTokens: 16000,
            preferredModelIds: ['a/b'],
          },
        },
      },
    })
    expect(cfg.extraction?.openrouter?.guardrails.preferredModelIds).toEqual(['a/b'])
    expect(cfg.extraction?.openrouter?.timeoutMs).toBe(30000)
  })
  it('accepts an empty config (nothing configured)', () =>
    expect(inferenceConfigSchema.parse({})).toEqual({}))
})
