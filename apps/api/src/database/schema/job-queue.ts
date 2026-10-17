/**
 * The queue workflow store (r5 Phase 1, Task 1.2 part 3) — what HR and ADMIN
 * DO with an opportunity, as opposed to what a collection FOUND
 * (`job-opportunities.ts`) or how it was collected (`job-collection.ts`).
 *
 *   job_queue_assignments          the studio-wide claim on an opportunity
 *   job_queue_dismissals           a TEAM- or STUDIO-scoped "not for us"
 *   job_team_triage_subscriptions  standing ADMIN triage per team
 *   job_queue_actions              append-only audit of every mutation and click
 *   job_queue_generations          a published, scoped snapshot of the queue order
 *   job_queue_generation_entries   one ranked opportunity inside a generation
 *
 * ADDITIVE: the Phase-1 queue columns on `job_postings` and the legacy
 * `job_posting_signals` table are untouched and are never read by this store
 * (C-01).
 *
 * RBAC AND TENANCY — WHAT THE SCHEMA CARRIES AND WHAT IT CANNOT
 * --------------------------------------------------------------
 * The cross-team disclosure risk of the store lives in these tables. A CHECK
 * sees one row and no session, so it cannot see the ACTOR'S ROLE. What the
 * schema does carry, by CHECK:
 *   - every scoped row stores `scope_kind` + `team_id`, and
 *     `..._scope_shape` makes a TEAM scope name exactly one team and a STUDIO
 *     scope name none — so a scoped read can always filter on `team_id`, and
 *     no query ever has to fall back to an unscoped one for lack of a column;
 *   - every actor is a NOT NULL / paired FK to `users`.
 * What it cannot carry, and is therefore a PHASE-6 SERVICE OBLIGATION (r5
 * Tasks 6.1 / 6.3 / 6.4), listed again on each table:
 *   - a STUDIO-scoped row (dismissal, claim, generation) is written only by an
 *     ADMIN; a TEAM-scoped row only by an ADMIN or by an HR who is a CURRENT
 *     active member of that team (membership is re-checked inside the write
 *     transaction, not taken from a cached projection);
 *   - release / reassign / suppress / triage grant / triage subscription are
 *     ADMIN-only;
 *   - a read never returns a row of a team the viewer is not scoped to.
 *
 * APPEND-ONLY AND IMMUTABLE — WHAT ACTUALLY ENFORCES THEM IN THIS PR
 * ------------------------------------------------------------------
 * NOTHING at the database level yet. `job_queue_actions` (append-only) and
 * `job_queue_generation_entries` (immutable) accept UPDATE and DELETE on the
 * schema this file produces: Drizzle cannot declare a trigger, so `db:push`
 * cannot create one, and this task writes no forward DDL (Task 1.3 does). The
 * integration spec pins that gap rather than hiding it.
 * What this PR does deliver toward the invariant:
 *   - no `updated_at` on either table — nothing in the schema invites an edit;
 *   - every parent FK of the action log is RESTRICT, so no parent delete can
 *     erase audit rows through a cascade.
 * TASK 1.3 OBLIGATION (forward DDL, by hand from this comment): BOTH
 *   (a) a `BEFORE UPDATE OR DELETE` row trigger on each of the two tables that
 *       raises, plus a `BEFORE TRUNCATE` statement trigger; and
 *   (b) the least-privileged application role gets only INSERT + SELECT on
 *       both (no UPDATE, DELETE, TRUNCATE).
 *   The generation purge (see below) runs as a role that may DELETE entries,
 *   or deletes the generation and lets the CASCADE remove them — the trigger
 *   on entries must therefore allow a DELETE that arrives through that FK
 *   cascade (pg_trigger_depth() > 0) and refuse a direct one.
 */
import { type SQL, sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  jobQueueActionKindEnum,
  jobQueueAssignmentStateEnum,
  jobQueueGenerationStatusEnum,
  jobQueueScopeKindEnum,
  jobSourceTypeEnum,
} from './enums'
import { jobOpportunities, jobSourceRecords } from './job-opportunities'
import { JOB_HANDLE_MAX, JOB_SANITIZED_TEXT_MAX, JOB_SHORT_TEXT_MAX } from './job-patterns'
import { teams, users } from './users'

