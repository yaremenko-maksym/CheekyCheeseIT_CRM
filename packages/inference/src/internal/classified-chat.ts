import { z } from 'zod'
import {
  boundedRequest,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  type BoundedResult,
  type FetchLike,
} from '../http/bounded-request'
import { buildChatMessages, chatCompletionsUrl, parseJsonOrNull } from './chat-completions'
import { parseGeminiModelId } from './model-id'
import type { JsonSchema } from './strict-schema'
import type { OpenRouterProviderFields } from '../router/openrouter'

/** The internal codes of ADR §5.1 a leaf can return (PROMPT_TOO_LARGE is the router's, pre-request). */
export const CLASSIFIED_CHAT_CODES = [
  'OK',
  'BUSY',
  'SPENT_DAY',
  'CREDIT',
  /** OpenRouter: a routing field (data policy, a routing parameter) was refused (ADR §3.5). */
  'FLAG_REJECTED',
  'RETIRED',
  'AUTH',
  'REFUSED',
  'INVALID_OUTPUT',
  'TIMEOUT',
  'TRANSPORT',
  'ABORTED',
] as const
export type ClassifiedChatCode = (typeof CLASSIFIED_CHAT_CODES)[number]

export type ChatProvider = 'gemini' | 'groq' | 'cloudflare' | 'openrouter'

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
  /** Base64 PNG pages; the router passes them only to a vision-capable pair. */
  images?: readonly string[] | undefined
  maxTokens: number
  /** Sent as `reasoning_effort` (OpenRouter: `reasoning.effort`); the router sets it only where the model takes it. */
  reasoningEffort?: 'low' | undefined
  structuredOutput: StructuredOutput
  timeoutMs?: number
  signal?: AbortSignal | undefined
  fetchImpl?: FetchLike | undefined
  /**
   * OpenRouter only, and required there: the `provider` routing object (§3.5 check 3). Missing or
   * `null` on an OpenRouter request means it cannot be built, and nothing is sent.
   */
  providerRouting?: OpenRouterProviderFields | null | undefined
}

/** Every pause derived from a header or an error body is clamped to this. */
export const MAX_PAUSE_MS = 24 * 60 * 60 * 1000

/** The largest `usage.total_tokens` believed from a provider; far above any free-tier day. */
export const MAX_REPORTED_TOKENS = 10_000_000

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
  // Provider-controlled (SR-M-66): out of range or not an integer counts as absent, never as a number.
  usage: z
    .object({
      total_tokens: z
        .number()
        .int()
        .nonnegative()
        .max(MAX_REPORTED_TOKENS)
        .optional()
        .catch(undefined),
    })
    .optional(),
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
/** Cloudflare 429 code 3036: the daily free allocation of Neurons is used up (errors page). */
const CLOUDFLARE_DAY_SPENT = 3036
/** Cloudflare 410 code 5028: "Model deprecated" (errors page). */
const CLOUDFLARE_DEPRECATED = 5028
/** Cloudflare API v4 code 10000 on a 403: the token is refused ("Enriched 403 responses", 2026-08-21). */
const CLOUDFLARE_AUTH = 10000
const cloudflareEnvelope = z.object({ errors: z.array(z.object({ code: z.unknown() })) })
/**
 * OpenRouter's error envelope `{ error: { code, message, metadata? } }`. Only `error.message` and,
 * for a moderation refusal, `error.metadata.reasons` are read (§5.1: fixed places, never page text).
 */
const openRouterEnvelope = z.object({
  error: z.object({
    message: z.string(),
    code: z.unknown().optional(),
    metadata: z.unknown().optional(),
  }),
})
const openRouterModeration = z.object({ reasons: z.array(z.unknown()) })
/** 429 markers, matched as whole tokens of `error.message` (§3.5). */
const OPENROUTER_DAY_SPENT = 'free-models-per-day'
/** The 404 a `data_collection` value no endpoint of the model accepts (2026-11-08 probe). */
const OPENROUTER_DATA_POLICY = /^No endpoints found matching your data policy\b/
/** A 400 that names one of the routing parameters the builder sends. */
const OPENROUTER_ROUTING_PARAMETERS = [
  'max_price',
  'require_parameters',
  'data_collection',
] as const
/** The key's own USD limit reached (UNVERIFIED wording until the 5.4c-5 smoke). */
const OPENROUTER_KEY_LIMIT = /\bkey limit (?:exceeded|reached)\b/i

