import { z } from 'zod'
import {
  boundedRequest,
  boundedRequestToLocalRuntime,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  type BoundedResult,
  type FetchLike,
} from '../http/bounded-request'
import { buildChatMessages, chatCompletionsUrl, parseJsonOrNull } from './chat-completions'
import { parseGeminiModelId } from './model-id'
import type { JsonSchema } from './strict-schema'

/** The internal codes of ADR §5.1 a leaf can return (PROMPT_TOO_LARGE is the router's, pre-request). */
export const CLASSIFIED_CHAT_CODES = [
  'OK',
  'BUSY',
  'SPENT_DAY',
  'CREDIT',
  'RETIRED',
  'AUTH',
  'REFUSED',
  'INVALID_OUTPUT',
  'TIMEOUT',
  'TRANSPORT',
  'ABORTED',
] as const
export type ClassifiedChatCode = (typeof CLASSIFIED_CHAT_CODES)[number]

export type ChatProvider = 'gemini' | 'groq' | 'local'

export type StructuredOutput =
  { mode: 'json_schema'; schema: JsonSchema } | { mode: 'json_object' } | { mode: 'none' }

export type ClassifiedChatResult =
  | { ok: true; code: 'OK'; text: string; totalTokens?: number }
  /** A Gemini 2xx re-routed to another version or variant: the answer is used, the requested id retires. */
  | { ok: true; code: 'RETIRED'; text: string; totalTokens?: number; servedModel: string }
  | { ok: false; code: 'BUSY'; retryAfterMs?: number }
  /** `responded: false` = no response was ever received (the own-cap unit is released, ADR §5.1). */
  | { ok: false; code: 'TRANSPORT'; responded: boolean }
  | {
      ok: false
      code: Exclude<ClassifiedChatCode, 'OK' | 'BUSY' | 'TRANSPORT'>
    }

export type ClassifiedChatOptions = {
  provider: ChatProvider
  baseUrl: string
  model: string
  apiKey?: string | undefined
  instruction?: string | undefined
  input: string
  correction?: string | undefined
  maxTokens: number
  structuredOutput: StructuredOutput
  timeoutMs?: number
  signal?: AbortSignal | undefined
  fetchImpl?: FetchLike | undefined
}

/** Every pause derived from a header or an error body is clamped to this. */
export const MAX_PAUSE_MS = 24 * 60 * 60 * 1000

const QUOTA_FAILURE = 'type.googleapis.com/google.rpc.QuotaFailure'
const RETRY_INFO = 'type.googleapis.com/google.rpc.RetryInfo'

const answerSchema = z.object({
  model: z.string().nullish(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullish() }),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z.object({ total_tokens: z.number().optional() }).optional(),
})

/** Gemini 403: the documented envelope with `error.status: PERMISSION_DENIED`. */
const permissionDenied = z.object({ error: z.object({ status: z.literal('PERMISSION_DENIED') }) })
/** Gemini 429: only `error.details[]` is read; status and details may be missing. */
const quotaEnvelope = z.object({ error: z.object({ details: z.array(z.unknown()).optional() }) })
const quotaFailure = z.object({
  '@type': z.literal(QUOTA_FAILURE),
  violations: z.array(z.object({ quotaId: z.string() })),
})
const retryInfo = z.object({ '@type': z.literal(RETRY_INFO), retryDelay: z.string() })
const groqEnvelope = z.object({ error: z.object({ message: z.string(), type: z.string() }) })
const notFoundEnvelope = z.object({
  error: z.object({ message: z.string().optional(), code: z.unknown().optional() }),
})

/**
 * An error body as JSON, or null when it is absent (over `boundedRequest`'s 2 MiB cap) or not JSON.
 * The whole body is parsed (the transport cap bounds the work); only named structured fields are
 * read afterwards, never the text.
 */
const errorBody = z.string().transform(parseJsonOrNull).catch(null)

