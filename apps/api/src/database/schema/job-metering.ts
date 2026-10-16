/**
 * Job-sourcing account metering (r5 Phase 1).
 *
 *   job_account_meters   one counter per (account, unit, window)
 *
 * In its OWN module on purpose: `job_sources` references a meter, and
 * `job_collection.ts` references `job_sources`. Declaring the meter here keeps
 * the import graph acyclic (metering <- job-sourcing <- job-collection); a
 * cycle between two modules that call `pgTable` at module scope resolves to
 * `undefined` tables depending on which side drizzle-kit loads first.
 *
 * Reservations against these meters live in `job-collection.ts`, because they
 * also reference runs and cycles.
 *
 * WHY A SEPARATE COUNTER FROM `job_sources.budget_*`: the legacy budget counts
 * one unit per collection, which is right for DOU and wrong for everything
 * else (TheirStack bills per returned record, JSearch per request, the HTML
 * extractor per model call, OpenRouter in money). The legacy columns stay for
 * DOU (r5 A1h) and the two never share a counter.
 */
import { sql } from 'drizzle-orm'
import { check, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { jobMeterUnitEnum, jobMeterWindowEnum } from './enums'

/**
 * An account identity that carries NO secrets. The CHECK is the mechanical part
 * of that promise: a short lowercase id (≤ 100 chars) over a deliberately
 * narrow alphabet that excludes the base64 characters `+ / =` and every
 * uppercase letter, so an API key, a bearer token or a URL with credentials
 * cannot be stored here even by accident. Mirrors `jobAccountKeySchema`.
 */
const ACCOUNT_KEY_PATTERN = '^[a-z0-9][a-z0-9._:-]{0,99}$'

export const jobAccountMeters = pgTable(
  'job_account_meters',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** e.g. `jsearch:rapidapi-main`, `openrouter:studio`. Never a credential. */
    accountKey: text('account_key').notNull(),
    unit: jobMeterUnitEnum('unit').notNull(),
    /**
     * Named `window_kind`, not `window`: `WINDOW` is a reserved word (SQL
     * window functions), so a column called that has to be double-quoted in
     * every hand-written statement — and the one that is forgotten is a syntax
     * error in the forward SQL of Task 1.3, not here. Same reasoning as
     * `limit_amount` below. Caught by the integration spec before it could get
     * that far.
     */
    window: jobMeterWindowEnum('window_kind').notNull(),
    /**
     * NULL = no published limit, and it is the ONLY value that means that — the
     * same single meaning `job_sources.budget_limit` carries, so a nonsense
     * number never reads as unlimited.
     *
     * Named `limit_amount`, not `limit`: `LIMIT` is a reserved word, and a
     * column that must be quoted in every hand-written statement is a
     * permanent source of forward-SQL / Drizzle drift.
     */
    limitAmount: integer('limit_amount'),
    /** Cost provably spent. */
    used: integer('used').notNull().default(0),
    /** Cost held for attempts that have not settled yet. */
    reserved: integer('reserved').notNull().default(0),
    /** Cost that may or may not have been billed (a timeout), held until reconciliation. */
    uncertain: integer('uncertain').notNull().default(0),
    windowStartedAt: timestamp('window_started_at', { withTimezone: true }),
    resetsAt: timestamp('resets_at', { withTimezone: true }),
    /** Limits are frozen by policy; a policy change is a new version, not an edit in place. */
    policyVersion: integer('policy_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One meter per (account, unit, window). Because `window` is part of the
    // key, a LIFETIME meter is a DIFFERENT row from the DAY and MONTH meters of
    // the same account — the "lifetime distinct from DAY/MONTH" invariant is
    // structural, not a convention.
    unique('uq_job_account_meters_identity').on(t.accountKey, t.unit, t.window),
    /**
     * THE ATOMIC SPEND GUARD. Two workers that both read "room for one more"
     * and both write serialize on this row's lock, and the second one's UPDATE
     * is refused by Postgres — no advisory lock, no application arithmetic, no
     * in-process `Map` (r5: per-host/account state shared through PostgreSQL).
     * Proven by a real two-writer race in job-collection.integration.spec.ts.
     */
    check(
      'ck_job_account_meters_spend_within_limit',
      sql`${t.limitAmount} IS NULL OR ${t.used} + ${t.reserved} + ${t.uncertain} <= ${t.limitAmount}`,
    ),
    check(
      'ck_job_account_meters_counters_nonneg',
      sql`${t.used} >= 0 AND ${t.reserved} >= 0 AND ${t.uncertain} >= 0`,
    ),
    check(
      'ck_job_account_meters_limit_nonneg',
      sql`${t.limitAmount} IS NULL OR ${t.limitAmount} >= 0`,
    ),
    check(
      'ck_job_account_meters_account_key_format',
      sql`${t.accountKey} ~ ${sql.raw(`'${ACCOUNT_KEY_PATTERN}'`)}`,
    ),
    // A LIFETIME meter has nothing to reset and no window to start.
    check(
      'ck_job_account_meters_lifetime_never_resets',
      sql`${t.window} <> 'LIFETIME' OR (${t.resetsAt} IS NULL AND ${t.windowStartedAt} IS NULL)`,
    ),
    // ... and conversely a rolling window is meaningless without its start.
    check(
      'ck_job_account_meters_windowed_has_start',
      sql`${t.window} = 'LIFETIME' OR ${t.windowStartedAt} IS NOT NULL`,
    ),
    check('ck_job_account_meters_policy_version_positive', sql`${t.policyVersion} > 0`),
  ],
)

export type JobAccountMeter = typeof jobAccountMeters.$inferSelect
export type NewJobAccountMeter = typeof jobAccountMeters.$inferInsert
