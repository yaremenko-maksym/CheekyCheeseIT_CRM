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
  /** Aborting ends the request as `TIMEOUT`; the router sees its own signal first (§5.5 item 3). */
  signal?: AbortSignal | undefined
}

/** Prefixed to a correction hint; counted in the router's fit check (ADR §5.1 `PROMPT_TOO_LARGE`). */
export const CORRECTION_PREFIX = 'Your previous answer was rejected. '

/** The bounded system + user (+ correction) messages every chat call sends. */
export function buildChatMessages(opts: {
  instruction?: string | undefined
  input: string
  correction?: string | undefined
}): { role: string; content: string }[] {
  return [
    {
      role: 'system',
      content: (opts.instruction ?? DEFAULT_EXTRACTION_INSTRUCTION).slice(
        0,
        MAX_EXTRACTION_INSTRUCTION_CHARS,
      ),
    },
    { role: 'user', content: opts.input.slice(0, MAX_EXTRACTION_INPUT_CHARS) },
    ...(opts.correction !== undefined
      ? [{ role: 'user', content: `${CORRECTION_PREFIX}${opts.correction}` }]
      : []),
  ]
}

/** `JSON.parse`, with `null` for text that is not JSON (every caller refuses a `null` document). */
export function parseJsonOrNull(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** `<baseUrl>/chat/completions`, trailing slashes of the base collapsed. */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`
}

/** One OpenAI-compatible chat/completions call through the bounded transport. Never throws. */
export async function sendChatCompletion(opts: ChatCompletionOptions): Promise<ChatCallResult> {
  const messages = buildChatMessages(opts)
  const result = await boundedRequest({
    url: chatCompletionsUrl(opts.baseUrl),
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
    allowLoopbackHttp: opts.allowLoopbackHttp === true,
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
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
      const env = envelopeSchema.safeParse(parseJsonOrNull(result.text))
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
