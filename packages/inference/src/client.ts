import { createJevDecisionAdapter } from './adapters/jev.decision-adapter'
import { createLocalExtractionAdapter } from './adapters/local.extraction-adapter'
import { createOpenRouterExtractionAdapter } from './adapters/openrouter.extraction-adapter'
import type { InferenceConfig } from './contracts/config'
import type { DecisionPort } from './contracts/decision'
import type { ExtractionPort } from './contracts/extraction'
import type { FetchLike } from './http/bounded-request'

export type InferenceClientDeps = {
  fetchImpl?: FetchLike
  resolveOpenRouterModelId?: () => string | null
  onOpenRouterModelUnavailable?: (deadModelId: string) => Promise<string | null>
}

const notConfiguredDecision: DecisionPort = {
  decide: async () => ({ ok: false, code: 'NOT_CONFIGURED' }),
}
const notConfiguredExtraction: ExtractionPort = {
  extract: async () => ({ ok: false, code: 'NOT_CONFIGURED' }),
}

function buildDecision(cfg: InferenceConfig, deps: InferenceClientDeps): DecisionPort {
  const jev = cfg.decision?.jev
  if (jev === undefined) return notConfiguredDecision
  return createJevDecisionAdapter({
    apiKey: jev.apiKey,
    ...(jev.baseUrl !== undefined && { baseUrl: jev.baseUrl }),
    ...(jev.timeoutMs !== undefined && { timeoutMs: jev.timeoutMs }),
    ...(deps.fetchImpl !== undefined && { fetchImpl: deps.fetchImpl }),
  })
}

function buildExtraction(cfg: InferenceConfig, deps: InferenceClientDeps): ExtractionPort {
  const ext = cfg.extraction
  if (ext === undefined) return notConfiguredExtraction
  if (ext.provider === 'local') {
    const local = ext.local
    if (local === undefined) return notConfiguredExtraction
    return createLocalExtractionAdapter({
      baseUrl: local.baseUrl,
      model: local.model,
      ...(local.apiKey !== undefined && { apiKey: local.apiKey }),
      ...(local.timeoutMs !== undefined && { timeoutMs: local.timeoutMs }),
      ...(deps.fetchImpl !== undefined && { fetchImpl: deps.fetchImpl }),
    })
  }
  const or = ext.openrouter
  if (or === undefined) return notConfiguredExtraction
  return createOpenRouterExtractionAdapter({
    apiKey: or.apiKey,
    resolveModelId: deps.resolveOpenRouterModelId ?? (() => null),
    onModelUnavailable: deps.onOpenRouterModelUnavailable ?? (async () => null),
    ...(or.baseUrl !== undefined && { baseUrl: or.baseUrl }),
    ...(or.timeoutMs !== undefined && { timeoutMs: or.timeoutMs }),
    ...(deps.fetchImpl !== undefined && { fetchImpl: deps.fetchImpl }),
  })
}

/** Entry point of the inference layer: configured adapters, or NOT_CONFIGURED stubs (no throw on boot). */
export class InferenceClient {
  readonly decision: DecisionPort
  readonly extraction: ExtractionPort

  constructor(cfg: InferenceConfig, deps: InferenceClientDeps = {}) {
    this.decision = buildDecision(cfg, deps)
    this.extraction = buildExtraction(cfg, deps)
  }
}
