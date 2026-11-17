/**
 * Cloudflare Workers AI (ADR 2026-11-03, "Amendment 2026-11-17 — Cloudflare provider"; facts in
 * `docs/architecture/2026-11-17-cloudflare-workers-ai-facts.md`). The account id sits in the URL path,
 * so it is the one value ever interpolated into a hosted URL (the SR-M-8 exception): it is admitted
 * only as 32 lower-case hex characters, checked here again on every build.
 */
const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/
const CLOUDFLARE_ACCOUNTS = 'https://api.cloudflare.com/client/v4/accounts/'

/** The listing reads pages of 50 (wrangler's size) and stops at a short page or after this many. */
export const CLOUDFLARE_LISTING_PAGE_SIZE = 50
export const CLOUDFLARE_LISTING_MAX_PAGES = 4

/** The daily free allocation, the same on Workers Free and Workers Paid; reset at 00:00 UTC. */
export const CLOUDFLARE_FREE_NEURONS_PER_DAY = 10_000
/**
 * Neurons per million tokens of the dearest pinned model (Mistral Small 3.1 24B): the own cap is
 * derived from a worst-case call at these rates, and a listing addition must not cost more.
 */
export const CLOUDFLARE_CEILING_NEURONS_PER_M = { input: 31_876, output: 50_488 } as const
/** The same ceiling in the unit the catalogue lists prices in (USD per million tokens). */
export const CLOUDFLARE_CEILING_USD_PER_M = { input: 0.351, output: 0.555 } as const

/**
 * The only ids a Cloudflare route config may pin, each with its verified price (USD per M tokens,
 * pricing page 2026-11-17). The own cap prices every call at the ceiling, so a pin above it is refused.
 */
export const CLOUDFLARE_PINNED_MODEL_PRICES: Readonly<
  Record<string, { readonly input: number; readonly output: number }>
> = {
  '@cf/mistralai/mistral-small-3.1-24b-instruct': { input: 0.351, output: 0.555 },
  '@cf/openai/gpt-oss-20b': { input: 0.2, output: 0.3 },
  '@cf/google/gemma-4-26b-a4b-it': { input: 0.1, output: 0.3 },
}

export function isCloudflarePinnableModel(id: string): boolean {
  return Object.hasOwn(CLOUDFLARE_PINNED_MODEL_PRICES, id)
}

/** The vendors of the pinned chain: a listing addition from any other vendor is dropped. */
const CLOUDFLARE_LISTING_VENDOR = /^@cf\/(?:mistralai|google|openai|meta)\//

/** `@cf/<vendor>/...` with `<vendor>` on the checked-in list (the id shape is checked elsewhere). */
export function isCloudflareListedVendor(id: string): boolean {
  return CLOUDFLARE_LISTING_VENDOR.test(id)
}

export function isCloudflareAccountId(id: string): boolean {
  return CLOUDFLARE_ACCOUNT_ID_PATTERN.test(id)
}

function accountAiRoot(accountId: string): string {
  // The message names no value: the refused string may be anything an env file held.
  if (!isCloudflareAccountId(accountId)) throw new Error('cloudflare account id refused')
  return `${CLOUDFLARE_ACCOUNTS}${accountId}/ai/`
}

/** The OpenAI-compatible base URL; `chatCompletionsUrl` appends `/chat/completions`. */
export function cloudflareChatBaseUrl(accountId: string): string {
  return `${accountAiRoot(accountId)}v1`
}

/** One page of the Text Generation catalogue search; deprecated (default) and experimental models excluded. */
export function cloudflareListingUrl(accountId: string, page: number): string {
  if (!Number.isInteger(page) || page < 1 || page > CLOUDFLARE_LISTING_MAX_PAGES) {
    throw new Error('cloudflare listing page refused')
  }
  return `${accountAiRoot(accountId)}models/search?task=Text%20Generation&hide_experimental=true&per_page=${CLOUDFLARE_LISTING_PAGE_SIZE}&page=${page}`
}

/**
 * Whether `requestsPerDay` worst-case calls fit the free allocation. A call is bounded by its window
 * (`promptFits`), so its worst case is a full window of input plus a full answer, both priced at the
 * ceiling rates. Integer arithmetic in millionths of a Neuron, so the boundary is exact.
 */
export function fitsCloudflareAllowance(r: {
  requestsPerDay: number
  contextTokens: number
  maxAnswerTokens: number
}): boolean {
  const perCall =
    r.contextTokens * CLOUDFLARE_CEILING_NEURONS_PER_M.input +
    r.maxAnswerTokens * CLOUDFLARE_CEILING_NEURONS_PER_M.output
  return r.requestsPerDay * perCall <= CLOUDFLARE_FREE_NEURONS_PER_DAY * 1_000_000
}
