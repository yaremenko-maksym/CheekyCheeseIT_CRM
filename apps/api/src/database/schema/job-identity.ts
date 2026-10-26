/**
 * Record store side tables (r5 Task 4.5) — run membership and canonical identity tokens.
 *
 *   job_run_records                   which run observed which source record, and at which revision
 *   job_source_record_heads           per record: the order of its observations (latest = newest observed)
 *   job_opportunity_identity_tokens   a trusted cross-source job key claimed by ONE opportunity
 *
 * Both are written only by `apps/api/src/job-sourcing/store/`. The forward DDL is
 * `drizzle/manual/2026-10-25_job_record_store.sql` (wired into the deploy by Task 4.6 S0);
 * `job-record-store-forward-ddl.integration.spec.ts` compares it with `db:push`.
 */
import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { jobCollectionRuns } from './job-collection'
import { jobOpportunities, jobSourceRecordRevisions, jobSourceRecords } from './job-opportunities'
import { users } from './users'

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
 * The observation order of one record (CR-M-2). `observed_at` is when the observing run started
 * (its fetch time, as far as the store can know it); `observation_seq` counts observations that
 * moved the latest pointer, per record, and is the dirty-work `target_version` — monotonic, so
 * content A -> B -> A enqueues three distinct versions. An observation older than `observed_at`
 * (a slow run committing after a later one) is stored as a revision and never moves the pointer.
 * A side table rather than columns on `job_source_records`, whose catalog is pinned by the
 * Phase-1 forward DDL.
 */
export const jobSourceRecordHeads = pgTable(
  'job_source_record_heads',
  {
    sourceRecordId: uuid('source_record_id').primaryKey(),
    latestRevisionId: uuid('latest_revision_id').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    observationSeq: bigint('observation_seq', { mode: 'number' }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'fk_job_source_record_heads_record',
      columns: [t.sourceRecordId],
      foreignColumns: [jobSourceRecords.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_job_source_record_heads_revision',
      columns: [t.latestRevisionId],
      foreignColumns: [jobSourceRecordRevisions.id],
    }).onDelete('cascade'),
    index('idx_job_source_record_heads_revision').on(t.latestRevisionId),
    check('ck_job_source_record_heads_seq_positive', sql`${t.observationSeq} > 0`),
  ],
)

/**
 * A trusted identity token: at most ONE opportunity owns a (kind, key). Only vendor-hosted ATS job
 * keys (`trustedAtsKeys`) become tokens — never an unverified apply URL, a homepage or a company
 * name — and only a record from that ATS's own adapter may claim one (SR-M-2). The partial UNIQUE
 * index over ACTIVE rows is the claim: `INSERT … ON CONFLICT DO NOTHING`, then read the owner. An
 * ADMIN release (`releaseToken`) sets `released_*` and keeps the row as history.
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
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: uuid('released_by'),
    releaseReason: text('release_reason'),
  },
  (t) => [
    uniqueIndex('uq_job_opportunity_identity_tokens_active_key')
      .on(t.namespaceKind, t.tokenKey)
      .where(sql`${t.releasedAt} IS NULL`),
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
    foreignKey({
      name: 'fk_job_opportunity_identity_tokens_released_by',
      columns: [t.releasedBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    index('idx_job_opportunity_identity_tokens_released_by').on(t.releasedBy),
    // A release says when, who and why — all three or none.
    check(
      'ck_job_opportunity_identity_tokens_release_triple',
      sql`(${t.releasedAt} IS NULL) = (${t.releasedBy} IS NULL) AND (${t.releasedAt} IS NULL) = (${t.releaseReason} IS NULL)`,
    ),
    check(
      'ck_job_opportunity_identity_tokens_release_reason_bounded',
      sql`${t.releaseReason} IS NULL OR length(${t.releaseReason}) <= 500`,
    ),
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
export type JobSourceRecordHead = typeof jobSourceRecordHeads.$inferSelect
export type JobOpportunityIdentityToken = typeof jobOpportunityIdentityTokens.$inferSelect
