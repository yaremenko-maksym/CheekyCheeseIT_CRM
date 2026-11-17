import { z } from 'zod'
import { parseJsonOrNull } from '../internal/chat-completions'
import { isValidProviderModelId, parseGeminiModelId } from '../internal/model-id'
import { boundedRequest, type FetchLike } from '../http/bounded-request'
import {
  CLOUDFLARE_CEILING_USD_PER_M,
  CLOUDFLARE_LISTING_MAX_PAGES,
  CLOUDFLARE_LISTING_PAGE_SIZE,
  cloudflareListingUrl,
  isCloudflareListedVendor,
  isCloudflareAccountId,
} from './cloudflare'
import type { HostedProvider } from './config'
import { isFreePricing, OPENROUTER_LISTING_URL, OPENROUTER_REQUIRED_PARAMETER } from './openrouter'

/**
 * Fixed package constants: no id, query value or user value is ever interpolated (SR-M-8). The
 * Cloudflare listing is the one exception, built by `cloudflareListingUrl` around the checked account id.
 */
export const MODEL_LISTING_URLS = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
  groq: 'https://api.groq.com/openai/v1/models',
  openrouter: OPENROUTER_LISTING_URL,
} as const satisfies Record<Exclude<HostedProvider, 'cloudflare'>, string>

/** Entries read from one listing; the rest are ignored and counted. */
export const LISTING_MAX_ENTRIES = 200
/** Far above any real id: the length cap runs before any id validation. */
const LISTING_MAX_ID_CHARS = 256
const LISTING_MAX_BYTES = 512 * 1024
/**
 * OpenRouter's catalogue carries a description per model and runs to megabytes (the registry's
 * `fetchOpenRouterCatalog` allows 16 MiB for the same endpoint); 8 MiB still bounds the parse.
 */
const OPENROUTER_LISTING_MAX_BYTES = 8 * 1024 * 1024

export type ListedModel = {
  id: string
  /** Absent when the provider's number is missing or not a positive integer. */
  context?: number | undefined
  /** Groq's flag; `true` on every Cloudflare entry kept, since deprecated ones are dropped. */
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
  openrouter: z.object({ data: z.array(z.unknown()) }),
  cloudflare: z.object({ result: z.array(z.unknown()) }),
}

const entries = (p: Exclude<HostedProvider, 'cloudflare'>, doc: unknown): unknown[] | null => {
  if (p === 'gemini') {
    const parsed = envelope.gemini.safeParse(doc)
    return parsed.success ? parsed.data.models : null
  }
  if (p === 'openrouter') {
    const parsed = envelope.openrouter.safeParse(doc)
    // The entry cap applies to `:free` entries only: the paid majority of the catalogue must not
    // push a free model past it. A shape check, nothing more; `toModel` validates each id.
    return parsed.success
      ? parsed.data.data.filter((e) => String((e as { id?: unknown } | null)?.id).endsWith(':free'))
      : null
  }
  const parsed = envelope.groq.safeParse(doc)
  return parsed.success ? parsed.data.data : null
}

/**
 * An OpenRouter catalogue entry (§3.5 check 2): kept only with a valid `:free` id, every price 0,
 * `structured_outputs` among its parameters and a positive integer context. Nothing else is read.
 */
const openRouterEntry = z.object({
  id: idField,
  context_length: contextField,
  pricing: z.unknown(),
  supported_parameters: z.array(z.unknown()),
})

function toOpenRouterModel(raw: unknown): ListedModel | null {
  const parsed = openRouterEntry.safeParse(raw)
  if (!parsed.success || !isValidProviderModelId('openrouter', parsed.data.id)) return null
  if (!isFreePricing(parsed.data.pricing)) return null
  if (!parsed.data.supported_parameters.includes(OPENROUTER_REQUIRED_PARAMETER)) return null
  // Listed, free and schema-capable is OpenRouter's "active"; an unknown context stays unknown.
  return { id: parsed.data.id, context: parsed.data.context_length, active: true }
}

/**
 * A catalogue entry as Cloudflare's docs pipeline stores it (UNVERIFIED for the search endpoint, facts
 * file 2026-11-17). Every property the decision needs must be present and well-formed, or the entry
 * is dropped: an unreadable entry is never taken for one without a planned deprecation.
 */
const cloudflareEntry = z.object({
  name: idField,
  task: z.object({ name: z.literal('Text Generation') }),
  properties: z.array(z.object({ property_id: z.string(), value: z.unknown() })),
})
const cloudflareContext = z.union([
  z.number().int().positive(),
  z
    .string()
    .regex(/^[1-9][0-9]{0,8}$/)
    .transform(Number),
])
const cloudflarePrices = z.array(
  z.object({ unit: z.string(), price: z.number().nonnegative(), currency: z.literal('USD') }),
)

