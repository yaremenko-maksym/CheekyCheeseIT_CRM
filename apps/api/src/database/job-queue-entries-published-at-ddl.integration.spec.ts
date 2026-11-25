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
 * a scratch schema holding a stub of `job_queue_generation_entries` with one existing row. The columns
 * and the index are compared with the DRIZZLE declaration, and the rollback written in the file's
 * header is run as written. NEVER `crm_db`:
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

const config = getTableConfig(jobQueueGenerationEntries)
const column = config.columns.find((c) => c.name === 'published_at')
const keyColumn = config.columns.find((c) => c.name === 'published_order_key')
const INDEX = 'uq_job_queue_generation_entries_published_order'

/** The rollback statements of the file's header comment, exactly as the runbook points to them. */
function rollbackSql(): string {
  const lines = readFileSync(FILE, 'utf8').split('\n')
  const start = lines.findIndex((l) => l.startsWith('--   To remove them'))
  const body: string[] = []
  for (const l of lines.slice(start + 1)) {
    if (!l.startsWith('--     ')) break
    body.push(l.slice('--     '.length))
  }
  return body.join('\n')
}

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

async function indexDef(): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname = $3`,
    [SCHEMA, TABLE, INDEX],
  )
  return rows[0]?.indexdef ?? null
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

  it('adds the nullable columns Drizzle declares, no default, existing rows NULL', async () => {
    expect(column).toBeDefined()
    expect(keyColumn).toBeDefined()
    expect(await addedColumns()).toEqual([
      {
        name: 'published_at',
        type: 'timestamp with time zone',
        not_null: false,
        default_expr: null,
      },
      { name: 'published_order_key', type: 'integer', not_null: false, default_expr: null },
    ])
    expect(column?.getSQLType()).toBe('timestamp with time zone')
    expect(column?.notNull).toBe(false)
    expect(keyColumn?.getSQLType()).toBe('integer')
    expect(keyColumn?.notNull).toBe(false)
    const { rows } = await client.query(
      `SELECT published_at, published_order_key FROM ${SCHEMA}.${TABLE}`,
    )
    expect(rows).toEqual([{ published_at: null, published_order_key: null }])
  })

  it('indexes (generation_id, published_order_key) uniquely, as Drizzle declares', async () => {
    expect(await indexDef()).toBe(
      `CREATE UNIQUE INDEX ${INDEX} ON ${SCHEMA}.${TABLE} USING btree (generation_id, published_order_key)`,
    )
    const declared = config.indexes.find((i) => i.config.name === INDEX)
    expect(declared?.config.unique).toBe(true)
  })

  it('refuses a negative published_order_key', async () => {
    await expect(
      client.query(`INSERT INTO ${SCHEMA}.${TABLE} (published_order_key) VALUES (-1)`),
    ).rejects.toThrow(/ck_job_queue_generation_entries_published_order_key_nonneg/)
  })

  it('the second apply succeeds and changes nothing', async () => {
    const before = await addedColumns()
    const beforeIndex = await indexDef()
    await applyFile()
    expect(await addedColumns()).toEqual(before)
    expect(await indexDef()).toBe(beforeIndex)
  })

  it('the rollback in the header removes both columns and the index; the file re-applies', async () => {
    const rollback = rollbackSql()
    expect(rollback).toContain(`DROP INDEX IF EXISTS ${INDEX};`)
    await client.query(rollback)
    expect(await addedColumns()).toEqual([])
    expect(await indexDef()).toBeNull()
    await applyFile()
    expect((await addedColumns()).map((c) => c.name)).toEqual([
      'published_at',
      'published_order_key',
    ])
  })
})
