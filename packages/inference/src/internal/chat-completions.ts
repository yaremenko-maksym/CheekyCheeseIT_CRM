import { z } from 'zod'
import {
  boundedRequest,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
} from '../http/bounded-request'
import { MAX_EXTRACTION_INPUT_CHARS } from '../contracts/extraction'
import type { InferenceErrorCode } from '../contracts/errors'
import { isModelUnavailable } from '../registry/model-registry'

export const DEFAULT_EXTRACTION_INSTRUCTION =
  'Extract the requested data from the user input. Respond with a single JSON object only, no prose.'

const envelopeSchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  usage: z.object({ total_tokens: z.number().optional() }).optional(),
})

/** Upper bound for a caller-supplied system instruction (alongside MAX_EXTRACTION_INPUT_CHARS for the input). */
export const MAX_EXTRACTION_INSTRUCTION_CHARS = 4000

/** `MODEL_UNAVAILABLE` is an INTERNAL code (reactive refresh only); never a public error code. */
export type ChatCallResult =
  | { ok: true; text: string; totalTokens?: number }
  | { ok: false; code: InferenceErrorCode | 'MODEL_UNAVAILABLE' }

export type ChatCompletionOptions = {
  baseUrl: string
  model: string
  apiKey?: string
  instruction?: string
  input: string
  correction?: string
  timeoutMs?: number
  allowLoopbackHttp?: boolean
  detectModelUnavailable?: boolean
  /** OpenRouter ZDR: ask the router to route only to providers that do not retain/train on the data. */
  denyDataCollection?: boolean
  fetchImpl?: FetchLike
}

/** One OpenAI-compatible chat/completions call through the bounded transport. Never throws. */
export async function sendChatCompletion(opts: ChatCompletionOptions): Promise<ChatCallResult> {
  const messages = [
    {
      role: 'system',
      content: (opts.instruction ?? DEFAULT_EXTRACTION_INSTRUCTION).slice(
        0,
        MAX_EXTRACTION_INSTRUCTION_CHARS,
      ),
    },
    { role: 'user', content: opts.input.slice(0, MAX_EXTRACTION_INPUT_CHARS) },
    ...(opts.correction !== undefined
      ? [{ role: 'user', content: `Your previous answer was rejected. ${opts.correction}` }]
      : []),
  ]
  const result = await boundedRequest({
    url: `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.apiKey !== undefined && { Authorization: `Bearer ${opts.apiKey}` }),
    },
    body: JSON.stringify({
      model: opts.model,
      messages,
      temperature: 0.1,
      ...(opts.denyDataCollection === true && { provider: { data_collection: 'deny' } }),
    }),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: DEFAULT_MAX_BYTES,
    ...(opts.allowLoopbackHttp !== undefined && { allowLoopbackHttp: opts.allowLoopbackHttp }),
    ...(opts.fetchImpl !== undefined && { fetchImpl: opts.fetchImpl }),
  })
  switch (result.kind) {
    case 'rate_limited':
      return { ok: false, code: 'RATE_LIMITED' }
    case 'timeout':
      return { ok: false, code: 'TIMEOUT' }
    case 'transport':
      return {
        ok: false,
        code:
          opts.detectModelUnavailable === true && isModelUnavailable(result)
            ? 'MODEL_UNAVAILABLE'
            : 'PROVIDER_ERROR',
      }
    case 'ok': {
      let json: unknown
      try {
        json = JSON.parse(result.text)
      } catch {
        return { ok: false, code: 'PROVIDER_ERROR' }
      }
      const env = envelopeSchema.safeParse(json)
      if (!env.success) return { ok: false, code: 'PROVIDER_ERROR' }
      const totalTokens = env.data.usage?.total_tokens
      return {
        ok: true,
        text: env.data.choices[0]!.message.content,
        ...(totalTokens !== undefined && { totalTokens }),
      }
    }
  }
}
