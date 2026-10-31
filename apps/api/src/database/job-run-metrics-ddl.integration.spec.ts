import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CrmAppSession,
  MANUAL_DIR,
  openCrmAppSession,
} from './__test-helpers__/crm-app-session'
import { PRIVILEGE_CLASSES, ROLES } from './privileges/privilege-classes'
import { LedgerFixtures } from '../test/ledger-fixtures'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Source fetch strategy U2 AC 1 and the CHECK half of AC 3 — the staged forward DDL
 * `manual-staged/2026-10-31_job_run_metrics_slowdown.sql` against a REAL Postgres.
 *
 *  - It is applied TWICE into a scratch schema holding stubs of the two tables it alters, as the
 *    deploy would (one transaction each), and the second apply changes nothing.
 *  - It refuses to finish over a same-named column of another type (the closing check).
 *  - The catalog check `2026-10-18_db_privileges_check.sql` passes on the pushed database, and
 *    `crm_app` can write the new columns through its EXISTING table grants and holds nothing more
 *    on the two tables than class A gives it.
 *  - The CHECK refuses `slowdown_level = 5` for `crm_app`, and admits 0 and 4.
 *
 * The column-by-column equality with `db:push` is in
 * job-opportunities-store-forward-ddl.integration.spec.ts (PART_7). NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-run-metrics-ddl.integration
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual-staged',
  '2026-10-31_job_run_metrics_slowdown.sql',
)
const SCHEMA = 'ddl_job_run_metrics_slowdown'
const TABLES = ['job_collection_runs', 'job_sources']
const RUN_COLUMNS = [
  'request_count',
  'bytes_read',
  'last_http_status',
  'newest_item_published_at',
  'envelope_fingerprint',
  'validators_seen',
]

let session: CrmAppSession
let client: PoolClient
let fx: LedgerFixtures

async function applyFile(): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query(readFileSync(FILE, 'utf8'))
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  }
}

