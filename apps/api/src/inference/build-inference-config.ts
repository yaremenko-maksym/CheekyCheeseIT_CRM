import { isAllowedRouterLocalModelUrl, type InferenceConfig } from '@crm/inference'
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
 * refuses the hosted keys and `ROUTER_LOCAL_MODEL_URL` (a source scan pins who names them).
 * `LOCAL_MODEL_KEY` and `LOCAL_MODEL_NAME` mean the same in both processes.
 */
export const extractionWorkerEnvSchema = z.object({
  LOCAL_MODEL_KEY: z.string().min(1).optional(),
  LOCAL_MODEL_NAME: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GROQ_API_KEY: z.string().min(1).optional(),
  // Its own key: `LOCAL_MODEL_URL` and its refine stay as narrow as they were (§3.3). No message:
  // the worker answers a refusal by reason only, never by text.
  ROUTER_LOCAL_MODEL_URL: z.string().refine(isAllowedRouterLocalModelUrl).optional(),
})

export type RouterEnv = z.infer<typeof extractionWorkerEnvSchema>

const HOSTED_KEY_ENV = { gemini: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY' } as const

function isRecord(v: unknown): v is Record<string, unknown> {
  // Stryker disable next-line ConditionalExpression: equivalent — a JSON string or number passed as a record has no `provider` or `routes`, so it is handed on unchanged either way
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** One route with its secret and address from env; null when env lacks them (the route does not exist). */
function routeFromEnv(route: unknown, env: RouterEnv): unknown {
  if (!isRecord(route)) return route
  // The JSON parameters never carry a key, URL or local model id: env alone supplies them (§2.4).
  const { apiKey: _k, baseUrl: _u, ...params } = route
  if (route.provider === 'gemini' || route.provider === 'groq') {
    const apiKey = env[HOSTED_KEY_ENV[route.provider]]
    return apiKey === undefined ? null : { ...params, apiKey }
  }
  if (route.provider !== 'local') return route
  const { model: _m, ...local } = params
  const { ROUTER_LOCAL_MODEL_URL: baseUrl, LOCAL_MODEL_NAME: model, LOCAL_MODEL_KEY: apiKey } = env
  if (baseUrl === undefined || model === undefined) return null
  return { ...local, baseUrl, model, ...(apiKey !== undefined && { apiKey }) }
}

/**
 * The extraction worker's router config: the non-secret route parameters (`EXTRACTION_ROUTER_CONFIG`)
 * plus the keys and the local URL from env (ADR §2.4). A route whose env is absent is dropped — that
 * provider does not take part; without the local route the router refuses the config and answers
 * `NOT_CONFIGURED`. Anything malformed is handed on unchanged for the router to refuse.
 */
export function buildRouterConfig(params: unknown, env: RouterEnv): unknown {
  if (!isRecord(params) || !Array.isArray(params.routes)) return params
  const routes = params.routes.map((r) => routeFromEnv(r, env)).filter((r) => r !== null)
  return { ...params, routes }
}
