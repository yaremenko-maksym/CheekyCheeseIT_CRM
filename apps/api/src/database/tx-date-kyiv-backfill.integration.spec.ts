/**
 * backlog 338 (owner decision 2, approved 2026-10-25) — the one-time backfill of legacy
 * NULL `transactions.tx_date` to the Kyiv business day, run against REAL Postgres.
 *
 * Runs the ACTUAL file `drizzle/manual/2026-10-25_tx_date_kyiv_backfill.sql`, not a
 * paraphrase. The value it writes must be exactly what `resolveTransactionDate(null, createdAt)`
 * would have persisted had the row been inserted today: the real instant when the Kyiv day
 * equals the UTC day, otherwise UTC midnight of the Kyiv day. Expected values below are
 * hand-computed literals; the TS helper is a second, independent implementation checked
 * for parity, not the source of the expectation.
 *
 * Database: a SCRATCH database `crm_scratch_txbackfill_<random>` is created on the server
 * `DATABASE_URL` points at, the Drizzle schema is pushed into it, and it is dropped in
 * `afterAll`. Refused if `DATABASE_URL` names `crm_db`. The dataset is exactly the rows
 * below, so "zero NULL rows left" is an exact claim, not a namespace-filtered one.
 *
 * Run (NEVER against crm_db; DATABASE_URL inline):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api test -- tx-date-kyiv-backfill.integration
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { kyivDayOf, type SessionUser } from '@crm/shared'

import { DatabaseService } from './database.service'
import * as schema from './schema'
import { SummaryService } from '../finance/summary.service'
import type { NbuCurrencyService } from '../finance/nbu-currency.service'
import { resolveTransactionDate, transactionBusinessMonth } from '../finance/transaction-date.util'
import { hasDatabaseUrl } from '../test/require-real-db'

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../drizzle/manual/2026-10-25_tx_date_kyiv_backfill.sql',
)
const BACKUP_TABLE = '_tx_date_kyiv_backfill_backup_20261025'
const SCRATCH_NAME = /^crm_scratch_txbackfill_[0-9a-f]{12}$/

const ADMIN_ID = 'a0000000-0000-4000-8000-0000000000b1'
const SENIOR_ID = 'a0000000-0000-4000-8000-0000000000b2'
const ADMIN: SessionUser = {
  id: ADMIN_ID,
  email: 'txb-admin@test.spec',
  displayName: 'TXB Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  ...ADMIN,
  id: 'a0000000-0000-4000-8000-0000000000b3',
  email: 'txb-accountant@test.spec',
  role: 'ACCOUNTANT',
}

/**
 * Legacy NULL rows: createdAt -> the tx_date the backfill must write (hand-computed).
 * Kyiv is UTC+2 (EET) in winter and UTC+3 (EEST) in summer; 2026 DST starts 29 Mar 01:00Z
 * and ends 25 Oct 01:00Z.
 */
const NULL_ROWS: { label: string; createdAt: string; expected: string }[] = [
  // 22:30Z on the last UTC day of October = 00:30 on 1 Nov in Kyiv (EET): month boundary.
  {
    label: 'oct-month-boundary',
    createdAt: '2026-10-31T22:30:00.000Z',
    expected: '2026-11-01T00:00:00.000Z',
  },
  {
    label: 'jan-month-boundary-winter',
    createdAt: '2026-01-31T22:30:00.000Z',
    expected: '2026-02-01T00:00:00.000Z',
  },
  {
    label: 'year-boundary',
    createdAt: '2025-12-31T22:30:00.000Z',
    expected: '2026-01-01T00:00:00.000Z',
  },
  // Night before DST end: 21:30Z 24 Oct = 00:30 25 Oct EEST (+3) -> Kyiv day 25 Oct.
  {
    label: 'dst-end-eve',
    createdAt: '2026-10-24T21:30:00.000Z',
    expected: '2026-10-25T00:00:00.000Z',
  },
  // After DST end: 21:30Z 25 Oct = 23:30 25 Oct EET (+2) -> same day, instant kept.
  {
    label: 'dst-end-after',
    createdAt: '2026-10-25T21:30:00.000Z',
    expected: '2026-10-25T21:30:00.000Z',
  },
  // After DST start: 21:30Z 29 Mar = 00:30 30 Mar EEST (+3). A fixed +2 would say 29 Mar.
  {
    label: 'dst-start-after',
    createdAt: '2026-03-29T21:30:00.000Z',
    expected: '2026-03-30T00:00:00.000Z',
  },
  // Before DST start: 21:30Z 28 Mar = 23:30 28 Mar EET (+2) -> same day, instant kept.
  {
    label: 'dst-start-eve',
    createdAt: '2026-03-28T21:30:00.000Z',
    expected: '2026-03-28T21:30:00.000Z',
  },
  // Exactly Kyiv midnight in summer (21:00Z = 00:00 EEST) and one second before it.
  {
    label: 'summer-midnight-exact',
    createdAt: '2026-05-31T21:00:00.000Z',
    expected: '2026-06-01T00:00:00.000Z',
  },
  {
    label: 'summer-midnight-minus-1s',
    createdAt: '2026-05-31T20:59:59.000Z',
    expected: '2026-05-31T20:59:59.000Z',
  },
  // Ordinary mid-day row: instant kept.
  { label: 'mid-day', createdAt: '2026-10-15T10:00:00.000Z', expected: '2026-10-15T10:00:00.000Z' },
]

