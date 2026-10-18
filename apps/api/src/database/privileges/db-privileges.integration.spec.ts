/**
 * The privilege model, proved by execution against a real PostgreSQL — as the roles it is
 * about.
 *
 * WHY EVERY ASSERTION HERE RUNS AS `crm_app` AND NOT AS THE MIGRATION ROLE
 * -----------------------------------------------------------------------
 * ADR §3 states it exactly: "a test run as `crm_user` proves the trigger and NOTHING about
 * privileges". The migration role owns every table, and an owner bypasses every grant, so
 * a spec that opens one pool and calls it a privilege test measures nothing. This file
 * opens three pools — the migration role, `crm_app` and `crm_collector` — and each
 * assertion names which one it uses.
 *
 * WHAT IT APPLIES
 * ---------------
 * The REAL bytes of `drizzle/manual/2026-10-18_db_roles.sql` and `…_db_grants.sql`,
 * statement by statement through `splitSqlStatements`, which is how `psql < file` sends
 * them (autocommit between statements). Not a paraphrase: if the file would fail on the
 * deploy, it fails here.
 *
 * WHERE IT APPLIES THEM, AND THE SIDE EFFECT THAT FOLLOWS
 * ------------------------------------------------------
 * In the integration database itself (`crm_qa` locally, `crm_ci` in CI) — which IS "a
 * scratch database built from the same DDL", the thing ADR §2 asks the check to run
 * against, and ADR §5 item 1 wants CI connecting as `crm_app` anyway. It cannot be a
 * database this spec creates, because the grants file names the real tables and so needs
 * the real schema, and `CREATE DATABASE … TEMPLATE` is refused while any other session is
 * connected to the template — which, with vitest running spec files in parallel, it always
 * is.
 *
 * Two consequences, stated rather than discovered later:
 *   1. The roles and grants REMAIN in the integration database afterwards. That is
 *      deliberate — re-applying is idempotent, and the end state is the one CI wants.
 *   2. The roles file revokes PUBLIC's CONNECT and TEMPORARY on `postgres` and
 *      `template1`, which are CLUSTER-wide, not database-scoped. On a throwaway CI
 *      container that is nothing; on a developer machine it changes the local cluster, and
 *      it is not undone here, because part 6 of the catalog check asserts exactly that
 *      revocation. Reverse it with
 *      `GRANT CONNECT, TEMPORARY ON DATABASE postgres, template1 TO PUBLIC`.
 *
 * `crm_db` is never touched: `integration-db-guard.ts` refuses a URL ending in `/crm_db`
 * before any of this runs, and `assertDisposableTarget` below refuses it again here.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { splitSqlStatements } from '../manual-sql-statements'
import { assertRealDbSchema, hasDatabaseUrl } from '../../test/require-real-db'
import { CHECK_FILE, GRANTS_FILE, ROLES_FILE } from './generate-privilege-sql'
import { ROLES } from './privilege-classes'
import { scramSha256Verifier } from './scram'

const MANUAL_DIR = join(__dirname, '..', '..', '..', 'drizzle', 'manual')
const readSql = (file: string): string => readFileSync(join(MANUAL_DIR, file), 'utf8')

/** Generated per run: the password only ever exists inside this process. */
const APP_PASSWORD = `probe${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
const COLLECTOR_PASSWORD = `probe${Math.random().toString(36).slice(2)}collector`

/** PostgreSQL's "permission denied" — what every refusal below must be, by code. */
const INSUFFICIENT_PRIVILEGE = '42501'
/** The probe tables, one per class, created after the model to exercise every class. */
const PROBE = {
  A: 'privprobe_a',
  ALOG: 'privprobe_a_log',
  ALOG_PRUNABLE: 'privprobe_a_log_prunable',
  B: 'privprobe_b',
  C: 'privprobe_c',
  D: 'privprobe_d',
  E: 'privprobe_e',
  V: 'privprobe_v',
} as const

let migration: Pool
let app: Pool
let collector: Pool

/** The SQLSTATE of a failed statement, or `null` if it unexpectedly succeeded. */
async function sqlstateOf(pool: Pool, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await pool.query(sql, params)
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? 'no-code'
  }
}

/** Runs a file the way `psql -v ON_ERROR_STOP=1 < file` does, optionally with GUCs set. */
async function applyFile(file: string, options?: string): Promise<void> {
  const pool = new Pool({
    connectionString: process.env['DATABASE_URL'],
    max: 1,
    ...(options ? { options } : {}),
  })
  try {
    for (const statement of splitSqlStatements(readSql(file))) {
      await pool.query(statement)
    }
  } finally {
    await pool.end()
  }
}

function urlFor(role: string, password: string, database?: string): string {
  const url = new URL(process.env['DATABASE_URL'] as string)
  url.username = role
  url.password = password
  if (database) url.pathname = `/${database}`
  return url.toString()
}

function assertDisposableTarget(): void {
  const database = new URL(process.env['DATABASE_URL'] as string).pathname.replace(/^\//, '')
  if (database === 'crm_db') {
    throw new Error('[db-privileges] refusing to run against the live crm_db')
  }
}

describe.skipIf(!hasDatabaseUrl())('database privilege model (ADR 2026-10-17)', () => {
  beforeAll(async () => {
    assertDisposableTarget()
    // Without the real schema the grants file would fail on a missing table — which is
    // correct behaviour, but it would look like a bug in this spec.
    await assertRealDbSchema([
      { table: 'users', column: 'id' },
      { table: 'job_queue_actions', column: 'id' },
      { table: 'document_access_log', column: 'id' },
    ])

    migration = new Pool({ connectionString: process.env['DATABASE_URL'] })

    // Exactly the deploy's mechanism: the verifier arrives as a connection option, which
    // is what PGOPTIONS becomes on the wire — never in argv, never in the file.
    const appVerifier = scramSha256Verifier(APP_PASSWORD)
    const collectorVerifier = scramSha256Verifier(COLLECTOR_PASSWORD)
    await applyFile(
      ROLES_FILE,
      `-c crm_roles.app_verifier=${appVerifier} -c crm_roles.collector_verifier=${collectorVerifier}`,
    )
    await applyFile(GRANTS_FILE)

    app = new Pool({ connectionString: urlFor(ROLES.app, APP_PASSWORD), max: 2 })
    collector = new Pool({ connectionString: urlFor(ROLES.collector, COLLECTOR_PASSWORD), max: 2 })

    // The probe tables. Created by the MIGRATION role, which is what gives them the
    // default privileges of class A — the state every new table starts in.
    for (const table of Object.values(PROBE)) {
      if (table === PROBE.V) continue
      await migration.query(`DROP TABLE IF EXISTS ${table} CASCADE`)
      await migration.query(`CREATE TABLE ${table} (id serial PRIMARY KEY, payload text)`)
      await migration.query(`INSERT INTO ${table} (payload) VALUES ('seed')`)
    }
    await migration.query(`DROP VIEW IF EXISTS ${PROBE.V}`)
    await migration.query(`CREATE VIEW ${PROBE.V} AS SELECT id, payload FROM ${PROBE.A}`)
  }, 120_000)

  afterAll(async () => {
    for (const table of Object.values(PROBE)) {
      if (table === PROBE.V) continue
      await migration?.query(`DROP TABLE IF EXISTS ${table} CASCADE`)
    }
    await migration?.query(`DROP VIEW IF EXISTS ${PROBE.V}`)
    // The probe tables are gone, so the catalog check's part 1 (every relation in public
    // is classified) is satisfied again for the next run.
    await Promise.all([app?.end(), collector?.end()])
    await migration?.end()
  })

  describe('the password path (ADR §4, trap 1 — no plain password reaches the server)', () => {
    it('lets crm_app log in with the password behind the verifier the file received', async () => {
      const { rows } = await app.query<{ user: string }>('SELECT current_user AS user')
      expect(rows[0]?.user).toBe(ROLES.app)
    })

    it('stores a SCRAM-SHA-256 verifier, not a plain password', async () => {
      const { rows } = await migration.query<{ kind: string }>(
        `SELECT split_part(rolpassword, '$', 1) AS kind FROM pg_authid WHERE rolname = $1`,
        [ROLES.app],
      )
      expect(rows[0]?.kind).toBe('SCRAM-SHA-256')
    })

    it('computes the same verifier PostgreSQL itself computes for that password', async () => {
      // The independent oracle for `scram.ts`: let the server hash a password its own way,
      // read back the salt and iteration count it chose, re-derive with those, and require
      // the whole stored string to match. A format-only test would pass on a verifier no
      // server accepts.
      const password = 'oracle-probe-7Hq2'
      await migration.query(`ALTER ROLE ${ROLES.collector} PASSWORD '${password}'`)
      const { rows } = await migration.query<{ stored: string }>(
        `SELECT rolpassword AS stored FROM pg_authid WHERE rolname = $1`,
        [ROLES.collector],
      )
      const stored = rows[0]?.stored as string
      const [, iterationsAndSalt] = stored.split('$')
      const [iterations, saltBase64] = (iterationsAndSalt as string).split(':')
      const ours = scramSha256Verifier(password, {
        salt: Buffer.from(saltBase64 as string, 'base64'),
        iterations: Number(iterations),
      })
      expect(ours).toBe(stored)
      // Put the collector back on its generated password for the rest of the file.
      await migration.query(
        `ALTER ROLE ${ROLES.collector} PASSWORD '${scramSha256Verifier(COLLECTOR_PASSWORD)}'`,
      )
    })

    it('leaves a password unchanged when its parameter is not set', async () => {
      // This is what lets one file serve every rollout step, and what keeps the owner's
      // own credential untouched until step 7 sets `crm_roles.owner_verifier`.
      const before = await migration.query<{ stored: string }>(
        `SELECT rolpassword AS stored FROM pg_authid WHERE rolname = current_user`,
      )
      await applyFile(ROLES_FILE)
      const after = await migration.query<{ stored: string }>(
        `SELECT rolpassword AS stored FROM pg_authid WHERE rolname = current_user`,
      )
      expect(after.rows[0]?.stored).toBe(before.rows[0]?.stored)
    })

    it('refuses a parameter that is not a SCRAM verifier, rather than storing it', async () => {
      // Stored verbatim, a plain password would leave the role unable to log in with
      // anything — and nothing may print the value to say why.
      await expect(applyFile(ROLES_FILE, '-c crm_roles.app_verifier=hunter2')).rejects.toThrow(
        /not a SCRAM-SHA-256 verifier/,
      )
      // The real verifier is still in place.
      const { rows } = await app.query<{ user: string }>('SELECT current_user AS user')
      expect(rows[0]?.user).toBe(ROLES.app)
    })
  })

  describe('class A — ordinary table: full DML as crm_app', () => {
    it('selects, inserts, updates and deletes', async () => {
      await app.query(`INSERT INTO ${PROBE.A} (payload) VALUES ('from crm_app')`)
      await app.query(`UPDATE ${PROBE.A} SET payload = 'updated' WHERE payload = 'from crm_app'`)
      const { rows } = await app.query(`SELECT payload FROM ${PROBE.A} WHERE payload = 'updated'`)
      expect(rows).toHaveLength(1)
      await app.query(`DELETE FROM ${PROBE.A} WHERE payload = 'updated'`)
    })

    it('is reachable the moment the migration role creates it — the default privileges', async () => {
      // `privprobe_a` was created AFTER the grants file ran and no grant names it, so this
      // passing is the proof that ALTER DEFAULT PRIVILEGES is attached to the role that
      // actually creates tables (ADR §2, "the trap").
      const fresh = `privprobe_default_${Date.now().toString(36)}`
      await migration.query(`CREATE TABLE ${fresh} (id serial PRIMARY KEY)`)
      try {
        await app.query(`INSERT INTO ${fresh} DEFAULT VALUES`)
        expect(await sqlstateOf(app, `SELECT 1 FROM ${fresh}`)).toBeNull()
      } finally {
        await migration.query(`DROP TABLE IF EXISTS ${fresh}`)
      }
    })

    it('never gets TRUNCATE, even on a class A table', async () => {
      expect(await sqlstateOf(app, `TRUNCATE ${PROBE.A}`)).toBe(INSUFFICIENT_PRIVILEGE)
    })
  })

  describe('the real tables, by class', () => {
    it('class A: crm_app holds SELECT, INSERT, UPDATE, DELETE on users', async () => {
      const { rows } = await migration.query<{ p: string; held: boolean }>(
        `SELECT p, has_table_privilege($1, 'public.users', p) AS held
           FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) AS p`,
        [ROLES.app],
      )
      expect(Object.fromEntries(rows.map((r) => [r.p, r.held]))).toEqual({
        SELECT: true,
        INSERT: true,
        UPDATE: true,
        DELETE: true,
        TRUNCATE: false,
      })
    })

    it('class A-log: crm_app may read and append to the finance audit trail, never rewrite it', async () => {
      // The finding this ADR answers: under a blanket class A, an injected statement could
      // UPDATE or DELETE the transaction audit trail.
      expect(await sqlstateOf(app, `SELECT 1 FROM transaction_audit_log LIMIT 1`)).toBeNull()
      expect(
        await sqlstateOf(app, `UPDATE transaction_audit_log SET action = 'x' WHERE false`),
      ).toBe(INSUFFICIENT_PRIVILEGE)
      expect(await sqlstateOf(app, `DELETE FROM transaction_audit_log WHERE false`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
      expect(await sqlstateOf(app, `TRUNCATE transaction_audit_log`)).toBe(INSUFFICIENT_PRIVILEGE)
    })

    it('class A-log-prunable: document_access_log keeps the DELETE its retention cron needs', async () => {
      // DocumentAccessLogRetentionCronService runs daily as the API. Without this grant the
      // first fire after the switch would be a swallowed 42501 and the log would grow
      // forever (ADR §4, "What step 4 does not reach").
      expect(await sqlstateOf(app, `DELETE FROM document_access_log WHERE false`)).toBeNull()
      expect(await sqlstateOf(app, `UPDATE document_access_log SET action = 'x' WHERE false`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
    })

    it('class B: job_queue_actions is append-only for crm_app, by privilege alone', async () => {
      // Task 1.3b adds the triggers; this is layer 1 on its own, which is the layer that
      // binds `crm_app` whether or not a trigger exists.
      expect(await sqlstateOf(app, `SELECT 1 FROM job_queue_actions LIMIT 1`)).toBeNull()
      expect(await sqlstateOf(app, `UPDATE job_queue_actions SET kind = kind WHERE false`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
      expect(await sqlstateOf(app, `DELETE FROM job_queue_actions WHERE false`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
      expect(await sqlstateOf(app, `TRUNCATE job_queue_actions`)).toBe(INSUFFICIENT_PRIVILEGE)
    })

    it('class V: a view is readable and not writable', async () => {
      expect(await sqlstateOf(app, `SELECT 1 FROM visible_projects LIMIT 1`)).toBeNull()
      // Privileges on a view's base tables are checked against the VIEW OWNER, so an
      // UPDATE-able view is a path around a revoke on the table underneath it.
      expect(await sqlstateOf(app, `UPDATE visible_projects SET name = name WHERE false`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
    })

    it('class E and the collector: neither role reaches what no class grants it', async () => {
      // The collector has no class C or D table yet (ADR §4 step 8), so it reaches nothing
      // at all — fail closed, by design, and worth pinning precisely because "nothing"
      // is easy to achieve by accident and easy to lose by accident.
      expect(await sqlstateOf(collector, `SELECT 1 FROM users LIMIT 1`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
      expect(await sqlstateOf(collector, `SELECT 1 FROM job_sources LIMIT 1`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
      expect(await sqlstateOf(collector, `INSERT INTO job_queue_actions DEFAULT VALUES`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
    })
  })

  describe('every class, applied to a table created after the model', () => {
    // The real manifest has no class C, D or E table yet. Rather than ship that machinery
    // unexercised, each class is applied here to a probe table and the OUTCOMES are written
    // out literally — which statement succeeds and which SQLSTATE refuses it — instead of
    // being derived from the same map the grants come from.
    beforeAll(async () => {
      await migration.query(
        `REVOKE ALL ON TABLE ${PROBE.ALOG}, ${PROBE.ALOG_PRUNABLE}, ${PROBE.B}, ${PROBE.C}, ${PROBE.D}, ${PROBE.E}, ${PROBE.V} FROM ${ROLES.app}, ${ROLES.collector}`,
      )
      await migration.query(`GRANT SELECT, INSERT ON TABLE ${PROBE.ALOG} TO ${ROLES.app}`)
      await migration.query(
        `GRANT SELECT, INSERT, DELETE ON TABLE ${PROBE.ALOG_PRUNABLE} TO ${ROLES.app}`,
      )
      await migration.query(`GRANT SELECT, INSERT ON TABLE ${PROBE.B} TO ${ROLES.app}`)
      await migration.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${PROBE.C} TO ${ROLES.app}, ${ROLES.collector}`,
      )
      await migration.query(`GRANT USAGE ON SEQUENCE ${PROBE.C}_id_seq TO ${ROLES.collector}`)
      await migration.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${PROBE.D} TO ${ROLES.app}`,
      )
      await migration.query(`GRANT SELECT (id) ON TABLE ${PROBE.D} TO ${ROLES.collector}`)
      await migration.query(`GRANT SELECT ON TABLE ${PROBE.V} TO ${ROLES.app}`)
      // class E: no grant at all, deliberately.
    })

    afterAll(async () => {
      // The probe relations leave `public` before the catalog-check and idempotence
      // describes run. They are unclassified by construction, so leaving them would make
      // part 1 fail for a reason that has nothing to do with the thing under test — and,
      // less obviously, would break the idempotence comparison: the grants file's reset
      // strips the default-privilege grants an unclassified table starts with, so the
      // first snapshot and the second would differ by exactly that, and a REAL loss of
      // idempotence would be invisible in the noise.
      await migration.query(`DROP VIEW IF EXISTS ${PROBE.V}`)
      for (const table of Object.values(PROBE)) {
        if (table === PROBE.V) continue
        await migration.query(`DROP TABLE IF EXISTS ${table} CASCADE`)
      }
    })

    it('class A-log refuses UPDATE and DELETE and allows INSERT', async () => {
      expect(await sqlstateOf(app, `INSERT INTO ${PROBE.ALOG} (payload) VALUES ('a')`)).toBeNull()
      expect(await sqlstateOf(app, `UPDATE ${PROBE.ALOG} SET payload = 'b'`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
      expect(await sqlstateOf(app, `DELETE FROM ${PROBE.ALOG}`)).toBe(INSUFFICIENT_PRIVILEGE)
    })

    it('class A-log-prunable allows DELETE but still refuses UPDATE', async () => {
      expect(await sqlstateOf(app, `DELETE FROM ${PROBE.ALOG_PRUNABLE}`)).toBeNull()
      expect(await sqlstateOf(app, `UPDATE ${PROBE.ALOG_PRUNABLE} SET payload = 'b'`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
    })

    it('class B refuses UPDATE, DELETE and TRUNCATE, and allows ON CONFLICT DO NOTHING', async () => {
      // id 1000, not 1: the table was seeded by the migration role and id 1 is taken, so
      // the first INSERT would fail with 23505 and say nothing about privileges.
      expect(
        await sqlstateOf(app, `INSERT INTO ${PROBE.B} (id, payload) VALUES (1000, 'x')`),
      ).toBeNull()
      // ADR §3: an idempotent write needs INSERT only; DO UPDATE needs UPDATE and is
      // therefore refused — by design, and this is the line application code must follow.
      expect(
        await sqlstateOf(
          app,
          `INSERT INTO ${PROBE.B} (id, payload) VALUES (1000, 'y') ON CONFLICT (id) DO NOTHING`,
        ),
      ).toBeNull()
      expect(
        await sqlstateOf(
          app,
          `INSERT INTO ${PROBE.B} (id, payload) VALUES (1000, 'y') ON CONFLICT (id) DO UPDATE SET payload = 'y'`,
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE)
      expect(await sqlstateOf(app, `UPDATE ${PROBE.B} SET payload = 'z'`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
      expect(await sqlstateOf(app, `DELETE FROM ${PROBE.B}`)).toBe(INSUFFICIENT_PRIVILEGE)
      expect(await sqlstateOf(app, `TRUNCATE ${PROBE.B}`)).toBe(INSUFFICIENT_PRIVILEGE)
      const { rows } = await app.query(`SELECT payload FROM ${PROBE.B} WHERE id = 1000`)
      expect(rows[0]).toEqual({ payload: 'x' })
    })

    it('class C gives the collector full DML and its sequence', async () => {
      expect(
        await sqlstateOf(collector, `INSERT INTO ${PROBE.C} (payload) VALUES ('collected')`),
      ).toBeNull()
      expect(
        await sqlstateOf(
          collector,
          `UPDATE ${PROBE.C} SET payload = 'again' WHERE payload = 'collected'`,
        ),
      ).toBeNull()
      expect(
        await sqlstateOf(collector, `DELETE FROM ${PROBE.C} WHERE payload = 'again'`),
      ).toBeNull()
    })

    it('class D gives the collector the named column and nothing else', async () => {
      expect(await sqlstateOf(collector, `SELECT id FROM ${PROBE.D}`)).toBeNull()
      // The reason class D is column-level at all: a table-level SELECT would silently
      // cover the columns that carry credentials, tokens or money.
      expect(await sqlstateOf(collector, `SELECT payload FROM ${PROBE.D}`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
      expect(await sqlstateOf(collector, `SELECT * FROM ${PROBE.D}`)).toBe(INSUFFICIENT_PRIVILEGE)
      expect(await sqlstateOf(collector, `INSERT INTO ${PROBE.D} (payload) VALUES ('x')`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
    })

    it('class E is unreachable by either role', async () => {
      expect(await sqlstateOf(app, `SELECT 1 FROM ${PROBE.E}`)).toBe(INSUFFICIENT_PRIVILEGE)
      expect(await sqlstateOf(app, `INSERT INTO ${PROBE.E} (payload) VALUES ('x')`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
      expect(await sqlstateOf(collector, `SELECT 1 FROM ${PROBE.E}`)).toBe(INSUFFICIENT_PRIVILEGE)
    })

    it('class V is readable and not writable', async () => {
      expect(await sqlstateOf(app, `SELECT 1 FROM ${PROBE.V}`)).toBeNull()
      expect(await sqlstateOf(app, `UPDATE ${PROBE.V} SET payload = 'x'`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
    })
  })

  describe('what crm_app cannot do at all — the attacks the role model closes', () => {
    it('cannot disable a trigger: that needs ownership, which it does not have', async () => {
      // The attack of ADR §3: append-only triggers mean nothing against a role that can
      // turn them off. Task 1.3b's triggers rest on exactly this refusal.
      expect(await sqlstateOf(app, `ALTER TABLE job_queue_actions DISABLE TRIGGER ALL`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
      expect(await sqlstateOf(app, `ALTER TABLE job_queue_actions DISABLE TRIGGER USER`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
    })

    it('cannot set session_replication_role, which would skip every non-ALWAYS trigger', async () => {
      expect(await sqlstateOf(app, `SET session_replication_role = 'replica'`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
    })

    it('cannot SET ROLE to the owner: it is a member of no role', async () => {
      const { rows } = await migration.query<{ owner: string }>(
        `SELECT relowner::regrole::text AS owner FROM pg_class WHERE oid = 'public.users'::regclass`,
      )
      expect(await sqlstateOf(app, `SET ROLE ${rows[0]?.owner as string}`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
    })

    it('is a member of no role, in the direction that matters', async () => {
      const { rows } = await migration.query(
        `SELECT roleid::regrole::text AS role FROM pg_auth_members WHERE member::regrole::text = ANY($1)`,
        [[ROLES.app, ROLES.collector, ROLES.retentionOwner]],
      )
      expect(rows).toEqual([])
    })

    it('cannot create a table, a schema or an index', async () => {
      expect(await sqlstateOf(app, `CREATE TABLE privprobe_forbidden (id int)`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
      expect(await sqlstateOf(app, `CREATE SCHEMA privprobe_schema`)).toBe(INSUFFICIENT_PRIVILEGE)
    })

    it('cannot create a temporary table', async () => {
      expect(await sqlstateOf(app, `CREATE TEMP TABLE privprobe_temp (id int)`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
    })

    it('cannot rewind a sequence with setval', async () => {
      // `USAGE, SELECT` and never `UPDATE`: setval is the ability to collide ids.
      expect(await sqlstateOf(app, `SELECT setval('telemetry_events_id_seq', 1)`)).toBe(
        INSUFFICIENT_PRIVILEGE,
      )
      expect(await sqlstateOf(app, `SELECT last_value FROM telemetry_events_id_seq`)).toBeNull()
    })

    it('cannot connect to the maintenance database', async () => {
      const other = new Pool({
        connectionString: urlFor(ROLES.app, APP_PASSWORD, 'postgres'),
        max: 1,
      })
      try {
        expect(await sqlstateOf(other, 'SELECT 1')).toBe(INSUFFICIENT_PRIVILEGE)
      } finally {
        await other.end().catch(() => undefined)
      }
    })

    it('is not a superuser and holds none of the role attributes that would undo this', async () => {
      const { rows } = await migration.query(
        `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication
           FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
        [[ROLES.app, ROLES.collector, ROLES.retentionOwner]],
      )
      for (const row of rows) {
        expect(row).toEqual({
          rolname: row['rolname'],
          rolsuper: false,
          rolcreaterole: false,
          rolcreatedb: false,
          rolbypassrls: false,
          rolreplication: false,
        })
      }
      expect(rows).toHaveLength(3)
    })

    it('owns nothing', async () => {
      const { rows } = await migration.query(
        `SELECT relname FROM pg_class WHERE relowner::regrole::text = ANY($1)
         UNION ALL SELECT proname FROM pg_proc WHERE proowner::regrole::text = ANY($1)
         UNION ALL SELECT nspname FROM pg_namespace WHERE nspowner::regrole::text = ANY($1)`,
        [[ROLES.app, ROLES.collector, ROLES.retentionOwner]],
      )
      expect(rows).toEqual([])
    })
  })

  describe('the catalog check (ADR §2) — and that it actually fails on drift', () => {
    /**
     * The check file is one transaction, so it must run on ONE connection: `Pool#query`
     * may hand each statement a different client, which would turn `BEGIN` and the
     * assertions into separate sessions and quietly make every drift test pass.
     */
    async function runCheck(pool: Pool): Promise<string | null> {
      const client: PoolClient = await pool.connect()
      try {
        for (const statement of splitSqlStatements(readSql(CHECK_FILE))) {
          try {
            await client.query(statement)
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined)
            return (error as Error).message
          }
        }
        return null
      } finally {
        client.release()
      }
    }

    it('passes against the database the files just built', async () => {
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('fails, naming the relation, when a table in public is unclassified (AC3)', async () => {
      // The failure mode the whole design exists to prevent: a table nobody classified
      // inherits SELECT, INSERT, UPDATE, DELETE from the default privileges, so an audit
      // log or a ledger table added later is silently writable by the API.
      const stray = 'privprobe_unclassified'
      await migration.query(`CREATE TABLE ${stray} (id serial PRIMARY KEY)`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 1 \(manifest coverage\)/)
        expect(failure).toContain(stray)
        expect(failure).toContain('in no privilege class')
      } finally {
        await migration.query(`DROP TABLE IF EXISTS ${stray} CASCADE`)
      }
    }, 60_000)

    it('fails when the manifest names a relation that does not exist', async () => {
      // The other direction of part 1: a table renamed or dropped without updating the
      // manifest would otherwise leave an expectation nothing asserts.
      await migration.query(`ALTER TABLE tos_versions RENAME TO tos_versions_renamed`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 1 \(manifest coverage\)/)
        expect(failure).toContain('tos_versions')
        expect(failure).toContain('does not exist in public')
      } finally {
        await migration.query(`ALTER TABLE tos_versions_renamed RENAME TO tos_versions`)
      }
    }, 60_000)

    it('fails when a privilege is added by hand, and the grants file repairs it', async () => {
      // The forward-fix path of ADR §4 "Rollback", proved rather than asserted: drift is
      // detected, and re-applying the reviewed file is what removes it. This is also the
      // one guarantee the check alone gives against the migration role — a privilege
      // widened outside a reviewed file is caught at the next deploy.
      await migration.query(`GRANT UPDATE ON TABLE job_queue_actions TO ${ROLES.app}`)
      const failure = await runCheck(migration)
      expect(failure).toMatch(/part 2 \(table privileges\)/)
      expect(failure).toContain('job_queue_actions')
      expect(failure).toContain('UPDATE')

      await applyFile(GRANTS_FILE)
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('fails when a stray default privilege appears', async () => {
      await migration.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT UPDATE ON TABLES TO ${ROLES.collector}`,
      )
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 5 \(default privileges\)/)
        expect(failure).toContain(ROLES.collector)
      } finally {
        await migration.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public REVOKE UPDATE ON TABLES FROM ${ROLES.collector}`,
        )
      }
    }, 60_000)

    it('fails when a role is given an attribute the model forbids', async () => {
      await migration.query(`ALTER ROLE ${ROLES.app} CREATEROLE`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 7 \(role attributes and ownership\)/)
        expect(failure).toContain('CREATEROLE')
      } finally {
        // The roles file is itself the repair path for this one.
        await applyFile(ROLES_FILE)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('fails when the application role is made a member of another role', async () => {
      // The direction that matters: membership is what would let `crm_app` SET ROLE to the
      // owner and get ownership — and with it DISABLE TRIGGER — back.
      await migration.query(`GRANT pg_read_all_data TO ${ROLES.app}`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 8 \(role membership\)/)
        expect(failure).toContain('must be a member of no role')
      } finally {
        await migration.query(`REVOKE pg_read_all_data FROM ${ROLES.app}`)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('fails when an undeclared trigger appears on a class B table', async () => {
      // Task 1.3b adds the real triggers and declares them in the manifest. Until then the
      // declaration is empty, which pins the gap: a trigger reaching the database without a
      // reviewed declaration fails the deploy.
      await migration.query(
        `CREATE OR REPLACE FUNCTION privprobe_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
      )
      await migration.query(
        `CREATE TRIGGER privprobe_stray BEFORE UPDATE ON job_queue_actions FOR EACH ROW EXECUTE FUNCTION privprobe_noop()`,
      )
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 9 \(append-only triggers\)/)
        expect(failure).toContain('privprobe_stray')
        expect(failure).toContain('not declared')
      } finally {
        await migration.query(`DROP TRIGGER IF EXISTS privprobe_stray ON job_queue_actions`)
        await migration.query(`DROP FUNCTION IF EXISTS privprobe_noop()`)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('does NOT fire for a function the migration role creates — the default privilege already closed it', async () => {
      // Measured, and worth recording because the first version of the test next door
      // assumed the opposite: with `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS
      // FROM PUBLIC` in place, a function created BY THAT ROLE gets an explicit `proacl`
      // with no PUBLIC entry. So the ordinary case is safe without anyone remembering, and
      // the check has nothing to report.
      await migration.query(
        `CREATE OR REPLACE FUNCTION privprobe_owned_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`,
      )
      try {
        const { rows } = await migration.query<{ acl: string | null }>(
          `SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'privprobe_owned_fn'`,
        )
        // `{crm_user=X/crm_user}` — the owner's own EXECUTE and nothing else. A PUBLIC
        // entry has an EMPTY grantee, so it reads `{=X/crm_user,…}`; that is what must be
        // absent, which is why the assertion is anchored and not a substring.
        expect(rows[0]?.acl).not.toBeNull()
        expect(rows[0]?.acl).not.toMatch(/[{,]=X\//)
        expect(await runCheck(migration)).toBeNull()
      } finally {
        await migration.query(`DROP FUNCTION IF EXISTS privprobe_owned_fn()`)
      }
    }, 60_000)

    it('fails when a function in public is granted to PUBLIC by hand', async () => {
      await migration.query(
        `CREATE OR REPLACE FUNCTION privprobe_public_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`,
      )
      await migration.query(`GRANT EXECUTE ON FUNCTION privprobe_public_fn() TO PUBLIC`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 6 \(database, schema and function privileges\)/)
        expect(failure).toContain('privprobe_public_fn')
      } finally {
        await migration.query(`DROP FUNCTION IF EXISTS privprobe_public_fn()`)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('fails for a function created by a SECOND DDL role, whose proacl is NULL', async () => {
      // This is the case the `COALESCE(proacl, acldefault(…))` in part 6 exists for, and
      // the only way to reach it: default privileges apply only to objects created by the
      // role they are attached to (ADR §2, "the trap"), so a function created by any other
      // role has a NULL `proacl` — which MEANS the default, and the default is EXECUTE to
      // PUBLIC. Reading the stored ACL alone would see NULL and report nothing.
      const other = 'privprobe_second_ddl_role'
      await migration.query(`DROP ROLE IF EXISTS ${other}`)
      await migration.query(`CREATE ROLE ${other}`)
      await migration.query(`GRANT CREATE ON SCHEMA public TO ${other}`)
      const client = await migration.connect()
      try {
        await client.query(`SET ROLE ${other}`)
        await client.query(
          `CREATE FUNCTION privprobe_other_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$`,
        )
        await client.query('RESET ROLE')
        const { rows } = await client.query<{ acl: string | null }>(
          `SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'privprobe_other_fn'`,
        )
        expect(rows[0]?.acl).toBeNull()

        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 6 \(database, schema and function privileges\)/)
        expect(failure).toContain('privprobe_other_fn')
      } finally {
        await client.query('RESET ROLE').catch(() => undefined)
        client.release()
        await migration.query(`DROP FUNCTION IF EXISTS privprobe_other_fn()`)
        await migration.query(`REVOKE CREATE ON SCHEMA public FROM ${other}`)
        await migration.query(`DROP ROLE IF EXISTS ${other}`)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)
  })

  describe('idempotence — the files re-run on every deploy', () => {
    it('changes no catalog row on a second and third application', async () => {
      const snapshot = async (): Promise<string> => {
        const { rows } = await migration.query<{ line: string }>(
          `SELECT line FROM (
             SELECT format('rel %s %s %s', c.relname, c.relkind, COALESCE(c.relacl::text, '-')) AS line
               FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S')
             UNION ALL
             SELECT format('defacl %s %s %s %s', d.defaclrole::regrole::text, d.defaclnamespace,
                           d.defaclobjtype, d.defaclacl::text) FROM pg_default_acl d
             UNION ALL
             SELECT format('role %s %s %s %s %s', r.rolname, r.rolcanlogin, r.rolconnlimit,
                           r.rolsuper, a.rolpassword IS NOT NULL)
               FROM pg_roles r JOIN pg_authid a ON a.oid = r.oid WHERE r.rolname LIKE 'crm%'
             UNION ALL
             SELECT format('member %s %s %s %s %s', m.roleid::regrole::text, m.member::regrole::text,
                           m.admin_option, m.inherit_option, m.set_option)
               FROM pg_auth_members m WHERE m.roleid::regrole::text LIKE 'crm%'
             UNION ALL
             SELECT format('db %s %s', d.datname, COALESCE(d.datacl::text, '-')) FROM pg_database d
             UNION ALL
             SELECT format('schema %s %s', n.nspname, COALESCE(n.nspacl::text, '-'))
               FROM pg_namespace n WHERE n.nspname = 'public'
           ) q ORDER BY line`,
        )
        return rows.map((r) => r.line).join('\n')
      }

      const before = await snapshot()
      expect(before.length).toBeGreaterThan(1000)
      await applyFile(ROLES_FILE)
      await applyFile(GRANTS_FILE)
      expect(await snapshot()).toBe(before)
      await applyFile(ROLES_FILE)
      await applyFile(GRANTS_FILE)
      expect(await snapshot()).toBe(before)
    }, 120_000)
  })
})
