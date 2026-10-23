import type { SQL } from 'drizzle-orm'
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  jobQueueActionKindSchema,
  jobQueueAssignmentStateSchema,
  jobQueueGenerationStatusSchema,
  jobQueueScopeKindSchema,
  jobSignalKindSchema,
} from '@crm/shared'
import {
  jobOpportunities,
  jobQueueActionKindEnum,
  jobQueueActions,
  jobQueueAssignments,
  jobQueueAssignmentStateEnum,
  jobQueueDismissals,
  jobQueueGenerationEntries,
  jobQueueGenerations,
  jobQueueGenerationStatusEnum,
  jobQueueScopeKindEnum,
  jobSignalKindEnum,
  jobSourceRecords,
  jobSourceTypeEnum,
  jobTeamTriageSubscriptions,
  teams,
  users,
} from './schema'

/**
 * r5 Task 1.2 (part 3) — the QUEUE half of the store, asserted against the
 * Drizzle metadata (the same declarations `db:push` applies). Real-catalog proof
 * is `job-queue-store.integration.spec.ts` against a scratch database.
 *
 * The unit twin exists because the mutation gate runs unit specs only: a mutated
 * column name, default or predicate has to die somewhere the gate can see.
 * (`job-queue-schema.spec.ts` is the LEGACY Phase-1 queue on `job_postings`.)
 */

const render = (s: unknown) => new PgDialect().sqlToQuery(s as SQL).sql

type Table = Parameters<typeof getTableConfig>[0]

const names = (t: Table) => getTableConfig(t).columns.map((c) => c.name)
const col = (t: Table, n: string) => {
  const c = getTableConfig(t).columns.find((x) => x.name === n)
  if (!c) throw new Error(`no column ${n}`)
  return c
}
const checkNames = (t: Table) => getTableConfig(t).checks.map((c) => c.name)
const checkSql = (t: Table, n: string) => {
  const c = getTableConfig(t).checks.find((x) => x.name === n)
  if (!c) throw new Error(`no check ${n}`)
  // Whitespace-normalized and unqualified, so an assertion reads like the DDL.
  return render(c.value)
    .replace(/\s+/g, ' ')
    .replaceAll(`"${getTableConfig(t).name}".`, '')
}
const uniqueOf = (t: Table, n: string) => {
  const u = getTableConfig(t).uniqueConstraints.find((x) => x.name === n)
  if (!u) throw new Error(`no unique ${n}`)
  return u
}
const uniqueCols = (t: Table, n: string) => uniqueOf(t, n).columns.map((c) => c.name)
const idx = (t: Table, n: string) => {
  const i = getTableConfig(t).indexes.find((x) => x.config.name === n)
  if (!i) throw new Error(`no index ${n}`)
  return i
}
const idxCols = (t: Table, n: string) =>
  idx(t, n).config.columns.map((c) => ('name' in c ? (c as { name: string }).name : render(c)))
const fkByName = (t: Table, n: string) => {
  const f = getTableConfig(t).foreignKeys.find((x) => x.getName() === n)
  if (!f) throw new Error(`no fk ${n}`)
  return f
}
const fkShape = (t: Table, n: string) => {
  const f = fkByName(t, n)
  const r = f.reference()
  return {
    columns: r.columns.map((c) => c.name),
    table: r.foreignTable,
    foreign: r.foreignColumns.map((c) => c.name),
    onDelete: f.onDelete,
  }
}

/**
 * The per-kind scope rule every scoped table carries, in two explicit branches.
 * Pinned as the WHOLE expression (CR-L-1): a `toContain` per branch would let a
 * widening third `OR` branch through unseen.
 */
function expectScopeShape(t: Table, name: string) {
  expect(checkSql(t, name)).toBe(
    `("scope_kind" = 'TEAM' AND "team_id" IS NOT NULL) OR ("scope_kind" = 'STUDIO' AND "team_id" IS NULL)`,
  )
}

