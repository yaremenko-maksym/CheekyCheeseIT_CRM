/**
 * Job collection machinery (r5 Phase 1) — HOW a collection is driven.
 *
 *   job_collection_cycles           one row per trigger / logical occurrence
 *   job_collection_runs             one attempt against one source
 *   job_account_meter_reservations  cost held against an account meter
 *   job_dirty_work                  durable recompute work, enqueued transactionally
 *
 * The canonical half of the store (what an attempt FOUND) is
 * `job-opportunities.ts`; the meter these reservations draw on is
 * `job-metering.ts`. ADDITIVE: the legacy `job_postings` path is untouched and
 * its one-unit `budget_*` counters on `job_sources` stay for DOU (r5 A1h).
 *
 * Everything an adapter brings back is UNTRUSTED, so the stored error text is
 * bounded by CHECK: a typed code plus a sanitized sentence, never a provider
 * secret and never a raw upstream body.
 *
 * WHAT THE SCHEMA CANNOT ENFORCE (Phase 2 worker obligations) is listed in the
 * comment above each constraint it half-covers — a reviewer should be able to
 * tell "the database refuses this" from "the worker must not do this".
 */
import { sql } from 'drizzle-orm'
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  jobCollectionCoverageEnum,
  jobCollectionCycleStatusEnum,
  jobCollectionOutcomeEnum,
  jobCollectionTriggerEnum,
  jobDirtyWorkEntityKindEnum,
  jobDirtyWorkStatusEnum,
  jobMeterReservationStatusEnum,
} from './enums'
import { jobAccountMeters } from './job-metering'
import { jobSources } from './job-sourcing'
import { users } from './users'

/** The initial shared HTML call reservation per trigger (r5 Task 3.7). */
const HTML_CALLS_PER_CYCLE = 20

export const jobCollectionCycles = pgTable(
  'job_collection_cycles',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    trigger: jobCollectionTriggerEnum('trigger').notNull(),
    /**
     * The occurrence key: the schedule slot for SCHEDULED, the client request id
     * for MANUAL. Paired with `trigger` in the UNIQUE below, this is what makes
     * "cycle identity created atomically per trigger, deduplicated across
     * replicas" a database fact: two replicas racing the same cron tick both
     * INSERT, one gets 23505, and both then read the same cycle.
     */
    triggerKey: text('trigger_key').notNull(),
    /** The ADMIN who pressed the button; NULL for the cron. */
    requestedBy: uuid('requested_by'),
    /** The meter the shared HTML call budget is drawn from, when one applies. */
    htmlCallMeterId: uuid('html_call_meter_id'),
    /** All HTML runs of THIS occurrence share these calls. */
    htmlCallReservation: integer('html_call_reservation').notNull().default(HTML_CALLS_PER_CYCLE),
    status: jobCollectionCycleStatusEnum('status').notNull().default('OPEN'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The dedupe is a CONSTRAINT, not an application convention (AC3).
    unique('uq_job_collection_cycles_trigger_key').on(t.trigger, t.triggerKey),
    foreignKey({
      name: 'fk_job_collection_cycles_requested_by',
      columns: [t.requestedBy],
      foreignColumns: [users.id],
      // RESTRICT: a cycle is provenance; deleting the actor must not erase it.
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_collection_cycles_html_meter',
      columns: [t.htmlCallMeterId],
      foreignColumns: [jobAccountMeters.id],
    }).onDelete('set null'),
    index('idx_job_collection_cycles_status').on(t.status, t.startedAt),
    index('idx_job_collection_cycles_requested_by').on(t.requestedBy),
    index('idx_job_collection_cycles_html_meter').on(t.htmlCallMeterId),
    check('ck_job_collection_cycles_trigger_key_nonempty', sql`${t.triggerKey} ~ '[^[:space:]]'`),
    // WORKER OBLIGATION the database only half-covers: the status may be set to
    // CLOSED only once every child run and work item is terminal or deferred.
    // What the CHECK guarantees is that a CLOSED cycle always says WHEN.
    check(
      'ck_job_collection_cycles_closed_pair',
      sql`(${t.status} = 'CLOSED') = (${t.closedAt} IS NOT NULL)`,
    ),
    // A manual occurrence names its actor; a scheduled one has none. Both
    // directions: a "manual" cycle with no actor is as wrong as a cron cycle
    // attributed to a person.
    check(
      'ck_job_collection_cycles_manual_has_actor',
      sql`(${t.trigger} = 'MANUAL') = (${t.requestedBy} IS NOT NULL)`,
    ),
    check('ck_job_collection_cycles_html_reservation_positive', sql`${t.htmlCallReservation} > 0`),
  ],
)

