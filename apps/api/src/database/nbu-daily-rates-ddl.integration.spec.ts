import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Manager-role plan PR 8 — the forward DDL `manual/2026-11-28_nbu_daily_rates.sql` against a REAL
 * Postgres, applied twice into a scratch schema, and compared with the table `db:push` built from
 * the Drizzle declaration in `public`. NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run nbu-daily-rates-ddl.integration.spec
 */
const FILE = join(__dirname, '..', '..', 'drizzle', 'manual', '2026-11-28_nbu_daily_rates.sql')
const SCHEMA = 'ddl_nbu_daily_rates'
const TABLE = 'nbu_daily_rates'

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

async function columns(schema: string) {
  const { rows } = await client.query(
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
  return rows
}

async function constraints(schema: string) {
  const { rows } = await client.query(
    `SELECT con.conname AS name, con.contype AS type, con.convalidated AS validated,
            pg_get_constraintdef(con.oid) AS def
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = $2
      ORDER BY con.conname`,
    [schema, TABLE],
  )
  return rows
}

describe.skipIf(!hasDatabaseUrl())('DDL: nbu_daily_rates', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    client = await pool.connect()
    const { rows } = await client.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    await client.query(`SET search_path = ${SCHEMA}, public`)
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

  it('creates the same columns and constraints db:push builds from the Drizzle declaration', async () => {
    const fromFile = await columns(SCHEMA)
    expect(fromFile.map((c) => c.name)).toEqual([
      'rate_date',
      'usd_uah',
      'eur_uah',
      'source_id',
      'created_at',
    ])
    expect(fromFile).toEqual(await columns('public'))
    const fileConstraints = await constraints(SCHEMA)
    expect(fileConstraints.map((c) => c.name)).toEqual([
      'ck_nbu_daily_rates_positive',
      'nbu_daily_rates_pkey',
    ])
    expect(fileConstraints.every((c) => c.validated === true)).toBe(true)
    expect(fileConstraints).toEqual(await constraints('public'))
  })

  it('refuses a non-positive rate and a second row for the same day', async () => {
    await client.query(
      `INSERT INTO ${SCHEMA}.${TABLE} (rate_date, usd_uah, eur_uah, source_id)
       VALUES ('2026-11-10', 41.1, 44.1, 'statdirectory')`,
    )
    await expect(
      client.query(
        `INSERT INTO ${SCHEMA}.${TABLE} (rate_date, usd_uah, eur_uah, source_id)
         VALUES ('2026-11-11', 0, 44.1, 'statdirectory')`,
      ),
    ).rejects.toThrow(/ck_nbu_daily_rates_positive/)
    await expect(
      client.query(
        `INSERT INTO ${SCHEMA}.${TABLE} (rate_date, usd_uah, eur_uah, source_id)
         VALUES ('2026-11-10', 42, 45, 'statdirectory')`,
      ),
    ).rejects.toThrow(/nbu_daily_rates_pkey/)
  })

  it('the second apply succeeds and changes nothing', async () => {
    const before = [await columns(SCHEMA), await constraints(SCHEMA)]
    await applyFile()
    expect([await columns(SCHEMA), await constraints(SCHEMA)]).toEqual(before)
  })
})