/** Gemini's compat layer may wrap the envelope in a list (UNVERIFIED shape, 5.4c-0 §7). */
function errorJson(text: string | undefined): unknown {
  const json = errorBody.parse(text)
  return Array.isArray(json) ? json[0] : json
}

/** Characters that can continue a model id; anything else bounds it as a whole token. */
const ID_CHAR = /[A-Za-z0-9._-]/

/** `id` occurs in `message` as a whole token, not as the prefix of a longer id. */
function namesWholeId(message: string, id: string): boolean {
  if (id === '') return false
  for (let i = message.indexOf(id); i !== -1; i = message.indexOf(id, i + 1)) {
    const before = message.charAt(i - 1)
    const after = message.charAt(i + id.length)
    if (!ID_CHAR.test(before) && !ID_CHAR.test(after)) return true
  }
  return false
}

function toPauseMs(seconds: number): number | undefined {
  return Number.isFinite(seconds) ? Math.min(seconds * 1000, MAX_PAUSE_MS) : undefined
}

/** `retry-after`: non-negative integer seconds; anything else (absent included) is absent. */
function parseRetryAfter(value: string | null | undefined): number | undefined {
  return /^[0-9]+$/.test(String(value)) ? toPauseMs(Number(value)) : undefined
}

/** Google `Duration` JSON (`"55s"`, `"1.5s"`); anything else (absent included) is absent. */
function parseDuration(value: string | undefined): number | undefined {
  const m = /^([0-9]+(?:\.[0-9]+)?)s$/.exec(String(value))
  return m === null ? undefined : toPauseMs(Number(m[1]))
}

/** `error.details[]` of a Google error envelope, if the body is one. */
function googleDetails(text: string | undefined): unknown[] | undefined {
  const env = quotaEnvelope.safeParse(errorJson(text))
  return env.success ? env.data.error.details : undefined
}

function isPerDayQuota(detail: unknown): boolean {
  const q = quotaFailure.safeParse(detail)
  return q.success && q.data.violations.some((v) => v.quotaId.includes('PerDay'))
}

function busy(retryAfterMs: number | undefined): ClassifiedChatResult {
  return retryAfterMs === undefined
    ? { ok: false, code: 'BUSY' }
    : { ok: false, code: 'BUSY', retryAfterMs }
}

function classifyRateLimit(
  provider: ChatProvider,
  r: Extract<BoundedResult, { kind: 'rate_limited' }>,
): ClassifiedChatResult {
  if (provider === 'gemini') {
    const details = googleDetails(r.text)
    if (details?.some(isPerDayQuota) === true) return { ok: false, code: 'SPENT_DAY' }
    const delay = details?.find((d) => retryInfo.safeParse(d).success)
    return busy(parseDuration(retryInfo.safeParse(delay).data?.retryDelay))
  }
  // Groq: the request headers always mean per day (documented); only an exact `0` spends the day.
  if (provider === 'groq' && r.headers?.get('x-ratelimit-remaining-requests') === '0') {
    return { ok: false, code: 'SPENT_DAY' }
  }
  return busy(parseRetryAfter(r.headers?.get('retry-after')))
}

/** A 403 is AUTH only with the provider's documented envelope; page text can never disable a provider. */
function isAuthEnvelope(provider: ChatProvider, text: string | undefined): boolean {
  const json = errorJson(text)
  if (provider === 'gemini') return permissionDenied.safeParse(json).success
  return provider === 'groq' && groqEnvelope.safeParse(json).success
}

/** A 404 retires the model only when the structured error names it; a bare 404 is a wrong URL. */
function namesModel(model: string, text: string | undefined): boolean {
  const env = notFoundEnvelope.safeParse(errorJson(text))
  if (!env.success) return false
  const { code, message } = env.data.error
  return code === 'model_not_found' || (message !== undefined && namesWholeId(message, model))
}

