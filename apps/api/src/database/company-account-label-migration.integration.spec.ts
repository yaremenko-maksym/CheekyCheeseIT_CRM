/**
 * `2026-10-03_company_account_label_code.sql` (server-text PR3): converges the
 * stored Russian prose marker onto the `COMPANY` code, idempotently.
 *
 * `deploy.yml` applies every `manual/*.sql` file on EVERY deploy (no registry of
 * applied migrations), so «apply again» must stay harmless forever — proven by
 * EXECUTING the file twice, not by reading it. Runs in an isolated schema with a
 * minimal `transactions` stub (only the three columns the file touches).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { hasDatabaseUrl } from '../test/require-real-db'

const MIGRATION_FILE = '2026-10-03_company_account_label_code.sql'
const SCHEMA = 'mig_company_label_check'
const PROSE = 'Счёт компании'
const STAMP = '2026-01-01T00:00:00.000Z'

let pool: Pool

function migrationSql(): string {
  return readFileSync(join(__dirname, '..', '..', 'drizzle', 'manual', MIGRATION_FILE), 'utf8')
}

async function apply(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(`SET search_path TO ${SCHEMA}`)
    await client.query(migrationSql())
  } finally {
    client.release()
  }
}

async function rows(): Promise<
  { id: number; sender_label: string | null; receiver_label: string | null; updated_at: Date }[]
> {
  const res = await pool.query(
    `SELECT id, sender_label, receiver_label, updated_at FROM ${SCHEMA}.transactions ORDER BY id`,
  )
  return res.rows
}

describe.skipIf(!hasDatabaseUrl())('миграция метки счёта компании идемпотентна', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.query(`CREATE SCHEMA ${SCHEMA}`)
    await pool.query(
      `CREATE TABLE ${SCHEMA}.transactions (
         id integer PRIMARY KEY,
         sender_label varchar(255),
         receiver_label varchar(255),
         updated_at timestamptz NOT NULL
       )`,
    )
  })

  beforeEach(async () => {
    await pool.query(`TRUNCATE ${SCHEMA}.transactions`)
    await pool.query(
      `INSERT INTO ${SCHEMA}.transactions (id, sender_label, receiver_label, updated_at) VALUES
         (1, $1, NULL, $2),            -- DIVIDEND_TO_ADMIN-style: company is the sender
         (2, 'Иван Петров', $1, $2),   -- COMPANY_DEPOSIT-style: company is the receiver
         (3, 'COMPANY', NULL, $2),     -- already a code
         (4, 'Acme Corp', 'Hosting', $2), -- unrelated labels
         (5, NULL, NULL, $2)`,
      [PROSE, STAMP],
    )
  })

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await pool.end()
  })

  it('rewrites the prose marker on either side to the COMPANY code', async () => {
    await apply()

    const [r1, r2] = await rows()
    expect(r1).toMatchObject({ sender_label: 'COMPANY', receiver_label: null })
    expect(r2).toMatchObject({ sender_label: 'Иван Петров', receiver_label: 'COMPANY' })
  })

  it('leaves every other label (codes, names, categories, nulls) untouched', async () => {
    await apply()

    const all = await rows()
    expect(all[2]).toMatchObject({ sender_label: 'COMPANY', receiver_label: null })
    expect(all[3]).toMatchObject({ sender_label: 'Acme Corp', receiver_label: 'Hosting' })
    expect(all[4]).toMatchObject({ sender_label: null, receiver_label: null })
  })

  it('does not bump updated_at — normalizing a token is not a user edit', async () => {
    await apply()

    for (const r of await rows()) {
      expect(r.updated_at.toISOString()).toBe(STAMP)
    }
  })

  it('applies twice in a row without error and the second run changes nothing', async () => {
    await apply()
    const afterFirst = await rows()

    await apply()

    expect(await rows()).toEqual(afterFirst)
  })

  it('leaves no row carrying the prose marker', async () => {
    await apply()

    const left = await pool.query(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.transactions
        WHERE sender_label = $1 OR receiver_label = $1`,
      [PROSE],
    )
    expect(left.rows[0].n).toBe(0)
  })
})
