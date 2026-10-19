import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertRealDbSchema, hasDatabaseUrl } from '../test/require-real-db'
import {
  applyDeployDdlFile,
  dropRolesCreated,
  existingDeployRoles,
  installDeployRoles,
} from './__test-helpers__/deploy-ddl-preconditions'
import { splitSqlStatements } from './manual-sql-statements'

/**
 * r5 Task 1.3b — the append-only triggers and the R-B retention path, against the
 * REAL PostgreSQL catalog. Every claim is proven by making the database accept or
 * refuse a statement, by error code; nothing here reads Drizzle metadata, because
 * Drizzle cannot declare a trigger and therefore knows nothing about any of this.
 *
 * This suite APPLIES THE TWO DDL FILES ITSELF, twice each, because that is the only
 * honest way to test forward DDL that `db:push` cannot produce — and applying twice
 * is simultaneously the idempotency proof the deploy needs (every manual file re-runs
 * on every deploy under `psql -v ON_ERROR_STOP=1`).
 *
 * Run against a scratch DB (NEVER the live crm_db), after `db:push`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_scratch_trig1024 \
 *     pnpm --filter @crm/api test -- job-queue-append-only.integration
 *
 * TWO THINGS THE SUITE NEEDS FROM ITS DATABASE, both stated rather than assumed:
 *   - the roles `crm_retention_owner` and `crm_app` (r5 Task 1.3c). The DDL refuses
 *     to apply without them, so their absence shows up as a setup failure naming
 *     them, not as a mystery;
 *   - the table privileges of `crm_retention_owner` on `job_queue_actions`. Those are
 *     1.3c's to grant in production; this suite grants them in its own scratch
 *     database so the trigger's admitted shapes can be exercised DIRECTLY (`SET ROLE`
 *     + a plain statement), independently of the two functions — which is what ADR §3
 *     condition 5 asks the tests to prove.
 *
 * TEARDOWN, and why it disables the triggers it just proved
 * --------------------------------------------------------
 * The log is append-only, so a fixture row CANNOT be deleted by the suite: that is
 * the feature. A teardown therefore has exactly two options — leave rows behind
 * (they hold RESTRICT references to the fixture users and teams, so nothing else can
 * be cleaned either), or disable the two action triggers for the length of the
 * cleanup, as the table owner. This suite does the second, in a `finally`, and then
 * RE-RUNS THE CATALOG CHECK as its last act, so a teardown that forgot to re-enable
 * a trigger fails the suite instead of leaving a quietly unguarded table behind for
 * whoever runs next. ADR §3 names this exact capability as the migration role's
 * (ownership alone suffices), which is why it is available here and to nothing in
 * the application.
 */

const TAG = `it1.3b-${randomUUID().slice(0, 8)}`
const REDACTION_TOKEN = '[REASON REDACTED]'
const RESTRICT_VIOLATION = '23001'
const FK_VIOLATION = '23503'
const INSUFFICIENT_PRIVILEGE = '42501'
const INVALID_PARAMETER = '22023'

const DDL_DIR = join(__dirname, '..', '..', 'drizzle', 'manual')
const TRIGGERS_SQL = join(DDL_DIR, '2026-10-18_job_queue_append_only_triggers.sql')
const CHECK_SQL = join(DDL_DIR, '2026-10-18_job_queue_append_only_check.sql')

const ACTION_TRIGGERS = [
  'trg_job_queue_actions_append_only',
  'trg_job_queue_actions_no_truncate',
] as const

/**
 * THE ONE GRANT PRODUCTION DOES NOT HAVE, named once so every test that depends on it can
 * point here, and so `afterAll` can revoke exactly it.
 *
 * `crm_retention_redact_action_reason` needs `SELECT` plus `UPDATE (reason)` to run. The
 * production manifest (`retentionOwnerFunctions` / the grants file) gives the role
 * `SELECT, DELETE` and nothing more, and part 3 of the privileges check forbids any
 * column-level privilege other than `SELECT` outright — so this grant is not merely absent
 * today, the current model refuses to express it. Measured: under the production grant set
 * the redaction function raises `42501`, which `AC4 — the redaction path is INERT under the
 * production grant set` pins.
 *
 * Granting it here is therefore a TEST FIXTURE and never evidence about production. Whether
 * production should gain it is an owner decision (table-level `UPDATE` is wider than the
 * function needs; column-level is forbidden by part 3), and it is open — not something this
 * suite may settle by granting itself the privilege and going green.
 */
const PRODUCTION_WITHHELD_GRANT = `GRANT UPDATE (reason, actor_id, subject_user_id) ON job_queue_actions TO crm_retention_owner`
const PRODUCTION_WITHHELD_REVOKE = `REVOKE UPDATE (reason, actor_id, subject_user_id) ON job_queue_actions FROM crm_retention_owner`

/** Deploy roles this suite created and must therefore drop again. See `afterAll`. */
let rolesCreatedHere: readonly string[] = []

let pool: Pool

const q = (text: string, params: unknown[] = []) => pool.query(text, params)

/** Run a statement that MUST be rejected; return the error code and message. */
async function rejected(text: string, params: unknown[] = []) {
  try {
    await pool.query(text, params)
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { code: err.code, message: (err.message ?? '').split('\n')[0] }
  }
  throw new Error(`expected the database to reject: ${text}`)
}

async function rejectedOn(client: PoolClient, text: string, params: unknown[] = []) {
  try {
    await client.query(text, params)
  } catch (e) {
    const err = e as { code?: string; message?: string }
    return { code: err.code, message: (err.message ?? '').split('\n')[0] }
  }
  throw new Error(`expected the database to reject: ${text}`)
}

/**
 * Exercise a statement with `current_user = crm_retention_owner` — the identity the
 * trigger keys its exception on, and the identity a SECURITY DEFINER function runs
 * under. One dedicated connection, so a failed `SET ROLE` cannot leak into a pooled
 * client another test picks up.
 */
async function asRetentionOwner<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query(`SET ROLE crm_retention_owner`)
    return await fn(client)
  } finally {
    try {
      await client.query('RESET ROLE')
    } catch {
      /* the connection is being returned either way */
    }
    client.release()
  }
}

let seq = 0
const nextTag = () => {
  seq += 1
  return `${TAG}-${seq}`
}

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

/**
 * A valid action-log row. `created_at` is explicit so a test can place a row inside
 * or outside the two-year retention window — the schema's default is `now()`, and
 * backdating LATER is impossible by design (the trigger refuses every UPDATE but the
 * redaction), so the age has to be chosen at insert time.
 */
async function newAction(opts: {
  actorId: string
  opportunityId: string
  reason?: string | null
  age?: string
}): Promise<string> {
  const { rows } = await q(
    `INSERT INTO job_queue_actions
       (kind, opportunity_id, actor_id, scope_kind, before_version, after_version,
        idempotency_key, reason, created_at)
     VALUES ('DISMISSED', $1, $2, 'STUDIO', 0, 1, $3, $4, now() - $5::interval)
     RETURNING id`,
    [
      opts.opportunityId,
      opts.actorId,
      nextTag(),
      opts.reason === undefined ? `${TAG} reason` : opts.reason,
      opts.age ?? '0 seconds',
    ],
  )
  return rows[0].id as string
}

