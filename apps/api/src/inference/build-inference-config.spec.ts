import { describe, expect, it } from 'vitest'
import { routerConfigSchema } from '@crm/inference'
import { extractionWorkerEnvSchema, validateEnv } from '../config/env'
import { buildInferenceConfig, buildRouterConfig } from './build-inference-config'
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

  it('accepts both provider selector members', () => {
    expect(
      validateEnv({ ...BASE_DEV, INFERENCE_EXTRACTION_PROVIDER: 'local' })
        .INFERENCE_EXTRACTION_PROVIDER,
    ).toBe('local')
    expect(
      validateEnv({ ...BASE_DEV, INFERENCE_EXTRACTION_PROVIDER: 'openrouter' })
        .INFERENCE_EXTRACTION_PROVIDER,
    ).toBe('openrouter')
  })

  it('accepts a multi-character LOCAL_MODEL_KEY', () => {
    expect(validateEnv({ ...BASE_DEV, LOCAL_MODEL_KEY: 'local-secret-key' }).LOCAL_MODEL_KEY).toBe(
      'local-secret-key',
    )
  })

  it('accepts a multi-character LOCAL_MODEL_NAME', () => {
    expect(validateEnv({ ...BASE_DEV, LOCAL_MODEL_NAME: 'llama-3.1-8b' }).LOCAL_MODEL_NAME).toBe(
      'llama-3.1-8b',
    )
  })

  it('rejects a remote plain-http LOCAL_MODEL_URL with the refine message', () => {
    expect(() => validateEnv({ ...BASE_DEV, LOCAL_MODEL_URL: 'http://evil.example' })).toThrow(
      /LOCAL_MODEL_URL must be/,
    )
  })

  it('accepts the router selector and the worker-only router keys', () => {
    const env = validateEnv({
      ...BASE_DEV,
      INFERENCE_EXTRACTION_PROVIDER: 'router',
      GEMINI_API_KEY: 'g-key',
      GROQ_API_KEY: 'q-key',
      ROUTER_LOCAL_MODEL_URL: 'http://crm-model-runtime:11434',
    })
    expect(env.INFERENCE_EXTRACTION_PROVIDER).toBe('router')
    expect(env.GEMINI_API_KEY).toBe('g-key')
    expect(env.GROQ_API_KEY).toBe('q-key')
    expect(env.ROUTER_LOCAL_MODEL_URL).toBe('http://crm-model-runtime:11434')
  })

  it('keeps the LOCAL_MODEL_URL refine narrow: the runtime container name is refused there', () => {
    expect(() =>
      validateEnv({ ...BASE_DEV, LOCAL_MODEL_URL: 'http://crm-model-runtime:11434' }),
    ).toThrow(/LOCAL_MODEL_URL must be/)
  })

  it('refuses a link-local ROUTER_LOCAL_MODEL_URL by key, never echoing the value', () => {
    let message = ''
    try {
      validateEnv({ ...BASE_DEV, ROUTER_LOCAL_MODEL_URL: 'http://169.254.169.254/latest' })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/ROUTER_LOCAL_MODEL_URL: ROUTER_LOCAL_MODEL_URL must be/)
    expect(message).not.toContain('169.254')
  })

  it('refuses an empty hosted key', () => {
    expect(() => validateEnv({ ...BASE_DEV, GEMINI_API_KEY: '' })).toThrow(/GEMINI_API_KEY/)
    expect(() => validateEnv({ ...BASE_DEV, GROQ_API_KEY: '' })).toThrow(/GROQ_API_KEY/)
  })
})

describe('extractionWorkerEnvSchema', () => {
  it('parses the worker keys alone, without the API env', () => {
    const r = extractionWorkerEnvSchema.safeParse({
      INFERENCE_EXTRACTION_PROVIDER: 'router',
      GROQ_API_KEY: 'q-key',
      ROUTER_LOCAL_MODEL_URL: 'http://crm-model-runtime:11434',
      LOCAL_MODEL_NAME: 'qwen3:8b',
      LOCAL_MODEL_KEY: 'l-key',
    })
    expect(r.success).toBe(true)
  })

  it('refuses a ROUTER_LOCAL_MODEL_URL the router refuses', () => {
    expect(
      extractionWorkerEnvSchema.safeParse({ ROUTER_LOCAL_MODEL_URL: 'http://example.com' }).success,
    ).toBe(false)
  })
})

