import type { NormalizedPosting } from '../job-source.provider'
import { LEGACY_RUN_ADAPTER_VERSION } from '../ownership/legacy-run-claim'
import { type RawObservationFields } from '../normalize/observation'

/**
 * r5 Task 4.6 S6d (covers the S6e *mapping*; S6e keeps the golden-over-fixture + the 50-item yield):
 * the DOU `NormalizedPosting` the provider returned → `RawObservationFields` for
 * `buildSourceObservation`. The pure half of T2 (ADR `2026-10-31-dou-bridge-run-ownership.md`,
 * section 2). It re-uses the one builder every adapter persists through, so the store's bounds and
 * identity rules are crossed in exactly one place.
 *
 * DOU has no native id (its identity is the canonical posting URL), so the builder falls to the URL
 * identity. The description is already markdown off the provider, so it enters as `text` and is not
 * re-converted.
 */
export const DOU_NAMESPACE = 'dou-rss'

export function douPostingToRawObservation(posting: NormalizedPosting): RawObservationFields {
  return {
    provider: posting.sourceType,
    namespace: DOU_NAMESPACE,
    url: posting.url,
    title: posting.title,
    companyName: posting.companyName,
    location: posting.location,
    description: posting.descriptionMd,
    descriptionKind: 'text',
    remote: posting.remote ?? null,
    employmentType: posting.employmentType ?? null,
    seniorityHint: posting.seniorityHint ?? null,
    tags: posting.tags ?? [],
    dates:
      posting.publishedAt != null
        ? [
            {
              semantics: 'PUBLISHED',
              contract: 'ISO_ZONED',
              raw: posting.publishedAt.toISOString(),
            },
          ]
        : [],
    adapterVersion: LEGACY_RUN_ADAPTER_VERSION,
  }
}
