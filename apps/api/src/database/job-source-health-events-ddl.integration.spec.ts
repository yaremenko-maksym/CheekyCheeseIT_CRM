import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CrmAppSession, openCrmAppSession } from './__test-helpers__/crm-app-session'
import { PRIVILEGE_CLASSES, ROLES } from './privileges/privilege-classes'
import { LedgerFixtures } from '../test/ledger-fixtures'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Source-fetch-strategy U4 — the staged forward DDL
 * `manual-staged/2026-10-31_job_source_health_events.sql` against a REAL Postgres.
 *
 *  - Applied TWICE into a scratch schema (with stub FK targets), as the deploy would; the second
 *    apply changes nothing (re-runnable).
 *  - The table's columns and CHECK constraints equal what `db:push` builds in `public` (the
 *    Drizzle schema and the SQL agree column for column — the forward-DDL drift gate).
 *  - As `crm_app` on the pushed `public` table (with the staged triggers applied): a TRANSITION
 *    row inserts; `error_sample` over 500 chars and `evidence` over 8192 are refused (AC 5);
 *    UPDATE/DELETE are refused — by the grant for `crm_app`, by the ENABLE ALWAYS trigger for the
 *    owner, and TRUNCATE too (AC 3's refusal half).
 *
 * NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-source-health-events-ddl.integration
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual-staged',
  '2026-10-31_job_source_health_events.sql',
)
const SCHEMA = 'ddl_job_source_health_events'
const TABLE = 'job_source_health_events'
const FK_STUBS = ['job_sources', 'job_collection_runs', 'users']

let session: CrmAppSession
let client: PoolClient
let fx: LedgerFixtures

const fileSql = (): string => readFileSync(FILE, 'utf8')

async function applyInto(c: PoolClient, searchPath: string): Promise<void> {
  await c.query('BEGIN')
  try {
    await c.query(`SET LOCAL search_path = ${searchPath}`)
    await c.query(fileSql())
    await c.query('COMMIT')
  } catch (e) {
    await c.query('ROLLBACK')
    throw e
  }
}

async function catalogOf(schema: string) {
  const { rows: columns } = await client.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expr
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [schema, TABLE],
  )
  const { rows: constraints } = await client.query(
    `SELECT k.conname AS name, k.convalidated AS validated, pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2 AND k.contype = 'c'
      ORDER BY k.conname`,
    [schema, TABLE],
  )
  return { columns, constraints }
}

