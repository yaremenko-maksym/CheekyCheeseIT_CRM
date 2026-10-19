import { randomUUID } from 'node:crypto'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'
import {
  APPEND_ONLY_TRIGGERS_DDL,
  applyDeployDdlFile,
  dropRolesCreated,
  existingDeployRoles,
  installDeployRoles,
} from './__test-helpers__/deploy-ddl-preconditions'

/**
 * r5 Task 1.2 (part 3) — the QUEUE workflow store against the REAL Postgres
 * catalog. Every UNIQUE / partial UNIQUE / NULLS NOT DISTINCT / CHECK / FK is
 * proven by inserting and expecting the database itself to accept or reject,
 * by error code; nothing here reads Drizzle metadata (that is
 * `job-queue-store-schema.spec.ts`, the unit twin the mutation gate can see).
 *
 * Two blocks need two connections: the studio-wide claim and the atomic
 * publish are claims about what happens when two writers race.
 *
 * Two blocks that once pinned a GAP now assert the guarantee: Task 1.3b's
 * triggers make the action log append-only and the generation entries
 * immutable, and `beforeAll` APPLIES THAT DDL ITSELF — see
 * "PRECONDITIONS" below for why it has to.
 *
 * PRECONDITIONS, AND WHY THIS SUITE ESTABLISHES THEM RATHER THAN INHERITING
 * ------------------------------------------------------------------------
 * `db:push` produces the tables WITHOUT the triggers; only
 * `drizzle/manual/2026-10-18_job_queue_append_only_triggers.sql` creates them.
 * When the two GAP PIN tests below were inverted, this suite's precondition
 * silently changed from "whatever db:push makes" to "db:push plus that file",
 * and nothing here applied it — so the suite passed only when some OTHER spec
 * had already applied it to the shared database.
 *
 * It did not. Measured (PostgreSQL 16.15, 2026-10-19): an integration run sets
 * `fileParallelism: false`, so files run serially in vitest's default order —
 * by descending file SIZE. This file (~55 KB) is larger than
 * `job-queue-append-only.integration.spec.ts` (~48 KB), the spec that applies
 * the DDL, so it runs FIRST and no trigger exists yet. `pg_trigger` returned no
 * rows, the teardown's `ALTER TABLE … DISABLE TRIGGER` failed with `42704`, and
 * the two inverted tests saw an UPDATE go through. A suite whose result depends
 * on which sibling ran before it is not a gate, so this one now applies the DDL
 * in `beforeAll`. The file is idempotent by design (`CREATE OR REPLACE` plus
 * `DROP TRIGGER IF EXISTS` then `CREATE TRIGGER`), which is what makes applying
 * it here safe next to the sibling that also applies it.
 *
 * THE FIRST ATTEMPT AT THAT WAS STILL INHERITING, and the correction is worth
 * recording because the first version LOOKED self-sufficient. Applying the 1.3b
 * DDL needs TWO roles — `crm_retention_owner` owns the R-B functions, `crm_app`
 * is the only grantee of EXECUTE on them — and the first version created only
 * the first, by hand. Run alone on a fresh cluster this suite therefore still
 * failed in `beforeAll`, with `required role(s) absent: crm_app`; it passed in
 * CI only because `db-privileges.integration.spec.ts` is larger still, runs
 * before it, and applies the real roles file. It also left the one role it did
 * create behind in the cluster. Both roles now come from the shipped roles file
 * via `__test-helpers__/deploy-ddl-preconditions.ts`, and `afterAll` drops
 * exactly the ones this run created — so the suite is a no-op on a cluster that
 * already has them and leaves no residue on one that does not. The measurement
 * that matters here is not "CI is green" but "`vitest run <this file>` is green
 * on a cluster with no `crm_*` role at all".
 *
 * CLEANUP: every row is reachable from this suite's TAG (users by email, teams
 * by name, opportunities by title, records by namespace, keys / reasons /
 * signatures by prefix). `afterAll` then asserts that all six new tables are
 * EMPTY — not merely free of tagged rows — so a fixture that escaped the tag
 * fails here instead of in somebody else's suite (lesson 3 of #1015).
 *
 * Run against a scratch DB (NEVER the live crm_db), after `db:push`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_scratch_queue1016 \
 *     pnpm --filter @crm/api test -- job-queue-store.integration
 */

const TAG = `it1017-${randomUUID().slice(0, 8)}`

let pool: Pool

const q = (text: string, params: unknown[] = []) => pool.query(text, params)

/** Run a statement that MUST be rejected; return the Postgres error code + constraint. */
async function rejected(text: string, params: unknown[] = []) {
  try {
    await pool.query(text, params)
  } catch (e) {
    const err = e as { code?: string; constraint?: string }
    return { code: err.code, constraint: err.constraint }
  }
  throw new Error(`expected the database to reject: ${text}`)
}

/** Same, on a specific connection (used by the two concurrency blocks). */
async function rejectedOn(client: PoolClient, text: string, params: unknown[] = []) {
  try {
    await client.query(text, params)
  } catch (e) {
    const err = e as { code?: string; constraint?: string }
    return { code: err.code, constraint: err.constraint }
  }
  throw new Error(`expected the database to reject: ${text}`)
}

const CHECK_VIOLATION = '23514'
const UNIQUE_VIOLATION = '23505'
const FK_VIOLATION = '23503'
const INVALID_TEXT = '22P02'
const OUT_OF_RANGE = '22003'
const RESTRICT_VIOLATION = '23001'

let seq = 0
const nextTag = () => {
  seq += 1
  return `${TAG}-${seq}`
}

/** The append-only guards a teardown must lift on the action log, then restore. */
const GUARD_TRIGGERS = [
  { table: 'job_queue_actions', trigger: 'trg_job_queue_actions_append_only' },
  { table: 'job_queue_actions', trigger: 'trg_job_queue_actions_no_truncate' },
] as const

/** Deploy roles this suite created and must therefore drop again. See `afterAll`. */
let rolesCreatedHere: readonly string[] = []

/**
 * Establish this suite's preconditions: the deploy roles exist, and the Task 1.3b guard
 * triggers exist and are `ENABLE ALWAYS`. See the header for why the suite establishes them
 * instead of hoping a sibling did.
 *
 * The 1.3b DDL refuses to apply unless BOTH `crm_retention_owner` (it owns the two R-B
 * functions) and `crm_app` (the only grantee of EXECUTE on them) exist. An earlier version
 * of this function created only the first, by hand — so run alone on a fresh cluster the
 * suite still died in `beforeAll` with `required role(s) absent: crm_app`, and it left the
 * role it had created behind in the cluster. Both roles now come from the SHIPPED roles
 * file, so their attributes have one source of truth and cannot drift from it, and
 * `afterAll` drops exactly the ones this run created.
 */
async function installAppendOnlyGuards(): Promise<void> {
  rolesCreatedHere = await installDeployRoles(pool)
  await applyDeployDdlFile(pool, APPEND_ONLY_TRIGGERS_DDL)
}

const NEW_TABLES = [
  'job_queue_actions',
  'job_queue_generation_entries',
  'job_queue_generations',
  'job_queue_assignments',
  'job_queue_dismissals',
  'job_team_triage_subscriptions',
] as const

