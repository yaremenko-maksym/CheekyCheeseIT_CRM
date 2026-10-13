import type { InferenceErrorCode } from '../contracts/errors'
import type { ExtractionPort, ExtractionRequest, ExtractionResult } from '../contracts/extraction'
import type { FetchLike } from '../http/bounded-request'
import { runExtraction } from '../internal/extraction-pipeline'
import { sendChatCompletion, type ChatCallResult } from '../internal/chat-completions'

export type OpenRouterExtractionConfig = {
  apiKey: string
  resolveModelId: () => string | null
  onModelUnavailable?: (deadModelId: string) => Promise<string | null>
  baseUrl?: string
  timeoutMs?: number
  fetchImpl?: FetchLike
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

export function createOpenRouterExtractionAdapter(cfg: OpenRouterExtractionConfig): ExtractionPort {
  const onModelUnavailable = cfg.onModelUnavailable ?? (async () => null)

  return {
    async extract<T>(req: ExtractionRequest<T>): Promise<ExtractionResult<T>> {
      let modelId = cfg.resolveModelId()
      if (modelId === null) return { ok: false, code: 'NOT_CONFIGURED' }
      let totalTokens: number | undefined

      const run = () =>
        runExtraction({
          schema: req.schema,
          call: async (correction?: string): Promise<ChatCallResult> => {
            const res = await sendChatCompletion({
              baseUrl: cfg.baseUrl ?? DEFAULT_BASE_URL,
              model: modelId as string,
              apiKey: cfg.apiKey,
              input: req.input,
              detectModelUnavailable: true,
              ...(req.instruction !== undefined && { instruction: req.instruction }),
              ...(correction !== undefined && { correction }),
              ...(cfg.timeoutMs !== undefined && { timeoutMs: cfg.timeoutMs }),
              ...(cfg.fetchImpl !== undefined && { fetchImpl: cfg.fetchImpl }),
            })
            if (res.ok) totalTokens = res.totalTokens
            return res
          },
        })

      let outcome = await run()
      if (!outcome.ok && outcome.code === 'MODEL_UNAVAILABLE') {
        // Single swap: at most one refresh and one retry, never a loop.
        const fresh = await onModelUnavailable(modelId)
        if (fresh !== null) {
          modelId = fresh
          outcome = await run()
        }
      }
      if (outcome.ok) {
        return {
          ok: true,
          data: outcome.data,
          ...(totalTokens !== undefined && { usage: { totalTokens } }),
        }
      }
      // MODEL_UNAVAILABLE is internal only; never surfaced publicly.
      const code: InferenceErrorCode =
        outcome.code === 'MODEL_UNAVAILABLE' ? 'PROVIDER_ERROR' : outcome.code
      return { ok: false, code }
    },
  }
}
