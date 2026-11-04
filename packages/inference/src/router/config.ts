import { z } from 'zod'
import { LOCAL_MODEL_RUNTIME_HOST } from '../http/bounded-request'
import { isValidModelId, isValidProviderModelId } from '../internal/model-id'

/** The checked-in hosted provider allowlist (ADR §2.1, D3: no OpenRouter in this version). */
export const HOSTED_PROVIDERS = ['gemini', 'groq'] as const
export type HostedProvider = (typeof HOSTED_PROVIDERS)[number]
export type RouterProvider = HostedProvider | 'local'

/** Hosted hosts are HTTPS package constants; no env or config can point a hosted route elsewhere (§3.3). */
export const HOSTED_BASE_URLS: Record<HostedProvider, string> = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  groq: 'https://api.groq.com/openai/v1',
}

/** Package maxima of the two budgets (§5.5); their sum is the call's absolute ceiling. */
export const MAX_HOSTED_BUDGET_MS = 120_000
export const MAX_FLOOR_BUDGET_MS = 600_000
/** The local route refuses a timeout of 300 s or more until the leaf streams (§8.4). */
export const LOCAL_TIMEOUT_LIMIT_MS = 300_000
/** Own caps sit at 50 % of each provider's configured free limit (owner decision D5). */
export const OWN_CAP_SHARE = 0.5

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** RFC 1918 IPv4 (the WHATWG parser has already normalised every numeric form to dotted quad). */
function isPrivateIpv4(host: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host)
  if (m === null) return false
  const a = Number(m[1])
  const b = Number(m[2])
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** fc00::/7 — the first hextet, unabbreviated after normalisation, is `fcXX` or `fdXX`. */
function isUniqueLocalIpv6(host: string): boolean {
  return /^\[f[cd][0-9a-f]{2}:/i.test(host)
}

/**
 * `ROUTER_LOCAL_MODEL_URL` (ADR §3.3): no credentials; plain `http` only to loopback or the one
 * runtime container name (a package constant); `https` to those or a private address. Link-local,
 * IPv4-mapped forms and every other name or address are refused.
 */
export function isAllowedRouterLocalModelUrl(raw: string): boolean {
  if (!URL.canParse(raw)) return false
  const url = new URL(raw)
  if (url.username !== '' || url.password !== '') return false
  const host = url.hostname
  const named = LOOPBACK_HOSTS.has(host) || host === LOCAL_MODEL_RUNTIME_HOST
  if (url.protocol === 'http:') return named
  return url.protocol === 'https:' && (named || isPrivateIpv4(host) || isUniqueLocalIpv6(host))
}

const STRUCTURED_OUTPUT = z.enum(['json_schema', 'json_object', 'none'])
const positiveInt = z.number().int().positive()

const hostedRouteSchema = z
  .object({
    provider: z.enum(HOSTED_PROVIDERS),
    apiKey: z.string().min(1),
    /** The pinned fallback list; the managed list supersedes it while valid (§3.4). */
    models: z.array(z.string()).min(1).max(16),
    contextTokens: positiveInt,
    structuredOutput: STRUCTURED_OUTPUT,
    minGapMs: z.number().int().nonnegative(),
    rotate: z.boolean().default(true),
    timeoutMs: positiveInt.max(MAX_HOSTED_BUDGET_MS),
    maxAnswerTokens: positiveInt,
    /** The provider's published free limit; the own cap is `OWN_CAP_SHARE` of it (D5). */
    freeLimit: z
      .object({ requestsPerDay: positiveInt, tokensPerDay: positiveInt.optional() })
      .strict(),
  })
  .strict()
  .refine((r) => r.models.every((m) => isValidProviderModelId(r.provider, m)), {
    message: 'model id outside the provider family',
    path: ['models'],
  })

const localRouteSchema = z
  .object({
    provider: z.literal('local'),
    baseUrl: z.string().refine(isAllowedRouterLocalModelUrl, 'ROUTER_LOCAL_MODEL_URL refused'),
    model: z.string().refine(isValidModelId, 'invalid model id'),
    apiKey: z.string().min(1).optional(),
    contextTokens: positiveInt,
    structuredOutput: STRUCTURED_OUTPUT,
    timeoutMs: positiveInt.lt(LOCAL_TIMEOUT_LIMIT_MS),
    maxAnswerTokens: positiveInt,
  })
  .strict()
  // A key over plain HTTP is a config error (SR-L-63), refused here rather than on every call.
  .refine((r) => r.apiKey === undefined || new URL(r.baseUrl).protocol === 'https:', {
    message: 'a local key needs https',
    path: ['apiKey'],
  })

export const routerConfigSchema = z
  .object({
    /** Own-cap limits are frozen under this version (D5). */
    policyVersion: z.string().min(1).max(64),
    hostedBudgetMs: z.number().int().nonnegative().max(MAX_HOSTED_BUDGET_MS),
    floorBudgetMs: positiveInt.max(MAX_FLOOR_BUDGET_MS),
    routes: z
      .array(z.union([hostedRouteSchema, localRouteSchema]))
      .min(1)
      .max(3),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const last = cfg.routes.at(-1)
    const locals = cfg.routes.filter((r) => r.provider === 'local')
    if (last?.provider !== 'local' || locals.length !== 1) {
      ctx.addIssue({ code: 'custom', message: 'exactly one local route, last', path: ['routes'] })
    }
    const hosted = cfg.routes.map((r) => r.provider).filter((p) => p !== 'local')
    if (new Set(hosted).size !== hosted.length) {
      ctx.addIssue({ code: 'custom', message: 'a hosted provider listed twice', path: ['routes'] })
    }
    // The floor must be able to give its request a whole timeout (§5.5 item 2).
    if (last?.provider === 'local' && cfg.floorBudgetMs < last.timeoutMs) {
      ctx.addIssue({
        code: 'custom',
        message: 'floor budget below one request',
        path: ['floorBudgetMs'],
      })
    }
  })

export type RouterConfig = z.infer<typeof routerConfigSchema>
export type RouterConfigInput = z.input<typeof routerConfigSchema>
export type HostedRouteConfig = z.infer<typeof hostedRouteSchema>
export type LocalRouteConfig = z.infer<typeof localRouteSchema>

/** The router call's absolute ceiling: the hosted budget plus the floor's (§5.5 item 2). */
export function routerCallCeilingMs(
  config: Pick<RouterConfig, 'hostedBudgetMs' | 'floorBudgetMs'>,
): number {
  return config.hostedBudgetMs + config.floorBudgetMs
}

/** The own daily cap derived from a free limit: never above `OWN_CAP_SHARE` of it (D5). */
export function ownCapOf(freeLimit: number): number {
  return Math.floor(freeLimit * OWN_CAP_SHARE)
}
