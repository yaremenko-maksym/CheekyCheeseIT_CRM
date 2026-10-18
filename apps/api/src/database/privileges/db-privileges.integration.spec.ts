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

/**
 * One sequence that really exists in `public`, read from the catalog.
 *
 * Hardcoding a name would make the parts-3-and-4 tests below pass vacuously the day the
 * column behind it stops being a serial — `GRANT … ON SEQUENCE` on a missing sequence
 * raises, which reads as a broken test rather than as drift.
 */
async function sequenceInPublic(): Promise<string> {
  const { rows } = await migration.query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'S'
      ORDER BY c.relname
      LIMIT 1`,
  )
  const name = rows[0]?.name
  if (!name) throw new Error('[db-privileges] no sequence in public to exercise part 4 with')
  return name
}

/**
 * Runs the whole committed catalog check and returns its failure message, or `null`.
 *
 * The check file is one transaction, so it must run on ONE connection: `Pool#query` may
 * hand each statement a different client, which would turn `BEGIN` and the assertions into
 * separate sessions and quietly make every drift test pass.
 *
 * At file scope because two describes use it — the drift tests and the parts-3-and-4 tests.
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

    // The probe tables. A relation created after the grants file inherits NOTHING now
    // that no default privilege covers TABLES (SR-H-1), so each probe is granted exactly
    // the class it stands for — explicitly, which is also how a real new table gets its
    // privileges: the grants file names it. `privprobe_a` is granted class A here; the
    // other classes are applied in their own describe below.
    for (const table of Object.values(PROBE)) {
      if (table === PROBE.V) continue
      await migration.query(`DROP TABLE IF EXISTS ${table} CASCADE`)
      await migration.query(`CREATE TABLE ${table} (id serial PRIMARY KEY, payload text)`)
      await migration.query(`INSERT INTO ${table} (payload) VALUES ('seed')`)
    }
    await migration.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${PROBE.A} TO ${ROLES.app}`,
    )
    await migration.query(`GRANT USAGE, SELECT ON SEQUENCE ${PROBE.A}_id_seq TO ${ROLES.app}`)
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
      // This is what lets one file serve every rollout step. It also covers the migration
      // role specifically — whose password this file now has NO path to touch at all, by
      // the owner's decision of 2026-10-18 (see the file's header): the deploy connects as
      // that role, so a rotation firing on "a secret appeared" breaks every subsequent
      // deploy if the secret and the stored password ever diverge. Here the role is
      // `current_user`, i.e. the migration role, and re-applying the whole file leaves its
      // stored verifier byte-identical.
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
      // strips the grants this describe makes by hand, so the first snapshot and the
      // second would differ by exactly that, and a REAL loss of idempotence would be
      // invisible in the noise.
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

  describe('a relation created after the grants file — no default privilege opens it', () => {
    // SR-H-1. An earlier revision attached `ALTER DEFAULT PRIVILEGES … GRANT SELECT,
    // INSERT, UPDATE, DELETE ON TABLES TO crm_app` to the migration role, to make "a new
    // class A table is reachable the moment it is created" true. Two things were wrong
    // with it, and the second is the serious one:
    //
    //   1. It bought nothing. `privilege-classes.spec.ts` derives its relation list from
    //      the Drizzle schema and fails on any unclassified `pgTable`, so a new table
    //      cannot ship without a manifest entry and regenerated grants anyway.
    //   2. `ON TABLES` includes VIEWS, and privileges on the base tables of an
    //      auto-updatable view are checked against the VIEW OWNER — the migration role.
    //      So a view created over a class B, A-log, E or V relation was WRITABLE by
    //      crm_app: a path straight around the revoke those classes exist to make.
    //
    // These four statements are the measurement, in the order it was taken. The first
    // held before the fix; the other three did not.
    it('cannot be written through a view over an append-only or unreachable table', async () => {
      const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const overB = `privprobe_v_over_class_b_${suffix}`
      const classE = `privprobe_class_e_backup_${suffix}`
      const overE = `privprobe_v_over_class_e_${suffix}`
      // A stand-in for class E built the way class E is defined — the API gets nothing —
      // rather than relying on one of the manual-DDL backups being present here.
      await migration.query(`CREATE TABLE ${classE} (id serial PRIMARY KEY, amount integer)`)
      await migration.query(`REVOKE ALL ON TABLE ${classE} FROM ${ROLES.app}, ${ROLES.collector}`)
      await migration.query(`CREATE VIEW ${overB} AS SELECT * FROM job_queue_actions`)
      await migration.query(`CREATE VIEW ${overE} AS SELECT * FROM ${classE}`)
      try {
        // 1. The revoke itself, on the real class B table. This always held.
        expect(await sqlstateOf(app, `UPDATE job_queue_actions SET kind = kind WHERE false`)).toBe(
          INSUFFICIENT_PRIVILEGE,
        )
        // 2-4. The same relation, and an unreachable one, through a view created after the
        // grants file ran. `WHERE false` so that a regression is a privilege result and
        // never a changed row.
        expect(await sqlstateOf(app, `UPDATE ${overB} SET kind = kind WHERE false`)).toBe(
          INSUFFICIENT_PRIVILEGE,
        )
        expect(await sqlstateOf(app, `DELETE FROM ${overB} WHERE false`)).toBe(
          INSUFFICIENT_PRIVILEGE,
        )
        expect(await sqlstateOf(app, `INSERT INTO ${overE} (amount) VALUES (999)`)).toBe(
          INSUFFICIENT_PRIVILEGE,
        )
        // Not even readable: a view, like a table, is reachable only once a grant names it.
        expect(await sqlstateOf(app, `SELECT 1 FROM ${overB}`)).toBe(INSUFFICIENT_PRIVILEGE)
      } finally {
        await migration.query(`DROP VIEW IF EXISTS ${overB}`)
        await migration.query(`DROP VIEW IF EXISTS ${overE}`)
        await migration.query(`DROP TABLE IF EXISTS ${classE} CASCADE`)
      }
    })

    it('is unreachable until a grant names it — fail closed, loudly', async () => {
      // The inverse of the test this replaces, which asserted a fresh table was usable
      // immediately. It is now unreachable, and that is the point: `permission denied`,
      // SQLSTATE 42501, is a loud failure in the deploy or in a log, whereas an
      // over-granted new table is silent. What makes this safe to rely on is upstream of
      // the database: a `pgTable` with no manifest entry fails the unit suite.
      const fresh = `privprobe_fresh_${Date.now().toString(36)}`
      await migration.query(`CREATE TABLE ${fresh} (id serial PRIMARY KEY)`)
      try {
        expect(await sqlstateOf(app, `SELECT 1 FROM ${fresh}`)).toBe(INSUFFICIENT_PRIVILEGE)
        expect(await sqlstateOf(app, `INSERT INTO ${fresh} DEFAULT VALUES`)).toBe(
          INSUFFICIENT_PRIVILEGE,
        )
        // And the sequence default privilege is KEPT, so a table whose grants do arrive
        // does not then fail on its own identity column — the one thing the table-level
        // default privilege was load-bearing for.
        await migration.query(`GRANT INSERT ON TABLE ${fresh} TO ${ROLES.app}`)
        expect(await sqlstateOf(app, `INSERT INTO ${fresh} DEFAULT VALUES`)).toBeNull()
      } finally {
        await migration.query(`DROP TABLE IF EXISTS ${fresh} CASCADE`)
      }
    })
  })

  describe('part 8 (role membership) — one test per operand of its branch predicate', () => {
    // CR-H-1. Every one of the five operands of part 8's `OR` chain, and its row-count
    // `HAVING` branch, could be DELETED by hand and this spec stayed green. The reason is
    // structural rather than careless, and it recurs: Stryker mutates the logical
    // OPERATOR, never a single operand, so "zero surviving mutants" and "an unpinned
    // conjunct" are both true at once. Only a hand deletion finds it, and only a test per
    // operand keeps it found.
    //
    // The chain has two branches and production takes the superuser one — production's
    // `crm_user` is `rolsuper = t`. Operand 1 (`owner_is_superuser`) decides that branch
    // alone, which also makes operands 2-5 UNREACHABLE while it is true: pinning them
    // needs a database whose `public` tables are owned by a NON-superuser, so that is what
    // this describe builds. One throwaway database, one non-superuser owner, and part 8
    // extracted from the committed check file and run on its own.
    const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const owner = `privprobe_owner_${suffix}`
    const other = `privprobe_other_${suffix}`
    const branchDb = `privprobe_branch_${suffix}`
    const allowed = 'WITH ADMIN TRUE, INHERIT FALSE, SET FALSE'
    let branch: Pool

    /**
     * The ONE statement of the committed check file that is the named part.
     *
     * It throws unless exactly one statement matches, because the failure mode of an
     * extraction like this is selecting nothing and making every test below pass on an
     * empty string — the same class of defect these tests exist to close.
     */
    function partStatement(label: string): string {
      const matches = splitSqlStatements(readSql(CHECK_FILE)).filter((st) => st.includes(label))
      if (matches.length !== 1) {
        throw new Error(`expected exactly one statement for ${label}, found ${matches.length}`)
      }
      return matches[0] as string
    }

    /** Runs part 8 against one connection and returns the failure message, or null. */
    async function runPart8(pool: Pool): Promise<string | null> {
      const client: PoolClient = await pool.connect()
      try {
        await client.query(partStatement('part 8 (role membership)'))
        return null
      } catch (error) {
        return (error as Error).message
      } finally {
        client.release()
      }
    }

    /** Puts the cluster's membership row for `crm_app` into exactly one state. */
    async function grantAppTo(member: string, options: string): Promise<void> {
      await migration.query(`REVOKE ${ROLES.app} FROM ${owner}, ${other}`)
      await migration.query(`GRANT ${ROLES.app} TO ${member} ${options}`)
    }

    beforeAll(async () => {
      await migration.query(`CREATE ROLE ${owner} NOSUPERUSER NOCREATEROLE NOCREATEDB NOLOGIN`)
      await migration.query(`CREATE ROLE ${other} NOSUPERUSER NOCREATEROLE NOCREATEDB NOLOGIN`)
      // `CREATE DATABASE` cannot run inside a transaction, so it goes through the pool
      // directly. It uses template1, which nothing connects to — unlike the integration
      // database itself, which is why this file does not template THAT (see the header).
      await migration.query(`CREATE DATABASE ${branchDb}`)
      const url = new URL(process.env['DATABASE_URL'] as string)
      url.pathname = `/${branchDb}`
      branch = new Pool({ connectionString: url.toString(), max: 1 })
      // What flips the branch: the owner of the relations in `public` here is a
      // non-superuser, and part 8 derives the migration role from exactly that.
      await branch.query(`CREATE TABLE owned_by_a_non_superuser (id integer)`)
      await branch.query(`ALTER TABLE owned_by_a_non_superuser OWNER TO ${owner}`)
      // The state PostgreSQL 16 itself produces in this branch, for all three roles.
      for (const role of [ROLES.app, ROLES.collector, ROLES.retentionOwner]) {
        await migration.query(`GRANT ${role} TO ${owner} ${allowed}`)
      }
    }, 60_000)

    afterAll(async () => {
      // The membership rows are CLUSTER-wide, so leaving one behind would fail part 8 for
      // every later test in this file and for anything else sharing the cluster.
      for (const role of [ROLES.app, ROLES.collector, ROLES.retentionOwner]) {
        await migration?.query(`REVOKE ${role} FROM ${owner}, ${other}`).catch(() => undefined)
      }
      await branch?.end()
      await migration?.query(`DROP DATABASE IF EXISTS ${branchDb}`).catch(() => undefined)
      await migration?.query(`DROP ROLE IF EXISTS ${owner}`).catch(() => undefined)
      await migration?.query(`DROP ROLE IF EXISTS ${other}`).catch(() => undefined)
    })

    it('passes in the non-superuser branch on the state PostgreSQL 16 itself produces', async () => {
      // Without this the tests below would be unfalsifiable in the other direction: a part
      // 8 that failed on everything would "pin" every operand just as well.
      expect(await runPart8(branch)).toBeNull()
    })

    it('SR-M-1: no membership row at all passes, whatever rolsuper says', async () => {
      // The state production is in — roles created by a superuser, so PostgreSQL made no
      // membership row — and the state it STAYS in after ADR §4's own hardening step
      // `ALTER ROLE crm_user NOSUPERUSER CREATEROLE`. Creator-membership is a fact about
      // who CREATED the role; `rolsuper` is a fact about who the role is NOW. An earlier
      // revision derived the expected row COUNT from the second, so that step would have
      // failed every deploy after it, and the only remedy its message read as was
      // `GRANT crm_app TO crm_user` — the opposite of hardening.
      //
      // Both branches are asserted in one test deliberately: the defect was the asymmetry
      // between them, and a test that visited only one would not have seen it. `branch` is
      // the non-superuser-owner database, `migration` the superuser one.
      for (const role of [ROLES.app, ROLES.collector, ROLES.retentionOwner]) {
        await migration.query(`REVOKE ${role} FROM ${owner}`)
      }
      try {
        expect(await runPart8(branch)).toBeNull()
        expect(await runPart8(migration)).toBeNull()
      } finally {
        for (const role of [ROLES.app, ROLES.collector, ROLES.retentionOwner]) {
          await migration.query(`GRANT ${role} TO ${owner} ${allowed}`)
        }
      }
    })

    it('SR-M-1: one creator-membership row passes in the superuser branch too', async () => {
      // The other half of the asymmetry, from the other side: a row of exactly the shape
      // PostgreSQL 16 produces for a non-superuser creator is ALLOWED even where the
      // migration role is currently a superuser. Nothing about the row says which branch
      // made it, so a check that reads the branch off `rolsuper` necessarily gets one of
      // the two wrong — this is the half that fired on the ADR's hardening step.
      //
      // It owns the whole cluster's membership state for its duration: the grants
      // `beforeAll` made become DEPENDENT privileges the moment the migration role is
      // itself a member (it is their grantor), and PostgreSQL then refuses to revoke that
      // membership without CASCADE — which would silently take the other grants with it.
      for (const role of [ROLES.app, ROLES.collector, ROLES.retentionOwner]) {
        await migration.query(`REVOKE ${role} FROM ${owner}`)
      }
      try {
        await migration.query(`GRANT ${ROLES.app} TO CURRENT_USER ${allowed}`)
        expect(await runPart8(migration)).toBeNull()
      } finally {
        await migration.query(`REVOKE ${ROLES.app} FROM CURRENT_USER`).catch(() => undefined)
        for (const role of [ROLES.app, ROLES.collector, ROLES.retentionOwner]) {
          await migration.query(`GRANT ${role} TO ${owner} ${allowed}`)
        }
      }
    })

    it('operand 2 (member <> migration role): rejects a grant to anyone else', async () => {
      // One row, so the row-count branch is satisfied; the member is not the migration
      // role, which is the whole of what makes it wrong — another role that can SET ROLE
      // to crm_app is another route into it.
      await grantAppTo(other, allowed)
      const failure = await runPart8(branch)
      expect(failure).toContain('which is not the creator-membership shape')
      expect(failure).toContain(other)
      await grantAppTo(owner, allowed)
      expect(await runPart8(branch)).toBeNull()
    })

    it('operand 3 (NOT admin_option): rejects a grant made without ADMIN', async () => {
      // PostgreSQL 16's automatic creator-membership always carries ADMIN. A row without
      // it was made by something else, and what made it is the question the deploy must
      // stop for.
      await grantAppTo(owner, 'WITH ADMIN FALSE, INHERIT FALSE, SET FALSE')
      const failure = await runPart8(branch)
      expect(failure).toContain('admin=f')
      await grantAppTo(owner, allowed)
      expect(await runPart8(branch)).toBeNull()
    })

    it('operand 4 (inherit_option): rejects INHERIT, which hands the privileges over', async () => {
      // With INHERIT the migration role holds crm_app's privileges without SET ROLE. It is
      // a superuser on production and gains nothing by it — but the day it is not, that is
      // the boundary gone, and `createrole_self_grant` in the roles file constrains only
      // the moment the grant is made.
      await grantAppTo(owner, 'WITH ADMIN TRUE, INHERIT TRUE, SET FALSE')
      const failure = await runPart8(branch)
      expect(failure).toContain('inherit=t')
      await grantAppTo(owner, allowed)
      expect(await runPart8(branch)).toBeNull()
    })

    it('operand 5 (set_option): rejects SET, which is the SET ROLE path itself', async () => {
      await grantAppTo(owner, 'WITH ADMIN TRUE, INHERIT FALSE, SET TRUE')
      const failure = await runPart8(branch)
      expect(failure).toContain('set=t')
      await grantAppTo(owner, allowed)
      expect(await runPart8(branch)).toBeNull()
    })

    it('the row-count branch: rejects a SECOND member, by arithmetic', async () => {
      // What the count catches, stated as measured rather than as assumed. The reviewer's
      // case for it was "two grants of the same shape to the same member from different
      // grantors, which the predicate cannot see because it never reads the grantor" —
      // and on 16.15 that state is NOT PRODUCIBLE: a superuser's second grant is merged
      // into the existing row (grantor stays the first one), a non-superuser grantor must
      // itself hold ADMIN and so is itself a membership row the shape predicate names,
      // and the migration role cannot be its own second grantor ("ADMIN option cannot be
      // granted back to your own grantor"). All three measured on this container,
      // 2026-10-18.
      //
      // So the reachable state is two MEMBERS, and the count is what names the set rather
      // than one row of it. This asserts the count's own message specifically: the shape
      // predicate fires on the same state for the extra member, so a test that accepted
      // mere failure would stay green with the count branch deleted.
      await migration.query(`GRANT ${ROLES.app} TO ${other} ${allowed}`)
      try {
        const failure = await runPart8(branch)
        expect(failure).toContain('has 2 membership rows, expected at most 1')
      } finally {
        await migration.query(`REVOKE ${ROLES.app} FROM ${other}`)
      }
      expect(await runPart8(branch)).toBeNull()
    })
  })

  describe('the catalog check (ADR §2) — and that it actually fails on drift', () => {
    it('passes against the database the files just built', async () => {
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('fails, naming the relation, when a table in public is unclassified (AC3)', async () => {
      // The failure mode the whole design exists to prevent: a table nobody classified.
      // It is now unreachable rather than silently writable (SR-H-1 removed the default
      // privilege that used to open it), but unreachable is not the same as reviewed — an
      // audit log or a ledger table added later must get a CLASS, and this is what refuses
      // the deploy until it has one.
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

    // NOT TESTED HERE: part 1's other direction — the manifest naming a relation that does
    // not exist. Reaching it needs a CLASSIFIED table to be absent, and every classified
    // table is a real one that the rest of the integration suite is using concurrently. The
    // first version of this spec renamed `tos_versions` to produce that state and broke
    // eight other spec files in the same run (measured: onboarding, contracts, pending and
    // five more). A test that only passes when it runs alone is worse than no test.
    //
    // The same mistake is caught earlier and without a database by
    // `privilege-classes.spec.ts` ("names no relation the Drizzle schema does not declare"),
    // which fails on a manifest entry for a table that no longer exists — the case this
    // branch would have covered.

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

    it('repairs a table default privilege the earlier revision of the roles file left', async () => {
      // The one drift this suite must also prove is REPAIRED rather than merely detected.
      // A database where the earlier revision ran carries a `pg_default_acl` row that no
      // deleted statement can remove, so the roles file revokes it explicitly; without
      // that, part 5 would fail on every deploy of such a database forever.
      await migration.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLES.app}`,
      )
      const failure = await runCheck(migration)
      expect(failure).toMatch(/part 5 \(default privileges\)/)
      expect(failure).toContain('on new r objects')

      await applyFile(ROLES_FILE)
      expect(await runCheck(migration)).toBeNull()
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
      //
      // The group granted here holds NO privileges, on purpose. The first version used
      // `pg_read_all_data`, and part 2 fired first because that role really does hand
      // `crm_app` SELECT on every table — a true finding, but it would have let part 8 rot
      // undetected behind part 2. An empty group isolates membership as the only difference.
      const group = 'privprobe_empty_group'
      await migration.query(`DROP ROLE IF EXISTS ${group}`)
      await migration.query(`CREATE ROLE ${group} NOLOGIN`)
      await migration.query(`GRANT ${group} TO ${ROLES.app}`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 8 \(role membership\)/)
        expect(failure).toContain('must be a member of no role')
      } finally {
        await migration.query(`REVOKE ${group} FROM ${ROLES.app}`)
        await migration.query(`DROP ROLE IF EXISTS ${group}`)
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

  describe('parts 3 and 4, which nothing could turn red (CR-H-2)', () => {
    // Every other part of the check had a drift test; these two had none, so "all nine
    // parts are proven" was an unproven claim about two of them. The SQL was never the
    // defect — it works, as these tests show — but a part no test can turn red is a part
    // that could be deleted, or quietly neutered by a manifest change, with nothing
    // noticing. One test per branch that can actually fire today.
    //
    // `runCheck` comes from the enclosing describe: the whole committed file on one
    // connection, which is how the deploy runs it.

    it('part 3 fails on a column SELECT the manifest does not declare', async () => {
      // The trap this part exists for: `information_schema.column_privileges` expands a
      // TABLE grant into one row per column, so a column-level grant hides inside a view
      // that otherwise looks like the table-level one. `collectorColumns` is empty today,
      // so ANY column SELECT for the collector is undeclared.
      //
      // Part 2 stays silent on this, which is why the failure can only be part 3's:
      // measured on 16.15, `has_table_privilege('crm_app','job_queue_actions','UPDATE')`
      // is false while a column-level UPDATE on it is held.
      await migration.query(`GRANT SELECT (id) ON TABLE users TO ${ROLES.collector}`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 3 \(column privileges\)/)
        expect(failure).toContain('users.id')
        expect(failure).toContain('which the manifest does not declare')
      } finally {
        await migration.query(`REVOKE SELECT (id) ON TABLE users FROM ${ROLES.collector}`)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('CR-M-3: part 3 fails on a column SELECT granted to the retention owner', async () => {
      // The hole CR-M-3 names: part 3 read `grantee = crm_collector` in the direction that
      // finds a stray grant, so `GRANT SELECT (id, email) ON users TO crm_retention_owner`
      // passed the check — and the next deploy's grants reset (its column-level sweep
      // covers all three roles) removed it SILENTLY, with nothing in the deploy log and
      // nothing in the check output. A privilege that is reverted without being reported
      // is the same defect as one that is never noticed: the state that produced it is
      // still there.
      //
      // `crm_retention_owner` is the sharper case of the two, because it holds no
      // table-level privilege on any class, so every column grant to it is undeclared by
      // construction — and it is the role that will own the SECURITY DEFINER retention
      // functions in Task 1.3b.
      await migration.query(`GRANT SELECT (id, email) ON TABLE users TO ${ROLES.retentionOwner}`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 3 \(column privileges\)/)
        expect(failure).toContain(ROLES.retentionOwner)
        expect(failure).toContain('users.email')
        expect(failure).toContain('which the manifest does not declare')
      } finally {
        await migration.query(
          `REVOKE SELECT (id, email) ON TABLE users FROM ${ROLES.retentionOwner}`,
        )
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('CR-M-3: part 3 fails on a column SELECT granted to crm_app on a class E table', async () => {
      // The same hole for the role that DOES hold table-level SELECT on most classes, so
      // the expected set cannot simply be "no column rows at all": `crm_app`'s column rows
      // on a class A table are the legitimate expansion of its table grant. A class E
      // relation grants it nothing, so a column SELECT there is drift — and class E is
      // where the row backups of `transactions` and of salary data live.
      const table = '_settle_phantom_backup_20260715'
      const { rows } = await migration.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = 'public' AND c.relname = $1) AS exists`,
        [table],
      )
      // Class E's relations are all OPTIONAL (manual-DDL artefacts), so this creates the
      // one it needs rather than depending on which data-fix files ran here. It is
      // classified, so part 1 stays quiet about it.
      if (!rows[0]?.exists) {
        await migration.query(`CREATE TABLE ${table} (id integer, note text)`)
      }
      try {
        await migration.query(`GRANT SELECT (note) ON TABLE ${table} TO ${ROLES.app}`)
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 3 \(column privileges\)/)
        expect(failure).toContain(`${table}.note`)
      } finally {
        await migration
          .query(`REVOKE SELECT (note) ON TABLE ${table} FROM ${ROLES.app}`)
          .catch(() => undefined)
        if (!rows[0]?.exists) {
          await migration.query(`DROP TABLE IF EXISTS ${table} CASCADE`)
        }
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('part 3 fails on a column privilege that is not SELECT', async () => {
      // SELECT is the only privilege ever granted at column level (class D's whole
      // mechanism). A column-level UPDATE on the append-only log is exactly the write the
      // class revokes, re-granted one column at a time.
      await migration.query(`GRANT UPDATE (kind) ON TABLE job_queue_actions TO ${ROLES.app}`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 3 \(column privileges\)/)
        expect(failure).toContain('holds column UPDATE on job_queue_actions.kind')
      } finally {
        await migration.query(`REVOKE UPDATE (kind) ON TABLE job_queue_actions FROM ${ROLES.app}`)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('part 4 fails when crm_app is given UPDATE on a sequence — setval, the id-collision path', async () => {
      // ADR §2, "Sequences": UPDATE on a sequence is `setval`, i.e. the ability to rewind
      // it and collide primary keys. It is the one sequence privilege the model forbids,
      // and until now nothing checked that the check checks it.
      const sequence = await sequenceInPublic()
      await migration.query(`GRANT UPDATE ON SEQUENCE ${sequence} TO ${ROLES.app}`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 4 \(sequence privileges\)/)
        expect(failure).toContain(`sequence ${sequence}`)
        expect(failure).toContain('holds UPDATE')
      } finally {
        await migration.query(`REVOKE UPDATE ON SEQUENCE ${sequence} FROM ${ROLES.app}`)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('part 4 fails in the other direction too, when crm_app loses USAGE on a sequence', async () => {
      // The direction that is an outage rather than a hole: without USAGE every INSERT
      // into a table with an identity column fails. Both directions matter, and a part
      // that only caught one would look the same in a green run.
      const sequence = await sequenceInPublic()
      await migration.query(`REVOKE USAGE ON SEQUENCE ${sequence} FROM ${ROLES.app}`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 4 \(sequence privileges\)/)
        expect(failure).toContain(`sequence ${sequence}`)
        expect(failure).toContain('lacks USAGE')
      } finally {
        await applyFile(GRANTS_FILE)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('part 4 fails when the collector is given a sequence outside its class C tables', async () => {
      // No class C table is assigned yet, so the collector's expected sequence set is
      // EMPTY — and an empty expectation is the easiest kind to satisfy by accident. This
      // is what makes "fail closed" an assertion rather than a hope.
      const sequence = await sequenceInPublic()
      await migration.query(`GRANT USAGE ON SEQUENCE ${sequence} TO ${ROLES.collector}`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 4 \(sequence privileges\)/)
        expect(failure).toContain(ROLES.collector)
        expect(failure).toContain('holds USAGE')
      } finally {
        await migration.query(`REVOKE USAGE ON SEQUENCE ${sequence} FROM ${ROLES.collector}`)
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
