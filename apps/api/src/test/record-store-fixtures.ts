import { createHash } from 'node:crypto'
import type { JobSourceType } from '@crm/shared'
import type { Pool } from 'pg'
import type { SourceObservation } from '../job-sourcing/normalize/observation'

/**
 * Fixtures for the record store's real-Postgres specs (r5 Task 4.5). Spec-only. Every record's
 * namespace starts with `t3spec-<tag>` so `LedgerFixtures.cleanup` removes it; every description
 * carries the tag so the blobs can be removed too.
 */

export interface ObservationSeed {
  namespace: string
  nativeId: string
  provider?: JobSourceType
  title?: string
  company?: string
  postingUrl?: string
  applicationUrl?: string | null
  /** Anything that should change the content hash (a new revision of the same posting). */
  version?: string
  tag: string
}

export function observation(s: ObservationSeed): SourceObservation {
  const title = s.title ?? 'Senior Go Engineer'
  const company = s.company ?? 'Acme'
  const posting = s.postingUrl ?? `https://fixture.test/jobs/${s.nativeId}`
  const description = `Build things (${s.tag}, ${s.version ?? 'v1'}).`
  const contentHash = createHash('sha256')
    .update(JSON.stringify([s.nativeId, title, company, posting, description]))
    .digest('hex')
  return {
    identity: {
      provider: s.provider ?? 'REMOTIVE_API',
      namespace: s.namespace,
      nativeId: s.nativeId,
      identityKey: JSON.stringify([s.nativeId]),
      identityKind: 'NATIVE_ID',
    },
    sourcePostingUrl: posting,
    applicationUrl: s.applicationUrl ?? null,
    originalFields: {} as SourceObservation['originalFields'],
    normalized: {
      title,
      companyName: company,
      companyNameNormalized: company.toLowerCase(),
      location: 'Remote',
      descriptionMd: description,
      publishedAt: null,
      dates: [],
      tags: ['go'],
    },
    evidence: [],
    adapterVersion: 'remotive_api-1',
    normalizerVersion: 'n1',
    contentHash,
  }
}

export interface StoreCounts {
  records: number
  revisions: number
  memberships: number
  dirty: number
  opportunities: number
  links: number
  tokens: number
}

/** Row counts of everything the store writes, for records whose namespace contains `prefix`. */
export async function storeCounts(admin: Pool, prefix: string): Promise<StoreCounts> {
  const { rows } = await admin.query(
    `WITH r AS (SELECT id FROM job_source_records WHERE namespace LIKE '%' || $1 || '%'),
          o AS (SELECT DISTINCT opportunity_id AS id FROM job_opportunity_sources
                 WHERE source_record_id IN (SELECT id FROM r))
     SELECT (SELECT count(*) FROM r)::int AS records,
            (SELECT count(*) FROM job_source_record_revisions WHERE source_record_id IN (SELECT id FROM r))::int AS revisions,
            (SELECT count(*) FROM job_run_records WHERE source_record_id IN (SELECT id FROM r))::int AS memberships,
            (SELECT count(*) FROM job_dirty_work WHERE entity_id IN (SELECT id FROM r UNION SELECT id FROM o))::int AS dirty,
            (SELECT count(*) FROM o)::int AS opportunities,
            (SELECT count(*) FROM job_opportunity_sources WHERE source_record_id IN (SELECT id FROM r))::int AS links,
            (SELECT count(*) FROM job_opportunity_identity_tokens WHERE source_record_id IN (SELECT id FROM r))::int AS tokens`,
    [prefix],
  )
  return rows[0] as StoreCounts
}

/** Legacy rows the store must never create. */
export async function legacyCounts(
  admin: Pool,
): Promise<{ suggestions: number; postings: number }> {
  const { rows } = await admin.query(
    `SELECT (SELECT count(*) FROM job_suggestions)::int AS suggestions,
            (SELECT count(*) FROM job_postings)::int AS postings`,
  )
  return rows[0] as { suggestions: number; postings: number }
}

/**
 * Remove the canonical rows (links are RESTRICT) and dirty work of records under `prefix`, then
 * the blobs carrying `tag`. Run BEFORE `LedgerFixtures.cleanup`, which deletes the records.
 */
export async function cleanupStore(admin: Pool, prefix: string, tag: string): Promise<void> {
  // CONTAINS, not starts with: an ATS board namespace is `greenhouse:<board>`.
  const records = `SELECT id FROM job_source_records WHERE namespace LIKE '%' || $1 || '%'`
  const { rows } = await admin.query(
    `SELECT DISTINCT opportunity_id AS id FROM job_opportunity_sources WHERE source_record_id IN (${records})`,
    [prefix],
  )
  const opportunities = rows.map((r) => r.id as string)
  await admin.query(
    `DELETE FROM job_dirty_work WHERE entity_id IN (${records}) OR entity_id = ANY($2::uuid[])`,
    [prefix, opportunities],
  )
  await admin.query(`DELETE FROM job_opportunity_sources WHERE source_record_id IN (${records})`, [
    prefix,
  ])
  await admin.query(`DELETE FROM job_opportunities WHERE id = ANY($1::uuid[])`, [opportunities])
  await admin.query(
    `DELETE FROM job_source_record_revisions WHERE source_record_id IN (${records})`,
    [prefix],
  )
  await admin.query(`DELETE FROM job_source_records WHERE namespace LIKE '%' || $1 || '%'`, [
    prefix,
  ])
  await admin.query(`DELETE FROM job_text_blobs WHERE text LIKE '%' || $1 || '%'`, [tag])
}
