import { z } from 'zod'
import {
  boundedRequest,
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  type FetchLike,
} from '../http/bounded-request'
import type { InferenceErrorCode } from '../contracts/errors'
import type { OpenRouterModel } from './model-registry'

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

// The envelope only requires `data` to be an array; entries are validated one by one so a single
// malformed entry is dropped instead of failing the whole refresh.
const catalogSchema = z.object({ data: z.array(z.unknown()) })

const entrySchema = z.object({
  id: z.string().min(1),
  context_length: z.number(),
  pricing: z.object({ prompt: z.union([z.string(), z.number()]) }),
})

/** Price per token as a finite, non-negative number; blank or non-numeric input is rejected (never "free"). */
function parsePerTokenPrice(raw: string | number): number | null {
  if (typeof raw === 'string' && raw.trim() === '') return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

export type OpenRouterCatalogResult =
  { ok: true; models: OpenRouterModel[] } | { ok: false; code: InferenceErrorCode }

export async function fetchOpenRouterCatalog(opts: {
  apiKey?: string
  baseUrl?: string
  timeoutMs?: number
  fetchImpl?: FetchLike
}): Promise<OpenRouterCatalogResult> {
  const res = await boundedRequest({
    url: `${(opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/models`,
    method: 'GET',
    ...(opts.apiKey !== undefined && { headers: { Authorization: `Bearer ${opts.apiKey}` } }),
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytes: DEFAULT_MAX_BYTES * 8,
    ...(opts.fetchImpl !== undefined && { fetchImpl: opts.fetchImpl }),
  })

  if (res.kind === 'rate_limited') return { ok: false, code: 'RATE_LIMITED' }
  if (res.kind === 'timeout') return { ok: false, code: 'TIMEOUT' }
  if (res.kind === 'transport') return { ok: false, code: 'PROVIDER_ERROR' }

  let json: unknown
  try {
    json = JSON.parse(res.text)
  } catch {
    return { ok: false, code: 'PROVIDER_ERROR' }
  }
  const parsed = catalogSchema.safeParse(json)
  if (!parsed.success) return { ok: false, code: 'PROVIDER_ERROR' }

  const models: OpenRouterModel[] = []
  for (const raw of parsed.data.data) {
    const entry = entrySchema.safeParse(raw)
    if (!entry.success) continue
    const m = entry.data
    const perToken = parsePerTokenPrice(m.pricing.prompt)
    // Unpriced/odd entries are dropped, never trusted: a model without a valid price cannot pass the ceiling.
    if (perToken === null) continue
    if (!(m.context_length > 0)) continue
    models.push({
      id: m.id,
      promptPriceUsdPerMTok: perToken * 1_000_000,
      contextTokens: m.context_length,
    })
  }
  return { ok: true, models }
}
