/**
 * Record store side tables (r5 Task 4.5) — run membership and canonical identity tokens.
 *
 *   job_run_records                   which run observed which source record, and at which revision
 *   job_opportunity_identity_tokens   a trusted cross-source job key claimed by ONE opportunity
 *
 * Both are written only by `apps/api/src/job-sourcing/store/`. The forward DDL is
 * `drizzle/manual-staged/2026-10-25_job_record_store.sql` (staged, not applied by the deploy);
 * `job-record-store-forward-ddl.integration.spec.ts` compares it with `db:push`.
 */
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { jobCollectionRuns } from './job-collection'
import { jobOpportunities, jobSourceRecordRevisions, jobSourceRecords } from './job-opportunities'

/** Upper bound of a token key: an ATS key is a JSON tuple of provider, namespace and job id. */
export const IDENTITY_TOKEN_KEY_MAX = 1024
/** Upper bound of a rule-version label. */
export const IDENTITY_RULE_VERSION_MAX = 100

/**
 * Run membership: one row per (run, record) the run observed. Two discovery configurations that
 * see the same native job write two rows here and still share ONE `job_source_records` row.
 * Derived bookkeeping, so it goes with its run, record or revision (CASCADE).
 */
export const jobRunRecords = pgTable(
  'job_run_records',
  {
    runId: uuid('run_id').notNull(),
    sourceRecordId: uuid('source_record_id').notNull(),
    /** The revision this run observed first (membership is written once per run and record). */
    revisionId: uuid('revision_id').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ name: 'pk_job_run_records', columns: [t.runId, t.sourceRecordId] }),
    foreignKey({
      name: 'fk_job_run_records_run',
      columns: [t.runId],
      foreignColumns: [jobCollectionRuns.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_job_run_records_record',
      columns: [t.sourceRecordId],
      foreignColumns: [jobSourceRecords.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_job_run_records_revision',
      columns: [t.revisionId],
      foreignColumns: [jobSourceRecordRevisions.id],
    }).onDelete('cascade'),
    // FK child indexes: the CASCADE from a record or a revision probes these.
    index('idx_job_run_records_record').on(t.sourceRecordId),
    index('idx_job_run_records_revision').on(t.revisionId),
  ],
)

/**
 * A trusted identity token: at most ONE opportunity owns a (kind, key). Only vendor-hosted ATS job
 * keys (`trustedAtsKeys`) become tokens — never an unverified apply URL, a homepage or a company
 * name. The UNIQUE constraint is the claim: `INSERT … ON CONFLICT DO NOTHING`, then read the owner.
 */
export const jobOpportunityIdentityTokens = pgTable(
  'job_opportunity_identity_tokens',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    namespaceKind: text('namespace_kind').notNull(),
    tokenKey: text('token_key').notNull(),
    opportunityId: uuid('opportunity_id').notNull(),
    /** The record whose trusted key made the claim (evidence). */
    sourceRecordId: uuid('source_record_id').notNull(),
    ruleVersion: text('rule_version').notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('uq_job_opportunity_identity_tokens_key').on(t.namespaceKind, t.tokenKey),
    foreignKey({
      name: 'fk_job_opportunity_identity_tokens_opportunity',
      columns: [t.opportunityId],
      foreignColumns: [jobOpportunities.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_job_opportunity_identity_tokens_record',
      columns: [t.sourceRecordId],
      foreignColumns: [jobSourceRecords.id],
    }).onDelete('cascade'),
    index('idx_job_opportunity_identity_tokens_opportunity').on(t.opportunityId),
    index('idx_job_opportunity_identity_tokens_record').on(t.sourceRecordId),
    check('ck_job_opportunity_identity_tokens_kind', sql`${t.namespaceKind} IN ('ATS_JOB_KEY')`),
    check(
      'ck_job_opportunity_identity_tokens_key_bounded',
      sql`${t.tokenKey} ~ '[^[:space:]]' AND length(${t.tokenKey}) <= ${sql.raw(String(IDENTITY_TOKEN_KEY_MAX))}`,
    ),
    check(
      'ck_job_opportunity_identity_tokens_rule_version_bounded',
      sql`${t.ruleVersion} ~ '[^[:space:]]' AND length(${t.ruleVersion}) <= ${sql.raw(String(IDENTITY_RULE_VERSION_MAX))}`,
    ),
  ],
)

export type JobRunRecord = typeof jobRunRecords.$inferSelect
export type JobOpportunityIdentityToken = typeof jobOpportunityIdentityTokens.$inferSelect
