import { z } from 'zod'
import {
  boundedRequest,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  type BoundedResult,
  type FetchLike,
} from '../http/bounded-request'
import { buildChatMessages, chatCompletionsUrl } from './chat-completions'
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
  apiKey?: string
  instruction?: string
  input: string
  correction?: string
  maxTokens: number
  structuredOutput: StructuredOutput
  timeoutMs?: number
  signal?: AbortSignal
  fetchImpl?: FetchLike
}

/** Error bodies are read only this far, and only through documented structured fields (ADR §5.1). */
export const MAX_ERROR_SCAN_CHARS = 2000
/** Every pause derived from a header or an error body is clamped to this. */
export const MAX_PAUSE_MS = 24 * 60 * 60 * 1000

const QUOTA_FAILURE = 'type.googleapis.com/google.rpc.QuotaFailure'
const RETRY_INFO = 'type.googleapis.com/google.rpc.RetryInfo'

const answerSchema = z.object({
  model: z.string().optional(),
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

const googleEnvelope = z.object({
  error: z.object({ status: z.string(), details: z.array(z.unknown()).optional() }),
})
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
 * A bounded slice of an error body as JSON (an absent body reads as the unparsable "undefined");
 * Gemini's compat layer may wrap the envelope in a list (UNVERIFIED shape, 5.4c-0 §7).
 */
function errorJson(text: string | undefined): unknown {
  try {
    const json: unknown = JSON.parse(String(text).slice(0, MAX_ERROR_SCAN_CHARS))
    return Array.isArray(json) ? json[0] : json
  } catch {
    return undefined
  }
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
  const env = googleEnvelope.safeParse(errorJson(text))
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
    const delay = details?.map((d) => retryInfo.safeParse(d)).find((d) => d.success)
    return busy(parseDuration(delay?.data?.retryDelay))
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
  if (provider === 'gemini') {
    const env = googleEnvelope.safeParse(json)
    return env.success && env.data.error.status === 'PERMISSION_DENIED'
  }
  return provider === 'groq' && groqEnvelope.safeParse(json).success
}

/** A 404 retires the model only when the structured error names it; a bare 404 is a wrong URL. */
function namesModel(model: string, text: string | undefined): boolean {
  const env = notFoundEnvelope.safeParse(errorJson(text))
  if (!env.success) return false
  const { code, message } = env.data.error
  return code === 'model_not_found' || (message?.includes(model) ?? false)
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
    case 498: // Groq flex tier at capacity
    case 503:
      return { ok: false, code: 'BUSY' }
  }
  return { ok: false, code: 'TRANSPORT', responded: true }
}

/** Gemini routes a deprecated id to a successor: a different version or variant retires the request. */
function reroutedTo(opts: ClassifiedChatOptions, served: string | undefined): string | null {
  if (opts.provider !== 'gemini' || served === undefined) return null
  const requested = parseGeminiModelId(opts.model)
  const actual = parseGeminiModelId(served)
  if (requested === null || actual === null) return null
  return requested.version !== actual.version || requested.variant !== actual.variant
    ? actual.id
    : null
}

function classifyAnswer(opts: ClassifiedChatOptions, text: string): ClassifiedChatResult {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, code: 'TRANSPORT', responded: true }
  }
  const env = answerSchema.safeParse(json)
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
  switch (so.mode) {
    case 'json_schema':
      return {
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'extraction', strict: true, schema: so.schema },
        },
      }
    case 'json_object':
      return { response_format: { type: 'json_object' } }
    case 'none':
      return {}
  }
}

/**
 * The one request builder and classifier for every router chat request (ADR §3.3, §5.1).
 * Never throws; never returns a key, a header value or body text.
 */
export async function sendClassifiedChatCompletion(
  opts: ClassifiedChatOptions,
): Promise<ClassifiedChatResult> {
  const local = opts.provider === 'local'
  const result = await boundedRequest({
    url: chatCompletionsUrl(opts.baseUrl),
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
    ...(local && { allowLocalRuntimeHttp: true }),
    ...(opts.signal !== undefined && { signal: opts.signal }),
    ...(opts.fetchImpl !== undefined && { fetchImpl: opts.fetchImpl }),
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
