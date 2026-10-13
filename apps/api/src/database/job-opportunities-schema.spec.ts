import type { SQL } from 'drizzle-orm'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  jobAvailabilitySchema,
  jobIdentityKindSchema,
  jobOpportunityLinkDecisionSchema,
  jobOpportunityMatchOutcomeSchema,
  jobSourceTypeSchema,
} from '@crm/shared'
import {
  jobAvailabilityEnum,
  jobIdentityKindEnum,
  jobOpportunities,
  jobOpportunityLinkDecisionEnum,
  jobOpportunityMatches,
  jobOpportunityMatchOutcomeEnum,
  jobOpportunitySources,
  jobOpportunityTeamTriage,
  jobSourceRecordRevisions,
  jobSourceRecords,
  jobSourceTypeEnum,
  jobTextBlobs,
  teams,
  users,
} from './schema'

/**
 * r5 Task 1.2 — the new `job_opportunities` store, asserted against the Drizzle
 * metadata (the same declarations `db:push` applies). Real-catalog proof is the
 * scratch-database push recorded in the PR.
 */

const render = (s: unknown) => new PgDialect().sqlToQuery(s as SQL).sql

const names = (t: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(t).columns.map((c) => c.name)
const col = (t: Parameters<typeof getTableConfig>[0], n: string) => {
  const c = getTableConfig(t).columns.find((x) => x.name === n)
  if (!c) throw new Error(`no column ${n}`)
  return c
}
const index = (t: Parameters<typeof getTableConfig>[0], n: string) => {
  const i = getTableConfig(t).indexes.find((x) => x.config.name === n)
  if (!i) throw new Error(`no index ${n}`)
  return i
}
const uniqueCols = (t: Parameters<typeof getTableConfig>[0], n: string) => {
  const u = getTableConfig(t).uniqueConstraints.find((x) => x.name === n)
  if (!u) throw new Error(`no unique ${n}`)
  return u.columns.map((c) => c.name)
}
const checkNames = (t: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(t).checks.map((c) => c.name)
const fk = (t: Parameters<typeof getTableConfig>[0], column: string) => {
  const f = getTableConfig(t).foreignKeys.find((x) => x.reference().columns[0]?.name === column)
  if (!f) throw new Error(`no fk on ${column}`)
  return f
}

describe('enum parity (pg <-> shared zod)', () => {
  it('mirrors the shared enums member for member, in order', () => {
    expect([...jobAvailabilityEnum.enumValues]).toEqual([...jobAvailabilitySchema.options])
    expect([...jobIdentityKindEnum.enumValues]).toEqual([...jobIdentityKindSchema.options])
    expect([...jobOpportunityMatchOutcomeEnum.enumValues]).toEqual([
      ...jobOpportunityMatchOutcomeSchema.options,
    ])
    expect([...jobOpportunityLinkDecisionEnum.enumValues]).toEqual([
      ...jobOpportunityLinkDecisionSchema.options,
    ])
  })
  it('names the pg types', () => {
    expect(jobAvailabilityEnum.enumName).toBe('job_availability')
    expect(jobIdentityKindEnum.enumName).toBe('job_identity_kind')
    expect(jobOpportunityMatchOutcomeEnum.enumName).toBe('job_opportunity_match_outcome')
    expect(jobOpportunityLinkDecisionEnum.enumName).toBe('job_opportunity_link_decision')
  })
})

describe('table names (job_opportunities family, never job_vacancies*)', () => {
  it.each([
    [jobTextBlobs, 'job_text_blobs'],
    [jobSourceRecords, 'job_source_records'],
    [jobSourceRecordRevisions, 'job_source_record_revisions'],
    [jobOpportunities, 'job_opportunities'],
    [jobOpportunitySources, 'job_opportunity_sources'],
    [jobOpportunityMatches, 'job_opportunity_matches'],
    [jobOpportunityTeamTriage, 'job_opportunity_team_triage'],
  ])('%#', (t, name) => {
    expect(getTableConfig(t).name).toBe(name)
  })
})

describe('job_text_blobs', () => {
  it('is content-addressed: sha256 is the primary key', () => {
    expect(names(jobTextBlobs)).toEqual(['sha256', 'text', 'created_at'])
    expect(col(jobTextBlobs, 'sha256').primary).toBe(true)
    expect(col(jobTextBlobs, 'text').notNull).toBe(true)
    expect(checkNames(jobTextBlobs)).toContain('ck_job_text_blobs_sha256_hex')
  })
})

describe('job_source_records', () => {
  it('carries scoped identity, urls, observation window and availability evidence', () => {
    expect(names(jobSourceRecords)).toEqual(
      expect.arrayContaining([
        'id',
        'source_type',
        'namespace',
        'identity_kind',
        'identity_key',
        'original_url',
        'display_url',
        'source_url',
        'application_url',
        'first_seen_at',
        'last_observed_at',
        'latest_revision_id',
        'availability',
        'availability_evidence',
        'availability_checked_at',
      ]),
    )
  })
  it('UNIQUE(provider type, namespace, identity key) — native scoped identity, not the legacy fingerprint', () => {
    expect(uniqueCols(jobSourceRecords, 'uq_job_source_records_identity')).toEqual([
      'source_type',
      'namespace',
      'identity_key',
    ])
    expect(names(jobSourceRecords)).not.toContain('fingerprint')
  })
  it('namespace defaults to empty (never NULL, so the unique key has no NULL hole)', () => {
    expect(col(jobSourceRecords, 'namespace').notNull).toBe(true)
    expect(col(jobSourceRecords, 'namespace').default).toBe('')
  })
  it('availability defaults UNKNOWN and is notNull', () => {
    expect(col(jobSourceRecords, 'availability').default).toBe('UNKNOWN')
    expect(col(jobSourceRecords, 'availability').notNull).toBe(true)
  })
  it('stored URLs are https-only by CHECK', () => {
    const checks = checkNames(jobSourceRecords)
    for (const n of [
      'ck_job_source_records_original_url_https',
      'ck_job_source_records_display_url_https',
      'ck_job_source_records_source_url_https',
      'ck_job_source_records_application_url_https',
    ]) {
      expect(checks).toContain(n)
    }
    const c = getTableConfig(jobSourceRecords).checks.find(
      (x) => x.name === 'ck_job_source_records_source_url_https',
    )
    expect(render(c?.value)).toContain('~*')
    expect(render(c?.value)).toContain('^https://')
  })
  it('latest revision is a nullable FK that nulls out', () => {
    expect(col(jobSourceRecords, 'latest_revision_id').notNull).toBe(false)
    expect(fk(jobSourceRecords, 'latest_revision_id').onDelete).toBe('set null')
  })
  it('timestamps are timestamptz', () => {
    for (const n of ['first_seen_at', 'last_observed_at', 'availability_checked_at']) {
      expect(col(jobSourceRecords, n).getSQLType()).toBe('timestamp with time zone')
    }
  })
})

describe('job_source_record_revisions', () => {
  it('carries versions, hash, payloads, provenance, dates and arrival order', () => {
    expect(names(jobSourceRecordRevisions)).toEqual(
      expect.arrayContaining([
        'id',
        'source_record_id',
        'adapter_version',
        'normalizer_version',
        'content_hash',
        'normalized',
        'original_identity',
        'field_provenance',
        'evidence',
        'description_sha256',
        'published_at_raw',
        'published_at',
        'received_seq',
        'received_at',
        'sample_ref',
      ]),
    )
  })
  it('UNIQUE(record, content hash, normalizer version)', () => {
    // Set semantics; the declared order follows the table's column order (see the schema comment).
    expect(
      [...uniqueCols(jobSourceRecordRevisions, 'uq_job_source_record_revisions_content')].sort(),
    ).toEqual(['content_hash', 'normalizer_version', 'source_record_id'])
  })
  it('belongs to a record (cascade) and references the blob store for the description', () => {
    expect(fk(jobSourceRecordRevisions, 'source_record_id').onDelete).toBe('cascade')
    const d = fk(jobSourceRecordRevisions, 'description_sha256')
    expect(d.reference().foreignTable).toBe(jobTextBlobs)
    expect(d.onDelete).toBe('restrict')
    expect(col(jobSourceRecordRevisions, 'description_sha256').notNull).toBe(false)
  })
  it('received_seq is a database-assigned identity (arrival order, not publish order)', () => {
    const c = col(jobSourceRecordRevisions, 'received_seq')
    expect(c.generatedIdentity?.type).toBe('always')
    expect(c.getSQLType()).toBe('bigint')
  })
  it('content hash is a 64-hex CHECK; raw and parsed dates are separate columns', () => {
    expect(checkNames(jobSourceRecordRevisions)).toContain(
      'ck_job_source_record_revisions_content_hash_hex',
    )
    expect(col(jobSourceRecordRevisions, 'published_at_raw').getSQLType()).toBe('text')
    expect(col(jobSourceRecordRevisions, 'published_at').getSQLType()).toBe(
      'timestamp with time zone',
    )
  })
  it('jsonb payloads are notNull', () => {
    for (const n of ['normalized', 'original_identity', 'field_provenance', 'evidence']) {
      expect(col(jobSourceRecordRevisions, n).notNull).toBe(true)
      expect(col(jobSourceRecordRevisions, n).getSQLType()).toBe('jsonb')
    }
  })
  it('has a latest-revision lookup index', () => {
    expect(
      index(jobSourceRecordRevisions, 'idx_job_source_record_revisions_record_seq'),
    ).toBeDefined()
  })
})

describe('job_opportunities', () => {
  it('has canonical fields, provenance, availability and a revision number', () => {
    expect(names(jobOpportunities)).toEqual(
      expect.arrayContaining([
        'id',
        'title',
        'title_key',
        'employer_name',
        'employer_key',
        'employer_verified',
        'location',
        'seniority',
        'stack_keywords',
        'application_url',
        'application_url_key',
        'published_at',
        'description_sha256',
        'field_revisions',
        'availability',
        'revision',
        'first_seen_at',
        'last_observed_at',
      ]),
    )
  })
  it('employer is nullable (no employer invented from a slug) and unverified by default', () => {
    expect(col(jobOpportunities, 'employer_name').notNull).toBe(false)
    expect(col(jobOpportunities, 'employer_key').notNull).toBe(false)
    expect(col(jobOpportunities, 'employer_verified').default).toBe(false)
  })
  it('a verified employer must have a key (CHECK)', () => {
    expect(checkNames(jobOpportunities)).toContain('ck_job_opportunities_verified_has_key')
  })
  it('revision starts at 1 and must be positive', () => {
    expect(col(jobOpportunities, 'revision').default).toBe(1)
    expect(checkNames(jobOpportunities)).toContain('ck_job_opportunities_revision_positive')
  })
  it('has NO unique constraint on company/title — candidate keys are indexed non-uniquely', () => {
    const cfg = getTableConfig(jobOpportunities)
    expect(cfg.uniqueConstraints).toHaveLength(0)
    const uniq = cfg.indexes.filter((i) => i.config.unique)
    expect(uniq).toHaveLength(0)
    const cand = index(jobOpportunities, 'idx_job_opportunities_candidate_key')
    expect(cand.config.columns.map((c) => (c as { name: string }).name)).toEqual([
      'employer_key',
      'title_key',
    ])
    expect(index(jobOpportunities, 'idx_job_opportunities_application_url_key')).toBeDefined()
  })
  it('keyword -> opportunity lookup is a GIN index; defaults are typed empty literals', () => {
    expect(index(jobOpportunities, 'idx_job_opportunities_stack_keywords').config.method).toBe(
      'gin',
    )
    expect(render(col(jobOpportunities, 'stack_keywords').default)).toBe(`'{}'::text[]`)
    expect(col(jobOpportunities, 'stack_keywords').notNull).toBe(true)
    expect(render(col(jobOpportunities, 'field_revisions').default)).toBe(`'{}'::jsonb`)
  })
  it('application URL is https-only; availability/seniority default to UNKNOWN', () => {
    expect(checkNames(jobOpportunities)).toContain('ck_job_opportunities_application_url_https')
    expect(col(jobOpportunities, 'availability').default).toBe('UNKNOWN')
    expect(col(jobOpportunities, 'seniority').default).toBe('UNKNOWN')
  })
})

describe('job_opportunity_sources', () => {
  it('links a record to an opportunity with decision, evidence, rule version and unlink history', () => {
    expect(names(jobOpportunitySources)).toEqual(
      expect.arrayContaining([
        'id',
        'source_record_id',
        'opportunity_id',
        'decision',
        'evidence',
        'rule_version',
        'linked_at',
        'unlinked_at',
        'unlink_reason',
      ]),
    )
    expect(col(jobOpportunitySources, 'decision').default).toBe('AUTO')
  })
  it('partial UNIQUE(record) WHERE active — one active owner per record, history preserved', () => {
    const i = index(jobOpportunitySources, 'uq_job_opportunity_sources_active_record')
    expect(i.config.unique).toBe(true)
    expect(i.config.columns.map((c) => (c as { name: string }).name)).toEqual(['source_record_id'])
    expect(render(i.config.where)).toContain('"unlinked_at" IS NULL')
  })
  it('history is never cascaded away', () => {
    expect(fk(jobOpportunitySources, 'source_record_id').onDelete).toBe('restrict')
    expect(fk(jobOpportunitySources, 'opportunity_id').onDelete).toBe('restrict')
  })
  it('an unlink carries a reason and vice versa (CHECK)', () => {
    expect(checkNames(jobOpportunitySources)).toContain('ck_job_opportunity_sources_unlink_pair')
  })
})

describe('job_opportunity_matches', () => {
  it('UNIQUE(opportunity, senior)', () => {
    expect(
      uniqueCols(jobOpportunityMatches, 'uq_job_opportunity_matches_opportunity_senior'),
    ).toEqual(['opportunity_id', 'senior_id'])
  })
  it('stores input versions, outcome, evidence and evaluation time', () => {
    expect(names(jobOpportunityMatches)).toEqual(
      expect.arrayContaining([
        'opportunity_revision',
        'senior_profile_version',
        'exclusion_version',
        'rule_version',
        'outcome',
        'evidence',
        'evaluated_at',
      ]),
    )
    for (const n of [
      'opportunity_revision',
      'senior_profile_version',
      'exclusion_version',
      'rule_version',
      'outcome',
      'evaluated_at',
    ]) {
      expect(col(jobOpportunityMatches, n).notNull).toBe(true)
    }
  })
  it('outcome is LEAD/TRIAGE/EXCLUDED only — a plain mismatch is never stored', () => {
    expect([...jobOpportunityMatchOutcomeEnum.enumValues]).toEqual(['LEAD', 'TRIAGE', 'EXCLUDED'])
  })
  it('per-senior invalidation index leads with senior_id', () => {
    const i = index(jobOpportunityMatches, 'idx_job_opportunity_matches_senior')
    expect(i.config.columns.map((c) => (c as { name: string }).name)[0]).toBe('senior_id')
  })
  it('cascades with the opportunity and the senior', () => {
    expect(fk(jobOpportunityMatches, 'opportunity_id').onDelete).toBe('cascade')
    const s = fk(jobOpportunityMatches, 'senior_id')
    expect(s.onDelete).toBe('cascade')
    expect(s.reference().foreignTable).toBe(users)
  })
})

describe('job_opportunity_team_triage', () => {
  it('UNIQUE(opportunity, team)', () => {
    expect(
      uniqueCols(jobOpportunityTeamTriage, 'uq_job_opportunity_team_triage_opportunity_team'),
    ).toEqual(['opportunity_id', 'team_id'])
  })
  it('records the ADMIN assignment with evidence, policy, revision and expiry', () => {
    expect(names(jobOpportunityTeamTriage)).toEqual(
      expect.arrayContaining([
        'assigned_by',
        'evidence',
        'policy_version',
        'opportunity_revision',
        'grant_version',
        'expires_at',
        'revoked_at',
      ]),
    )
    expect(col(jobOpportunityTeamTriage, 'assigned_by').notNull).toBe(true)
    expect(col(jobOpportunityTeamTriage, 'expires_at').notNull).toBe(true)
    expect(col(jobOpportunityTeamTriage, 'grant_version').default).toBe(1)
    expect(fk(jobOpportunityTeamTriage, 'team_id').reference().foreignTable).toBe(teams)
    expect(fk(jobOpportunityTeamTriage, 'assigned_by').onDelete).toBe('restrict')
  })
})

describe('identifiers fit Postgres (63 chars) — longer names are truncated and cause re-push drift', () => {
  const all = [
    jobTextBlobs,
    jobSourceRecords,
    jobSourceRecordRevisions,
    jobOpportunities,
    jobOpportunitySources,
    jobOpportunityMatches,
    jobOpportunityTeamTriage,
  ]
  it('every FK has an explicit or short-enough name; every index/unique/check name is <= 63', () => {
    for (const t of all) {
      const cfg = getTableConfig(t)
      const ids = [
        ...cfg.indexes.map((i) => i.config.name),
        ...cfg.uniqueConstraints.map((u) => u.name ?? ''),
        ...cfg.checks.map((c) => c.name),
        ...cfg.foreignKeys.map((f) => f.getName()),
      ]
      for (const id of ids) expect(id.length, `${cfg.name}: ${id}`).toBeLessThanOrEqual(63)
    }
  })
})

describe('provider enum is shared with the legacy store', () => {
  it('records reuse job_source_type (31 members)', () => {
    expect([...jobSourceTypeEnum.enumValues]).toEqual([...jobSourceTypeSchema.options])
    expect(col(jobSourceRecords, 'source_type').getSQLType()).toBe('job_source_type')
  })
})
