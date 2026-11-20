import { describe, expect, it } from 'vitest'
import {
  HOSTED_BASE_URLS,
  hostedBaseUrl,
  MAX_HOSTED_BUDGET_MS,
  ownCapOf,
  routerCallCeilingMs,
  routerConfigSchema,
  type RouterConfigInput,
} from './config'
import { isValidModelId, isValidProviderModelId } from '../internal/model-id'
import { CLOUDFLARE_CEILING_USD_PER_M, CLOUDFLARE_PINNED_MODEL_PRICES } from './cloudflare'

/** The withdrawn local route as a stale config still carries it (Amendment 2026-11-08). */
const staleLocal = {
  provider: 'local' as const,
  baseUrl: 'http://crm-model-runtime:11434/v1',
  model: 'qwen2.5:3b',
  contextTokens: 8192,
  structuredOutput: 'json_schema' as const,
  timeoutMs: 120_000,
  maxAnswerTokens: 600,
}
const groq = {
  provider: 'groq' as const,
  apiKey: 'k',
  models: ['openai/gpt-oss-20b'],
  contextTokens: 8000,
  structuredOutput: 'json_schema' as const,
  minGapMs: 3000,
  timeoutMs: 30_000,
  maxAnswerTokens: 800,
  freeLimit: { requestsPerDay: 1000 },
}
const ACCOUNT = '0123456789abcdef0123456789abcdef'
const cloudflare = {
  provider: 'cloudflare' as const,
  apiKey: 'k',
  accountId: ACCOUNT,
  models: ['@cf/mistralai/mistral-small-3.1-24b-instruct', '@cf/openai/gpt-oss-20b'],
  contextTokens: 16_000,
  structuredOutput: 'none' as const,
  minGapMs: 0,
  timeoutMs: 30_000,
  maxAnswerTokens: 2_048,
  freeLimit: { requestsPerDay: 16 },
}
const gemini = {
  ...groq,
  provider: 'gemini' as const,
  models: ['gemini-2.5-flash'],
}
const base = (routes: unknown, extra: object = {}): RouterConfigInput =>
  ({
    policyVersion: 'p1',
    hostedBudgetMs: 60_000,
    routes,
    ...extra,
  }) as RouterConfigInput

const ok = (cfg: unknown) => routerConfigSchema.safeParse(cfg).success

