import type { ExtractionPort, ExtractionRequest, ExtractionResult } from '../contracts/extraction'
import type { FetchLike } from '../http/bounded-request'
import { runExtraction } from '../internal/extraction-pipeline'
import { sendChatCompletion, type ChatCallResult } from '../internal/chat-completions'

export type LocalExtractionConfig = {
  baseUrl: string
  model: string
  apiKey?: string
  timeoutMs?: number
  fetchImpl?: FetchLike
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function isLoopbackBase(baseUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname)
  } catch {
    return false
  }
}

export function createLocalExtractionAdapter(cfg: LocalExtractionConfig): ExtractionPort {
  // A non-loopback "local" base is a config error: the local adapter must never reach a remote host.
  const loopback = isLoopbackBase(cfg.baseUrl)
  return {
    async extract<T>(req: ExtractionRequest<T>): Promise<ExtractionResult<T>> {
      if (!loopback) return { ok: false, code: 'PROVIDER_ERROR' }
      let totalTokens: number | undefined
      const outcome = await runExtraction({
        schema: req.schema,
        call: async (correction?: string): Promise<ChatCallResult> => {
          const res = await sendChatCompletion({
            baseUrl: cfg.baseUrl,
            model: cfg.model,
            input: req.input,
            allowLoopbackHttp: true,
            ...(cfg.apiKey !== undefined && { apiKey: cfg.apiKey }),
            ...(req.instruction !== undefined && { instruction: req.instruction }),
            ...(correction !== undefined && { correction }),
            ...(cfg.timeoutMs !== undefined && { timeoutMs: cfg.timeoutMs }),
            ...(cfg.fetchImpl !== undefined && { fetchImpl: cfg.fetchImpl }),
          })
          if (res.ok && res.totalTokens !== undefined) {
            totalTokens = (totalTokens ?? 0) + res.totalTokens
          }
          return res
        },
      })
      if (outcome.ok) {
        return {
          ok: true,
          data: outcome.data,
          ...(totalTokens !== undefined && { usage: { totalTokens } }),
        }
      }
      // detectModelUnavailable is off here, so the internal code cannot occur; map defensively.
      return {
        ok: false,
        code: outcome.code === 'MODEL_UNAVAILABLE' ? 'PROVIDER_ERROR' : outcome.code,
      }
    },
  }
}
