import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { Pool, type PoolClient } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { users } from './schema'
import { hasDatabaseUrl } from '../test/require-real-db'

/**
 * Default senior share 26 -> 40 — `manual/2026-11-28_senior_share_default_40.sql` against a REAL
 * Postgres, in a scratch schema holding a stub of `users` with the pre-change default 26. NEVER
 * `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run senior-share-default-40-ddl.integration.spec
 */
const FILE = join(
  __dirname,
  '..',
  '..',
  'drizzle',
  'manual',
  '2026-11-28_senior_share_default_40.sql',
)
const SCHEMA = 'ddl_senior_share_default_40'

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

async function shares(): Promise<Record<string, number>> {
  const { rows } = await client.query<{ name: string; senior_share_percent: number }>(
    `SELECT name, senior_share_percent FROM ${SCHEMA}.users ORDER BY name`,
  )
  return Object.fromEntries(rows.map((r) => [r.name, r.senior_share_percent]))
}

async function columnDefault(): Promise<string | null> {
  const { rows } = await client.query<{ d: string | null }>(
    `SELECT column_default AS d FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'senior_share_percent'`,
    [SCHEMA],
  )
  return rows[0]?.d ?? null
}

describe.skipIf(!hasDatabaseUrl())('DDL: users.senior_share_percent default 26 -> 40', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    client = await pool.connect()
    const { rows } = await client.query(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await client.query(`CREATE SCHEMA ${SCHEMA}`)
    await client.query(`SET search_path = ${SCHEMA}, public`)
    await client.query(
      `CREATE TABLE ${SCHEMA}.users (
         name text PRIMARY KEY,
         senior_share_percent integer NOT NULL DEFAULT 26
       )`,
    )
    await client.query(
      `INSERT INTO ${SCHEMA}.users (name, senior_share_percent) VALUES ('a26', 26), ('b30', 30), ('c0', 0)`,
    )
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

  it('moves 26 to 40 and leaves every other value untouched', async () => {
    expect(await shares()).toEqual({ a26: 40, b30: 30, c0: 0 })
  })

  it('sets the column default to 40, as Drizzle declares', async () => {
    expect(await columnDefault()).toBe('40')
    const col = getTableConfig(users).columns.find((c) => c.name === 'senior_share_percent')
    expect(col?.default).toBe(40)
    await client.query(`INSERT INTO ${SCHEMA}.users (name) VALUES ('d_new')`)
    expect((await shares())['d_new']).toBe(40)
  })

  it('a replay is a no-op: a user deliberately set back to 26 keeps 26', async () => {
    await client.query(`UPDATE ${SCHEMA}.users SET senior_share_percent = 26 WHERE name = 'a26'`)
    await applyFile()
    expect((await shares())['a26']).toBe(26)
    expect(await columnDefault()).toBe('40')
  })

  it('refuses when the default is neither 26 nor 40, changing nothing', async () => {
    await client.query(
      `ALTER TABLE ${SCHEMA}.users ALTER COLUMN senior_share_percent SET DEFAULT 33`,
    )
    const before = await shares()
    await expect(applyFile()).rejects.toThrow(/default is 33, expected 26 or 40/)
    expect(await shares()).toEqual(before)
    expect(await columnDefault()).toBe('33')
  })
})
