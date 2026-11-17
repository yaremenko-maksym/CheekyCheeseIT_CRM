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

/** One page of the Text Generation catalogue search; deprecated models are excluded by default. */
export function cloudflareListingUrl(accountId: string, page: number): string {
  if (!Number.isInteger(page) || page < 1 || page > CLOUDFLARE_LISTING_MAX_PAGES) {
    throw new Error('cloudflare listing page refused')
  }
  return `${accountAiRoot(accountId)}models/search?task=Text%20Generation&per_page=${CLOUDFLARE_LISTING_PAGE_SIZE}&page=${page}`
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