describe('enum parity (pg <-> shared zod)', () => {
  it.each([
    [jobQueueScopeKindEnum, jobQueueScopeKindSchema, 'job_queue_scope_kind'],
    [jobQueueAssignmentStateEnum, jobQueueAssignmentStateSchema, 'job_queue_assignment_state'],
    [jobQueueActionKindEnum, jobQueueActionKindSchema, 'job_queue_action_kind'],
    [jobQueueGenerationStatusEnum, jobQueueGenerationStatusSchema, 'job_queue_generation_status'],
  ])('%# mirrors the shared enum member for member, in order', (pgEnum, zod, pgName) => {
    expect([...pgEnum.enumValues]).toEqual([...zod.options])
    expect(pgEnum.enumName).toBe(pgName)
  })

  it('carries all fourteen action kinds and leaves the legacy signal enum alone', () => {
    // Thirteen queue kinds plus REASON_REDACTED (r5 Task 1.4b-ii), which is an
    // evidence row about this log rather than a fourteenth queue mutation.
    expect(jobQueueActionKindEnum.enumValues).toHaveLength(14)
    expect(jobQueueActionKindEnum.enumValues.at(-1)).toBe('REASON_REDACTED')
    expect([...jobSignalKindEnum.enumValues]).toEqual([...jobSignalKindSchema.options])
    expect(jobSignalKindEnum.enumName).toBe('job_posting_signal_kind')
  })
})

describe('table names', () => {
  it.each([
    [jobQueueAssignments, 'job_queue_assignments'],
    [jobQueueDismissals, 'job_queue_dismissals'],
    [jobTeamTriageSubscriptions, 'job_team_triage_subscriptions'],
    [jobQueueActions, 'job_queue_actions'],
    [jobQueueGenerations, 'job_queue_generations'],
    [jobQueueGenerationEntries, 'job_queue_generation_entries'],
  ])('%#', (t, name) => {
    expect(getTableConfig(t).name).toBe(name)
  })
})

// ---------------------------------------------------------------------------
// job_queue_assignments (AC1)
// ---------------------------------------------------------------------------

describe('job_queue_assignments (AC1)', () => {
  const t = jobQueueAssignments

  it('has exactly the r5 fields', () => {
    expect(names(t)).toEqual([
      'id',
      'opportunity_id',
      'state',
      'scope_kind',
      'team_id',
      'assignee_id',
      'taken_at',
      'version',
      'released_at',
      'released_by',
      'release_reason',
      'reassigned_at',
      'reassigned_by',
      'reassigned_from_id',
      'created_at',
      'updated_at',
    ])
  })

  it('defaults a new claim to TAKEN at version 1, now', () => {
    expect(col(t, 'state').default).toBe('TAKEN')
    expect(col(t, 'state').notNull).toBe(true)
    expect(col(t, 'version').default).toBe(1)
    expect(col(t, 'version').notNull).toBe(true)
    expect(col(t, 'version').getSQLType()).toBe('integer')
    expect(col(t, 'taken_at').notNull).toBe(true)
    expect(col(t, 'taken_at').hasDefault).toBe(true)
    for (const c of ['assignee_id', 'scope_kind', 'opportunity_id'])
      expect(col(t, c).notNull).toBe(true)
    for (const c of [
      'team_id',
      'released_at',
      'released_by',
      'release_reason',
      'reassigned_at',
      'reassigned_by',
      'reassigned_from_id',
    ])
      expect(col(t, c).notNull).toBe(false)
  })

  it('is a studio-wide claim: UNIQUE(opportunity) alone', () => {
    expect(uniqueCols(t, 'uq_job_queue_assignments_opportunity')).toEqual(['opportunity_id'])
  })

  it('references the opportunity (cascade), the team and every actor (restrict)', () => {
    expect(fkShape(t, 'fk_job_queue_assignments_opportunity')).toEqual({
      columns: ['opportunity_id'],
      table: jobOpportunities,
      foreign: ['id'],
      onDelete: 'cascade',
    })
    expect(fkShape(t, 'fk_job_queue_assignments_team')).toEqual({
      columns: ['team_id'],
      table: teams,
      foreign: ['id'],
      onDelete: 'restrict',
    })
    for (const [fk, c] of [
      ['fk_job_queue_assignments_assignee', 'assignee_id'],
      ['fk_job_queue_assignments_released_by', 'released_by'],
      ['fk_job_queue_assignments_reassigned_by', 'reassigned_by'],
      ['fk_job_queue_assignments_reassigned_from', 'reassigned_from_id'],
    ])
      expect(fkShape(t, fk)).toEqual({
        columns: [c],
        table: users,
        foreign: ['id'],
        onDelete: 'restrict',
      })
  })

  it('indexes the claimer and the claimer team for scoped reads', () => {
    expect(idxCols(t, 'idx_job_queue_assignments_assignee')).toEqual(['assignee_id', 'state'])
    expect(idxCols(t, 'idx_job_queue_assignments_team')).toEqual(['team_id', 'state'])
  })

  it('declares every guard', () => {
    expect(checkNames(t)).toEqual([
      'ck_job_queue_assignments_scope_shape',
      'ck_job_queue_assignments_version_positive',
      'ck_job_queue_assignments_release_pair',
      'ck_job_queue_assignments_release_reason_bounded',
      'ck_job_queue_assignments_reassign_triple',
    ])
    expectScopeShape(t, 'ck_job_queue_assignments_scope_shape')
    expect(checkSql(t, 'ck_job_queue_assignments_version_positive')).toBe('"version" > 0')
  })

  it('pairs the release in two explicit branches (no boolean equality)', () => {
    expect(checkSql(t, 'ck_job_queue_assignments_release_pair')).toBe(
      `("state" = 'TAKEN' AND "released_at" IS NULL AND "released_by" IS NULL AND "release_reason" IS NULL) OR ("state" = 'RELEASED' AND "released_at" IS NOT NULL AND "released_by" IS NOT NULL)`,
    )
  })

  it('bounds the release reason and pairs the reassignment triple', () => {
    expect(checkSql(t, 'ck_job_queue_assignments_release_reason_bounded')).toBe(
      `"release_reason" IS NULL OR ("release_reason" ~ '[^[:space:]]' AND length("release_reason") <= 500)`,
    )
    expect(checkSql(t, 'ck_job_queue_assignments_reassign_triple')).toBe(
      `("reassigned_at" IS NULL AND "reassigned_by" IS NULL AND "reassigned_from_id" IS NULL) OR ("reassigned_at" IS NOT NULL AND "reassigned_by" IS NOT NULL AND "reassigned_from_id" IS NOT NULL)`,
    )
  })
})

