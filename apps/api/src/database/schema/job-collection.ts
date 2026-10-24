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
 * bounded by CHECK on BOTH halves: `error_code` / `last_error_code` must match
 * the typed upper-snake alphabet of `JOB_ERROR_CODE_PATTERN` (<= 64 chars), and
 * `error_message` is capped at `JOB_SANITIZED_TEXT_MAX` characters. A CHECK
 * cannot recognise a secret; what it does is make a raw upstream body — the
 * thing that carries one — fail loudly instead of persisting quietly.
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
import {
  JOB_ERROR_CODE_PATTERN,
  JOB_HANDLE_MAX,
  JOB_JSONB_TEXT_MAX,
  JOB_SANITIZED_TEXT_MAX,
  JOB_SHORT_TEXT_MAX,
} from './job-patterns'
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
    /**
     * The meter the shared HTML call budget is drawn from, when one applies.
     *
     * SPEC-L-1, recorded rather than enforced: NULLABLE because a cycle whose
     * sources need no HTML extraction draws on no HTML meter at all, and the
     * database cannot know, at INSERT time, whether this occurrence will spawn
     * an HTML run — the runs do not exist yet. So "an occurrence that spawns an
     * HTML run names the meter that run draws on" is PHASE-2 WORKER OBLIGATION
     * 11 in the PR body, not a constraint. Making the column NOT NULL would
     * instead force every non-HTML cycle to invent a meter reference, which is
     * worse than the gap it closes.
     */
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
    /**
     * CR-L-2 / SPEC-L-1. The composite target for `job_collection_runs`'s
     * trigger FK below. `id` is already the primary key, so this UNIQUE adds no
     * new identity — it exists only so a child row can reference the PAIR and
     * Postgres can refuse a disagreement. A CHECK cannot read another row.
     */
    unique('uq_job_collection_cycles_id_trigger').on(t.id, t.trigger),
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
    // SR-M-3: the limit `jobCollectionCycleSchema.triggerKey` already carried.
    check(
      'ck_job_collection_cycles_trigger_key_bounded',
      sql`length(${t.triggerKey}) <= ${sql.raw(String(JOB_HANDLE_MAX))}`,
    ),
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
     * taken under. `uq_job_collection_runs_running_owner` is scoped by this
     * column, but since Task 2.5 T1 `uq_job_collection_runs_one_started_per_source`
     * is not: a run under a new config DOES contend with a still-running one,
     * which has to end (or be recovered) first.
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
     * The paid account this run spends against (Task 2.5 T1): the source's
     * `account_meter_id`, or the source's own id when it has no meter. It is
     * what `uq_job_collection_runs_one_started_per_account` keys on, so two
     * sources that share one account cannot fetch at the same time.
     *
     * NO DEFAULT, on purpose: a key the database invented would be shared by no
     * other run, and the per-account slot would then lock nothing.
     *
     * WORKER OBLIGATION the database cannot see (a CHECK reads only its own
     * row; there is no FK, since the key names either a meter or a source):
     * the writer derives the key from `job_sources` at claim time, under the
     * claim's row locks. A writer that passed the source id for a metered
     * source would get a per-source lock only. The run ledger (Task 2.5 T3) is
     * the only intended writer.
     */
    accountKey: uuid('account_key').notNull(),
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
    /**
     * Typed code: the UPPER_SNAKE shape is CHECK-enforced. That the
     * classification comes from a documented status code rather than page text
     * is a worker obligation (7), not something a CHECK can see.
     */
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
    /**
     * CR-L-2 / SPEC-L-1. A run's trigger must BE its cycle's trigger: a
     * SCHEDULED occurrence cannot contain a run that reports itself MANUAL, and
     * the provenance a reader draws from either column would otherwise depend
     * on which one they read. Enforced as a composite FK because a CHECK sees
     * only its own row.
     */
    foreignKey({
      name: 'fk_job_collection_runs_cycle_trigger',
      columns: [t.cycleId, t.trigger],
      foreignColumns: [jobCollectionCycles.id, jobCollectionCycles.trigger],
    }).onDelete('restrict'),
    // Stable attempt ids: a retry under the same id is one row, not two.
    unique('uq_job_collection_runs_attempt').on(t.sourceId, t.attemptId),
    /**
     * CR-L-2 / SPEC-L-1. The composite target for the reservation's cycle FK:
     * same device as `uq_job_collection_cycles_id_trigger` — no new identity,
     * just a referencable pair.
     */
    unique('uq_job_collection_runs_id_cycle').on(t.id, t.cycleId),
    /**
     * ONE RUNNING OWNER PER (source, config). The same device
     * `job_opportunity_sources` uses for its active link: a partial unique index
     * over the live state only, so terminal runs accumulate as history without
     * ever contending. Two workers racing a start both INSERT, one gets 23505.
     */
    uniqueIndex('uq_job_collection_runs_running_owner')
      .on(t.sourceId, t.configVersion)
      .where(sql`${t.outcome} = 'STARTED'`),
    /**
     * Task 2.5 T1 — ONE ACTIVE FETCH PER SOURCE, whatever its config version.
     * The index above is per (source, config), so a config bump would let a
     * second STARTED run coexist with the first; this one closes that. The
     * index above stays: it is subsumed, not contradicted, and dropping it is
     * not this task's call. The run ledger checks the same rule under row
     * locks; this is the backstop that holds when a writer does not.
     */
    uniqueIndex('uq_job_collection_runs_one_started_per_source')
      .on(t.sourceId)
      .where(sql`${t.outcome} = 'STARTED'`),
    /** Task 2.5 T1 — ONE ACTIVE FETCH PER ACCOUNT (see `accountKey`). */
    uniqueIndex('uq_job_collection_runs_one_started_per_account')
      .on(t.accountKey)
      .where(sql`${t.outcome} = 'STARTED'`),
    index('idx_job_collection_runs_source_started').on(t.sourceId, t.startedAt.desc()),
    // FK child index: the RESTRICT probe on cycle close, and the cycle fan-out.
    index('idx_job_collection_runs_cycle').on(t.cycleId),
    check('ck_job_collection_runs_attempt_id_nonempty', sql`${t.attemptId} ~ '[^[:space:]]'`),
    // SR-M-3: the limits the shared schemas already carried, which the columns
    // did not. A text column with no bound is where an adapter puts a payload.
    check(
      'ck_job_collection_runs_attempt_id_bounded',
      sql`length(${t.attemptId}) <= ${sql.raw(String(JOB_HANDLE_MAX))}`,
    ),
    check(
      'ck_job_collection_runs_owner_token_bounded',
      sql`${t.ownerToken} IS NULL OR length(${t.ownerToken}) <= ${sql.raw(String(JOB_HANDLE_MAX))}`,
    ),
    check(
      'ck_job_collection_runs_adapter_version_bounded',
      sql`length(${t.adapterVersion}) <= ${sql.raw(String(JOB_SHORT_TEXT_MAX))}`,
    ),
    /**
     * SR-M-3. JSONB with neither a type nor a length bound: a checkpoint is a
     * page cursor plus remaining ids (bounded resume), and the snapshot is one
     * source's config. An array or a scalar here is a different shape than
     * every reader expects, and `source_config_snapshot` copies `config`
     * verbatim into history that is never deleted — so the length is bounded
     * at the write, where it can still fail loudly. CR-L-4: the bound counts
     * CHARACTERS of jsonb's rendered text (`length(x::text)`), not bytes — see
     * `JOB_JSONB_TEXT_MAX`.
     */
    check(
      'ck_job_collection_runs_checkpoint_bounded',
      sql`jsonb_typeof(${t.checkpoint}) = 'object' AND length(${t.checkpoint}::text) <= ${sql.raw(String(JOB_JSONB_TEXT_MAX))}`,
    ),
    check(
      'ck_job_collection_runs_config_snapshot_bounded',
      sql`jsonb_typeof(${t.sourceConfigSnapshot}) = 'object' AND length(${t.sourceConfigSnapshot}::text) <= ${sql.raw(String(JOB_JSONB_TEXT_MAX))}`,
    ),
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
      sql`${t.errorMessage} IS NULL OR length(${t.errorMessage}) <= ${sql.raw(String(JOB_SANITIZED_TEXT_MAX))}`,
    ),
    // SR-M-2 / SPEC-M-1: the CODE was unbounded `text` while the module header
    // claimed a typed code. Now the claim is enforced, not asserted.
    check(
      'ck_job_collection_runs_error_code_format',
      sql`${t.errorCode} IS NULL OR ${t.errorCode} ~ ${sql.raw(`'${JOB_ERROR_CODE_PATTERN}'`)}`,
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
    /** Worst-case cost, reserved and COMMITTED before any I/O. CR-M-2: `bigint`, like the meter it draws on. */
    amount: bigint('amount', { mode: 'number' }).notNull(),
    /** Cost provably converted to used — exactly once (r5). */
    usedAmount: bigint('used_amount', { mode: 'number' }).notNull().default(0),
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
    /**
     * CR-L-2 / SPEC-L-1. A reservation taken FOR a run belongs to that run's
     * occurrence. MATCH SIMPLE is what makes this exactly right rather than too
     * strict: with `run_id` NULL (a model call, which is not a collection
     * attempt) the pair is not checked at all, so such a reservation still names
     * its own cycle freely.
     */
    foreignKey({
      name: 'fk_job_account_meter_reservations_run_cycle',
      columns: [t.runId, t.cycleId],
      foreignColumns: [jobCollectionRuns.id, jobCollectionRuns.cycleId],
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
    // SR-M-3: the limit `jobMeterReservationSchema.attemptId` already carried.
    check(
      'ck_job_account_meter_reservations_attempt_id_bounded',
      sql`length(${t.attemptId}) <= ${sql.raw(String(JOB_HANDLE_MAX))}`,
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
    /**
     * CR-L-1. ... and the converse, which the pair above did not say: a
     * RELEASED reservation has no send instant. "Release ONLY provably unsent
     * cost" (r5) — a row claiming both that the request left and that nothing
     * was spent is the state the release path must never produce.
     */
    check(
      'ck_job_account_meter_reservations_released_unsent',
      sql`${t.status} <> 'RELEASED' OR ${t.sentAt} IS NULL`,
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
    check(
      'ck_job_dirty_work_reason_bounded',
      sql`length(${t.reason}) <= ${sql.raw(String(JOB_SHORT_TEXT_MAX))}`,
    ),
    // SR-M-3: the limits the shared schema already carried.
    check(
      'ck_job_dirty_work_claim_owner_bounded',
      sql`${t.claimOwner} IS NULL OR length(${t.claimOwner}) <= ${sql.raw(String(JOB_HANDLE_MAX))}`,
    ),
    check(
      'ck_job_dirty_work_checkpoint_bounded',
      sql`jsonb_typeof(${t.checkpoint}) = 'object' AND length(${t.checkpoint}::text) <= ${sql.raw(String(JOB_JSONB_TEXT_MAX))}`,
    ),
    check('ck_job_dirty_work_retry_count_nonneg', sql`${t.retryCount} >= 0`),
    check('ck_job_dirty_work_fencing_epoch_positive', sql`${t.fencingEpoch} > 0`),
    /**
     * A CLAIMED item is owned under a lease, and ONLY a claimed item is: an
     * owner left behind on a released item is how a stale lease comes back.
     *
     * CR-M-1 — NOT written as one equality of two booleans. That form
     * (`(status = 'CLAIMED') = (owner IS NOT NULL AND lease IS NOT NULL)`) is
     * satisfied when BOTH sides are false, so a row with `status <> 'CLAIMED'`,
     * an owner and a NULL lease passed — exactly the state this comment calls
     * impossible. Each branch names the columns it requires, and the
     * non-claimed branch names them CLEARED.
     */
    check(
      'ck_job_dirty_work_claim_pair',
      sql`(${t.status} = 'CLAIMED' AND ${t.claimOwner} IS NOT NULL AND ${t.leaseExpiresAt} IS NOT NULL)
          OR (${t.status} <> 'CLAIMED' AND ${t.claimOwner} IS NULL AND ${t.leaseExpiresAt} IS NULL)`,
    ),
    // SR-M-2 / SPEC-M-1: a typed code here too.
    check(
      'ck_job_dirty_work_last_error_code_format',
      sql`${t.lastErrorCode} IS NULL OR ${t.lastErrorCode} ~ ${sql.raw(`'${JOB_ERROR_CODE_PATTERN}'`)}`,
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
