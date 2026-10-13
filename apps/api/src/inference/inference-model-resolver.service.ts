import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { fetchOpenRouterCatalog, selectModel } from '@crm/inference'
import type { Env } from '../config/env'
import { EXTRACTION_MODEL_GUARDRAILS } from './extraction-guardrails'
import { INFERENCE_RESOLVER_OPTIONS } from './inference.tokens'

export type InferenceResolverOptions = {
  fetchCatalog?: typeof fetchOpenRouterCatalog
  now?: () => number
  cooldownMs?: number
}

const DEFAULT_COOLDOWN_MS = 60_000
// A hanging catalog must never tie up a refresh (or the process) for long.
const CATALOG_TIMEOUT_MS = 10_000

/**
 * Reactive, single-flight OpenRouter model resolver. The catalog is fetched in the background at boot
 * (boot never waits on OpenRouter), again when the adapter reports the current model unavailable (a
 * real signal: bypasses the cooldown), and lazily when a caller finds no model selected (self-heal
 * after a failed boot, throttled by the cooldown). Concurrent callers share one in-flight refresh. Never throws and
 * never logs the key or any provider body. Inactive (returns null) unless OpenRouter is configured.
 */
@Injectable()
export class InferenceModelResolverService implements OnModuleInit {
  private readonly logger = new Logger(InferenceModelResolverService.name)
  private currentModelId: string | null = null
  private inFlight: Promise<void> | null = null
  private lastRefreshAt: number | null = null
  private readonly apiKey: string | undefined
  private readonly active: boolean
  private readonly fetchCatalog: typeof fetchOpenRouterCatalog
  private readonly now: () => number
  private readonly cooldownMs: number

  constructor(
    config: ConfigService<Env, true>,
    @Optional() @Inject(INFERENCE_RESOLVER_OPTIONS) options?: InferenceResolverOptions,
  ) {
    this.apiKey = config.get('OPENROUTER_API_KEY', { infer: true })
    this.active =
      this.apiKey !== undefined &&
      config.get('INFERENCE_EXTRACTION_PROVIDER', { infer: true }) === 'openrouter'
    this.fetchCatalog = options?.fetchCatalog ?? fetchOpenRouterCatalog
    this.now = options?.now ?? Date.now
    this.cooldownMs = options?.cooldownMs ?? DEFAULT_COOLDOWN_MS
  }

  async onModuleInit(): Promise<void> {
    if (!this.active) return
    void this.refresh() // fire-and-forget: boot must not block on OpenRouter (never rejects)
  }

  getSelectedModelId(): string | null {
    if (this.active && this.currentModelId === null) void this.refresh() // self-heal, cooldown-throttled
    return this.currentModelId
  }

  async onModelUnavailable(deadId: string): Promise<string | null> {
    // Stryker disable next-line ConditionalExpression: equivalent — when inactive currentModelId is never set (null) so the deadId check below is false anyway and the same null is returned
    if (!this.active) return null
    if (deadId === this.currentModelId) await this.refresh(true)
    return this.currentModelId
  }

  private async refresh(force = false): Promise<void> {
    if (this.inFlight !== null) return this.inFlight
    if (!force && this.lastRefreshAt !== null && this.now() - this.lastRefreshAt < this.cooldownMs)
      return
    this.lastRefreshAt = this.now()
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async doRefresh(): Promise<void> {
    try {
      const res = await this.fetchCatalog({
        // Stryker disable next-line ConditionalExpression: equivalent — doRefresh only runs when active, which requires apiKey !== undefined, so the guard is always true
        ...(this.apiKey !== undefined && { apiKey: this.apiKey }),
        timeoutMs: CATALOG_TIMEOUT_MS,
      })
      if (!res.ok) {
        this.logger.warn(`OpenRouter catalog refresh failed (${res.code}); keeping last model`)
        return
      }
      const chosen = selectModel(res.models, EXTRACTION_MODEL_GUARDRAILS)
      if (chosen === null) {
        this.logger.warn(
          'No OpenRouter model satisfies the extraction guardrails; extraction stays unavailable until the guardrails are widened',
        )
        return
      }
      this.currentModelId = chosen.id
    } catch {
      this.logger.warn('OpenRouter catalog refresh threw; keeping last model')
    }
  }
}