const HOSTED_COMMON = {
  contextTokens: 32_000,
  structuredOutput: 'json_schema',
  minGapMs: 1_000,
  timeoutMs: 30_000,
  maxAnswerTokens: 2_000,
  freeLimit: { requestsPerDay: 1_000 },
}
const PARAMS = {
  policyVersion: 'v1',
  hostedBudgetMs: 60_000,
  floorBudgetMs: 6 * 200_000,
  routes: [
    { provider: 'gemini', models: ['gemini-2.5-flash'], ...HOSTED_COMMON },
    { provider: 'groq', models: ['openai/gpt-oss-20b'], ...HOSTED_COMMON },
    {
      provider: 'local',
      contextTokens: 8_192,
      structuredOutput: 'json_schema',
      timeoutMs: 200_000,
      maxAnswerTokens: 1_000,
    },
  ],
}
const FULL_ENV = {
  GEMINI_API_KEY: 'G-ENV-KEY',
  GROQ_API_KEY: 'Q-ENV-KEY',
  ROUTER_LOCAL_MODEL_URL: 'http://crm-model-runtime:11434',
  LOCAL_MODEL_NAME: 'qwen3:8b',
}
type Routes = { routes: Record<string, unknown>[] }

describe('buildRouterConfig', () => {
  it('fills keys and the local URL from env into a config the router accepts', () => {
    const cfg = buildRouterConfig(PARAMS, { ...FULL_ENV, LOCAL_MODEL_KEY: 'L-ENV-KEY' })
    const { routes } = cfg as Routes
    expect(routes.map((r) => [r.provider, r.apiKey])).toEqual([
      ['gemini', 'G-ENV-KEY'],
      ['groq', 'Q-ENV-KEY'],
      ['local', 'L-ENV-KEY'],
    ])
    expect(routes[2]).toMatchObject({
      baseUrl: 'http://crm-model-runtime:11434',
      model: 'qwen3:8b',
    })
    // A key over plain HTTP is the router's refusal (SR-L-63); without it the config is accepted.
    expect(routerConfigSchema.safeParse(buildRouterConfig(PARAMS, FULL_ENV)).success).toBe(true)
  })

  it('drops a hosted route whose key is absent: that provider does not take part', () => {
    const { routes } = buildRouterConfig(PARAMS, {
      ...FULL_ENV,
      GEMINI_API_KEY: undefined,
    }) as Routes
    expect(routes.map((r) => r.provider)).toEqual(['groq', 'local'])
    const localOnly = buildRouterConfig(PARAMS, {
      ROUTER_LOCAL_MODEL_URL: FULL_ENV.ROUTER_LOCAL_MODEL_URL,
      LOCAL_MODEL_NAME: FULL_ENV.LOCAL_MODEL_NAME,
    })
    expect((localOnly as Routes).routes.map((r) => r.provider)).toEqual(['local'])
    expect(routerConfigSchema.safeParse(localOnly).success).toBe(true)
  })

  it('never takes a key, URL or model from the JSON parameters', () => {
    const smuggled = {
      ...PARAMS,
      routes: [
        { ...PARAMS.routes[1], apiKey: 'JSON-KEY' },
        { ...PARAMS.routes[2], apiKey: 'JSON-KEY', baseUrl: 'http://evil.example', model: 'x' },
      ],
    }
    const withEnv = buildRouterConfig(smuggled, FULL_ENV) as Routes
    expect(withEnv.routes[0]!.apiKey).toBe('Q-ENV-KEY')
    expect(withEnv.routes[1]).toMatchObject({ baseUrl: FULL_ENV.ROUTER_LOCAL_MODEL_URL })
    expect(withEnv.routes[1]!.model).toBe('qwen3:8b')
    expect(withEnv.routes[1]).not.toHaveProperty('apiKey')
    expect(JSON.stringify(buildRouterConfig(smuggled, {}))).not.toMatch(/JSON-KEY|evil/)
  })

  it('drops the local route without its URL or model, so the router refuses the config', () => {
    for (const missing of ['ROUTER_LOCAL_MODEL_URL', 'LOCAL_MODEL_NAME'] as const) {
      const cfg = buildRouterConfig(PARAMS, { ...FULL_ENV, [missing]: undefined })
      expect((cfg as Routes).routes.map((r) => r.provider)).toEqual(['gemini', 'groq'])
      expect(routerConfigSchema.safeParse(cfg).success).toBe(false)
    }
  })

  it('hands an unknown provider and a malformed config on unchanged, for the router to refuse', () => {
    const odd = { ...PARAMS, routes: [{ provider: 'openrouter', apiKey: 'K' }] }
    expect(buildRouterConfig(odd, FULL_ENV)).toEqual(odd)
    // A route that is not an object is not read; a null one is no route, like an absent env.
    expect(buildRouterConfig({ ...PARAMS, routes: [null, 'x', 7] }, FULL_ENV)).toEqual({
      ...PARAMS,
      routes: ['x', 7],
    })
    for (const raw of [null, 'x', 1, [], { routes: 'x' }, { policyVersion: 'v1' }]) {
      expect(buildRouterConfig(raw, FULL_ENV)).toEqual(raw)
    }
  })

  it('the API inference config never carries the router: no extraction block for it', () => {
    expect(
      buildInferenceConfig({
        INFERENCE_EXTRACTION_PROVIDER: 'router',
        LOCAL_MODEL_URL: 'http://localhost:11434',
        LOCAL_MODEL_NAME: 'qwen3:8b',
        OPENROUTER_API_KEY: 'or-key',
      }).extraction,
    ).toBeUndefined()
  })

  it('does not mutate the parameters', () => {
    const copy = structuredClone(PARAMS)
    buildRouterConfig(PARAMS, FULL_ENV)
    expect(PARAMS).toEqual(copy)
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

  it('omits local extraction unless the provider is local AND both url and name are set', () => {
    const url = 'http://localhost:11434/v1'
    expect(
      buildInferenceConfig({ INFERENCE_EXTRACTION_PROVIDER: 'local', LOCAL_MODEL_URL: url }),
    ).toStrictEqual({})
    expect(
      buildInferenceConfig({ INFERENCE_EXTRACTION_PROVIDER: 'local', LOCAL_MODEL_NAME: 'q' }),
    ).toStrictEqual({})
    expect(buildInferenceConfig({ LOCAL_MODEL_URL: url, LOCAL_MODEL_NAME: 'q' })).toStrictEqual({})
    expect(
      buildInferenceConfig({
        INFERENCE_EXTRACTION_PROVIDER: 'openrouter',
        LOCAL_MODEL_URL: url,
        LOCAL_MODEL_NAME: 'q',
      }),
    ).toStrictEqual({})
  })

  it('local block carries no apiKey property when the key is absent', () => {
    const cfg = buildInferenceConfig({
      INFERENCE_EXTRACTION_PROVIDER: 'local',
      LOCAL_MODEL_URL: 'http://localhost:11434/v1',
      LOCAL_MODEL_NAME: 'q',
    })
    expect(cfg.extraction?.local).toStrictEqual({
      baseUrl: 'http://localhost:11434/v1',
      model: 'q',
    })
  })

  it('selects exactly one extraction provider and keeps decision independent', () => {
    expect(
      buildInferenceConfig({
        JEV_API_KEY: 'jk',
        OPENROUTER_API_KEY: 'or',
        INFERENCE_EXTRACTION_PROVIDER: 'openrouter',
        LOCAL_MODEL_URL: 'http://x/v1',
        LOCAL_MODEL_NAME: 'q',
      }),
    ).toStrictEqual({
      decision: { jev: { apiKey: 'jk' } },
      extraction: {
        provider: 'openrouter',
        openrouter: { apiKey: 'or', guardrails: EXTRACTION_MODEL_GUARDRAILS },
      },
    })
  })
})

describe('EXTRACTION_MODEL_GUARDRAILS', () => {
  it('pins the tunable guardrail values', () => {
    expect(EXTRACTION_MODEL_GUARDRAILS).toStrictEqual({
      maxPromptPriceUsdPerMTok: 1,
      minContextTokens: 16000,
      preferredModelIds: [],
    })
  })
})
