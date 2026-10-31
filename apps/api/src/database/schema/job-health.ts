/**
 * Source-fetch-strategy U4 — the append-only health event log `job_source_health_events`.
 *
 * Design: docs/architecture/2026-10-25-source-fetch-strategy.md section 10. A source's CURRENT
 * health state is NOT stored: it is the `to_state` of its latest `TRANSITION` event. The detector
 * pass writes a row only when a source's `(state, reason)` changes, so the log grows with change,
 * not with time.
 *
 * APPEND-ONLY. `crm_app` holds `SELECT, INSERT` only (privilege class B), and
 * `drizzle/manual-staged/2026-10-31_job_source_health_events.sql` adds `ENABLE ALWAYS` triggers
 * that refuse every `UPDATE`, `DELETE` and `TRUNCATE` (the `job_queue_actions` pattern) — with no
 * retention exception, because the events are evidence and are never pruned (ADR "Rollback").
 *
 * The states and reasons are the value lists of section 10, pinned here as CHECK constraints
 * rather than pg enums (a text + CHECK column needs no `CREATE TYPE`, so the staged forward DDL is
 * re-runnable with a plain `CREATE TABLE IF NOT EXISTS`). The TypeScript side of the same lists is
 * `job-sourcing/health/types.ts`; the two must agree, and `job-source-health-schema.spec.ts` holds
 * them to each other.
 */
import { sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'
import { JOB_JSONB_TEXT_MAX, JOB_SANITIZED_TEXT_MAX, JOB_SHORT_TEXT_MAX } from './job-patterns'
import { jobCollectionRuns } from './job-collection'
import { jobSources } from './job-sourcing'
import { users } from './users'

/** The eight health states (section 10), as the CHECK's value list. */
export const HEALTH_STATE_VALUES = [
  'BLOCKED',
  'CAPPED',
  'PAUSED',
  'FAILING',
  'EMPTY',
  'DEGRADED',
  'SILENT',
  'HEALTHY',
] as const

/** The eleven detector reasons (section 10). */
export const HEALTH_REASON_VALUES = [
  'VOLUME_DROP',
  'NO_NEW_ITEMS',
  'EMPTY_RESPONSE',
  'SCHEMA_DRIFT',
  'ACCESS_CHANGED',
  'THROTTLED',
  'SLOW',
  'PAYLOAD_GROWTH',
  'STALE_FEED',
  'BOARD_GONE',
  'DEADLINE_NEAR',
] as const

/** An upper-snake IN-list literal, e.g. `'A', 'B'`, for a CHECK body. */
const inList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ')

/** A note is bounded like a sanitized string: a sentence, not a document. */
const NOTE_MAX = JOB_SANITIZED_TEXT_MAX

export const jobSourceHealthEvents = pgTable(
  'job_source_health_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceId: uuid('source_id').notNull(),
    /** The database clock (ADR section 10): the pass never supplies it. */
    at: timestamp('at', { withTimezone: true }).defaultNow().notNull(),
    /** `TRANSITION` (a state/reason change) or `NOTE` (an ADMIN note). */
    kind: text('kind').notNull(),
    /** TRANSITION only; NULL on the first transition of a source. */
    fromState: text('from_state'),
    /** TRANSITION only. */
    toState: text('to_state'),
    /** TRANSITION only; NULL when the transition carries no reason (e.g. into HEALTHY). */
    reasonCode: text('reason_code'),
    /** Bounded JSON: the metric values against the baseline, the run ids. */
    evidence: jsonb('evidence')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** The runs that bracket the change (provenance). */
    firstBadRunId: uuid('first_bad_run_id'),
    lastGoodRunId: uuid('last_good_run_id'),
    /** The adapter / config version at the moment of the change. */
    adapterVersion: text('adapter_version'),
    configVersion: integer('config_version'),
    /** The last answered HTTP status, and a bounded sample of the error (500 chars, no PII). */
    httpStatus: smallint('http_status'),
    errorSample: text('error_sample'),
    /** NOTE only: the ADMIN who wrote it, and the note text. */
    actorId: uuid('actor_id'),
    note: text('note'),
  },
  (t) => [
    foreignKey({
      name: 'fk_job_source_health_events_source',
      columns: [t.sourceId],
      foreignColumns: [jobSources.id],
      // RESTRICT: health history is provenance, never deleted by removing a source.
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_source_health_events_first_bad_run',
      columns: [t.firstBadRunId],
      foreignColumns: [jobCollectionRuns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_source_health_events_last_good_run',
      columns: [t.lastGoodRunId],
      foreignColumns: [jobCollectionRuns.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_source_health_events_actor',
      columns: [t.actorId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    // The latest-event lookup: newest first per source (the current state is derived from it).
    index('idx_job_source_health_events_source_at').on(t.sourceId, t.at.desc()),
    check('ck_job_source_health_events_kind', sql`${t.kind} IN ('TRANSITION', 'NOTE')`),
    // from_state / to_state / reason_code are drawn from the fixed vocabularies, or NULL.
    check(
      'ck_job_source_health_events_states',
      sql`(${t.fromState} IS NULL OR ${t.fromState} IN (${sql.raw(inList(HEALTH_STATE_VALUES))}))
        AND (${t.toState} IS NULL OR ${t.toState} IN (${sql.raw(inList(HEALTH_STATE_VALUES))}))
        AND (${t.reasonCode} IS NULL OR ${t.reasonCode} IN (${sql.raw(inList(HEALTH_REASON_VALUES))}))`,
    ),
    // The shape of each kind: a TRANSITION names a to_state and carries no note; a NOTE names an
    // actor and note and carries no transition fields.
    check(
      'ck_job_source_health_events_kind_shape',
      sql`(${t.kind} = 'TRANSITION' AND ${t.toState} IS NOT NULL
             AND ${t.actorId} IS NULL AND ${t.note} IS NULL)
        OR (${t.kind} = 'NOTE' AND ${t.actorId} IS NOT NULL AND ${t.note} IS NOT NULL
             AND ${t.fromState} IS NULL AND ${t.toState} IS NULL AND ${t.reasonCode} IS NULL)`,
    ),
    // Bounded JSON, at the write, where it can still fail loudly (8192 characters of rendered text).
    check(
      'ck_job_source_health_events_evidence_bounded',
      sql`jsonb_typeof(${t.evidence}) = 'object' AND length(${t.evidence}::text) <= ${sql.raw(String(JOB_JSONB_TEXT_MAX))}`,
    ),
    // A sentence, not an upstream body: 500 characters, no PII (a worker obligation the CHECK
    // cannot see — what it can do is make pasting a response body in fail loudly).
    check(
      'ck_job_source_health_events_error_sample_bounded',
      sql`${t.errorSample} IS NULL OR length(${t.errorSample}) <= ${sql.raw(String(JOB_SANITIZED_TEXT_MAX))}`,
    ),
    check(
      'ck_job_source_health_events_http_status_range',
      sql`${t.httpStatus} IS NULL OR ${t.httpStatus} BETWEEN 100 AND 599`,
    ),
    check(
      'ck_job_source_health_events_adapter_version_bounded',
      sql`${t.adapterVersion} IS NULL OR length(${t.adapterVersion}) <= ${sql.raw(String(JOB_SHORT_TEXT_MAX))}`,
    ),
    check(
      'ck_job_source_health_events_config_version_positive',
      sql`${t.configVersion} IS NULL OR ${t.configVersion} > 0`,
    ),
    check(
      'ck_job_source_health_events_note_bounded',
      sql`${t.note} IS NULL OR length(${t.note}) <= ${sql.raw(String(NOTE_MAX))}`,
    ),
  ],
)

export type JobSourceHealthEvent = typeof jobSourceHealthEvents.$inferSelect
export type NewJobSourceHealthEvent = typeof jobSourceHealthEvents.$inferInsert