async function catalogOf(schema: string) {
  const { rows: columns } = await client.query(
    `SELECT c.relname AS table, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expr
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
    [schema, TABLES],
  )
  const { rows: constraints } = await client.query(
    `SELECT c.relname AS table, k.conname AS name, k.convalidated AS validated,
            pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND k.contype = 'c'
      ORDER BY c.relname, k.conname`,
    [schema, TABLES],
  )
  return { columns, constraints }
}

const sqlstate = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run()
    return undefined
  } catch (e) {
    return (e as { code?: string }).code
  }
}

describe.skipIf(!hasDatabaseUrl())('U2 staged DDL: run metrics and slowdown_level', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    client = await session.admin.connect()
    const { rows } = await client.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    fx = new LedgerFixtures(session.admin, `u2ddl${Date.now().toString(36)}`)
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    await client.query(`SET search_path = ${SCHEMA}`)
    for (const table of TABLES) await client.query(`CREATE TABLE ${table} (id uuid PRIMARY KEY)`)
    // A row in each, so the NOT NULL DEFAULT 0 column is added under existing data.
    await client.query(`INSERT INTO job_sources (id) VALUES (gen_random_uuid())`)
    await client.query(`INSERT INTO job_collection_runs (id) VALUES (gen_random_uuid())`)
    await applyFile()
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await client?.query(`SET search_path = public`)
      await client?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      client?.release()
      await fx?.cleanup()
    } finally {
      await session.close()
    }
  })

  it('AC 1: adds the six nullable run columns and slowdown_level with its CHECKs', async () => {
    const { columns, constraints } = await catalogOf(SCHEMA)
    const runs = columns.filter((c) => c['table'] === 'job_collection_runs').slice(1)
    expect(runs.map((c) => [c['name'], c['type'], c['not_null'], c['default_expr']])).toEqual([
      ['request_count', 'integer', false, null],
      ['bytes_read', 'bigint', false, null],
      ['last_http_status', 'smallint', false, null],
      ['newest_item_published_at', 'timestamp with time zone', false, null],
      ['envelope_fingerprint', 'text', false, null],
      ['validators_seen', 'boolean', false, null],
    ])
    const level = columns.find((c) => c['name'] === 'slowdown_level')
    expect(level).toMatchObject({ type: 'smallint', not_null: true, default_expr: '0' })
    expect(constraints.map((c) => [c['name'], c['validated']])).toEqual([
      ['ck_job_collection_runs_metrics_bounded', true],
      ['ck_job_sources_slowdown_level_range', true],
    ])
    // The existing row took the default: level 0, today's behaviour.
    const { rows } = await client.query(`SELECT slowdown_level FROM job_sources`)
    expect(rows).toEqual([{ slowdown_level: 0 }])
  })

  it('AC 1: the second apply succeeds and changes nothing', async () => {
    const before = await catalogOf(SCHEMA)
    await applyFile()
    expect(await catalogOf(SCHEMA)).toEqual(before)
  })

  it('the constraints it adds are the ones db:push declares (same definition in public)', async () => {
    const pushed = await catalogOf('public')
    const ours = await catalogOf(SCHEMA)
    const names = ours.constraints.map((c) => c['name'])
    expect(pushed.constraints.filter((c) => names.includes(c['name']))).toEqual(ours.constraints)
  })

  it('refuses to finish over a same-named column of another type, and rolls back', async () => {
    // `validators_seen` is in no CHECK, so only the closing check can see the wrong type.
    await client.query(`ALTER TABLE job_collection_runs DROP COLUMN validators_seen`)
    await client.query(`ALTER TABLE job_collection_runs ADD COLUMN validators_seen text`)
    await expect(applyFile()).rejects.toThrow(/job_collection_runs\.validators_seen/)
    await client.query(`ALTER TABLE job_collection_runs DROP COLUMN validators_seen`)
    await applyFile()
    const { rows } = await client.query(
      `SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute
        WHERE attrelid = 'job_collection_runs'::regclass AND attname = 'validators_seen'`,
    )
    expect(rows).toEqual([{ t: 'boolean' }])
  })

  it('AC 1: the catalog check passes, and crm_app writes the new columns through its existing grants and nothing more', async () => {
    const check = readFileSync(join(MANUAL_DIR, '2026-10-18_db_privileges_check.sql'), 'utf8')
    await expect(session.admin.query(check)).resolves.toBeDefined()
    expect(PRIVILEGE_CLASSES.A).toEqual(expect.arrayContaining(TABLES))
    const cols = [
      ...RUN_COLUMNS.map((c) => ['job_collection_runs', c]),
      ['job_sources', 'slowdown_level'],
    ]
    const { rows } = await session.admin.query(
      `SELECT t, c, p, has_column_privilege($1, 'public.' || t, c, p) AS held
         FROM unnest($2::text[], $3::text[]) AS x(t, c),
              unnest(ARRAY['SELECT', 'INSERT', 'UPDATE']) p`,
      [ROLES.app, cols.map((x) => x[0]), cols.map((x) => x[1])],
    )
    expect(rows).toHaveLength(21)
    expect(rows.filter((r) => r['held'] !== true)).toEqual([])
    // Nothing more: class A on both tables is SELECT/INSERT/UPDATE/DELETE, never TRUNCATE,
    // REFERENCES or TRIGGER, and no column-level grant of its own.
    const { rows: extra } = await session.admin.query(
      `SELECT table_name, privilege_type FROM information_schema.table_privileges
        WHERE grantee = $1 AND table_schema = 'public' AND table_name = ANY($2::text[])
          AND privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')`,
      [ROLES.app, TABLES],
    )
    expect(extra).toEqual([])
    const { rows: columnGrants } = await session.admin.query(
      `SELECT a.attname FROM pg_attribute a
        WHERE a.attrelid = ANY(ARRAY['public.job_collection_runs'::regclass, 'public.job_sources'::regclass])
          AND a.attacl IS NOT NULL`,
    )
    expect(columnGrants).toEqual([])
  })

  it('AC 3: as crm_app, the CHECK refuses slowdown_level 5 and -1, and admits 4 and 0', async () => {
    const id = await fx.source({ manifestId: null, hostKey: null })
    const set = (level: number) =>
      session.pool.query(`UPDATE job_sources SET slowdown_level = $2 WHERE id = $1`, [id, level])
    expect(await sqlstate(() => set(5))).toBe('23514')
    expect(await sqlstate(() => set(-1))).toBe('23514')
    expect(await sqlstate(() => set(4))).toBeUndefined()
    expect(await sqlstate(() => set(0))).toBeUndefined()
    // Positive control: the statement really ran as crm_app.
    const { rows } = await session.pool.query(`SELECT current_user AS u`)
    expect(rows[0].u).toBe(ROLES.app)
  })
})