/**
 * A generation in its own fresh TEAM scope. TEAM rather than STUDIO deliberately:
 * `uq_job_queue_generations_published_studio` allows exactly ONE published STUDIO
 * generation in the whole database, so two tests that publish a STUDIO generation
 * collide on an index that has nothing to do with what they are testing (it cost
 * four red tests on the first run of this suite). The team-scoped partial unique is
 * per team, so a fresh team per generation keeps the tests independent.
 */
async function newGeneration(status: 'BUILDING' | 'PUBLISHED' | 'INVALIDATED' = 'BUILDING') {
  const team = await newTeam()
  const { rows } = await q(
    `INSERT INTO job_queue_generations
       (scope_kind, team_id, policy_signature, rule_version, evaluated_at, expires_at)
     VALUES ('TEAM', $2, $1, 'rank-v1', now(), now() + interval '1 hour')
     RETURNING id`,
    [`${TAG}:${nextTag()}`, team],
  )
  const id = rows[0].id as string
  if (status === 'PUBLISHED') {
    await q(`UPDATE job_queue_generations SET status='PUBLISHED', published_at=now() WHERE id=$1`, [
      id,
    ])
  } else if (status === 'INVALIDATED') {
    await q(
      `UPDATE job_queue_generations SET status='INVALIDATED', invalidated_at=now() WHERE id=$1`,
      [id],
    )
  }
  return id
}

let entryOrderKey = 0
async function newEntry(generationId: string, opportunityId: string) {
  entryOrderKey += 1
  await q(
    `INSERT INTO job_queue_generation_entries
       (generation_id, opportunity_id, rank_score, order_key, first_seen_at, opportunity_revision)
     VALUES ($1, $2, 10, $3, now(), 1)`,
    [generationId, opportunityId, entryOrderKey],
  )
}

/**
 * Apply a manual DDL file the way the deploy does — statement by statement, with
 * statement-level AUTOCOMMIT.
 *
 * It used to be ONE `pool.query(wholeFile)`, with a comment claiming the two were the
 * same. They are not: a multi-statement simple query runs as a SINGLE IMPLICIT
 * TRANSACTION, so everything this suite proves about idempotence — applying each file
 * twice — was proven under a transaction the deploy never has. A transaction is the more
 * forgiving of the two (a statement can lean on an uncommitted earlier one, and a failure
 * mid-file rolls the lot back instead of leaving the half state the file's header
 * discusses), so the weaker environment was the one being tested. `splitSqlStatements` is
 * the same mechanism `db-privileges.integration.spec.ts` and the forward-DDL spec use.
 */
const applyFile = async (path: string) => {
  await applyDeployDdlFile(pool, path)
}

async function triggerState(name: string, table: string): Promise<string | undefined> {
  const { rows } = await q(
    `SELECT t.tgenabled FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname='public' AND c.relname=$1 AND t.tgname=$2`,
    [table, name],
  )
  return rows[0]?.tgenabled as string | undefined
}

