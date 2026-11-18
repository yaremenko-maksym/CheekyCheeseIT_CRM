/**
 * OpenRouter route, free models only (ADR §3.5, Amendment 2026-11-08 H.5 and H.9). The id rule
 * (check 1) is `isValidProviderModelId('openrouter', id)`; this module holds checks 2 and 3: the
 * catalogue price filter and the request's `provider` routing fields.
 */

/** The chat base URL, a package constant: no env or config can point the route elsewhere (§3.3). */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/**
 * The catalogue the router reads. The query narrows the listing to models that take a JSON schema;
 * the listing re-checks `supported_parameters` itself, so an ignored query cuts nothing it relies on.
 */
export const OPENROUTER_LISTING_URL =
  'https://openrouter.ai/api/v1/models?supported_parameters=structured_outputs'

/** The parameter a candidate must list: the router asks for a strict JSON schema (§3.5 check 2). */
export const OPENROUTER_REQUIRED_PARAMETER = 'structured_outputs'

/** `provider.data_collection` (D11): required on the route, with no default. */
export const OPENROUTER_DATA_COLLECTION = ['allow', 'deny'] as const
export type OpenRouterDataCollection = (typeof OPENROUTER_DATA_COLLECTION)[number]

/** An upstream provider slug for `provider.ignore` (OD-2: empty in the sample). */
export const OPENROUTER_PROVIDER_SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const OPENROUTER_IGNORE_MAX = 16

/** A catalogue price is free only as the number 0 or a non-blank string that parses to exactly 0. */
function isZeroPrice(raw: unknown): boolean {
  if (typeof raw === 'number') return raw === 0
  return typeof raw === 'string' && raw.trim() !== '' && Number(raw) === 0
}

/**
 * Check 2: every field of `pricing` is 0. A missing, empty or non-object `pricing`, and any field
 * that is blank, `null`, non-numeric or above 0 (`"0.0000001"`), is not free.
 */
export function isFreePricing(pricing: unknown): boolean {
  if (typeof pricing !== 'object' || pricing === null || Array.isArray(pricing)) return false
  const prices = Object.values(pricing)
  return prices.length > 0 && prices.every(isZeroPrice)
}

/** The `provider` object every OpenRouter chat request carries (§3.5 check 3). */
export type OpenRouterProviderFields = {
  max_price: { prompt: 0; completion: 0; request: 0; image: 0 }
  require_parameters: true
  data_collection: OpenRouterDataCollection
  ignore: string[]
}

/**
 * Check 3: the routing fields, from the route's own values. `null` when they cannot be built (a
 * missing or unknown `dataCollection`, a bad `ignore` entry): the caller then sends nothing.
 * Never a `models` array, a `route` field or `transforms`: each would let OpenRouter pick a model
 * the id and price checks never saw.
 */
export function openRouterProviderFields(route: {
  dataCollection?: unknown
  providerIgnore?: readonly unknown[] | undefined
}): OpenRouterProviderFields | null {
  const dc = route.dataCollection
  if (dc !== 'allow' && dc !== 'deny') return null
  const ignore = route.providerIgnore ?? []
  if (
    !Array.isArray(ignore) ||
    ignore.length > OPENROUTER_IGNORE_MAX ||
    !ignore.every((s) => typeof s === 'string' && OPENROUTER_PROVIDER_SLUG.test(s))
  ) {
    return null
  }
  return {
    max_price: { prompt: 0, completion: 0, request: 0, image: 0 },
    require_parameters: true,
    data_collection: dc,
    ignore: [...(ignore as string[])],
  }
}

/**
 * The OpenRouter part of one chat request's options, for the production call and the probes alike:
 * `providerRouting` is present on an OpenRouter route, `null` when it cannot be built (nothing is then
 * sent), and absent on every other provider.
 */
export function routeChatFields(route: {
  provider: string
  dataCollection?: unknown
  providerIgnore?: readonly unknown[] | undefined
}): { providerRouting?: OpenRouterProviderFields | null } {
  return route.provider === 'openrouter' ? { providerRouting: openRouterProviderFields(route) } : {}
}