describe('routerConfigSchema (hosted-only, Amendment 2026-11-08 H.1)', () => {
  it('accepts one hosted route, and every hosted route in any order', () => {
    expect(ok(base([groq]))).toBe(true)
    expect(ok(base([gemini, groq, cloudflare]))).toBe(true)
    expect(ok(base([cloudflare, groq, gemini]))).toBe(true)
  })

  it('defaults rotate to true on a hosted route', () => {
    const parsed = routerConfigSchema.parse(base([groq]))
    expect(parsed.routes[0]).toMatchObject({ rotate: true })
  })

  it('refuses a stale config with a local route, first, last or alone, never stripping it', () => {
    expect(ok(base([staleLocal]))).toBe(false)
    expect(ok(base([groq, staleLocal]))).toBe(false)
    expect(ok(base([staleLocal, groq]))).toBe(false)
  })

  it('refuses a stale config that still carries floorBudgetMs', () => {
    expect(ok(base([groq], { floorBudgetMs: 720_000 }))).toBe(false)
  })

  it('refuses an empty route list and one longer than the provider allowlist', () => {
    expect(ok(base([]))).toBe(false)
    expect(ok(base([gemini, groq, cloudflare, { ...gemini }]))).toBe(false)
  })

  it.each([
    ['a string', 'routes'],
    ['null', null],
    ['an object', { 0: groq }],
    ['an array of non-objects', [1, 'x', null]],
    ['a route with a non-numeric timeout', [{ ...groq, timeoutMs: 'slow' }]],
  ])('refuses routes given as %s without throwing (the refines stay total)', (_label, routes) => {
    expect(() => routerConfigSchema.safeParse(base(routes))).not.toThrow()
    expect(ok(base(routes))).toBe(false)
  })

  it('refuses a hosted provider listed twice and a provider outside the allowlist', () => {
    expect(ok(base([groq, groq]))).toBe(false)
    expect(ok(base([groq]))).toBe(true)
    const foreign = routerConfigSchema.safeParse(base([{ ...groq, provider: 'mistral' }]))
    expect(foreign.success).toBe(false)
    // Refused for its provider, not for anything else on the otherwise valid Groq route.
    expect(foreign.error?.issues.map((i) => i.path.join('.'))).toEqual(['routes.0.provider'])
  })

  it('refuses a hosted model id outside the provider family', () => {
    expect(ok(base([{ ...groq, models: ['llama-3.1-8b-instant'] }]))).toBe(false)
    expect(ok(base([{ ...groq, models: [] }]))).toBe(false)
    expect(ok(base([{ ...groq, models: ['openai/gpt-oss-20b', 'llama-3.1-8b-instant'] }]))).toBe(
      false,
    )
  })

  it('refuses a hosted route without a key and any foreign field (a base URL included)', () => {
    const { apiKey: _k, ...noKey } = groq
    expect(ok(base([noKey]))).toBe(false)
    expect(ok(base([{ ...groq, baseUrl: 'https://evil.test' }]))).toBe(false)
    expect(ok(base([groq], { extra: 1 }))).toBe(false)
  })

  it('refuses a hosted budget that cannot hold one whole request of the slowest route', () => {
    const slow = { ...gemini, timeoutMs: 45_000 }
    expect(ok(base([groq, slow], { hostedBudgetMs: 44_999 }))).toBe(false)
    expect(ok(base([groq, slow], { hostedBudgetMs: 45_000 }))).toBe(true)
    expect(ok(base([slow, groq], { hostedBudgetMs: 44_999 }))).toBe(false)
  })

  it('refuses a zero or negative hosted budget, and one above the package maximum', () => {
    expect(ok(base([{ ...groq, timeoutMs: 1 }], { hostedBudgetMs: 0 }))).toBe(false)
    expect(ok(base([{ ...groq, timeoutMs: 1 }], { hostedBudgetMs: -1 }))).toBe(false)
    expect(ok(base([{ ...groq, timeoutMs: 1 }], { hostedBudgetMs: 1 }))).toBe(true)
    expect(ok(base([groq], { hostedBudgetMs: MAX_HOSTED_BUDGET_MS + 1 }))).toBe(false)
    expect(ok(base([groq], { hostedBudgetMs: MAX_HOSTED_BUDGET_MS }))).toBe(true)
  })

  it('accepts the #1377 runbook sample once its withdrawn floorBudgetMs is gone (AC6)', () => {
    const sample = {
      policyVersion: 'hosted-2026-11-17',
      hostedBudgetMs: 90000,
      routes: [
        {
          ...gemini,
          models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
          contextTokens: 32000,
          minGapMs: 4000,
          maxAnswerTokens: 2000,
          freeLimit: { requestsPerDay: 20 },
        },
        {
          ...groq,
          models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
          minGapMs: 2000,
          maxAnswerTokens: 2000,
          freeLimit: { requestsPerDay: 1000, tokensPerDay: 200000 },
        },
        {
          ...cloudflare,
          models: [
            '@cf/mistralai/mistral-small-3.1-24b-instruct',
            '@cf/openai/gpt-oss-20b',
            '@cf/google/gemma-4-26b-a4b-it',
          ],
          minGapMs: 2000,
        },
      ],
    }
    expect(ok(sample)).toBe(true)
    expect(ok({ ...sample, floorBudgetMs: 180000 })).toBe(false)
  })
})

describe('routerConfigSchema: the cloudflare route (amendment 2026-11-17)', () => {
  it('accepts a cloudflare route with its account id, and all three hosted routes', () => {
    expect(ok(base([cloudflare]))).toBe(true)
    expect(ok(base([gemini, groq, cloudflare]))).toBe(true)
  })

  it('refuses more than four routes', () => {
    expect(ok(base([gemini, groq, cloudflare, { ...gemini }]))).toBe(false)
  })

  it('refuses a cloudflare route without an account id or with one outside 32 lower-case hex', () => {
    const { accountId: _a, ...noAccount } = cloudflare
    expect(ok(base([noAccount]))).toBe(false)
    expect(ok(base([{ ...cloudflare, accountId: ACCOUNT.toUpperCase() }]))).toBe(false)
    expect(ok(base([{ ...cloudflare, accountId: `${ACCOUNT}/../x` }]))).toBe(false)
    expect(ok(base([{ ...cloudflare, accountId: ACCOUNT.slice(1) }]))).toBe(false)
  })

  it('refuses an account id on any other hosted route', () => {
    expect(ok(base([{ ...groq, accountId: ACCOUNT }]))).toBe(false)
    expect(ok(base([{ ...gemini, accountId: ACCOUNT }]))).toBe(false)
  })

  it('refuses a cloudflare model id outside @cf/<vendor>/<name>', () => {
    expect(ok(base([{ ...cloudflare, models: ['openai/gpt-oss-20b'] }]))).toBe(false)
  })

  it('pins only checked-in Cloudflare models priced at or under the ceiling (F4)', () => {
    const pins = [
      '@cf/mistralai/mistral-small-3.1-24b-instruct',
      '@cf/openai/gpt-oss-20b',
      '@cf/google/gemma-4-26b-a4b-it',
    ]
    expect(ok(base([{ ...cloudflare, models: pins }]))).toBe(true)
    for (const extra of ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/openai/gpt-oss-120b']) {
      expect(ok(base([{ ...cloudflare, models: [...pins, extra] }]))).toBe(false)
    }
    // The pin list is Cloudflare's alone: another provider's ids are not held to it.
    expect(ok(base([groq, cloudflare]))).toBe(true)
  })

  it('every checked-in Cloudflare pin is priced at or under the ceiling the own cap uses', () => {
    for (const { input, output } of Object.values(CLOUDFLARE_PINNED_MODEL_PRICES)) {
      expect(input).toBeGreaterThan(0)
      expect(output).toBeGreaterThan(0)
      expect(input).toBeLessThanOrEqual(CLOUDFLARE_CEILING_USD_PER_M.input)
      expect(output).toBeLessThanOrEqual(CLOUDFLARE_CEILING_USD_PER_M.output)
    }
    expect(Object.keys(CLOUDFLARE_PINNED_MODEL_PRICES)).toHaveLength(3)
  })

  it('refuses a free limit whose worst-case calls exceed 10 000 Neurons a day', () => {
    expect(ok(base([{ ...cloudflare, freeLimit: { requestsPerDay: 17 } }]))).toBe(false)
    expect(ok(base([{ ...cloudflare, maxAnswerTokens: 4_096 }]))).toBe(false)
  })

  it('does not hold other providers to the Neurons allowance', () => {
    expect(ok(base([{ ...groq, contextTokens: 131_072, maxAnswerTokens: 8_000 }]))).toBe(true)
  })

  it('keeps the account id on the parsed route', () => {
    expect(routerConfigSchema.parse(base([cloudflare])).routes[0]).toMatchObject({
      accountId: ACCOUNT,
    })
  })
})

