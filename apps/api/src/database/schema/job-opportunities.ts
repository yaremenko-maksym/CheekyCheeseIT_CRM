/**
 * Job opportunities (r5 Phase 1) — the NEW vacancy-sourcing store.
 *
 *   job_text_blobs                 content-addressed description text
 *   job_source_records             one row per provider-native posting (scoped identity)
 *   job_source_record_revisions    immutable observations of a record
 *   job_opportunities              canonical, de-duplicated external job
 *   job_opportunity_sources        record -> opportunity link, with history
 *   job_opportunity_matches        per-senior evaluation (LEAD / TRIAGE / EXCLUDED)
 *   job_opportunity_team_triage    ADMIN-assigned cross-team visibility
 *
 * ADDITIVE: independent of the legacy `job_postings` / `job_suggestions` path
 * (separate tables, native scoped identity instead of the legacy fingerprint).
 * "Opportunity", not "vacancy": `vacancies` are the studio's own landing
 * postings (CONTEXT.md).
 *
 * Everything stored here originated in a third party and is UNTRUSTED: stored
 * navigation URLs are https-only by CHECK; hashes are 64-hex by CHECK.
 */
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
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
  jobAvailabilityEnum,
  jobIdentityKindEnum,
  jobOpportunityLinkDecisionEnum,
  jobOpportunityMatchOutcomeEnum,
  jobSeniorityEnum,
  jobSourceTypeEnum,
} from './enums'
import { teams, users } from './users'

/**
 * records <-> revisions reference each other. The explicit return type breaks
 * the circular type inference (TS7022) that would otherwise degrade every
 * relational query type in the schema to `any`.
 */
function revisionIdColumn(): AnyPgColumn {
  return jobSourceRecordRevisions.id
}

/**
 * Stored navigation URLs: https only, with a host, no whitespace, no embedded
 * credentials. The authority (up to the first `/`, `?` or `#`) must be non-empty
 * and free of `@` and whitespace, so `https://`, `https:// x` and
 * `https://user:pass@host/` are all rejected.
 *
 * One of THREE guards on the same value, to be changed together:
 *   * `externalHttpsUrlSchema` (`packages/shared/src/schemas/job-sourcing.ts`) —
 *     `.url()` + `.max(2048)` + `^https:\/\/[^/?#@]+([/?#]\S*)?$`, with whitespace
 *     in the authority left to `.url()`;
 *   * `isSafeExternalUrl`
 *     (`apps/web/app/components/job-sourcing/open-original.ts`) — the same shape
 *     as a bare regex, plus a `new URL` parse, before `window.open`;
 *   * this CHECK, which is shape-only: no URL parser, no length cap, and
 *     `[:space:]` is locale-dependent for non-ASCII characters.
 *
 * What pins them together is `EXTERNAL_URL_CORPUS`
 * (`packages/shared/src/schemas/job-sourcing-url-corpus.ts`), run against this
 * CHECK in `job-source-type-enum-ddl.integration.spec.ts`. A pre-R11-H-4 version of
 * this comment quoted the zod schema as `^https://\S+$`, which accepted
 * credentials; do not reintroduce that shape.
 */
const HTTPS_URL_PATTERN = '^https://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$'
const httpsUrlOrNull = (column: AnyPgColumn) =>
  sql`${column} IS NULL OR ${column} ~* ${sql.raw(`'${HTTPS_URL_PATTERN}'`)}`

