import { describe, expect, it } from 'vitest'
import { validateEnv } from '../config/env'
import { buildInferenceConfig } from './build-inference-config'
import { EXTRACTION_MODEL_GUARDRAILS } from './extraction-guardrails'

const BASE_DEV = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/crm',
  REDIS_URL: 'redis://localhost:6379',
  GOOGLE_CLIENT_ID: 'google-client-id',
  GOOGLE_CLIENT_SECRET: 'google-client-secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:3001/api/auth/google/callback',
  JWT_SECRET: 'jwt-secret-at-least-32-chars-000000',
  SESSION_SECRET: 'session-secret-at-least-32-chars-0',
  FRONTEND_URL: 'http://localhost:3000',
  AWS_ACCESS_KEY_ID: 'crmdevaccesskey',
  AWS_SECRET_ACCESS_KEY: 'crmdevsecretkey',
}

describe('inference env keys', () => {
  it('accepts a config with every inference key absent', () => {
    const env = validateEnv({ ...BASE_DEV })
    expect(env.JEV_API_KEY).toBeUndefined()
    expect(env.OPENROUTER_API_KEY).toBeUndefined()
    expect(env.LOCAL_MODEL_URL).toBeUndefined()
    expect(env.INFERENCE_EXTRACTION_PROVIDER).toBeUndefined()
  })

  it('accepts a valid provider selector and keys', () => {
    const env = validateEnv({
      ...BASE_DEV,
      INFERENCE_EXTRACTION_PROVIDER: 'openrouter',
      OPENROUTER_API_KEY: 'or-key',
      JEV_API_KEY: 'jev-key',
    })
    expect(env.INFERENCE_EXTRACTION_PROVIDER).toBe('openrouter')
    expect(env.OPENROUTER_API_KEY).toBe('or-key')
  })

  it('rejects an unknown provider selector', () => {
    expect(() => validateEnv({ ...BASE_DEV, INFERENCE_EXTRACTION_PROVIDER: 'groq' })).toThrow()
  })
})

describe('buildInferenceConfig', () => {
  it('returns an empty config when nothing is set', () => {
    expect(buildInferenceConfig({})).toEqual({})
  })

  it('builds the openrouter block with guardrails and no model id', () => {
    expect(
      buildInferenceConfig({
        OPENROUTER_API_KEY: 'or-key',
        INFERENCE_EXTRACTION_PROVIDER: 'openrouter',
      }),
    ).toEqual({
      extraction: {
        provider: 'openrouter',
        openrouter: { apiKey: 'or-key', guardrails: EXTRACTION_MODEL_GUARDRAILS },
      },
    })
  })

  it('omits extraction when the selected provider has no key', () => {
    expect(buildInferenceConfig({ INFERENCE_EXTRACTION_PROVIDER: 'openrouter' })).toEqual({})
    expect(buildInferenceConfig({ OPENROUTER_API_KEY: 'k' })).toEqual({})
  })

  it('builds the local block, with the key only when present', () => {
    expect(
      buildInferenceConfig({
        INFERENCE_EXTRACTION_PROVIDER: 'local',
        LOCAL_MODEL_URL: 'http://localhost:11434/v1',
        LOCAL_MODEL_NAME: 'qwen',
      }),
    ).toEqual({
      extraction: {
        provider: 'local',
        local: { baseUrl: 'http://localhost:11434/v1', model: 'qwen' },
      },
    })
    expect(
      buildInferenceConfig({
        INFERENCE_EXTRACTION_PROVIDER: 'local',
        LOCAL_MODEL_URL: 'http://localhost:11434/v1',
        LOCAL_MODEL_NAME: 'qwen',
        LOCAL_MODEL_KEY: 'lk',
      }).extraction?.local?.apiKey,
    ).toBe('lk')
  })

  it('builds the jev decision block when the key is present', () => {
    expect(buildInferenceConfig({ JEV_API_KEY: 'jk' })).toEqual({
      decision: { jev: { apiKey: 'jk' } },
    })
  })
})
