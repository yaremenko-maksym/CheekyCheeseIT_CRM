import { z } from 'zod'
import { isValidProviderModelId } from '../internal/model-id'
import {
  cloudflareChatBaseUrl,
  fitsCloudflareAllowance,
  isCloudflareAccountId,
  isCloudflarePinnableModel,
} from './cloudflare'
import {
  OPENROUTER_BASE_URL,
  OPENROUTER_DATA_COLLECTION,
  OPENROUTER_IGNORE_MAX,
  OPENROUTER_PROVIDER_SLUG,
} from './openrouter'

/**
 * The checked-in hosted provider allowlist (ADR §2.1; Cloudflare Workers AI by the amendment of
 * 2026-11-17; OpenRouter, free models only, by §3.5 and Amendment 2026-11-08 H.5).
 */
export const HOSTED_PROVIDERS = ['gemini', 'groq', 'cloudflare', 'openrouter'] as const
export type HostedProvider = (typeof HOSTED_PROVIDERS)[number]
/** Hosted routes only: the local floor is withdrawn (Amendment 2026-11-08, H.1). */
export type RouterProvider = HostedProvider

/** Hosted hosts are HTTPS package constants; no env or config can point a hosted route elsewhere (§3.3). */
export const HOSTED_BASE_URLS = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: OPENROUTER_BASE_URL,
} as const satisfies Record<Exclude<HostedProvider, 'cloudflare'>, string>

/**
 * The base URL of a hosted route. Cloudflare's carries the account id under a constant host; the
 * builder re-checks the id, so a route that skipped the schema still cannot steer the request.
 */
export function hostedBaseUrl(route: {
  provider: HostedProvider
  accountId?: string | undefined
}): string {
  // Stryker disable next-line StringLiteral: equivalent — any fallback outside 32 lower-case hex throws like '' does
  if (route.provider === 'cloudflare') return cloudflareChatBaseUrl(route.accountId ?? '')
  return HOSTED_BASE_URLS[route.provider]
}

/** Package maximum of the hosted budget (§5.5): the router call's absolute ceiling (H.1). */
export const MAX_HOSTED_BUDGET_MS = 120_000
/** Own caps sit at 50 % of each provider's configured free limit (owner decision D5). */
export const OWN_CAP_SHARE = 0.5

const STRUCTURED_OUTPUT = z.enum(['json_schema', 'json_object', 'none'])
const positiveInt = z.number().int().positive()

const hostedRouteSchema = z
  .object({
    provider: z.enum(HOSTED_PROVIDERS),
    apiKey: z.string().min(1),
    /** Cloudflare only: the account the URL path names (32 lower-case hex, the SR-M-8 exception). */
    accountId: z.string().refine(isCloudflareAccountId).optional(),
    /** OpenRouter only, and required there with no default: `provider.data_collection` (D11). */
    dataCollection: z.enum(OPENROUTER_DATA_COLLECTION).optional(),
    /** OpenRouter only: `provider.ignore` (OD-2: empty). */
    providerIgnore: z
      .array(z.string().regex(OPENROUTER_PROVIDER_SLUG))
      .max(OPENROUTER_IGNORE_MAX)
      .optional(),
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
  // Every model id in the provider's family; issues carry no detail, a config holds a key.
  .refine((r) => r.models.every((m) => isValidProviderModelId(r.provider, m)))
  // The own cap prices a call at the ceiling, so a Cloudflare pin must be a checked-in id priced under it.
  .refine((r) => r.provider !== 'cloudflare' || r.models.every(isCloudflarePinnableModel))
  // The account id belongs to the cloudflare route and to no other.
  .refine((r) => (r.provider === 'cloudflare') === (r.accountId !== undefined))
  // `dataCollection` belongs to the openrouter route, which cannot be built without it (§3.5 check 3).
  .refine((r) => (r.provider === 'openrouter') === (r.dataCollection !== undefined))
  .refine((r) => r.provider === 'openrouter' || r.providerIgnore === undefined)
  // Cloudflare's free limit is 10 000 Neurons, not requests: the configured request count must fit
  // it at the worst-case call (amendment 2026-11-17), so the own cap at 50 % fits half of it.
  .refine(
    (r) =>
      r.provider !== 'cloudflare' ||
      fitsCloudflareAllowance({
        requestsPerDay: r.freeLimit.requestsPerDay,
        contextTokens: r.contextTokens,
        maxAnswerTokens: r.maxAnswerTokens,
      }),
  )

export const routerConfigSchema = z
  .object({
    /** Own-cap limits are frozen under this version (D5). */
    policyVersion: z.string().min(1).max(64),
    hostedBudgetMs: positiveInt.max(MAX_HOSTED_BUDGET_MS),
    // Strict and hosted-only: a stale `local` route or `floorBudgetMs` is refused, never stripped (H.1).
    routes: z.array(hostedRouteSchema).min(1).max(HOSTED_PROVIDERS.length),
  })
  .strict()
  // Every provider once. Total (SR-H-65): Zod runs refines after `routes` failed, so an element may
  // be any value; optional chaining keeps a non-object from throwing out of `safeParse`.
  .refine((cfg) => new Set(cfg.routes.map((r) => r?.provider)).size === cfg.routes.length)
  // The budget holds one whole request of the slowest route (§5.5). NaN from a bad timeout refuses.
  .refine((cfg) => cfg.hostedBudgetMs >= Math.max(0, ...cfg.routes.map((r) => r?.timeoutMs)))

export type RouterConfig = z.infer<typeof routerConfigSchema>
export type RouterConfigInput = z.input<typeof routerConfigSchema>
export type HostedRouteConfig = z.infer<typeof hostedRouteSchema>

/** The router call's absolute ceiling: the hosted budget, now that no floor follows it (H.1). */
export function routerCallCeilingMs(config: Pick<RouterConfig, 'hostedBudgetMs'>): number {
  return config.hostedBudgetMs
}

/** The own daily cap derived from a free limit: never above `OWN_CAP_SHARE` of it (D5). */
export function ownCapOf(freeLimit: number): number {
  return Math.floor(freeLimit * OWN_CAP_SHARE)
}
