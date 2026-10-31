/**
 * backlog 338, final step (owner-approved 2026-10-26) — `transactions.tx_date` becomes
 * NOT NULL. Runs the ACTUAL file `drizzle/manual/2026-10-27_transactions_tx_date_not_null.sql`
 * against REAL Postgres, the way the deploy applies it (one connection, one transaction).
 *
 * Database: a SCRATCH database `crm_scratch_txnotnull_<random>` is created on the server
 * `DATABASE_URL` points at, the Drizzle schema is pushed into it, and it is dropped in
 * `afterAll`. Refused if `DATABASE_URL` names `crm_db`.
 *
 * Run (NEVER against crm_db; DATABASE_URL inline):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- tx-date-not-null.integration
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import * as schema from './schema'
import { hasDatabaseUrl } from '../test/require-real-db'

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../drizzle/manual/2026-10-27_transactions_tx_date_not_null.sql',
)
const SCRATCH_NAME = /^crm_scratch_txnotnull_[0-9a-f]{12}$/
const ADMIN_ID = 'a0000000-0000-4000-8000-0000000000c1'
const SENIOR_ID = 'a0000000-0000-4000-8000-0000000000c2'

describe.skipIf(!hasDatabaseUrl())(
  'transactions.tx_date NOT NULL (2026-10-27_transactions_tx_date_not_null.sql)',
  () => {
    let adminPool: Pool
    let pool: Pool
    let scratchName: string
    const migrationSql = readFileSync(MIGRATION_PATH, 'utf8')

    /** Apply the real file on one connection, returning the NOTICE lines it raised. */
    async function applyMigration(): Promise<string[]> {
      const client = await pool.connect()
      const notices: string[] = []
      const onNotice = (m: { message?: string }) => notices.push(m.message ?? '')
      client.on('notice', onNotice)
      try {
        await client.query(migrationSql)
        return notices
      } finally {
        client.off('notice', onNotice)
        client.release()
      }
    }

    async function isNotNull(): Promise<boolean> {
      const res = await pool.query<{ notnull: boolean }>(
        `SELECT attnotnull AS notnull FROM pg_attribute
          WHERE attrelid = 'public.transactions'::regclass AND attname = 'tx_date'`,
      )
      return res.rows[0]!.notnull
    }

    async function rowCount(): Promise<number> {
      const res = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM transactions`)
      return Number(res.rows[0]!.n)
    }

    function insertTx(txDate: string | null) {
      return pool.query(
        `INSERT INTO transactions
           (type, status, amount, currency, tx_date, receiver_id, senior_share_percent, created_by)
         VALUES ('SENIOR_INCOME', 'PAID', '1', 'USD', $1, $2, 100, $3)`,
        [txDate, SENIOR_ID, ADMIN_ID],
      )
    }

    function insertTxWithoutTxDate() {
      return pool.query(
        `INSERT INTO transactions
           (type, status, amount, currency, receiver_id, senior_share_percent, created_by)
         VALUES ('SENIOR_INCOME', 'PAID', '1', 'USD', $1, 100, $2)`,
        [SENIOR_ID, ADMIN_ID],
      )
    }

    beforeAll(async () => {
      const base = new URL(process.env['DATABASE_URL']!)
      if (base.pathname.replace('/', '') === 'crm_db')
        throw new Error('refusing to run against crm_db')
      scratchName = `crm_scratch_txnotnull_${randomBytes(6).toString('hex')}`
      if (!SCRATCH_NAME.test(scratchName)) throw new Error(`bad scratch name ${scratchName}`)

      adminPool = new Pool({ connectionString: base.toString(), max: 1 })
      adminPool.on('error', () => undefined)
      const who = await adminPool.query('SELECT current_database() AS db')
      if (who.rows[0].db === 'crm_db') throw new Error('connected to crm_db — refusing')
      await adminPool.query(`CREATE DATABASE ${scratchName}`)

      const scratchUrl = new URL(base.toString())
      scratchUrl.pathname = `/${scratchName}`
      pool = new Pool({ connectionString: scratchUrl.toString(), max: 2 })
      pool.on('error', () => undefined)

      const db = drizzle(pool, { schema })
      const { pushSchema } = await import('drizzle-kit/api')
      const pushed = await pushSchema(schema, db as never)
      await pushed.apply()

      for (const [id, role] of [
        [ADMIN_ID, 'ADMIN'],
        [SENIOR_ID, 'SENIOR'],
      ] as const) {
        await pool.query(
          `INSERT INTO users (id, email, display_name, role, google_id) VALUES ($1, $2, $3, $4, $5)`,
          [id, `txnn-${role.toLowerCase()}@test.spec`, `TxNN ${role}`, role, `g-${id}`],
        )
      }
    }, 120_000)

    afterAll(async () => {
      try {
        await pool?.end()
      } finally {
        if (adminPool && scratchName && SCRATCH_NAME.test(scratchName)) {
          await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`)
        }
        await adminPool?.end()
      }
    })

    it('schema.ts already declares the end state: the pushed column is NOT NULL', async () => {
      expect(await isNotNull()).toBe(true)
    })

    it('the database rejects an insert without tx_date (not_null_violation 23502)', async () => {
      await expect(insertTxWithoutTxDate()).rejects.toMatchObject({
        code: '23502',
        column: 'tx_date',
      })
      await expect(insertTx(null)).rejects.toMatchObject({ code: '23502', column: 'tx_date' })
      expect(await rowCount()).toBe(0)
    })

    it('fails loud on a NULL row, with the count only, and leaves the column nullable', async () => {
      // Production before this file: the column was nullable.
      await pool.query('ALTER TABLE transactions ALTER COLUMN tx_date DROP NOT NULL')
      await insertTx('2026-10-01T00:00:00.000Z')
      await insertTx(null)
      await insertTx(null)

      await expect(applyMigration()).rejects.toThrow(
        /^transactions\.tx_date NOT NULL refused: 2 row\(s\) still have tx_date IS NULL$/,
      )
      expect(await isNotNull()).toBe(false)
      expect(await rowCount()).toBe(3)
    })

    it('fails fast (lock_timeout, 55P03) instead of queueing behind a lock the old API holds', async () => {
      await pool.query(
        `UPDATE transactions SET tx_date = '2026-10-02T00:00:00.000Z' WHERE tx_date IS NULL`,
      )
      // An open transaction of the still-serving API: any read of transactions holds
      // ACCESS SHARE, which conflicts with the ALTER's ACCESS EXCLUSIVE.
      const holder = await pool.connect()
      try {
        await holder.query('BEGIN')
        await holder.query('SELECT count(*) FROM transactions')
        const started = Date.now()
        await expect(applyMigration()).rejects.toMatchObject({ code: '55P03' })
        const waitedMs = Date.now() - started
        // Bounded by the file's 10s lock_timeout, not by the holder.
        expect(waitedMs).toBeGreaterThanOrEqual(9_000)
        expect(waitedMs).toBeLessThan(20_000)
      } finally {
        await holder.query('ROLLBACK')
        holder.release()
      }
      expect(await isNotNull()).toBe(false)
    }, 40_000)

    it('with 0 NULL rows the column becomes NOT NULL without rewriting data', async () => {
      await pool.query(
        `UPDATE transactions SET tx_date = '2026-10-02T00:00:00.000Z' WHERE tx_date IS NULL`,
      )
      const before = await pool.query(`SELECT id, tx_date FROM transactions ORDER BY id`)

      const notices = await applyMigration()

      expect(notices).toEqual(['transactions.tx_date is now NOT NULL (0 NULL rows checked)'])
      expect(await isNotNull()).toBe(true)
      const after = await pool.query(`SELECT id, tx_date FROM transactions ORDER BY id`)
      expect(after.rows).toEqual(before.rows)
      await expect(insertTxWithoutTxDate()).rejects.toMatchObject({ code: '23502' })
    })

    it('a second apply is a no-op (every deploy re-runs it)', async () => {
      const notices = await applyMigration()
      expect(notices).toEqual(['transactions.tx_date is already NOT NULL; nothing to do'])
      expect(await isNotNull()).toBe(true)
      expect(await rowCount()).toBe(3)
    })
  },
)