/**
 * Non-blank and at most `max` CHARACTERS. A length-and-non-blank guard ONLY:
 * it cannot tell a sanitized sentence from an upstream body or from personal
 * data — keeping those out is the writer's obligation. Same shape as the
 * shared `triageReasonSchema` (`trim().min(1).max(500)`).
 */
const boundedText = (c: AnyPgColumn, max: number): SQL =>
  sql`${c} ~ '[^[:space:]]' AND length(${c}) <= ${sql.raw(String(max))}`
const boundedTextOrNull = (c: AnyPgColumn, max: number): SQL =>
  sql`${c} IS NULL OR (${boundedText(c, max)})`

/** A TEAM scope names exactly one team; a STUDIO scope names none. Two branches. */
const scopeShape = (kind: AnyPgColumn, team: AnyPgColumn): SQL =>
  sql`(${kind} = 'TEAM' AND ${team} IS NOT NULL) OR (${kind} = 'STUDIO' AND ${team} IS NULL)`

const TELEMETRY_KINDS = sql.raw(`('OPENED', 'DEAD_LINK', 'SPAM')`)
const SUBSCRIPTION_KINDS = sql.raw(`('TRIAGE_SUBSCRIBED', 'TRIAGE_UNSUBSCRIBED')`)
const TRIAGE_KINDS = sql.raw(
  `('TRIAGE_GRANTED', 'TRIAGE_REVOKED', 'TRIAGE_SUBSCRIBED', 'TRIAGE_UNSUBSCRIBED')`,
)

/**
 * The claim. UNIQUE(opportunity) makes it STUDIO-WIDE (r5 Task 6.3): two
 * concurrent first claims both INSERT and one gets 23505. The row is kept on
 * release, so a later claim is an UPDATE guarded by `version` (the expected
 * version in the WHERE clause), which is what serializes a re-take.
 *
 * PHASE-6 OBLIGATIONS: a claim in STUDIO scope is an ADMIN's; release and
 * reassign are ADMIN-only; "already taken" is shown without the assignee's
 * name outside the viewer's scope (`jobQueueAssignmentSchema` carries no
 * actor and no team for that reason); the take transaction locks the target
 * and its possible-duplicate set in sorted id order.
 */
