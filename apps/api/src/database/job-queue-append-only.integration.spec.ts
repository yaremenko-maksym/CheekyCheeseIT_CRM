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
 * TWO THINGS THE SUITE NEEDS FROM ITS DATABASE, both ESTABLISHED rather than assumed:
 *   - the roles `crm_retention_owner` and `crm_app` (r5 Task 1.3c). The suite INSTALLS
 *     them itself, from the shipped roles file so their attributes have one source of
 *     truth, and `afterAll` drops exactly the ones this run created — so it is a no-op
 *     on a cluster that already had them and leaves no residue on one that did not.
 *     (Until fix round 1 this bullet said their absence "shows up as a setup failure";
 *     it did, which was the defect — the suite inherited them from whichever sibling
 *     vitest happened to sequence first and could not run alone at all.);
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
    // revokes them — see the docblock on `PRODUCTION_WITHHELD_GRANT` above for why the
    // UPDATE one in particular must not outlive this suite.
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
  /**
   * AC4 — the two SECURITY DEFINER functions.
   *
   * READ THIS BEFORE READING THE GREEN LIST BELOW (fix round 2, CR-M-6). The four
   * tests whose titles end "(logic only: needs a grant production lacks)" run under
   * `PRODUCTION_WITHHELD_GRANT`, a column-level `UPDATE` that production does NOT
   * have and that part 3 of the privileges check forbids outright. They establish
   * what the function's BODY does, and nothing about what production can do.
   *
   * Under the shipped grant set `crm_retention_redact_action_reason` raises `42501`
   * on its first call — which is pinned, by `is INERT under the PRODUCTION grant
   * set`, the one test in this describe that speaks about production. So: the purge
   * half of the retention path is real and callable; the REDACTION half is inert, and
   * four passing tests next to it do not change that. The reason it is inert and
   * cannot simply be granted is in the DDL header under "KNOWN DIVERGENCE ... (2 of
   * 2)": a redaction cannot append its `REASON_REDACTED` evidence row at all until a
   * schema task lands the enum value, so a grant today would buy a path that runs and
   * still fails to record the evidence that makes it legally meaningful.
   */
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

    it('redacts a reason to the fixed token and nothing else (logic only: needs a grant production lacks)', async () => {
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

    it('is idempotent on an already-redacted row, no second write (logic only: needs a grant production lacks)', async () => {
      const id = await newAction({ actorId: actor, opportunityId: opportunity })
      await q(`SELECT crm_retention_redact_action_reason($1, $2)`, [id, 'dsr-2026-002'])
      const { rows } = await q(`SELECT crm_retention_redact_action_reason($1, $2) AS redacted`, [
        id,
        'dsr-2026-002',
      ])
      expect(rows[0].redacted).toBe(false)
    })

    it('validates its arguments, condition 3: bounded, non-blank (logic only: needs a grant production lacks)', async () => {
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

    it('redaction also reads the REAL table, not a temp table shadowing it (logic only: needs a grant production lacks)', async () => {
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

    // =====================================================================
    // ONE TEST PER ASSERTION THE MANIFEST MAKES (fix round 2, CR-H-2)
    //
    // WHY THESE EXIST, because it is the whole lesson of the round. The manifest's
    // comments say each of its six columns "earns its place by a tampering that
    // passed the earlier version of this file green" — and that was true, but the
    // replay proving it lived in a report rather than in the repository. The code
    // reviewer then deleted NINE of the new assertions by hand, one at a time, and
    // the suite stayed green for every one of them: the tgtype column, the function
    // column, the `WHEN` check, the argument count, the md5 column, the whole
    // extra-trigger scan, that scan's table-match operand, the overload filter and
    // the overload report. Only the pre-existing `tgenabled` assertion went red.
    //
    // A guarantee nobody can re-run is a guarantee that decays silently: the next
    // edit of the check file can strip any column and CI will not notice. So each
    // assertion now has a test that goes red when THAT assertion is deleted, and
    // the deletion was run for each one rather than assumed (the commands are in
    // the PR body).
    //
    // SHAPE, kept identical to the tests above: tamper, run the SHIPPED check bytes
    // and require a rejection, assert the fragment only THAT assertion produces,
    // then repair in `finally` and re-run the check to prove the repair worked. The
    // fragment matters — several tamperings trip more than one assertion (anything
    // that changes a definition also moves the md5), and asserting the specific
    // fragment is what ties the test to the assertion rather than to the tampering.
    // =====================================================================

    /**
     * Replace one guard trigger's definition and nothing else.
     *
     * `CREATE OR REPLACE TRIGGER` rather than DROP + CREATE so the tampering leaves
     * the trigger present throughout — these tests are about what the CHECK sees,
     * and a momentarily absent trigger would trip the "is MISSING" assertion
     * instead of the one under test. It resets `tgenabled` to 'O', so each tamper
     * sets `ENABLE ALWAYS` back: otherwise every one of these tests would trip the
     * pre-existing `tgenabled` assertion and prove nothing about the new columns.
     */
    const retamper = async (definition: string) => {
      await q(`CREATE OR REPLACE TRIGGER trg_job_queue_actions_append_only ${definition}`)
      await q(
        `ALTER TABLE job_queue_actions ENABLE ALWAYS TRIGGER trg_job_queue_actions_append_only`,
      )
    }

    /**
     * Run the shipped check bytes against a tampered catalog and return the failure
     * message; repair the catalog and re-verify the repair regardless of outcome.
     *
     * It RETURNS the message rather than asserting on it so that every test below
     * carries its own visible `expect`. That is not only for `vitest/expect-expect`:
     * the fragment each test asserts is the only thing tying it to ONE assertion in
     * the manifest, so it belongs at the test, not hidden in a shared helper.
     */
    const tamperedCheckMessage = async (repair?: () => Promise<void>): Promise<string> => {
      try {
        const err = await rejected(readFileSync(CHECK_SQL, 'utf8'))
        return err.message ?? ''
      } finally {
        if (repair) await repair()
        await applyFile(TRIGGERS_SQL)
        // The repair really repaired: a tamper test that left the catalog broken
        // would otherwise fail the NEXT test for an unrelated-looking reason.
        await applyFile(CHECK_SQL)
      }
    }

    // --- column 4: the timing/event/row bitmask. Three demonstrated rewrites. ---

    it('column 4: fails when a guard is narrowed to fewer events (DELETE left unguarded)', async () => {
      // tgtype 27 -> 19: the guard no longer fires on DELETE at all.
      await retamper(
        `BEFORE UPDATE ON public.job_queue_actions
         FOR EACH ROW EXECUTE FUNCTION public.job_queue_actions_append_only()`,
      )
      expect(await tamperedCheckMessage()).toContain('WRONG timing/events')
    })

    it('column 4: fails when a BEFORE guard is flipped to AFTER', async () => {
      // An AFTER trigger cannot refuse by returning NULL and runs once the row is
      // already written — the guard's whole mechanism is BEFORE.
      await retamper(
        `AFTER UPDATE OR DELETE ON public.job_queue_actions
         FOR EACH ROW EXECUTE FUNCTION public.job_queue_actions_append_only()`,
      )
      expect(await tamperedCheckMessage()).toContain('WRONG timing/events')
    })

    it('column 4: fails when a row guard becomes a statement guard', async () => {
      // A statement trigger never sees OLD/NEW, so every per-row shape test inside
      // the body is dead code the moment this bit moves.
      await retamper(
        `BEFORE UPDATE OR DELETE ON public.job_queue_actions
         FOR EACH STATEMENT EXECUTE FUNCTION public.job_queue_actions_append_only()`,
      )
      expect(await tamperedCheckMessage()).toContain('WRONG timing/events')
    })

    // --- column 5: the function the trigger actually executes. ---

    it('column 5: fails when a guard is repointed at a no-op function', async () => {
      await q(`
        CREATE OR REPLACE FUNCTION public.ac5_decoy_noop() RETURNS trigger
        LANGUAGE plpgsql AS $noop$ BEGIN RETURN NEW; END $noop$;
      `)
      await retamper(
        `BEFORE UPDATE OR DELETE ON public.job_queue_actions
         FOR EACH ROW EXECUTE FUNCTION public.ac5_decoy_noop()`,
      )
      const message = await tamperedCheckMessage(async () => {
        // The trigger is repointed back BEFORE the function is dropped: while a
        // trigger still executes it, the function cannot be dropped.
        await q(
          `CREATE OR REPLACE TRIGGER trg_job_queue_actions_append_only
             BEFORE UPDATE OR DELETE ON public.job_queue_actions
             FOR EACH ROW EXECUTE FUNCTION public.job_queue_actions_append_only()`,
        )
        await q(`DROP FUNCTION IF EXISTS public.ac5_decoy_noop()`)
      })
      expect(message).toContain('EXECUTES')
    })

    // --- the WHEN clause: separately named because `WHEN (false)` is total. ---

    it('fails when a guard gains a WHEN clause that is never true', async () => {
      // The guard still exists, is ENABLE ALWAYS, has the right tgtype and the right
      // function — and never runs.
      await retamper(
        `BEFORE UPDATE OR DELETE ON public.job_queue_actions
         FOR EACH ROW WHEN (false)
         EXECUTE FUNCTION public.job_queue_actions_append_only()`,
      )
      expect(await tamperedCheckMessage()).toContain('carries a WHEN clause')
    })

    // --- the argument count. ---

    it('fails when a guard passes an argument to its function', async () => {
      // Reachable only through the trigger's argument list, which is why the
      // assertion is not redundant with the md5: it names the finding in its own
      // terms instead of leaving the reader to diff two checksums.
      await retamper(
        `BEFORE UPDATE OR DELETE ON public.job_queue_actions
         FOR EACH ROW EXECUTE FUNCTION public.job_queue_actions_append_only('x')`,
      )
      expect(await tamperedCheckMessage()).toContain('argument(s) to its function')
    })

    // --- column 6: the catch-all, and the one tampering ONLY it sees. ---

    it('column 6: fails on a rewrite that every other assertion is blind to', async () => {
      // THE test for the catch-all, and the reason the catch-all is not decoration.
      // `BEFORE UPDATE OF reason OR DELETE` keeps tgtype at 27, keeps the function,
      // adds no WHEN and passes no argument — columns 3-5 and both assertions above
      // stay silent — and it DISARMS the guard: the trigger then fires only when
      // `reason` is in the SET list. Measured on 16.15 against this schema: with
      // this definition in place, `UPDATE job_queue_actions SET actor_id = <other>`
      // SUCCEEDED and rewrote the audit row's actor, where the reviewed definition
      // refuses it with 23001. Column 6 is the only thing between that rewrite and
      // a green deploy.
      await retamper(
        `BEFORE UPDATE OF reason OR DELETE ON public.job_queue_actions
         FOR EACH ROW EXECUTE FUNCTION public.job_queue_actions_append_only()`,
      )
      expect(await tamperedCheckMessage()).toContain('definition checksum')
    })

    // --- part 1b: the scan for triggers nobody declared. ---

    it('1b: fails on an extra undeclared trigger, on each of the three guarded tables', async () => {
      // Per-table rather than once, because the scan derives its table list from the
      // manifest and a list that silently covered only one table would pass a
      // single-table test.
      for (const table of [
        'job_queue_actions',
        'job_queue_generation_entries',
        'job_queue_generations',
      ]) {
        await q(`
          CREATE OR REPLACE FUNCTION public.ac5_extra_noop() RETURNS trigger
          LANGUAGE plpgsql AS $noop$ BEGIN RETURN NEW; END $noop$;
        `)
        await q(
          `CREATE OR REPLACE TRIGGER ac5_extra_trigger BEFORE INSERT ON public.${table}
             FOR EACH ROW EXECUTE FUNCTION public.ac5_extra_noop()`,
        )
        try {
          const err = await rejected(readFileSync(CHECK_SQL, 'utf8'))
          expect(err.message).toContain('NOT DECLARED')
          expect(err.message).toContain(table)
        } finally {
          await q(`DROP TRIGGER IF EXISTS ac5_extra_trigger ON public.${table}`)
          await q(`DROP FUNCTION IF EXISTS public.ac5_extra_noop()`)
        }
        await applyFile(CHECK_SQL)
      }
    })

    it('1b: fails on a decoy reusing a DECLARED name on a DIFFERENT guarded table', async () => {
      // This pins the scan's table-match operand (`expected_triggers[s][2] =
      // c.relname`) specifically. Matching on the NAME alone would accept this
      // decoy as declared, because `trg_job_queue_generations_frozen` IS a declared
      // name — just not on this table. The seven declared triggers all remain
      // present and correct, so no other assertion fires.
      await q(`
        CREATE OR REPLACE FUNCTION public.ac5_decoy_noop() RETURNS trigger
        LANGUAGE plpgsql AS $noop$ BEGIN RETURN NEW; END $noop$;
      `)
      await q(
        `CREATE OR REPLACE TRIGGER trg_job_queue_generations_frozen
           BEFORE INSERT ON public.job_queue_actions
           FOR EACH ROW EXECUTE FUNCTION public.ac5_decoy_noop()`,
      )
      try {
        const err = await rejected(readFileSync(CHECK_SQL, 'utf8'))
        expect(err.message).toContain('NOT DECLARED')
        expect(err.message).toContain(
          'trg_job_queue_generations_frozen on public.job_queue_actions',
        )
      } finally {
        await q(
          `DROP TRIGGER IF EXISTS trg_job_queue_generations_frozen ON public.job_queue_actions`,
        )
        await q(`DROP FUNCTION IF EXISTS public.ac5_decoy_noop()`)
      }
      await applyFile(CHECK_SQL)
    })

    // --- part 2b: the overload report. ---

    it('2b: reports an unexpected overload of a guard function name', async () => {
      // Nothing in the reviewed DDL creates an overload, so one is an unreviewed
      // object sitting next to a security guard under a confusable name.
      // `RETURNS int`, not `RETURNS trigger`: PostgreSQL refuses declared arguments
      // on a trigger function outright ("trigger functions cannot have declared
      // arguments"), so the confusable object an attacker could actually leave
      // behind under a guard's name is a NON-trigger overload. The check matches on
      // `proname` and non-empty identity arguments without caring about the return
      // type, which is what makes it see this.
      await q(`
        CREATE OR REPLACE FUNCTION public.job_queue_actions_append_only(p_unused int)
        RETURNS int LANGUAGE sql
        SET search_path = pg_catalog, public, pg_temp
        AS $over$ SELECT 1 $over$;
      `)
      try {
        const err = await rejected(readFileSync(CHECK_SQL, 'utf8'))
        expect(err.message).toContain('unexpected overload')
        expect(err.message).toContain('job_queue_actions_append_only')
      } finally {
        await q(`DROP FUNCTION IF EXISTS public.job_queue_actions_append_only(int)`)
      }
      await applyFile(CHECK_SQL)
    })

    // =====================================================================
    // PART 1c — the three ways to disarm a guarded table WITHOUT touching a
    // trigger (fix round 2, SR-R2-M-1)
    //
    // Everything above reads `pg_trigger`. The security review went looking off
    // that list and found three objects that each leave all seven triggers
    // BYTE-IDENTICAL and the check GREEN, in other catalogs entirely: `pg_rewrite`
    // (a rule), `pg_inherits` (a child table) and `pg_policy` (row-level security).
    // The second is the one that matters most, because it is precisely the shape
    // part 1b's own comment claims to stop — "it can suppress a write, rewrite NEW,
    // or silently swallow rows" — reached by a different route.
    //
    // All three need OWNERSHIP of the table, so `crm_app` cannot reach them; the
    // actor who can is the migration role, which is exactly the actor this file
    // exists to DETECT rather than prevent. That is why they are worth catching and
    // why they were not a HIGH.
    //
    // Each test replays the tampering and requires the check to go red — the
    // red-before/green-after the manifest's standard asks of every assertion.
    // =====================================================================

    it('1c: fails on a RULE that makes the audit INSERT record nothing', async () => {
      // `DO INSTEAD NOTHING`: the INSERT returns success, `INSERT 0 0`, and the log
      // silently stops recording. No trigger is touched.
      await q(
        `CREATE RULE ac5_skip_audit_insert AS ON INSERT TO public.job_queue_actions
           DO INSTEAD NOTHING`,
      )
      const message = await tamperedCheckMessage(async () => {
        await q(`DROP RULE IF EXISTS ac5_skip_audit_insert ON public.job_queue_actions`)
      })
      expect(message).toContain('carries a RULE')
      expect(message).toContain('ac5_skip_audit_insert')
    })

    it('1c: fails on an INHERITING CHILD table, including one in another schema', async () => {
      // The child is deliberately created in a FRESH SCHEMA, not in `public`. Part 1
      // of the privileges check ("every relation in public is classified exactly
      // once") would have caught a child in `public`, but it is scoped
      // `nspname = 'public'` — so a child next door is invisible to it. This
      // assertion reads `pg_inherits` FOR THE PARENT, which finds the child regardless
      // of the schema it lives in, and that is the whole reason it is phrased that way.
      // (Deliberately NOT the parent's `pg_class.relhassubclass`: that is a planner hint
      // PostgreSQL only clears on a later vacuum, so an assertion on it would stay red
      // after the child was removed — non-deterministically, until some vacuum ran.
      // Naming the hint here would be the most misleading possible wording, given that
      // the staleness is exactly why the hint was rejected.)
      await q(`CREATE SCHEMA IF NOT EXISTS ac5_shadow`)
      await q(
        `CREATE TABLE ac5_shadow.job_queue_actions_child ()
           INHERITS (public.job_queue_actions)`,
      )
      const message = await tamperedCheckMessage(async () => {
        await q(`DROP TABLE IF EXISTS ac5_shadow.job_queue_actions_child`)
        await q(`DROP SCHEMA IF EXISTS ac5_shadow`)
      })
      expect(message).toContain('has an INHERITING CHILD table')
      expect(message).toContain('job_queue_actions_child')
      expect(message).toContain('ac5_shadow')
    })

    it('1c: fails on ROW LEVEL SECURITY hiding the audit log', async () => {
      // `USING (false)` makes the whole log invisible to every role the policy
      // applies to, with every guard still in place and still ENABLE ALWAYS. This is
      // the REALISTIC variant — the one an attacker installs — and it trips BOTH
      // operands of the RLS assertion at once, which is exactly why it is not enough
      // on its own: see the two tests below, one per operand (fix round 3, CR-H-9).
      await q(`ALTER TABLE public.job_queue_actions ENABLE ROW LEVEL SECURITY`)
      await q(`CREATE POLICY ac5_hide_everything ON public.job_queue_actions USING (false)`)
      const message = await tamperedCheckMessage(async () => {
        await q(`DROP POLICY IF EXISTS ac5_hide_everything ON public.job_queue_actions`)
        await q(`ALTER TABLE public.job_queue_actions DISABLE ROW LEVEL SECURITY`)
      })
      expect(message).toContain('has ROW LEVEL SECURITY')
      expect(message).toContain('enabled = t')
      expect(message).toContain('ac5_hide_everything')
    })

    // ONE TEST PER OPERAND, because the assertion above is a DISJUNCTION
    // (`relrowsecurity OR policies IS NOT NULL`) and the realistic tampering sets both.
    // Each of the two operands survived deletion with the suite green until these
    // landed: the states that separate them are "RLS on with no policy" and "a policy
    // with RLS off", and each is reachable in one statement.

    it('1c: fails on RLS enabled with NO policy (pins the relrowsecurity operand)', async () => {
      // RLS enabled and no policy is the STRICTEST possible state, not a lax one:
      // with no permissive policy, a non-owner sees zero rows. It is also invisible to
      // the `policies` operand, so only `relrowsecurity` can catch it.
      await q(`ALTER TABLE public.job_queue_actions ENABLE ROW LEVEL SECURITY`)
      const message = await tamperedCheckMessage(async () => {
        await q(`ALTER TABLE public.job_queue_actions DISABLE ROW LEVEL SECURITY`)
      })
      expect(message).toContain('has ROW LEVEL SECURITY')
      expect(message).toContain('enabled = t')
      expect(message).toContain('policies = none')
    })

    it('1c: fails on a POLICY with RLS disabled (pins the policies operand)', async () => {
      // `CREATE POLICY` does NOT enable row-level security, so this state is inert
      // today — and it is one `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` away from
      // hiding the whole audit log, with no new object needed. An unreviewed policy
      // sitting on an audit table is worth a finding on its own, which is why the
      // assertion tests the policy list and not only the flag.
      await q(`CREATE POLICY ac5_policy_only ON public.job_queue_actions USING (false)`)
      const message = await tamperedCheckMessage(async () => {
        await q(`DROP POLICY IF EXISTS ac5_policy_only ON public.job_queue_actions`)
      })
      expect(message).toContain('has ROW LEVEL SECURITY')
      expect(message).toContain('enabled = f')
      expect(message).toContain('ac5_policy_only')
    })

    // =====================================================================
    // PART 2's GRANT OPERANDS AND PART 3's ARITHMETIC (fix round 3, CR-H-9)
    //
    // Three more assertions that deleted with the suite green. The existing
    // `GRANT EXECUTE ... TO PUBLIC` test pins the PUBLIC operand; these pin the other
    // two directions of the same `proacl` reading, plus part 3's count.
    // =====================================================================

    it('2: fails when EXECUTE is granted beyond crm_app and the owner', async () => {
      // `crm_collector` is a real deploy role, so this is the shape a careless
      // least-privilege edit would actually produce — not PUBLIC, just one role too
      // many. The PUBLIC operand cannot see it.
      await q(
        `GRANT EXECUTE ON FUNCTION public.crm_retention_purge_job_queue_actions() TO crm_collector`,
      )
      const message = await tamperedCheckMessage(async () => {
        await q(
          `REVOKE EXECUTE ON FUNCTION public.crm_retention_purge_job_queue_actions()
             FROM crm_collector`,
        )
      })
      expect(message).toContain('grants EXECUTE to 1 role(s) beyond crm_app and its owner')
    })

    it('2: fails when EXECUTE is NOT granted to crm_app', async () => {
      // The opposite failure from every other privilege assertion here: not "too
      // wide" but "too narrow". ADR condition 4 requires the grant to exist by name,
      // and a deploy that revoked it would leave the retention path uncallable while
      // every other privilege assertion stayed quiet.
      await q(
        `REVOKE EXECUTE ON FUNCTION public.crm_retention_purge_job_queue_actions() FROM crm_app`,
      )
      const message = await tamperedCheckMessage()
      expect(message).toContain('does not grant EXECUTE to crm_app')
    })

    it('3: fails when crm_retention_owner owns a THIRD function', async () => {
      // Part 3 is arithmetic rather than attentiveness: ADR §2 allows exactly these
      // two definer functions, and a third owned by this role would run with its
      // privileges having never been reviewed as part of R-B. Nothing else in the
      // check looks at functions it does not already name, so this count is the only
      // assertion that can see an EXTRA one.
      await q(`CREATE OR REPLACE FUNCTION public.ac5_third_owned() RETURNS int
                 LANGUAGE sql AS $third$ SELECT 1 $third$`)
      await q(`ALTER FUNCTION public.ac5_third_owned() OWNER TO crm_retention_owner`)
      const message = await tamperedCheckMessage(async () => {
        // Dropped here rather than in `afterAll`: while this role owns it,
        // `DROP ROLE` would refuse and the whole teardown would fail.
        await q(`DROP FUNCTION IF EXISTS public.ac5_third_owned()`)
      })
      expect(message).toContain('crm_retention_owner owns 3 function(s), expected exactly 2')
    })

    // =====================================================================
    // The check's own session dependency (fix round 2, CR-M-5)
    // =====================================================================

    it('passes under a search_path that does not contain public (column 6 is pinned)', async () => {
      // `pg_get_triggerdef` schema-qualifies the executed function only when `public`
      // is not visible, so all seven column-6 checksums move with the session's
      // `search_path`: measured 193803… with `public` visible and 0c86cd… under
      // `search_path = pg_catalog`. Before the check pinned its own path, a HEALTHY
      // database failed it with seven checksum problems whenever the deploy role
      // carried a role-level or database-level `search_path` without `public` — a
      // false positive on deploy, the one failure mode this file must never invent.
      //
      // A dedicated connection with the hostile path set as a startup option, which
      // is how a role-level or database-level setting would actually arrive.
      const hostile = new Pool({
        connectionString: process.env['DATABASE_URL'],
        max: 1,
        options: '-c search_path=pg_catalog',
      })
      try {
        // `current_setting`, not `SHOW`: `SHOW` names its own output column and
        // ignores an alias, so the assertion would read `undefined` and pass
        // vacuously on any path.
        const { rows } = await hostile.query<{ sp: string }>(
          `SELECT current_setting('search_path') AS sp`,
        )
        expect(rows[0]?.sp).toBe('pg_catalog')
        // It RAISES on any problem, so completing without throwing is the result.
        await expect(hostile.query(readFileSync(CHECK_SQL, 'utf8'))).resolves.toBeDefined()
      } finally {
        await hostile.end()
      }
    })

    // =====================================================================
    // THE "EVERY ASSERTION HAS A TEST" CLAIM, CHECKED BY THE SUITE (CR-H-9)
    //
    // Both SQL headers and the PR body make a claim of the form "every assertion that
    // can change the verdict has a test". That is a claim about a SET, and a set claim
    // needs an enumeration you can re-run — a spot check is how it was untrue twice:
    // round 2 left nine assertions unpinned, and round 3 found five more, including two
    // OPERANDS of one disjunction that the realistic tampering trips together.
    //
    // So the claim is now arithmetic rather than attentiveness, the same device as part
    // 1b deriving its table list from the manifest. The inventory below has one entry
    // per assertion site in the shipped check, and the test asserts:
    //   1. the number of entries equals the number of sites in the file — so ADDING an
    //      assertion without classifying it turns this test red;
    //   2. every inventoried fragment is really present — so REMOVING an assertion
    //      without removing its entry turns it red;
    //   3. every entry is classified exactly one way: pinned, or a measured equivalent;
    //   4. every test named as a pin EXISTS in this file, matched on `it('<title>` so
    //      the inventory cannot satisfy itself by containing the string.
    //
    // An `equivalentBecause` entry is a deliberate, measured exemption: deleting that
    // assertion cannot change the check's pass/fail verdict, because another assertion
    // fires on the same catalog state. Each reason below was MEASURED by building the
    // state and running the real check against a mutant with that assertion deleted —
    // never argued from the code. Adding an entry here is how you exempt an assertion,
    // and the reason has to name the assertion that covers it.
    // =====================================================================
    type CheckAssertion = {
      /** A stable fragment of the assertion's message, as it appears in the SQL. */
      readonly fragment: string
      /** Exact titles of the tests that pin it — one per OPERAND, not one per site. */
      readonly pinnedBy?: readonly string[]
      /** Or: why deleting it cannot change the verdict. Measured, not argued. */
      readonly equivalentBecause?: string
    }

    const CHECK_ASSERTIONS: readonly CheckAssertion[] = [
      // --- part 1: the seven declared triggers, column by column ---
      { fragment: 'is MISSING from public.%s', pinnedBy: ['fails when a guard is dropped'] },
      {
        fragment: 'is not ENABLE ALWAYS',
        pinnedBy: ['fails when a guard is disabled, and re-applying the DDL repairs it'],
      },
      {
        fragment: 'fires on the WRONG timing/events',
        pinnedBy: [
          'column 4: fails when a guard is narrowed to fewer events (DELETE left unguarded)',
          'column 4: fails when a BEFORE guard is flipped to AFTER',
          'column 4: fails when a row guard becomes a statement guard',
        ],
      },
      {
        fragment: 'EXECUTES public.%s()',
        pinnedBy: ['column 5: fails when a guard is repointed at a no-op function'],
      },
      {
        fragment: 'carries a WHEN clause',
        pinnedBy: ['fails when a guard gains a WHEN clause that is never true'],
      },
      {
        fragment: 'argument(s) to its function',
        pinnedBy: ['fails when a guard passes an argument to its function'],
      },
      {
        fragment: 'definition checksum is %s, manifest says',
        pinnedBy: ['column 6: fails on a rewrite that every other assertion is blind to'],
      },
      // --- part 1b: the scan for undeclared triggers ---
      {
        fragment: 'is NOT DECLARED in this file',
        pinnedBy: [
          '1b: fails on an extra undeclared trigger, on each of the three guarded tables',
          '1b: fails on a decoy reusing a DECLARED name on a DIFFERENT guarded table',
        ],
      },
      // --- part 1c: the three non-trigger ways to disarm a guarded table ---
      {
        fragment: 'carries a RULE',
        pinnedBy: ['1c: fails on a RULE that makes the audit INSERT record nothing'],
      },
      {
        fragment: 'has an INHERITING CHILD table',
        pinnedBy: ['1c: fails on an INHERITING CHILD table, including one in another schema'],
      },
      {
        // ONE site, TWO operands — the finding that made CR-H-9 a HIGH. The realistic
        // tampering (`USING (false)`) sets both, so it pins neither; each operand gets
        // the state that isolates it.
        fragment: 'has ROW LEVEL SECURITY (enabled = %s, policies = %s)',
        pinnedBy: [
          '1c: fails on RLS enabled with NO policy (pins the relrowsecurity operand)',
          '1c: fails on a POLICY with RLS disabled (pins the policies operand)',
        ],
      },
      // --- part 2: the two R-B functions, ADR §3 condition by condition ---
      {
        fragment: 'function public.%s(%s) is MISSING',
        equivalentBecause:
          'part 3 counts the functions this role owns, so a missing one also moves that ' +
          'count. Measured: dropping the purge function is red on the real check ' +
          '(2 problems) and red on the mutant (1 problem, the count).',
      },
      {
        fragment: 'is not SECURITY DEFINER',
        equivalentBecause:
          '`prosecdef` cannot move without `CREATE OR REPLACE`, which moves ' +
          '`pg_get_functiondef` and therefore the body checksum. Confirmed equivalent by ' +
          'the round-3 code review verdict.',
      },
      {
        fragment: 'is owned by %L, expected crm_retention_owner',
        equivalentBecause:
          'part 3 counts only functions owned by this role, so a changed owner moves that ' +
          'count too. Confirmed equivalent by the round-3 code review verdict.',
      },
      {
        fragment: 'has proconfig %L, expected exactly',
        pinnedBy: ['fails when the pinned search_path is removed'],
      },
      {
        fragment: 'body checksum is %s, manifest says %s — the deployed',
        pinnedBy: ['fails when a function body changes outside a reviewed file (checksum drift)'],
      },
      {
        fragment: 'has default privileges (proacl IS NULL)',
        equivalentBecause:
          'UNREACHABLE alongside a correct owner, measured two ways: the owner role cannot ' +
          'create a function in `public` at all ("permission denied for schema public", ' +
          'because the roles file revokes CREATE ON SCHEMA public from PUBLIC), and ' +
          '`ALTER FUNCTION ... OWNER TO` MATERIALISES the ACL as ' +
          '`{crm_retention_owner=X/crm_retention_owner}` rather than leaving it NULL. With ' +
          'a wrong owner instead, the owner assertion and part 3 both fire. The realistic ' +
          'shape this was meant to catch — a DDL edit dropping the REVOKE/GRANT lines — ' +
          'is caught by "does not grant EXECUTE to crm_app", which IS pinned.',
      },
      {
        fragment: 'role(s) beyond crm_app and its owner',
        pinnedBy: ['2: fails when EXECUTE is granted beyond crm_app and the owner'],
      },
      {
        fragment: 'grants EXECUTE to PUBLIC',
        pinnedBy: ['fails when EXECUTE is granted to PUBLIC'],
      },
      {
        fragment: 'does not grant EXECUTE to crm_app',
        pinnedBy: ['2: fails when EXECUTE is NOT granted to crm_app'],
      },
      // --- part 2b: the seven trigger-function bodies ---
      {
        fragment: 'trigger function public.%s() is MISSING',
        equivalentBecause:
          'a trigger function cannot be dropped while a trigger executes it, so reaching ' +
          'this state needs CASCADE, which drops the trigger and fires the part-1 MISSING ' +
          'assertion. Measured: real check red (2 problems), mutant red (1, the trigger).',
      },
      {
        fragment: 'unexpected overload(s)',
        pinnedBy: ['2b: reports an unexpected overload of a guard function name'],
      },
      {
        fragment: 'trigger function public.%s has proconfig %L',
        equivalentBecause:
          '`proconfig` on a trigger function cannot move without `CREATE OR REPLACE`, ' +
          'which moves the body checksum asserted next. Confirmed equivalent by the ' +
          'round-3 code review verdict.',
      },
      {
        fragment: 'body checksum is %s, manifest says %s — a guard body',
        pinnedBy: ['fails when a TRIGGER guard body changes (condition 5 is pinned too)'],
      },
      // --- part 3: arithmetic on what the retention role owns ---
      {
        fragment: 'owns %s function(s), expected exactly',
        pinnedBy: ['3: fails when crm_retention_owner owns a THIRD function'],
      },
    ]

    it('every assertion in the check is pinned by a test or a measured equivalence', () => {
      const sql = readFileSync(CHECK_SQL, 'utf8')
      const spec = readFileSync(__filename, 'utf8')

      // 1. Arithmetic: one inventory entry per assertion site, no more and no fewer.
      //    This is the line that makes the set claim re-runnable.
      const sites = (sql.match(/problems := problems \|\| format\(/g) ?? []).length
      expect(sites).toBe(CHECK_ASSERTIONS.length)

      const missingFragments: string[] = []
      const unclassified: string[] = []
      const missingTests: string[] = []

      for (const assertion of CHECK_ASSERTIONS) {
        // 2. The fragment is really in the shipped check.
        if (!sql.includes(assertion.fragment)) missingFragments.push(assertion.fragment)

        // 3. Classified exactly one way.
        const pinned = (assertion.pinnedBy?.length ?? 0) > 0
        const exempt = Boolean(assertion.equivalentBecause)
        if (pinned === exempt) unclassified.push(assertion.fragment)

        // 4. Each named test exists — matched on `it('<title>` so that the inventory
        //    literal above cannot satisfy this by containing the title string.
        for (const title of assertion.pinnedBy ?? []) {
          const declaration = `it('${title}'`
          if (!spec.includes(declaration)) missingTests.push(title)
        }
      }

      expect(missingFragments).toEqual([])
      expect(unclassified).toEqual([])
      expect(missingTests).toEqual([])
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
          // The file's OWN `BEGIN;` / `COMMIT;` are skipped here, and that is load-bearing
          // rather than tidy: this test has already dropped the role inside ITS transaction,
          // so letting the file's `COMMIT` run would commit that drop and remove
          // `crm_retention_owner` from the cluster for good. The precondition raises before
          // the `COMMIT` is reached today, so nothing commits either way — but that is a
          // property of the file's current statement ORDER, and a test whose safety rests on
          // it is one edit away from wiping a role. What this test exercises is the
          // precondition, not the wrap; the wrap is exercised by `OWNER-M-1 — the file is one
          // transaction` below.
          const statements = splitSqlStatements(readFileSync(TRIGGERS_SQL, 'utf8')).filter(
            (st) => !/^\s*(BEGIN|COMMIT)\s*;?\s*$/i.test(st),
          )
          for (const statement of statements) {
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
  // OWNER-M-1 — the file is ONE TRANSACTION, proven from a second session
  //
  // The owner decided to wrap the DDL. The header now claims that the intermediate
  // states inside the file are never visible to another session, and that is the
  // kind of claim this feature has been burned by seven times: a comment advertising
  // a guarantee the artifact does not deliver. So it is proven, from a SECOND
  // CONNECTION, rather than asserted.
  //
  // Two windows existed, both are closed, and ONE CHANGE EACH CLOSES THEM — an earlier
  // version of this comment credited the wrap with both (fix round 3, CR-M-10):
  //   1. the RECREATE window — `DROP TRIGGER` then `CREATE TRIGGER` under statement
  //      autocommit left a committed instant with the guard absent. Closed by
  //      `CREATE OR REPLACE TRIGGER`, which converges in place with no `DROP`; measured
  //      in an unwrapped control, where the trigger count stayed at 7 throughout.
  //   2. the ENABLE ORIGIN window — `CREATE [OR REPLACE] TRIGGER` leaves the trigger
  //      `ENABLE ORIGIN` until the separate `ENABLE ALWAYS` commits, so a session with
  //      `session_replication_role = replica` could skip the guard in between. Closed by
  //      the TRANSACTION and only by it: no form of `CREATE ... TRIGGER` avoids it.
  // The first test below observes the transaction's guarantee, which covers both as a
  // consequence: mid-apply, a second session sees neither a missing trigger nor an
  // `ENABLE ORIGIN` one — it sees the previous state, whole.
  // -------------------------------------------------------------------------
  describe('OWNER-M-1 — the file is one transaction', () => {
    /** The file's statements, and the index of its trailing `COMMIT`. */
    const wrappedStatements = () => {
      const statements = splitSqlStatements(readFileSync(TRIGGERS_SQL, 'utf8'))
      const commitAt = statements.findIndex((st) => /^\s*COMMIT\s*;?\s*$/i.test(st))
      const beginAt = statements.findIndex((st) => /^\s*BEGIN\s*;?\s*$/i.test(st))
      return { statements, commitAt, beginAt }
    }

    it('opens with BEGIN and ends with COMMIT, with every object between them', () => {
      // The structural half, so that if someone later unwraps the file the test that
      // matters below cannot pass vacuously by having nothing to straddle.
      const { statements, commitAt, beginAt } = wrappedStatements()
      expect(beginAt).toBe(0)
      expect(commitAt).toBe(statements.length - 1)
      // Everything that creates an object is inside.
      const firstCreate = statements.findIndex((st) => /^\s*CREATE /i.test(st))
      expect(firstCreate).toBeGreaterThan(beginAt)
      expect(firstCreate).toBeLessThan(commitAt)
    })

    it('shows a second session NO intermediate state mid-apply, and the new state after COMMIT', async () => {
      const trigger = 'trg_job_queue_generations_frozen'
      const table = 'job_queue_generations'
      const { statements, commitAt } = wrappedStatements()

      // A committed "previous state" that is visibly different from the end state, so
      // that "the second session sees the previous state" is an observation and not a
      // tautology: the trigger is really gone before the apply starts.
      await q(`DROP TRIGGER ${trigger} ON ${table}`)
      expect(await triggerState(trigger, table)).toBeUndefined()

      const applying = await pool.connect()
      try {
        for (const statement of statements.slice(0, commitAt)) {
          await applying.query(statement)
        }

        // MID-APPLY, from another connection. Inside `applying`'s transaction the
        // trigger now exists and is ENABLE ALWAYS; from here it must still be absent.
        // This is simultaneously the proof for window 1 (never missing-then-present as
        // two committed states) and window 2 (never visible as 'O').
        expect(await triggerState(trigger, table)).toBeUndefined()

        await applying.query(statements[commitAt] as string)
      } finally {
        // If the loop threw, the transaction is still open on this client.
        await applying.query('ROLLBACK').catch(() => undefined)
        applying.release()
      }

      // After COMMIT the second session sees the finished state directly: present AND
      // 'A'. It never saw 'O'.
      expect(await triggerState(trigger, table)).toBe('A')
      await applyFile(TRIGGERS_SQL)
      await applyFile(CHECK_SQL)
    })

    it('aborts on a conflicting lock instead of queueing behind it (SET LOCAL lock_timeout)', async () => {
      // The other direction of the wrap's cost: one transaction holds ACCESS EXCLUSIVE
      // on the guarded tables until COMMIT, so a contended deploy must FAIL rather than
      // stall while the old API is still serving. `lock_timeout` is what makes that the
      // behaviour, and this test is the only thing that proves the value in the file is
      // doing something.
      //
      // It really waits out the file's own five seconds — the file's `SET LOCAL` wins
      // over anything this test could set first, which is the point of putting it in
      // the file. One slow test, deliberately.
      const blocker = await pool.connect()
      let code: string | undefined
      let elapsedMs = 0
      try {
        await blocker.query('BEGIN')
        // A WRITER, not a reader, and that distinction is measured rather than
        // assumed: the file's statements take ShareRowExclusiveLock (see the test
        // below), which does NOT conflict with the ACCESS SHARE of a plain SELECT.
        // An earlier version of this test held a SELECT open and the file applied
        // straight through it in 0 ms, proving nothing. ROW EXCLUSIVE — what any
        // INSERT takes — is what conflicts, and it is also the realistic case: an
        // API session writing an audit row while the deploy lands.
        await blocker.query(
          `INSERT INTO job_queue_actions
             (kind, opportunity_id, actor_id, scope_kind, before_version, after_version,
              idempotency_key, reason)
           VALUES ('DISMISSED', $1, $2, 'STUDIO', 0, 1, $3, $4)`,
          [opportunity, actor, nextTag(), `${TAG} lock-probe`],
        )

        const startedAt = Date.now()
        try {
          await applyFile(TRIGGERS_SQL)
        } catch (error) {
          code = (error as { code?: string }).code
        }
        elapsedMs = Date.now() - startedAt
      } finally {
        await blocker.query('ROLLBACK').catch(() => undefined)
        blocker.release()
      }

      expect(code).toBe('55P03') // lock_not_available
      // Aborted on the timeout rather than hung: comfortably past 5s, nowhere near a
      // test timeout. The upper bound is what distinguishes "aborted" from "waited".
      expect(elapsedMs).toBeGreaterThanOrEqual(4_500)
      expect(elapsedMs).toBeLessThan(20_000)

      // And the file still applies cleanly once the lock is gone — a failed attempt
      // left nothing behind, which is the other half of what the transaction buys.
      await applyFile(TRIGGERS_SQL)
      await applyFile(CHECK_SQL)
    }, 60_000)

    it('takes ShareRowExclusive, not ACCESS EXCLUSIVE — so readers are never blocked', async () => {
      // The header makes a claim about the lock MODE, and that claim is the whole
      // basis for saying the wrap is cheap. It was also the claim both review axes
      // got wrong (both described ACCESS EXCLUSIVE, blocking every reader), so it is
      // worth a test rather than a measurement in a report.
      const applying = await pool.connect()
      try {
        await applying.query('BEGIN')
        await applying.query(
          `CREATE OR REPLACE TRIGGER trg_job_queue_actions_append_only
             BEFORE UPDATE OR DELETE ON public.job_queue_actions
             FOR EACH ROW EXECUTE FUNCTION public.job_queue_actions_append_only()`,
        )
        await applying.query(
          `ALTER TABLE public.job_queue_actions
             ENABLE ALWAYS TRIGGER trg_job_queue_actions_append_only`,
        )

        const { rows } = await applying.query<{ mode: string }>(
          `SELECT DISTINCT l.mode
             FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
            WHERE l.pid = pg_backend_pid() AND c.relname = 'job_queue_actions'
            ORDER BY 1`,
        )
        expect(rows.map((r) => r.mode)).toEqual(['ShareRowExclusiveLock'])

        // The consequence that makes it cheap: a SECOND session reads the table
        // while this transaction holds that lock, without waiting.
        const { rows: readable } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM job_queue_actions`,
        )
        expect(readable[0]?.n).toBeGreaterThanOrEqual(0)
      } finally {
        await applying.query('ROLLBACK').catch(() => undefined)
        applying.release()
      }
      await applyFile(TRIGGERS_SQL)
      await applyFile(CHECK_SQL)
    })
  })

  // -------------------------------------------------------------------------
  // The honest gaps this task could not close. The generations INSERT gap below is
  // recorded in the DDL header under "A DEFERRED GAP: `job_queue_generations` HAS NO
  // INSERT GUARD" and in the PR body — NOT under divergence 2, which this comment used
  // to point at and which is the unrelated `REASON_REDACTED` gap (fix round 2,
  // SPEC-L-5). The second GAP PIN further down is the divergence-2 one.
  // -------------------------------------------------------------------------
  /**
   * Insert a generation born PUBLISHED and already expired — the row the missing
   * INSERT guard would refuse — and MAKE THE FAILURE MODE SAY WHICH ONE IT IS.
   *
   * This is the mechanical half of the GAP PIN's discrimination (fix round 2,
   * `SR-R2-M-3` and `CR-M-8`, which are one change). A raw thrown pg error here is
   * the exact surface that was misread once already: it is the same `23514` whether
   * the fixture is invalid or a new guard is refusing the shape. So the error is
   * caught and classified before it reaches the assertion:
   *   - `err.constraint` naming a `ck_` constraint  -> the FIXTURE is wrong;
   *   - otherwise                                   -> something REFUSED the shape,
   *     i.e. the guard landed and the pin must be inverted.
   * Each throws a message that says what to do, so the next reader cannot act on the
   * wrong one.
   */
  async function bornExpiredGeneration(team: string) {
    try {
      const { rows } = await q(
        `INSERT INTO job_queue_generations
           (scope_kind, team_id, policy_signature, rule_version, evaluated_at,
            expires_at, status, published_at)
         VALUES ('TEAM', $2, $1, 'rank-v1', now() - interval '2 years',
                 now() - interval '1 year', 'PUBLISHED', now() - interval '1 year')
         RETURNING id, status, expires_at`,
        [`${TAG}:${nextTag()}`, team],
      )
      return rows
    } catch (error) {
      const err = error as { code?: string; constraint?: string; message?: string; where?: string }
      if (err.constraint?.startsWith('ck_')) {
        throw new Error(
          `TEST BUG, not a landed guard: this fixture INSERT violates the CHECK ` +
            `constraint ${err.constraint}. The row must satisfy every CHECK on ` +
            `job_queue_generations and still be born PUBLISHED and expired. Fix the ` +
            `fixture and KEEP the pin. (SQLSTATE ${err.code}: ${err.message})`,
        )
      }
      throw new Error(
        `THE GUARD LANDED: the INSERT of a generation born PUBLISHED-and-expired was ` +
          `REFUSED by something other than a CHECK constraint (SQLSTATE ${err.code}, ` +
          `constraint ${err.constraint ?? 'none'}, where ${err.where ?? 'n/a'}). The gap ` +
          `this pin records is closed — invert it into a positive assertion that the ` +
          `INSERT is refused, and delete the GAP PIN comment. (${err.message})`,
      )
    }
  }

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
      // discovery.
      //
      // IF THIS TEST IS RED: FIND OUT WHY BEFORE YOU TOUCH IT. There are two reasons it
      // can go red and they call for opposite actions, so the order of these two
      // paragraphs is deliberate — the previous version said "delete it" first, and that
      // is the sentence a hurried reader acts on.
      //   (a) THE FIXTURE IS INVALID. The INSERT below must satisfy five CHECK constraints
      //       on this table; the FIRST version of this test violated
      //       `ck_job_queue_generations_expiry_after_evaluation` and failed while saying
      //       nothing at all about whether a guard exists. Fix the fixture, keep the pin.
      //   (b) THE GUARD LANDED. An INSERT guard on `job_queue_generations` now refuses
      //       this row. Invert the pin into a positive assertion and delete this comment.
      // The discrimination is MECHANICAL, not left to this comment: the test catches the
      // error and names which case it is in. It does not branch on the SQLSTATE alone,
      // because `23514` is ambiguous in both directions — a future INSERT guard could
      // plausibly raise `check_violation` itself as the natural code for "invalid shape",
      // and this table already has five CHECKs that raise it for fixture reasons. What
      // discriminates is `err.constraint`: PostgreSQL sets it to the constraint name for a
      // real CHECK violation and leaves it unset for an error raised inside a trigger
      // function. Retiring a pin on a misread is how a guard gets weakened to make a test
      // pass, so the test refuses to let the misread happen silently.
      //
      // `evaluated_at` is backdated further than `expires_at` only because
      // `ck_job_queue_generations_expiry_after_evaluation` requires
      // `expires_at > evaluated_at` — a CHECK that constrains the two columns against
      // EACH OTHER and says nothing about either against `now()`. So the row is
      // internally consistent and still born expired, which is the point.
      const team = await newTeam()
      const rows = await bornExpiredGeneration(team)
      expect(rows[0].status).toBe('PUBLISHED')
      expect(new Date(rows[0].expires_at as string).getTime()).toBeLessThan(Date.now())

      // And the consequence that makes this an integrity nuance rather than a
      // disclosure: the generation is permanently EMPTY, because an entry may only be
      // added while the generation is BUILDING and this one never will be.
      const entryError = await rejected(
        `INSERT INTO job_queue_generation_entries
           (generation_id, opportunity_id, rank_score, order_key, first_seen_at,
            opportunity_revision)
         VALUES ($1, $2, 10, 999001, now(), 1)`,
        [rows[0].id, opportunity],
      )
      expect(entryError.code).toBe(RESTRICT_VIOLATION)
    })
  })

  // The GAP PIN that used to live here asserted the ABSENCE of the
  // `REASON_REDACTED` enum value, so that the day it was added the pin would go
  // red and point at the DDL header's "KNOWN DIVERGENCE ... (2 of 2)". r5 Task
  // 1.4b-ii added it, the pin went red exactly as designed, and this is its
  // positive counterpart: the same fact, asserted from the other side.
  describe('the REASON_REDACTED evidence row is now writable', () => {
    it('has its enum value, appended last so the existing members did not move', async () => {
      const { rows } = await q(
        `SELECT array_agg(enumlabel ORDER BY enumsortorder) AS labels FROM pg_enum e
           JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'job_queue_action_kind'`,
      )
      const labels = rows[0].labels as string[]
      expect(labels).toContain('REASON_REDACTED')
      expect(labels.at(-1)).toBe('REASON_REDACTED')
      expect(labels).toHaveLength(14)
    })

    it('has the two CHECK branches the evidence row needs, and no third target hole', async () => {
      const def = async (name: string) =>
        (
          await q(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [
            name,
          ])
        ).rows[0].def as string
      const target = await def('ck_job_queue_actions_target')
      const versions = await def('ck_job_queue_actions_versions')
      // The branch that lets the row in...
      expect(target).toContain('REASON_REDACTED')
      expect(versions).toContain('REASON_REDACTED')
      // ...and the exclusions that stop it ALSO satisfying the catch-all
      // branches, which is what would make the new kind unconstrained.
      expect(target).toMatch(/<>\s*'REASON_REDACTED'/)
      expect(versions).toMatch(/<>\s*'REASON_REDACTED'/)
    })

    /**
     * WHAT IS STILL NOT DISCHARGED, and why this is a pin rather than a test.
     * The row is now WRITABLE; the redaction still cannot WRITE it, because
     * `crm_retention_redact_action_reason` needs `UPDATE (reason)` and holds
     * `SELECT, DELETE` — the `42501` the header describes. That grant is r5 Task
     * 1.4b-iii, deliberately justified by this now-meaningful failing run. When
     * the grant lands, the function appends the row and this pin goes red,
     * pointing whoever lands it at the three places that still say "not
     * discharged" (the DDL header, the memo's status, the r5 plan).
     */
    it('GAP PIN — the function still cannot write it: no INSERT wired, no UPDATE (reason) granted', async () => {
      const { rows } = await q(
        `SELECT pg_get_functiondef(oid) AS def FROM pg_proc
          WHERE proname = 'crm_retention_redact_action_reason'`,
      )
      expect(rows[0].def).not.toContain('REASON_REDACTED')
    })
  })
})