export const jobCollectionRuns = pgTable(
  'job_collection_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceId: uuid('source_id').notNull(),
    /** Every run belongs to an occurrence (r5: every run carries `cycleId`). */
    cycleId: uuid('cycle_id').notNull(),
    /**
     * Stable across retries: a retried attempt re-uses its id, so the
     * reservation it already took is found instead of taken twice.
     */
    attemptId: text('attempt_id').notNull(),
    /**
     * The source's config version at the moment the run started. A bump
     * INVALIDATES the checkpoint: a checkpoint belongs to the config it was
     * taken under, and the partial UNIQUE below is scoped by this column, so a
     * run under a new config does not contend with a stale running one.
     */
    configVersion: integer('config_version').notNull(),
    /** The config itself, snapshotted — a later edit must not rewrite history. */
    sourceConfigSnapshot: jsonb('source_config_snapshot')
      .notNull()
      .default(sql`'{}'::jsonb`),
    adapterVersion: text('adapter_version').notNull(),
    trigger: jobCollectionTriggerEnum('trigger').notNull(),
    outcome: jobCollectionOutcomeEnum('outcome').notNull().default('STARTED'),
    /**
     * Defaults to PARTIAL, the strictest reading: a run that died before it
     * could say how much it covered must not claim FULL_INVENTORY.
     */
    coverage: jobCollectionCoverageEnum('coverage').notNull().default('PARTIAL'),
    /** Who holds the run. Present exactly while the run is STARTED. */
    ownerToken: text('owner_token'),
    /**
     * Monotonic fencing epoch. WORKER OBLIGATION: a worker writes only while its
     * epoch is still the greatest for this source, so a process that resumes
     * after a lease expiry cannot overwrite its successor's work. The database
     * stores and bounds the epoch; it cannot know whose turn it is.
     */
    fencingEpoch: bigint('fencing_epoch', { mode: 'number' }).notNull().default(1),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    /** Subrequest checkpoints (page cursors, remaining ids) for bounded resume. */
    checkpoint: jsonb('checkpoint')
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Counts mirror jobCollectionReportSchema field for field, so the stored row
    // and the wire DTO cannot drift into two different arithmetics.
    received: integer('received').notNull().default(0),
    created: integer('created').notNull().default(0),
    revised: integer('revised').notNull().default(0),
    unchanged: integer('unchanged').notNull().default(0),
    duplicates: integer('duplicates').notNull().default(0),
    invalid: integer('invalid').notNull().default(0),
    /** OUR fault, not the provider's — and a SUCCEEDED run may carry none. */
    persistenceErrors: integer('persistence_errors').notNull().default(0),
    /** Typed code; the classification never comes from page text (r5). */
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: 'fk_job_collection_runs_source',
      columns: [t.sourceId],
      foreignColumns: [jobSources.id],
      // RESTRICT: "never delete provenance by removing a source" (r5) is this
      // FK. Retiring a source is an administrative state, not a DELETE.
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_collection_runs_cycle',
      columns: [t.cycleId],
      foreignColumns: [jobCollectionCycles.id],
    }).onDelete('restrict'),
    // Stable attempt ids: a retry under the same id is one row, not two.
    unique('uq_job_collection_runs_attempt').on(t.sourceId, t.attemptId),
    /**
     * ONE RUNNING OWNER PER (source, config). The same device
     * `job_opportunity_sources` uses for its active link: a partial unique index
     * over the live state only, so terminal runs accumulate as history without
     * ever contending. Two workers racing a start both INSERT, one gets 23505.
     */
    uniqueIndex('uq_job_collection_runs_running_owner')
      .on(t.sourceId, t.configVersion)
      .where(sql`${t.outcome} = 'STARTED'`),
    index('idx_job_collection_runs_source_started').on(t.sourceId, t.startedAt.desc()),
    // FK child index: the RESTRICT probe on cycle close, and the cycle fan-out.
    index('idx_job_collection_runs_cycle').on(t.cycleId),
    check('ck_job_collection_runs_attempt_id_nonempty', sql`${t.attemptId} ~ '[^[:space:]]'`),
    check('ck_job_collection_runs_config_version_positive', sql`${t.configVersion} > 0`),
    check('ck_job_collection_runs_fencing_epoch_positive', sql`${t.fencingEpoch} > 0`),
    // A terminal run has an end; a running one does not. Both directions.
    check(
      'ck_job_collection_runs_terminal_pair',
      sql`(${t.outcome} = 'STARTED') = (${t.endedAt} IS NULL)`,
    ),
    // A running run is OWNED, under a lease. (A terminal one keeps its owner
    // token as provenance — the constraint is one-directional on purpose.)
    check(
      'ck_job_collection_runs_running_has_lease',
      sql`${t.outcome} <> 'STARTED' OR (${t.ownerToken} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)`,
    ),
    check(
      'ck_job_collection_runs_counts_nonneg',
      sql`${t.received} >= 0 AND ${t.created} >= 0 AND ${t.revised} >= 0 AND ${t.unchanged} >= 0 AND ${t.duplicates} >= 0 AND ${t.invalid} >= 0 AND ${t.persistenceErrors} >= 0`,
    ),
    // At most one disposition per received item, at every moment — including
    // mid-run, when most items are not dispositioned yet.
    check(
      'ck_job_collection_runs_dispositions_bounded',
      sql`${t.created} + ${t.revised} + ${t.unchanged} + ${t.duplicates} + ${t.invalid} + ${t.persistenceErrors} <= ${t.received}`,
    ),
    /**
     * On SUCCEEDED, EXACTLY one disposition per received item and no
     * persistence errors — the same two rules `jobCollectionReportSchema`
     * enforces on the wire, so a row that the database accepted cannot fail to
     * serialize. FAILED / CANCELLED are deliberately exempt: there the received
     * count is itself partial.
     */
    check(
      'ck_job_collection_runs_succeeded_complete',
      sql`${t.outcome} <> 'SUCCEEDED' OR (${t.persistenceErrors} = 0 AND ${t.created} + ${t.revised} + ${t.unchanged} + ${t.duplicates} + ${t.invalid} = ${t.received})`,
    ),
    // Sanitized, not raw: 500 characters is a sentence, not an upstream body.
    // A CHECK cannot recognise a secret; it CAN make pasting a response body in
    // fail loudly instead of quietly persisting one.
    check(
      'ck_job_collection_runs_error_message_bounded',
      sql`${t.errorMessage} IS NULL OR length(${t.errorMessage}) <= 500`,
    ),
  ],
)

