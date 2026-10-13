import type { InferenceConfig } from '@crm/inference'
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
