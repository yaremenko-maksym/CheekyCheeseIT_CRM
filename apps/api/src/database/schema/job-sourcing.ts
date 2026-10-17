/**
 * Job-sourcing: sources, postings, signals, suggestions and exclusion filters.
 */
import { isNull, relations, sql } from 'drizzle-orm'
import {
  boolean,
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
  jobExclusionKindEnum,
  jobQueueStatusEnum,
  jobSeniorityEnum,
  jobSignalKindEnum,
  jobSourceAdminStateEnum,
  jobSourceBudgetWindowEnum,
  jobSourceReadinessEnum,
  jobSourceTriggerModeEnum,
  jobSourceTypeEnum,
  jobSuggestionStatusEnum,
} from './enums'
import { jobAccountMeters } from './job-metering'
import {
  JOB_ERROR_CODE_PATTERN,
  JOB_HANDLE_MAX,
  JOB_PUBLIC_ID_PATTERN,
  JOB_SANITIZED_TEXT_MAX,
  JOB_UNBROKEN_RUN_PATTERN,
} from './job-patterns'
import { users } from './users'

// ---------------------------------------------------------------------------
// Job sourcing (task-job-sourcing-slice1) — EXTERNAL vacancies a senior can
// apply to. The mirror image of the `vacancies` block above: those are OUR
// openings shown on the landing; these are OTHER companies' openings pulled in
// from a third-party feed and offered to our seniors.
// ---------------------------------------------------------------------------
//
// Everything in `job_postings` is UNTRUSTED third-party content — see the
// header of packages/shared/src/schemas/job-sourcing.ts for the full contract
// (https-only URLs, markdown-without-raw-HTML descriptions).

/**
 * A configured feed. `config` holds ONLY source-specific knobs (for DOU: the
 * category, validated against an allow-list) — deliberately NOT a URL: letting
 * an admin store an arbitrary URL here would turn the collector into an SSRF
 * primitive. The endpoint is a constant in the provider implementation.
 */