describe.skipIf(!hasDatabaseUrl())(
  'tx_date Kyiv backfill (2026-10-25_tx_date_kyiv_backfill.sql)',
  () => {
    let adminPool: Pool
    let pool: Pool
    let scratchName: string
    let summary: SummaryService
    let migrationSql: string
    const ids = new Map<string, string>()
    let explicitId: string
    let snapshotBefore: Map<string, Record<string, unknown>>
    let monthsBefore: Map<string, string>
    let graphBeforeError: string | null

    async function insertTx(row: {
      txDate: string | null
      createdAt: string
      status?: string
      deletedAt?: string | null
      amount?: string
    }): Promise<string> {
      const res = await pool.query<{ id: string }>(
        `INSERT INTO transactions
         (type, status, amount, currency, tx_date, created_at, deleted_at, receiver_id, senior_share_percent, created_by)
       VALUES ('SENIOR_INCOME', $1, $2, 'USD', $3, $4, $5, $6, 100, $7)
       RETURNING id`,
        [
          row.status ?? 'PAID',
          row.amount ?? '10',
          row.txDate,
          row.createdAt,
          row.deletedAt ?? null,
          SENIOR_ID,
          ADMIN_ID,
        ],
      )
      return res.rows[0]!.id
    }

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

    async function snapshotWithoutTxDate(): Promise<Map<string, Record<string, unknown>>> {
      const res = await pool.query<{ id: string; row: Record<string, unknown> }>(
        `SELECT id, to_jsonb(t) - 'tx_date' AS row FROM transactions t`,
      )
      return new Map(res.rows.map((r) => [r.id, r.row]))
    }

    async function txDates(): Promise<Map<string, Date | null>> {
      const res = await pool.query<{ id: string; tx_date: Date | null }>(
        `SELECT id, tx_date FROM transactions`,
      )
      return new Map(res.rows.map((r) => [r.id, r.tx_date]))
    }

    async function nullCount(): Promise<number> {
      const res = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM transactions WHERE tx_date IS NULL`,
      )
      return Number(res.rows[0]!.n)
    }

    async function graph(): Promise<unknown> {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-11-02T12:00:00.000Z'))
      try {
        return (await summary.getSummary(ACCOUNTANT)).monthly
      } finally {
        vi.useRealTimers()
      }
    }

    beforeAll(async () => {
      const base = new URL(process.env['DATABASE_URL']!)
      if (base.pathname.replace('/', '') === 'crm_db')
        throw new Error('refusing to run against crm_db')
      scratchName = `crm_scratch_txbackfill_${randomBytes(6).toString('hex')}`
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
      // schema.ts now declares tx_date NOT NULL (2026-10-27_transactions_tx_date_not_null.sql).
      // The backfill ran on production BEFORE that constraint, against a nullable column, so
      // this scratch database is put back into that historical shape to replay it faithfully.
      await pool.query('ALTER TABLE transactions ALTER COLUMN tx_date DROP NOT NULL')

      const instance = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(instance, { pool, db })
      const nbu = { getRates: () => Promise.resolve({}) } as unknown as NbuCurrencyService
      summary = new SummaryService(instance, nbu)

      for (const u of [
        ADMIN,
        ACCOUNTANT,
        { ...ADMIN, id: SENIOR_ID, email: 'txb-senior@test.spec', role: 'SENIOR' },
      ]) {
        await pool.query(
          `INSERT INTO users (id, email, display_name, role, google_id) VALUES ($1, $2, $3, $4, $5)`,
          [u.id, u.email, u.displayName, u.role, `g-${u.id}`],
        )
      }

      for (const [i, r] of NULL_ROWS.entries()) {
        ids.set(
          r.label,
          await insertTx({ txDate: null, createdAt: r.createdAt, amount: String(i + 1) }),
        )
      }
      // Status and soft-delete do not matter: every NULL row is a legacy row to backfill.
      ids.set(
        'pending',
        await insertTx({ txDate: null, createdAt: '2026-08-31T21:30:00.000Z', status: 'PENDING' }),
      )
      ids.set(
        'soft-deleted',
        await insertTx({
          txDate: null,
          createdAt: '2026-08-31T21:30:00.000Z',
          deletedAt: '2026-09-01T10:00:00Z',
        }),
      )
      // A row WITH an explicit tx_date, whose UTC day differs from its Kyiv created-at day:
      // must stay exactly as it is.
      explicitId = await insertTx({
        txDate: '2026-10-31T00:00:00Z',
        createdAt: '2026-10-31T23:00:00Z',
      })

      migrationSql = readFileSync(MIGRATION_PATH, 'utf-8')
      snapshotBefore = await snapshotWithoutTxDate()
      const before = await pool.query<{ id: string; created_at: Date }>(
        `SELECT id, created_at FROM transactions WHERE tx_date IS NULL`,
      )
      // Month key each row had through the (now removed) created_at fallback: the
      // KYIV month of created_at.
      monthsBefore = new Map(before.rows.map((r) => [r.id, kyivDayOf(r.created_at).slice(0, 7)]))
      graphBeforeError = await graph().then(
        () => null,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      )
    }, 60_000)

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

    it('starts with the 12 legacy NULL rows and no backup table', async () => {
      expect(await nullCount()).toBe(12)
      const reg = await pool.query(`SELECT to_regclass($1) AS r`, [`public.${BACKUP_TABLE}`])
      expect(reg.rows[0].r).toBeNull()
    })

    it('fails loud and writes nothing when the update count disagrees with the backup (CR-M-1)', async () => {
      // Stand-in for a concurrent writer between the backup INSERT and the UPDATE: a trigger
      // that silently skips the update of one row, so updated (11) < backed_up (12). Deleting
      // the final counts-disagree RAISE makes this run succeed and this test fail.
      const skipped = ids.get('mid-day')!
      await pool.query(`CREATE FUNCTION pg_temp_skip_one() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF OLD.id = '${skipped}' THEN RETURN NULL; END IF; RETURN NEW; END $f$`)
      await pool.query(
        `CREATE TRIGGER skip_one BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION pg_temp_skip_one()`,
      )
      try {
        await expect(applyMigration()).rejects.toThrow(
          /counts disagree \(null_before=12, backed_up=12, updated=11, null_after=1\)/,
        )
      } finally {
        await pool.query(`DROP TRIGGER skip_one ON transactions`)
        await pool.query(`DROP FUNCTION pg_temp_skip_one()`)
      }
      // The whole DO block rolled back: no backup table, every NULL still NULL, nothing else moved.
      expect(await nullCount()).toBe(12)
      const reg = await pool.query(`SELECT to_regclass($1) AS r`, [`public.${BACKUP_TABLE}`])
      expect(reg.rows[0].r).toBeNull()
      expect(await snapshotWithoutTxDate()).toEqual(snapshotBefore)
    })

    it('first run backfills every NULL row and reports the counts', async () => {
      const notices = await applyMigration()
      expect(await nullCount()).toBe(0)
      expect(notices.join('\n')).toContain('tx_date kyiv backfill: prior_run=false null_before=12')
      expect(notices.join('\n')).toContain('tx_date kyiv backfill: updated=12 null_after=0')
    })

    it('writes the hand-computed Kyiv-day value for each boundary and DST edge', async () => {
      const dates = await txDates()
      for (const r of NULL_ROWS) {
        expect({ label: r.label, txDate: dates.get(ids.get(r.label)!)?.toISOString() }).toEqual({
          label: r.label,
          txDate: r.expected,
        })
      }
      // 21:30Z 31 Aug = 00:30 1 Sep EEST.
      expect(dates.get(ids.get('pending')!)?.toISOString()).toBe('2026-09-01T00:00:00.000Z')
      expect(dates.get(ids.get('soft-deleted')!)?.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    })

    it('writes the same value resolveTransactionDate would persist for a new row', async () => {
      const dates = await txDates()
      for (const r of NULL_ROWS) {
        const persisted = resolveTransactionDate(null, new Date(r.createdAt))
        expect({ label: r.label, txDate: dates.get(ids.get(r.label)!)?.toISOString() }).toEqual({
          label: r.label,
          txDate: persisted.toISOString(),
        })
      }
    })

    it('keeps every row in the business month the removed created_at fallback gave it', async () => {
      const res = await pool.query<{ id: string; tx_date: Date }>(
        `SELECT id, tx_date FROM transactions WHERE id = ANY($1)`,
        [[...monthsBefore.keys()]],
      )
      expect(res.rows).toHaveLength(12)
      for (const row of res.rows) {
        const after = transactionBusinessMonth({ id: row.id, txDate: row.tx_date })
        expect({ id: row.id, month: after }).toEqual({
          id: row.id,
          month: monthsBefore.get(row.id),
        })
      }
      // The decisive row, by literal: filed in November before and after.
      expect(monthsBefore.get(ids.get('oct-month-boundary')!)).toBe('2026-11')
    })

    it('the graph refused the NULL rows before the backfill and files them by literal after it', async () => {
      // backlog 338: no created_at fallback, so a NULL tx_date fails loud.
      expect(graphBeforeError).toMatch(
        /^transactionBusinessMonth: transaction .+ has a NULL tx_date$/,
      )
      // Hand-computed from NULL_ROWS (amount = index + 1, all PAID) plus the explicit
      // 31 Oct row (10); the PENDING and soft-deleted rows are not in the graph.
      const income = (month: string, amount: number) => ({
        month,
        income: amount,
        expenses: 0,
        salaries: 0,
        profit: amount,
      })
      expect(await graph()).toEqual([
        income('2026-01', 3), // year-boundary
        income('2026-02', 2), // jan-month-boundary-winter
        income('2026-03', 13), // dst-start-after 6 + dst-start-eve 7
        income('2026-05', 9), // summer-midnight-minus-1s
        income('2026-06', 8), // summer-midnight-exact
        income('2026-10', 29), // dst-end-eve 4 + dst-end-after 5 + mid-day 10 + explicit 10
        income('2026-11', 1), // oct-month-boundary
      ])
    })

    it('touches no column other than tx_date, and no row that had a tx_date', async () => {
      expect(await snapshotWithoutTxDate()).toEqual(snapshotBefore)
      expect((await txDates()).get(explicitId)?.toISOString()).toBe('2026-10-31T00:00:00.000Z')
    })

    it('records every backfilled id in the backup table, and only those', async () => {
      const res = await pool.query<{ transaction_id: string; backfilled_tx_date: Date }>(
        `SELECT transaction_id, backfilled_tx_date FROM ${BACKUP_TABLE}`,
      )
      expect(res.rows.map((r) => r.transaction_id).sort()).toEqual([...monthsBefore.keys()].sort())
      expect(res.rows.map((r) => r.transaction_id)).not.toContain(explicitId)
    })

    it('a second run changes 0 rows', async () => {
      const before = await txDates()
      const notices = await applyMigration()
      expect(notices.join('\n')).toContain('tx_date kyiv backfill: prior_run=true null_before=0')
      expect(notices.join('\n')).toContain('tx_date kyiv backfill: updated=0 null_after=0')
      expect(await txDates()).toEqual(before)
      const backup = await pool.query(`SELECT count(*)::int AS n FROM ${BACKUP_TABLE}`)
      expect(backup.rows[0].n).toBe(12)
    })

    it('fails loud, writing nothing, when NULL rows reappear after the one-time run', async () => {
      const strayId = await insertTx({ txDate: null, createdAt: '2026-10-20T10:00:00.000Z' })
      await expect(applyMigration()).rejects.toThrow(
        /tx_date kyiv backfill: 1 row\(s\) with NULL tx_date appeared after the one-time backfill/,
      )
      expect((await txDates()).get(strayId)).toBeNull()
      await pool.query(`DELETE FROM transactions WHERE id = $1`, [strayId])
    })

    it('the documented rollback restores exactly the original NULLs', async () => {
      // The ROLLBACK statement quoted in the migration header, verbatim.
      const rollback = /-- ROLLBACK:\n((?:-- {3}.*\n)+)/.exec(migrationSql)
      expect(rollback, 'migration header must carry the rollback statement').not.toBeNull()
      const statement = rollback![1]!.replace(/^-- {3}/gm, '')
      await pool.query(statement)
      expect(await nullCount()).toBe(12)
      expect((await txDates()).get(explicitId)?.toISOString()).toBe('2026-10-31T00:00:00.000Z')
      expect(await snapshotWithoutTxDate()).toEqual(snapshotBefore)
    })
  },
)
