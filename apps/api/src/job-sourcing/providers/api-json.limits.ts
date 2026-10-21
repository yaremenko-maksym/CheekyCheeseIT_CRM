import { DEFAULT_JSON_LIMITS, type JsonLimits } from './bounded-json'

/**
 * The bounds one API page collection runs under. Separate from `api-json.provider.ts` so a phase-3
 * adapter can state its own ceilings without importing the loop, and so `bounded-json.ts` stays
 * unaware of pagination.
 */
export interface ApiJsonLimits extends JsonLimits {
  /**
   * Hard ceiling on pages PER ATTEMPT — counted from the page the attempt started on, not from
   * page one, so a resumed attempt gets a full bound of its own and every run makes progress.
   * Hitting it is a bound, not a failure: see `deriveCoverage`, where a SEARCH scope keeps WINDOW
   * and a full-inventory scope drops to PARTIAL.
   *
   * MUST BE >= 1. A zero would make the bound fire before the first request, which is the
   * zero-fetch stall that the per-attempt counting exists to prevent — an adapter precondition,
   * stated here rather than clamped in the loop, because silently treating 0 as 1 would hide a
   * misconfigured adapter instead of surfacing it.
   */
  maxPages: number
  /** More items on one page than this is drift: the provider ignored the page size we asked for,
   * and truncating silently would report a coverage we did not have. */
  maxItemsPerPage: number
}

export const DEFAULT_API_JSON_LIMITS: ApiJsonLimits = {
  ...DEFAULT_JSON_LIMITS,
  maxPages: 10,
  maxItemsPerPage: 500,
}
