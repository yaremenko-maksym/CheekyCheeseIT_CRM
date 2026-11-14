import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type CrmAppSession, openCrmAppSession } from './__test-helpers__/crm-app-session'
import { ALL_TABLE_PRIVILEGES, PRIVILEGE_CLASSES, ROLES } from './privileges/privilege-classes'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * The staged forward DDL `manual-staged/2026-11-14_senior_availability.sql` against a REAL Postgres
 * (vacancy-queue design §5.2): re-runnable, column for column and constraint for constraint what
 * `db:push` builds, class A for `crm_app`, and the FREE ↔ day pairing refused by the CHECK.
 *
 * NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run senior-availability-ddl.integration
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual-staged',
  '2026-11-14_senior_availability.sql',
)
const SCHEMA = 'ddl_senior_availability'
const TABLE = 'senior_availability'
const USER_ID = '5a110014-0000-4000-bb00-000000000001'

let session: CrmAppSession
let client: PoolClient

async function applyInto(c: PoolClient): Promise<void> {
  await c.query('BEGIN')
  try {
    // `public` after the scratch schema: the FK names `users`, which lives only in public
    await c.query(`SET LOCAL search_path = ${SCHEMA}, public`)
    await c.query(readFileSync(FILE, 'utf8'))
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
    `SELECT k.conname AS name, k.contype AS kind, k.convalidated AS validated,
            pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2
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

describe.skipIf(!hasDatabaseUrl())('staged DDL: senior_availability', () => {
  beforeAll(async () => {
    session = await openCrmAppSession()
    client = await session.admin.connect()
    const { rows } = await client.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    await applyInto(client)
    await client.query(
      `INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'DDL Senior', 'SENIOR')
       ON CONFLICT (id) DO NOTHING`,
      [USER_ID, 'ddl-senior-availability@test.spec'],
    )
  }, 120_000)

  afterAll(async () => {
    if (session === undefined) return
    try {
      await client?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await client?.query(`DELETE FROM users WHERE id = $1`, [USER_ID]).catch(() => undefined)
      client?.release()
    } finally {
      await session.close()
    }
  })

  it('has the columns db:push declares, same type/null/default', async () => {
    const scratch = await catalogOf(SCHEMA)
    expect(scratch.columns).toEqual((await catalogOf('public')).columns)
    expect(scratch.columns.map((c) => c['name'])).toEqual([
      'user_id',
      'status',
      'available_from',
      'updated_at',
    ])
  })

  it('has the primary key, FK and CHECKs db:push declares, definition for definition', async () => {
    const scratch = await catalogOf(SCHEMA)
    expect(scratch.constraints).toEqual((await catalogOf('public')).constraints)
    expect(scratch.constraints.map((c) => c['name'])).toEqual([
      'ck_senior_availability_from',
      'ck_senior_availability_status',
      'senior_availability_pkey',
      'senior_availability_user_id_users_id_fk',
    ])
  })

  it('the second apply succeeds and changes nothing (re-runnable)', async () => {
    const before = await catalogOf(SCHEMA)
    await applyInto(client)
    expect(await catalogOf(SCHEMA)).toEqual(before)
  })

  it('is class A: the shipped grants give crm_app exactly the class privileges', async () => {
    expect(PRIVILEGE_CLASSES.A).toContain(TABLE)
    const { rows } = await session.admin.query(
      `SELECT p FROM unnest($3::text[]) p WHERE has_table_privilege($1, 'public.' || $2, p)`,
      [ROLES.app, TABLE, ALL_TABLE_PRIVILEGES],
    )
    expect(rows.map((r) => r['p']).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
  })

  it('as crm_app FREE needs its day and BUSY refuses one; an unknown status is refused', async () => {
    const upsert = (status: string, from: string | null) =>
      session.pool.query(
        `INSERT INTO ${TABLE} (user_id, status, available_from) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET status = EXCLUDED.status,
           available_from = EXCLUDED.available_from`,
        [USER_ID, status, from],
      )
    await expect(upsert('FREE', '2026-11-01')).resolves.toBeDefined()
    await expect(upsert('BUSY', null)).resolves.toBeDefined()
    expect(await sqlstate(() => upsert('FREE', null))).toBe('23514')
    expect(await sqlstate(() => upsert('BUSY', '2026-11-01'))).toBe('23514')
    expect(await sqlstate(() => upsert('AWAY', null))).toBe('23514')
    const { rows } = await session.pool.query(`SELECT current_user AS u`)
    expect(rows[0].u).toBe(ROLES.app)
  })
})