async function newUser(role = 'HR'): Promise<string> {
  const t = nextTag()
  const { rows } = await q(
    `INSERT INTO users (email, display_name, role) VALUES ($1, $2, $3) RETURNING id`,
    [`${t}@test.spec`, `${t} user`, role],
  )
  return rows[0].id as string
}

async function newTeam(): Promise<string> {
  const { rows } = await q(`INSERT INTO teams (name) VALUES ($1) RETURNING id`, [nextTag()])
  return rows[0].id as string
}

async function newOpportunity(): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_opportunities (title, title_key) VALUES ($1, $1) RETURNING id`,
    [nextTag()],
  )
  return rows[0].id as string
}

async function newSourceRecord(): Promise<string> {
  const t = nextTag()
  const { rows } = await q(
    `INSERT INTO job_source_records (source_type, namespace, identity_kind, identity_key)
     VALUES ('DOU_RSS', $1, 'NATIVE_ID', $1) RETURNING id`,
    [t],
  )
  return rows[0].id as string
}

/** A valid TEAM claim; the caller overrides one column at a time. */
async function claim(opportunityId: string, teamId: string, assigneeId: string) {
  const { rows } = await q(
    `INSERT INTO job_queue_assignments (opportunity_id, scope_kind, team_id, assignee_id)
     VALUES ($1, 'TEAM', $2, $3) RETURNING *`,
    [opportunityId, teamId, assigneeId],
  )
  return rows[0] as Record<string, unknown>
}

async function newSubscription(teamId: string, actorId: string): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_team_triage_subscriptions
       (team_id, role_family, policy_version, actor_id, reason, expires_at)
     VALUES ($1, 'backend', 0, $2, $3, now() + interval '30 days') RETURNING id`,
    [teamId, actorId, `${TAG} standing triage`],
  )
  return rows[0].id as string
}

