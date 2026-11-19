import type { JobSourceType } from '@crm/shared'

/**
 * EMPLOYER WITHHELD AT THE SOURCE — the third state of the employer field.
 *
 * The employer of a posting is in exactly one of three states, and they are not interchangeable:
 *
 *   * DISCLOSED — the feed carries an employer and we stored it.
 *   * WITHHELD_AT_SOURCE — the source does not publish one BY DESIGN, and says so by being the
 *     kind of source it is. The posting is real, complete and worth a senior's attention; the
 *     employer is simply not knowable from this feed.
 *   * absent for any OTHER reason — a feed that is supposed to carry an employer and did not. That
 *     is a defect in the item or in our adapter, it stays a `MISSING_COMPANY` quarantine, and
 *     nothing here widens it.
 *
 * The distinction is a PROPERTY OF THE SOURCE TYPE, declared here, and never a property of an
 * individual item: a per-item flag would let one malformed entry of any feed claim the state and
 * turn a real defect into a stored posting with no employer. The key is `raw.provider`, which the
 * collection loop stamps from `spec.type` AFTER the adapter's `mapItem` has run
 * (`providers/api-json.provider.ts`), so an adapter cannot assert it for itself.
 *
 * THE EMPLOYER IS NEVER GUESSED. Not from the title, not from the description's prose, not from the
 * feed's own name: a withheld employer is stored as withheld, never as the source's brand. Djinni
 * withholds the employer until a candidate applies, which is why the state exists at all
 * (backlog 309; owner decision 2026-11-19 that such a posting IS worth a senior's attention).
 *
 * Adding a source here is a data-contract change: it converts that source's missing employers from
 * quarantined to stored. Add one only when the source's OWN published feed has no employer field,
 * with a capture in `providers/sources/__fixtures__/` showing it.
 */
export const EMPLOYER_WITHHELD_BY_SOURCE: Readonly<Partial<Record<JobSourceType, true>>> =
  Object.freeze({
    DJINNI_RSS: true,
  })

/** Whether this source type publishes no employer by design (see the file header). */
export function withholdsEmployerByDesign(provider: JobSourceType): boolean {
  return EMPLOYER_WITHHELD_BY_SOURCE[provider] === true
}

/**
 * The stored marker. One value today; it is a union so a reader must match on it rather than treat
 * a truthy field as "withheld", and so a second disclosure state can be added without re-typing
 * every consumer.
 */
export type EmployerDisclosure = 'WITHHELD_AT_SOURCE'
