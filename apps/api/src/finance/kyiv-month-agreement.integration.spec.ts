/**
 * backlog 338 (A) — the three month views must agree on a row that sits on a
 * month boundary where Kyiv is already ahead of UTC.
 *
 * The three readers
 *   - the finance summary GRAPH      (`getSummary().monthly`, keyed by `transactionBusinessMonth`)
 *   - the accountant TILES           (`getAccountantSummary().paidThisMonth` / `validatedThisMonth`)
 *   - the SENIOR stats               (`getSeniorSummary().seniorShareIncome.thisMonth` / `lastMonth`)
 * are run against REAL Postgres rows with the clock pinned to 2026-10-31T23:30Z
 * (= 01:30 on 1 November in Kyiv, UTC+2), where the UTC month is still October
 * and the Kyiv month is already November.
 *
 * The decisive row is PAID, written at 2026-10-31T22:30Z (= 00:30 on 1 Nov Kyiv)
 * with the `tx_date` the writer (`resolveTransactionDate`) persists for that
 * instant: the Kyiv day 2026-11-01 at UTC midnight. `tx_date` is never NULL any
 * more (the created_at fallback was removed), so every row here carries
 * one. All three views must file the decisive row in 2026-11 and the October
 * rows in 2026-10.
 *
 * Database: a SCRATCH database `crm_scratch_kyivmonth_<random>` is created on the
 * server `DATABASE_URL` points at, the Drizzle schema is pushed into it, and it is
 * dropped in `afterAll`. Creation is refused if `DATABASE_URL` names `crm_db`. The
 * dataset is therefore exactly the rows below, so the graph totals are exact.
 *
 * Run (NEVER against crm_db; DATABASE_URL inline):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     TZ=Europe/Kyiv pnpm --filter @crm/api test -- kyiv-month-agreement.integration
 * and again with TZ=America/Los_Angeles.
 */
import { randomBytes } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import { SummaryService } from './summary.service'
import { resolveTransactionDate } from './transaction-date.util'
import type { NbuCurrencyService } from './nbu-currency.service'
import { hasDatabaseUrl } from '../test/require-real-db'

const SCRATCH_NAME = /^crm_scratch_kyivmonth_[0-9a-f]{12}$/

// The pinned clock: UTC says October, Kyiv (UTC+2 after the 25 Oct DST end) says November.
const NOW = new Date('2026-10-31T23:30:00.000Z')

// The decisive row's write instant and the tx_date the real writer persists for it.
const BOUNDARY_WRITE = new Date('2026-10-31T22:30:00.000Z')
const BOUNDARY_TX_DATE = resolveTransactionDate(undefined, BOUNDARY_WRITE).toISOString()

const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001'
const ACCOUNTANT_ID = 'a0000000-0000-4000-8000-000000000002'
const SENIOR_ID = 'a0000000-0000-4000-8000-000000000003'

const ADMIN: SessionUser = {
  id: ADMIN_ID,
  email: 'km-admin@test.spec',
  displayName: 'KM Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  ...ADMIN,
  id: ACCOUNTANT_ID,
  email: 'km-accountant@test.spec',
  role: 'ACCOUNTANT',
}
const SENIOR: SessionUser = {
  ...ADMIN,
  id: SENIOR_ID,
  email: 'km-senior@test.spec',
  role: 'SENIOR',
}