async function newGeneration(
  scope: { kind: 'TEAM'; teamId: string } | { kind: 'STUDIO' },
): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_queue_generations
       (scope_kind, team_id, policy_signature, rule_version, evaluated_at, expires_at)
     VALUES ($1, $2, $3, 'rank-v1', now(), now() + interval '1 hour') RETURNING id`,
    [scope.kind, scope.kind === 'TEAM' ? scope.teamId : null, `${TAG}:sig`],
  )
  return rows[0].id as string
}

describe.skipIf(!hasDatabaseUrl())('job queue workflow store (real Postgres catalog)', () => {
  // Fixtures shared by the blocks below; each block creates its own
  // opportunities so no test depends on another's rows.
  let admin: string
  let hr: string
  let hrOther: string
  let teamA: string
  let teamB: string

  beforeAll(async () => {
    await assertRealDbSchema([
      { table: 'job_queue_assignments', column: 'assignee_id' },
      { table: 'job_queue_dismissals', column: 'undone_by' },
      { table: 'job_team_triage_subscriptions', column: 'subscription_version' },
      { table: 'job_queue_actions', column: 'idempotency_key' },
      { table: 'job_queue_generations', column: 'policy_signature' },
      { table: 'job_queue_generation_entries', column: 'order_key' },
    ])
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const { rows } = await q('SELECT current_database() AS db')
    // Writing spec: refuse the live database outright (the vitest guard does too).
    if (rows[0].db === 'crm_db') throw new Error('refusing to run against the live crm_db')
    await installAppendOnlyGuards()
    admin = await newUser('ADMIN')
    hr = await newUser('HR')
    hrOther = await newUser('HR')
    teamA = await newTeam()
    teamB = await newTeam()
  })

  /** Children first: the action log is RESTRICT towards every parent. Idempotent. */
  async function cleanup() {
    const users = `SELECT id FROM users WHERE email LIKE $1`
    // The log is append-only: the table owner disables its triggers for the length of
    // the cleanup (as job-queue-append-only.integration.spec.ts does) and re-enables
    // them in a `finally`, so a failed delete cannot leave the table unguarded.
    try {
      for (const name of GUARD_TRIGGERS)
        await q(`ALTER TABLE ${name.table} DISABLE TRIGGER ${name.trigger}`)
      await q(`DELETE FROM job_queue_actions WHERE actor_id IN (${users})`, [`${TAG}%`])
      // Entries cascade from their generation; a generation may only be purged once
      // INVALIDATED.
      await q(
        `UPDATE job_queue_generations SET status='INVALIDATED', invalidated_at=now()
          WHERE policy_signature LIKE $1 AND status <> 'INVALIDATED'`,
        [`${TAG}%`],
      )
      await q(`DELETE FROM job_queue_generations WHERE policy_signature LIKE $1`, [`${TAG}%`])
    } finally {
      for (const name of GUARD_TRIGGERS)
        await q(`ALTER TABLE ${name.table} ENABLE ALWAYS TRIGGER ${name.trigger}`)
    }
    await q(`DELETE FROM job_queue_assignments WHERE assignee_id IN (${users})`, [`${TAG}%`])
    await q(`DELETE FROM job_queue_dismissals WHERE dismissed_by IN (${users})`, [`${TAG}%`])
    await q(`DELETE FROM job_team_triage_subscriptions WHERE actor_id IN (${users})`, [`${TAG}%`])
    await q(`DELETE FROM job_opportunities WHERE title LIKE $1`, [`${TAG}%`])
    await q(`DELETE FROM job_source_records WHERE namespace LIKE $1`, [`${TAG}%`])
    await q(`DELETE FROM teams WHERE name LIKE $1`, [`${TAG}%`])
    await q(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}%`])
  }

  // A safety net when a test failed before the final cleanup test ran.
  afterAll(async () => {
    if (!pool) return
    try {
      await cleanup()
    } finally {
      // The suite's last act: a teardown that leaked a disabled guard must fail
      // here rather than leave the table silently unprotected for whoever runs next.
      const { rows } = await q(
        `SELECT tgname, tgenabled FROM pg_trigger
          WHERE tgrelid = 'job_queue_actions'::regclass AND NOT tgisinternal
          ORDER BY tgname`,
      )
      // Leave the cluster as this suite found it: drop exactly the roles IT created.
      // On CI a sibling creates them first, so this is a no-op there; run alone on a
      // fresh cluster it is what keeps the suite from leaking `crm_retention_owner`
      // (and, with it, the two R-B functions the role owns) into the cluster.
      let leaked: string[] = []
      try {
        await dropRolesCreated(pool, rolesCreatedHere)
        if (rolesCreatedHere.length > 0) leaked = await existingDeployRoles(pool)
      } finally {
        await pool.end()
      }
      const names = rows.map((r) => r.tgname).join(',')
      const wanted = GUARD_TRIGGERS.map((g) => g.trigger).join(',')
      if (names !== wanted || !rows.every((r) => r.tgenabled === 'A')) {
        throw new Error(
          `teardown left the action-log guards in a bad state: ${JSON.stringify(rows)}`,
        )
      }
      if (leaked.length > 0) {
        throw new Error(`teardown left role(s) behind in the cluster: ${leaked.join(', ')}`)
      }
    }
  })

  // -------------------------------------------------------------------------
  // job_queue_assignments (AC1)
  // -------------------------------------------------------------------------

  describe('job_queue_assignments (AC1)', () => {
    it('stores a TEAM claim with TAKEN, version 1 and a taken-at by default', async () => {
      const row = await claim(await newOpportunity(), teamA, hr)
      expect(row).toMatchObject({ state: 'TAKEN', version: 1, team_id: teamA, assignee_id: hr })
      expect(row['taken_at']).toBeInstanceOf(Date)
    })

    it('accepts an ADMIN claim in STUDIO scope (no team)', async () => {
      const { rows } = await q(
        `INSERT INTO job_queue_assignments (opportunity_id, scope_kind, team_id, assignee_id)
         VALUES ($1, 'STUDIO', NULL, $2) RETURNING scope_kind, team_id`,
        [await newOpportunity(), admin],
      )
      expect(rows).toEqual([{ scope_kind: 'STUDIO', team_id: null }])
    })

    it('is studio-wide: a second claim on the opportunity is refused, whatever the team', async () => {
      const opp = await newOpportunity()
      await claim(opp, teamA, hr)
      const dup = await rejected(
        `INSERT INTO job_queue_assignments (opportunity_id, scope_kind, team_id, assignee_id)
         VALUES ($1, 'TEAM', $2, $3)`,
        [opp, teamB, hrOther],
      )
      expect(dup).toEqual({
        code: UNIQUE_VIOLATION,
        constraint: 'uq_job_queue_assignments_opportunity',
      })
    })

    it('refuses a scope whose team does not match its kind, both ways', async () => {
      for (const [kind, team] of [
        ['TEAM', null],
        ['STUDIO', 'teamA'],
      ] as const) {
        const r = await rejected(
          `INSERT INTO job_queue_assignments (opportunity_id, scope_kind, team_id, assignee_id)
           VALUES ($1, $2, $3, $4)`,
          [await newOpportunity(), kind, team === null ? null : teamA, hr],
        )
        expect(r).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_queue_assignments_scope_shape',
        })
      }
    })

    it('refuses every half-set release combination and accepts both whole states', async () => {
      const opp = await newOpportunity()
      const now = new Date()
      // [state, released_at, released_by, release_reason] — every value is a
      // bound parameter, so each case differs from a valid row in ONE column.
      for (const half of [
        ['RELEASED', null, admin, null], // released without an instant
        ['RELEASED', now, null, null], // released without an actor
        ['TAKEN', now, null, null], // taken with a stale instant
        ['TAKEN', null, admin, null], // taken with a stale actor
        ['TAKEN', null, null, 'left over'], // taken with a stale reason
      ] as const) {
        const r = await rejected(
          `INSERT INTO job_queue_assignments
             (opportunity_id, scope_kind, team_id, assignee_id, state, released_at, released_by, release_reason)
           VALUES ($1, 'TEAM', $2, $3, $4, $5, $6, $7)`,
          [opp, teamA, hr, ...half],
        )
        expect(r, JSON.stringify(half)).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_queue_assignments_release_pair',
        })
      }
      // Whole RELEASED, with and without the optional reason.
      for (const reason of ['went on leave', null]) {
        await q(
          `INSERT INTO job_queue_assignments
             (opportunity_id, scope_kind, team_id, assignee_id, state, released_at, released_by, release_reason)
           VALUES ($1, 'TEAM', $2, $3, 'RELEASED', now(), $4, $5)`,
          [await newOpportunity(), teamA, hr, admin, reason],
        )
      }
    })

    it('bounds the release reason: blank and 501 refused, 500 accepted', async () => {
      for (const reason of ['   ', 'r'.repeat(501)]) {
        const r = await rejected(
          `INSERT INTO job_queue_assignments
             (opportunity_id, scope_kind, team_id, assignee_id, state, released_at, released_by, release_reason)
           VALUES ($1, 'TEAM', $2, $3, 'RELEASED', now(), $4, $5)`,
          [await newOpportunity(), teamA, hr, admin, reason],
        )
        expect(r).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_queue_assignments_release_reason_bounded',
        })
      }
      await q(
        `INSERT INTO job_queue_assignments
           (opportunity_id, scope_kind, team_id, assignee_id, state, released_at, released_by, release_reason)
         VALUES ($1, 'TEAM', $2, $3, 'RELEASED', now(), $4, $5)`,
        [await newOpportunity(), teamA, hr, admin, 'r'.repeat(500)],
      )
    })

    it('keeps the reassignment triple whole', async () => {
      const cols = `(opportunity_id, scope_kind, team_id, assignee_id, reassigned_at, reassigned_by, reassigned_from_id)`
      const now = new Date()
      for (const triple of [
        [now, null, null],
        [null, admin, null],
        [null, null, hrOther],
        [now, admin, null],
        [null, admin, hrOther],
        [now, null, hrOther],
      ] as const) {
        const r = await rejected(
          `INSERT INTO job_queue_assignments ${cols} VALUES ($1, 'TEAM', $2, $3, $4, $5, $6)`,
          [await newOpportunity(), teamA, hr, ...triple],
        )
        expect(r, JSON.stringify(triple)).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_queue_assignments_reassign_triple',
        })
      }
      await q(
        `INSERT INTO job_queue_assignments ${cols} VALUES ($1, 'TEAM', $2, $3, now(), $4, $5)`,
        [await newOpportunity(), teamA, hr, admin, hrOther],
      )
    })

    it('refuses version 0, an unknown state, an unknown opportunity and an unknown team', async () => {
      expect(
        await rejected(
          `INSERT INTO job_queue_assignments (opportunity_id, scope_kind, team_id, assignee_id, version)
           VALUES ($1, 'TEAM', $2, $3, 0)`,
          [await newOpportunity(), teamA, hr],
        ),
      ).toEqual({ code: CHECK_VIOLATION, constraint: 'ck_job_queue_assignments_version_positive' })
      expect(
        (
          await rejected(
            `INSERT INTO job_queue_assignments (opportunity_id, scope_kind, team_id, assignee_id, state)
             VALUES ($1, 'TEAM', $2, $3, 'CLAIMED')`,
            [await newOpportunity(), teamA, hr],
          )
        ).code,
      ).toBe(INVALID_TEXT)
      expect(
        await rejected(
          `INSERT INTO job_queue_assignments (opportunity_id, scope_kind, team_id, assignee_id)
           VALUES ($1, 'TEAM', $2, $3)`,
          [randomUUID(), teamA, hr],
        ),
      ).toEqual({ code: FK_VIOLATION, constraint: 'fk_job_queue_assignments_opportunity' })
      expect(
        await rejected(
          `INSERT INTO job_queue_assignments (opportunity_id, scope_kind, team_id, assignee_id)
           VALUES ($1, 'TEAM', $2, $3)`,
          [await newOpportunity(), randomUUID(), hr],
        ),
      ).toEqual({ code: FK_VIOLATION, constraint: 'fk_job_queue_assignments_team' })
    })

    it('never loses a claim to a team delete, and goes with its opportunity', async () => {
      const team = await newTeam()
      const opp = await newOpportunity()
      await claim(opp, team, hr)
      expect(await rejected(`DELETE FROM teams WHERE id = $1`, [team])).toEqual({
        code: FK_VIOLATION,
        constraint: 'fk_job_queue_assignments_team',
      })
      await q(`DELETE FROM job_opportunities WHERE id = $1`, [opp])
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM job_queue_assignments WHERE opportunity_id = $1`,
        [opp],
      )
      expect(rows[0].n).toBe(0)
      await q(`DELETE FROM teams WHERE id = $1`, [team])
    })
  })

  // -------------------------------------------------------------------------
  // job_queue_dismissals (AC2)
  // -------------------------------------------------------------------------

  describe('job_queue_dismissals (AC2)', () => {
    const DISMISS = `INSERT INTO job_queue_dismissals (opportunity_id, scope_kind, team_id, reason, dismissed_by)
                     VALUES ($1, $2, $3, 'not our stack', $4)`
    const dismiss = (opp: string, kind: string, team: string | null, by = hr) =>
      q(DISMISS, [opp, kind, team, by])
    const dismissRefused = (opp: string, kind: string, team: string | null, by = hr) =>
      rejected(DISMISS, [opp, kind, team, by])

    it('accepts a TEAM and a STUDIO dismissal of one opportunity side by side', async () => {
      const opp = await newOpportunity()
      await dismiss(opp, 'TEAM', teamA)
      await dismiss(opp, 'TEAM', teamB)
      await dismiss(opp, 'STUDIO', null, admin)
      const { rows } = await q(
        `SELECT version, dismissed_at IS NOT NULL AS stamped FROM job_queue_dismissals
         WHERE opportunity_id = $1`,
        [opp],
      )
      expect(rows).toEqual([
        { version: 1, stamped: true },
        { version: 1, stamped: true },
        { version: 1, stamped: true },
      ])
    })

    it('refuses a second dismissal in the same TEAM scope', async () => {
      const opp = await newOpportunity()
      await dismiss(opp, 'TEAM', teamA)
      expect(await dismissRefused(opp, 'TEAM', teamA, hrOther)).toEqual({
        code: UNIQUE_VIOLATION,
        constraint: 'uq_job_queue_dismissals_opportunity_scope',
      })
    })

    it('refuses a second STUDIO dismissal — NULLS NOT DISTINCT, not a plain UNIQUE', async () => {
      const opp = await newOpportunity()
      await dismiss(opp, 'STUDIO', null, admin)
      expect(await dismissRefused(opp, 'STUDIO', null, admin)).toEqual({
        code: UNIQUE_VIOLATION,
        constraint: 'uq_job_queue_dismissals_opportunity_scope',
      })
    })

    it('refuses a STUDIO dismissal naming a team and a TEAM one without a team', async () => {
      for (const [kind, team] of [
        ['STUDIO', teamA],
        ['TEAM', null],
      ] as const) {
        expect(await dismissRefused(await newOpportunity(), kind, team)).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_queue_dismissals_scope_shape',
        })
      }
    })

    it('keeps the undo pair whole and accepts a whole undo', async () => {
      const cols = `(opportunity_id, scope_kind, team_id, reason, dismissed_by, undone_at, undone_by)`
      for (const values of [`now(), NULL`, `NULL, $3::uuid`]) {
        expect(
          await rejected(
            `INSERT INTO job_queue_dismissals ${cols}
             VALUES ($1, 'TEAM', $2, 'x', $3, ${values})`,
            [await newOpportunity(), teamA, hr],
          ),
          values,
        ).toEqual({ code: CHECK_VIOLATION, constraint: 'ck_job_queue_dismissals_undo_pair' })
      }
      await q(
        `INSERT INTO job_queue_dismissals ${cols} VALUES ($1, 'TEAM', $2, 'x', $3, now(), $3)`,
        [await newOpportunity(), teamA, hr],
      )
    })

    it('bounds the reason and the version', async () => {
      for (const reason of ['', ' \t ', 'r'.repeat(501)]) {
        expect(
          await rejected(
            `INSERT INTO job_queue_dismissals (opportunity_id, scope_kind, team_id, reason, dismissed_by)
             VALUES ($1, 'TEAM', $2, $3, $4)`,
            [await newOpportunity(), teamA, reason, hr],
          ),
        ).toEqual({ code: CHECK_VIOLATION, constraint: 'ck_job_queue_dismissals_reason_bounded' })
      }
      await q(
        `INSERT INTO job_queue_dismissals (opportunity_id, scope_kind, team_id, reason, dismissed_by)
         VALUES ($1, 'TEAM', $2, $3, $4)`,
        [await newOpportunity(), teamA, 'r'.repeat(500), hr],
      )
      expect(
        await rejected(
          `INSERT INTO job_queue_dismissals (opportunity_id, scope_kind, team_id, reason, dismissed_by, version)
           VALUES ($1, 'TEAM', $2, 'x', $3, 0)`,
          [await newOpportunity(), teamA, hr],
        ),
      ).toEqual({ code: CHECK_VIOLATION, constraint: 'ck_job_queue_dismissals_version_positive' })
    })

    it('goes with its team (a team view) and with its opportunity', async () => {
      const team = await newTeam()
      const opp = await newOpportunity()
      await dismiss(opp, 'TEAM', team)
      await q(`DELETE FROM teams WHERE id = $1`, [team])
      const opp2 = await newOpportunity()
      await dismiss(opp2, 'STUDIO', null, admin)
      await q(`DELETE FROM job_opportunities WHERE id = $1`, [opp2])
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM job_queue_dismissals WHERE opportunity_id IN ($1, $2)`,
        [opp, opp2],
      )
      expect(rows[0].n).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // job_team_triage_subscriptions (AC3)
  // -------------------------------------------------------------------------

  describe('job_team_triage_subscriptions (AC3)', () => {
    const cols = `(team_id, role_family, source_types, policy_version, subscription_version, actor_id, reason, expires_at)`
    const insert = (
      over: Partial<Record<'role' | 'types' | 'policy' | 'version' | 'reason', unknown>> = {},
    ) =>
      q(
        `INSERT INTO job_team_triage_subscriptions ${cols}
         VALUES ($1, $2, $3::job_source_type[], $4, $5, $6, $7, now() + interval '30 days')
         RETURNING *`,
        [
          teamA,
          'role' in over ? over.role : 'backend',
          'types' in over ? over.types : '{}',
          'policy' in over ? over.policy : 0,
          'version' in over ? over.version : 1,
          admin,
          'reason' in over ? over.reason : `${TAG} standing`,
        ],
      )
    const refused = async (over: Parameters<typeof insert>[0]) => {
      try {
        await insert(over)
      } catch (e) {
        const err = e as { code?: string; constraint?: string }
        return { code: err.code, constraint: err.constraint }
      }
      throw new Error(`expected a refusal for ${JSON.stringify(over)}`)
    }

    it('stores the contract fields with an every-source default and version 1', async () => {
      const { rows } = await q(
        `INSERT INTO job_team_triage_subscriptions
           (team_id, role_family, policy_version, actor_id, reason, expires_at)
         VALUES ($1, 'backend', 0, $2, $3, now() + interval '1 day') RETURNING *`,
        [teamA, admin, `${TAG} default`],
      )
      expect(rows[0]).toMatchObject({
        subscription_version: 1,
        policy_version: 0,
        revoked_at: null,
      })
      // node-postgres does not parse arrays of a custom enum type: read them as text.
      const types = async (id: string) =>
        (
          await q(
            `SELECT source_types::text AS t FROM job_team_triage_subscriptions WHERE id = $1`,
            [id],
          )
        ).rows[0].t
      expect(await types(rows[0].id as string)).toBe('{}')
      const typed = await insert({ types: '{DOU_RSS,DJINNI_RSS}' })
      expect(await types(typed.rows[0].id as string)).toBe('{DOU_RSS,DJINNI_RSS}')
    })

    it('bounds the role family: blank and 101 refused, 100 accepted', async () => {
      for (const role of ['', '   ', 'r'.repeat(101)])
        expect(await refused({ role })).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_team_triage_subscriptions_role_family_bounded',
        })
      await insert({ role: 'r'.repeat(100) })
    })

    it('refuses a NULL element and a multi-dimensional filter (CR-M-1)', async () => {
      // The cardinality bound counts a NULL element as a member, and nothing
      // looked at dimensionality: '{NULL}' and a 2-D array were both stored
      // although the contract (an array of enum members) refuses them.
      for (const types of ['{NULL}', '{DOU_RSS,NULL}', '{{DOU_RSS},{DJINNI_RSS}}'])
        expect(await refused({ types }), types).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_team_triage_subscriptions_source_types_shape',
        })
      // The empty filter ("every source") has NO dimensions at all — it must pass.
      await insert({ types: '{}' })
      await insert({ types: '{DOU_RSS}' })
    })

    it('accepts only provider types, at most as many as the enum has', async () => {
      expect((await refused({ types: '{NOT_A_SOURCE}' })).code).toBe(INVALID_TEXT)
      const { rows } = await q(`SELECT cardinality(enum_range(NULL::job_source_type))::int AS n`)
      const n = rows[0].n as number
      await insert({ types: `{${Array(n).fill('DOU_RSS').join(',')}}` })
      expect(
        await refused({
          types: `{${Array(n + 1)
            .fill('DOU_RSS')
            .join(',')}}`,
        }),
      ).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_team_triage_subscriptions_source_types_bounded',
      })
    })

    it('starts the subscription version at 1 and allows policy version 0', async () => {
      expect(await refused({ version: 0 })).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_team_triage_subscriptions_version_positive',
      })
      expect(await refused({ policy: -1 })).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_team_triage_subscriptions_policy_version_nonneg',
      })
      expect((await refused({ policy: 2_147_483_648 })).code).toBe(OUT_OF_RANGE)
    })

    it('requires a create reason', async () => {
      for (const reason of ['', ' '])
        expect(await refused({ reason })).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_team_triage_subscriptions_reason_bounded',
        })
    })

    it('keeps the revoke triple whole, with a bounded reason', async () => {
      const id = (await insert()).rows[0].id as string
      const now = new Date()
      for (const triple of [
        [now, null, null],
        [null, admin, null],
        [null, null, 'gone'],
        [now, admin, null], // the UNKNOWN trap: a NULL reason in the revoked branch
        [now, null, 'gone'],
        [null, admin, 'gone'],
        [now, admin, '  '],
        [now, admin, 'r'.repeat(501)],
      ] as const) {
        const r = await rejected(
          `UPDATE job_team_triage_subscriptions
           SET revoked_at = $2, revoked_by = $3, revoke_reason = $4 WHERE id = $1`,
          [id, ...triple],
        )
        expect(r, JSON.stringify(triple)).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_team_triage_subscriptions_revoke_triple',
        })
      }
      await q(
        `UPDATE job_team_triage_subscriptions
         SET revoked_at = now(), revoked_by = $2, revoke_reason = 'team reorganised',
             subscription_version = subscription_version + 1
         WHERE id = $1`,
        [id, admin],
      )
    })

    it('never loses its author to a user delete', async () => {
      const author = await newUser('ADMIN')
      await newSubscription(teamA, author)
      expect(await rejected(`DELETE FROM users WHERE id = $1`, [author])).toEqual({
        code: FK_VIOLATION,
        constraint: 'fk_job_team_triage_subscriptions_actor',
      })
    })
  })

  // -------------------------------------------------------------------------
  // job_queue_actions (AC4)
  // -------------------------------------------------------------------------

  describe('job_queue_actions (AC4)', () => {
    type Action = {
      kind: string
      opportunity?: string | null
      source?: string | null
      subscription?: string | null
      actor?: string
      scope?: 'TEAM' | 'STUDIO'
      team?: string | null
      subjectTeam?: string | null
      subjectUser?: string | null
      before?: number | null
      after?: number | null
      key?: string
      reason?: string | null
    }
    let opp: string
    let rec: string
    let sub: string

    beforeAll(async () => {
      opp = await newOpportunity()
      rec = await newSourceRecord()
      sub = await newSubscription(teamA, admin)
    })

    const insertAction = (a: Action) =>
      q(
        `INSERT INTO job_queue_actions
           (kind, opportunity_id, source_record_id, subscription_id, actor_id, scope_kind, team_id,
            subject_team_id, subject_user_id, before_version, after_version, idempotency_key, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
        [
          a.kind,
          a.opportunity === undefined ? opp : a.opportunity,
          a.source === undefined ? null : a.source,
          a.subscription === undefined ? null : a.subscription,
          a.actor ?? hr,
          a.scope ?? 'TEAM',
          a.team === undefined ? ((a.scope ?? 'TEAM') === 'TEAM' ? teamA : null) : a.team,
          a.subjectTeam ?? null,
          a.subjectUser ?? null,
          a.before === undefined ? 0 : a.before,
          a.after === undefined ? 1 : a.after,
          a.key ?? nextTag(),
          a.reason ?? null,
        ],
      )
    const actionRefused = async (a: Action) => {
      try {
        await insertAction(a)
      } catch (e) {
        const err = e as { code?: string; constraint?: string }
        return { code: err.code, constraint: err.constraint }
      }
      throw new Error(`expected a refusal for ${JSON.stringify(a)}`)
    }
    const telemetry = (kind: string): Action => ({ kind, source: rec, before: null, after: null })
    const subscription = (kind: string): Action => ({
      kind,
      opportunity: null,
      subscription: sub,
      scope: 'STUDIO',
      actor: admin,
      subjectTeam: teamA,
    })

    it('accepts one valid row of every kind', async () => {
      for (const kind of ['OPENED', 'DEAD_LINK', 'SPAM']) await insertAction(telemetry(kind))
      for (const kind of ['TAKEN', 'DISMISSED', 'UNDONE', 'RELEASED', 'SUPPRESSED'])
        await insertAction({ kind })
      await insertAction({
        kind: 'REASSIGNED',
        subjectUser: hrOther,
        actor: admin,
        scope: 'STUDIO',
      })
      for (const kind of ['TRIAGE_GRANTED', 'TRIAGE_REVOKED'])
        await insertAction({ kind, actor: admin, scope: 'STUDIO', subjectTeam: teamB })
      for (const kind of ['TRIAGE_SUBSCRIBED', 'TRIAGE_UNSUBSCRIBED'])
        await insertAction(subscription(kind))
      // An optional source record on a non-telemetry kind (r5).
      await insertAction({ kind: 'TAKEN', source: rec })
      const { rows } = await q(
        `SELECT count(DISTINCT kind)::int AS n FROM job_queue_actions WHERE actor_id IN ($1, $2)`,
        [hr, admin],
      )
      expect(rows[0].n).toBe(13)
    })

    it('targets a subscription XOR an opportunity, by kind', async () => {
      for (const a of [
        { kind: 'TAKEN', opportunity: null },
        { kind: 'TAKEN', subscription: sub },
        { ...subscription('TRIAGE_SUBSCRIBED'), subscription: null },
        { ...subscription('TRIAGE_SUBSCRIBED'), opportunity: opp },
        { ...subscription('TRIAGE_UNSUBSCRIBED'), source: rec },
      ] as Action[])
        expect(await actionRefused(a), JSON.stringify(a)).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_queue_actions_target',
        })
    })

    it('requires the clicked source record on every telemetry kind', async () => {
      for (const kind of ['OPENED', 'DEAD_LINK', 'SPAM'])
        expect(await actionRefused({ ...telemetry(kind), source: null })).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_queue_actions_clicked_source',
        })
    })

    it('names the subject team on TRIAGE_* only and the new assignee on REASSIGNED only', async () => {
      expect(
        await actionRefused({ kind: 'TRIAGE_GRANTED', actor: admin, scope: 'STUDIO' }),
      ).toEqual({ code: CHECK_VIOLATION, constraint: 'ck_job_queue_actions_subject_team' })
      expect(
        await actionRefused({ ...subscription('TRIAGE_SUBSCRIBED'), subjectTeam: null }),
      ).toEqual({ code: CHECK_VIOLATION, constraint: 'ck_job_queue_actions_subject_team' })
      expect(await actionRefused({ kind: 'TAKEN', subjectTeam: teamA })).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_queue_actions_subject_team',
      })
      expect(await actionRefused({ kind: 'REASSIGNED', actor: admin, scope: 'STUDIO' })).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_queue_actions_subject_user',
      })
      expect(await actionRefused({ kind: 'RELEASED', subjectUser: hrOther })).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_queue_actions_subject_user',
      })
    })

    it('lets SUPPRESSED carry no version — its target has none (SPEC-M-1)', async () => {
      // No r5 entity holds suppression state, so there is no version to move.
      await insertAction({
        kind: 'SUPPRESSED',
        actor: admin,
        scope: 'STUDIO',
        before: null,
        after: null,
      })
      // ... but a half-set or backward pair is still refused.
      for (const v of [
        { before: 0, after: null },
        { before: null, after: 1 },
        { before: 1, after: 1 },
      ])
        expect(
          await actionRefused({ kind: 'SUPPRESSED', actor: admin, scope: 'STUDIO', ...v }),
          JSON.stringify(v),
        ).toEqual({ code: CHECK_VIOLATION, constraint: 'ck_job_queue_actions_versions' })
      // A triage grant DOES have a version (`job_opportunity_team_triage.grant_version`),
      // so it stays versioned.
      expect(
        await actionRefused({
          kind: 'TRIAGE_GRANTED',
          actor: admin,
          scope: 'STUDIO',
          subjectTeam: teamB,
          before: null,
          after: null,
        }),
      ).toEqual({ code: CHECK_VIOLATION, constraint: 'ck_job_queue_actions_versions' })
    })

    it('leaves telemetry unversioned and moves every mutation strictly forward', async () => {
      for (const v of [
        { before: 0, after: null },
        { before: null, after: 1 },
        { before: 0, after: 1 },
      ])
        expect(await actionRefused({ ...telemetry('OPENED'), ...v }), JSON.stringify(v)).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_queue_actions_versions',
        })
      for (const v of [
        { before: null, after: 1 },
        { before: 0, after: null },
        { before: null, after: null },
        { before: 1, after: 1 },
        { before: 2, after: 1 },
        { before: -1, after: 1 },
      ])
        expect(await actionRefused({ kind: 'DISMISSED', ...v }), JSON.stringify(v)).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_queue_actions_versions',
        })
    })

    it('scopes the idempotency key to its actor', async () => {
      const key = nextTag()
      await insertAction({ kind: 'TAKEN', key })
      expect(await actionRefused({ kind: 'DISMISSED', key })).toEqual({
        code: UNIQUE_VIOLATION,
        constraint: 'uq_job_queue_actions_actor_idempotency',
      })
      // Another actor's identical key is a different request, not a collision.
      await insertAction({ kind: 'DISMISSED', key, actor: hrOther })
    })

    it('records an OPENED click once per actor + opportunity + source record', async () => {
      const o = await newOpportunity()
      await insertAction({ ...telemetry('OPENED'), opportunity: o })
      expect(await actionRefused({ ...telemetry('OPENED'), opportunity: o })).toEqual({
        code: UNIQUE_VIOLATION,
        constraint: 'uq_job_queue_actions_opened_once',
      })
      // Another actor, another source copy, or a non-OPENED kind is not the same click.
      await insertAction({ ...telemetry('OPENED'), opportunity: o, actor: hrOther })
      await insertAction({
        ...telemetry('OPENED'),
        opportunity: o,
        source: await newSourceRecord(),
      })
      await insertAction({ ...telemetry('SPAM'), opportunity: o })
      await insertAction({ ...telemetry('SPAM'), opportunity: o })
    })

    it('bounds the key and the reason, and refuses a scope of the wrong shape', async () => {
      for (const key of ['', ' ', 'k'.repeat(201)])
        expect(await actionRefused({ kind: 'TAKEN', key })).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_queue_actions_idempotency_key_bounded',
        })
      await insertAction({ kind: 'TAKEN', key: `${TAG}-${'k'.repeat(180)}` })
      for (const reason of [' ', 'r'.repeat(501)])
        expect(await actionRefused({ kind: 'TAKEN', reason })).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_queue_actions_reason_bounded',
        })
      await insertAction({ kind: 'TAKEN', reason: 'r'.repeat(500) })
      expect(await actionRefused({ kind: 'TAKEN', scope: 'STUDIO', team: teamA })).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_queue_actions_scope_shape',
      })
      expect(await actionRefused({ kind: 'TAKEN', scope: 'TEAM', team: null })).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_queue_actions_scope_shape',
      })
      expect((await actionRefused({ kind: 'CLAIMED' })).code).toBe(INVALID_TEXT)
    })

    it('never lets a parent delete erase audit: every parent is RESTRICT', async () => {
      const o = await newOpportunity()
      const r = await newSourceRecord()
      const s = await newSubscription(teamA, admin)
      await insertAction({ ...telemetry('OPENED'), opportunity: o, source: r })
      await insertAction(subscription('TRIAGE_SUBSCRIBED'))
      await insertAction({ ...subscription('TRIAGE_UNSUBSCRIBED'), subscription: s })
      expect(await rejected(`DELETE FROM job_opportunities WHERE id = $1`, [o])).toEqual({
        code: FK_VIOLATION,
        constraint: 'fk_job_queue_actions_opportunity',
      })
      expect(await rejected(`DELETE FROM job_source_records WHERE id = $1`, [r])).toEqual({
        code: FK_VIOLATION,
        constraint: 'fk_job_queue_actions_source_record',
      })
      expect(
        await rejected(`DELETE FROM job_team_triage_subscriptions WHERE id = $1`, [s]),
      ).toEqual({ code: FK_VIOLATION, constraint: 'fk_job_queue_actions_subscription' })
    })

    it('refuses UPDATE and DELETE on the action log (append-only trigger, Task 1.3)', async () => {
      const row = (await insertAction({ kind: 'TAKEN' })).rows[0] as { id: string }
      expect(
        (await rejected(`UPDATE job_queue_actions SET reason = 'edited' WHERE id = $1`, [row.id]))
          .code,
      ).toBe(RESTRICT_VIOLATION)
      expect((await rejected(`DELETE FROM job_queue_actions WHERE id = $1`, [row.id])).code).toBe(
        RESTRICT_VIOLATION,
      )
      // The row survived both attempts untouched.
      const { rows } = await q(`SELECT reason FROM job_queue_actions WHERE id = $1`, [row.id])
      expect(rows).toHaveLength(1)
      expect(rows[0].reason).not.toBe('edited')
    })
  })

  // -------------------------------------------------------------------------
  // job_queue_generations + entries (AC5)
  // -------------------------------------------------------------------------

  describe('job_queue_generations (AC5)', () => {
    const gcols = `(scope_kind, team_id, policy_signature, rule_version, status, evaluated_at, expires_at, published_at, invalidated_at)`

    it('starts BUILDING', async () => {
      const id = await newGeneration({ kind: 'TEAM', teamId: teamA })
      const { rows } = await q(`SELECT status FROM job_queue_generations WHERE id = $1`, [id])
      expect(rows[0].status).toBe('BUILDING')
    })

    it('refuses every instant combination that does not match its status', async () => {
      for (const v of [
        `'BUILDING', now(), now() + interval '1 hour', now(), NULL`,
        `'BUILDING', now(), now() + interval '1 hour', NULL, now()`,
        `'PUBLISHED', now(), now() + interval '1 hour', NULL, NULL`,
        `'PUBLISHED', now(), now() + interval '1 hour', now(), now()`,
        `'INVALIDATED', now(), now() + interval '1 hour', NULL, NULL`,
        `'INVALIDATED', now(), now() + interval '1 hour', now(), NULL`,
      ])
        expect(
          await rejected(
            `INSERT INTO job_queue_generations ${gcols} VALUES ('TEAM', $1, $2, 'rank-v1', ${v})`,
            [teamB, `${TAG}:sig`],
          ),
          v,
        ).toEqual({ code: CHECK_VIOLATION, constraint: 'ck_job_queue_generations_status_instants' })
      // INVALIDATED with or without a prior publish.
      for (const published of ['now()', 'NULL'])
        await q(
          `INSERT INTO job_queue_generations ${gcols}
           VALUES ('TEAM', $1, $2, 'rank-v1', 'INVALIDATED', now(), now() + interval '1 hour', ${published}, now())`,
          [teamB, `${TAG}:sig`],
        )
    })

    it('expires strictly after evaluation and bounds its texts', async () => {
      const at = (signature: string, rule: string, expires: string) =>
        rejected(
          `INSERT INTO job_queue_generations
             (scope_kind, team_id, policy_signature, rule_version, evaluated_at, expires_at)
           VALUES ('TEAM', $1, $2, $3, now(), ${expires})`,
          [teamA, signature, rule],
        )
      expect(await at(`${TAG}:sig`, 'rank-v1', 'now()')).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_queue_generations_expiry_after_evaluation',
      })
      for (const sig of ['', ' ', `${TAG}${'s'.repeat(200)}`])
        expect(await at(sig, 'rank-v1', `now() + interval '1 hour'`)).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_queue_generations_policy_signature_bounded',
        })
      for (const rule of ['', 'r'.repeat(101)])
        expect(await at(`${TAG}:sig`, rule, `now() + interval '1 hour'`)).toEqual({
          code: CHECK_VIOLATION,
          constraint: 'ck_job_queue_generations_rule_version_bounded',
        })
      expect(
        await rejected(
          `INSERT INTO job_queue_generations
             (scope_kind, team_id, policy_signature, rule_version, evaluated_at, expires_at)
           VALUES ('STUDIO', $1, $2, 'rank-v1', now(), now() + interval '1 hour')`,
          [teamA, `${TAG}:sig`],
        ),
      ).toEqual({ code: CHECK_VIOLATION, constraint: 'ck_job_queue_generations_scope_shape' })
    })

    it('allows one PUBLISHED generation per team and one for STUDIO', async () => {
      const team = await newTeam()
      const publish = (id: string) =>
        q(
          `UPDATE job_queue_generations SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
          [id],
        )
      const first = await newGeneration({ kind: 'TEAM', teamId: team })
      const second = await newGeneration({ kind: 'TEAM', teamId: team })
      await publish(first)
      expect(
        await rejected(
          `UPDATE job_queue_generations SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
          [second],
        ),
      ).toEqual({ code: UNIQUE_VIOLATION, constraint: 'uq_job_queue_generations_published_team' })
      // Another team publishes independently.
      await publish(await newGeneration({ kind: 'TEAM', teamId: await newTeam() }))

      // STUDIO: two NULL teams would both pass a plain index — this one refuses.
      const s1 = await newGeneration({ kind: 'STUDIO' })
      const s2 = await newGeneration({ kind: 'STUDIO' })
      await publish(s1)
      expect(
        await rejected(
          `UPDATE job_queue_generations SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
          [s2],
        ),
      ).toEqual({ code: UNIQUE_VIOLATION, constraint: 'uq_job_queue_generations_published_studio' })

      // The legal swap: invalidate the current one and publish the next IN ONE transaction.
      const c = await pool.connect()
      try {
        await c.query('BEGIN')
        await c.query(
          `UPDATE job_queue_generations SET status = 'INVALIDATED', invalidated_at = now() WHERE id = $1`,
          [first],
        )
        await c.query(
          `UPDATE job_queue_generations SET status = 'PUBLISHED', published_at = now() WHERE id = $1`,
          [second],
        )
        await c.query('COMMIT')
      } finally {
        c.release()
      }
      const { rows } = await q(
        `SELECT id FROM job_queue_generations WHERE team_id = $1 AND status = 'PUBLISHED'`,
        [team],
      )
      expect(rows).toEqual([{ id: second }])
    })

    it('cascades a purged generation to its entries', async () => {
      const g = await newGeneration({ kind: 'TEAM', teamId: teamA })
      await q(
        `INSERT INTO job_queue_generation_entries
           (generation_id, opportunity_id, rank_score, order_key, first_seen_at, opportunity_revision)
         VALUES ($1, $2, 10, 0, now(), 1)`,
        [g, await newOpportunity()],
      )
      await q(
        `UPDATE job_queue_generations SET status = 'INVALIDATED', invalidated_at = now() WHERE id = $1`,
        [g],
      )
      await q(`DELETE FROM job_queue_generations WHERE id = $1`, [g])
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM job_queue_generation_entries WHERE generation_id = $1`,
        [g],
      )
      expect(rows[0].n).toBe(0)
    })
  })

  describe('job_queue_generation_entries (AC5)', () => {
    let gen: string
    beforeAll(async () => {
      gen = await newGeneration({ kind: 'TEAM', teamId: teamA })
    })
    const entry = (o: string, rank: number | string, order: number, revision = 1) =>
      q(
        `INSERT INTO job_queue_generation_entries
           (generation_id, opportunity_id, rank_score, order_key, first_seen_at, opportunity_revision)
         VALUES ($1, $2, $3, $4, now(), $5)`,
        [gen, o, rank, order, revision],
      )
    const entryRefused = async (...args: Parameters<typeof entry>) => {
      try {
        await entry(...args)
      } catch (e) {
        const err = e as { code?: string; constraint?: string }
        return { code: err.code, constraint: err.constraint }
      }
      throw new Error('expected a refusal')
    }

    it('keys entries (generation, opportunity) and positions by a unique order key', async () => {
      const o1 = await newOpportunity()
      const o2 = await newOpportunity()
      await entry(o1, -5, 0)
      expect(await entryRefused(o1, 7, 1)).toEqual({
        code: UNIQUE_VIOLATION,
        constraint: 'pk_job_queue_generation_entries',
      })
      expect(await entryRefused(o2, 7, 0)).toEqual({
        code: UNIQUE_VIOLATION,
        constraint: 'uq_job_queue_generation_entries_order',
      })
      await entry(o2, 7, 1)
    })

    it('keeps integer score / order keys in range and refuses a negative position', async () => {
      expect((await entryRefused(await newOpportunity(), '2147483648', 5)).code).toBe(OUT_OF_RANGE)
      expect((await entryRefused(await newOpportunity(), '1.5', 5)).code).toBe(INVALID_TEXT)
      await entry(await newOpportunity(), -2_147_483_648, 6)
      expect(await entryRefused(await newOpportunity(), 0, -1)).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_queue_generation_entries_order_key_nonneg',
      })
      expect(await entryRefused(await newOpportunity(), 0, 9, 0)).toEqual({
        code: CHECK_VIOLATION,
        constraint: 'ck_job_queue_generation_entries_revision_positive',
      })
      expect(
        await rejected(
          `INSERT INTO job_queue_generation_entries
             (generation_id, opportunity_id, rank_score, order_key, first_seen_at, opportunity_revision)
           VALUES ($1, $2, 0, 0, now(), 1)`,
          [randomUUID(), await newOpportunity()],
        ),
      ).toEqual({ code: FK_VIOLATION, constraint: 'fk_job_queue_generation_entries_generation' })
    })

    it('drops an entry whose opportunity is deleted (r5: removals allowed)', async () => {
      const o = await newOpportunity()
      await entry(o, 1, 20)
      await q(`DELETE FROM job_opportunities WHERE id = $1`, [o])
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM job_queue_generation_entries WHERE opportunity_id = $1`,
        [o],
      )
      expect(rows[0].n).toBe(0)
    })

    it('refuses editing an entry once written (immutable-entries trigger, Task 1.3)', async () => {
      const o = await newOpportunity()
      await entry(o, 1, 30)
      const err = await rejected(
        `UPDATE job_queue_generation_entries SET rank_score = 99
         WHERE generation_id = $1 AND opportunity_id = $2`,
        [gen, o],
      )
      expect(err.code).toBe(RESTRICT_VIOLATION)
      const { rows } = await q(
        `SELECT rank_score FROM job_queue_generation_entries
         WHERE generation_id = $1 AND opportunity_id = $2`,
        [gen, o],
      )
      expect(Number(rows[0].rank_score)).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Real-DB concurrency (AC8)
  // -------------------------------------------------------------------------

  describe('real-DB concurrency (AC8)', () => {
    it('two HRs racing the first claim: exactly one holds the opportunity', async () => {
      const opp = await newOpportunity()
      const a = await pool.connect()
      const b = await pool.connect()
      try {
        await a.query('BEGIN')
        await b.query('BEGIN')
        const insert = `INSERT INTO job_queue_assignments (opportunity_id, scope_kind, team_id, assignee_id)
                        VALUES ($1, 'TEAM', $2, $3)`
        await a.query(insert, [opp, teamA, hr])
        // B blocks on the unique index until A resolves; start it unawaited.
        const bInsert = rejectedOn(b, insert, [opp, teamB, hrOther])
        await a.query('COMMIT')
        expect(await bInsert).toEqual({
          code: UNIQUE_VIOLATION,
          constraint: 'uq_job_queue_assignments_opportunity',
        })
        await b.query('ROLLBACK')
        const { rows } = await q(
          `SELECT assignee_id FROM job_queue_assignments WHERE opportunity_id = $1`,
          [opp],
        )
        expect(rows).toEqual([{ assignee_id: hr }])
      } finally {
        a.release()
        b.release()
      }
    })

    it('two HRs racing a re-take of a released claim: the version guard admits one', async () => {
      const opp = await newOpportunity()
      await q(
        `INSERT INTO job_queue_assignments
           (opportunity_id, scope_kind, team_id, assignee_id, state, released_at, released_by)
         VALUES ($1, 'TEAM', $2, $3, 'RELEASED', now(), $4)`,
        [opp, teamA, hr, admin],
      )
      const retake = `UPDATE job_queue_assignments
        SET state = 'TAKEN', assignee_id = $2, team_id = $3, taken_at = now(), version = version + 1,
            released_at = NULL, released_by = NULL, release_reason = NULL
        WHERE opportunity_id = $1 AND state = 'RELEASED' AND version = 1`
      const a = await pool.connect()
      const b = await pool.connect()
      try {
        await a.query('BEGIN')
        await b.query('BEGIN')
        const won = await a.query(retake, [opp, hrOther, teamB])
        expect(won.rowCount).toBe(1)
        // B waits on A's row lock, then re-evaluates its WHERE against the
        // committed row (version 2, TAKEN) and updates nothing.
        const bRetake = b.query(retake, [opp, hr, teamA])
        await a.query('COMMIT')
        expect((await bRetake).rowCount).toBe(0)
        await b.query('COMMIT')
        const { rows } = await q(
          `SELECT assignee_id, version, state FROM job_queue_assignments WHERE opportunity_id = $1`,
          [opp],
        )
        expect(rows).toEqual([{ assignee_id: hrOther, version: 2, state: 'TAKEN' }])
      } finally {
        a.release()
        b.release()
      }
    })

    it('two publishers racing one scope: exactly one generation is PUBLISHED', async () => {
      const team = await newTeam()
      const g1 = await newGeneration({ kind: 'TEAM', teamId: team })
      const g2 = await newGeneration({ kind: 'TEAM', teamId: team })
      const publish = `UPDATE job_queue_generations SET status = 'PUBLISHED', published_at = now() WHERE id = $1`
      const a = await pool.connect()
      const b = await pool.connect()
      try {
        await a.query('BEGIN')
        await b.query('BEGIN')
        await a.query(publish, [g1])
        const bPublish = rejectedOn(b, publish, [g2])
        await a.query('COMMIT')
        expect(await bPublish).toEqual({
          code: UNIQUE_VIOLATION,
          constraint: 'uq_job_queue_generations_published_team',
        })
        await b.query('ROLLBACK')
        const { rows } = await q(
          `SELECT id FROM job_queue_generations WHERE team_id = $1 AND status = 'PUBLISHED'`,
          [team],
        )
        expect(rows).toEqual([{ id: g1 }])
      } finally {
        a.release()
        b.release()
      }
    })
  })

  it('leaves every new table EMPTY after cleanup (AC8 — not just free of tagged rows)', async () => {
    await cleanup()
    // The integration run is serial (vitest.config), so nothing else writes here.
    const counts: Record<string, number> = {}
    for (const t of NEW_TABLES) {
      const { rows } = await q(`SELECT count(*)::int AS n FROM ${t}`)
      counts[t] = rows[0].n as number
    }
    expect(counts).toEqual(Object.fromEntries(NEW_TABLES.map((t) => [t, 0])))
  })
})