// ---------------------------------------------------------------------------
// job_queue_dismissals (AC2)
// ---------------------------------------------------------------------------

describe('job_queue_dismissals (AC2)', () => {
  const t = jobQueueDismissals

  it('has exactly the r5 fields', () => {
    expect(names(t)).toEqual([
      'id',
      'opportunity_id',
      'scope_kind',
      'team_id',
      'reason',
      'dismissed_by',
      'dismissed_at',
      'version',
      'undone_at',
      'undone_by',
      'created_at',
      'updated_at',
    ])
    expect(col(t, 'version').default).toBe(1)
    expect(col(t, 'dismissed_at').hasDefault).toBe(true)
    for (const c of ['scope_kind', 'reason', 'dismissed_by', 'dismissed_at', 'version'])
      expect(col(t, c).notNull).toBe(true)
    for (const c of ['team_id', 'undone_at', 'undone_by']) expect(col(t, c).notNull).toBe(false)
  })

  it('is UNIQUE(opportunity, scope kind, scope team) with NULLS NOT DISTINCT', () => {
    // Without NULLS NOT DISTINCT two STUDIO rows (team NULL) would both pass.
    const u = uniqueOf(t, 'uq_job_queue_dismissals_opportunity_scope')
    expect(u.columns.map((c) => c.name)).toEqual(['opportunity_id', 'scope_kind', 'team_id'])
    expect(u.nullsNotDistinct).toBe(true)
  })

  it('references opportunity and team (cascade) and the actors (restrict)', () => {
    expect(fkShape(t, 'fk_job_queue_dismissals_opportunity')).toEqual({
      columns: ['opportunity_id'],
      table: jobOpportunities,
      foreign: ['id'],
      onDelete: 'cascade',
    })
    expect(fkShape(t, 'fk_job_queue_dismissals_team')).toEqual({
      columns: ['team_id'],
      table: teams,
      foreign: ['id'],
      onDelete: 'cascade',
    })
    for (const [fk, c] of [
      ['fk_job_queue_dismissals_dismissed_by', 'dismissed_by'],
      ['fk_job_queue_dismissals_undone_by', 'undone_by'],
    ])
      expect(fkShape(t, fk)).toEqual({
        columns: [c],
        table: users,
        foreign: ['id'],
        onDelete: 'restrict',
      })
  })

  it('indexes the scope for a team-scoped read', () => {
    expect(idxCols(t, 'idx_job_queue_dismissals_team')).toEqual(['team_id'])
  })

  it('declares the scope shape, the bounds and the undo pair', () => {
    expect(checkNames(t)).toEqual([
      'ck_job_queue_dismissals_scope_shape',
      'ck_job_queue_dismissals_version_positive',
      'ck_job_queue_dismissals_reason_bounded',
      'ck_job_queue_dismissals_undo_pair',
    ])
    expectScopeShape(t, 'ck_job_queue_dismissals_scope_shape')
    expect(checkSql(t, 'ck_job_queue_dismissals_version_positive')).toBe('"version" > 0')
    expect(checkSql(t, 'ck_job_queue_dismissals_reason_bounded')).toBe(
      `"reason" ~ '[^[:space:]]' AND length("reason") <= 500`,
    )
    expect(checkSql(t, 'ck_job_queue_dismissals_undo_pair')).toBe(
      `("undone_at" IS NULL AND "undone_by" IS NULL) OR ("undone_at" IS NOT NULL AND "undone_by" IS NOT NULL)`,
    )
  })
})