export const jobQueueAssignments = pgTable(
  'job_queue_assignments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    opportunityId: uuid('opportunity_id').notNull(),
    state: jobQueueAssignmentStateEnum('state').notNull().default('TAKEN'),
    /** The scope the claimer acted in: their team, or STUDIO (team NULL) for an ADMIN. */
    scopeKind: jobQueueScopeKindEnum('scope_kind').notNull(),
    teamId: uuid('team_id'),
    /** The current — or, once RELEASED, the last — holder. */
    assigneeId: uuid('assignee_id').notNull(),
    takenAt: timestamp('taken_at', { withTimezone: true }).defaultNow().notNull(),
    version: integer('version').notNull().default(1),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releasedBy: uuid('released_by'),
    releaseReason: text('release_reason'),
    reassignedAt: timestamp('reassigned_at', { withTimezone: true }),
    reassignedBy: uuid('reassigned_by'),
    reassignedFromId: uuid('reassigned_from_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('uq_job_queue_assignments_opportunity').on(t.opportunityId),
    // Workflow state derived from the opportunity: it goes with it.
    foreignKey({
      name: 'fk_job_queue_assignments_opportunity',
      columns: [t.opportunityId],
      foreignColumns: [jobOpportunities.id],
    }).onDelete('cascade'),
    // RESTRICT: a claim is studio-wide state, not part of a team's view, so
    // deleting a team must not silently drop it (teams are not deleted by the
    // application today; this makes the database say so if one ever is).
    foreignKey({
      name: 'fk_job_queue_assignments_team',
      columns: [t.teamId],
      foreignColumns: [teams.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_queue_assignments_assignee',
      columns: [t.assigneeId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_queue_assignments_released_by',
      columns: [t.releasedBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_queue_assignments_reassigned_by',
      columns: [t.reassignedBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_queue_assignments_reassigned_from',
      columns: [t.reassignedFromId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    index('idx_job_queue_assignments_assignee').on(t.assigneeId, t.state),
    index('idx_job_queue_assignments_team').on(t.teamId, t.state),
    check('ck_job_queue_assignments_scope_shape', scopeShape(t.scopeKind, t.teamId)),
    check('ck_job_queue_assignments_version_positive', sql`${t.version} > 0`),
    // Two branches (lesson CR-M-1 of #1015). TAKEN clears every release field,
    // the reason included, so a re-take cannot keep the previous holder's
    // reason; RELEASED requires when + by whom, the reason stays optional.
    check(
      'ck_job_queue_assignments_release_pair',
      sql`(${t.state} = 'TAKEN' AND ${t.releasedAt} IS NULL AND ${t.releasedBy} IS NULL AND ${t.releaseReason} IS NULL)
          OR (${t.state} = 'RELEASED' AND ${t.releasedAt} IS NOT NULL AND ${t.releasedBy} IS NOT NULL)`,
    ),
    check(
      'ck_job_queue_assignments_release_reason_bounded',
      boundedTextOrNull(t.releaseReason, JOB_SANITIZED_TEXT_MAX),
    ),
    check(
      'ck_job_queue_assignments_reassign_triple',
      sql`(${t.reassignedAt} IS NULL AND ${t.reassignedBy} IS NULL AND ${t.reassignedFromId} IS NULL)
          OR (${t.reassignedAt} IS NOT NULL AND ${t.reassignedBy} IS NOT NULL AND ${t.reassignedFromId} IS NOT NULL)`,
    ),
  ],
)

/**
 * A scoped dismissal. UNIQUE(opportunity, scope kind, scope ID) — the scope ID
 * IS `team_id`, NULL for STUDIO, and the constraint is NULLS NOT DISTINCT
 * (PostgreSQL 15+): without it two STUDIO rows for one opportunity would both
 * pass, because NULLs are distinct in a plain UNIQUE. Undo keeps the row
 * (undo metadata set) and a re-dismiss UPDATEs it under `version`; the history
 * of both lives in `job_queue_actions`.
 *
 * PHASE-6 OBLIGATIONS: a STUDIO dismissal is ADMIN-ONLY (r5) — the schema
 * stores the kind and refuses a STUDIO row that names a team, but cannot see
 * that the actor is an ADMIN. A TEAM dismissal is written only for a team the
 * actor currently belongs to (or by an ADMIN), and HR reads only their own
 * team's rows.
 */
export const jobQueueDismissals = pgTable(
  'job_queue_dismissals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    opportunityId: uuid('opportunity_id').notNull(),
    scopeKind: jobQueueScopeKindEnum('scope_kind').notNull(),
    teamId: uuid('team_id'),
    reason: text('reason').notNull(),
    dismissedBy: uuid('dismissed_by').notNull(),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }).defaultNow().notNull(),
    version: integer('version').notNull().default(1),
    undoneAt: timestamp('undone_at', { withTimezone: true }),
    undoneBy: uuid('undone_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('uq_job_queue_dismissals_opportunity_scope')
      .on(t.opportunityId, t.scopeKind, t.teamId)
      .nullsNotDistinct(),
    foreignKey({
      name: 'fk_job_queue_dismissals_opportunity',
      columns: [t.opportunityId],
      foreignColumns: [jobOpportunities.id],
    }).onDelete('cascade'),
    // CASCADE: a TEAM dismissal is part of that team's view and nothing else.
    foreignKey({
      name: 'fk_job_queue_dismissals_team',
      columns: [t.teamId],
      foreignColumns: [teams.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_job_queue_dismissals_dismissed_by',
      columns: [t.dismissedBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_queue_dismissals_undone_by',
      columns: [t.undoneBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    index('idx_job_queue_dismissals_scope').on(t.scopeKind, t.teamId),
    check('ck_job_queue_dismissals_scope_shape', scopeShape(t.scopeKind, t.teamId)),
    check('ck_job_queue_dismissals_version_positive', sql`${t.version} > 0`),
    check('ck_job_queue_dismissals_reason_bounded', boundedText(t.reason, JOB_SANITIZED_TEXT_MAX)),
    check(
      'ck_job_queue_dismissals_undo_pair',
      sql`(${t.undoneAt} IS NULL AND ${t.undoneBy} IS NULL) OR (${t.undoneAt} IS NOT NULL AND ${t.undoneBy} IS NOT NULL)`,
    ),
  ],
)

/**
 * Standing ADMIN triage for one team: opportunities of a role family (and,
 * optionally, only from some sources) become visible to that team without a
 * per-opportunity grant. Agrees with the #1011 contracts
 * (`create/revoke/jobQueueTeamTriageSubscriptionSchema`): one column per
 * contract field, plus the create reason and the revoke triple for audit.
 *
 * "NEVER COVERS UNVERIFIABLE-EMPLOYER ITEMS" (r5) IS A PHASE-6 OBLIGATION, NOT
 * A SCHEMA INVARIANT. The fact it depends on — `job_opportunities.
 * employer_verified` — is on another table; a CHECK sees only this row, and no
 * trigger can be declared here. So the rule lives in the query that applies a
 * subscription: it must add `employer_verified = true` (the column is NOT NULL,
 * default false, and `ck_job_opportunities_verified_has_key` ties it to a
 * non-NULL employer key), and an unverifiable item reaches a team only through
 * an explicit per-opportunity grant (`job_opportunity_team_triage`). The unit
 * twin pins that this table carries no verification flag, so nobody adds one a
 * CHECK could not keep true.
 *
 * OTHER PHASE-6 OBLIGATIONS: create and revoke are ADMIN-only; an expired or
 * revoked subscription grants nothing; a revoke matches `subscription_version`.
 */
export const jobTeamTriageSubscriptions = pgTable(
  'job_team_triage_subscriptions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    teamId: uuid('team_id').notNull(),
    roleFamily: text('role_family').notNull(),
    /** Empty = every source. */
    sourceTypes: jobSourceTypeEnum('source_types')
      .array()
      .notNull()
      .default(sql`'{}'::job_source_type[]`),
    policyVersion: integer('policy_version').notNull(),
    subscriptionVersion: integer('subscription_version').notNull().default(1),
    /** The ADMIN who created it. */
    actorId: uuid('actor_id').notNull(),
    reason: text('reason').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
    revokeReason: text('revoke_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // CASCADE, exactly like `job_opportunity_team_triage.team_id`.
    foreignKey({
      name: 'fk_job_team_triage_subscriptions_team',
      columns: [t.teamId],
      foreignColumns: [teams.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_job_team_triage_subscriptions_actor',
      columns: [t.actorId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_team_triage_subscriptions_revoked_by',
      columns: [t.revokedBy],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    index('idx_job_team_triage_subscriptions_team').on(t.teamId, t.expiresAt),
    check(
      'ck_job_team_triage_subscriptions_role_family_bounded',
      boundedText(t.roleFamily, JOB_SHORT_TEXT_MAX),
    ),
    // The contract's `.max(options.length)`, read from the enum itself so it
    // stays true when a provider type is added.
    check(
      'ck_job_team_triage_subscriptions_source_types_bounded',
      sql`cardinality(${t.sourceTypes}) <= cardinality(enum_range(NULL::job_source_type))`,
    ),
    check('ck_job_team_triage_subscriptions_policy_version_nonneg', sql`${t.policyVersion} >= 0`),
    check('ck_job_team_triage_subscriptions_version_positive', sql`${t.subscriptionVersion} > 0`),
    check(
      'ck_job_team_triage_subscriptions_reason_bounded',
      boundedText(t.reason, JOB_SANITIZED_TEXT_MAX),
    ),
    check(
      'ck_job_team_triage_subscriptions_revoke_triple',
      sql`(${t.revokedAt} IS NULL AND ${t.revokedBy} IS NULL AND ${t.revokeReason} IS NULL)
          OR (${t.revokedAt} IS NOT NULL AND ${t.revokedBy} IS NOT NULL AND ${boundedText(t.revokeReason, JOB_SANITIZED_TEXT_MAX)})`,
    ),
  ],
)

/**
 * The action log: one row per queue mutation or click (r5 Task 6.3 writes it in
 * the same transaction as the mutation, so an audit failure rolls the mutation
 * back). APPEND-ONLY IS NOT ENFORCED BY THIS SCHEMA — see the file header for
 * exactly what does and does not exist in this PR, and the Task 1.3 obligation.
 *
 * What the CHECKs do enforce, per kind:
 *   - TRIAGE_SUBSCRIBED / _UNSUBSCRIBED target a subscription and nothing else;
 *     every other kind targets an opportunity and no subscription (r5 lists
 *     "opportunity" for the log, but a standing subscription has none);
 *   - OPENED / DEAD_LINK / SPAM reference the clicked source record (r5 Task
 *     6.3: reports reference the clicked source copy); on other opportunity
 *     kinds the source record is optional;
 *   - TRIAGE_* name the team concerned (`subject_team_id`), REASSIGNED names the
 *     new assignee (`subject_user_id`), and no other kind carries either;
 *   - telemetry carries no version; every other kind moves it forward
 *     (`before_version` 0 = the row did not exist yet).
 * The idempotency key is UNIQUE PER ACTOR, not globally: a global key would let
 * one actor's 23505 reveal that someone else used a key. OPENED is idempotent
 * click telemetry per actor + opportunity + source record (partial UNIQUE).
 * `reason` is bounded by CHECK; that it is SANITIZED (no upstream body, no
 * personal data) is the writer's obligation — a CHECK cannot see it.
 *
 * PHASE-6 OBLIGATIONS: `actor_id` is the authenticated actor, and the scope is
 * the one the request was authorized in; ADMIN audit reads may span teams, HR
 * reads filter on `team_id` / `subject_team_id`.
 */
export const jobQueueActions = pgTable(
  'job_queue_actions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    kind: jobQueueActionKindEnum('kind').notNull(),
    opportunityId: uuid('opportunity_id'),
    sourceRecordId: uuid('source_record_id'),
    subscriptionId: uuid('subscription_id'),
    actorId: uuid('actor_id').notNull(),
    /** The scope the actor acted in. */
    scopeKind: jobQueueScopeKindEnum('scope_kind').notNull(),
    teamId: uuid('team_id'),
    subjectTeamId: uuid('subject_team_id'),
    subjectUserId: uuid('subject_user_id'),
    beforeVersion: integer('before_version'),
    afterVersion: integer('after_version'),
    idempotencyKey: text('idempotency_key').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('uq_job_queue_actions_actor_idempotency').on(t.actorId, t.idempotencyKey),
    uniqueIndex('uq_job_queue_actions_opened_once')
      .on(t.actorId, t.opportunityId, t.sourceRecordId)
      .where(sql`${t.kind} = 'OPENED'`),
    // Every parent is RESTRICT: no delete anywhere erases audit through a cascade.
    foreignKey({
      name: 'fk_job_queue_actions_opportunity',
      columns: [t.opportunityId],
      foreignColumns: [jobOpportunities.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_queue_actions_source_record',
      columns: [t.sourceRecordId],
      foreignColumns: [jobSourceRecords.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_queue_actions_subscription',
      columns: [t.subscriptionId],
      foreignColumns: [jobTeamTriageSubscriptions.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_queue_actions_actor',
      columns: [t.actorId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_queue_actions_team',
      columns: [t.teamId],
      foreignColumns: [teams.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_queue_actions_subject_team',
      columns: [t.subjectTeamId],
      foreignColumns: [teams.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'fk_job_queue_actions_subject_user',
      columns: [t.subjectUserId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    index('idx_job_queue_actions_opportunity').on(t.opportunityId, t.createdAt),
    index('idx_job_queue_actions_team').on(t.teamId, t.createdAt),
    index('idx_job_queue_actions_subject_team').on(t.subjectTeamId, t.createdAt),
    // The RESTRICT probes on a parent delete need an index on the child column.
    index('idx_job_queue_actions_source_record').on(t.sourceRecordId),
    index('idx_job_queue_actions_subscription').on(t.subscriptionId),
    check('ck_job_queue_actions_scope_shape', scopeShape(t.scopeKind, t.teamId)),
    check(
      'ck_job_queue_actions_target',
      sql`(${t.kind} IN ${SUBSCRIPTION_KINDS} AND ${t.opportunityId} IS NULL AND ${t.subscriptionId} IS NOT NULL AND ${t.sourceRecordId} IS NULL)
          OR (${t.kind} NOT IN ${SUBSCRIPTION_KINDS} AND ${t.opportunityId} IS NOT NULL AND ${t.subscriptionId} IS NULL)`,
    ),
    // An implication, not a pair: the source record is optional elsewhere (r5).
    check(
      'ck_job_queue_actions_clicked_source',
      sql`${t.kind} NOT IN ${TELEMETRY_KINDS} OR ${t.sourceRecordId} IS NOT NULL`,
    ),
    check(
      'ck_job_queue_actions_subject_team',
      sql`(${t.kind} IN ${TRIAGE_KINDS} AND ${t.subjectTeamId} IS NOT NULL)
          OR (${t.kind} NOT IN ${TRIAGE_KINDS} AND ${t.subjectTeamId} IS NULL)`,
    ),
    check(
      'ck_job_queue_actions_subject_user',
      sql`(${t.kind} = 'REASSIGNED' AND ${t.subjectUserId} IS NOT NULL)
          OR (${t.kind} <> 'REASSIGNED' AND ${t.subjectUserId} IS NULL)`,
    ),
    check(
      'ck_job_queue_actions_versions',
      sql`(${t.kind} IN ${TELEMETRY_KINDS} AND ${t.beforeVersion} IS NULL AND ${t.afterVersion} IS NULL)
          OR (${t.kind} NOT IN ${TELEMETRY_KINDS} AND ${t.beforeVersion} >= 0 AND ${t.afterVersion} > ${t.beforeVersion})`,
    ),
    check(
      'ck_job_queue_actions_idempotency_key_bounded',
      boundedText(t.idempotencyKey, JOB_HANDLE_MAX),
    ),
    check(
      'ck_job_queue_actions_reason_bounded',
      boundedTextOrNull(t.reason, JOB_SANITIZED_TEXT_MAX),
    ),
  ],
)

/**
 * A published snapshot of one scope's queue order (r5 Task 6.2: the first list
 * request selects the current generation for its scope; additions and moves
 * only on refresh). Lifecycle BUILDING -> PUBLISHED -> INVALIDATED; a BUILDING
 * one may be abandoned straight to INVALIDATED.
 *
 * ATOMIC PUBLISH IS ENFORCED: two partial UNIQUE indexes allow at most ONE
 * PUBLISHED generation per team and one for STUDIO (two indexes because a
 * single one over `(scope_kind, team_id)` would treat every STUDIO NULL as
 * distinct). The publisher invalidates the current generation and publishes
 * the new one IN ONE TRANSACTION; two publishers racing for one scope both
 * reach the index and exactly one commits.
 *
 * NOT ENFORCED (publisher obligations, Phase 6): entries are inserted only
 * while the generation is BUILDING and never after it is PUBLISHED; "invalidate
 * before purge" — the purge deletes only `status = 'INVALIDATED'` rows
 * (`idx_job_queue_generations_status_expiry` serves that scan). A FK or CHECK
 * cannot refuse the DELETE of a PUBLISHED row; the Task 1.3 trigger on entries
 * (file header) does not cover the generation row itself, so a Task 1.3
 * `BEFORE DELETE` trigger refusing `status <> 'INVALIDATED'` is part of the
 * same obligation.
 *
 * PHASE-6 OBLIGATION: a STUDIO generation is served only to an ADMIN, a TEAM
 * generation only within that team's authorized scope; cached projections never
 * replace the current authorization check.
 */
export const jobQueueGenerations = pgTable(
  'job_queue_generations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    scopeKind: jobQueueScopeKindEnum('scope_kind').notNull(),
    teamId: uuid('team_id'),
    /** Opaque digest of the policy inputs (membership / exclusion versions); a cursor is checked against it. */
    policySignature: text('policy_signature').notNull(),
    ruleVersion: text('rule_version').notNull(),
    status: jobQueueGenerationStatusEnum('status').notNull().default('BUILDING'),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('uq_job_queue_generations_published_team')
      .on(t.teamId)
      .where(sql`${t.status} = 'PUBLISHED' AND ${t.scopeKind} = 'TEAM'`),
    uniqueIndex('uq_job_queue_generations_published_studio')
      .on(t.scopeKind)
      .where(sql`${t.status} = 'PUBLISHED' AND ${t.scopeKind} = 'STUDIO'`),
    index('idx_job_queue_generations_status_expiry').on(t.status, t.expiresAt),
    // CASCADE: a derived projection of that team's view.
    foreignKey({
      name: 'fk_job_queue_generations_team',
      columns: [t.teamId],
      foreignColumns: [teams.id],
    }).onDelete('cascade'),
    check('ck_job_queue_generations_scope_shape', scopeShape(t.scopeKind, t.teamId)),
    // One branch per status; INVALIDATED keeps `published_at` whatever it was.
    check(
      'ck_job_queue_generations_status_instants',
      sql`(${t.status} = 'BUILDING' AND ${t.publishedAt} IS NULL AND ${t.invalidatedAt} IS NULL)
          OR (${t.status} = 'PUBLISHED' AND ${t.publishedAt} IS NOT NULL AND ${t.invalidatedAt} IS NULL)
          OR (${t.status} = 'INVALIDATED' AND ${t.invalidatedAt} IS NOT NULL)`,
    ),
    check(
      'ck_job_queue_generations_expiry_after_evaluation',
      sql`${t.expiresAt} > ${t.evaluatedAt}`,
    ),
    check(
      'ck_job_queue_generations_policy_signature_bounded',
      boundedText(t.policySignature, JOB_HANDLE_MAX),
    ),
    check(
      'ck_job_queue_generations_rule_version_bounded',
      boundedText(t.ruleVersion, JOB_SHORT_TEXT_MAX),
    ),
  ],
)

/**
 * One ranked opportunity inside a generation, keyed (generation, opportunity)
 * with INTEGER score and order keys (r5). The order is
 * `(rank_score, first_seen_at, opportunity_id)` desc (Task 6.2), materialized
 * as a dense `order_key` that a cursor pages on; UNIQUE(generation, order_key)
 * keeps two entries from sharing a position.
 *
 * IMMUTABILITY IS NOT ENFORCED BY THIS SCHEMA — see the file header (Task 1.3
 * trigger + grant). Both parents CASCADE: purging a generation removes its
 * entries, and deleting an opportunity removes it from every generation, which
 * r5 Task 6.2 allows ("removals allowed, additions/moves only on refresh").
 */
export const jobQueueGenerationEntries = pgTable(
  'job_queue_generation_entries',
  {
    generationId: uuid('generation_id').notNull(),
    opportunityId: uuid('opportunity_id').notNull(),
    rankScore: integer('rank_score').notNull(),
    orderKey: integer('order_key').notNull(),
    /** The tie-breaker, snapshotted so the order cannot move under a cursor. */
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    /** The input version the entry was evaluated against. */
    opportunityRevision: integer('opportunity_revision').notNull(),
  },
  (t) => [
    primaryKey({
      name: 'pk_job_queue_generation_entries',
      columns: [t.generationId, t.opportunityId],
    }),
    unique('uq_job_queue_generation_entries_order').on(t.generationId, t.orderKey),
    foreignKey({
      name: 'fk_job_queue_generation_entries_generation',
      columns: [t.generationId],
      foreignColumns: [jobQueueGenerations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_job_queue_generation_entries_opportunity',
      columns: [t.opportunityId],
      foreignColumns: [jobOpportunities.id],
    }).onDelete('cascade'),
    // The PK leads with generation_id; the opportunity cascade probe and the
    // "which generations contain this opportunity" invalidation need their own.
    index('idx_job_queue_generation_entries_opportunity').on(t.opportunityId),
    check('ck_job_queue_generation_entries_order_key_nonneg', sql`${t.orderKey} >= 0`),
    check('ck_job_queue_generation_entries_revision_positive', sql`${t.opportunityRevision} > 0`),
  ],
)

export type JobQueueAssignmentRow = typeof jobQueueAssignments.$inferSelect
export type NewJobQueueAssignmentRow = typeof jobQueueAssignments.$inferInsert
export type JobQueueDismissalRow = typeof jobQueueDismissals.$inferSelect
export type NewJobQueueDismissalRow = typeof jobQueueDismissals.$inferInsert
export type JobTeamTriageSubscriptionRow = typeof jobTeamTriageSubscriptions.$inferSelect
export type NewJobTeamTriageSubscriptionRow = typeof jobTeamTriageSubscriptions.$inferInsert
export type JobQueueActionRow = typeof jobQueueActions.$inferSelect
export type NewJobQueueActionRow = typeof jobQueueActions.$inferInsert
export type JobQueueGenerationRow = typeof jobQueueGenerations.$inferSelect
export type NewJobQueueGenerationRow = typeof jobQueueGenerations.$inferInsert
export type JobQueueGenerationEntryRow = typeof jobQueueGenerationEntries.$inferSelect
export type NewJobQueueGenerationEntryRow = typeof jobQueueGenerationEntries.$inferInsert
