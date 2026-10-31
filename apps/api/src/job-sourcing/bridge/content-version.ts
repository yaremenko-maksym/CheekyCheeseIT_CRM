import { createHash } from 'node:crypto'
import type { NormalizedPosting } from '../job-source.provider'

/**
 * r5 Task 4.6 S6d — the delivery row's `content_version` (ADR
 * `2026-10-31-dou-bridge-run-ownership.md`, section 2): a content hash of the `NormalizedPosting`
 * exactly as the provider returned it. It is NOT the store's `observation_seq`, so the legacy feed
 * never depends on the new store — an item the observation validator refuses still reaches the
 * legacy consumers under its own version.
 *
 * First write wins: a changed description makes a new version, so the re-enqueue is a fresh key and
 * the old DUPLICATE/CREATED row is left untouched (ADR "Legacy semantics are kept"). Tag order is
 * canonicalised so a feed that re-orders its tags does not spuriously make a new version.
 */
export function contentVersion(posting: NormalizedPosting): string {
  const canonical = {
    sourceType: posting.sourceType,
    externalId: posting.externalId,
    url: posting.url,
    title: posting.title,
    companyName: posting.companyName,
    companyNameNormalized: posting.companyNameNormalized,
    location: posting.location ?? null,
    descriptionMd: posting.descriptionMd,
    publishedAt: posting.publishedAt?.toISOString() ?? null,
    remote: posting.remote ?? null,
    employmentType: posting.employmentType ?? null,
    seniorityHint: posting.seniorityHint ?? null,
    // Stryker disable next-line LogicalOperator: `tags ?? []` is equivalent — `new Set(undefined)`
    // and `new Set([])` are both empty, so the hash is identical whether tags is absent or empty.
    tags: [...new Set(posting.tags ?? [])].sort(),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}
