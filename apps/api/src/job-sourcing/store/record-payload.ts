import { createHash } from 'node:crypto'
import type { SourceObservation } from '../normalize/observation'

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