// ---------------------------------------------------------------------------
// job_team_triage_subscriptions (AC3)
// ---------------------------------------------------------------------------

describe('job_team_triage_subscriptions (AC3)', () => {
  const t = jobTeamTriageSubscriptions

  it('has a column for every field of the #1011 contracts, plus the audit trail', () => {
    expect(names(t)).toEqual([
      'id',
      'team_id',
      'role_family',
      'source_types',
      'policy_version',
      'subscription_version',
      'actor_id',
      'reason',
      'expires_at',
      'revoked_at',
      'revoked_by',
      'revoke_reason',
      'created_at',
      'updated_at',
    ])
    for (const c of [
      'team_id',
      'role_family',
      'source_types',
      'policy_version',
      'subscription_version',
      'actor_id',
      'reason',
      'expires_at',
    ])
      expect(col(t, c).notNull).toBe(true)
    for (const c of ['revoked_at', 'revoked_by', 'revoke_reason'])
      expect(col(t, c).notNull).toBe(false)
    expect(col(t, 'subscription_version').default).toBe(1)
    expect(col(t, 'policy_version').getSQLType()).toBe('integer')
  })

  it('stores the source filter as a job_source_type[] defaulting to every source', () => {
    const c = col(t, 'source_types')
    expect(c.getSQLType()).toBe('job_source_type[]')
    expect(render(c.default)).toBe(`'{}'::job_source_type[]`)
    expect(jobSourceTypeEnum.enumName).toBe('job_source_type')
  })

  it('references the team (cascade, like a triage grant) and the actors (restrict)', () => {
    expect(fkShape(t, 'fk_job_team_triage_subscriptions_team')).toEqual({
      columns: ['team_id'],
      table: teams,
      foreign: ['id'],
      onDelete: 'cascade',
    })
    for (const [fk, c] of [
      ['fk_job_team_triage_subscriptions_actor', 'actor_id'],
      ['fk_job_team_triage_subscriptions_revoked_by', 'revoked_by'],
    ])
      expect(fkShape(t, fk)).toEqual({
        columns: [c],
        table: users,
        foreign: ['id'],
        onDelete: 'restrict',
      })
    expect(idxCols(t, 'idx_job_team_triage_subscriptions_team')).toEqual(['team_id', 'expires_at'])
  })

  it('declares the bounds the contracts carry, and the revoke triple', () => {
    expect(checkNames(t)).toEqual([
      'ck_job_team_triage_subscriptions_role_family_bounded',
      'ck_job_team_triage_subscriptions_source_types_bounded',
      'ck_job_team_triage_subscriptions_source_types_shape',
      'ck_job_team_triage_subscriptions_policy_version_nonneg',
      'ck_job_team_triage_subscriptions_version_positive',
      'ck_job_team_triage_subscriptions_reason_bounded',
      'ck_job_team_triage_subscriptions_revoke_triple',
    ])
    expect(checkSql(t, 'ck_job_team_triage_subscriptions_role_family_bounded')).toBe(
      `"role_family" ~ '[^[:space:]]' AND length("role_family") <= 100`,
    )
    expect(checkSql(t, 'ck_job_team_triage_subscriptions_source_types_bounded')).toBe(
      `cardinality("source_types") <= cardinality(enum_range(NULL::job_source_type))`,
    )
    expect(checkSql(t, 'ck_job_team_triage_subscriptions_source_types_shape')).toBe(
      `CASE WHEN COALESCE(array_ndims("source_types"), 1) <> 1 THEN false ELSE array_position("source_types", NULL) IS NULL END`,
    )
    expect(checkSql(t, 'ck_job_team_triage_subscriptions_policy_version_nonneg')).toBe(
      '"policy_version" >= 0',
    )
    expect(checkSql(t, 'ck_job_team_triage_subscriptions_version_positive')).toBe(
      '"subscription_version" > 0',
    )
    expect(checkSql(t, 'ck_job_team_triage_subscriptions_reason_bounded')).toBe(
      `"reason" ~ '[^[:space:]]' AND length("reason") <= 500`,
    )
    expect(checkSql(t, 'ck_job_team_triage_subscriptions_revoke_triple')).toBe(
      `("revoked_at" IS NULL AND "revoked_by" IS NULL AND "revoke_reason" IS NULL) OR ("revoked_at" IS NOT NULL AND "revoked_by" IS NOT NULL AND "revoke_reason" IS NOT NULL AND "revoke_reason" ~ '[^[:space:]]' AND length("revoke_reason") <= 500)`,
    )
  })

  it('carries NO employer-verification column: that rule is a Phase-6 query predicate', () => {
    // The verification flag lives on job_opportunities; a CHECK on this row
    // cannot see another table. Pinned so nobody "adds" a flag that a CHECK
    // could not enforce and calls the rule done.
    expect(names(t).some((n) => n.includes('employer') || n.includes('verified'))).toBe(false)
    expect(names(jobOpportunities)).toContain('employer_verified')
  })
})

