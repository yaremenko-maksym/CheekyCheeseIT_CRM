import { createHash } from 'node:crypto'
import {
  externalHttpsUrlSchema,
  jobSourceIdentitySchema,
  jobSourceRevisionSchema,
} from '@crm/shared'
import { MAX_DESCRIPTION_CHARS } from '../html-to-markdown'
import {
  DISPLAY_TAG_CHARS,
  DISPLAY_TAGS,
  MAX_OBSERVED_DATES,
  type SourceObservation,
  toStoredIdentity,
  toStoredRevisionFields,
} from '../normalize/observation'

/**
 * Evidence entries one observation can carry: one per date (MAX_OBSERVED_DATES), one rejected
 * link and a few display truncations — 32 is well above that and still a bounded jsonb row.
 */
export const MAX_EVIDENCE_ENTRIES = 32

const storedRevision = jobSourceRevisionSchema.pick({
  adapterVersion: true,
  normalizerVersion: true,
  contentHash: true,
  title: true,
  companyName: true,
  location: true,
  applicationUrl: true,
})

/**
 * The store does not trust the TypeScript type of what it is handed (SR-M-4): the identity and
 * the revision fields are re-parsed with the store's own schemas (`publishedAt` is not: it is
 * serialised from a Date, so it is a valid ISO instant or the serialisation already threw), the posting URL with the shared
 * https rule, and the two unbounded-by-type lists are bounded. Throws on the first violation.
 */
export function validateObservation(o: SourceObservation): void {
  jobSourceIdentitySchema.parse(toStoredIdentity(o.identity))
  storedRevision.parse(toStoredRevisionFields(o))
  externalHttpsUrlSchema.parse(o.sourcePostingUrl)
  const dates = o.normalized.dates.length
  if (dates > MAX_OBSERVED_DATES)
    throw new RangeError(`validateObservation: ${dates} dates, at most ${MAX_OBSERVED_DATES}`)
  const evidence = o.evidence.length
  if (evidence > MAX_EVIDENCE_ENTRIES)
    throw new RangeError(
      `validateObservation: ${evidence} evidence entries, at most ${MAX_EVIDENCE_ENTRIES}`,
    )
  // The display limits `buildSourceObservation` applies, re-checked (security LOW, round 2).
  if (o.normalized.descriptionMd.length > MAX_DESCRIPTION_CHARS)
    throw new RangeError('validateObservation: description over the display limit')
  const tags = o.normalized.tags
  if (
    tags !== undefined &&
    (tags.length > DISPLAY_TAGS || tags.some((t) => t.length > DISPLAY_TAG_CHARS))
  )
    throw new RangeError('validateObservation: tags over the display limit')
}

/**
 * What one observation writes into `job_source_record_revisions` (and `job_text_blobs`), as plain
 * values. Pure, so the mapping is unit-tested; the store only binds these to SQL.
 */
export interface RevisionPayload {
  adapterVersion: string
  normalizerVersion: string
  contentHash: string
  /** Normalized posting fields, minus the description (that is a blob). */
  normalized: Record<string, unknown>
  /** Identity fields exactly as observed. */
  originalIdentity: Record<string, unknown>
  evidence: Record<string, unknown>
  /** Content-addressed description; null for an empty one. */
  description: { sha256: string; text: string } | null
  publishedAtRaw: string | null
  publishedAt: string | null
  sourceUrl: string
  applicationUrl: string | null
}

export function revisionPayload(o: SourceObservation): RevisionPayload {
  const n = o.normalized
  const publishedAt = n.publishedAt?.toISOString() ?? null
  const text = n.descriptionMd
  return {
    adapterVersion: o.adapterVersion,
    normalizerVersion: o.normalizerVersion,
    contentHash: o.contentHash,
    normalized: {
      title: n.title,
      companyName: n.companyName,
      companyNameNormalized: n.companyNameNormalized,
      location: n.location,
      publishedAt,
      remote: n.remote ?? null,
      employmentType: n.employmentType ?? null,
      seniorityHint: n.seniorityHint ?? null,
      tags: n.tags ?? [],
      dates: n.dates,
    },
    originalIdentity: {
      provider: o.identity.provider,
      namespace: o.identity.namespace,
      nativeId: o.identity.nativeId,
      identityKind: o.identity.identityKind,
      identityKey: o.identity.identityKey,
      sourcePostingUrl: o.sourcePostingUrl,
      applicationUrl: o.applicationUrl,
    },
    evidence: { fields: o.evidence },
    description:
      text === '' ? null : { sha256: createHash('sha256').update(text).digest('hex'), text },
    publishedAtRaw: n.dates.find((d) => d.semantics === 'PUBLISHED')?.raw ?? null,
    publishedAt,
    sourceUrl: o.sourcePostingUrl,
    applicationUrl: o.applicationUrl,
  }
}
