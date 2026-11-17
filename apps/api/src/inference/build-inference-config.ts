import { isCloudflareAccountId, type InferenceConfig } from '@crm/inference'
import { z } from 'zod'
import type { Env } from '../config/env'
import { EXTRACTION_MODEL_GUARDRAILS } from './extraction-guardrails'

export type InferenceEnv = Partial<
  Pick<
    Env,
    | 'JEV_API_KEY'
    | 'OPENROUTER_API_KEY'
    | 'LOCAL_MODEL_URL'
    | 'LOCAL_MODEL_KEY'
    | 'LOCAL_MODEL_NAME'
    | 'INFERENCE_EXTRACTION_PROVIDER'
  >
>

/**
 * Maps env to the package config. A provider block exists only when its keys are present; provider
 * hosts are package constants (no base-URL env), and the OpenRouter block carries guardrails, never
 * a model id (the resolver picks the model at runtime).
 */
export function buildInferenceConfig(env: InferenceEnv): InferenceConfig {
  const cfg: InferenceConfig = {}

  if (env.JEV_API_KEY !== undefined) {
    cfg.decision = { jev: { apiKey: env.JEV_API_KEY } }
  }

  const provider = env.INFERENCE_EXTRACTION_PROVIDER
  if (provider === 'openrouter' && env.OPENROUTER_API_KEY !== undefined) {
    cfg.extraction = {
      provider: 'openrouter',
      openrouter: { apiKey: env.OPENROUTER_API_KEY, guardrails: EXTRACTION_MODEL_GUARDRAILS },
    }
  } else if (
    provider === 'local' &&
    env.LOCAL_MODEL_URL !== undefined &&
    env.LOCAL_MODEL_NAME !== undefined
  ) {
    cfg.extraction = {
      provider: 'local',
      local: {
        baseUrl: env.LOCAL_MODEL_URL,
        model: env.LOCAL_MODEL_NAME,
        ...(env.LOCAL_MODEL_KEY !== undefined && { apiKey: env.LOCAL_MODEL_KEY }),
      },
    }
  }

  return cfg
}

/**
 * The extraction worker's model keys (ADR §2.4, §3.3), parsed by the worker alone: the API's env
 * refuses the hosted keys (a source scan pins who names them). The router is hosted-only
 * (5.4c-H1): the local route's URL, model and key are no worker keys, and are not read.
 */
export const extractionWorkerEnvSchema = z.object({
  GEMINI_API_KEY: z.string().min(1).optional(),
  GROQ_API_KEY: z.string().min(1).optional(),
  // The same names the API's resume path reads (amendment 2026-11-17). Lenient here: an account id
  // outside the pattern drops the Cloudflare route instead of refusing the worker's whole env.
  CLOUDFLARE_AI_TOKEN: z.string().min(1).optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
})

export type RouterEnv = z.infer<typeof extractionWorkerEnvSchema>

const HOSTED_KEY_ENV = {
  gemini: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  cloudflare: 'CLOUDFLARE_AI_TOKEN',
} as const

function isRecord(v: unknown): v is Record<string, unknown> {
  // Stryker disable next-line ConditionalExpression: equivalent — a JSON string or number passed as a record has no `provider` or `routes`, so it is handed on unchanged either way
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** One hosted route with its secret from env; null when env lacks it (the route does not exist). */
function routeFromEnv(route: unknown, env: RouterEnv): unknown {
  if (!isRecord(route)) return route
  // The JSON parameters never carry a key, URL or account id: env alone supplies them (§2.4).
  const { apiKey: _k, baseUrl: _u, accountId: _a, ...params } = route
  if (route.provider === 'gemini' || route.provider === 'groq') {
    const apiKey = env[HOSTED_KEY_ENV[route.provider]]
    return apiKey === undefined ? null : { ...params, apiKey }
  }
  if (route.provider === 'cloudflare') {
    // The account id enters the URL path (the SR-M-8 exception): only 32 lower-case hex gets there.
    const { CLOUDFLARE_AI_TOKEN: apiKey, CLOUDFLARE_ACCOUNT_ID: accountId } = env
    // Stryker disable next-line StringLiteral: equivalent — any fallback outside 32 lower-case hex is refused like '' is
    if (apiKey === undefined || !isCloudflareAccountId(accountId ?? '')) return null
    return { ...params, apiKey, accountId }
  }
  // Any other provider, a stale `local` route included, goes on unchanged for the router to refuse.
  return route
}

export type RouterEnvWarning = {
  route: 'cloudflare'
  reason: 'ACCOUNT_ID_MALFORMED' | 'ACCOUNT_ID_MISSING' | 'TOKEN_MISSING'
}

/**
 * Why a configured Cloudflare route was dropped although part of its env is set (F6, F9, CR-L-1):
 * `routeFromEnv` drops it for a malformed account id, or for a missing id or token while the other
 * is set, which would otherwise be silent. Names only, never a value.
 */
export function routerEnvWarnings(params: unknown, env: RouterEnv): RouterEnvWarning[] {
  if (!isRecord(params) || !Array.isArray(params.routes)) return []
  const hasCloudflare = params.routes.some((r) => isRecord(r) && r.provider === 'cloudflare')
  if (!hasCloudflare) return []
  const id = env.CLOUDFLARE_ACCOUNT_ID
  if (id === undefined) {
    return env.CLOUDFLARE_AI_TOKEN === undefined
      ? []
      : [{ route: 'cloudflare', reason: 'ACCOUNT_ID_MISSING' }]
  }
  if (!isCloudflareAccountId(id)) return [{ route: 'cloudflare', reason: 'ACCOUNT_ID_MALFORMED' }]
  return env.CLOUDFLARE_AI_TOKEN === undefined
    ? [{ route: 'cloudflare', reason: 'TOKEN_MISSING' }]
    : []
}

/**
 * The extraction worker's router config: the non-secret route parameters (`EXTRACTION_ROUTER_CONFIG`)
 * plus the keys from env (ADR §2.4). A route whose env is absent is dropped — that provider does not
 * take part; with no route left the router refuses the config and answers `NOT_CONFIGURED`.
 * Anything malformed, a stale `local` route or `floorBudgetMs` included, is handed on unchanged for
 * the router to refuse (5.4c-H1).
 */
export function buildRouterConfig(params: unknown, env: RouterEnv): unknown {
  if (!isRecord(params) || !Array.isArray(params.routes)) return params
  const routes = params.routes.map((r) => routeFromEnv(r, env)).filter((r) => r !== null)
  return { ...params, routes }
}