const sqlstate = async (run: () => Promise<unknown>): Promise<string | undefined> => {
  try {
    await run()
    return undefined
  } catch (e) {
    return (e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code
  }
}

describe.skipIf(!hasDatabaseUrl())('U4 staged DDL: job_source_health_events', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    client = await session.admin.connect()
    const { rows } = await client.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    fx = new LedgerFixtures(session.admin, `u4ddl${Date.now().toString(36)}`)

    // Scratch schema with stub FK targets, then the staged file applied twice.
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    await client.query(`SET search_path = ${SCHEMA}`)
    for (const stub of FK_STUBS) await client.query(`CREATE TABLE ${stub} (id uuid PRIMARY KEY)`)
    await applyInto(client, SCHEMA)
    await client.query(`SET search_path = public`)

    // The pushed public table gains the triggers (CREATE TABLE IF NOT EXISTS is a no-op there).
    await applyInto(client, 'public')
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await client?.query(`SET search_path = public`)
      await client?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      // The append-only trigger refuses the cleanup DELETE, and the health rows' FK would then
      // block fx.cleanup() from deleting their sources. Disable the guard (owner only) and clear
      // the rows this suite appended, so the fixtures can be removed.
      await client
        ?.query(`ALTER TABLE ${TABLE} DISABLE TRIGGER trg_job_source_health_events_append_only`)
        .catch(() => undefined)
      await client?.query(`DELETE FROM ${TABLE} WHERE true`).catch(() => undefined)
      client?.release()
      await fx?.cleanup()
    } finally {
      await session.close()
    }
  })

  it('creates the 16 columns db:push declares, same type/null/default', async () => {
    const scratch = await catalogOf(SCHEMA)
    const pushed = await catalogOf('public')
    expect(scratch.columns).toEqual(pushed.columns)
    expect(scratch.columns.map((c) => c['name'])).toEqual([
      'id',
      'source_id',
      'at',
      'kind',
      'from_state',
      'to_state',
      'reason_code',
      'evidence',
      'first_bad_run_id',
      'last_good_run_id',
      'adapter_version',
      'config_version',
      'http_status',
      'error_sample',
      'actor_id',
      'note',
    ])
  })

  it('the CHECK constraints equal the ones db:push declares, definition for definition', async () => {
    const scratch = await catalogOf(SCHEMA)
    const pushed = await catalogOf('public')
    expect(scratch.constraints).toEqual(pushed.constraints)
    expect(scratch.constraints.map((c) => c['name'])).toContain(
      'ck_job_source_health_events_states',
    )
  })

  it('the second apply succeeds and changes nothing (re-runnable)', async () => {
    const before = await catalogOf(SCHEMA)
    await applyInto(client, SCHEMA)
    expect(await catalogOf(SCHEMA)).toEqual(before)
  })

  it('is privilege class A-log: crm_app SELECT+INSERT, never UPDATE/DELETE', async () => {
    expect(PRIVILEGE_CLASSES['A-log']).toContain(TABLE)
    const { rows } = await session.admin.query(
      `SELECT p, has_table_privilege($1, 'public.' || $2, p) AS held
         FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p`,
      [ROLES.app, TABLE],
    )
    expect(Object.fromEntries(rows.map((r) => [r['p'], r['held']]))).toEqual({
      SELECT: true,
      INSERT: true,
      UPDATE: false,
      DELETE: false,
    })
  })

  it('AC 3 / AC 5: as crm_app a TRANSITION inserts; bounds and mutations are refused', async () => {
    const sourceId = await fx.source({ manifestId: null, hostKey: null })
    const insert = (cols: string, vals: string, params: unknown[]) =>
      session.pool.query(`INSERT INTO ${TABLE} (${cols}) VALUES (${vals})`, params)

    // A valid TRANSITION row inserts.
    await expect(
      insert('source_id, kind, to_state, reason_code', '$1, $2, $3, $4', [
        sourceId,
        'TRANSITION',
        'FAILING',
        'ACCESS_CHANGED',
      ]),
    ).resolves.toBeDefined()

    // AC 5: error_sample over 500 chars, and evidence over 8192 chars, are refused (23514).
    expect(
      await sqlstate(() =>
        insert('source_id, kind, to_state, error_sample', '$1, $2, $3, $4', [
          sourceId,
          'TRANSITION',
          'FAILING',
          'x'.repeat(501),
        ]),
      ),
    ).toBe('23514')
    expect(
      await sqlstate(() =>
        insert('source_id, kind, to_state, evidence', '$1, $2, $3, $4::jsonb', [
          sourceId,
          'TRANSITION',
          'FAILING',
          JSON.stringify({ blob: 'y'.repeat(8300) }),
        ]),
      ),
    ).toBe('23514')

    // AC 3: crm_app cannot UPDATE or DELETE (no grant → 42501).
    expect(await sqlstate(() => session.pool.query(`UPDATE ${TABLE} SET note = 'x'`))).toBe('42501')
    expect(await sqlstate(() => session.pool.query(`DELETE FROM ${TABLE}`))).toBe('42501')

    const { rows } = await session.pool.query(`SELECT current_user AS u`)
    expect(rows[0].u).toBe(ROLES.app)
  })

  it('AC 3: the ENABLE ALWAYS triggers refuse UPDATE, DELETE and TRUNCATE even for the owner', async () => {
    const sourceId = await fx.source({ manifestId: null, hostKey: null })
    await client.query(
      `INSERT INTO ${TABLE} (source_id, kind, to_state) VALUES ($1, 'TRANSITION', 'HEALTHY')`,
      [sourceId],
    )
    // restrict_violation is '23001'; assert the class rather than the message.
    expect(
      await sqlstate(() =>
        client.query(`UPDATE ${TABLE} SET note = 'x' WHERE source_id = $1`, [sourceId]),
      ),
    ).toBe('23001')
    expect(
      await sqlstate(() => client.query(`DELETE FROM ${TABLE} WHERE source_id = $1`, [sourceId])),
    ).toBe('23001')
    expect(await sqlstate(() => client.query(`TRUNCATE ${TABLE}`))).toBe('23001')
  })
})
