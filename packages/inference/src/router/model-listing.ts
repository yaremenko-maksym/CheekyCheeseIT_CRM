import { z } from 'zod'
import { parseJsonOrNull } from '../internal/chat-completions'
import { isValidProviderModelId, parseGeminiModelId } from '../internal/model-id'
import { boundedRequest, type FetchLike } from '../http/bounded-request'
import type { HostedProvider } from './config'

/** Fixed package constants: no id, query value or user value is ever interpolated (SR-M-8). */
export const MODEL_LISTING_URLS = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
  groq: 'https://api.groq.com/openai/v1/models',
} as const satisfies Record<HostedProvider, string>

/** Entries read from one listing; the rest are ignored and counted. */
export const LISTING_MAX_ENTRIES = 200
/** Far above any real id: the length cap runs before any id validation. */
const LISTING_MAX_ID_CHARS = 256
const LISTING_MAX_BYTES = 512 * 1024

export type ListedModel = {
  id: string
  /** Absent when the provider's number is missing or not a positive integer. */
  context?: number | undefined
  /** Groq only. */
  active?: boolean | undefined
}

export type ListingResult =
  | { kind: 'ok'; models: ListedModel[]; dropped: number; beyondCap: number }
  /** The key was refused: the provider refresh fails, its list is kept (§3.4). */
  | { kind: 'auth' }
  /** `noResponse` releases the own-cap unit (§5.1); a timeout commits it. */
  | { kind: 'failed'; noResponse: boolean }

const contextField = z.number().int().positive().optional().catch(undefined)
const idField = z.string().max(LISTING_MAX_ID_CHARS)

const geminiEntry = z.object({ name: idField, inputTokenLimit: contextField })
const groqEntry = z.object({
  id: idField,
  context_window: contextField,
  active: z.boolean().optional().catch(undefined),
})

const envelope = {
  gemini: z.object({ models: z.array(z.unknown()) }),
  groq: z.object({ data: z.array(z.unknown()) }),
}

const entries = (p: HostedProvider, doc: unknown): unknown[] | null => {
  if (p === 'gemini') {
    const parsed = envelope.gemini.safeParse(doc)
    return parsed.success ? parsed.data.models : null
  }
  const parsed = envelope.groq.safeParse(doc)
  return parsed.success ? parsed.data.data : null
}

/** One untrusted entry to a validated model, or `null`: the raw value goes no further. */
const toModel = (p: HostedProvider, raw: unknown): ListedModel | null => {
  if (p === 'gemini') {
    const parsed = geminiEntry.safeParse(raw)
    if (!parsed.success) return null
    const id = parseGeminiModelId(parsed.data.name)?.id
    return id === undefined ? null : { id, context: parsed.data.inputTokenLimit }
  }
  const parsed = groqEntry.safeParse(raw)
  if (!parsed.success || !isValidProviderModelId('groq', parsed.data.id)) return null
  return {
    id: parsed.data.id,
    context: parsed.data.context_window,
    active: parsed.data.active,
  }
}

/**
 * The bounded listing fetch (§3.3, SR-M-8). The key is only in a header. The size cap comes before
 * the parse; the entry cap and the id length cap come before any id validation. A hostile id is
 * counted and dropped here, so nothing past this module can probe, store or log it.
 */
export async function fetchModelListing(opts: {
  provider: HostedProvider
  apiKey: string
  timeoutMs: number
  fetchImpl?: FetchLike | undefined
}): Promise<ListingResult> {
  const { provider: p, apiKey } = opts
  const headers: Record<string, string> =
    p === 'gemini' ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` }
  const r = await boundedRequest({
    url: MODEL_LISTING_URLS[p],
    method: 'GET',
    headers,
    timeoutMs: opts.timeoutMs,
    maxBytes: LISTING_MAX_BYTES,
    fetchImpl: opts.fetchImpl,
  })
  if (r.kind === 'ok') return readListing(p, r.text)
  if (r.kind === 'transport') {
    if (r.status === 401 || r.status === 403) return { kind: 'auth' }
    return { kind: 'failed', noResponse: r.status === undefined }
  }
  // A timeout or a 429: the provider may have counted the request.
  return { kind: 'failed', noResponse: false }
}

function readListing(p: HostedProvider, text: string): ListingResult {
  const raw = entries(p, parseJsonOrNull(text))
  if (raw === null) return { kind: 'failed', noResponse: false }
  const models: ListedModel[] = []
  let dropped = 0
  for (const entry of raw.slice(0, LISTING_MAX_ENTRIES)) {
    const model = toModel(p, entry)
    // A repeated id would waste a probe of the day's allowance.
    if (model === null || models.some((m) => m.id === model.id)) dropped += 1
    else models.push(model)
  }
  return {
    kind: 'ok',
    models,
    dropped,
    beyondCap: Math.max(0, raw.length - LISTING_MAX_ENTRIES),
  }
}