// ---------------------------------------------------------------------------
// job_queue_actions (AC4)
// ---------------------------------------------------------------------------

describe('job_queue_actions (AC4)', () => {
  const t = jobQueueActions

  it('has exactly the r5 fields and NO updated_at (nothing in the schema invites an edit)', () => {
    expect(names(t)).toEqual([
      'id',
      'kind',
      'opportunity_id',
      'source_record_id',
      'subscription_id',
      'actor_id',
      'scope_kind',
      'team_id',
      'subject_team_id',
      'subject_user_id',
      // r5 Task 1.4b-ii: the row of THIS log a REASON_REDACTED evidence row is
      // about. Declared in the `subject_*` family; `db:push` appends it
      // physically, which this list does not read.
      'subject_action_id',
      'before_version',
      'after_version',
      'idempotency_key',
      'reason',
      'created_at',
    ])
    for (const c of ['kind', 'actor_id', 'scope_kind', 'idempotency_key', 'created_at'])
      expect(col(t, c).notNull).toBe(true)
    for (const c of [
      'opportunity_id',
      'source_record_id',
      'subscription_id',
      'team_id',
      'subject_team_id',
      'subject_user_id',
      'subject_action_id',
      'before_version',
      'after_version',
      'reason',
    ])
      expect(col(t, c).notNull).toBe(false)
    expect(col(t, 'created_at').hasDefault).toBe(true)
  })

  it('never cascades: every parent reference is RESTRICT, so no delete erases audit', () => {
    const fks = getTableConfig(t).foreignKeys
    // STILL seven with `subject_action_id` added: it carries NO foreign key, and
    // that is load-bearing rather than an omission. A self-FK of ANY mode breaks
    // the end-of-retention purge, which deletes a subject row up to two years
    // before its evidence row falls due (see the schema header). If someone
    // "fixes" the missing FK, this count goes to 8 and this test says so.
    expect(fks).toHaveLength(7)
    expect(fks.some((f) => f.reference().columns.some((c) => c.name === 'subject_action_id'))).toBe(
      false,
    )
    for (const f of fks) expect(f.onDelete).toBe('restrict')
    expect(fkShape(t, 'fk_job_queue_actions_opportunity').table).toBe(jobOpportunities)
    expect(fkShape(t, 'fk_job_queue_actions_source_record').table).toBe(jobSourceRecords)
    expect(fkShape(t, 'fk_job_queue_actions_subscription').table).toBe(jobTeamTriageSubscriptions)
    expect(fkShape(t, 'fk_job_queue_actions_actor').columns).toEqual(['actor_id'])
    expect(fkShape(t, 'fk_job_queue_actions_actor').table).toBe(users)
    expect(fkShape(t, 'fk_job_queue_actions_team').table).toBe(teams)
    expect(fkShape(t, 'fk_job_queue_actions_subject_team').columns).toEqual(['subject_team_id'])
    expect(fkShape(t, 'fk_job_queue_actions_subject_team').table).toBe(teams)
    expect(fkShape(t, 'fk_job_queue_actions_subject_user').columns).toEqual(['subject_user_id'])
    expect(fkShape(t, 'fk_job_queue_actions_subject_user').table).toBe(users)
  })

  it('scopes the idempotency key to its actor', () => {
    expect(uniqueCols(t, 'uq_job_queue_actions_actor_idempotency')).toEqual([
      'actor_id',
      'idempotency_key',
    ])
  })

  it('records an OPENED click once per actor + opportunity + source record', () => {
    const i = idx(t, 'uq_job_queue_actions_opened_once')
    expect(i.config.unique).toBe(true)
    expect(idxCols(t, 'uq_job_queue_actions_opened_once')).toEqual([
      'actor_id',
      'opportunity_id',
      'source_record_id',
    ])
    expect(render(i.config.where)).toBe(`"job_queue_actions"."kind" = 'OPENED'`)
  })

  it('indexes the history reads and every RESTRICT probe that has no other index', () => {
    expect(idxCols(t, 'idx_job_queue_actions_opportunity')).toEqual([
      'opportunity_id',
      'created_at',
    ])
    expect(idxCols(t, 'idx_job_queue_actions_team')).toEqual(['team_id', 'created_at'])
    expect(idxCols(t, 'idx_job_queue_actions_subject_team')).toEqual([
      'subject_team_id',
      'created_at',
    ])
    expect(idxCols(t, 'idx_job_queue_actions_source_record')).toEqual(['source_record_id'])
    expect(idxCols(t, 'idx_job_queue_actions_subscription')).toEqual(['subscription_id'])
    // CR-L-6: deliberately unindexed, like every other user FK (users are
    // archived, never deleted, so the RESTRICT probe never fires).
    expect(
      getTableConfig(t).indexes.some((i) =>
        i.config.columns.some((c) => 'name' in c && c.name === 'subject_user_id'),
      ),
    ).toBe(false)
  })

  it('declares every guard', () => {
    expect(checkNames(t)).toEqual([
      'ck_job_queue_actions_scope_shape',
      'ck_job_queue_actions_target',
      'ck_job_queue_actions_clicked_source',
      'ck_job_queue_actions_subject_team',
      'ck_job_queue_actions_subject_user',
      'ck_job_queue_actions_versions',
      'ck_job_queue_actions_idempotency_key_bounded',
      'ck_job_queue_actions_reason_bounded',
      'ck_job_queue_actions_redaction_reason_null',
    ])
    expectScopeShape(t, 'ck_job_queue_actions_scope_shape')
  })

  it('targets a subscription, an opportunity, or a redacted action row, by kind, in three branches', () => {
    expect(checkSql(t, 'ck_job_queue_actions_target')).toBe(
      `("kind" IN ('TRIAGE_SUBSCRIBED', 'TRIAGE_UNSUBSCRIBED') AND "opportunity_id" IS NULL AND "subscription_id" IS NOT NULL AND "source_record_id" IS NULL AND "subject_action_id" IS NULL) OR ("kind" = 'REASON_REDACTED' AND "subject_action_id" IS NOT NULL AND "subject_action_id" <> "id" AND "opportunity_id" IS NULL AND "subscription_id" IS NULL AND "source_record_id" IS NULL) OR ("kind" NOT IN ('TRIAGE_SUBSCRIBED', 'TRIAGE_UNSUBSCRIBED') AND "kind" <> 'REASON_REDACTED' AND "opportunity_id" IS NOT NULL AND "subscription_id" IS NULL AND "subject_action_id" IS NULL)`,
    )
  })

  it('requires the clicked source record on telemetry', () => {
    expect(checkSql(t, 'ck_job_queue_actions_clicked_source')).toBe(
      `"kind" NOT IN ('OPENED', 'DEAD_LINK', 'SPAM') OR "source_record_id" IS NOT NULL`,
    )
  })

  // r5 Task 1.4b-ii. `TELEMETRY_KINDS` looked like the home for a versionless
  // kind, and it is NOT: the same set is read here, so a REASON_REDACTED row
  // inside it would be required to name a clicked source record it does not
  // have. The seam was checked rather than assumed, and this is the check.
  it('does not fold the redaction evidence row into the telemetry set', () => {
    expect(checkSql(t, 'ck_job_queue_actions_clicked_source')).not.toContain('REASON_REDACTED')
    expect(checkSql(t, 'ck_job_queue_actions_subject_team')).not.toContain('REASON_REDACTED')
    expect(checkSql(t, 'ck_job_queue_actions_subject_user')).not.toContain('REASON_REDACTED')
  })

  it('pairs the subject team with TRIAGE_* and the subject user with REASSIGNED', () => {
    expect(checkSql(t, 'ck_job_queue_actions_subject_team')).toBe(
      `("kind" IN ('TRIAGE_GRANTED', 'TRIAGE_REVOKED', 'TRIAGE_SUBSCRIBED', 'TRIAGE_UNSUBSCRIBED') AND "subject_team_id" IS NOT NULL) OR ("kind" NOT IN ('TRIAGE_GRANTED', 'TRIAGE_REVOKED', 'TRIAGE_SUBSCRIBED', 'TRIAGE_UNSUBSCRIBED') AND "subject_team_id" IS NULL)`,
    )
    expect(checkSql(t, 'ck_job_queue_actions_subject_user')).toBe(
      `("kind" = 'REASSIGNED' AND "subject_user_id" IS NOT NULL) OR ("kind" <> 'REASSIGNED' AND "subject_user_id" IS NULL)`,
    )
  })

  it('leaves telemetry unversioned and moves every mutation forward', () => {
    expect(checkSql(t, 'ck_job_queue_actions_versions')).toBe(
      `("kind" IN ('OPENED', 'DEAD_LINK', 'SPAM') AND "before_version" IS NULL AND "after_version" IS NULL) OR ("kind" = 'SUPPRESSED' AND "before_version" IS NULL AND "after_version" IS NULL) OR ("kind" = 'REASON_REDACTED' AND "before_version" IS NULL AND "after_version" IS NULL) OR ("kind" NOT IN ('OPENED', 'DEAD_LINK', 'SPAM') AND "kind" <> 'REASON_REDACTED' AND "before_version" IS NOT NULL AND "after_version" IS NOT NULL AND "before_version" >= 0 AND "after_version" > "before_version")`,
    )
  })

  it('bounds the key and the reason', () => {
    expect(checkSql(t, 'ck_job_queue_actions_idempotency_key_bounded')).toBe(
      `"idempotency_key" ~ '[^[:space:]]' AND length("idempotency_key") <= 200`,
    )
    expect(checkSql(t, 'ck_job_queue_actions_reason_bounded')).toBe(
      `"reason" IS NULL OR ("reason" ~ '[^[:space:]]' AND length("reason") <= 500)`,
    )
  })

  it('leaves the redaction evidence row without free text (SR-M-5 of PR #1075)', () => {
    // r5 Task 1.4b-iii. The evidence row's own `reason` would be one more unstructured
    // write site, and redacting it would need evidence of its own — a recursion. Every
    // other kind keeps its bounded, optional reason untouched by this constraint.
    expect(checkSql(t, 'ck_job_queue_actions_redaction_reason_null')).toBe(
      `"kind" <> 'REASON_REDACTED' OR "reason" IS NULL`,
    )
  })
})

