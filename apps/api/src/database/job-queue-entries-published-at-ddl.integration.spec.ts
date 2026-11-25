import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jobQueueGenerationEntries } from './schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Queue sort by publication date — the forward DDL
 * `manual/2026-11-25_job_queue_entries_published_at.sql` against a REAL Postgres, applied twice into
 * a scratch schema holding a stub of `job_queue_generation_entries` with one existing row. The column
 * is compared with the DRIZZLE declaration. NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run job-queue-entries-published-at-ddl.integration.spec
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual',
  '2026-11-25_job_queue_entries_published_at.sql',
)
const SCHEMA = 'ddl_job_queue_entries_published_at'
const TABLE = 'job_queue_generation_entries'

const column = getTableConfig(jobQueueGenerationEntries).columns.find(
  (c) => c.name === 'published_at',
)

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

describe.skipIf(!hasDatabaseUrl())('DDL: job_queue_generation_entries.published_at', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    client = await pool.connect()
    const { rows } = await client.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    await client.query(`SET search_path = ${SCHEMA}, public`)
    await client.query(
      `CREATE TABLE ${SCHEMA}.${TABLE} (generation_id uuid PRIMARY KEY DEFAULT gen_random_uuid())`,
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

  it('adds the nullable timestamptz column Drizzle declares, no default, existing rows NULL', async () => {
    expect(column).toBeDefined()
    expect(await addedColumns()).toEqual([
      {
        name: 'published_at',
        type: 'timestamp with time zone',
        not_null: false,
        default_expr: null,
      },
    ])
    expect(column?.getSQLType()).toBe('timestamp with time zone')
    expect(column?.notNull).toBe(false)
    const { rows } = await client.query(`SELECT published_at FROM ${SCHEMA}.${TABLE}`)
    expect(rows).toEqual([{ published_at: null }])
  })

  it('the second apply succeeds and changes nothing', async () => {
    const before = await addedColumns()
    await applyFile()
    expect(await addedColumns()).toEqual(before)
  })
})
