import { describe, expect, it } from 'vitest'
import { MAX_SMALL_DOSE_GROUPS } from '../contracts/extraction'
import {
  HOSTED_BASE_URLS,
  hostedBaseUrl,
  LOCAL_TIMEOUT_LIMIT_MS,
  localRuntimeKey,
  isAllowedRouterLocalModelUrl,
  MAX_FLOOR_BUDGET_MS,
  ownCapOf,
  routerCallCeilingMs,
  routerConfigSchema,
  type RouterConfigInput,
} from './config'
import { isValidModelId, isValidProviderModelId } from '../internal/model-id'
import { CLOUDFLARE_CEILING_USD_PER_M, CLOUDFLARE_PINNED_MODEL_PRICES } from './cloudflare'

const local = {
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
const base = (routes: unknown[], extra: object = {}): RouterConfigInput =>
  ({
    policyVersion: 'p1',
    hostedBudgetMs: 60_000,
    floorBudgetMs: 720_000,
    routes,
    ...extra,
  }) as RouterConfigInput

const ok = (cfg: unknown) => routerConfigSchema.safeParse(cfg).success

describe('routerConfigSchema', () => {
  it('accepts a local-only config and a hosted route in front of the local floor', () => {
    expect(ok(base([local]))).toBe(true)
    expect(ok(base([groq, local]))).toBe(true)
  })

  it('defaults rotate to true on a hosted route', () => {
    const parsed = routerConfigSchema.parse(base([groq, local]))
    expect(parsed.routes[0]).toMatchObject({ rotate: true })
  })

  it('refuses a config without a local route, with the local route not last, or with two', () => {
    expect(ok(base([groq]))).toBe(false)
    expect(ok(base([local, groq]))).toBe(false)
    expect(ok(base([local, local]))).toBe(false)
    expect(ok(base([]))).toBe(false)
  })

  it('refuses a hosted provider listed twice and a provider outside the allowlist', () => {
    expect(ok(base([groq, groq, local]))).toBe(false)
    expect(ok(base([{ ...groq, provider: 'openrouter' }, local]))).toBe(false)
  })

  it('refuses a hosted model id outside the provider family, and an invalid local model id', () => {
    expect(ok(base([{ ...groq, models: ['llama-3.1-8b-instant'] }, local]))).toBe(false)
    expect(ok(base([{ ...groq, models: [] }, local]))).toBe(false)
    expect(
      ok(base([{ ...groq, models: ['openai/gpt-oss-20b', 'llama-3.1-8b-instant'] }, local])),
    ).toBe(false)
    expect(ok(base([{ ...local, model: '../etc/passwd' }]))).toBe(false)
  })

  it('refuses a hosted route without a key and any foreign field (a base URL included)', () => {
    const { apiKey: _k, ...noKey } = groq
    expect(ok(base([noKey, local]))).toBe(false)
    expect(ok(base([{ ...groq, baseUrl: 'https://evil.test' }, local]))).toBe(false)
    expect(ok(base([local], { extra: 1 }))).toBe(false)
  })

  it('refuses a local timeout of 300 s or more (§8.4) and accepts one just below', () => {
    expect(ok(base([{ ...local, timeoutMs: 300_000 }], { floorBudgetMs: 1_800_000 }))).toBe(false)
    expect(ok(base([{ ...local, timeoutMs: 299_999 }], { floorBudgetMs: 1_800_000 }))).toBe(true)
  })

  it('refuses a floor budget that cannot give every group of a full table one request (§5.5 item 2)', () => {
    const fullTable = MAX_SMALL_DOSE_GROUPS * local.timeoutMs
    expect(ok(base([local], { floorBudgetMs: fullTable - 1 }))).toBe(false)
    expect(ok(base([local], { floorBudgetMs: fullTable }))).toBe(true)
  })

  it('caps the table at six groups and lets the floor maximum hold a full table at the local limit', () => {
    expect(MAX_SMALL_DOSE_GROUPS).toBe(6)
    expect(MAX_FLOOR_BUDGET_MS).toBe(MAX_SMALL_DOSE_GROUPS * LOCAL_TIMEOUT_LIMIT_MS)
  })

  it('refuses budgets above the package maxima', () => {
    expect(ok(base([local], { hostedBudgetMs: 120_001 }))).toBe(false)
    expect(ok(base([local], { hostedBudgetMs: 120_000 }))).toBe(true)
    expect(ok(base([local], { floorBudgetMs: 1_800_001 }))).toBe(false)
    expect(ok(base([local], { floorBudgetMs: 1_800_000 }))).toBe(true)
  })

  it('refuses a local key over plain HTTP and accepts it over https', () => {
    expect(ok(base([{ ...local, apiKey: 'k' }]))).toBe(false)
    expect(ok(base([{ ...local, apiKey: 'k', baseUrl: 'https://10.0.0.5/v1' }]))).toBe(true)
    expect(ok(base([{ ...local, apiKey: 'key-123', baseUrl: 'https://10.0.0.5/v1' }]))).toBe(true)
    expect(ok(base([{ ...local, apiKey: '', baseUrl: 'https://10.0.0.5/v1' }]))).toBe(false)
  })

  it.each(['', 'https://u:KEY_MARKER@[x', 'gsk_LIVEKEY_pasted_here'])(
    'a key with an unparsable local URL %j is refused without throwing (SR-H-65)',
    (baseUrl) => {
      const r = routerConfigSchema.safeParse(base([{ ...local, apiKey: 'k', baseUrl }]))
      expect(r.success).toBe(false)
      expect(JSON.stringify(r.error?.issues)).not.toContain('KEY_MARKER')
    },
  )

  it('refuses a config whose local URL is refused', () => {
    expect(ok(base([{ ...local, baseUrl: 'http://169.254.169.254/v1' }]))).toBe(false)
  })
})

describe('routerConfigSchema: the cloudflare route (amendment 2026-11-17)', () => {
  it('accepts a cloudflare route with its account id, and all three hosted routes before the floor', () => {
    expect(ok(base([cloudflare, local]))).toBe(true)
    expect(ok(base([gemini, groq, cloudflare, local]))).toBe(true)
  })

  it('refuses more than four routes', () => {
    expect(ok(base([gemini, groq, cloudflare, { ...gemini }, local]))).toBe(false)
  })

  it('refuses a cloudflare route without an account id or with one outside 32 lower-case hex', () => {
    const { accountId: _a, ...noAccount } = cloudflare
    expect(ok(base([noAccount, local]))).toBe(false)
    expect(ok(base([{ ...cloudflare, accountId: ACCOUNT.toUpperCase() }, local]))).toBe(false)
    expect(ok(base([{ ...cloudflare, accountId: `${ACCOUNT}/../x` }, local]))).toBe(false)
    expect(ok(base([{ ...cloudflare, accountId: ACCOUNT.slice(1) }, local]))).toBe(false)
  })

  it('refuses an account id on any other hosted route', () => {
    expect(ok(base([{ ...groq, accountId: ACCOUNT }, local]))).toBe(false)
    expect(ok(base([{ ...gemini, accountId: ACCOUNT }, local]))).toBe(false)
  })

  it('refuses a cloudflare model id outside @cf/<vendor>/<name>', () => {
    expect(ok(base([{ ...cloudflare, models: ['openai/gpt-oss-20b'] }, local]))).toBe(false)
  })

  it('pins only checked-in Cloudflare models priced at or under the ceiling (F4)', () => {
    const pins = [
      '@cf/mistralai/mistral-small-3.1-24b-instruct',
      '@cf/openai/gpt-oss-20b',
      '@cf/google/gemma-4-26b-a4b-it',
    ]
    expect(ok(base([{ ...cloudflare, models: pins }, local]))).toBe(true)
    for (const extra of ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/openai/gpt-oss-120b']) {
      expect(ok(base([{ ...cloudflare, models: [...pins, extra] }, local]))).toBe(false)
    }
    // The pin list is Cloudflare's alone: another provider's ids are not held to it.
    expect(ok(base([groq, cloudflare, local]))).toBe(true)
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
    expect(ok(base([{ ...cloudflare, freeLimit: { requestsPerDay: 17 } }, local]))).toBe(false)
    expect(ok(base([{ ...cloudflare, maxAnswerTokens: 4_096 }, local]))).toBe(false)
  })

  it('does not hold other providers to the Neurons allowance', () => {
    expect(ok(base([{ ...groq, contextTokens: 131_072, maxAnswerTokens: 8_000 }, local]))).toBe(
      true,
    )
  })

  it('keeps the account id on the parsed route', () => {
    expect(routerConfigSchema.parse(base([cloudflare, local])).routes[0]).toMatchObject({
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

describe('isAllowedRouterLocalModelUrl (ADR §3.3)', () => {
  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:11434/v1',
    'http://[::1]:11434/v1',
    'http://crm-model-runtime:11434/v1',
    'https://crm-model-runtime/v1',
    'https://localhost/v1',
    'https://10.1.2.3/v1',
    'https://172.16.0.1/v1',
    'https://172.31.255.255/v1',
    'https://192.168.1.1/v1',
    'https://[fd12:3456::1]/v1',
    'https://[fc00::1]/v1',
  ])('allows %s', (url) => {
    expect(isAllowedRouterLocalModelUrl(url)).toBe(true)
  })

  it.each([
    ['http to a private address', 'http://10.1.2.3/v1'],
    ['http to a foreign name', 'http://model.example.com/v1'],
    ['https to a foreign name', 'https://model.example.com/v1'],
    ['https to a public address', 'https://8.8.8.8/v1'],
    ['link-local v4 (cloud metadata)', 'https://169.254.169.254/v1'],
    ['link-local v6', 'https://[fe80::1]/v1'],
    ['IPv4-mapped loopback', 'http://[::ffff:127.0.0.1]/v1'],
    ['IPv4-mapped private', 'https://[::ffff:10.0.0.1]/v1'],
    ['credentials', 'http://user:pw@localhost/v1'],
    ['a username only', 'https://user@10.0.0.1/v1'],
    ['172.15 is not private', 'https://172.15.0.1/v1'],
    ['172.32 is not private', 'https://172.32.0.1/v1'],
    ['192.169 is not private', 'https://192.169.0.1/v1'],
    ['11.x is not private', 'https://11.0.0.1/v1'],
    ['a fe00 v6 is not unique-local', 'https://[fe00::1]/v1'],
    ['a short fc hextet is not fc00::/7', 'https://[fc::1]/v1'],
    ['a password without a username', 'https://:pw@10.0.0.1/v1'],
    ['a name that starts like a private address', 'https://10.evil.com/v1'],
    ['a private address followed by a domain', 'https://10.0.0.1.evil.com/v1'],
    ['a 16-31 second octet outside 172', 'https://11.16.0.1/v1'],
    ['a 168 second octet outside 192', 'https://193.168.0.1/v1'],
    ['an unparsable string', '::not-a-url'],
    ['a container-like name', 'http://crm-model-runtime.evil/v1'],
    ['another scheme', 'ftp://localhost/v1'],
    ['not a URL', 'localhost:11434'],
  ])('refuses %s', (_label, url) => {
    expect(isAllowedRouterLocalModelUrl(url)).toBe(false)
  })
})

describe('localRuntimeKey (SR-L-71)', () => {
  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:11434/v1',
    'http://[::1]:11434/v1',
    'http://crm-model-runtime:11434/v1',
    'https://localhost/v1',
    'http://LOCALHOST:8080',
  ])('%s is the one local runtime', (url) => {
    expect(localRuntimeKey(url)).toBe('local-runtime')
  })

  it('a private address is its own origin', () => {
    expect(localRuntimeKey('https://10.0.0.5:8443/v1')).toBe('https://10.0.0.5:8443')
    expect(localRuntimeKey('https://10.0.0.6/v1')).toBe('https://10.0.0.6')
  })
})

describe('ceiling, own cap and constants', () => {
  it('routerCallCeilingMs is the sum of the two budgets', () => {
    expect(routerCallCeilingMs({ hostedBudgetMs: 45_000, floorBudgetMs: 130_000 })).toBe(175_000)
  })

  it('ownCapOf is half the free limit, rounded down', () => {
    expect(ownCapOf(1000)).toBe(500)
    expect(ownCapOf(9)).toBe(4)
    expect(ownCapOf(1)).toBe(0)
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
    expect(isValidProviderModelId('local', 'qwen2.5:3b')).toBe(true)
  })
})
