import { Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { transactionAuditLog, transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * PR #1213 (SPEC-M-1 / AC4) — the ADMIN business-date edit against real Postgres.
 *
 * What only a real database can show: `tx_date` as STORED, the two journal rows
 * committed (or rolled back) in the SAME transaction as the UPDATE, and that every
 * refusal leaves both the row and the journal untouched.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@127.0.0.1:5432/crm_scratch_<name> \
 *     pnpm --filter @crm/api exec vitest run src/finance/admin-edit-tx-date.integration.spec.ts
 */

const ADMIN: SessionUser = {
  id: 'fa5a1e00-0000-4000-bb00-000000000001',
  email: 'txd-admin@test.spec',
  displayName: 'TXD Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const SENIOR: SessionUser = {
  ...ADMIN,
  id: 'fa5a1e00-0000-4000-bb00-000000000002',
  email: 'txd-senior@test.spec',
  displayName: 'TXD Senior',
  role: 'SENIOR',
}
const HR: SessionUser = {
  ...ADMIN,
  id: 'fa5a1e00-0000-4000-bb00-000000000003',
  email: 'txd-hr@test.spec',
  displayName: 'TXD HR',
  role: 'HR',
  seniorSharePercent: 0,
}
/** Not a row in `users`: the journal's actor FK refuses it, which forces a mid-transaction failure. */
const GHOST_ADMIN: SessionUser = {
  ...ADMIN,
  id: 'fa5a1e00-0000-4000-bb00-0000000000ff',
  email: 'txd-ghost@test.spec',
}
const PERSISTED = [ADMIN, SENIOR, HR]
const TEST_USER_IDS = [...PERSISTED, GHOST_ADMIN].map((u) => u.id)

const invoicesSpy = {
  autoCreateForPayout: vi.fn(() => Promise.resolve()),
  autoCreateForIncome: vi.fn(() => Promise.resolve()),
  autoCreateForSeniorPayout: vi.fn(() => Promise.resolve()),
  autoCreateForSalary: vi.fn(() => Promise.resolve()),
  voidAndReissueInvoiceForAmountEdit: vi.fn(() => Promise.resolve('REISSUED')),
  reissueSalaryInvoiceIfVoided: vi.fn(() => Promise.resolve('NOT_NEEDED')),
  canRepairSalaryInvoice: vi.fn(() => Promise.resolve(true)),
}

let _pool: Pool | null = null

@Global()
@Module({
  providers: [
    {
      provide: DatabaseService,
      useFactory: (): DatabaseService => {
        _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
        const db = drizzle(_pool, { schema })
        const instance = Object.create(DatabaseService.prototype) as DatabaseService
        Object.assign(instance, { pool: _pool, db })
        Object.defineProperty(instance, 'onModuleInit', {
          value: () => Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        Object.defineProperty(instance, 'onModuleDestroy', {
          value: () => _pool?.end() ?? Promise.resolve(),
          writable: false,
          enumerable: false,
          configurable: true,
        })
        return instance
      },
    },
  ],
  exports: [DatabaseService],
})
class TestDatabaseModule {}

@Module({
  imports: [TestDatabaseModule],
  providers: [
    {
      provide: TransactionsService,
      useFactory: (db: DatabaseService) =>
        makeTransactionsService({ db, invoicesService: invoicesSpy as never }),
      inject: [DatabaseService],
    },
  ],
})
class TxDateEditTestModule {}

const HAS_DB_URL = !!process.env['DATABASE_URL']

/** `YYYY-MM-DD` of the UTC day `n` days ago (rows are stored at 12:00 UTC, the same Kyiv day). */
function dayAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
}
function noonUtc(day: string): Date {
  return new Date(`${day}T12:00:00.000Z`)
}

const STORED_DAY = dayAgo(10)
const IN_WINDOW_DAY = dayAgo(20)
const OUT_OF_WINDOW_DAY = dayAgo(60)
const TX_HASH = `0x${'ab'.repeat(32)}`

describe.skipIf(!HAS_DB_URL)(
  'admin edit of a transaction business date (real DB) — PR #1213',
  () => {
    let svc: TransactionsService
    let dbSvc: DatabaseService

    async function cleanup() {
      const db = dbSvc.db
      const rows = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(inArray(transactions.createdBy, TEST_USER_IDS))
      const ids = rows.map((r) => r.id)
      if (ids.length > 0) {
        await db.delete(transactionAuditLog).where(inArray(transactionAuditLog.targetId, ids))
      }
      await db.delete(transactions).where(inArray(transactions.createdBy, TEST_USER_IDS))
    }

    beforeAll(async () => {
      const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
      try {
        const which = await probe.query('SELECT current_database() AS db')
        if (which.rows[0]?.db === 'crm_db') {
          throw new Error('[admin-edit-tx-date] REFUSING to run against the live crm_db')
        }
      } finally {
        await probe.end()
      }

      const moduleRef = await Test.createTestingModule({
        imports: [TxDateEditTestModule],
      }).compile()
      await moduleRef.init()
      svc = moduleRef.get(TransactionsService)
      dbSvc = moduleRef.get(DatabaseService)

      await cleanup()
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
      await dbSvc.db
        .insert(users)
        .values(
          PERSISTED.map((u) => ({
            id: u.id,
            email: u.email,
            displayName: u.displayName,
            role: u.role,
            googleId: `test-google-${u.id}`,
          })),
        )
        .onConflictDoNothing()
    }, 30_000)

    beforeEach(async () => {
      await cleanup()
    })

    afterAll(async () => {
      try {
        await cleanup()
        await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
      } catch {
        // non-fatal
      }
      await _pool?.end()
    }, 15_000)

    async function seedExpense(
      over: Partial<typeof transactions.$inferInsert> = {},
    ): Promise<string> {
      const [r] = await dbSvc.db
        .insert(transactions)
        .values({
          type: 'EXPENSE',
          status: 'PAID',
          amount: '100.000000',
          currency: 'USD',
          txDate: noonUtc(STORED_DAY),
          createdBy: ADMIN.id,
          ...over,
        })
        .returning({ id: transactions.id })
      return r!.id
    }

    const row = (id: string) =>
      dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, id) })
    const journal = (id: string, action: string) =>
      dbSvc.db.query.transactionAuditLog.findMany({
        where: and(eq(transactionAuditLog.targetId, id), eq(transactionAuditLog.action, action)),
      })
    const allJournal = (id: string) =>
      dbSvc.db.query.transactionAuditLog.findMany({ where: eq(transactionAuditLog.targetId, id) })
    const storedDay = async (id: string) => (await row(id))!.txDate!.toISOString().slice(0, 10)

    it('non-ADMIN roles get 403 and the row and journal are untouched', async () => {
      const id = await seedExpense()
      for (const who of [SENIOR, HR]) {
        await expect(
          svc.adminUpdateTransaction(id, { txDate: IN_WINDOW_DAY }, who),
        ).rejects.toMatchObject({ status: 403 })
      }
      expect(await storedDay(id)).toBe(STORED_DAY)
      expect(await allJournal(id)).toHaveLength(0)
    })

    it('ADMIN moves the date of a PAID row inside the window: only tx_date changes, one AMOUNT_OR_RECEIVER_CHANGE row with before/after, no backdate row', async () => {
      const id = await seedExpense()
      const before = (await row(id))!

      await svc.adminUpdateTransaction(id, { txDate: IN_WINDOW_DAY }, ADMIN)

      const after = (await row(id))!
      expect(after.txDate!.toISOString().slice(0, 10)).toBe(IN_WINDOW_DAY)
      expect(after).toMatchObject({
        status: 'PAID',
        amount: before.amount,
        currency: before.currency,
        txHash: null,
        settledAmount: null,
      })
      const changes = await journal(id, 'AMOUNT_OR_RECEIVER_CHANGE')
      expect(changes).toHaveLength(1)
      expect(changes[0]!.actorId).toBe(ADMIN.id)
      expect(changes[0]!.metadata).toEqual({ txDate: { before: STORED_DAY, after: IN_WINDOW_DAY } })
      expect(await journal(id, 'TX_DATE_BACKDATED')).toHaveLength(0)
    })

    it('re-sending the stored day is not a change: nothing is journalled', async () => {
      const id = await seedExpense()
      await svc.adminUpdateTransaction(id, { txDate: STORED_DAY, notes: 'notes only' }, ADMIN)
      expect(await storedDay(id)).toBe(STORED_DAY)
      expect(await allJournal(id)).toHaveLength(0)
    })

    it('beyond 31 days without a reason is refused with the edit-screen code; nothing is written', async () => {
      const id = await seedExpense()
      await expect(
        svc.adminUpdateTransaction(id, { txDate: OUT_OF_WINDOW_DAY }, ADMIN),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'FINANCE_TX_DATE_EDIT_REASON_REQUIRED' }),
      })
      expect(await storedDay(id)).toBe(STORED_DAY)
      expect(await allJournal(id)).toHaveLength(0)
    })

    it('beyond 31 days WITH a reason: tx_date moves and both journal rows are committed together', async () => {
      const id = await seedExpense()
      await svc.adminUpdateTransaction(
        id,
        { txDate: OUT_OF_WINDOW_DAY, backdateReason: 'late receipt from the vendor' },
        ADMIN,
      )
      expect(await storedDay(id)).toBe(OUT_OF_WINDOW_DAY)
      const changes = await journal(id, 'AMOUNT_OR_RECEIVER_CHANGE')
      expect(changes.map((c) => c.metadata)).toEqual([
        { txDate: { before: STORED_DAY, after: OUT_OF_WINDOW_DAY } },
      ])
      const backdated = await journal(id, 'TX_DATE_BACKDATED')
      expect(backdated).toHaveLength(1)
      expect(backdated[0]!.actorId).toBe(ADMIN.id)
      expect(backdated[0]!.metadata).toEqual({
        txDate: OUT_OF_WINDOW_DAY,
        backdateReason: 'late receipt from the vendor',
      })
    })

    it('atomicity: when a journal insert fails inside the transaction the UPDATE rolls back too', async () => {
      const id = await seedExpense()
      // GHOST_ADMIN is not in `users`: the journal's actor FK rejects the audit row
      // AFTER the UPDATE has run, so the row only stays unmoved if both share one transaction.
      await expect(
        svc.adminUpdateTransaction(id, { txDate: IN_WINDOW_DAY }, GHOST_ADMIN),
      ).rejects.toThrow()
      expect(await storedDay(id)).toBe(STORED_DAY)
      expect(await allJournal(id)).toHaveLength(0)
    })

    describe('locked rows refuse the date change with FINANCE_TX_DATE_LOCKED_ROW and write nothing', () => {
      const cases: Array<[string, Partial<typeof transactions.$inferInsert>]> = [
        ['a row with a claimed tx_hash', { txHash: TX_HASH }],
        ['a COMPANY_ACCOUNT-funded row', { fundingSource: 'COMPANY_ACCOUNT' }],
        ['a row that already has settlements', { settledAmount: '40.000000' }],
      ]
      it.each(cases)('%s', async (_name, over) => {
        const id = await seedExpense(over)
        await expect(
          svc.adminUpdateTransaction(id, { txDate: IN_WINDOW_DAY }, ADMIN),
        ).rejects.toMatchObject({
          response: expect.objectContaining({ code: 'FINANCE_TX_DATE_LOCKED_ROW' }),
        })
        expect(await storedDay(id)).toBe(STORED_DAY)
        expect(await allJournal(id)).toHaveLength(0)
      })

      it('a metadata-only edit of a locked row still succeeds (the lock is date-only)', async () => {
        const id = await seedExpense({ txHash: TX_HASH })
        await svc.adminUpdateTransaction(id, { txDate: STORED_DAY, notes: 'still editable' }, ADMIN)
        expect((await row(id))!.notes).toBe('still editable')
        expect(await storedDay(id)).toBe(STORED_DAY)
      })
    })

    it('a request that claims a tx_hash AND moves the date is refused as locked; neither lands', async () => {
      // Only a COMPANY_ACCOUNT ADMIN_INCOME row consumes a transfer, so only it can claim a
      // hash; its stored funding source trips the same code first, so this pins the combined
      // outcome (refused, neither the claim nor the date lands) rather than which guard fired.
      const id = await seedExpense({
        type: 'ADMIN_INCOME',
        receiverId: ADMIN.id,
        fundingSource: 'COMPANY_ACCOUNT',
      })
      await expect(
        svc.adminUpdateTransaction(
          id,
          { txDate: IN_WINDOW_DAY, receiptExternalUrl: `https://etherscan.io/tx/${TX_HASH}` },
          ADMIN,
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'FINANCE_TX_DATE_LOCKED_ROW' }),
      })
      const after = (await row(id))!
      expect(after.txHash).toBeNull()
      expect(after.receiptExternalUrl).toBeNull()
      expect(await storedDay(id)).toBe(STORED_DAY)
      expect(await allJournal(id)).toHaveLength(0)
    })
  },
)