describe.skipIf(!hasDatabaseUrl())('job queue append-only triggers + R-B retention path', () => {
  let actor: string
  let opportunity: string

  beforeAll(async () => {
    await assertRealDbSchema([
      { table: 'job_queue_actions', column: 'idempotency_key' },
      { table: 'job_queue_generations', column: 'policy_signature' },
      { table: 'job_queue_generation_entries', column: 'order_key' },
    ])
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const { rows } = await q('SELECT current_database() AS db, version() AS v')
    if (rows[0].db === 'crm_db') throw new Error('refusing to run against the live crm_db')
    // Recorded in the run output on purpose: a writing spec states which database it
    // is writing to (two PostgreSQL instances answer on 5432 on this machine).
    console.log(`[1.3b] database=${rows[0].db} ${String(rows[0].v).split(',')[0]}`)

    // This suite's own precondition, not a sibling's leftover: the 1.3b DDL refuses to
    // apply unless `crm_retention_owner` and `crm_app` both exist, and before fix round 1
    // this file created NEITHER — run alone it died in `beforeAll` with
    // `required role(s) absent`. Both now come from the shipped roles file, so their
    // attributes have a single source of truth, and `afterAll` drops exactly the ones
    // this run created.
    rolesCreatedHere = await installDeployRoles(pool)

    // AC1 / AC7 — apply both files TWICE. The second pass is the idempotency proof
    // and also the repair path the deploy relies on.
    await applyFile(TRIGGERS_SQL)
    await applyFile(TRIGGERS_SQL)
    await applyFile(CHECK_SQL)
    await applyFile(CHECK_SQL)

    // 1.3c owns these grants in production; the suite needs them to drive the
    // trigger's admitted shapes directly. Scratch-database only, and `afterAll`
    // revokes them — see PRODUCTION GRANT SET in the header for why the UPDATE one in
    // particular must not outlive this suite.
    await q(`GRANT SELECT, INSERT, DELETE ON job_queue_actions TO crm_retention_owner`)
    await q(PRODUCTION_WITHHELD_GRANT)

    actor = await newUser('HR')
    opportunity = await newOpportunity()
  })

  afterAll(async () => {
    if (!pool) return
    try {
      // See the header: the only way to clean an append-only table is to be its owner.
      for (const name of ACTION_TRIGGERS) {
        await q(`ALTER TABLE job_queue_actions DISABLE TRIGGER ${name}`)
      }
      const users = `SELECT id FROM users WHERE email LIKE $1`
      await q(`DELETE FROM job_queue_actions WHERE actor_id IN (${users})`, [`${TAG}%`])
      await q(
        `UPDATE job_queue_generations SET status='INVALIDATED', invalidated_at=now()
          WHERE policy_signature LIKE $1 AND status <> 'INVALIDATED'`,
        [`${TAG}%`],
      )
      await q(`DELETE FROM job_queue_generations WHERE policy_signature LIKE $1`, [`${TAG}%`])
      await q(`DELETE FROM job_opportunities WHERE title LIKE $1`, [`${TAG}%`])
      await q(`DELETE FROM teams WHERE name LIKE $1`, [`${TAG}%`])
      await q(`DELETE FROM users WHERE email LIKE $1`, [`${TAG}%`])
    } finally {
      for (const name of ACTION_TRIGGERS) {
        await q(`ALTER TABLE job_queue_actions ENABLE ALWAYS TRIGGER ${name}`)
      }
      // The suite's last act: if the teardown left a guard off, this raises.
      await applyFile(CHECK_SQL)

      // Give back the fixture privileges. The UPDATE one especially: left behind, it
      // makes the redaction path look callable to every later reader of this cluster —
      // which is exactly the false impression that made three green redaction tests
      // read as evidence about production.
      await q(PRODUCTION_WITHHELD_REVOKE)
      await q(`REVOKE SELECT, INSERT, DELETE ON job_queue_actions FROM crm_retention_owner`)

      // Leave the cluster as this suite found it. A no-op on CI, where a sibling
      // creates the roles first; on a fresh cluster it is what stops this suite
      // leaking them.
      let leaked: string[] = []
      try {
        await dropRolesCreated(pool, rolesCreatedHere)
        if (rolesCreatedHere.length > 0) leaked = await existingDeployRoles(pool)
      } finally {
        await pool.end()
      }
      if (leaked.length > 0) {
        throw new Error(`teardown left role(s) behind in the cluster: ${leaked.join(', ')}`)
      }
    }
  })

  // -------------------------------------------------------------------------
  // AC1 — the triggers exist, in the right shapes, ENABLE ALWAYS
  // -------------------------------------------------------------------------
  describe('AC1 — trigger inventory', () => {
    it('installs seven guards, every one ENABLE ALWAYS', async () => {
      const { rows } = await q(
        `SELECT c.relname AS table_name, t.tgname, t.tgenabled,
                (t.tgtype & 1) <> 0  AS is_row,
                (t.tgtype & 2) <> 0  AS is_before,
                (t.tgtype & 4) <> 0  AS on_insert,
                (t.tgtype & 8) <> 0  AS on_delete,
                (t.tgtype & 16) <> 0 AS on_update,
                (t.tgtype & 32) <> 0 AS on_truncate
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND NOT t.tgisinternal
            AND t.tgname LIKE 'trg_job_queue%'
          ORDER BY c.relname, t.tgname`,
      )
      expect(rows.map((r) => r.tgname)).toEqual([
        'trg_job_queue_actions_append_only',
        'trg_job_queue_actions_no_truncate',
        'trg_job_queue_generation_entries_building_only',
        'trg_job_queue_generation_entries_immutable',
        'trg_job_queue_generation_entries_no_truncate',
        'trg_job_queue_generations_frozen',
        'trg_job_queue_generations_purge_invalidated_only',
      ])
      // ENABLE ALWAYS ('A') on every one — the default 'O' is skipped under
      // session_replication_role = replica, which is the bypass this closes.
      expect(rows.every((r) => r.tgenabled === 'A')).toBe(true)
      expect(rows.every((r) => r.is_before)).toBe(true)

      const byName = Object.fromEntries(rows.map((r) => [r.tgname, r]))
      // The audit log: one row trigger for UPDATE OR DELETE, one statement trigger
      // for TRUNCATE (a row-level DELETE trigger does NOT fire on TRUNCATE).
      expect(byName['trg_job_queue_actions_append_only']).toMatchObject({
        is_row: true,
        on_update: true,
        on_delete: true,
        on_insert: false,
        on_truncate: false,
      })
      expect(byName['trg_job_queue_actions_no_truncate']).toMatchObject({
        is_row: false,
        on_truncate: true,
      })
      expect(byName['trg_job_queue_generation_entries_no_truncate']).toMatchObject({
        is_row: false,
        on_truncate: true,
      })
      expect(byName['trg_job_queue_generation_entries_building_only']).toMatchObject({
        is_row: true,
        on_insert: true,
        on_update: false,
        on_delete: false,
      })
    })

    it('refuses an UPDATE even under session_replication_role = replica (ENABLE ALWAYS)', async () => {
      const id = await newAction({ actorId: actor, opportunityId: opportunity })
      const client = await pool.connect()
      try {
        await client.query(`SET session_replication_role = replica`)
        const err = await rejectedOn(client, `UPDATE job_queue_actions SET reason=$1 WHERE id=$2`, [
          `${TAG} rewritten`,
          id,
        ])
        expect(err.code).toBe(RESTRICT_VIOLATION)
      } finally {
        await client.query(`RESET session_replication_role`)
        client.release()
      }
    })
  })

  // -------------------------------------------------------------------------
  // The append-only log
  // -------------------------------------------------------------------------
  describe('job_queue_actions is append-only', () => {
    it('accepts an INSERT', async () => {
      const id = await newAction({ actorId: actor, opportunityId: opportunity })
      const { rows } = await q(`SELECT count(*)::int AS n FROM job_queue_actions WHERE id=$1`, [id])
      expect(rows[0].n).toBe(1)
    })

    it('refuses an UPDATE', async () => {
      const id = await newAction({ actorId: actor, opportunityId: opportunity })
      const err = await rejected(`UPDATE job_queue_actions SET reason=$1 WHERE id=$2`, [
        `${TAG} rewritten`,
        id,
      ])
      expect(err.code).toBe(RESTRICT_VIOLATION)
      expect(err.message).toContain('append-only')
    })

    it('refuses a DELETE', async () => {
      const id = await newAction({ actorId: actor, opportunityId: opportunity })
      const err = await rejected(`DELETE FROM job_queue_actions WHERE id=$1`, [id])
      expect(err.code).toBe(RESTRICT_VIOLATION)
      const { rows } = await q(`SELECT count(*)::int AS n FROM job_queue_actions WHERE id=$1`, [id])
      expect(rows[0].n).toBe(1)
    })

    it('refuses a TRUNCATE', async () => {
      const err = await rejected(`TRUNCATE job_queue_actions`)
      expect(err.code).toBe(RESTRICT_VIOLATION)
      expect(err.message).toContain('TRUNCATE refused')
    })
  })

  // -------------------------------------------------------------------------
  // AC2 — the entries guard: direct DELETE refused, both cascades allowed
  // -------------------------------------------------------------------------
  describe('AC2 — job_queue_generation_entries: direct DELETE vs the two cascades', () => {
    it('refuses a DIRECT delete (both parents still exist)', async () => {
      const gen = await newGeneration('BUILDING')
      const opp = await newOpportunity()
      await newEntry(gen, opp)
      const err = await rejected(
        `DELETE FROM job_queue_generation_entries WHERE generation_id=$1 AND opportunity_id=$2`,
        [gen, opp],
      )
      expect(err.code).toBe(RESTRICT_VIOLATION)
      expect(err.message).toContain('direct DELETE refused')
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM job_queue_generation_entries WHERE generation_id=$1`,
        [gen],
      )
      expect(rows[0].n).toBe(1)
    })

    it('allows the cascade from a purged generation', async () => {
      const gen = await newGeneration('BUILDING')
      const opp = await newOpportunity()
      await newEntry(gen, opp)
      await q(
        `UPDATE job_queue_generations SET status='INVALIDATED', invalidated_at=now() WHERE id=$1`,
        [gen],
      )
      await q(`DELETE FROM job_queue_generations WHERE id=$1`, [gen])
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM job_queue_generation_entries WHERE generation_id=$1`,
        [gen],
      )
      expect(rows[0].n).toBe(0)
    })

    it('allows the cascade from a deleted opportunity', async () => {
      const gen = await newGeneration('BUILDING')
      const opp = await newOpportunity()
      await newEntry(gen, opp)
      await q(`DELETE FROM job_opportunities WHERE id=$1`, [opp])
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM job_queue_generation_entries WHERE opportunity_id=$1`,
        [opp],
      )
      expect(rows[0].n).toBe(0)
    })

    it('refuses an UPDATE of an entry', async () => {
      const gen = await newGeneration('BUILDING')
      const opp = await newOpportunity()
      await newEntry(gen, opp)
      const err = await rejected(
        `UPDATE job_queue_generation_entries SET rank_score=99 WHERE generation_id=$1`,
        [gen],
      )
      expect(err.code).toBe(RESTRICT_VIOLATION)
      expect(err.message).toContain('immutable')
    })

    it('refuses a TRUNCATE of the entries', async () => {
      const err = await rejected(`TRUNCATE job_queue_generation_entries`)
      expect(err.code).toBe(RESTRICT_VIOLATION)
    })
  })

  // -------------------------------------------------------------------------
  // AC3 — the four generation controls, each with an accepted and a refused case
  // -------------------------------------------------------------------------
  describe('AC3 — generation team-boundary controls', () => {
    it('accepts an entry INSERT while BUILDING and refuses it afterwards', async () => {
      const gen = await newGeneration('BUILDING')
      const opp = await newOpportunity()
      await newEntry(gen, opp) // accepted

      await q(
        `UPDATE job_queue_generations SET status='PUBLISHED', published_at=now() WHERE id=$1`,
        [gen],
      )
      const opp2 = await newOpportunity()
      entryOrderKey += 1
      const err = await rejected(
        `INSERT INTO job_queue_generation_entries
           (generation_id, opportunity_id, rank_score, order_key, first_seen_at, opportunity_revision)
         VALUES ($1, $2, 10, $3, now(), 1)`,
        [gen, opp2, entryOrderKey],
      )
      expect(err.code).toBe(RESTRICT_VIOLATION)
      expect(err.message).toContain('not BUILDING')
    })

    it('leaves a missing generation to the foreign key, not to the guard', async () => {
      const opp = await newOpportunity()
      entryOrderKey += 1
      const err = await rejected(
        `INSERT INTO job_queue_generation_entries
           (generation_id, opportunity_id, rank_score, order_key, first_seen_at, opportunity_revision)
         VALUES ($1, $2, 10, $3, now(), 1)`,
        [randomUUID(), opp, entryOrderKey],
      )
      expect(err.code).toBe(FK_VIOLATION)
    })

    it('freezes scope_kind, team_id and expires_at, while allowing other columns to move', async () => {
      const gen = await newGeneration('BUILDING') // TEAM-scoped, see newGeneration
      const otherTeam = await newTeam()

      // Widening a TEAM generation to STUDIO is the disclosure move: every team's
      // rows in one list.
      const scope = await rejected(
        `UPDATE job_queue_generations SET scope_kind='STUDIO', team_id=NULL WHERE id=$1`,
        [gen],
      )
      expect(scope.code).toBe(RESTRICT_VIOLATION)
      expect(scope.message).toContain('scope_kind is frozen')

      const teamOnly = await rejected(`UPDATE job_queue_generations SET team_id=$2 WHERE id=$1`, [
        gen,
        otherTeam,
      ])
      expect(teamOnly.code).toBe(RESTRICT_VIOLATION)
      expect(teamOnly.message).toContain('team_id is frozen')

      const expiry = await rejected(
        `UPDATE job_queue_generations SET expires_at = now() + interval '10 years' WHERE id=$1`,
        [gen],
      )
      expect(expiry.code).toBe(RESTRICT_VIOLATION)
      expect(expiry.message).toContain('expires_at is frozen')

      // Accepted: an UPDATE that touches none of the three and does not move status.
      await q(`UPDATE job_queue_generations SET rule_version='rank-v2' WHERE id=$1`, [gen])
      const { rows } = await q(`SELECT rule_version FROM job_queue_generations WHERE id=$1`, [gen])
      expect(rows[0].rule_version).toBe('rank-v2')
    })

    it('makes status one-way', async () => {
      const a = await newGeneration('BUILDING')
      await q(
        `UPDATE job_queue_generations SET status='PUBLISHED', published_at=now() WHERE id=$1`,
        [a],
      )
      const back = await rejected(
        `UPDATE job_queue_generations SET status='BUILDING' WHERE id=$1`,
        [a],
      )
      expect(back.code).toBe(RESTRICT_VIOLATION)
      expect(back.message).toContain('transition')

      await q(
        `UPDATE job_queue_generations SET status='INVALIDATED', invalidated_at=now() WHERE id=$1`,
        [a],
      )
      const revive = await rejected(
        `UPDATE job_queue_generations SET status='PUBLISHED' WHERE id=$1`,
        [a],
      )
      expect(revive.code).toBe(RESTRICT_VIOLATION)

      // BUILDING -> INVALIDATED directly is the abandon path, and is allowed.
      const b = await newGeneration('BUILDING')
      await q(
        `UPDATE job_queue_generations SET status='INVALIDATED', invalidated_at=now() WHERE id=$1`,
        [b],
      )
      const { rows } = await q(`SELECT status FROM job_queue_generations WHERE id=$1`, [b])
      expect(rows[0].status).toBe('INVALIDATED')
    })

    it('refuses the DELETE of a generation that is not INVALIDATED, and allows it after', async () => {
      const gen = await newGeneration('PUBLISHED')
      const err = await rejected(`DELETE FROM job_queue_generations WHERE id=$1`, [gen])
      expect(err.code).toBe(RESTRICT_VIOLATION)
      expect(err.message).toContain('not INVALIDATED')

      await q(
        `UPDATE job_queue_generations SET status='INVALIDATED', invalidated_at=now() WHERE id=$1`,
        [gen],
      )
      await q(`DELETE FROM job_queue_generations WHERE id=$1`, [gen])
      const { rows } = await q(`SELECT count(*)::int AS n FROM job_queue_generations WHERE id=$1`, [
        gen,
      ])
      expect(rows[0].n).toBe(0)
    })

    it("refuses a TEAM delete until that team's generations are invalidated (the stated consequence)", async () => {
      const team = await newTeam()
      const { rows: g } = await q(
        `INSERT INTO job_queue_generations
           (scope_kind, team_id, policy_signature, rule_version, evaluated_at, expires_at)
         VALUES ('TEAM', $1, $2, 'rank-v1', now(), now() + interval '1 hour') RETURNING id`,
        [team, `${TAG}:${nextTag()}`],
      )
      const gen = g[0].id as string

      const err = await rejected(`DELETE FROM teams WHERE id=$1`, [team])
      expect(err.code).toBe(RESTRICT_VIOLATION)

      await q(
        `UPDATE job_queue_generations SET status='INVALIDATED', invalidated_at=now() WHERE id=$1`,
        [gen],
      )
      await q(`DELETE FROM teams WHERE id=$1`, [team])
      const { rows } = await q(`SELECT count(*)::int AS n FROM teams WHERE id=$1`, [team])
      expect(rows[0].n).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // The TOCTOU race (review finding, 2026-10-18) — two connections, deliberately
  // interleaved. Fails against the unlocked read; passes with `FOR SHARE`.
  // -------------------------------------------------------------------------
  describe('two-connection race — the entry INSERT guard holds under concurrency', () => {
    it('refuses an entry whose generation is published while the insert is in flight', async () => {
      const gen = await newGeneration('BUILDING')
      const opp = await newOpportunity()
      const t1 = await pool.connect()
      const t2 = await pool.connect()
      try {
        // T2 publishes and HOLDS the transaction: it owns FOR NO KEY UPDATE on the
        // generation row. Without `FOR SHARE` in the guard, T1's insert does not even
        // wait (the FK's FOR KEY SHARE does not conflict), reads the pre-publish
        // status and lands an entry inside a PUBLISHED generation — MEASURED before
        // the fix. With it, T1 waits, then re-reads the committed PUBLISHED and raises.
        await t2.query('BEGIN')
        await t2.query(
          `UPDATE job_queue_generations SET status='PUBLISHED', published_at=now() WHERE id=$1`,
          [gen],
        )

        await t1.query('BEGIN')
        entryOrderKey += 1
        const inserting = t1
          .query(
            `INSERT INTO job_queue_generation_entries
               (generation_id, opportunity_id, rank_score, order_key, first_seen_at, opportunity_revision)
             VALUES ($1, $2, 10, $3, now(), 1)`,
            [gen, opp, entryOrderKey],
          )
          .then(
            () => ({ ok: true as const }),
            (e: { code?: string; message?: string }) => ({
              ok: false as const,
              code: e.code,
              message: (e.message ?? '').split('\n')[0],
            }),
          )

        // Give T1 time to reach the lock; then let T2 commit.
        await new Promise((r) => setTimeout(r, 400))
        const { rows: waiting } = await q(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND state = 'active'
              AND query ILIKE 'INSERT INTO job_queue_generation_entries%'`,
        )
        expect(waiting[0].n).toBeGreaterThan(0) // the guard made the writer wait
        await t2.query('COMMIT')

        const result = await inserting
        expect(result.ok).toBe(false)
        expect(result).toMatchObject({ code: RESTRICT_VIOLATION })
        expect(result.ok === false ? result.message : '').toContain('not BUILDING')
        await t1.query('ROLLBACK')
      } finally {
        t1.release()
        t2.release()
      }

      const { rows } = await q(
        `SELECT count(*)::int AS n FROM job_queue_generation_entries WHERE generation_id=$1`,
        [gen],
      )
      expect(rows[0].n).toBe(0)
    })

    it('makes a concurrent publish wait for an in-flight insert, and the entry lands legitimately', async () => {
      const gen = await newGeneration('BUILDING')
      const opp = await newOpportunity()
      const t1 = await pool.connect()
      const t2 = await pool.connect()
      try {
        await t1.query('BEGIN')
        entryOrderKey += 1
        await t1.query(
          `INSERT INTO job_queue_generation_entries
             (generation_id, opportunity_id, rank_score, order_key, first_seen_at, opportunity_revision)
           VALUES ($1, $2, 10, $3, now(), 1)`,
          [gen, opp, entryOrderKey],
        )

        await t2.query('BEGIN')
        const publishing = t2
          .query(
            `UPDATE job_queue_generations SET status='PUBLISHED', published_at=now() WHERE id=$1`,
            [gen],
          )
          .then(() => true)

        await new Promise((r) => setTimeout(r, 400))
        const { rows: waiting } = await q(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event_type = 'Lock' AND state = 'active'
              AND query ILIKE 'UPDATE job_queue_generations%'`,
        )
        expect(waiting[0].n).toBeGreaterThan(0) // the publish is the one that waits

        await t1.query('COMMIT')
        await publishing
        await t2.query('COMMIT')
      } finally {
        t1.release()
        t2.release()
      }

      // The entry was inserted while the generation was BUILDING and the publish
      // happened after — the legitimate order, so the row stays.
      const { rows } = await q(
        `SELECT g.status, count(e.*)::int AS entries
           FROM job_queue_generations g
           LEFT JOIN job_queue_generation_entries e ON e.generation_id = g.id
          WHERE g.id=$1 GROUP BY g.status`,
        [gen],
      )
      expect(rows[0]).toMatchObject({ status: 'PUBLISHED', entries: 1 })
    })
  })

  // -------------------------------------------------------------------------
  // AC4 — the R-B retention path
  // -------------------------------------------------------------------------
  describe('AC4 — R-B: the two SECURITY DEFINER functions', () => {
    it('purges an expired row and leaves a fresh one', async () => {
      const expired = await newAction({
        actorId: actor,
        opportunityId: opportunity,
        age: '3 years',
      })
      const fresh = await newAction({ actorId: actor, opportunityId: opportunity })

      const { rows } = await q(`SELECT crm_retention_purge_job_queue_actions() AS purged`)
      expect(Number(rows[0].purged)).toBeGreaterThanOrEqual(1)

      const { rows: after } = await q(
        `SELECT count(*)::int AS n FROM job_queue_actions WHERE id = ANY($1::uuid[])`,
        [[expired, fresh]],
      )
      expect(after[0].n).toBe(1)
      const { rows: survivor } = await q(
        `SELECT count(*)::int AS n FROM job_queue_actions WHERE id=$1`,
        [fresh],
      )
      expect(survivor[0].n).toBe(1)
    })

    it('redacts a reason to the fixed token and nothing else', async () => {
      const id = await newAction({
        actorId: actor,
        opportunityId: opportunity,
        reason: `${TAG} a name somebody typed`,
      })
      const { rows: before } = await q(`SELECT * FROM job_queue_actions WHERE id=$1`, [id])

      const { rows } = await q(`SELECT crm_retention_redact_action_reason($1, $2) AS redacted`, [
        id,
        'dsr-2026-001',
      ])
      expect(rows[0].redacted).toBe(true)

      const { rows: after } = await q(`SELECT * FROM job_queue_actions WHERE id=$1`, [id])
      expect(after[0].reason).toBe(REDACTION_TOKEN)
      // Every other column is untouched — the shape the trigger enforces.
      for (const [key, value] of Object.entries(before[0] as Record<string, unknown>)) {
        if (key === 'reason') continue
        expect(after[0][key]).toEqual(value)
      }
    })

    it('is idempotent on an already-redacted row (no second write)', async () => {
      const id = await newAction({ actorId: actor, opportunityId: opportunity })
      await q(`SELECT crm_retention_redact_action_reason($1, $2)`, [id, 'dsr-2026-002'])
      const { rows } = await q(`SELECT crm_retention_redact_action_reason($1, $2) AS redacted`, [
        id,
        'dsr-2026-002',
      ])
      expect(rows[0].redacted).toBe(false)
    })

    it('validates its arguments (condition 3: bounded, non-blank)', async () => {
      const id = await newAction({ actorId: actor, opportunityId: opportunity })
      const blank = await rejected(`SELECT crm_retention_redact_action_reason($1, $2)`, [id, '   '])
      expect(blank.code).toBe(INVALID_PARAMETER)
      const tooLong = await rejected(`SELECT crm_retention_redact_action_reason($1, $2)`, [
        id,
        'x'.repeat(201),
      ])
      expect(tooLong.code).toBe(INVALID_PARAMETER)
      const noId = await rejected(`SELECT crm_retention_redact_action_reason(NULL, $1)`, ['dsr'])
      expect(noId.code).toBe(INVALID_PARAMETER)
    })

    it('pins the six conditions in the catalog', async () => {
      const { rows } = await q(
        `SELECT p.proname,
                p.prosecdef,
                pg_get_userbyid(p.proowner) AS owner,
                p.proconfig,
                p.prosrc NOT ILIKE '%EXECUTE %' AS no_dynamic_sql
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' AND p.proname LIKE 'crm_retention_%'
          ORDER BY p.proname`,
      )
      expect(rows).toHaveLength(2)
      for (const row of rows) {
        expect(row.prosecdef).toBe(true) // (1)
        expect(row.owner).toBe('crm_retention_owner') // (1)
        // (2) pinned, and pg_temp LAST — the ordering is the protection, see below.
        expect(row.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp'])
        expect(row.no_dynamic_sql).toBe(true) // (3)
      }

      // (4) EXECUTE to crm_app by name, and not to PUBLIC.
      const { rows: acl } = await q(
        `SELECT p.proname, pg_get_userbyid(a.grantee) AS grantee, a.privilege_type
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           CROSS JOIN LATERAL aclexplode(p.proacl) a
          WHERE n.nspname='public' AND p.proname LIKE 'crm_retention_%' AND a.grantee <> 0
          ORDER BY p.proname, grantee`,
      )
      const grantees = new Set(acl.map((r) => r.grantee))
      expect(grantees.has('crm_app')).toBe(true)
      expect([...grantees].sort()).toEqual(['crm_app', 'crm_retention_owner'])
      const { rows: pub } = await q(
        `SELECT count(*)::int AS n
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           CROSS JOIN LATERAL aclexplode(p.proacl) a
          WHERE n.nspname='public' AND p.proname LIKE 'crm_retention_%' AND a.grantee = 0`,
      )
      expect(pub[0].n).toBe(0)
    })

    it('reads the REAL table, not a temp table shadowing it (search_path ends with pg_temp)', async () => {
      // The attack the security review demonstrated: a definer function whose
      // search_path does not name pg_temp explicitly searches the temporary schema
      // FIRST, so the caller can shadow the table the function means to read. Here
      // the function's references are unqualified ON PURPOSE (see the DDL header), so
      // this test fails the moment the `SET search_path` is dropped.
      const expired = await newAction({
        actorId: actor,
        opportunityId: opportunity,
        age: '3 years',
      })
      const client = await pool.connect()
      try {
        await client.query(
          `CREATE TEMP TABLE job_queue_actions (id uuid primary key, created_at timestamptz)`,
        )
        await client.query(`INSERT INTO job_queue_actions (id, created_at) VALUES ($1, now())`, [
          randomUUID(),
        ])
        const { rows: shadow } = await client.query(
          `SELECT count(*)::int AS n FROM pg_temp.job_queue_actions`,
        )
        expect(shadow[0].n).toBe(1) // the shadow really is in place

        const { rows } = await client.query(
          `SELECT crm_retention_purge_job_queue_actions() AS purged`,
        )
        // It purged the REAL expired row...
        expect(Number(rows[0].purged)).toBeGreaterThanOrEqual(1)
        const { rows: gone } = await q(
          `SELECT count(*)::int AS n FROM public.job_queue_actions WHERE id=$1`,
          [expired],
        )
        expect(gone[0].n).toBe(0)
        // ...and left the caller's temp table alone.
        const { rows: temp } = await client.query(
          `SELECT count(*)::int AS n FROM pg_temp.job_queue_actions`,
        )
        expect(temp[0].n).toBe(1)
      } finally {
        await client.query(`DROP TABLE IF EXISTS pg_temp.job_queue_actions`)
        client.release()
      }
    })

    it('redaction also reads the REAL table, not a temp table shadowing it', async () => {
      // The same test as the one above, for the other definer function. `redact` has the
      // same unqualified references and the same `SET search_path`, so it has the same
      // exposure and deserves the same proof; until fix round 1 only `purge` had one,
      // which made the pin look like a property of the pair when it was a property of one.
      const id = await newAction({
        actorId: actor,
        opportunityId: opportunity,
        reason: `${TAG} a name somebody typed`,
      })
      const decoy = randomUUID()
      const client = await pool.connect()
      try {
        await client.query(`CREATE TEMP TABLE job_queue_actions (id uuid primary key, reason text)`)
        await client.query(`INSERT INTO job_queue_actions (id, reason) VALUES ($1, $2)`, [
          decoy,
          'untouched',
        ])

        const { rows } = await client.query(
          `SELECT crm_retention_redact_action_reason($1, $2) AS redacted`,
          [id, 'dsr-2026-shadow'],
        )
        expect(rows[0].redacted).toBe(true)

        // The REAL row was redacted...
        const { rows: real } = await q(`SELECT reason FROM public.job_queue_actions WHERE id=$1`, [
          id,
        ])
        expect(real[0].reason).toBe(REDACTION_TOKEN)
        // ...and the caller's temp table was left alone.
        const { rows: temp } = await client.query(
          `SELECT reason FROM pg_temp.job_queue_actions WHERE id=$1`,
          [decoy],
        )
        expect(temp[0].reason).toBe('untouched')
      } finally {
        await client.query(`DROP TABLE IF EXISTS pg_temp.job_queue_actions`)
        client.release()
      }
    })

    it('is INERT under the PRODUCTION grant set: the redaction raises 42501', async () => {
      // THE TEST THAT SPEAKS ABOUT PRODUCTION. The three redaction tests above run with
      // `PRODUCTION_WITHHELD_GRANT` in place, so what they establish is the function's
      // LOGIC on a grant set production does not have. Production gives the role
      // `SELECT, DELETE`; with only those, the function cannot write and raises `42501`.
      // That inert state is the deployed reality until the owner decides the grant
      // question, and it is pinned here so the decision cannot be made by accident —
      // if someone grants the privilege in production, THIS test goes red and says so.
      const id = await newAction({
        actorId: actor,
        opportunityId: opportunity,
        reason: `${TAG} still here`,
      })
      await q(PRODUCTION_WITHHELD_REVOKE)
      try {
        const err = await rejected(`SELECT crm_retention_redact_action_reason($1, $2)`, [
          id,
          'dsr-2026-inert',
        ])
        expect(err.code).toBe(INSUFFICIENT_PRIVILEGE)
        // And the reason it could not rewrite is still the original.
        const { rows } = await q(`SELECT reason FROM job_queue_actions WHERE id=$1`, [id])
        expect(rows[0].reason).toBe(`${TAG} still here`)
      } finally {
        await q(PRODUCTION_WITHHELD_GRANT)
      }
    })
  })

  // -------------------------------------------------------------------------
  // The two-year retention boundary — an OWNER DECISION, recorded in the legal
  // memo, and until fix round 1 pinned by nothing: four mutations of it stayed
  // green. Each test below is named by the mutation it kills, and the interval
  // lives in TWO places (the trigger and the purge function), so both are pinned.
  //
  // `729 days` is the "one day short" age: two calendar years is 730 or 731 days,
  // so a 729-day-old row is inside the window — and it is well past ONE year, which
  // is what makes a widened interval visible instead of silently agreeing.
  // -------------------------------------------------------------------------
  describe('the two-year retention boundary', () => {
    const countOf = async (id: string): Promise<number> => {
      const { rows } = await q(`SELECT count(*)::int AS n FROM job_queue_actions WHERE id=$1`, [id])
      return rows[0].n as number
    }

    it('trigger: refuses the retention owner deleting a row one day SHORT of two years', async () => {
      // Kills: the trigger's `interval '2 years'` widened to `'1 year'`.
      const id = await newAction({ actorId: actor, opportunityId: opportunity, age: '729 days' })
      const err = await asRetentionOwner((c) =>
        rejectedOn(c, `DELETE FROM job_queue_actions WHERE id=$1`, [id]),
      )
      expect(err.code).toBe(RESTRICT_VIOLATION)
      expect(await countOf(id)).toBe(1)
    })

    it('purge: leaves a row one day SHORT of two years', async () => {
      // Kills: the purge function's `interval '2 years'` narrowed to `'1 year'`.
      const id = await newAction({ actorId: actor, opportunityId: opportunity, age: '729 days' })
      await q(`SELECT crm_retention_purge_job_queue_actions()`)
      expect(await countOf(id)).toBe(1)
    })

    it('purge: deletes a row one day PAST two years', async () => {
      // Kills: the purge function's `interval '2 years'` widened to `'3 years'`.
      const id = await newAction({
        actorId: actor,
        opportunityId: opportunity,
        age: '2 years 1 day',
      })
      await q(`SELECT crm_retention_purge_job_queue_actions()`)
      expect(await countOf(id)).toBe(0)
    })

    it('redaction: refuses a NULL request id', async () => {
      // Kills: deleting the `p_request_id IS NULL` operand from the validation. Without
      // it, every other term of the condition evaluates to NULL for a NULL argument
      // (`NULL !~ '…'` and `length(NULL) > 200` are both NULL), so the whole guard is
      // NULL — not TRUE — and an unattributed redaction is accepted. The request id is
      // the only record of WHO asked for an audit-log row to be rewritten.
      const id = await newAction({ actorId: actor, opportunityId: opportunity })
      const err = await rejected(`SELECT crm_retention_redact_action_reason($1, NULL)`, [id])
      expect(err.code).toBe(INVALID_PARAMETER)
      const { rows } = await q(`SELECT reason FROM job_queue_actions WHERE id=$1`, [id])
      expect(rows[0].reason).not.toBe(REDACTION_TOKEN)
    })
  })

  // -------------------------------------------------------------------------
  // The refused near-misses: the trigger validates SHAPE, not just identity
  // (ADR §3 condition 5 — independently of the functions)
  // -------------------------------------------------------------------------
  describe('the trigger bounds the exception by shape, not only by identity', () => {
    it('refuses the retention owner deleting a row that is not yet expired', async () => {
      const id = await newAction({ actorId: actor, opportunityId: opportunity })
      const err = await asRetentionOwner((c) =>
        rejectedOn(c, `DELETE FROM job_queue_actions WHERE id=$1`, [id]),
      )
      expect(err.code).toBe(RESTRICT_VIOLATION)
    })

    it('allows the retention owner deleting an expired row (the admitted shape)', async () => {
      const id = await newAction({
        actorId: actor,
        opportunityId: opportunity,
        age: '2 years 1 day',
      })
      await asRetentionOwner((c) => c.query(`DELETE FROM job_queue_actions WHERE id=$1`, [id]))
      const { rows } = await q(`SELECT count(*)::int AS n FROM job_queue_actions WHERE id=$1`, [id])
      expect(rows[0].n).toBe(0)
    })

    it('refuses a reason set to anything but the fixed token', async () => {
      const id = await newAction({ actorId: actor, opportunityId: opportunity })
      const err = await asRetentionOwner((c) =>
        rejectedOn(c, `UPDATE job_queue_actions SET reason=$1 WHERE id=$2`, ['something else', id]),
      )
      expect(err.code).toBe(RESTRICT_VIOLATION)
    })

    it('refuses a redaction that also moves another column', async () => {
      const id = await newAction({ actorId: actor, opportunityId: opportunity })
      const other = await newUser('HR')
      const err = await asRetentionOwner((c) =>
        rejectedOn(c, `UPDATE job_queue_actions SET reason=$1, actor_id=$2 WHERE id=$3`, [
          REDACTION_TOKEN,
          other,
          id,
        ]),
      )
      expect(err.code).toBe(RESTRICT_VIOLATION)
    })

    it('refuses a second redaction of an already-redacted row', async () => {
      // The trigger's job, not the function's: a re-redaction changes nothing and
      // would still write a new row version into an append-only table. Driven
      // DIRECTLY (ADR §3 condition 5) because the function's own WHERE clause filters
      // this case out, so going through the function proves nothing about the trigger
      // — which is exactly what the operand-deletion pass showed.
      const id = await newAction({ actorId: actor, opportunityId: opportunity })
      await q(`SELECT crm_retention_redact_action_reason($1, $2)`, [id, 'dsr-2026-003'])
      const err = await asRetentionOwner((c) =>
        rejectedOn(c, `UPDATE job_queue_actions SET reason=$1 WHERE id=$2`, [REDACTION_TOKEN, id]),
      )
      expect(err.code).toBe(RESTRICT_VIOLATION)
    })

    it('refuses a redaction of a row whose reason is already NULL', async () => {
      const id = await newAction({ actorId: actor, opportunityId: opportunity, reason: null })
      const err = await asRetentionOwner((c) =>
        rejectedOn(c, `UPDATE job_queue_actions SET reason=$1 WHERE id=$2`, [REDACTION_TOKEN, id]),
      )
      expect(err.code).toBe(RESTRICT_VIOLATION)
    })

    it('refuses the same shapes from a session that is not the retention owner', async () => {
      const id = await newAction({
        actorId: actor,
        opportunityId: opportunity,
        age: '3 years',
      })
      const del = await rejected(`DELETE FROM job_queue_actions WHERE id=$1`, [id])
      expect(del.code).toBe(RESTRICT_VIOLATION)
      const upd = await rejected(`UPDATE job_queue_actions SET reason=$1 WHERE id=$2`, [
        REDACTION_TOKEN,
        id,
      ])
      expect(upd.code).toBe(RESTRICT_VIOLATION)
    })

    it('refuses EXECUTE on the retention functions to a role that was not granted it', async () => {
      // crm_collector holds nothing on the log (ADR §3 layer 1) and must not be able
      // to reach the exception through the function either.
      const client = await pool.connect()
      try {
        await client.query(`SET ROLE crm_collector`)
        const err = await rejectedOn(client, `SELECT crm_retention_purge_job_queue_actions()`)
        expect(err.code).toBe(INSUFFICIENT_PRIVILEGE)
      } finally {
        await client.query('RESET ROLE')
        client.release()
      }
    })
  })

  // -------------------------------------------------------------------------
  // AC5 — the catalog check fails on drift
  // -------------------------------------------------------------------------
  describe('AC5 — the catalog check', () => {
    it('passes on a correctly applied database', async () => {
      // It RAISES on any problem, so reaching the assertion is the result.
      await expect(applyFile(CHECK_SQL)).resolves.toBeUndefined()
    })

    it('fails when a guard is disabled, and re-applying the DDL repairs it', async () => {
      await q(`ALTER TABLE job_queue_actions DISABLE TRIGGER trg_job_queue_actions_append_only`)
      expect(await triggerState('trg_job_queue_actions_append_only', 'job_queue_actions')).toBe('D')
      try {
        const err = await rejected(readFileSync(CHECK_SQL, 'utf8'))
        expect(err.message).toContain('not ENABLE ALWAYS')
      } finally {
        await applyFile(TRIGGERS_SQL)
      }
      expect(await triggerState('trg_job_queue_actions_append_only', 'job_queue_actions')).toBe('A')
      await applyFile(CHECK_SQL)
    })

    it('fails when a guard is dropped', async () => {
      await q(`DROP TRIGGER trg_job_queue_generations_frozen ON job_queue_generations`)
      try {
        const err = await rejected(readFileSync(CHECK_SQL, 'utf8'))
        expect(err.message).toContain('is MISSING')
      } finally {
        await applyFile(TRIGGERS_SQL)
      }
      await applyFile(CHECK_SQL)
    })

    it('fails when a function body changes outside a reviewed file (checksum drift)', async () => {
      await q(`
        CREATE OR REPLACE FUNCTION public.crm_retention_purge_job_queue_actions()
        RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = pg_catalog, public, pg_temp
        AS $drift$
        BEGIN
          -- a widened window: exactly the change the checksum exists to catch
          DELETE FROM job_queue_actions WHERE created_at <= now() - interval '1 day';
          RETURN 0;
        END
        $drift$;
      `)
      try {
        const err = await rejected(readFileSync(CHECK_SQL, 'utf8'))
        expect(err.message).toContain('body checksum')
      } finally {
        await applyFile(TRIGGERS_SQL)
      }
      await applyFile(CHECK_SQL)
    })

    it('fails when a TRIGGER guard body changes (condition 5 is pinned too)', async () => {
      // The trigger holds the shape validation, so pinning only the two R-B function
      // bodies would pin the wiring and not the content: this body change keeps every
      // trigger in place and ENABLE ALWAYS while gutting the guard.
      await q(`
        CREATE OR REPLACE FUNCTION public.job_queue_generations_purge_invalidated_only()
        RETURNS trigger LANGUAGE plpgsql
        SET search_path = pg_catalog, public, pg_temp
        AS $drift$
        BEGIN
          RETURN OLD; -- every generation becomes deletable
        END
        $drift$;
      `)
      try {
        const err = await rejected(readFileSync(CHECK_SQL, 'utf8'))
        expect(err.message).toContain('trigger function')
        expect(err.message).toContain('body checksum')
      } finally {
        await applyFile(TRIGGERS_SQL)
      }
      await applyFile(CHECK_SQL)
    })

    it('fails when the pinned search_path is removed', async () => {
      await q(
        `ALTER FUNCTION public.crm_retention_redact_action_reason(uuid, text) RESET search_path`,
      )
      try {
        const err = await rejected(readFileSync(CHECK_SQL, 'utf8'))
        expect(err.message).toContain('proconfig')
      } finally {
        await applyFile(TRIGGERS_SQL)
      }
      await applyFile(CHECK_SQL)
    })

    it('fails when EXECUTE is granted to PUBLIC', async () => {
      await q(`GRANT EXECUTE ON FUNCTION public.crm_retention_purge_job_queue_actions() TO PUBLIC`)
      try {
        const err = await rejected(readFileSync(CHECK_SQL, 'utf8'))
        expect(err.message).toContain('PUBLIC')
      } finally {
        await q(
          `REVOKE EXECUTE ON FUNCTION public.crm_retention_purge_job_queue_actions() FROM PUBLIC`,
        )
      }
      await applyFile(CHECK_SQL)
    })
  })

  // -------------------------------------------------------------------------
  // AC6 — the apply-order precondition
  // -------------------------------------------------------------------------
  describe('AC6 — the file refuses to apply without the roles it depends on', () => {
    it('names both roles in the first statement, before creating anything', () => {
      const sql = readFileSync(TRIGGERS_SQL, 'utf8')
      const guardAt = sql.indexOf('DO $precondition$')
      expect(guardAt).toBeGreaterThanOrEqual(0)

      const guardBlock = sql.slice(guardAt, sql.indexOf('$precondition$;', guardAt))
      expect(guardBlock).toContain('crm_retention_owner')
      expect(guardBlock).toContain('crm_app')
      expect(guardBlock).toContain('undefined_object')

      // Nothing is created before the guard runs. Matched at the start of a line, so
      // the header's prose about `CREATE OR REPLACE` does not count as a statement.
      const firstCreate = sql.search(/^CREATE /im)
      expect(firstCreate).toBeGreaterThan(guardAt)
    })

    it('raises undefined_object when a required role is really absent (THE SHIPPED FILE)', async () => {
      // This used to probe a hand-written COPY of the predicate with a role name that
      // could not exist, which proves a predicate of that shape refuses — not that the
      // shipped file does. The objection to exercising the real file was that
      // `crm_retention_owner` is cluster-wide and dropping it would break whatever else
      // uses it. That objection is answered by the transaction below: `DROP OWNED BY`
      // and `DROP ROLE` are both transactional in PostgreSQL, so the role is genuinely
      // gone for the length of this one connection's transaction and comes back on
      // `ROLLBACK`, having never been gone for anybody else.
      const client = await pool.connect()
      let code: string | undefined
      let message = ''
      try {
        await client.query('BEGIN')
        // DROP ROLE refuses while the role holds privileges or owns anything, and after
        // the grants file it holds both; DROP OWNED BY clears them inside the transaction.
        await client.query(`DROP OWNED BY crm_retention_owner CASCADE`)
        await client.query(`DROP ROLE crm_retention_owner`)

        try {
          for (const statement of splitSqlStatements(readFileSync(TRIGGERS_SQL, 'utf8'))) {
            await client.query(statement)
          }
        } catch (error) {
          code = (error as { code?: string }).code
          message = (error as { message?: string }).message ?? ''
        }
      } finally {
        await client.query('ROLLBACK').catch(() => undefined)
        client.release()
      }

      expect(code).toBe('42704') // undefined_object
      expect(message).toContain('required role(s) absent')
      expect(message).toContain('crm_retention_owner')

      // The rollback really did put the role back — otherwise every later test in this
      // file would fail for an unrelated-looking reason, and this is where it is cheap
      // to say so.
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM pg_catalog.pg_roles WHERE rolname='crm_retention_owner'`,
      )
      expect(rows[0].n).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // The honest gap this task could not close (DDL header, divergence 2)
  // -------------------------------------------------------------------------
  describe('GAP PIN — job_queue_generations has no INSERT guard', () => {
    it('accepts a generation created already PUBLISHED with expires_at in the past', async () => {
      // MEASURED, and deliberately left open in this PR. The three guards on this table
      // and its entries all constrain what happens AFTER a generation exists:
      // `_frozen` freezes scope_kind / team_id / expires_at on UPDATE and makes status
      // one-way, `_purge_invalidated_only` bounds DELETE, and `_building_only` refuses an
      // entry once the generation leaves BUILDING. Nothing constrains the INSERT, so a
      // role with INSERT can create a generation that is PUBLISHED and already expired —
      // a state the state machine would never reach by moving through it.
      //
      // WHY IT IS A FOLLOW-UP AND NOT THIS PR: there is no cross-team disclosure in it,
      // because an entry can only be added while the generation is BUILDING, so a
      // generation born PUBLISHED is permanently empty — the exposure is an integrity
      // nuance (a nonsense row), not a read of another team's queue. Closing it means an
      // eighth trigger with its own admitted-shape semantics, its own manifest entry and
      // its own tests, decided on its own merits rather than appended to a PR already in
      // a fix round. This test records the gap so that it is a known state rather than a
      // discovery, and GOES RED the day the guard lands — which is the signal to delete it.
      const team = await newTeam()
      const { rows } = await q(
        `INSERT INTO job_queue_generations
           (scope_kind, team_id, policy_signature, rule_version, evaluated_at,
            expires_at, status, published_at)
         VALUES ('TEAM', $2, $1, 'rank-v1', now(),
                 now() - interval '1 year', 'PUBLISHED', now() - interval '1 year')
         RETURNING id, status, expires_at`,
        [`${TAG}:${nextTag()}`, team],
      )
      expect(rows[0].status).toBe('PUBLISHED')
      expect(new Date(rows[0].expires_at as string).getTime()).toBeLessThan(Date.now())
    })
  })

  describe('GAP PIN — the REASON_REDACTED evidence row', () => {
    it('has no enum value to write, so the redaction logs to the server log instead', async () => {
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM pg_enum e
           JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'job_queue_action_kind' AND e.enumlabel = 'REASON_REDACTED'`,
      )
      // When this goes red, the follow-up has landed: wire the INSERT into
      // crm_retention_redact_action_reason() and delete this pin. See the DDL
      // header, "KNOWN DIVERGENCE ... (2 of 2)".
      expect(rows[0].n).toBe(0)
    })
  })
})
