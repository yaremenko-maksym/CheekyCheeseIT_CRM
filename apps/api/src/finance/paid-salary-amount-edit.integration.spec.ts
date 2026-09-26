import { ForbiddenException, Global, Module } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { drizzle } from 'drizzle-orm/node-postgres'
import { and, eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { PAID_ROW_LOCKED_FIELD_MESSAGES } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { InvoicesService } from '../invoices/invoices.service'
import { invoiceSignatures, transactionAuditLog, transactions, users } from '../database/schema'
import * as schema from '../database/schema'

/**
 * task-paid-salary-amount-edit — the owner's scenario against real Postgres.
 *
 * A salary owed in USD, paid in UAH through `paySalary` (so `original_amount`,
 * `original_currency` and `exchange_rate` are stamped exactly the way production
 * stamps them), then its paid figure is corrected through the SAME two calls the
 * dialog makes: `GET :id/edit-preview` → `PATCH :id/admin-edit` with the token.
 *
 * What only a real database can show: the three columns as STORED (numeric
 * round-trips, the rate untouched to the last of its eight decimals), the
 * journal row, and that the refusals write nothing at all.
 *
 * The invoice side is a spy: the real void+reissue has its own real-DB coverage
 * (`invoice-signature-integrity.integration.spec.ts`); what this task adds is
 * the CALL, asserted here and in `cascade-apply.unit.spec.ts`.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@127.0.0.1:5432/crm_scratch_<name> \
 *     pnpm --filter @crm/api exec vitest run src/finance/paid-salary-amount-edit.integration.spec.ts
 */

const ADMIN: SessionUser = {
  id: 'fa5a1e00-0000-4000-aa00-000000000001',
  email: 'pse-admin@test.spec',
  displayName: 'PSE Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const JUNIOR: SessionUser = {
  ...ADMIN,
  id: 'fa5a1e00-0000-4000-aa00-000000000002',
  email: 'pse-junior@test.spec',
  displayName: 'PSE Junior',
  role: 'JUNIOR',
  seniorSharePercent: 0,
}
const ALL = [ADMIN, JUNIOR]
const TEST_USER_IDS = ALL.map((u) => u.id)

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
class PaidSalaryEditTestModule {}

/** See `salary-paid-amount.integration.spec.ts`: no URL is the ONE legitimate skip. */
const HAS_DB_URL = !!process.env['DATABASE_URL']

describe.skipIf(!HAS_DB_URL)(
  'paid salary amount edit (real DB) — task-paid-salary-amount-edit',
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
          throw new Error('[paid-salary-amount-edit] REFUSING to run against the live crm_db')
        }
        const check = await probe.query(
          `SELECT 1 FROM information_schema.columns
          WHERE table_name='transactions' AND column_name='exchange_rate' LIMIT 1`,
        )
        if (check.rowCount === 0) {
          throw new Error('[paid-salary-amount-edit] schema not migrated (no exchange_rate)')
        }
      } finally {
        await probe.end()
      }

      const moduleRef = await Test.createTestingModule({
        imports: [PaidSalaryEditTestModule],
      }).compile()
      await moduleRef.init()
      svc = moduleRef.get(TransactionsService)
      dbSvc = moduleRef.get(DatabaseService)

      await cleanup()
      await dbSvc.db.delete(users).where(inArray(users.id, TEST_USER_IDS))
      await dbSvc.db
        .insert(users)
        .values(
          ALL.map((u) => ({
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
      invoicesSpy.voidAndReissueInvoiceForAmountEdit.mockClear()
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

    /** 1180 USD owed, 48 675 UAH actually paid ⇒ rate 41.25 (48 675 / 1180). */
    async function paidSalary(): Promise<string> {
      const pending = await svc.createSalary(
        { receiverId: JUNIOR.id, amount: 1180, currency: 'USD', salaryMonth: '2026-08' },
        ADMIN,
      )
      await svc.paySalary(
        pending.id,
        {
          fundingSource: 'ADMIN_PERSONAL',
          payerAdminId: ADMIN.id,
          currency: 'UAH',
          paidAmount: 48_675,
          receiptExternalUrl: 'https://etherscan.io/tx/0xpaidsalaryamountedit',
        },
        ADMIN,
      )
      return pending.id
    }

    function row(id: string) {
      return dbSvc.db.query.transactions.findFirst({ where: eq(transactions.id, id) })
    }

    async function editWithPreview(id: string, amount: number) {
      const preview = await svc.getEditCascadePreview(id, amount, ADMIN)
      await svc.adminUpdateTransaction(id, { amount, cascadeVersion: preview.version! }, ADMIN)
      return preview
    }

    it('the precondition: paySalary stamped the triplet this edit works from', async () => {
      const id = await paidSalary()
      const r = await row(id)
      expect(r).toMatchObject({
        status: 'PAID',
        amount: '48675.000000',
        currency: 'UAH',
        originalAmount: '1180.000000',
        originalCurrency: 'USD',
        exchangeRate: '41.25000000',
      })
    })

    it('stores the new amount and the obligation at the RECORDED rate; the rate itself is untouched', async () => {
      const id = await paidSalary()
      const preview = await editWithPreview(id, 48_867)

      const r = await row(id)
      // 48 867 / 41.25 = 1184.654545… (worked by hand: 41.25 × 1184 = 48 840, 27 / 41.25 = 0.654545…)
      expect(r).toMatchObject({
        amount: '48867.000000',
        originalAmount: '1184.654545',
        originalCurrency: 'USD',
        exchangeRate: '41.25000000',
        currency: 'UAH',
        salaryMonth: '2026-08',
        status: 'PAID',
      })
      // What the preview promised is what the database holds.
      expect(preview.plan?.sourcePaymentFact?.newOriginalAmount).toBe(Number(r!.originalAmount))
      // The invariant `exchangeRate == amount / originalAmount`, at paySalary's own precision.
      const rate = Number(r!.exchangeRate)
      const obligation = Number(r!.originalAmount)
      expect(Math.abs(obligation * rate - Number(r!.amount))).toBeLessThanOrEqual(
        rate * 5e-7 + obligation * 5e-9,
      )
    })

    it('journals old and new for all three fields', async () => {
      const id = await paidSalary()
      await editWithPreview(id, 48_867)

      const journal = await dbSvc.db.query.transactionAuditLog.findMany({
        where: and(
          eq(transactionAuditLog.targetId, id),
          eq(transactionAuditLog.action, 'AMOUNT_OR_RECEIVER_CHANGE'),
        ),
      })
      expect(journal).toHaveLength(1)
      expect(journal[0]!.actorId).toBe(ADMIN.id)
      expect(journal[0]!.metadata).toEqual({
        amount: { before: '48675.000000', after: '48867' },
        paymentFact: {
          originalAmount: { before: '1180', after: '1184.654545' },
          exchangeRate: { before: '41.25000000', after: '41.25000000' },
          recomputed: true,
        },
      })
    })

    it('SR-M-1: a failed re-issue is journalled and reported; a plain re-save then repairs it', async () => {
      const id = await paidSalary()
      invoicesSpy.voidAndReissueInvoiceForAmountEdit.mockResolvedValueOnce('REISSUE_FAILED')
      const preview = await svc.getEditCascadePreview(id, 48_867, ADMIN)
      const saved = await svc.adminUpdateTransaction(
        id,
        { amount: 48_867, cascadeVersion: preview.version! },
        ADMIN,
      )
      expect(saved).toMatchObject({ invoiceReissueIncomplete: 'SELF_REPAIRABLE' })
      const failures = await dbSvc.db.query.transactionAuditLog.findMany({
        where: and(
          eq(transactionAuditLog.targetId, id),
          eq(transactionAuditLog.action, 'INVOICE_REISSUE_FAILED'),
        ),
      })
      expect(failures.map((f) => f.metadata)).toEqual([{ stage: 'REISSUE' }])
      // The amount edit itself stands.
      expect((await row(id))?.amount).toBe('48867.000000')

      invoicesSpy.reissueSalaryInvoiceIfVoided.mockResolvedValueOnce('REISSUED')
      const resaved = await svc.adminUpdateTransaction(id, { notes: 'пересохранение' }, ADMIN)
      expect(invoicesSpy.reissueSalaryInvoiceIfVoided).toHaveBeenCalledWith(id, ADMIN.id)
      expect(resaved).not.toHaveProperty('invoiceReissueIncomplete')
    })

    it('SR-M-3: a failed VOID is journalled with its own stage and the re-save repairs that stage too', async () => {
      const id = await paidSalary()
      invoicesSpy.voidAndReissueInvoiceForAmountEdit.mockResolvedValueOnce('VOID_FAILED')
      const preview = await svc.getEditCascadePreview(id, 48_867, ADMIN)
      const saved = await svc.adminUpdateTransaction(
        id,
        { amount: 48_867, cascadeVersion: preview.version! },
        ADMIN,
      )
      expect(saved).toMatchObject({ invoiceReissueIncomplete: 'SELF_REPAIRABLE' })
      const failures = await dbSvc.db.query.transactionAuditLog.findMany({
        where: and(
          eq(transactionAuditLog.targetId, id),
          eq(transactionAuditLog.action, 'INVOICE_REISSUE_FAILED'),
        ),
      })
      // Its OWN stage — the repair below keys on this line being on record.
      expect(failures.map((f) => f.metadata)).toEqual([{ stage: 'VOID' }])

      invoicesSpy.reissueSalaryInvoiceIfVoided.mockResolvedValueOnce('REISSUED')
      const resaved = await svc.adminUpdateTransaction(id, { notes: 'пересохранение' }, ADMIN)
      expect(invoicesSpy.reissueSalaryInvoiceIfVoided).toHaveBeenCalledWith(id, ADMIN.id)
      expect(resaved).not.toHaveProperty('invoiceReissueIncomplete')
    })

    it('voids and re-issues the invoice for the corrected figure', async () => {
      const id = await paidSalary()
      await editWithPreview(id, 48_867)
      expect(invoicesSpy.voidAndReissueInvoiceForAmountEdit).toHaveBeenCalledTimes(1)
      expect(invoicesSpy.voidAndReissueInvoiceForAmountEdit).toHaveBeenCalledWith(id, ADMIN.id)
    })

    it('no recorded rate (owner decision 2): only the amount moves, and the journal says why', async () => {
      const id = await paidSalary()
      await dbSvc.db.update(transactions).set({ exchangeRate: null }).where(eq(transactions.id, id))

      const preview = await editWithPreview(id, 48_867)
      expect(preview.plan?.sourcePaymentFact).toMatchObject({
        recomputed: false,
        exchangeRate: null,
      })

      const r = await row(id)
      expect(r).toMatchObject({
        amount: '48867.000000',
        originalAmount: '1180.000000',
        exchangeRate: null,
      })
      const journal = await dbSvc.db.query.transactionAuditLog.findMany({
        where: eq(transactionAuditLog.targetId, id),
      })
      expect(journal.map((j) => j.metadata)).toContainEqual(
        expect.objectContaining({
          paymentFact: expect.objectContaining({
            recomputed: false,
            note: 'exchange rate not recorded — obligation not recomputed',
          }),
        }),
      )
      expect(invoicesSpy.voidAndReissueInvoiceForAmountEdit).toHaveBeenCalledWith(id, ADMIN.id)
    })

    it('currency and salary month stay locked — refused, nothing written', async () => {
      const id = await paidSalary()
      const before = await row(id)
      const preview = await svc.getEditCascadePreview(id, 48_867, ADMIN)

      await expect(
        svc.adminUpdateTransaction(
          id,
          { amount: 48_867, currency: 'USD', cascadeVersion: preview.version! },
          ADMIN,
        ),
      ).rejects.toThrow(PAID_ROW_LOCKED_FIELD_MESSAGES.CURRENCY)
      await expect(
        svc.adminUpdateTransaction(
          id,
          { amount: 48_867, salaryMonth: '2026-07', cascadeVersion: preview.version! },
          ADMIN,
        ),
      ).rejects.toThrow(PAID_ROW_LOCKED_FIELD_MESSAGES.SALARY_MONTH)

      expect(await row(id)).toEqual(before)
      expect(invoicesSpy.voidAndReissueInvoiceForAmountEdit).not.toHaveBeenCalled()
    })

    it('an obligation that could not be stored is refused — preview and write agree, nothing written', async () => {
      const id = await paidSalary()
      // A rate that puts 500 000 UAH at 1 000 000 USD — above the transaction ceiling.
      await dbSvc.db
        .update(transactions)
        .set({ exchangeRate: '0.50000000' })
        .where(eq(transactions.id, id))
      const before = await row(id)

      const preview = await svc.getEditCascadePreview(id, 500_000, ADMIN)
      expect(preview).toMatchObject({
        editable: false,
        blockedReason: 'SALARY_OBLIGATION_OUT_OF_RANGE',
      })

      const versionOfUnchanged = (await svc.getEditCascadePreview(id, 48_675.5, ADMIN)).version!
      await expect(
        svc.adminUpdateTransaction(
          id,
          { amount: 500_000, cascadeVersion: versionOfUnchanged },
          ADMIN,
        ),
      ).rejects.toThrow(/outside the allowed range — check the amount/)
      expect(await row(id)).toEqual(before)
    })

    it.each(['SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'] as const)(
      'FM-5: a %s cannot preview or edit a paid salary — 403, nothing written',
      async (role) => {
        const id = await paidSalary()
        const before = await row(id)
        const viewer: SessionUser = { ...ADMIN, role }

        await expect(svc.getEditCascadePreview(id, 48_867, viewer)).rejects.toBeInstanceOf(
          ForbiddenException,
        )
        await expect(
          svc.adminUpdateTransaction(id, { amount: 48_867, cascadeVersion: 'x' }, viewer),
        ).rejects.toBeInstanceOf(ForbiddenException)
        expect(await row(id)).toEqual(before)
      },
    )

    /**
     * SR-M-3, the READ half — against real Postgres.
     *
     * `loadReissueState` decides the repair from three query VALUES a unit double
     * cannot check: `signer_role = 'COUNTERPARTY'` and `voided_at IS NULL`
     * — blank either and a different figure comes back, so each row below
     * carries its own distinguishable amount (mutation-gate-integration-specs.md:
     * only a live DB can tell).
     *
     * The service is built with `Object.create` and a real `db`: this path makes
     * no S3/PDF call, so none of the heavier collaborators are needed.
     */
    describe('loadReissueState against real rows (SR-M-3)', () => {
      function invoicesAgainstRealDb(): {
        loadReissueState: (id: string) => Promise<{
          type: string
          status: string
          payoutRequestId: string | null
          invoiceDocumentId: string | null
          hasVoidedInvoice: boolean
          amount: string
          signedAmountSnapshot: string | null
          activeCompanySignedAt: Date | null
          lastVoidFailureAt: Date | null
        } | null>
      } {
        const svc = Object.create(InvoicesService.prototype) as InvoicesService
        Object.assign(svc, { db: dbSvc })
        return svc as unknown as ReturnType<typeof invoicesAgainstRealDb>
      }

      async function journal(txId: string, action: string, metadata: Record<string, unknown>) {
        await dbSvc.db
          .insert(transactionAuditLog)
          .values({ actorId: ADMIN.id, targetId: txId, action, metadata })
      }

      async function signature(
        txId: string,
        role: 'COMPANY' | 'COUNTERPARTY',
        amountSnapshot: string,
        voidedAt: Date | null,
      ) {
        await dbSvc.db.insert(invoiceSignatures).values({
          transactionId: txId,
          signerRole: role,
          signerId: ADMIN.id,
          voidedAt,
          amountSnapshot,
          pdfHash: 'a'.repeat(64),
          method: role === 'COMPANY' ? 'AUTO_COMPANY' : 'MANUAL_CLICK',
        })
      }

      it('reads the ACTIVE COUNTERPARTY snapshot — not a company one, not a voided one', async () => {
        const id = await paidSalary()
        // Each row carries a DIFFERENT figure, so a wrong filter cannot pass by
        // accident: swap the signer_role for the other one and the COMPANY
        // figure comes back; drop the `voided_at IS NULL` and the retired
        // countersignature does.
        await signature(id, 'COMPANY', '11111.000000', null)
        await signature(id, 'COUNTERPARTY', '22222.000000', new Date())
        await signature(id, 'COUNTERPARTY', '48675.000000', null)

        const state = await invoicesAgainstRealDb().loadReissueState(id)
        expect(state?.signedAmountSnapshot).toBe('48675.000000')
        // The voided row is what `hasVoidedInvoice` reads — a different question.
        expect(state?.hasVoidedInvoice).toBe(true)
      })

      it('a countersignature that was voided leaves nothing confirming a stale figure', async () => {
        const id = await paidSalary()
        await signature(id, 'COUNTERPARTY', '48675.000000', new Date())

        const state = await invoicesAgainstRealDb().loadReissueState(id)
        expect(state?.signedAmountSnapshot).toBeNull()
      })

      it('dates the COMPANY signature, not a countersignature', async () => {
        const id = await paidSalary()
        const companyAt = new Date('2026-09-20T10:00:00.000Z')
        await dbSvc.db.insert(invoiceSignatures).values({
          transactionId: id,
          signerRole: 'COMPANY',
          signerId: ADMIN.id,
          signedAt: companyAt,
          amountSnapshot: null,
          pdfHash: 'a'.repeat(64),
          method: 'AUTO_COMPANY',
        })
        // A LATER countersignature: if the role filter were swapped, this
        // timestamp would come back instead.
        await dbSvc.db.insert(invoiceSignatures).values({
          transactionId: id,
          signerRole: 'COUNTERPARTY',
          signerId: ADMIN.id,
          signedAt: new Date('2026-09-23T10:00:00.000Z'),
          amountSnapshot: '48675.000000',
          pdfHash: 'b'.repeat(64),
          method: 'MANUAL_CLICK',
        })

        const state = await invoicesAgainstRealDb().loadReissueState(id)
        expect(state?.activeCompanySignedAt?.toISOString()).toBe(companyAt.toISOString())
      })

      it('…and ignores a COMPANY signature that was voided (SR-L-8)', async () => {
        const id = await paidSalary()
        await dbSvc.db.insert(invoiceSignatures).values({
          transactionId: id,
          signerRole: 'COMPANY',
          signerId: ADMIN.id,
          signedAt: new Date('2026-09-20T10:00:00.000Z'),
          voidedAt: new Date('2026-09-21T10:00:00.000Z'),
          amountSnapshot: null,
          pdfHash: 'c'.repeat(64),
          method: 'AUTO_COMPANY',
        })

        // A retired signature dates a document that no longer exists — reading
        // it would make every repaired row look stale again.
        const state = await invoicesAgainstRealDb().loadReissueState(id)
        expect(state?.activeCompanySignedAt).toBeNull()
      })

      it('reads a recorded VOID failure', async () => {
        const id = await paidSalary()
        await journal(id, 'INVOICE_REISSUE_FAILED', { stage: 'VOID' })

        const state = await invoicesAgainstRealDb().loadReissueState(id)
        expect(state?.lastVoidFailureAt).toBeInstanceOf(Date)
      })

      it('ignores a VOID failure recorded against ANOTHER transaction (SR-L-8)', async () => {
        const id = await paidSalary()
        // `transaction_audit_log.target_id` carries no FK, so a bare id is a
        // faithful stand-in for «some other row» — and one salary per receiver
        // per month is all the unique index allows anyway.
        await journal('c0ffee00-0000-4000-8a00-000000000001', 'INVOICE_REISSUE_FAILED', {
          stage: 'VOID',
        })

        const state = await invoicesAgainstRealDb().loadReissueState(id)
        expect(state?.lastVoidFailureAt).toBeNull()
      })

      it('ignores a line of another action, even with the same stage', async () => {
        const id = await paidSalary()
        await journal(id, 'AMOUNT_OR_RECEIVER_CHANGE', { stage: 'VOID' })

        const state = await invoicesAgainstRealDb().loadReissueState(id)
        expect(state?.lastVoidFailureAt).toBeNull()
      })

      it('ignores the REISSUE stage — only a failed VOID leaves a live document', async () => {
        const id = await paidSalary()
        await journal(id, 'INVOICE_REISSUE_FAILED', { stage: 'REISSUE' })

        const state = await invoicesAgainstRealDb().loadReissueState(id)
        expect(state?.lastVoidFailureAt).toBeNull()
      })

      it('a row with no signatures at all reports none, and carries its own amount', async () => {
        const id = await paidSalary()
        const state = await invoicesAgainstRealDb().loadReissueState(id)
        expect(state?.signedAmountSnapshot).toBeNull()
        expect(state?.amount).toBe('48675.000000')
      })
    })
  },
)
