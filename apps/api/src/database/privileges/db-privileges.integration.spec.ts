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
 *      `template1`, which are CLUSTER-wide, not database-scoped, and part 6 of the catalog
 *      check asserts exactly that revocation. So the spec RECORDS both ACLs before it
 *      touches anything and, in an `afterAll` that also runs when a test (or `beforeAll`)
 *      fails, writes them back exactly — NULL included (`cluster-acl-snapshot.ts`).
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
import {
  CHECK_FILE,
  GRANTS_FILE,
  ROLES_FILE,
  collectorSequenceGrantSql,
} from './generate-privilege-sql'
import { ROLES, retentionOwnerFunctions } from './privilege-classes'
import { scramSha256Verifier } from './scram'
import {
  cleanupThenRestore,
  snapshotClusterAcls,
  type ClusterAclSnapshot,
} from './cluster-acl-snapshot'

const MANUAL_DIR = join(__dirname, '..', '..', '..', 'drizzle', 'manual')
const readSql = (file: string): string => readFileSync(join(MANUAL_DIR, file), 'utf8')

/**
 * Task 1.3b's triggers and R-B functions. Not a generated file and so not a constant of
 * `generate-privilege-sql.ts`, but a precondition of the generated CHECK — see `beforeAll`.
 */
const TRIGGERS_FILE = '2026-10-18_job_queue_append_only_triggers.sql'

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
let clusterAcls: ClusterAclSnapshot | undefined

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

/**
 * The ONE statement of the committed check file that is the named part.
 *
 * It throws unless exactly one statement matches, because the failure mode of an
 * extraction like this is selecting nothing and making every test using it pass on an
 * empty string — the same class of defect these tests exist to close.
 *
 * At file scope because two describes need it: part 8's operand tests, which need a part
 * run on a database the whole check could not pass on, and part 1's absent-relation test,
 * which needs the part's own text to mutate.
 */
function partStatement(label: string): string {
  const matches = splitSqlStatements(readSql(CHECK_FILE)).filter((st) => st.includes(label))
  if (matches.length !== 1) {
    throw new Error(`expected exactly one statement for ${label}, found ${matches.length}`)
  }
  return matches[0] as string
}