/** Content-addressed text: identical descriptions are stored once. */
export const jobTextBlobs = pgTable(
  'job_text_blobs',
  {
    sha256: text('sha256').primaryKey(),
    text: text('text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [check('ck_job_text_blobs_sha256_hex', sql`${t.sha256} ~ '^[0-9a-f]{64}$'`)],
)

export const jobSourceRecords = pgTable(
  'job_source_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceType: jobSourceTypeEnum('source_type').notNull(),
    /** Board / account scope (e.g. an ATS company slug); '' for global providers — never NULL. */
    namespace: text('namespace').notNull().default(''),
    identityKind: jobIdentityKindEnum('identity_kind').notNull(),
    /** Provider-native id, or the canonical URL when the kind is URL_FALLBACK. */
    identityKey: text('identity_key').notNull(),
    originalUrl: text('original_url'),
    displayUrl: text('display_url'),
    /** The source's own posting page. */
    sourceUrl: text('source_url'),
    /** Where to apply — kept apart from the posting page. */
    applicationUrl: text('application_url'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }).defaultNow().notNull(),
    // FK declared in the table extras with an explicit name (auto name > 63 chars).
    latestRevisionId: uuid('latest_revision_id'),
    availability: jobAvailabilityEnum('availability').notNull().default('UNKNOWN'),
    availabilityEvidence: jsonb('availability_evidence')
      .notNull()
      .default(sql`'{}'::jsonb`),
    availabilityCheckedAt: timestamp('availability_checked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Discovery queries are observations, not identity: two configs that see
    // the same native job resolve to this one row.
    unique('uq_job_source_records_identity').on(t.sourceType, t.namespace, t.identityKey),
    index('idx_job_source_records_last_observed').on(t.lastObservedAt),
    // At least one non-whitespace character ('' / '   ' / tabs / newlines all rejected).
    check('ck_job_source_records_identity_key_nonempty', sql`${t.identityKey} ~ '[^[:space:]]'`),
    foreignKey({
      name: 'fk_job_source_records_latest_revision',
      columns: [t.latestRevisionId],
      foreignColumns: [revisionIdColumn()],
    }).onDelete('set null'),
    check('ck_job_source_records_original_url_https', httpsUrlOrNull(t.originalUrl)),
    check('ck_job_source_records_display_url_https', httpsUrlOrNull(t.displayUrl)),
    check('ck_job_source_records_source_url_https', httpsUrlOrNull(t.sourceUrl)),
    check('ck_job_source_records_application_url_https', httpsUrlOrNull(t.applicationUrl)),
  ],
)

export const jobSourceRecordRevisions = pgTable(
  'job_source_record_revisions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceRecordId: uuid('source_record_id').notNull(),
    adapterVersion: text('adapter_version').notNull(),
    normalizerVersion: text('normalizer_version').notNull(),
    contentHash: text('content_hash').notNull(),
    /** Normalized posting fields (title, company, location, tags, ...). */
    normalized: jsonb('normalized').notNull(),
    /** Identity fields exactly as the provider sent them, before normalization. */
    originalIdentity: jsonb('original_identity').notNull(),
    /** field -> evidence of where the value came from. */
    fieldProvenance: jsonb('field_provenance')
      .notNull()
      .default(sql`'{}'::jsonb`),
    evidence: jsonb('evidence')
      .notNull()
      .default(sql`'{}'::jsonb`),
    descriptionSha256: text('description_sha256'),
    /** Date string as received, and what we parsed from it. */
    publishedAtRaw: text('published_at_raw'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** Arrival order (database-assigned) — NOT the provider's publish order. */
    receivedSeq: bigint('received_seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    /** Pointer to a bounded stored sample, where policy permits one. */
    sampleRef: text('sample_ref'),
  },
  (t) => [
    // Explicit FK names: the generated ones exceed Postgres' 63-char identifier
    // limit, get truncated in the catalog, and make every re-push see drift.
    foreignKey({
      name: 'fk_job_source_record_revisions_record',
      columns: [t.sourceRecordId],
      foreignColumns: [jobSourceRecords.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_job_source_record_revisions_description',
      columns: [t.descriptionSha256],
      foreignColumns: [jobTextBlobs.sha256],
    }).onDelete('restrict'),
    // Column order matches the table's column order on purpose: drizzle-kit's
    // introspection returns table order, so any other order is seen as drift and
    // the constraint is dropped and re-added on every push.
    unique('uq_job_source_record_revisions_content').on(
      t.sourceRecordId,
      t.normalizerVersion,
      t.contentHash,
    ),
    index('idx_job_source_record_revisions_record_seq').on(t.sourceRecordId, t.receivedSeq.desc()),
    // FK child index: RESTRICT on job_text_blobs needs a cheap referencing-row probe.
    index('idx_job_source_record_revisions_description').on(t.descriptionSha256),
    check(
      'ck_job_source_record_revisions_content_hash_hex',
      sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
)

export const jobOpportunities = pgTable(
  'job_opportunities',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    title: text('title').notNull(),
    /** Normalized title used only as a (non-unique) candidate key. */
    titleKey: text('title_key').notNull(),
    /** NULL when the source does not state one — never invented from a slug. */
    employerName: text('employer_name'),
    employerKey: text('employer_key'),
    employerVerified: boolean('employer_verified').notNull().default(false),
    location: text('location'),
    seniority: jobSeniorityEnum('seniority').notNull().default('UNKNOWN'),
    /** Canonical stack keywords; GIN-indexed for keyword -> opportunity invalidation. */
    stackKeywords: text('stack_keywords')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    applicationUrl: text('application_url'),
    applicationUrlKey: text('application_url_key'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    descriptionSha256: text('description_sha256').references(() => jobTextBlobs.sha256, {
      onDelete: 'restrict',
    }),
    /** selected field -> id of the source-record revision it was taken from. */
    fieldRevisions: jsonb('field_revisions')
      .notNull()
      .default(sql`'{}'::jsonb`),
    availability: jobAvailabilityEnum('availability').notNull().default('UNKNOWN'),
    /** Bumped on every change that can alter a match; stale matches are never served. */
    revision: integer('revision').notNull().default(1),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastObservedAt: timestamp('last_observed_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // Deliberately NO unique company/title constraint: two real openings can
    // share both. These are candidate keys for identity resolution only.
    index('idx_job_opportunities_candidate_key').on(t.employerKey, t.titleKey),
    index('idx_job_opportunities_application_url_key').on(t.applicationUrlKey),
    index('idx_job_opportunities_stack_keywords').using('gin', t.stackKeywords),
    index('idx_job_opportunities_availability').on(t.availability),
    index('idx_job_opportunities_description').on(t.descriptionSha256),
    check('ck_job_opportunities_revision_positive', sql`${t.revision} > 0`),
    check(
      'ck_job_opportunities_verified_has_key',
      sql`NOT ${t.employerVerified} OR ${t.employerKey} IS NOT NULL`,
    ),
    check('ck_job_opportunities_application_url_https', httpsUrlOrNull(t.applicationUrl)),
  ],
)

export const jobOpportunitySources = pgTable(
  'job_opportunity_sources',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    // RESTRICT both ways: link history is provenance and is never cascaded away.
    sourceRecordId: uuid('source_record_id').notNull(),
    opportunityId: uuid('opportunity_id').notNull(),
    decision: jobOpportunityLinkDecisionEnum('decision').notNull().default('AUTO'),
    evidence: jsonb('evidence')
      .notNull()
      .default(sql`'{}'::jsonb`),
    ruleVersion: text('rule_version').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).defaultNow().notNull(),
    unlinkedAt: timestamp('unlinked_at', { withTimezone: true }),
    unlinkReason: text('unlink_reason'),
  },
  (t) => [
    foreignKey({
      name: 'fk_job_opportunity_sources_record',
      columns: [t.sourceRecordId],
      foreignColumns: [jobSourceRecords.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_opportunity_sources_opportunity',
      columns: [t.opportunityId],
      foreignColumns: [jobOpportunities.id],
    }).onDelete('restrict'),
    // At most one ACTIVE owner per record; unlinked rows are history.
    uniqueIndex('uq_job_opportunity_sources_active_record')
      .on(t.sourceRecordId)
      .where(sql`${t.unlinkedAt} IS NULL`),
    index('idx_job_opportunity_sources_opportunity').on(t.opportunityId),
    // The partial unique index above covers ACTIVE links only; history lookups
    // by record (and the RESTRICT FK probe) need a full index.
    index('idx_job_opportunity_sources_record').on(t.sourceRecordId),
    check(
      'ck_job_opportunity_sources_unlink_pair',
      sql`(${t.unlinkedAt} IS NULL) = (${t.unlinkReason} IS NULL)`,
    ),
  ],
)

export const jobOpportunityMatches = pgTable(
  'job_opportunity_matches',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    opportunityId: uuid('opportunity_id')
      .notNull()
      .references(() => jobOpportunities.id, { onDelete: 'cascade' }),
    seniorId: uuid('senior_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Input versions: a row whose versions differ from the current ones is stale and never served.
    opportunityRevision: integer('opportunity_revision').notNull(),
    seniorProfileVersion: text('senior_profile_version').notNull(),
    exclusionVersion: text('exclusion_version').notNull(),
    ruleVersion: text('rule_version').notNull(),
    outcome: jobOpportunityMatchOutcomeEnum('outcome').notNull(),
    evidence: jsonb('evidence')
      .notNull()
      .default(sql`'{}'::jsonb`),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('uq_job_opportunity_matches_opportunity_senior').on(t.opportunityId, t.seniorId),
    // Per-senior invalidation (archive / team change) and queue reads.
    index('idx_job_opportunity_matches_senior').on(t.seniorId, t.outcome),
  ],
)

export const jobOpportunityTeamTriage = pgTable(
  'job_opportunity_team_triage',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    opportunityId: uuid('opportunity_id').notNull(),
    teamId: uuid('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    /** ADMIN who made the assignment (after restriction checks). */
    assignedBy: uuid('assigned_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    evidence: jsonb('evidence')
      .notNull()
      .default(sql`'{}'::jsonb`),
    policyVersion: integer('policy_version').notNull(),
    opportunityRevision: integer('opportunity_revision').notNull(),
    grantVersion: integer('grant_version').notNull().default(1),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: 'fk_job_opportunity_team_triage_opportunity',
      columns: [t.opportunityId],
      foreignColumns: [jobOpportunities.id],
    }).onDelete('cascade'),
    unique('uq_job_opportunity_team_triage_opportunity_team').on(t.opportunityId, t.teamId),
    index('idx_job_opportunity_team_triage_team').on(t.teamId, t.expiresAt),
    index('idx_job_opportunity_team_triage_assigned_by').on(t.assignedBy),
  ],
)

export type JobTextBlob = typeof jobTextBlobs.$inferSelect
export type JobSourceRecord = typeof jobSourceRecords.$inferSelect
export type NewJobSourceRecord = typeof jobSourceRecords.$inferInsert
export type JobSourceRecordRevision = typeof jobSourceRecordRevisions.$inferSelect
export type NewJobSourceRecordRevision = typeof jobSourceRecordRevisions.$inferInsert
export type JobOpportunity = typeof jobOpportunities.$inferSelect
export type NewJobOpportunity = typeof jobOpportunities.$inferInsert
export type JobOpportunitySource = typeof jobOpportunitySources.$inferSelect
export type JobOpportunityMatch = typeof jobOpportunityMatches.$inferSelect
export type JobOpportunityTeamTriage = typeof jobOpportunityTeamTriage.$inferSelect
