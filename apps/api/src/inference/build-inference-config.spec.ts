import { describe, expect, it } from 'vitest'
import { routerConfigSchema } from '@crm/inference'
import { validateEnv, WORKER_ONLY_ENV_KEYS } from '../config/env'
import {
  buildInferenceConfig,
  buildRouterConfig,
  extractionWorkerEnvSchema,
  routerEnvWarnings,
} from './build-inference-config'
import { EXTRACTION_MODEL_GUARDRAILS } from './extraction-guardrails'

const BASE_DEV = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/crm',
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

  it('the router selector is the worker’s alone: the API refuses it', () => {
    expect(() => validateEnv({ ...BASE_DEV, INFERENCE_EXTRACTION_PROVIDER: 'router' })).toThrow(
      /INFERENCE_EXTRACTION_PROVIDER/,
    )
  })

  it.each(WORKER_ONLY_ENV_KEYS)('the API refuses to boot with %s, naming the key only', (key) => {
    const value = 'http://VALUE-MARKER.example/x'
    let message = ''
    try {
      validateEnv({ ...BASE_DEV, [key]: value })
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toBe(
      `Invalid environment variables:\n  ${key}: worker-only key, not allowed in the API env`,
    )
  })

  it('names every worker-only key that is set, and nothing else', () => {
    expect(() =>
      validateEnv({ ...BASE_DEV, GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', LOCAL_MODEL_NAME: 'm' }),
    ).toThrow(
      'Invalid environment variables:\n  GEMINI_API_KEY: worker-only key, not allowed in the API env\n  GROQ_API_KEY: worker-only key, not allowed in the API env',
    )
  })

  it('an empty worker-only key is unset (the .env.example template carries one)', () => {
    const env = validateEnv({ ...BASE_DEV, ROUTER_LOCAL_MODEL_URL: '', GEMINI_API_KEY: '' })
    expect(Object.keys(env).filter((k) => WORKER_ONLY_ENV_KEYS.includes(k as never))).toEqual([])
  })

  it('the worker-only keys are the hosted keys and the router URL', () => {
    expect(WORKER_ONLY_ENV_KEYS).toEqual([
      'GEMINI_API_KEY',
      'GROQ_API_KEY',
      'ROUTER_LOCAL_MODEL_URL',
    ])
  })

  it('keeps the LOCAL_MODEL_URL refine narrow: the runtime container name is refused there', () => {
    expect(() =>
      validateEnv({ ...BASE_DEV, LOCAL_MODEL_URL: 'http://crm-model-runtime:11434' }),
    ).toThrow(/LOCAL_MODEL_URL must be/)
  })
})

describe('extractionWorkerEnvSchema', () => {
  it('refuses an empty hosted key', () => {
    expect(extractionWorkerEnvSchema.safeParse({ GEMINI_API_KEY: '' }).success).toBe(false)
    expect(extractionWorkerEnvSchema.safeParse({ GROQ_API_KEY: '' }).success).toBe(false)
    expect(extractionWorkerEnvSchema.safeParse({ OPENROUTER_API_KEY: '' }).success).toBe(false)
  })

  it('parses the worker keys alone, without the API env', () => {
    const r = extractionWorkerEnvSchema.safeParse({ GROQ_API_KEY: 'q-key' })
    expect(r.success).toBe(true)
  })

  it.each(['ROUTER_LOCAL_MODEL_URL', 'LOCAL_MODEL_NAME', 'LOCAL_MODEL_KEY'])(
    '%s is no worker key any more (5.4c-H1): left set, it is not read and refuses nothing',
    (key) => {
      const r = extractionWorkerEnvSchema.safeParse({ GROQ_API_KEY: 'q-key', [key]: 'http://x' })
      expect(r.success).toBe(true)
      expect(r.data).toEqual({ GROQ_API_KEY: 'q-key' })
    },
  )
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
  routes: [
    { provider: 'gemini', models: ['gemini-2.5-flash'], ...HOSTED_COMMON },
    { provider: 'groq', models: ['openai/gpt-oss-20b'], ...HOSTED_COMMON },
  ],
}
const FULL_ENV = { GEMINI_API_KEY: 'G-ENV-KEY', GROQ_API_KEY: 'Q-ENV-KEY' }
type Routes = { routes: Record<string, unknown>[] }

const ACCOUNT = '0123456789abcdef0123456789abcdef'
/** The #1377 runbook sample (gemini + groq + cloudflare), without the withdrawn `floorBudgetMs`. */
const RUNBOOK_SAMPLE = {
  policyVersion: 'hosted-2026-11-17',
  hostedBudgetMs: 90_000,
  routes: [
    {
      provider: 'gemini',
      models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
      contextTokens: 32_000,
      structuredOutput: 'json_schema',
      minGapMs: 4_000,
      timeoutMs: 30_000,
      maxAnswerTokens: 2_000,
      freeLimit: { requestsPerDay: 20 },
    },
    {
      provider: 'groq',
      models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
      contextTokens: 8_000,
      structuredOutput: 'json_schema',
      minGapMs: 2_000,
      timeoutMs: 30_000,
      maxAnswerTokens: 2_000,
      freeLimit: { requestsPerDay: 1_000, tokensPerDay: 200_000 },
    },
    {
      provider: 'cloudflare',
      models: [
        '@cf/mistralai/mistral-small-3.1-24b-instruct',
        '@cf/openai/gpt-oss-20b',
        '@cf/google/gemma-4-26b-a4b-it',
      ],
      contextTokens: 16_000,
      structuredOutput: 'none',
      minGapMs: 2_000,
      timeoutMs: 30_000,
      maxAnswerTokens: 2_048,
      freeLimit: { requestsPerDay: 16 },
    },
  ],
}
const SAMPLE_ENV = { ...FULL_ENV, CLOUDFLARE_AI_TOKEN: 'C-ENV-KEY', CLOUDFLARE_ACCOUNT_ID: ACCOUNT }
const STALE_LOCAL = {
  provider: 'local',
  contextTokens: 8_192,
  structuredOutput: 'json_schema',
  timeoutMs: 200_000,
  maxAnswerTokens: 1_000,
}

describe('buildRouterConfig', () => {
  it('fills the hosted keys from env into a config the router accepts', () => {
    const cfg = buildRouterConfig(PARAMS, FULL_ENV)
    const { routes } = cfg as Routes
    expect(routes.map((r) => [r.provider, r.apiKey])).toEqual([
      ['gemini', 'G-ENV-KEY'],
      ['groq', 'Q-ENV-KEY'],
    ])
    expect(routerConfigSchema.safeParse(cfg).success).toBe(true)
  })

  it('accepts the hosted-only runbook sample: gemini, groq and cloudflare, every key from env (AC6)', () => {
    const cfg = buildRouterConfig(RUNBOOK_SAMPLE, SAMPLE_ENV)
    expect((cfg as Routes).routes.map((r) => r.provider)).toEqual(['gemini', 'groq', 'cloudflare'])
    expect(routerConfigSchema.safeParse(cfg).success).toBe(true)
  })

  it('a stale floorBudgetMs is handed on, so the router refuses the config (5.4c-H1)', () => {
    const cfg = buildRouterConfig({ ...RUNBOOK_SAMPLE, floorBudgetMs: 180_000 }, SAMPLE_ENV)
    expect(cfg).toHaveProperty('floorBudgetMs', 180_000)
    expect(routerConfigSchema.safeParse(cfg).success).toBe(false)
  })

  it('a stale local route is handed on unchanged, so the router refuses the config (5.4c-H1)', () => {
    const withLocal = { ...PARAMS, routes: [...PARAMS.routes, STALE_LOCAL] }
    const cfg = buildRouterConfig(withLocal, FULL_ENV) as Routes
    expect(cfg.routes.map((r) => r.provider)).toEqual(['gemini', 'groq', 'local'])
    expect(cfg.routes[2]).toEqual(STALE_LOCAL)
    expect(routerConfigSchema.safeParse(cfg).success).toBe(false)
  })

  it('drops a hosted route whose key is absent: that provider does not take part', () => {
    const { routes } = buildRouterConfig(PARAMS, {
      ...FULL_ENV,
      GEMINI_API_KEY: undefined,
    }) as Routes
    expect(routes.map((r) => r.provider)).toEqual(['groq'])
    // No key at all: no route is left, and the router refuses the empty list.
    const none = buildRouterConfig(PARAMS, {})
    expect((none as Routes).routes).toEqual([])
    expect(routerConfigSchema.safeParse(none).success).toBe(false)
  })

  describe('the Cloudflare route (amendment 2026-11-17)', () => {
    const CF = {
      provider: 'cloudflare',
      models: ['@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/openai/gpt-oss-20b'],
      ...HOSTED_COMMON,
      contextTokens: 16_000,
      maxAnswerTokens: 2_048,
      freeLimit: { requestsPerDay: 16 },
    }
    const WITH_CF = { ...PARAMS, routes: [CF, PARAMS.routes[1]] }
    const CF_ENV = { ...FULL_ENV, CLOUDFLARE_AI_TOKEN: 'C-ENV-KEY', CLOUDFLARE_ACCOUNT_ID: ACCOUNT }

    it('fills the token and the account id from env into a config the router accepts', () => {
      const cfg = buildRouterConfig(WITH_CF, CF_ENV)
      expect((cfg as Routes).routes[0]).toMatchObject({
        provider: 'cloudflare',
        apiKey: 'C-ENV-KEY',
        accountId: ACCOUNT,
      })
      expect(routerConfigSchema.safeParse(cfg).success).toBe(true)
    })

    it.each([
      ['no token', { CLOUDFLARE_AI_TOKEN: undefined }],
      ['no account id', { CLOUDFLARE_ACCOUNT_ID: undefined }],
      ['an upper-case account id', { CLOUDFLARE_ACCOUNT_ID: ACCOUNT.toUpperCase() }],
      ['a 31-character account id', { CLOUDFLARE_ACCOUNT_ID: ACCOUNT.slice(1) }],
      ['an account id with a path', { CLOUDFLARE_ACCOUNT_ID: `${ACCOUNT.slice(3)}/..` }],
      ['an empty account id', { CLOUDFLARE_ACCOUNT_ID: '' }],
    ])('drops the route with %s: the rest of the config still stands', (_why, over) => {
      const cfg = buildRouterConfig(WITH_CF, { ...CF_ENV, ...over })
      expect((cfg as Routes).routes.map((r) => r.provider)).toEqual(['groq'])
      expect(routerConfigSchema.safeParse(cfg).success).toBe(true)
    })

    it('never takes the token or the account id from the JSON parameters', () => {
      const smuggled = {
        ...PARAMS,
        routes: [{ ...CF, apiKey: 'JSON-KEY', accountId: 'f'.repeat(32) }, PARAMS.routes[1]],
      }
      const withEnv = buildRouterConfig(smuggled, CF_ENV) as Routes
      expect(withEnv.routes[0]).toMatchObject({ apiKey: 'C-ENV-KEY', accountId: ACCOUNT })
      const without = JSON.stringify(buildRouterConfig(smuggled, FULL_ENV))
      expect(without).not.toContain('JSON-KEY')
      expect(without).not.toContain('f'.repeat(32))
    })

    it('warns once, by route and reason, when a set account id is malformed (F6)', () => {
      const bad = `${ACCOUNT.slice(1)}X`
      const warnings = routerEnvWarnings(WITH_CF, { ...CF_ENV, CLOUDFLARE_ACCOUNT_ID: bad })
      expect(warnings).toEqual([{ route: 'cloudflare', reason: 'ACCOUNT_ID_MALFORMED' }])
      expect(JSON.stringify(warnings)).not.toContain(bad)
      expect(routerEnvWarnings(WITH_CF, CF_ENV)).toEqual([])
      expect(routerEnvWarnings(WITH_CF, { ...CF_ENV, CLOUDFLARE_ACCOUNT_ID: '' })).toHaveLength(1)
      // No Cloudflare route, or no readable config: nothing to warn about.
      expect(routerEnvWarnings(PARAMS, { ...CF_ENV, CLOUDFLARE_ACCOUNT_ID: bad })).toEqual([])
      expect(routerEnvWarnings('x', { ...CF_ENV, CLOUDFLARE_ACCOUNT_ID: bad })).toEqual([])
      expect(routerEnvWarnings({ routes: 'x' }, { ...CF_ENV, CLOUDFLARE_ACCOUNT_ID: bad })).toEqual(
        [],
      )
    })

    it('warns once, by route and reason, when the account id is set but the token is missing (F9)', () => {
      const env = { ...CF_ENV, CLOUDFLARE_AI_TOKEN: undefined }
      expect(routerEnvWarnings(WITH_CF, env)).toEqual([
        { route: 'cloudflare', reason: 'TOKEN_MISSING' },
      ])
      // Nothing set at all: the route was never configured, so nothing to warn about.
      expect(routerEnvWarnings(WITH_CF, { ...env, CLOUDFLARE_ACCOUNT_ID: undefined })).toEqual([])
      // No Cloudflare route in the config: the token's absence means nothing.
      expect(routerEnvWarnings(PARAMS, env)).toEqual([])
      // A malformed id keeps its own single warning.
      expect(routerEnvWarnings(WITH_CF, { ...env, CLOUDFLARE_ACCOUNT_ID: 'x' })).toEqual([
        { route: 'cloudflare', reason: 'ACCOUNT_ID_MALFORMED' },
      ])
    })

    it('warns once, by route and reason, when the token is set but the account id is missing (CR-L-1)', () => {
      const env = { ...CF_ENV, CLOUDFLARE_ACCOUNT_ID: undefined }
      expect(routerEnvWarnings(WITH_CF, env)).toEqual([
        { route: 'cloudflare', reason: 'ACCOUNT_ID_MISSING' },
      ])
      expect(JSON.stringify(routerEnvWarnings(WITH_CF, env))).not.toContain(
        CF_ENV.CLOUDFLARE_AI_TOKEN,
      )
      // Nothing set at all: the route was never configured, so nothing to warn about.
      expect(routerEnvWarnings(WITH_CF, { ...env, CLOUDFLARE_AI_TOKEN: undefined })).toEqual([])
      // No Cloudflare route in the config: the id's absence means nothing.
      expect(routerEnvWarnings(PARAMS, env)).toEqual([])
    })

    it('the worker env refuses an empty token and leaves a malformed account id to the route', () => {
      expect(extractionWorkerEnvSchema.safeParse({ CLOUDFLARE_AI_TOKEN: '' }).success).toBe(false)
      expect(extractionWorkerEnvSchema.safeParse({ CLOUDFLARE_ACCOUNT_ID: 'x' }).success).toBe(true)
    })
  })

  describe('the OpenRouter route (5.4c-H3)', () => {
    const OR = {
      provider: 'openrouter',
      models: ['meta-llama/llama-3.3-70b-instruct:free'],
      ...HOSTED_COMMON,
      minGapMs: 3_000,
      dataCollection: 'allow',
    }
    const WITH_OR = { ...RUNBOOK_SAMPLE, routes: [...RUNBOOK_SAMPLE.routes, OR] }

    it('fills OPENROUTER_API_KEY from env into a config the router accepts', () => {
      const cfg = buildRouterConfig(WITH_OR, { ...SAMPLE_ENV, OPENROUTER_API_KEY: 'O-ENV-KEY' })
      const { routes } = cfg as Routes
      expect(routes.map((r) => r.provider)).toEqual(['gemini', 'groq', 'cloudflare', 'openrouter'])
      expect(routes[3]).toEqual({ ...OR, apiKey: 'O-ENV-KEY' })
      expect(routerConfigSchema.safeParse(cfg).success).toBe(true)
    })

    it('drops the route when the key is absent, and never takes one from the JSON', () => {
      const smuggled = {
        ...WITH_OR,
        routes: [...RUNBOOK_SAMPLE.routes, { ...OR, apiKey: 'JSON-KEY' }],
      }
      const cfg = buildRouterConfig(smuggled, SAMPLE_ENV) as Routes
      expect(cfg.routes.map((r) => r.provider)).toEqual(['gemini', 'groq', 'cloudflare'])
      expect(JSON.stringify(cfg)).not.toContain('JSON-KEY')
    })

    it('a route without dataCollection is handed on, so the router refuses the config', () => {
      const { dataCollection: _d, ...bare } = OR
      const cfg = buildRouterConfig(
        { ...PARAMS, routes: [bare] },
        { OPENROUTER_API_KEY: 'O-ENV-KEY' },
      )
      expect(routerConfigSchema.safeParse(cfg).success).toBe(false)
    })

    it('OPENROUTER_API_KEY is no worker-only key: the API resume path reads the same name', () => {
      expect(WORKER_ONLY_ENV_KEYS).not.toContain('OPENROUTER_API_KEY')
      expect(validateEnv({ ...BASE_DEV, OPENROUTER_API_KEY: 'or-key' }).OPENROUTER_API_KEY).toBe(
        'or-key',
      )
    })
  })

  it('never takes a key or URL from the JSON parameters', () => {
    const smuggled = {
      ...PARAMS,
      routes: [
        { ...PARAMS.routes[0], apiKey: 'JSON-KEY', baseUrl: 'http://evil.example' },
        { ...PARAMS.routes[1], apiKey: 'JSON-KEY' },
      ],
    }
    const withEnv = buildRouterConfig(smuggled, FULL_ENV) as Routes
    expect(withEnv.routes[0]!.apiKey).toBe('G-ENV-KEY')
    expect(withEnv.routes[0]).not.toHaveProperty('baseUrl')
    expect(withEnv.routes[1]!.apiKey).toBe('Q-ENV-KEY')
    expect(JSON.stringify(buildRouterConfig(smuggled, {}))).not.toMatch(/JSON-KEY|evil/)
  })

  it('hands an unknown provider and a malformed config on unchanged, for the router to refuse', () => {
    const odd = { ...PARAMS, routes: [{ provider: 'mistral', apiKey: 'K' }] }
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