// ---------------------------------------------------------------------------
// job_queue_generations + entries (AC5)
// ---------------------------------------------------------------------------

describe('job_queue_generations (AC5)', () => {
  const t = jobQueueGenerations

  it('has exactly the r5 fields', () => {
    expect(names(t)).toEqual([
      'id',
      'scope_kind',
      'team_id',
      'policy_signature',
      'rule_version',
      'status',
      'evaluated_at',
      'expires_at',
      'published_at',
      'invalidated_at',
      'created_at',
    ])
    expect(col(t, 'status').default).toBe('BUILDING')
    for (const c of [
      'scope_kind',
      'policy_signature',
      'rule_version',
      'status',
      'evaluated_at',
      'expires_at',
    ])
      expect(col(t, c).notNull).toBe(true)
    for (const c of ['team_id', 'published_at', 'invalidated_at'])
      expect(col(t, c).notNull).toBe(false)
  })

  it('publishes atomically: at most one PUBLISHED generation per team and one for STUDIO', () => {
    const team = idx(t, 'uq_job_queue_generations_published_team')
    expect(team.config.unique).toBe(true)
    expect(idxCols(t, 'uq_job_queue_generations_published_team')).toEqual(['team_id'])
    expect(render(team.config.where)).toBe(
      `"job_queue_generations"."status" = 'PUBLISHED' AND "job_queue_generations"."scope_kind" = 'TEAM'`,
    )
    const studio = idx(t, 'uq_job_queue_generations_published_studio')
    expect(studio.config.unique).toBe(true)
    expect(idxCols(t, 'uq_job_queue_generations_published_studio')).toEqual(['scope_kind'])
    expect(render(studio.config.where)).toBe(
      `"job_queue_generations"."status" = 'PUBLISHED' AND "job_queue_generations"."scope_kind" = 'STUDIO'`,
    )
    expect(idxCols(t, 'idx_job_queue_generations_status_expiry')).toEqual(['status', 'expires_at'])
    expect(idxCols(t, 'idx_job_queue_generations_team')).toEqual(['team_id'])
  })

  it('references the team with cascade (a derived projection)', () => {
    expect(fkShape(t, 'fk_job_queue_generations_team')).toEqual({
      columns: ['team_id'],
      table: teams,
      foreign: ['id'],
      onDelete: 'cascade',
    })
  })

  it('declares the scope shape, one branch per status, the expiry and the bounds', () => {
    expect(checkNames(t)).toEqual([
      'ck_job_queue_generations_scope_shape',
      'ck_job_queue_generations_status_instants',
      'ck_job_queue_generations_expiry_after_evaluation',
      'ck_job_queue_generations_policy_signature_bounded',
      'ck_job_queue_generations_rule_version_bounded',
    ])
    expectScopeShape(t, 'ck_job_queue_generations_scope_shape')
    expect(checkSql(t, 'ck_job_queue_generations_status_instants')).toBe(
      `("status" = 'BUILDING' AND "published_at" IS NULL AND "invalidated_at" IS NULL) OR ("status" = 'PUBLISHED' AND "published_at" IS NOT NULL AND "invalidated_at" IS NULL) OR ("status" = 'INVALIDATED' AND "invalidated_at" IS NOT NULL)`,
    )
    expect(checkSql(t, 'ck_job_queue_generations_expiry_after_evaluation')).toBe(
      '"expires_at" > "evaluated_at"',
    )
    expect(checkSql(t, 'ck_job_queue_generations_policy_signature_bounded')).toBe(
      `"policy_signature" ~ '[^[:space:]]' AND length("policy_signature") <= 200`,
    )
    expect(checkSql(t, 'ck_job_queue_generations_rule_version_bounded')).toBe(
      `"rule_version" ~ '[^[:space:]]' AND length("rule_version") <= 100`,
    )
  })
})

