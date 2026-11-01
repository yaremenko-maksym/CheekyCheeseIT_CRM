/**
 * Missing-inventory counter (r5 Task 4.6, slice S8a; ADR
 * `docs/architecture/2026-11-01-availability-reconciliation.md` Decisions 3 and 5).
 *
 *   job_source_record_inventory_misses   the owner-frozen D4 counter: consecutive VALID
 *                                        FULL_INVENTORY runs that did not list a record, per
 *                                        (record, board, config version).
 *
 * The forward DDL is STAGED: `drizzle/manual-staged/2026-11-01_job_source_record_inventory_misses.sql`
 * (listed in STAGED_RELATIONS); `job-source-record-inventory-misses-forward-ddl.integration.spec.ts`
 * compares it with `db:push`. Nothing reads or writes the table yet (the reconciliation worker is
 * S8d). The run ids are evidence pointers, deliberately not foreign keys.
 */
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { jobSourceRecords } from './job-opportunities'

export const jobSourceRecordInventoryMisses = pgTable(
  'job_source_record_inventory_misses',
  {
    sourceRecordId: uuid('source_record_id').notNull(),
    /** The FULL_INVENTORY-capable source scope. */
    board: text('board').notNull(),
    /** A bump opens a new row: runs under another config are not comparable. */
    configVersion: integer('config_version').notNull(),
    consecutiveMisses: integer('consecutive_misses').notNull().default(0),
    /** The run that opened the current chain. */
    firstMissRunId: uuid('first_miss_run_id').notNull(),
    /** For the >= 24h span test. */
    firstMissAt: timestamp('first_miss_at', { withTimezone: true }).notNull(),
    lastMissRunId: uuid('last_miss_run_id').notNull(),
    lastMissAt: timestamp('last_miss_at', { withTimezone: true }).notNull(),
    /** For the > 50 % inventory-drop guard. */
    lastInventorySize: integer('last_inventory_size').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({
      name: 'job_source_record_inventory_misses_pkey',
      columns: [t.sourceRecordId, t.board, t.configVersion],
    }),
    foreignKey({
      name: 'fk_job_source_record_inventory_misses_record',
      columns: [t.sourceRecordId],
      foreignColumns: [jobSourceRecords.id],
    }).onDelete('cascade'),
    check('ck_job_inventory_misses_count', sql`${t.consecutiveMisses} >= 0`),
    check('ck_job_inventory_misses_config_version', sql`${t.configVersion} > 0`),
    check('ck_job_inventory_misses_inventory_size', sql`${t.lastInventorySize} >= 0`),
    check(
      'ck_job_inventory_misses_board',
      sql`length(btrim(${t.board})) > 0 AND length(${t.board}) <= 200`,
    ),
    check('ck_job_inventory_misses_span', sql`${t.lastMissAt} >= ${t.firstMissAt}`),
  ],
)