function classifyFailure(
  opts: ClassifiedChatOptions,
  r: Extract<BoundedResult, { kind: 'transport' }>,
): ClassifiedChatResult {
  if (r.status === undefined) return { ok: false, code: 'TRANSPORT', responded: false }
  if (r.tooLarge === true) return { ok: false, code: 'INVALID_OUTPUT' }
  switch (r.status) {
    case 401:
      return { ok: false, code: 'AUTH' }
    case 402:
      return { ok: false, code: 'CREDIT' }
    case 403:
      if (isAuthEnvelope(opts.provider, r.text)) return { ok: false, code: 'AUTH' }
      break
    case 404:
      if (namesModel(opts.model, r.text)) return { ok: false, code: 'RETIRED' }
      break
    case 503:
      return { ok: false, code: 'BUSY' }
  }
  return { ok: false, code: 'TRANSPORT', responded: true }
}

/** Gemini routes a deprecated id to a successor: a different version or variant retires the request. */
function reroutedTo(opts: ClassifiedChatOptions, served: string | null | undefined): string | null {
  if (opts.provider !== 'gemini' || typeof served !== 'string') return null
  const requested = parseGeminiModelId(opts.model)
  const actual = parseGeminiModelId(served)
  if (requested === null || actual === null) return null
  return requested.version !== actual.version || requested.variant !== actual.variant
    ? actual.id
    : null
}

function classifyAnswer(opts: ClassifiedChatOptions, text: string): ClassifiedChatResult {
  const env = answerSchema.safeParse(parseJsonOrNull(text))
  if (!env.success) return { ok: false, code: 'TRANSPORT', responded: true }
  const choice = env.data.choices[0]!
  if (choice.finish_reason === 'content_filter') return { ok: false, code: 'REFUSED' }
  const content = choice.message.content ?? ''
  if (choice.finish_reason === 'length' || content.trim() === '') {
    return { ok: false, code: 'INVALID_OUTPUT' }
  }
  const totalTokens = env.data.usage?.total_tokens
  const tokens = totalTokens === undefined ? {} : { totalTokens }
  const servedModel = reroutedTo(opts, env.data.model)
  return servedModel === null
    ? { ok: true, code: 'OK', text: content, ...tokens }
    : { ok: true, code: 'RETIRED', text: content, ...tokens, servedModel }
}

function responseFormat(so: StructuredOutput): object {
  if (so.mode === 'json_schema') {
    return {
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'extraction', strict: true, schema: so.schema },
      },
    }
  }
  return so.mode === 'json_object' ? { response_format: { type: 'json_object' } } : {}
}

/**
 * The one request builder and classifier for every router chat request (ADR §3.3, §5.1).
 * Never throws; never returns a key, a header value or body text.
 */
export async function sendClassifiedChatCompletion(
  opts: ClassifiedChatOptions,
): Promise<ClassifiedChatResult> {
  const local = opts.provider === 'local'
  const url = chatCompletionsUrl(opts.baseUrl)
  // A key over plain HTTP is a config error (SR-L-63): refused before anything is sent.
  if (opts.apiKey !== undefined && URL.canParse(url) && new URL(url).protocol === 'http:') {
    return { ok: false, code: 'TRANSPORT', responded: false }
  }
  // Only the local leaf may reach the runtime host over plain HTTP (SR-M-64).
  const send = local ? boundedRequestToLocalRuntime : boundedRequest
  const result = await send({
    url,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.apiKey !== undefined && { Authorization: `Bearer ${opts.apiKey}` }),
    },
    body: JSON.stringify({
      model: opts.model,
      messages: buildChatMessages(opts),
      temperature: local ? 0 : 0.1,
      max_tokens: opts.maxTokens,
      ...responseFormat(opts.structuredOutput),
    }),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: DEFAULT_MAX_BYTES,
    readRateLimitDetails: true,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
  })
  switch (result.kind) {
    case 'timeout':
      return { ok: false, code: result.aborted === true ? 'ABORTED' : 'TIMEOUT' }
    case 'rate_limited':
      return classifyRateLimit(opts.provider, result)
    case 'transport':
      return classifyFailure(opts, result)
    case 'ok':
      return classifyAnswer(opts, result.text)
  }
}