describe('hostedBaseUrl', () => {
  it('is the package constant for gemini and groq', () => {
    expect(hostedBaseUrl({ provider: 'gemini' })).toBe(HOSTED_BASE_URLS.gemini)
    expect(hostedBaseUrl({ provider: 'groq' })).toBe(HOSTED_BASE_URLS.groq)
  })

  it('builds the cloudflare URL from the account id', () => {
    expect(hostedBaseUrl({ provider: 'cloudflare', accountId: ACCOUNT })).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/v1`,
    )
  })

  it('throws for a cloudflare route without a valid account id', () => {
    expect(() => hostedBaseUrl({ provider: 'cloudflare' })).toThrow()
    expect(() => hostedBaseUrl({ provider: 'cloudflare', accountId: 'evil.example' })).toThrow()
  })
})

describe('ceiling, own cap and constants', () => {
  it('routerCallCeilingMs is the hosted budget (H.1)', () => {
    expect(routerCallCeilingMs({ hostedBudgetMs: 45_000 })).toBe(45_000)
    expect(routerCallCeilingMs({ hostedBudgetMs: MAX_HOSTED_BUDGET_MS })).toBe(120_000)
  })

  // D5 amended by the owner 2026-11-20: 100 % of the free limit, except Cloudflare at 50 %.
  it.each(['gemini', 'groq', 'openrouter'] as const)(
    'ownCapOf(%s) is the whole free limit',
    (p) => {
      expect(ownCapOf(p, 1000)).toBe(1000)
      expect(ownCapOf(p, 9)).toBe(9)
    },
  )

  it('ownCapOf(cloudflare) is half the free limit, rounded down', () => {
    expect(ownCapOf('cloudflare', 1000)).toBe(500)
    expect(ownCapOf('cloudflare', 9)).toBe(4)
    expect(ownCapOf('cloudflare', 1)).toBe(0)
  })

  it('hosted hosts are HTTPS constants', () => {
    expect(Object.values(HOSTED_BASE_URLS).every((u) => u.startsWith('https://'))).toBe(true)
  })
})

describe('model id validation', () => {
  it.each(['qwen2.5:3b', 'hf.co/org/model:Q4_K_M', 'gemma-3-4b', 'a'.repeat(128)])(
    'accepts %s',
    (id) => {
      expect(isValidModelId(id)).toBe(true)
    },
  )

  it.each([
    '',
    'a'.repeat(129),
    '/abs',
    'a/../b',
    'a b',
    'a\nb',
    'a:b:c',
    'http://x',
    'mödel',
    'a\u0000b',
  ])('refuses %j', (id) => {
    expect(isValidModelId(id)).toBe(false)
  })

  it('applies the provider family pattern to hosted providers', () => {
    expect(isValidProviderModelId('groq', 'openai/gpt-oss-120b')).toBe(true)
    expect(isValidProviderModelId('groq', 'openai/gpt-oss-20b-preview')).toBe(false)
    expect(isValidProviderModelId('groq', 'xopenai/gpt-oss-20b')).toBe(false)
    expect(isValidProviderModelId('gemini', 'gemini-2.5-flash')).toBe(true)
    expect(isValidProviderModelId('gemini', 'models/gemini-2.5-flash')).toBe(false)
  })
})