export const jobSources = pgTable(
  'job_sources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    type: jobSourceTypeEnum('type').notNull(),
    config: jsonb('config').notNull().default({}),
    enabled: boolean('enabled').notNull().default(true),
    lastCollectedAt: timestamp('last_collected_at', { withTimezone: true }),

    // --- request budget (task-vacancy-matching §4) ---------------------------
    //
    // A PROPERTY OF THE SOURCE, not of the caller: whoever asks for a
    // collection — the cron or an admin pressing the button — spends from the
    // same counter, so twenty clicks in a row cannot burn a month of JSearch's
    // 200 requests. Arithmetic (rollover, remaining, reset instant) lives in
    // `@crm/shared`'s source-budget.ts so the API and the UI cannot disagree.
    //
    // NULL `budget_limit` means "no published limit" (DOU's feed) — and it is
    // the ONLY value that means that. A nonsense number does NOT: see the
    // hostile-input rule in source-budget.ts.
    // Stryker disable next-line StringLiteral: a COLUMN NAME — it exists in the database, so no unit test can observe it; the prod DDL declares the same identifier in 2026-08-12_job_source_budgets.sql and the integration suite reads through it
    budgetLimit: integer('budget_limit'),
    // Stryker disable next-line StringLiteral: same — a column name, verified against a real database by the integration suite and by the DDL script, never by a unit test
    budgetWindow: jobSourceBudgetWindowEnum('budget_window'),
    // Stryker disable next-line StringLiteral: a COLUMN NAME — it exists in the database, so no unit test can observe it; the prod DDL declares the same identifier in 2026-08-12_job_source_budgets.sql and the integration suite reads through it
    budgetUsed: integer('budget_used').notNull().default(0),
    /** Start of the window `budget_used` is counted in (UTC, calendar-anchored). */
    // Stryker disable next-line BooleanLiteral,StringLiteral,ObjectLiteral: the column name and its options — withTimezone decides timestamptz vs timestamp — a COLUMN TYPE in Postgres, declared by 2026-08-12_job_source_budgets.sql and exercised by the integration suite. It appeared killed locally only because this machine runs at UTC+03 while CI runs at UTC, so a unit test comparing an ISO string happened to notice; that is a property of the runner's timezone, not an assertion about the schema
    budgetWindowStartedAt: timestamp('budget_window_started_at', { withTimezone: true }),

    // --- how this source may be collected (task-vacancy-matching §5) ---------
    //
    // Cheap sources run on the schedule; expensive ones wait for a human. The
    // driver is arithmetic: JSearch's 200/month is ~6/day, useless on a cron but
    // ample when aimed at one senior by hand.
    // Stryker disable next-line StringLiteral: the column DEFAULT is applied by Postgres on INSERT, so no unit test can see it; the default is pinned in the DDL script and exercised by job-matching.integration.spec.ts, which inserts a source without a trigger mode and expects the scheduled cron to pick it up
    triggerMode: jobSourceTriggerModeEnum('trigger_mode').notNull().default('SCHEDULED'),
    /** Minimum hours between scheduled collections; NULL = every cron tick. */
    minIntervalHours: integer('min_interval_hours'),
    /** Why the source was switched off (auto-disable on 403, or by an admin). */
    disabledReason: text('disabled_reason'),

    // --- stable identity and versioning (r5 Task 1.2, correction C-16) -------
    //
    // The seed identity TODAY is the `(type, config)` pair below, which is why
    // editing a config silently creates a DIFFERENT source instead of a new
    // version of the same one. `manifest_id` is the durable identity that
    // replaces it.
    //
    // NULLABLE, and that is the whole point: the 2026-10-05 seed files are
    // immutable (C-16) and carry no manifest id, so a NOT NULL column — even
    // with a default — would either make the seed unappliable or invent an
    // identity for sixteen rows nobody has verified. Task 3.7 backfills real
    // ids from the typed manifest; until then NULL means "not yet claimed",
    // and the partial UNIQUE below keeps the claimed ones distinct.
    manifestId: text('manifest_id'),
    /** Board / account scope (an ATS company slug); '' for global providers — never NULL. */
    namespace: text('namespace').notNull().default(''),
    /** Which manifest entry revision this row was provisioned from. */
    manifestVersion: integer('manifest_version').notNull().default(1),
    /** Policy (limits, cooldowns, coverage rules) frozen under this version. */
    policyVersion: integer('policy_version').notNull().default(1),
    /**
     * Bumped on every change to `config`. A CHECKPOINT BELONGS TO ITS CONFIG
     * VERSION: `job_collection_runs.config_version` records the version a
     * checkpoint was taken under, so a bump here invalidates every stored
     * checkpoint without deleting the run history that proves it existed.
     */
    configVersion: integer('config_version').notNull().default(1),

    // --- real-unit account metering (r5 Task 1.2 / 3.7) ---------------------
    //
    // Several sources can share ONE account (the three seeded JSearch queries
    // bill against a single RapidAPI key), so the counter lives on the meter,
    // not here. The legacy `budget_*` columns above stay for DOU (r5 A1h) and
    // the two never share a counter.
    accountMeterId: uuid('account_meter_id'),

    // --- readiness and administrative state ---------------------------------
    //
    // `enabled`, the admin state and readiness are THREE separate states
    // (r5 6.5 / 7.5): a source can be switched on, not paused, and still
    // unusable because its credentials were never verified. HTTP 200 is not
    // readiness, and the sixteen seeded rows are candidates, not verified
    // configs (C-16).
    readiness: jobSourceReadinessEnum('readiness').notNull().default('CANDIDATE'),
    /** Typed reason a source is readiness-BLOCKED (policy / credential / contract). Bounded by CHECK. */
    readinessReason: text('readiness_reason'),
    adminState: jobSourceAdminStateEnum('admin_state').notNull().default('ACTIVE'),
    /**
     * Append-only JSON array of administrative transitions. "Never delete
     * provenance by removing a source" (r5): retiring is a state recorded here,
     * never a DELETE — and `job_collection_runs` holds a RESTRICT foreign key
     * to make that mechanical rather than advisory.
     */
    adminStateHistory: jsonb('admin_state_history')
      .notNull()
      .default(sql`'[]'::jsonb`),

    // --- attempt history and cooldown ---------------------------------------
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    /**
     * Last attempt that returned at least one record — kept APART from
     * `last_success_at` because a SUCCEEDED attempt may legitimately carry zero
     * items, and "succeeding and finding nothing for a week" is the symptom
     * only this column can show.
     */
    lastNonemptyAt: timestamp('last_nonempty_at', { withTimezone: true }),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    cooldownUntil: timestamp('cooldown_until', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /** Typed classification from a documented status / error code, never page text. */
    lastErrorCode: text('last_error_code'),
    /** Sanitized sentence — never a provider secret, never a raw upstream body. */
    lastErrorMessage: text('last_error_message'),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One row per (type, settings) pair — re-seeding the same source is a
    // no-op instead of silently doubling every collection run. KEPT: the
    // immutable seed's `ON CONFLICT (type, config) DO NOTHING` targets this
    // constraint by name, so dropping it would break re-application.
    unique('uq_job_sources_type_config').on(t.type, t.config),
    // Unique only WHERE PRESENT: every unclaimed row holds NULL, and a plain
    // UNIQUE would be satisfied by those NULLs anyway — the partial index says
    // so explicitly instead of relying on that reading.
    uniqueIndex('uq_job_sources_manifest_id')
      .on(t.manifestId)
      .where(sql`${t.manifestId} IS NOT NULL`),
    foreignKey({
      name: 'fk_job_sources_account_meter',
      columns: [t.accountMeterId],
      foreignColumns: [jobAccountMeters.id],
      // SET NULL, not RESTRICT: retiring a provider account must not pin the
      // source row. The spend history lives on the meter's reservations.
    }).onDelete('set null'),
    index('idx_job_sources_account_meter').on(t.accountMeterId),
    // The cron's scan: which sources are due.
    index('idx_job_sources_next_attempt').on(t.nextAttemptAt),
    // Same shape as the account key: a short lowercase id, no secrets, no URL.
    check(
      'ck_job_sources_manifest_id_format',
      sql`${t.manifestId} IS NULL OR ${t.manifestId} ~ ${sql.raw(`'${JOB_PUBLIC_ID_PATTERN}'`)}`,
    ),
    // SR-M-1: same refusal as the account key — an identity is segmented, a
    // pasted key is one unbroken run.
    check(
      'ck_job_sources_manifest_id_segmented',
      sql`${t.manifestId} IS NULL OR ${t.manifestId} !~ ${sql.raw(`'${JOB_UNBROKEN_RUN_PATTERN}'`)}`,
    ),
    // SR-M-3: the limit `jobSourceHealthSchema.namespace` already carried.
    check(
      'ck_job_sources_namespace_bounded',
      sql`length(${t.namespace}) <= ${sql.raw(String(JOB_HANDLE_MAX))}`,
    ),
    check(
      'ck_job_sources_versions_positive',
      sql`${t.manifestVersion} > 0 AND ${t.policyVersion} > 0 AND ${t.configVersion} > 0`,
    ),
    check('ck_job_sources_consecutive_failures_nonneg', sql`${t.consecutiveFailures} >= 0`),
    // A source nobody may collect from says why — otherwise the ADMIN screen
    // can only show "blocked" with no way to act on it.
    check(
      'ck_job_sources_blocked_has_reason',
      sql`${t.readiness} <> 'BLOCKED' OR ${t.readinessReason} IS NOT NULL`,
    ),
    check(
      'ck_job_sources_last_error_bounded',
      sql`${t.lastErrorMessage} IS NULL OR length(${t.lastErrorMessage}) <= ${sql.raw(String(JOB_SANITIZED_TEXT_MAX))}`,
    ),
    // SR-M-2 / SPEC-M-1: a TYPED code, not free text. The column was unbounded
    // `text`, so a 400-character upstream body — which may carry a key — was
    // accepted into a column documented as holding a classification.
    check(
      'ck_job_sources_last_error_code_format',
      sql`${t.lastErrorCode} IS NULL OR ${t.lastErrorCode} ~ ${sql.raw(`'${JOB_ERROR_CODE_PATTERN}'`)}`,
    ),
    // The reason reaches an ADMIN screen; a sentence, never a pasted response.
    check(
      'ck_job_sources_readiness_reason_bounded',
      sql`${t.readinessReason} IS NULL OR length(${t.readinessReason}) <= ${sql.raw(String(JOB_SANITIZED_TEXT_MAX))}`,
    ),
    // History is an ARRAY: an object or a scalar here would silently become a
    // one-entry "history" that no append can extend.
    check(
      'ck_job_sources_admin_state_history_array',
      sql`jsonb_typeof(${t.adminStateHistory}) = 'array'`,
    ),
  ],
)

