/**
 * Job-sourcing: sources, postings, signals, suggestions and exclusion filters.
 */
import { isNull, relations, sql } from 'drizzle-orm'
import {
  boolean,
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
  jobSourceBudgetWindowEnum,
  jobSourceTriggerModeEnum,
  jobSourceTypeEnum,
  jobSuggestionStatusEnum,
} from './enums'
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

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One row per (type, settings) pair — re-seeding the same source is a
    // no-op instead of silently doubling every collection run.
    unique('uq_job_sources_type_config').on(t.type, t.config),
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