describe('job_queue_generation_entries (AC5)', () => {
  const t = jobQueueGenerationEntries

  it('is keyed (generation, opportunity) with integer score and order keys', () => {
    expect(names(t)).toEqual([
      'generation_id',
      'opportunity_id',
      'rank_score',
      'order_key',
      'first_seen_at',
      'opportunity_revision',
    ])
    const pk = getTableConfig(t).primaryKeys
    expect(pk).toHaveLength(1)
    expect(pk[0]?.getName()).toBe('pk_job_queue_generation_entries')
    expect(pk[0]?.columns.map((c) => c.name)).toEqual(['generation_id', 'opportunity_id'])
    for (const c of ['rank_score', 'order_key', 'opportunity_revision']) {
      expect(col(t, c).getSQLType()).toBe('integer')
      expect(col(t, c).notNull).toBe(true)
    }
    expect(col(t, 'first_seen_at').notNull).toBe(true)
  })

  it('orders a generation by a unique order key', () => {
    expect(uniqueCols(t, 'uq_job_queue_generation_entries_order')).toEqual([
      'generation_id',
      'order_key',
    ])
    expect(idxCols(t, 'idx_job_queue_generation_entries_opportunity')).toEqual(['opportunity_id'])
  })

  it('cascades from both parents (purge, and r5 "removals allowed")', () => {
    expect(fkShape(t, 'fk_job_queue_generation_entries_generation')).toEqual({
      columns: ['generation_id'],
      table: jobQueueGenerations,
      foreign: ['id'],
      onDelete: 'cascade',
    })
    expect(fkShape(t, 'fk_job_queue_generation_entries_opportunity')).toEqual({
      columns: ['opportunity_id'],
      table: jobOpportunities,
      foreign: ['id'],
      onDelete: 'cascade',
    })
  })

  it('declares the bounds', () => {
    expect(checkNames(t)).toEqual([
      'ck_job_queue_generation_entries_order_key_nonneg',
      'ck_job_queue_generation_entries_revision_positive',
    ])
    expect(checkSql(t, 'ck_job_queue_generation_entries_order_key_nonneg')).toBe('"order_key" >= 0')
    expect(checkSql(t, 'ck_job_queue_generation_entries_revision_positive')).toBe(
      '"opportunity_revision" > 0',
    )
  })
})