export const jobPostings = pgTable(
  'job_postings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceType: jobSourceTypeEnum('source_type').notNull(),
    sourceId: uuid('source_id').references(() => jobSources.id, { onDelete: 'set null' }),
    /** Stable identity WITHIN a source — the canonical, query-stripped URL. */
    externalId: text('external_id').notNull(),
    /** Original posting URL. https-only, enforced at ingest and on the wire. */
    url: text('url').notNull(),
    title: text('title').notNull(),
    companyName: text('company_name').notNull(),
    /**
     * `normalizeCompanyName(companyName)` — persisted so company filtering is a
     * plain string comparison instead of re-folding every row on every read.
     * Recomputed on every ingest, never edited by hand.
     */
    companyNameNormalized: text('company_name_normalized').notNull(),
    location: text('location'),
    /** Markdown, never raw HTML — converted + stripped at ingest. */
    descriptionMd: text('description_md').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /**
     * sha256(sourceType + '|' + canonical URL) — the dedupe key (AC1). It is
     * computed from the CANONICALIZED url (query string stripped) because DOU's
     * `<guid>` carries a fresh timestamp query on every fetch, so a raw-URL
     * fingerprint would treat the same vacancy as new on every single run.
     */
    fingerprint: text('fingerprint').notNull(),
    collectedAt: timestamp('collected_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),

    // --- vacancy queue (vacancy-sourcing phase 1) ----------------------------
    /** sha256(company_normalized|normalized title) — CROSS-source twin key. NULL = legacy row, invisible to the queue. */
    dedupeKey: text('dedupe_key'),
    /** Other places this same job is open: [{ source, url }], capped at 20 by the upsert. */
    alsoSeenOn: jsonb('also_seen_on')
      .notNull()
      .default(sql`'[]'::jsonb`),
    matchedSeniorIds: uuid('matched_senior_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    matchedKeywords: text('matched_keywords')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Stryker disable next-line StringLiteral: equivalent mutant — drizzle falls back to the property KEY when a column name is empty, and the key is also `seniority`, so the generated column is identical; the default 'UNKNOWN' on this same line is asserted by job-queue-schema.spec.ts
    seniority: jobSeniorityEnum('seniority').notNull().default('UNKNOWN'),
    stackUnknown: boolean('stack_unknown').notNull().default(false),
    rankScore: integer('rank_score').notNull().default(0),
    queueStatus: jobQueueStatusEnum('queue_status').notNull().default('NEW'),
    takenBy: uuid('taken_by').references(() => users.id, { onDelete: 'set null' }),
    takenAt: timestamp('taken_at', { withTimezone: true }),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('uq_job_postings_fingerprint').on(t.fingerprint),
    index('idx_job_postings_published_at').on(t.publishedAt.desc()),
    index('idx_job_postings_company_normalized').on(t.companyNameNormalized),
    uniqueIndex('uq_job_postings_dedupe_key')
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
    index('idx_job_postings_queue').on(
      t.queueStatus,
      t.rankScore.desc(),
      t.collectedAt.desc(),
      t.id.desc(),
    ),
    index('idx_job_postings_matched_seniors').using('gin', t.matchedSeniorIds),
  ],
)

export const jobSuggestions = pgTable(
  'job_suggestions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    postingId: uuid('posting_id')
      .notNull()
      .references(() => jobPostings.id, { onDelete: 'cascade' }),
    seniorId: uuid('senior_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: jobSuggestionStatusEnum('status').notNull().default('NEW'),
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),
    statusChangedBy: uuid('status_changed_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One suggestion per (posting, senior). This is what makes a REJECTED
    // posting stay rejected (AC4): a later collection run cannot insert a
    // second NEW row for the same pair.
    uniqueIndex('uq_job_suggestions_posting_senior').on(t.postingId, t.seniorId),
    index('idx_job_suggestions_senior_status').on(t.seniorId, t.status),
  ],
)

/** One row per HR action on a queue posting (opened / taken / dead link / spam). */
export const jobPostingSignals = pgTable(
  'job_posting_signals',
  {
    // Stryker disable next-line StringLiteral: equivalent mutant — drizzle falls back to the property KEY when a column name is empty, and the key is also `id`, so the generated column is identical
    id: uuid('id').defaultRandom().primaryKey(),
    postingId: uuid('posting_id')
      .notNull()
      .references(() => jobPostings.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    kind: jobSignalKindEnum('kind').notNull(),
    // Stryker disable next-line BooleanLiteral: withTimezone selects timestamptz at the DB level — only observable via a real Postgres round-trip (integration), not a unit test (mutation-gate-integration-specs.md)
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('idx_job_posting_signals_posting').on(t.postingId, t.kind)],
)

/**
 * Manual exclusions. `senior_id IS NULL` means the studio-wide (GLOBAL) list.
 *
 * NOT stored here: exclusions derived from the senior's own projects — those
 * are recomputed on every read (see JobSourcingService.buildExclusionSet) so
 * they can never go stale after a project is added, renamed or archived.
 */
export const jobExclusionFilters = pgTable(
  'job_exclusion_filters',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    seniorId: uuid('senior_id').references(() => users.id, { onDelete: 'cascade' }),
    kind: jobExclusionKindEnum('kind').notNull(),
    /** As typed by the human — shown in the UI. */
    value: text('value').notNull(),
    /** Canonical form used for matching (`normalizeCompanyName`). */
    normalizedValue: text('normalized_value').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Two PARTIAL unique indexes rather than one `NULLS NOT DISTINCT` index:
    // in Postgres NULLs are distinct by default, so a plain unique index on a
    // nullable senior_id would happily accept the same GLOBAL entry twice.
    uniqueIndex('uq_job_exclusions_global').on(t.kind, t.normalizedValue).where(isNull(t.seniorId)),
    uniqueIndex('uq_job_exclusions_senior')
      .on(t.seniorId, t.kind, t.normalizedValue)
      .where(sql`${t.seniorId} IS NOT NULL`),
    index('idx_job_exclusions_senior').on(t.seniorId),
  ],
)

// Job sourcing relations (task-job-sourcing-slice1)
export const jobPostingsRelations = relations(jobPostings, ({ one, many }) => ({
  source: one(jobSources, { fields: [jobPostings.sourceId], references: [jobSources.id] }),
  suggestions: many(jobSuggestions),
}))

export const jobSuggestionsRelations = relations(jobSuggestions, ({ one }) => ({
  posting: one(jobPostings, {
    fields: [jobSuggestions.postingId],
    references: [jobPostings.id],
  }),
  senior: one(users, {
    fields: [jobSuggestions.seniorId],
    references: [users.id],
    relationName: 'jobSuggestionsAsSenior',
  }),
  statusChangedByUser: one(users, {
    fields: [jobSuggestions.statusChangedBy],
    references: [users.id],
    relationName: 'jobSuggestionsAsStatusChanger',
  }),
}))

export type JobSource = typeof jobSources.$inferSelect

export type NewJobSource = typeof jobSources.$inferInsert

export type JobPosting = typeof jobPostings.$inferSelect

export type JobPostingSignal = typeof jobPostingSignals.$inferSelect

export type NewJobPosting = typeof jobPostings.$inferInsert

export type JobSuggestion = typeof jobSuggestions.$inferSelect

export type NewJobSuggestion = typeof jobSuggestions.$inferInsert

export type JobExclusionFilter = typeof jobExclusionFilters.$inferSelect

export type NewJobExclusionFilter = typeof jobExclusionFilters.$inferInsert