/** Runs ONE statement (a single part of the check) and returns its failure message, or null. */
async function runPart(pool: Pool, statement: string): Promise<string | null> {
  const client: PoolClient = await pool.connect()
  try {
    await client.query(statement)
    return null
  } catch (error) {
    return (error as Error).message
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
    // Before anything below can rewrite them — see the header, consequence 2.
    clusterAcls = await snapshotClusterAcls(process.env['DATABASE_URL'] as string)
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
    // Task 1.3b's DDL, applied here for the same reason the roles and grants files are:
    // the committed check this suite runs now ASSERTS 1.3b's objects — the two triggers of
    // `appendOnlyTriggers` (part 9) and the two definer functions of
    // `retentionOwnerFunctions`, which part 7 requires `crm_retention_owner` to own. On a
    // database where this file never ran, the check fails with "declared function … is not
    // owned by crm_retention_owner" and the failure is the suite's own missing
    // precondition, not drift. The deploy applies it between the roles and the grants, and
    // so does this; it is idempotent, so a sibling spec applying it too is harmless.
    await applyFile(TRIGGERS_FILE)
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
    // The restore runs LAST and in a `finally` (CR-M-11): before, it sat after these
    // unprotected awaits, so a failing cleanup STATEMENT — not only a failing test — left
    // PUBLIC's CONNECT revoked on the shared cluster. The pools close in their own
    // `finally` for the same reason. Pinned in `cluster-acl-snapshot.integration.spec.ts`.
    await cleanupThenRestore(async () => {
      try {
        for (const table of Object.values(PROBE)) {
          if (table === PROBE.V) continue
          await migration?.query(`DROP TABLE IF EXISTS ${table} CASCADE`)
        }
        await migration?.query(`DROP VIEW IF EXISTS ${PROBE.V}`)
        // The probe tables are gone, so the catalog check's part 1 (every relation in
        // public is classified) is satisfied again for the next run.
      } finally {
        await Promise.allSettled([app?.end(), collector?.end(), migration?.end()])
      }
    }, clusterAcls)
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

    it('CR-M-8: the generated class C sequence grant reaches that table’s sequence and no other', async () => {
      // The one piece of the grants file that is CODE rather than a flat statement list —
      // a `DO` block whose `pg_depend` join decides which sequences the collector reaches.
      // No class C table is assigned yet, so `buildGrantsSql()` does not emit it and the
      // unit spec can only match its text; the join itself (deptype 'a'/'i', the
      // owning-table filter) was proved by nothing. This runs the generator's own output
      // and asserts the outcome.
      //
      // The hand-written `GRANT USAGE ON SEQUENCE … TO crm_collector` in this describe's
      // `beforeAll` is what stands in for it elsewhere; here the generator writes the
      // statement, which is the difference between testing the model and testing the test.
      await migration.query(`REVOKE USAGE ON SEQUENCE ${PROBE.C}_id_seq FROM ${ROLES.collector}`)
      expect(
        await migration.query<{ has: boolean }>(
          `SELECT has_sequence_privilege($1, $2, 'USAGE') AS has`,
          [ROLES.collector, `public.${PROBE.C}_id_seq`],
        ),
      ).toMatchObject({ rows: [{ has: false }] })

      await migration.query(collectorSequenceGrantSql([PROBE.C]))

      const { rows } = await migration.query<{ seq: string; has: boolean }>(
        `SELECT c.relname AS seq, has_sequence_privilege($1, c.oid, 'USAGE') AS has
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'S' AND c.relname LIKE 'privprobe_%'
          ORDER BY c.relname`,
        [ROLES.collector],
      )
      const granted = rows.filter((r) => r.has).map((r) => r.seq)
      // Exactly one: the class C table's own sequence. The probe tables all have a serial
      // id, so every one of them has a sequence the block could have reached — which is
      // what makes "only this one" an assertion rather than a coincidence.
      expect(granted).toEqual([`${PROBE.C}_id_seq`])
      expect(rows.length).toBeGreaterThan(1)
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

    it('owns no relation and no schema', async () => {
      // Ownership is the privilege that undoes every revoke: an owner can re-grant, ALTER
      // and DISABLE TRIGGER. None of the three may own a relation or a schema — not even
      // the retention owner, whose two functions are the single, declared exception below.
      const { rows } = await migration.query(
        `SELECT relname AS name FROM pg_class WHERE relowner::regrole::text = ANY($1)
         UNION ALL SELECT nspname FROM pg_namespace WHERE nspowner::regrole::text = ANY($1)`,
        [[ROLES.app, ROLES.collector, ROLES.retentionOwner]],
      )
      expect(rows).toEqual([])
    })

    it('owns exactly the functions the manifest declares, and only the retention owner owns any', async () => {
      // The inverted GAP PIN: this asserted "owns nothing" until Task 1.3b gave
      // `crm_retention_owner` the two R-B definer functions of ADR §3. The assertion is
      // now the manifest's own list, so a definer function appearing under either
      // application role — or under this one without being declared — fails here as well
      // as in part 7 of the committed check.
      const { rows } = await migration.query(
        `SELECT proname, proowner::regrole::text AS owner FROM pg_proc
          WHERE proowner::regrole::text = ANY($1) ORDER BY proname`,
        [[ROLES.app, ROLES.collector, ROLES.retentionOwner]],
      )
      expect(rows.map((r) => r['proname'])).toEqual([...retentionOwnerFunctions].sort())
      expect([...new Set(rows.map((r) => r['owner']))]).toEqual([ROLES.retentionOwner])
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

    /** Runs part 8 against one connection and returns the failure message, or null. */
    async function runPart8(pool: Pool): Promise<string | null> {
      return runPart(pool, partStatement('part 8 (role membership)'))
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

    // CR-M-12. Every test above drives `crm_app`, so narrowing both of part 8's role joins
    // (and its count) to `crm_app` alone left this spec green. The other two roles, in both
    // directions, each asserted by its own message.
    it.each([ROLES.collector, ROLES.retentionOwner])(
      'CR-M-12: rejects %s being a member of any role',
      async (role) => {
        await migration.query(`GRANT ${other} TO ${role}`)
        try {
          expect(await runPart8(branch)).toContain(`${role} is a member of ${other}`)
        } finally {
          await migration.query(`REVOKE ${other} FROM ${role}`)
        }
        expect(await runPart8(branch)).toBeNull()
      },
    )

    it.each([ROLES.collector, ROLES.retentionOwner])(
      'CR-M-12: rejects a second member of %s, by shape and by count',
      async (role) => {
        // Same shape as the creator row, so only the member name and the count are wrong.
        await migration.query(`GRANT ${role} TO ${other} ${allowed}`)
        try {
          const failure = await runPart8(branch)
          expect(failure).toContain(`${role} has member ${other}`)
          expect(failure).toContain(`${role} has 2 membership rows, expected at most 1`)
        } finally {
          await migration.query(`REVOKE ${role} FROM ${other}`)
        }
        expect(await runPart8(branch)).toBeNull()
      },
    )
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

    it('CR-M-7: part 1 fails when a non-optional classified relation is absent', async () => {
      // Part 1's OTHER direction, and the one the round-1 substitute never exercised: the
      // substitute asserted the manifest's own consistency in TypeScript, so neutering
      // this SQL branch left the spec green.
      //
      // Dropping a classified table to produce the state is what the first version of this
      // spec did (it renamed `tos_versions`) and it broke eight other spec files in the
      // same run — every classified table is a real one the rest of the suite is using
      // concurrently. So the DATABASE is left alone and the CHECK TEXT is mutated instead:
      // one declared relation renamed to a name nothing has. That exercises the real
      // committed SQL, on the real catalog, with no shared state touched.
      const part1 = partStatement('part 1 (manifest coverage)')
      const absent = `${'tos_versions'}_absent_by_test`
      const mutated = part1.replace("('tos_versions', 'A', false)", `('${absent}', 'A', false)`)
      // Without this the test would pass on an unmutated statement the day the row's text
      // changes — a green run proving nothing, which is the defect class in question.
      expect(mutated).not.toBe(part1)

      const failure = await runPart(migration, mutated)
      expect(failure).toContain('part 1 (manifest coverage)')
      expect(failure).toContain(`${absent} is classified A but does not exist in public`)
      // The unmutated part passes on the same database in the same run, so the failure
      // above is the mutation and not the state.
      expect(await runPart(migration, part1)).toBeNull()
    }, 60_000)

    it('CR-M-7: the optional flag is what exempts a manual-DDL relation from that branch', async () => {
      // `_drop_share_pending_parity_backup_20260727` is classified E and really is absent
      // here (and on production, measured 2026-10-18) — the natural instance of the state
      // above. It stays quiet only because its declaration carries `optional = true`, and
      // nothing asserted that the flag is what does it: with `WHERE NOT d.optional`
      // deleted, every database that never ran that data-fix file would fail part 1.
      const part1 = partStatement('part 1 (manifest coverage)')
      const optional = '_drop_share_pending_parity_backup_20260727'
      const { rows } = await migration.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = 'public' AND c.relname = $1) AS exists`,
        [optional],
      )
      // If a concurrent spec created it, the premise of this test is gone — say so rather
      // than asserting something else.
      expect(rows[0]?.exists).toBe(false)

      expect(await runPart(migration, part1)).toBeNull()
      const mutated = part1.replace(`('${optional}', 'E', true)`, `('${optional}', 'E', false)`)
      expect(mutated).not.toBe(part1)
      const failure = await runPart(migration, mutated)
      expect(failure).toContain(`${optional} is classified E but does not exist in public`)
    }, 60_000)

    it('fails when a privilege is added by hand, and the grants file repairs it', async () => {
      // The forward-fix path of ADR §4 "Rollback", proved rather than asserted: drift is
      // detected, and re-applying the reviewed file is what removes it. This is also the
      // one guarantee the check alone gives against the migration role — a privilege
      // widened outside a reviewed file is caught at the next deploy.
      //
      // The repair runs in a `finally` (ORCH-L-3): with it inline, ANY failing assertion
      // above left the hand-made GRANT on the database, and the next test to call
      // `runCheck` — and the idempotence snapshot after it — failed for that reason
      // instead of its own. One red test became three, and the first one named the only
      // real cause. Every drift test in this file now restores in a `finally` for the
      // same reason.
      await migration.query(`GRANT UPDATE ON TABLE job_queue_actions TO ${ROLES.app}`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 2 \(table privileges\)/)
        expect(failure).toContain('job_queue_actions')
        expect(failure).toContain('UPDATE')
      } finally {
        await applyFile(GRANTS_FILE)
      }
      // The repair is an assertion of its own, not merely cleanup: re-applying the
      // reviewed file is the forward fix ADR §4 "Rollback" promises.
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    // CR-M-4 — WHICH CHECK BRANCHES ARE PINNED, AND WHICH ARE DELIBERATELY NOT
    // Round 1 pinned parts 3, 4 and 8 branch by branch. The tests from here to the end of
    // this describe do the same for the branches of parts 2, 5, 6 and 7 that DECIDE A
    // PRIVILEGE. What is left unpinned, each with the reason rather than an omission:
    //
    //   part 7, "role %s does not exist" — reaching it means dropping one of the three
    //     roles, and two of this file's three pools are connected AS those roles. The
    //     grants file's own `DO $guard$` raises on a missing role before the check runs
    //     (pinned without a database in `generate-privilege-sql.spec.ts`), and part 1
    //     exercises the identical `NOT EXISTS` shape against pg_class.
    //   part 7, "owns schema" — making an application role own schema `public` changes
    //     the schema every other spec in the run depends on, and the branch is one
    //     `nspowner` comparison in the same UNION as the relation-ownership branch below,
    //     which IS pinned.
    //   part 7, "declared function … is not owned by" and part 9's enabled-state and
    //     missing-trigger branches — unreachable while `retentionOwnerFunctions` and
    //     `appendOnlyTriggers` are empty. They are pinned against the GENERATOR in
    //     `generate-privilege-sql.spec.ts` (the declared row set is emitted verbatim),
    //     and Task 1.3b, which fills both, is what makes them reachable against a
    //     database. Pinning them now would require this file to carry a fake declaration,
    //     i.e. to test a manifest nobody ships.
    //   part 3's "lacks the declared column SELECT", the DECLARED half — `collectorColumns`
    //     is empty, so that half of the expected set is empty. The other half (a role's
    //     table-level expansion going missing) IS reachable and is pinned in the
    //     parts-3-and-4 describe (CR-M-12) by running part 3 on its own: through
    //     `runCheck` it never is, because losing a table SELECT fails part 2 first.

    it('part 2 fails in the lacks direction, not only when a privilege is added', async () => {
      // The direction that is an outage rather than a hole: a privilege the model requires
      // going missing. A check that only caught the widening direction would look exactly
      // the same in a green run, and the grants file's reset-then-grant shape means a
      // half-applied file is precisely how this state arises.
      await migration.query(`REVOKE SELECT ON TABLE users FROM ${ROLES.app}`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 2 \(table privileges\)/)
        expect(failure).toContain('users (class A)')
        expect(failure).toContain('lacks SELECT')
      } finally {
        await applyFile(GRANTS_FILE)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('part 2 fails on WITH GRANT OPTION, which no class ever grants', async () => {
      // ADR §2: a role that may re-grant its own privileges can widen the boundary with no
      // DDL at all — and `has_table_privilege(…, 'SELECT')` is TRUE either way, so this is
      // invisible to every other branch of part 2.
      await migration.query(`GRANT SELECT ON TABLE users TO ${ROLES.app} WITH GRANT OPTION`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 2 \(table privileges\)/)
        expect(failure).toContain('holds SELECT WITH GRANT OPTION')
      } finally {
        await applyFile(GRANTS_FILE)
      }
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
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 5 \(default privileges\)/)
        expect(failure).toContain('on new r objects')
      } finally {
        // In a `finally` for the ORCH-L-3 reason: a `pg_default_acl` row left behind by a
        // red assertion is cluster state, and it would fail every later test in the file.
        await applyFile(ROLES_FILE)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('part 5 fails in the missing direction, when the sequence default privilege is revoked', async () => {
      // The entry that keeps a sequence created by a LATER migration usable by the API at
      // all. Its absence is an outage on the next `CREATE TABLE … serial`, and nothing but
      // this branch of part 5 would report it: no existing object changes.
      await migration.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM ${ROLES.app}`,
      )
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 5 \(default privileges\)/)
        expect(failure).toContain('missing default privilege')
        expect(failure).toContain('on new S objects')
      } finally {
        await applyFile(ROLES_FILE)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('part 5 fails when a default privilege carries GRANT OPTION', async () => {
      // The grantable flag is its own branch (`OR a.grantable`) because the entry is
      // otherwise EXPECTED: grantee, privilege and object type all match the manifest, so
      // the set comparison is satisfied and only the flag is wrong. A sequence default
      // privilege with GRANT OPTION lets crm_app re-grant every future sequence.
      await migration.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${ROLES.app} WITH GRANT OPTION`,
      )
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 5 \(default privileges\)/)
        expect(failure).toContain('WITH GRANT OPTION')
      } finally {
        await applyFile(ROLES_FILE)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('part 6 fails when PUBLIC is given CONNECT on the database back', async () => {
      // `REVOKE ALL ON DATABASE … FROM PUBLIC` in the roles file is what makes a role the
      // API does not hold unable to connect at all. Re-granting it to PUBLIC undoes the
      // outer boundary while leaving every table grant intact, so no other part moves.
      const database = new URL(process.env['DATABASE_URL'] as string).pathname.replace(/^\//, '')
      await migration.query(`GRANT CONNECT ON DATABASE ${database} TO PUBLIC`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 6 \(database, schema and function privileges\)/)
        expect(failure).toContain('PUBLIC holds CONNECT')
      } finally {
        await applyFile(ROLES_FILE)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('part 6 fails when PUBLIC is given CREATE on schema public', async () => {
      // CREATE on `public` lets any role that can connect add a relation — and a relation
      // it owns, i.e. one outside the class model entirely, with triggers it may disable.
      // Part 1 would catch the relation at the NEXT deploy; this catches the ability.
      await migration.query(`GRANT CREATE ON SCHEMA public TO PUBLIC`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 6 \(database, schema and function privileges\)/)
        expect(failure).toContain('PUBLIC holds CREATE on schema public')
      } finally {
        await applyFile(ROLES_FILE)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('part 7 fails on a wrong CONNECTION LIMIT, and the roles file repairs it', async () => {
      // CONNECTION_LIMITS in the manifest and the roles file's repair clause have to agree,
      // and this is the only thing that would notice if they stopped agreeing. A limit
      // SMALLER than the pool is an outage under load, which is why it is asserted exactly
      // rather than as a ceiling.
      await migration.query(`ALTER ROLE ${ROLES.app} CONNECTION LIMIT 5`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 7 \(role attributes and ownership\)/)
        expect(failure).toContain('CONNECTION LIMIT is 5, expected 30')
      } finally {
        await applyFile(ROLES_FILE)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('part 7 fails when the retention owner is given LOGIN, and the roles file repairs it', async () => {
      // NOLOGIN is what keeps `crm_retention_owner` off the network: it exists only to own
      // SECURITY DEFINER functions, and a function running as its owner does not need to
      // log in. LOGIN on it is a credential-shaped hole that no table privilege reveals.
      await migration.query(`ALTER ROLE ${ROLES.retentionOwner} LOGIN`)
      try {
        const failure = await runCheck(migration)
        expect(failure).toMatch(/part 7 \(role attributes and ownership\)/)
        expect(failure).toContain('rolcanlogin is t, expected f')
      } finally {
        await applyFile(ROLES_FILE)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 60_000)

    it('part 7 fails when an application role owns a relation', async () => {
      // Ownership, not SUPERUSER, is what allows DISABLE TRIGGER, DROP TRIGGER and
      // re-granting — ADR §1's first sentence. So "owns nothing" is the load-bearing
      // assertion of part 7, and until now nothing could turn it red.
      //
      // Part 7 is run ALONE here, and that is the point rather than a convenience: an
      // owner passes every `has_table_privilege` test, so part 2 fires first on this same
      // state and would have let part 7 rot behind it — the same masking that
      // `pg_read_all_data` produced for part 8 in round 1.
      const table = '_settle_phantom_backup_20260715'
      const part7 = partStatement('part 7 (role attributes and ownership)')
      await migration.query(`DROP TABLE IF EXISTS ${table} CASCADE`)
      // Classified (class E) and optional, so creating it keeps part 1 quiet and dropping
      // it afterwards is the state every other database is in.
      await migration.query(`CREATE TABLE ${table} (id integer)`)
      try {
        expect(await runPart(migration, part7)).toBeNull()
        await migration.query(`ALTER TABLE ${table} OWNER TO ${ROLES.app}`)
        const failure = await runPart(migration, part7)
        expect(failure).toContain('part 7 (role attributes and ownership)')
        expect(failure).toContain(`${ROLES.app} owns relation ${table}`)
      } finally {
        await migration.query(`DROP TABLE IF EXISTS ${table} CASCADE`)
      }
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

    // CR-M-12 — what the tests above still left deletable by hand. These run ONE part on its
    // own (`runPart`), for two reasons: the part-3 branch below is unreachable through
    // `runCheck`, and a single part is the narrowest statement that can turn red.

    it('CR-M-12: part 3 fails in the lacks direction when a table-level SELECT goes missing', async () => {
      // `runCheck` stops at the first failing part, and losing a table SELECT fails part 2
      // first — so through `runCheck` this branch is never reached, whatever the comment in
      // the drift describe used to say. Part 3 on its own reaches it: `crm_app`'s expected
      // column rows on `users` are the expansion of a table SELECT it no longer has.
      const part3 = partStatement('part 3 (column privileges)')
      await migration.query(`REVOKE SELECT ON TABLE users FROM ${ROLES.app}`)
      try {
        expect(await runPart(migration, part3)).toContain(
          `${ROLES.app} lacks the declared column SELECT on users.id`,
        )
      } finally {
        await applyFile(GRANTS_FILE)
      }
      expect(await runPart(migration, part3)).toBeNull()
    }, 60_000)

    // Five of part 4's nine `wanted` rows could each be deleted with this spec green. One
    // case per row, each asserting the row's own message.
    it.each([
      [ROLES.app, 'SELECT', 'lacks'],
      [ROLES.collector, 'SELECT', 'holds'],
      [ROLES.collector, 'UPDATE', 'holds'],
      [ROLES.retentionOwner, 'USAGE', 'holds'],
      [ROLES.retentionOwner, 'SELECT', 'holds'],
      [ROLES.retentionOwner, 'UPDATE', 'holds'],
    ] as const)(
      'CR-M-12: part 4 pins the wanted row (%s, %s) — reports that it %s it',
      async (role, privilege, direction) => {
        const sequence = await sequenceInPublic()
        const part4 = partStatement('part 4 (sequence privileges)')
        await migration.query(
          direction === 'lacks'
            ? `REVOKE ${privilege} ON SEQUENCE ${sequence} FROM ${role}`
            : `GRANT ${privilege} ON SEQUENCE ${sequence} TO ${role}`,
        )
        try {
          expect(await runPart(migration, part4)).toContain(
            `sequence ${sequence}: ${role} ${direction} ${privilege}`,
          )
        } finally {
          if (direction === 'holds') {
            await migration.query(`REVOKE ${privilege} ON SEQUENCE ${sequence} FROM ${role}`)
          }
          await applyFile(GRANTS_FILE)
        }
        expect(await runPart(migration, part4)).toBeNull()
      },
      60_000,
    )

    it('CR-M-12: part 4’s class C branch expects the collector’s USAGE on that table’s sequence', async () => {
      // No real class C table exists, so with the branch forced to `false` every database
      // still passed. The table here is a probe and the CHECK TEXT is mutated to declare it
      // class C — the technique of part 1's absent-relation test: the real committed SQL,
      // on the real catalog, with no shared state changed.
      const table = 'privprobe_part4_c'
      const part4 = partStatement('part 4 (sequence privileges)')
      const declared = "('tos_versions', 'A', false)"
      const mutated = part4.replace(declared, `${declared},\n    ('${table}', 'C', false)`)
      expect(mutated).not.toBe(part4)
      await migration.query(`DROP TABLE IF EXISTS ${table} CASCADE`)
      await migration.query(`CREATE TABLE ${table} (id serial PRIMARY KEY)`)
      try {
        expect(await runPart(migration, mutated)).toContain(
          `sequence ${table}_id_seq: ${ROLES.collector} lacks USAGE`,
        )
        await migration.query(`GRANT USAGE ON SEQUENCE ${table}_id_seq TO ${ROLES.collector}`)
        expect(await runPart(migration, mutated)).toBeNull()
        // The same grant, with the table in no class, is drift — so the branch, not the
        // grant, is what made the line above pass.
        expect(await runPart(migration, part4)).toContain(
          `sequence ${table}_id_seq: ${ROLES.collector} holds USAGE`,
        )
      } finally {
        await migration.query(`DROP TABLE IF EXISTS ${table} CASCADE`)
      }
    }, 60_000)
  })

  describe('the roles file’s attribute-repair path (CR-M-5, CR-M-6)', () => {
    /**
     * The ONE statement of the roles file that is the attribute-repair block.
     *
     * Same shape and same reason as `partStatement`: an extraction that silently selects
     * nothing would make every test below pass on an empty string.
     */
    function attributeRepairBlock(): string {
      const matches = splitSqlStatements(readSql(ROLES_FILE)).filter((st) =>
        st.includes('$attributes$'),
      )
      if (matches.length !== 1) {
        throw new Error(`expected exactly one $attributes$ block, found ${matches.length}`)
      }
      return matches[0] as string
    }

    /** Every attribute of a role the repair block is responsible for. */
    async function attributesOf(role: string): Promise<Record<string, unknown>> {
      const { rows } = await migration.query(
        `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
                rolinherit, rolcanlogin, rolconnlimit
           FROM pg_roles WHERE rolname = $1`,
        [role],
      )
      return rows[0] as Record<string, unknown>
    }

    it('CR-M-5: repairs every clause it is responsible for, in one application', async () => {
      // Round 1 pinned two of the eight clauses (NOCREATEROLE and CONNECTION LIMIT). The
      // other six were unpinned, which for a drift-REPAIR path means: delete the line and
      // the role keeps the attribute, with the catalog check failing the deploy instead of
      // the file fixing it. One state with ALL EIGHT drifted, so deleting any single
      // clause leaves this test red on exactly that attribute.
      //
      // `crm_collector` and not `crm_app`: the app pool in this file is connected as
      // crm_app, and NOLOGIN plus CONNECTION LIMIT 0 on a role with live sessions is a
      // fight with the rest of the suite rather than a test.
      await migration.query(
        `ALTER ROLE ${ROLES.collector} SUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS NOINHERIT NOLOGIN CONNECTION LIMIT 7`,
      )
      try {
        expect(await attributesOf(ROLES.collector)).toMatchObject({
          rolsuper: true,
          rolcreatedb: true,
          rolcreaterole: true,
          rolreplication: true,
          rolbypassrls: true,
          rolinherit: false,
          rolcanlogin: false,
          rolconnlimit: 7,
        })

        await applyFile(ROLES_FILE)

        // Every one of the eight, written out: the declared state of the collector per
        // ROLES / CONNECTION_LIMITS in privilege-classes.ts.
        expect(await attributesOf(ROLES.collector)).toEqual({
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false,
          rolinherit: true,
          rolcanlogin: true,
          rolconnlimit: 10,
        })
      } finally {
        await applyFile(ROLES_FILE)
      }
      expect(await runCheck(migration)).toBeNull()
    }, 120_000)

    /**
     * Drifts `crm_collector` by `drift` (as the superuser), then runs the attribute-repair
     * block as step 0's branch 2: a non-superuser CREATEROLE role holding ADMIN on it.
     * Returns the collector's attributes right after the block and every notice and
     * warning the block raised. `inspect` runs while the drift-after-repair state still
     * stands; the superuser re-applies the roles file afterwards, whatever happened.
     */
    async function repairAsBranch2(
      drift: string,
      inspect?: () => Promise<void>,
    ): Promise<{ after: Record<string, unknown>; notices: string }> {
      const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const fixer = `privprobe_fixer_${suffix}`
      const fixerPassword = `probe${Math.random().toString(36).slice(2)}`
      let fixerPool: Pool | undefined
      // The roles file revoked PUBLIC's CONNECT on this database, so a new login role has
      // to be granted it by name — which is itself the boundary working as designed.
      const database = new URL(process.env['DATABASE_URL'] as string).pathname.replace(/^\//, '')
      await migration.query(
        `CREATE ROLE ${fixer} LOGIN NOSUPERUSER CREATEROLE NOCREATEDB PASSWORD '${fixerPassword}'`,
      )
      try {
        await migration.query(`GRANT CONNECT ON DATABASE ${database} TO ${fixer}`)
        // In PostgreSQL 16 a CREATEROLE role may only alter roles it holds ADMIN on.
        await migration.query(
          `GRANT ${ROLES.collector} TO ${fixer} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE`,
        )
        await migration.query(`ALTER ROLE ${ROLES.collector} ${drift}`)
        fixerPool = new Pool({ connectionString: urlFor(fixer, fixerPassword), max: 1 })

        const notices: string[] = []
        const client = await fixerPool.connect()
        try {
          client.on('notice', (n) => notices.push(String(n.message)))
          await client.query(attributeRepairBlock())
        } finally {
          client.release()
        }
        const after = await attributesOf(ROLES.collector)
        await inspect?.()
        return { after, notices: notices.join(' | ') }
      } finally {
        await fixerPool?.end()
        await migration
          .query(`REVOKE ${ROLES.collector} FROM ${fixer} CASCADE`)
          .catch(() => undefined)
        // Before DROP ROLE: PostgreSQL refuses to drop a role that still holds a database
        // privilege, and an orphaned datacl entry would also change the idempotence
        // snapshot the next describe compares.
        await migration
          .query(`REVOKE ALL ON DATABASE ${database} FROM ${fixer}`)
          .catch(() => undefined)
        await migration.query(`DROP ROLE IF EXISTS ${fixer}`).catch(() => undefined)
        await applyFile(ROLES_FILE)
      }
    }

    it('CR-M-6: as a non-superuser CREATEROLE owner, repairs what it can and warns about the rest', async () => {
      // The file's own comment claims "repair of whatever the role is allowed to change
      // plus a loud WARNING for the rest" of step 0's branch 2. With one `ALTER ROLE`
      // carrying every differing clause, that was FALSE: PostgreSQL 16 refuses the whole
      // statement if any clause needs an attribute the altering role lacks, so with
      // CREATEDB and CREATEROLE both drifted NOTHING was repaired and CREATEROLE — the
      // clause that lets a role mint a more privileged one — stayed on the role.
      //
      // Since SR-M-2, "what it can" means the REDUCING clauses: NOCREATEROLE lands, while
      // INHERIT and the higher connection limit (7 -> 10) are ENABLING and are withheld,
      // because a reducing clause (NOCREATEDB) was refused.
      let failure: string | null = null
      const { after, notices } = await repairAsBranch2(
        'CREATEDB CREATEROLE NOINHERIT CONNECTION LIMIT 7',
        async () => {
          failure = await runCheck(migration)
        },
      )
      expect(after).toMatchObject({
        rolcreaterole: false,
        rolcreatedb: true,
        rolinherit: false,
        rolconnlimit: 7,
      })
      expect(notices).toContain(`cannot repair attributes of ${ROLES.collector} (NOCREATEDB)`)
      expect(notices).toContain('withheld: CONNECTION LIMIT 10 INHERIT')
      // Not repaired, and that is the honest half: CREATEDB may only be changed by a role
      // that holds it. Part 7 fails the deploy on this state — reported, not accepted.
      expect(failure).toMatch(/part 7 \(role attributes and ownership\)/)
      expect(failure).toContain('CREATEDB')
      expect(await runCheck(migration)).toBeNull()
    }, 120_000)

    // SR-M-2. One clause at a time made "repair what you can" true — and, in branch 2, let
    // the block RAISE privileges: LOGIN is accepted from a non-superuser CREATEROLE role
    // while a superuser-only clause is refused, so a role drifted to `NOLOGIN REPLICATION`
    // ended as `LOGIN REPLICATION`, more privileged than both where it was and where it
    // should be. The reviewer's three drifted states, each written out.
    it.each([
      ['NOLOGIN REPLICATION', { rolreplication: true }, 'NOREPLICATION'],
      ['NOLOGIN BYPASSRLS', { rolbypassrls: true }, 'NOBYPASSRLS'],
      ['NOLOGIN CREATEDB', { rolcreatedb: true }, 'NOCREATEDB'],
    ] as const)(
      'SR-M-2: drifted to %s in branch 2, the role is not given LOGIN back',
      async (drift, held, refused) => {
        const { after, notices } = await repairAsBranch2(drift)
        expect(after).toMatchObject({ ...held, rolcanlogin: false })
        expect(notices).toContain(`cannot repair attributes of ${ROLES.collector} (${refused})`)
        expect(notices).toContain('withheld: LOGIN')
      },
      120_000,
    )

    it('SR-M-2: a refusal with nothing enabling to withhold says so, rather than nothing', async () => {
      // The warning's `COALESCE(NULLIF(…), 'nothing')`: with CREATEDB the only drift, the
      // one clause is reducing and refused, so `withheld` is empty. Without the COALESCE
      // the message would trail off after "withheld: " — and an operator reading it could
      // not tell "nothing was withheld" from a truncated line.
      const { after, notices } = await repairAsBranch2('CREATEDB')
      expect(after).toMatchObject({ rolcreatedb: true, rolcanlogin: true, rolinherit: true })
      expect(notices).toContain(`cannot repair attributes of ${ROLES.collector} (NOCREATEDB)`)
      expect(notices).toContain('withheld: nothing')
    }, 120_000)

    it('SR-M-2: a LOWER connection limit is a reducing clause and lands even then', async () => {
      // -1 is "no limit", so 10 is a reduction from it. The limit is the one clause that
      // can go either way, so it is classified by direction, not by name.
      const { after, notices } = await repairAsBranch2('CREATEDB NOINHERIT CONNECTION LIMIT -1')
      expect(after).toMatchObject({ rolconnlimit: 10, rolcreatedb: true, rolinherit: false })
      expect(notices).toContain('withheld: INHERIT')
    }, 120_000)

    it('SR-M-2: with no reducing clause refused, branch 2 still applies the enabling ones', async () => {
      // Withholding is conditional on a refusal, not a blanket "never enable in branch 2" —
      // which would leave a merely NOLOGIN application role unable to log in for good.
      const { after, notices } = await repairAsBranch2('NOLOGIN NOINHERIT CONNECTION LIMIT 7')
      expect(after).toMatchObject({ rolcanlogin: true, rolinherit: true, rolconnlimit: 10 })
      expect(notices).not.toContain('cannot repair')
    }, 120_000)
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