function toCloudflareModel(raw: unknown): ListedModel | null {
  const parsed = cloudflareEntry.safeParse(raw)
  if (!parsed.success || !isValidProviderModelId('cloudflare', parsed.data.name)) return null
  if (!isCloudflareListedVendor(parsed.data.name)) return null
  const property = (id: string): unknown =>
    parsed.data.properties.find((x) => x.property_id === id)?.value
  if (parsed.data.properties.some((x) => x.property_id === 'planned_deprecation_date')) return null
  const context = cloudflareContext.safeParse(property('context_window'))
  const prices = cloudflarePrices.safeParse(property('price'))
  if (!context.success || !prices.success) return null
  const rate = (unit: string): number | undefined => prices.data.find((x) => x.unit === unit)?.price
  const input = rate('per M input tokens')
  const output = rate('per M output tokens')
  // A dearer model would break the own-cap arithmetic; a free (0) price is not a price we can trust.
  if (input === undefined || input <= 0 || input > CLOUDFLARE_CEILING_USD_PER_M.input) return null
  if (output === undefined || output <= 0 || output > CLOUDFLARE_CEILING_USD_PER_M.output)
    return null
  return { id: parsed.data.name, context: context.data, active: true }
}

/** One untrusted entry to a validated model, or `null`: the raw value goes no further. */
const toModel = (p: HostedProvider, raw: unknown): ListedModel | null => {
  if (p === 'cloudflare') return toCloudflareModel(raw)
  if (p === 'openrouter') return toOpenRouterModel(raw)
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
type ListingOptions = {
  provider: HostedProvider
  apiKey: string
  /** Cloudflare only: the account the search URL names. */
  accountId?: string | undefined
  timeoutMs: number
  fetchImpl?: FetchLike | undefined
}

export async function fetchModelListing(opts: ListingOptions): Promise<ListingResult> {
  const { provider: p, apiKey } = opts
  if (p === 'cloudflare') return fetchCloudflareListing(opts)
  const headers: Record<string, string> =
    p === 'gemini' ? { 'x-goog-api-key': apiKey } : { Authorization: `Bearer ${apiKey}` }
  const maxBytes = p === 'openrouter' ? OPENROUTER_LISTING_MAX_BYTES : LISTING_MAX_BYTES
  const r = await getListingText(MODEL_LISTING_URLS[p], headers, opts, maxBytes)
  return typeof r === 'string' ? readListing(p, entries(p, parseJsonOrNull(r))) : r
}

/** The body text of one listing request, or the listing result its failure means. */
async function getListingText(
  url: string,
  headers: Record<string, string>,
  opts: ListingOptions,
  maxBytes = LISTING_MAX_BYTES,
): Promise<string | Exclude<ListingResult, { kind: 'ok' }>> {
  const r = await boundedRequest({
    url,
    method: 'GET',
    headers,
    timeoutMs: opts.timeoutMs,
    maxBytes,
    fetchImpl: opts.fetchImpl,
  })
  if (r.kind === 'ok') return r.text
  if (r.kind === 'transport') {
    if (r.status === 401 || r.status === 403) return { kind: 'auth' }
    return { kind: 'failed', noResponse: r.status === undefined }
  }
  // A timeout or a 429: the provider may have counted the request.
  return { kind: 'failed', noResponse: false }
}

/**
 * The Cloudflare search, page by page until a short page. Every page full up to the last one read
 * means the catalogue may go on: a cut listing could drop a live model, so the listing fails instead.
 */
async function fetchCloudflareListing(opts: ListingOptions): Promise<ListingResult> {
  // Stryker disable next-line StringLiteral: equivalent — any fallback outside 32 lower-case hex is refused like '' is
  const accountId = opts.accountId ?? ''
  if (!isCloudflareAccountId(accountId)) return { kind: 'failed', noResponse: true }
  const headers = { Authorization: `Bearer ${opts.apiKey}` }
  const raw: unknown[] = []
  for (let page = 1; page <= CLOUDFLARE_LISTING_MAX_PAGES; page += 1) {
    const r = await getListingText(cloudflareListingUrl(accountId, page), headers, opts)
    // After the first page a response has been received, so the unit is committed.
    if (typeof r !== 'string') return page === 1 || r.kind === 'auth' ? r : failedAnswered
    const doc = envelope.cloudflare.safeParse(parseJsonOrNull(r))
    if (!doc.success) return failedAnswered
    raw.push(...doc.data.result)
    if (doc.data.result.length < CLOUDFLARE_LISTING_PAGE_SIZE) return readListing('cloudflare', raw)
  }
  return failedAnswered
}

const failedAnswered: ListingResult = { kind: 'failed', noResponse: false }

function readListing(p: HostedProvider, raw: unknown[] | null): ListingResult {
  if (raw === null) return { kind: 'failed', noResponse: false }
  const models: ListedModel[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const entry of raw.slice(0, LISTING_MAX_ENTRIES)) {
    const model = toModel(p, entry)
    // A repeated id would waste a probe of the day's allowance.
    if (model === null || seen.has(model.id)) dropped += 1
    else {
      seen.add(model.id)
      models.push(model)
    }
  }
  return {
    kind: 'ok',
    models,
    dropped,
    beyondCap: Math.max(0, raw.length - LISTING_MAX_ENTRIES),
  }
}