/**
 * `token` occurs in `message` bounded by characters outside `[A-Za-z0-9_-]`. Unlike a model id, a
 * marker may end a sentence: "Rate limit exceeded: free-models-per-day. Add 10 credits ...".
 */
function hasMarker(message: string, token: string): boolean {
  for (let i = message.indexOf(token); i !== -1; i = message.indexOf(token, i + 1)) {
    const around = message.charAt(i - 1) + message.charAt(i + token.length)
    if (!/[A-Za-z0-9_-]/.test(around)) return true
  }
  return false
}

/** `error.message` of an OpenRouter error body, or undefined when the body is not its envelope. */
function openRouterError(
  text: string | undefined,
): z.infer<typeof openRouterEnvelope>['error'] | undefined {
  const env = openRouterEnvelope.safeParse(errorJson(text))
  return env.success ? env.data.error : undefined
}

/**
 * An OpenRouter 404 or 400 caused by a routing field this builder sent (§3.5): classified before
 * `RETIRED`, or it would retire good models.
 */
function isFlagRejected(status: 400 | 404, text: string | undefined): boolean {
  const message = openRouterError(text)?.message
  if (message === undefined) return false
  if (status === 404) return OPENROUTER_DATA_POLICY.test(message)
  return OPENROUTER_ROUTING_PARAMETERS.some((name) => hasMarker(message, name))
}

/** An OpenRouter 403: the key limit is `CREDIT`, a moderation flag `REFUSED`, its envelope `AUTH`. */
function classifyOpenRouter403(text: string | undefined): ClassifiedChatResult | undefined {
  const error = openRouterError(text)
  if (error === undefined) return undefined
  if (OPENROUTER_KEY_LIMIT.test(error.message)) return { ok: false, code: 'CREDIT' }
  if (openRouterModeration.safeParse(error.metadata).success) return { ok: false, code: 'REFUSED' }
  return { ok: false, code: 'AUTH' }
}

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
  // Cloudflare: only the documented code in its v4 envelope spends the day; 3040 is capacity.
  if (provider === 'cloudflare' && hasCloudflareCode(r.text, CLOUDFLARE_DAY_SPENT)) {
    return { ok: false, code: 'SPENT_DAY' }
  }
  // OpenRouter: only the per-day token in `error.message` spends the day; `free-models-per-min` and
  // an upstream 429 with neither marker are one busy cool-down.
  const message = provider === 'openrouter' ? openRouterError(r.text)?.message : undefined
  if (message !== undefined && hasMarker(message, OPENROUTER_DAY_SPENT)) {
    return { ok: false, code: 'SPENT_DAY' }
  }
  return busy(parseRetryAfter(r.headers?.get('retry-after')))
}

/** The Cloudflare v4 envelope's `errors[]` holds the documented numeric `code`. */
function hasCloudflareCode(text: string | undefined, code: number): boolean {
  const env = cloudflareEnvelope.safeParse(errorJson(text))
  return env.success && env.data.errors.some((e) => e.code === code)
}