export const jobAccountMeterReservations = pgTable(
  'job_account_meter_reservations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    meterId: uuid('meter_id').notNull(),
    /** The attempt this cost was reserved for; stable across retries. */
    attemptId: text('attempt_id').notNull(),
    /** NULL for a reservation that is not a collection attempt (e.g. a model call). */
    runId: uuid('run_id'),
    /** Every reservation carries its cycle (r5): reservations are taken before spawn. */
    cycleId: uuid('cycle_id').notNull(),
    status: jobMeterReservationStatusEnum('status').notNull().default('RESERVED'),
    /** Worst-case cost, reserved and COMMITTED before any I/O. */
    amount: integer('amount').notNull(),
    /** Cost provably converted to used — exactly once (r5). */
    usedAmount: integer('used_amount').notNull().default(0),
    reservedAt: timestamp('reserved_at', { withTimezone: true }).defaultNow().notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (t) => [
    // UNIQUE(account, attempt id): the reservation is idempotent, so a retry
    // after an uncertain commit finds its own row instead of double-charging.
    unique('uq_job_account_meter_reservations_attempt').on(t.meterId, t.attemptId),
    foreignKey({
      name: 'fk_job_account_meter_reservations_meter',
      columns: [t.meterId],
      foreignColumns: [jobAccountMeters.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_account_meter_reservations_run',
      columns: [t.runId],
      foreignColumns: [jobCollectionRuns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_account_meter_reservations_cycle',
      columns: [t.cycleId],
      foreignColumns: [jobCollectionCycles.id],
    }).onDelete('restrict'),
    index('idx_job_account_meter_reservations_meter_status').on(t.meterId, t.status),
    index('idx_job_account_meter_reservations_run').on(t.runId),
    index('idx_job_account_meter_reservations_cycle').on(t.cycleId),
    check(
      'ck_job_account_meter_reservations_attempt_id_nonempty',
      sql`${t.attemptId} ~ '[^[:space:]]'`,
    ),
    // A zero-cost reservation reserves nothing and would make the guard a no-op.
    check('ck_job_account_meter_reservations_amount_positive', sql`${t.amount} > 0`),
    check(
      'ck_job_account_meter_reservations_used_within_amount',
      sql`${t.usedAmount} >= 0 AND ${t.usedAmount} <= ${t.amount}`,
    ),
    // "Release ONLY provably unsent cost" (r5): a released reservation has
    // spent nothing. Releasing cost that was already used is the bug this
    // CHECK exists to make impossible.
    check(
      'ck_job_account_meter_reservations_released_unused',
      sql`${t.status} <> 'RELEASED' OR ${t.usedAmount} = 0`,
    ),
    // Anything beyond RESERVED / RELEASED means the request provably left.
    check(
      'ck_job_account_meter_reservations_sent_pair',
      sql`${t.status} IN ('RESERVED', 'RELEASED') OR ${t.sentAt} IS NOT NULL`,
    ),
    // Exactly-once conversion: a USED reservation has settled, with cost.
    check(
      'ck_job_account_meter_reservations_used_settled',
      sql`${t.status} <> 'USED' OR (${t.settledAt} IS NOT NULL AND ${t.usedAmount} > 0)`,
    ),
  ],
)

export const jobDirtyWork = pgTable(
  'job_dirty_work',
  {
    /**
     * A client-side UUID default, deliberately NOT an identity column: this row
     * is written INSIDE the producer's transaction (r5), so it must not depend
     * on a sequence or any other side channel. `gen_random_uuid()` needs
     * nothing outside the transaction and leaves no gaps to reason about.
     */
    id: uuid('id').defaultRandom().primaryKey(),
    /** The entity is (kind, id) — the discriminator of the polymorphic target. */
    entityKind: jobDirtyWorkEntityKindEnum('entity_kind').notNull(),
    entityId: uuid('entity_id').notNull(),
    /**
     * The version the worker must reach. WORKER OBLIGATION: compare versions
     * before installing output, so a slow worker never overwrites a newer
     * result with an older computation.
     */
    targetVersion: bigint('target_version', { mode: 'number' }).notNull(),
    /** Which producer enqueued it. Part of the idempotency key below. */
    reason: text('reason').notNull(),
    status: jobDirtyWorkStatusEnum('status').notNull().default('PENDING'),
    claimOwner: text('claim_owner'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    fencingEpoch: bigint('fencing_epoch', { mode: 'number' }).notNull().default(1),
    retryCount: integer('retry_count').notNull().default(0),
    checkpoint: jsonb('checkpoint')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** The occurrence that produced it, when there was one. */
    cycleId: uuid('cycle_id'),
    lastErrorCode: text('last_error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * UNIQUE(entity, target version, reason). This is what lets a producer
     * enqueue unconditionally inside its own transaction: a second producer
     * reaching the same conclusion gets 23505 and does nothing, instead of the
     * two of them queueing the same recompute twice.
     */
    unique('uq_job_dirty_work_entity_target').on(
      t.entityKind,
      t.entityId,
      t.targetVersion,
      t.reason,
    ),
    // NO foreign key on `entity_id` ON PURPOSE: the target is polymorphic
    // (a source record, an opportunity, a senior, an exclusion, a project
    // client) and Postgres has no polymorphic FK. The index below is what keeps
    // the lookup cheap; referential sanity is the producer's obligation.
    index('idx_job_dirty_work_entity').on(t.entityKind, t.entityId),
    // The claim scan: oldest pending first.
    index('idx_job_dirty_work_pending').on(t.status, t.createdAt),
    index('idx_job_dirty_work_cycle').on(t.cycleId),
    foreignKey({
      name: 'fk_job_dirty_work_cycle',
      columns: [t.cycleId],
      foreignColumns: [jobCollectionCycles.id],
    }).onDelete('restrict'),
    check('ck_job_dirty_work_target_version_positive', sql`${t.targetVersion} > 0`),
    check('ck_job_dirty_work_reason_nonempty', sql`${t.reason} ~ '[^[:space:]]'`),
    check('ck_job_dirty_work_reason_bounded', sql`length(${t.reason}) <= 100`),
    check('ck_job_dirty_work_retry_count_nonneg', sql`${t.retryCount} >= 0`),
    check('ck_job_dirty_work_fencing_epoch_positive', sql`${t.fencingEpoch} > 0`),
    // A CLAIMED item is owned under a lease, and ONLY a claimed item is: an
    // owner left behind on a released item is how a stale lease comes back.
    check(
      'ck_job_dirty_work_claim_pair',
      sql`(${t.status} = 'CLAIMED') = (${t.claimOwner} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)`,
    ),
    // DEFERRED counts as terminal here: a cycle closes when all its children
    // are terminal OR deferred (r5), so both must record when they finished.
    check(
      'ck_job_dirty_work_terminal_pair',
      sql`(${t.status} IN ('DONE', 'FAILED', 'DEFERRED')) = (${t.completedAt} IS NOT NULL)`,
    ),
  ],
)

export type JobCollectionCycle = typeof jobCollectionCycles.$inferSelect
export type NewJobCollectionCycle = typeof jobCollectionCycles.$inferInsert
export type JobCollectionRun = typeof jobCollectionRuns.$inferSelect
export type NewJobCollectionRun = typeof jobCollectionRuns.$inferInsert
export type JobAccountMeterReservation = typeof jobAccountMeterReservations.$inferSelect
export type NewJobAccountMeterReservation = typeof jobAccountMeterReservations.$inferInsert
export type JobDirtyWorkRow = typeof jobDirtyWork.$inferSelect
export type NewJobDirtyWorkRow = typeof jobDirtyWork.$inferInsert
