/**
 * DOU bridge delivery ledger (r5 Task 4.6, slice S6b; ADR
 * `docs/architecture/2026-10-31-dou-bridge-run-ownership.md` D-3).
 *
 *   job_bridge_deliveries   one row per (consumer, posting identity, content version) the bridge
 *                           must hand to a legacy consumer: the `job_postings` insert
 *                           (LEGACY_POSTING) and the senior suggestions (LEGACY_SUGGESTION).
 *
 * The forward DDL is `drizzle/manual-staged/2026-10-31_job_bridge_deliveries.sql` (STAGED, not
 * applied by the deploy; promotion is slice S6f); `job-bridge-deliveries-forward-ddl.integration.spec.ts`
 * compares it with `db:push`. Nothing reads or writes the table yet (S6d / S6e).
 *
 * `consumer` and `status` are text + CHECK rather than the enum types the ADR sketch names: the
 * same closed sets, without a non-idempotent `CREATE TYPE` in a re-applied file and without a
 * `DROP TYPE` in the rollback (the `namespace_kind` precedent in `job-identity.ts`).
 */
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { jobSourceTypeEnum } from './enums'
import { jobCollectionRuns } from './job-collection'
import { jobPostings, jobSources } from './job-sourcing'

export const JOB_BRIDGE_CONSUMERS = ['LEGACY_POSTING', 'LEGACY_SUGGESTION'] as const
export type JobBridgeConsumer = (typeof JOB_BRIDGE_CONSUMERS)[number]
export const JOB_BRIDGE_STATUSES = ['PENDING', 'DONE', 'INVALID'] as const
export type JobBridgeStatus = (typeof JOB_BRIDGE_STATUSES)[number]
/** Upper bound of one stored payload (`pg_column_size`); real DOU items are a few KiB. */
export const JOB_BRIDGE_PAYLOAD_MAX_BYTES = 65536

export const jobBridgeDeliveries = pgTable(
  'job_bridge_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** SET NULL: postings outlive a deleted source (`job_postings.source_id`), so must this evidence. */
    sourceId: uuid('source_id'),
    provider: jobSourceTypeEnum('provider').notNull(),
    consumer: text('consumer').$type<JobBridgeConsumer>().notNull(),
    /** The posting fingerprint. */
    identityKey: text('identity_key').notNull(),
    /** sha256 of the NormalizedPosting; a suggestion row carries its posting row's version. */
    contentVersion: text('content_version').notNull(),
    /** The NormalizedPosting (LEGACY_POSTING) or `{}` (LEGACY_SUGGESTION). */
    payload: jsonb('payload').notNull(),
    status: text('status').$type<JobBridgeStatus>().notNull().default('PENDING'),
    /** CREATED | DUPLICATE | <db error class>. */
    outcome: text('outcome'),
    /** CREATED and DUPLICATE both store it, so a purged posting cascades this row away. */
    postingId: uuid('posting_id'),
    suggestionsCreated: integer('suggestions_created'),
    enqueuedByRun: uuid('enqueued_by_run').notNull(),
    deliveredByRun: uuid('delivered_by_run'),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'fk_job_bridge_deliveries_source',
      columns: [t.sourceId],
      foreignColumns: [jobSources.id],
    }).onDelete('set null'),
    // CASCADE: retention purges unanswered postings; a delivery of a purged posting means nothing.
    foreignKey({
      name: 'fk_job_bridge_deliveries_posting',
      columns: [t.postingId],
      foreignColumns: [jobPostings.id],
    }).onDelete('cascade'),
    // RESTRICT: runs are never deleted (no retention path does), and a run purge must not erase
    // delivery evidence silently.
    foreignKey({
      name: 'fk_job_bridge_deliveries_enqueued_by_run',
      columns: [t.enqueuedByRun],
      foreignColumns: [jobCollectionRuns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_bridge_deliveries_delivered_by_run',
      columns: [t.deliveredByRun],
      foreignColumns: [jobCollectionRuns.id],
    }).onDelete('restrict'),
    // The delivery identity.
    uniqueIndex('uq_job_bridge_delivery').on(t.consumer, t.identityKey, t.contentVersion),
    // The drain reads only PENDING rows, per source.
    index('ix_job_bridge_pending')
      .on(t.sourceId, t.consumer, t.createdAt)
      .where(sql`${t.status} = 'PENDING'`),
    // FK child index: the posting purge's CASCADE probes it.
    index('idx_job_bridge_deliveries_posting').on(t.postingId),
    check('ck_job_bridge_consumer', sql`${t.consumer} IN ('LEGACY_POSTING', 'LEGACY_SUGGESTION')`),
    check('ck_job_bridge_status', sql`${t.status} IN ('PENDING', 'DONE', 'INVALID')`),
    check('ck_job_bridge_legacy_only', sql`${t.provider} = 'DOU_RSS'`),
    check(
      'ck_job_bridge_suggestion_post',
      sql`${t.consumer} <> 'LEGACY_SUGGESTION' OR ${t.postingId} IS NOT NULL`,
    ),
    // A DONE posting delivery (CREATED or DUPLICATE) names its posting, so a purge cascades the
    // row away and the next collection re-offers the item (ADR D-3, "A purged posting reappearing").
    check(
      'ck_job_bridge_posting_done_has_posting',
      sql`${t.consumer} <> 'LEGACY_POSTING' OR ${t.status} <> 'DONE' OR ${t.postingId} IS NOT NULL`,
    ),
    check(
      'ck_job_bridge_done_stamped',
      sql`(${t.status} = 'PENDING') = (${t.deliveredAt} IS NULL)`,
    ),
    check(
      'ck_job_bridge_payload_size',
      sql`pg_column_size(${t.payload}) <= ${sql.raw(String(JOB_BRIDGE_PAYLOAD_MAX_BYTES))}`,
    ),
  ],
)
