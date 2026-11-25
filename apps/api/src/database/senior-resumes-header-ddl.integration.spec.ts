import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seniorResumes } from './schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Resume header overrides — the forward DDL `manual/2026-11-24_senior_resumes_header.sql` against a
 * REAL Postgres, applied twice into a scratch schema holding a stub of `senior_resumes` with one
 * existing row. The column is compared with the DRIZZLE declaration. NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run senior-resumes-header-ddl.integration.spec
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual',
  '2026-11-24_senior_resumes_header.sql',
)
const SCHEMA = 'ddl_senior_resumes_header'
const TABLE = 'senior_resumes'

const column = getTableConfig(seniorResumes).columns.find((c) => c.name === 'header')

let pool: Pool
let client: PoolClient

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

async function addedColumns() {
  const { rows } = await client.query(
    `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
            a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expr
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 1 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [SCHEMA, TABLE],
  )
  return rows
}

describe.skipIf(!hasDatabaseUrl())('DDL: senior_resumes.header', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    client = await pool.connect()
    const { rows } = await client.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    await client.query(`SET search_path = ${SCHEMA}, public`)
    await client.query(
      `CREATE TABLE ${SCHEMA}.${TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`,
    )
    await client.query(`INSERT INTO ${SCHEMA}.${TABLE} DEFAULT VALUES`)
    await applyFile()
  }, 120_000)

  afterAll(async () => {
    if (pool === undefined) return
    try {
      await client?.query(`SET search_path = public`)
      await client?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      client?.release()
    } finally {
      await pool.end()
    }
  })

  it('adds the nullable jsonb column Drizzle declares, no default, existing rows NULL', async () => {
    expect(column).toBeDefined()
    expect(await addedColumns()).toEqual([
      {
        name: 'header',
        type: 'jsonb',
        not_null: false,
        default_expr: null,
      },
    ])
    expect(column?.getSQLType()).toBe('jsonb')
    expect(column?.notNull).toBe(false)
    const { rows } = await client.query(`SELECT header FROM ${SCHEMA}.${TABLE}`)
    expect(rows).toEqual([{ header: null }])
  })

  it('the second apply succeeds and changes nothing', async () => {
    const before = await addedColumns()
    await applyFile()
    expect(await addedColumns()).toEqual(before)
  })
})