/** A 403 is AUTH only with the provider's documented envelope; page text can never disable a provider. */
function isAuthEnvelope(provider: ChatProvider, text: string | undefined): boolean {
  const json = errorJson(text)
  if (provider === 'gemini') return permissionDenied.safeParse(json).success
  // 5035 (model needs Workers Paid) and 3023 (account blocked) stay TRANSPORT: nothing is disabled.
  if (provider === 'cloudflare') return hasCloudflareCode(text, CLOUDFLARE_AUTH)
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
    case 400:
      if (opts.provider === 'openrouter' && isFlagRejected(400, r.text)) {
        return { ok: false, code: 'FLAG_REJECTED' }
      }
      break
    case 403:
      if (opts.provider === 'openrouter') {
        const or403 = classifyOpenRouter403(r.text)
        if (or403 !== undefined) return or403
        break
      }
      if (isAuthEnvelope(opts.provider, r.text)) return { ok: false, code: 'AUTH' }
      break
    case 404:
      if (opts.provider === 'openrouter' && isFlagRejected(404, r.text)) {
        return { ok: false, code: 'FLAG_REJECTED' }
      }
      if (namesModel(opts.model, r.text)) return { ok: false, code: 'RETIRED' }
      break
    // Gone: only Cloudflare's documented "Model deprecated" retires; any other 410 is TRANSPORT.
    case 410:
      if (opts.provider === 'cloudflare' && hasCloudflareCode(r.text, CLOUDFLARE_DEPRECATED)) {
        return { ok: false, code: 'RETIRED' }
      }
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
 * A classified result with what the router meters (ADR §5.1, §6.2): whether a request was handed to
 * `fetch` at all (an abort before that spends nothing) and the HTTP status when one arrived.
 */
export type ClassifiedChatOutcome = {
  result: ClassifiedChatResult
  sent: boolean
  status?: number
}

/**
 * The one request builder and classifier for every router chat request (ADR §3.3, §5.1).
 * Never throws; never returns a key, a header value or body text.
 */
export async function sendClassifiedChatCompletion(
  opts: ClassifiedChatOptions,
): Promise<ClassifiedChatResult> {
  return (await sendClassifiedChat(opts)).result
}

/** `sendClassifiedChatCompletion` with the send flag and the HTTP status, for the router's events. */
export async function sendClassifiedChat(
  opts: ClassifiedChatOptions,
): Promise<ClassifiedChatOutcome> {
  const url = chatCompletionsUrl(opts.baseUrl)
  // A key over plain HTTP is a config error (SR-L-63): refused before anything is sent.
  if (opts.apiKey !== undefined && URL.canParse(url) && new URL(url).protocol === 'http:') {
    return { result: { ok: false, code: 'TRANSPORT', responded: false }, sent: false }
  }
  if (opts.signal?.aborted === true) {
    return { result: { ok: false, code: 'ABORTED' }, sent: false }
  }
  // An OpenRouter request without its routing fields is never sent (§3.5 check 3).
  const routing = opts.provider === 'openrouter' ? opts.providerRouting : undefined
  if (opts.provider === 'openrouter' && (routing === undefined || routing === null)) {
    // Per call, never persisted: the config schema refuses such a route at load, so it is unreachable.
    return { result: { ok: false, code: 'TRANSPORT', responded: false }, sent: false }
  }
  const result = await boundedRequest({
    url,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.apiKey !== undefined && { Authorization: `Bearer ${opts.apiKey}` }),
    },
    body: JSON.stringify({
      model: opts.model,
      messages: buildChatMessages(opts),
      temperature: 0.1,
      max_tokens: opts.maxTokens,
      // JSON.stringify drops an undefined value, so the field is absent unless asked. OpenRouter
      // ignores the flat field and reads `reasoning.effort` (2026-11-25 probe).
      ...(opts.reasoningEffort !== undefined &&
        (opts.provider === 'openrouter'
          ? { reasoning: { effort: opts.reasoningEffort } }
          : { reasoning_effort: opts.reasoningEffort })),
      ...responseFormat(opts.structuredOutput),
      ...(routing !== undefined && routing !== null && { provider: routing }),
    }),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: DEFAULT_MAX_BYTES,
    readRateLimitDetails: true,
    signal: opts.signal,
    fetchImpl: opts.fetchImpl,
  })
  const { status } = result as { status?: number }
  return { result: classify(opts, result), sent: true, ...(status !== undefined && { status }) }
}

function classify(opts: ClassifiedChatOptions, result: BoundedResult): ClassifiedChatResult {
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
