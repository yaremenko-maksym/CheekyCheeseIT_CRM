import { DEFAULT_JSON_LIMITS, type JsonLimits } from './bounded-json'

/**
 * The bounds one API page collection runs under. Separate from `api-json.provider.ts` so a phase-3
 * adapter can state its own ceilings without importing the loop, and so `bounded-json.ts` stays
 * unaware of pagination.
 */
export interface ApiJsonLimits extends JsonLimits {
  /** Hard ceiling on pages per attempt. Hitting it is a bound, not a failure — see
   * `deriveCoverage`: on a SEARCH scope it is a WINDOW, on a full-inventory scope PARTIAL. */
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