describe.skipIf(!hasDatabaseUrl())(
  'Kyiv month windows agree across graph, tiles and senior stats',
  () => {
    let adminPool: Pool
    let pool: Pool
    let scratchName: string
    let summary: SummaryService

    async function insertTx(row: {
      type: string
      status: string
      amount: string
      txDate: string
      createdAt: string
      validatedAt?: string | null
      senderId?: string | null
      receiverId?: string | null
    }) {
      await pool.query(
        `INSERT INTO transactions
         (type, status, amount, currency, tx_date, created_at, validated_at, sender_id, receiver_id, senior_share_percent, created_by)
       VALUES ($1, $2, $3, 'USD', $4, $5, $6, $7, $8, 100, $9)`,
        [
          row.type,
          row.status,
          row.amount,
          row.txDate,
          row.createdAt,
          row.validatedAt ?? null,
          row.senderId ?? null,
          row.receiverId ?? null,
          ADMIN_ID,
        ],
      )
    }

    beforeAll(async () => {
      const base = new URL(process.env['DATABASE_URL']!)
      if (base.pathname.replace('/', '') === 'crm_db') {
        throw new Error('refusing to run against crm_db')
      }
      scratchName = `crm_scratch_kyivmonth_${randomBytes(6).toString('hex')}`
      if (!SCRATCH_NAME.test(scratchName)) throw new Error(`bad scratch name ${scratchName}`)

      adminPool = new Pool({ connectionString: base.toString(), max: 1 })
      adminPool.on('error', () => undefined)
      const who = await adminPool.query('SELECT current_database() AS db')
      if (who.rows[0].db === 'crm_db') throw new Error('connected to crm_db — refusing')
      await adminPool.query(`CREATE DATABASE ${scratchName}`)

      const scratchUrl = new URL(base.toString())
      scratchUrl.pathname = `/${scratchName}`
      pool = new Pool({ connectionString: scratchUrl.toString(), max: 4 })
      pool.on('error', () => undefined)

      const db = drizzle(pool, { schema })
      const { pushSchema } = await import('drizzle-kit/api')
      const pushed = await pushSchema(schema, db as never)
      await pushed.apply()

      const instance = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(instance, { pool, db })
      const nbu = { getRates: () => Promise.resolve({}) } as unknown as NbuCurrencyService
      summary = new SummaryService(instance, nbu)

      for (const u of [ADMIN, ACCOUNTANT, SENIOR]) {
        await pool.query(
          `INSERT INTO users (id, email, display_name, role, google_id) VALUES ($1, $2, $3, $4, $5)`,
          [u.id, u.email, u.displayName, u.role, `g-${u.id}`],
        )
      }

      // 'SENIOR_INCOME' PAID rows credited to SENIOR (100% share snapshot => share == amount).
      const income = (amount: string, txDate: string, createdAt: string) =>
        insertTx({
          type: 'SENIOR_INCOME',
          status: 'PAID',
          amount,
          txDate,
          createdAt,
          receiverId: SENIOR_ID,
        })
      // X — THE boundary row: written 22:30Z on the last UTC day of October (00:30
      //     on 1 Nov in Kyiv) with no operator date, so the writer stores the Kyiv
      //     day (asserted in the first test below).
      await income('100', BOUNDARY_TX_DATE, BOUNDARY_WRITE.toISOString())
      // Y — mid-October, written the same day. Business month: 2026-10.
      await income('10', '2026-10-15T00:00:00Z', '2026-10-15T10:00:00Z')
      // Z — operator-chosen tx_date 31 Oct (UTC midnight), created on 1 Nov Kyiv.
      //     tx_date wins: 2026-10.
      await income('1', '2026-10-31T00:00:00Z', '2026-10-31T23:00:00Z')
      // Validated-by-the-accountant rows (validatedAt is a real instant).
      //   V1 validated 22:30Z 31 Oct = Kyiv November -> "validated this month".
      //   V2 validated 15 Oct       = Kyiv October  -> not this month.
      await insertTx({
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '7',
        txDate: '2026-10-01T00:00:00Z',
        createdAt: '2026-10-01T00:00:00Z',
        validatedAt: '2026-10-31T22:30:00Z',
        receiverId: SENIOR_ID,
      })
      await insertTx({
        type: 'SENIOR_INCOME',
        status: 'VALIDATED',
        amount: '70',
        txDate: '2026-10-01T00:00:00Z',
        createdAt: '2026-10-01T00:00:00Z',
        validatedAt: '2026-10-15T10:00:00Z',
        receiverId: SENIOR_ID,
      })
    })

    afterAll(async () => {
      vi.useRealTimers()
      try {
        await pool?.end()
      } finally {
        if (adminPool && scratchName && SCRATCH_NAME.test(scratchName)) {
          await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`)
        }
        await adminPool?.end()
      }
    })

    async function atBoundaryClock<T>(run: () => Promise<T>): Promise<T> {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(NOW)
      try {
        return await run()
      } finally {
        vi.useRealTimers()
      }
    }

    it('the boundary row carries the non-null Kyiv-day tx_date the writer persists', async () => {
      expect(BOUNDARY_TX_DATE).toBe('2026-11-01T00:00:00.000Z')
      const res = await pool.query<{ tx_date: Date | null }>(
        `SELECT tx_date FROM transactions WHERE created_at = $1`,
        [BOUNDARY_WRITE.toISOString()],
      )
      expect(res.rows.map((r) => r.tx_date?.toISOString())).toEqual(['2026-11-01T00:00:00.000Z'])
      const nulls = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM transactions WHERE tx_date IS NULL`,
      )
      expect(nulls.rows[0]!.n).toBe('0')
    })

    it('the graph files the boundary row in November and the mid-October row in October', async () => {
      const { monthly } = await atBoundaryClock(() => summary.getSummary(ACCOUNTANT))
      const byMonth = Object.fromEntries(monthly.map((m) => [m.month, m.income]))
      expect(byMonth).toEqual({ '2026-10': 11, '2026-11': 100 })
    })

    it('the accountant tiles count the SAME November row as "this month" (paid and validated)', async () => {
      const tiles = await atBoundaryClock(() => summary.getAccountantSummary(ACCOUNTANT))
      expect(tiles.paidThisMonth.amount).toBe(100)
      expect(tiles.validatedThisMonth).toEqual({ count: 1, amount: 7 })
    })

    it('the senior stats put the SAME row in this month and the October rows in last month', async () => {
      const stats = await atBoundaryClock(() => summary.getSeniorSummary(SENIOR))
      expect(stats.seniorShareIncome.thisMonth).toBe(100)
      expect(stats.earningsStats.lastMonthIncome).toBe(11)
      const history = stats.earningsStats.monthlyHistory
      expect(history.at(-1)).toEqual({ month: '2026-11', amount: 100 })
      expect(history.at(-2)).toEqual({ month: '2026-10', amount: 11 })
    })

    it('all three views assign the boundary amount to one and the same month', async () => {
      const { graph, tiles, senior } = await atBoundaryClock(async () => ({
        graph: await summary.getSummary(ACCOUNTANT),
        tiles: await summary.getAccountantSummary(ACCOUNTANT),
        senior: await summary.getSeniorSummary(SENIOR),
      }))
      const graphCurrent = graph.monthly.find((m) => m.month === '2026-11')?.income
      expect(tiles.paidThisMonth.amount).toBe(graphCurrent)
      expect(senior.seniorShareIncome.thisMonth).toBe(graphCurrent)
    })
  },
)
