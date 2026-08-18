/**
 * Real-DB regression spec for security-review PR #456 round 2, MED-1:
 * "У фиксов HIGH-1 и HIGH-2 нет ни одного регрессионного теста."
 *
 * HIGH-1 (invoices) and HIGH-2 (company-account deposits) were fixed as part
 * of the round-1 response and re-verified structurally in round 2 (view +
 * fused fetch/guard helpers), but neither module had a DEDICATED regression
 * test proving the fix against a REAL soft-deleted row through the REAL
 * service methods. This file is that proof — real Postgres, real
 * `InvoicesService` / `CompanyAccountService`, a row soft-deleted via the
 * real `TransactionsService.adminDeleteTransaction` (not hand-inserted with
 * `deletedAt` pre-set, so the whole write path is exercised too).
 *
 * WHAT it covers:
 *   HIGH-1 — `InvoicesService`:
 *     - `getInvoice`: counterparty → 404 after delete; ADMIN → still 200.
 *     - `listInvoices`: the deleted row is absent for BOTH the counterparty
 *       AND ADMIN (no `includeDeleted` toggle on this list — see the
 *       `listInvoices` comment in invoices.service.ts for why).
 *     - `signInvoice`: counterparty → 404 (not 200-signs-it), and the guard
 *       fires BEFORE any PDF/S3/notification work (those collaborators are
 *       spies that must never be called).
 *     - `verifyInvoice` (public, no auth): a previously-signed invoice on a
 *       now-deleted transaction is no longer publicly verifiable.
 *   HIGH-2 — `CompanyAccountService.getDepositStatus`:
 *     - owner → 404 after delete (was 200 before the fix).
 *     - ADMIN → still 200, with the deposit's last-known PENDING status (not
 *       the round-1 regression where this MED had a 400 write-gate slapped
 *       on a read endpoint). Etherscan is a scripted fake that never confirms
 *       the seeded hash, so the deposit provably stays PENDING across every
 *       poll in this file — the assertion is about the soft-delete guard,
 *       not a race with the (keyless, auto-confirming) default fake.
 *
 * security-review PR #456 round 3, MED-2 — `fetchWritableTransactionOrThrow`'s
 * write-half (`assertTransactionNotDeleted`) had ZERO coverage: the reviewer
 * removed that one line and all 2019 unit + 1019 integration tests stayed
 * green, meaning the line was deletable and nothing would notice. Closed by
 * the `signInvoice — privileged counterparty` test below: a viewer who passes
 * the READ gate on a deleted row (ADMIN/ACCOUNTANT bypass) must still be
 * blocked from SIGNING it — 400, not "signs it anyway". This is the exact
 * scenario `assertTransactionNotDeleted` exists for; a privileged
 * non-counterparty or a non-privileged counterparty never reach it (they 404
 * earlier), so this is the ONLY test that can exercise this specific line.
 *
 * DB-SKIP-GUARD:
 *   describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is unset (reports
 *   SKIPPED). A DATABASE_URL that IS set but unusable throws in beforeAll
 *   (reports FAILED). Neither case can look like "passed" with zero assertions.
 *
 * SEED strategy: UUID namespace ad200000-* — distinct from other specs.
 *
 * Run against a scratch DB (NEVER the live crm_db):
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/crm_qa \
 *     pnpm --filter @crm/api exec vitest run soft-delete-cross-module-visibility.integration.spec
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { inArray } from 'drizzle-orm'
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import { companyAccount, documents, transactions, users } from '../database/schema'
import * as schema from '../database/schema'
import type { TransactionsService } from './transactions.service'
import { CompanyAccountService } from './company-account.service'
import type { DepositVerification, EtherscanService } from './etherscan.service'
import { withDerivedMinorUnits, type ScriptedVerification } from './__test-helpers__/etherscan-fake'
import { InvoicesService } from '../invoices/invoices.service'
import { hasDatabaseUrl } from '../test/require-real-db'

const ADMIN_1: SessionUser = {
  id: 'ad200000-0000-4000-aa00-000000000001',
  email: 'xm-admin@test.spec',
  displayName: 'XM Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const SENIOR_1: SessionUser = {
  id: 'ad200000-0000-4000-aa00-000000000002',
  email: 'xm-senior@test.spec',
  displayName: 'XM Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const JUNIOR_STRANGER: SessionUser = {
  id: 'ad200000-0000-4000-aa00-000000000003',
  email: 'xm-junior@test.spec',
  displayName: 'XM Junior',
  avatarUrl: null,
  role: 'JUNIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
// security-review PR #456 round 3, MED-2: needs to be BOTH privileged (passes
// the assertTransactionVisible READ gate on a deleted row) AND the
// transaction's own counterparty (passes signInvoice's RBAC check) — the only
// persona shape that can reach `fetchWritableTransactionOrThrow`'s write-half.
const ACCOUNTANT_1: SessionUser = {
  id: 'ad200000-0000-4000-aa00-000000000004',
  email: 'xm-accountant@test.spec',
  displayName: 'XM Accountant',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 0,
  legalFullName: null,
}

const ALL_USER_IDS = [ADMIN_1, SENIOR_1, JUNIOR_STRANGER, ACCOUNTANT_1].map((u) => u.id)
const SENIOR_INCOME_TX_ID = 'ad200001-0000-4000-b000-000000000001'
const DEPOSIT_TX_ID = 'ad200001-0000-4000-b000-000000000002'
const PRIVILEGED_SALARY_TX_ID = 'ad200001-0000-4000-b000-000000000003'
const INVOICE_DOC_ID = 'ad200003-0000-4000-d000-000000000001'
const PRIVILEGED_SALARY_DOC_ID = 'ad200003-0000-4000-d000-000000000002'
const ACCOUNT_ID = 'ad200002-0000-4000-c000-000000000001'
const WALLET = '0xad20000000000000000000000000000000ad20'
const DEPOSIT_HASH = '0x' + 'a'.repeat(64)

// Scripted Etherscan fake (mirrors company-account.deposit.integration.spec.ts):
// no entry for DEPOSIT_HASH → `withDerivedMinorUnits(undefined)` → "not found,
// not confirmed" — the deposit provably stays PENDING across every poll,
// unlike the keyless default EtherscanService (auto-confirms everything,
// which would flip the seeded deposit to PAID before the delete/visibility
// assertions below even run).
const verifyScript = new Map<string, ScriptedVerification>()
const fakeEtherscan: Pick<EtherscanService, 'verifyDeposit'> = {
  verifyDeposit: (txHash: string): Promise<DepositVerification> =>
    Promise.resolve(withDerivedMinorUnits(verifyScript.get(txHash))),
}

let _pool: Pool | null = null
let txSvc: TransactionsService
let dbSvc: DatabaseService

describe.skipIf(!hasDatabaseUrl())(
  'security-review PR #456 round 2 (MED-1) — cross-module visibility regression (real-DB)',
  () => {
    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        await probe.end()
      } catch {
        throw new Error(
          '[soft-delete-cross-module-visibility] FAILED — no DB reachable at DATABASE_URL (expected in CI unit job)',
        )
      }

      _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const db = drizzle(_pool, { schema })

      dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(dbSvc, { pool: _pool, db })
      txSvc = makeTransactionsService({ db: dbSvc })

      // Surgical cleanup of leftover rows from a previous failed run.
      await db
        .delete(transactions)
        .where(
          inArray(transactions.id, [SENIOR_INCOME_TX_ID, DEPOSIT_TX_ID, PRIVILEGED_SALARY_TX_ID]),
        )
      await db
        .delete(documents)
        .where(inArray(documents.id, [INVOICE_DOC_ID, PRIVILEGED_SALARY_DOC_ID]))
      await db.delete(users).where(inArray(users.id, ALL_USER_IDS))

      for (const u of [ADMIN_1, SENIOR_1, JUNIOR_STRANGER, ACCOUNTANT_1]) {
        await db.insert(users).values({
          id: u.id,
          email: u.email,
          displayName: u.displayName,
          role: u.role,
          seniorSharePercent: 26,
        })
      }

      // A real `documents` row (INVOICE category) so the FK on
      // `transactions.invoice_document_id` resolves — `getInvoice`/
      // `verifyInvoice` both gate on this column being non-null.
      await db.insert(documents).values({
        id: INVOICE_DOC_ID,
        ownerId: SENIOR_1.id,
        category: 'INVOICE',
        name: 'invoice-ad200001.pdf',
        s3Key: `documents/invoice/${SENIOR_INCOME_TX_ID}.pdf`,
        sizeBytes: 1024,
        mimeType: 'application/pdf',
        uploadedBy: ADMIN_1.id,
      })
      await db.insert(documents).values({
        id: PRIVILEGED_SALARY_DOC_ID,
        ownerId: ACCOUNTANT_1.id,
        category: 'INVOICE',
        name: 'invoice-ad200001-salary.pdf',
        s3Key: `documents/invoice/${PRIVILEGED_SALARY_TX_ID}.pdf`,
        sizeBytes: 1024,
        mimeType: 'application/pdf',
        uploadedBy: ADMIN_1.id,
      })

      // security-review PR #456 round 3, MED-2: a SALARY row whose RECEIVER
      // (=counterparty, per `getCounterpartyId`) is ACCOUNTANT_1 — i.e. an
      // ACCOUNTANT signing their OWN salary invoice. PAYOUT can't be used for
      // this (`adminDeleteTransaction` refuses to delete PAYOUT/PAYOUT_ADMIN/
      // PAYOUT_CONFIRMED rows outright), so SALARY is the only type reachable
      // through the real delete path where a privileged viewer is also the
      // counterparty.
      await db.insert(transactions).values({
        id: PRIVILEGED_SALARY_TX_ID,
        type: 'SALARY',
        status: 'PAID',
        amount: '1000',
        currency: 'USD',
        receiverId: ACCOUNTANT_1.id,
        invoiceDocumentId: PRIVILEGED_SALARY_DOC_ID,
        salaryMonth: '2026-08',
        createdBy: ADMIN_1.id,
      })

      // A PAID SENIOR_INCOME with an invoice already generated (auto-create
      // normally does this; hand-seeding the FK is equivalent for this spec's
      // purpose — the point under test is the READ path after deletion, not
      // the generation trigger, which has its own coverage elsewhere).
      await db.insert(transactions).values({
        id: SENIOR_INCOME_TX_ID,
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '500',
        currency: 'USDT',
        senderLabel: 'Client Co',
        receiverId: SENIOR_1.id,
        invoiceDocumentId: INVOICE_DOC_ID,
        createdBy: ADMIN_1.id,
      })

      // A PENDING COMPANY_DEPOSIT owned by SENIOR_1. `txHash` is deliberately
      // NOT in `verifyScript` — every `getDepositStatus` poll in this file
      // resolves it as "not found / not confirmed", so it never auto-flips to
      // PAID out from under the soft-delete assertions.
      await db.insert(transactions).values({
        id: DEPOSIT_TX_ID,
        type: 'COMPANY_DEPOSIT',
        status: 'PENDING',
        amount: '0',
        currency: 'USDT',
        senderId: SENIOR_1.id,
        senderLabel: SENIOR_1.displayName,
        txHash: DEPOSIT_HASH,
        createdBy: SENIOR_1.id,
      })

      const existingAccount = await db.query.companyAccount.findFirst()
      if (existingAccount) {
        await db
          .update(companyAccount)
          .set({ walletAddress: WALLET })
          .where(inArray(companyAccount.id, [existingAccount.id]))
      } else {
        await db.insert(companyAccount).values({
          id: ACCOUNT_ID,
          walletAddress: WALLET,
          confirmationThreshold: 12,
          updatedBy: ADMIN_1.id,
        })
      }
    }, 30_000)

    afterAll(async () => {
      if (!_pool)
        throw new Error(
          '[require-real-db] _pool not initialized — beforeAll should have thrown already',
        )
      const db = drizzle(_pool, { schema })
      await db
        .delete(transactions)
        .where(
          inArray(transactions.id, [SENIOR_INCOME_TX_ID, DEPOSIT_TX_ID, PRIVILEGED_SALARY_TX_ID]),
        )
        .catch(() => undefined)
      await db
        .delete(documents)
        .where(inArray(documents.id, [INVOICE_DOC_ID, PRIVILEGED_SALARY_DOC_ID]))
        .catch(() => undefined)
      await db
        .delete(users)
        .where(inArray(users.id, ALL_USER_IDS))
        .catch(() => undefined)
      await _pool.end()
    }, 15_000)

    // ── HIGH-1: InvoicesService ────────────────────────────────────────────────

    describe('HIGH-1 — InvoicesService, real deleted-transaction proof', () => {
      // Collaborators getInvoice/listInvoices/verifyInvoice never touch; for
      // signInvoice's guard-fires-first assertion these are spies that must
      // stay uncalled.
      const pdfService = { generateSignableInvoicePdf: vi.fn() }
      const documentsService = { uploadInternal: vi.fn(), findByIdInternal: vi.fn() }
      const s3 = { getObject: vi.fn() }
      const notificationsService = { create: vi.fn() }
      const config = { get: () => 'https://app.test' }

      function makeInvoicesSvc(): InvoicesService {
        return new InvoicesService(
          dbSvc,
          pdfService as never,
          documentsService as never,
          s3 as never,
          notificationsService as never,
          config as never,
        )
      }

      it('getInvoice + listInvoices see the invoice while active', async () => {
        const svc = makeInvoicesSvc()
        const invoice = await svc.getInvoice(SENIOR_1, SENIOR_INCOME_TX_ID)
        expect(invoice.transactionId).toBe(SENIOR_INCOME_TX_ID)

        const list = await svc.listInvoices(SENIOR_1, {})
        expect(list.find((i) => i.transactionId === SENIOR_INCOME_TX_ID)).toBeDefined()
      })

      it('after adminDeleteTransaction: counterparty gets 404 from getInvoice; ADMIN still gets 200', async () => {
        await txSvc.adminDeleteTransaction(SENIOR_INCOME_TX_ID, 'HIGH-1 regression proof', ADMIN_1)

        const svc = makeInvoicesSvc()
        await expect(svc.getInvoice(SENIOR_1, SENIOR_INCOME_TX_ID)).rejects.toThrow(
          NotFoundException,
        )
        const adminView = await svc.getInvoice(ADMIN_1, SENIOR_INCOME_TX_ID)
        expect(adminView.transactionId).toBe(SENIOR_INCOME_TX_ID)
      })

      it('listInvoices excludes the deleted row for BOTH the counterparty and ADMIN', async () => {
        const svc = makeInvoicesSvc()
        const seniorList = await svc.listInvoices(SENIOR_1, {})
        expect(seniorList.find((i) => i.transactionId === SENIOR_INCOME_TX_ID)).toBeUndefined()
        const adminList = await svc.listInvoices(ADMIN_1, {})
        expect(adminList.find((i) => i.transactionId === SENIOR_INCOME_TX_ID)).toBeUndefined()
      })

      it('signInvoice: counterparty gets 404, and the guard fires BEFORE any PDF/S3/notification work', async () => {
        pdfService.generateSignableInvoicePdf.mockClear()
        documentsService.uploadInternal.mockClear()
        s3.getObject.mockClear()
        notificationsService.create.mockClear()

        const svc = makeInvoicesSvc()
        const fakeReq = { ip: '1.2.3.4', headers: {} } as never
        await expect(svc.signInvoice(SENIOR_1, SENIOR_INCOME_TX_ID, fakeReq)).rejects.toThrow(
          NotFoundException,
        )
        expect(pdfService.generateSignableInvoicePdf).not.toHaveBeenCalled()
        expect(documentsService.uploadInternal).not.toHaveBeenCalled()
        expect(s3.getObject).not.toHaveBeenCalled()
        expect(notificationsService.create).not.toHaveBeenCalled()
      })

      it('signInvoice — privileged counterparty (ACCOUNTANT signing their own deleted SALARY) gets 400, not a silent sign', async () => {
        // ACCOUNTANT passes assertTransactionVisible's privileged-viewer bypass
        // (sees the deleted row) AND is the row's own counterparty (passes the
        // RBAC check) — the ONLY persona shape that reaches
        // fetchWritableTransactionOrThrow's assertTransactionNotDeleted call.
        // A non-privileged counterparty 404s earlier (visibility gate); a
        // privileged non-counterparty 403s earlier (RBAC check) — neither can
        // exercise this specific line.
        await txSvc.adminDeleteTransaction(
          PRIVILEGED_SALARY_TX_ID,
          'MED-2 regression proof — privileged counterparty write-gate',
          ADMIN_1,
        )

        pdfService.generateSignableInvoicePdf.mockClear()
        documentsService.uploadInternal.mockClear()
        s3.getObject.mockClear()
        notificationsService.create.mockClear()

        const svc = makeInvoicesSvc()
        const fakeReq = { ip: '1.2.3.4', headers: {} } as never
        await expect(
          svc.signInvoice(ACCOUNTANT_1, PRIVILEGED_SALARY_TX_ID, fakeReq),
        ).rejects.toThrow(BadRequestException)
        expect(pdfService.generateSignableInvoicePdf).not.toHaveBeenCalled()
        expect(documentsService.uploadInternal).not.toHaveBeenCalled()
        expect(s3.getObject).not.toHaveBeenCalled()
        expect(notificationsService.create).not.toHaveBeenCalled()
      })

      it('restore, sign for real, delete again → verifyInvoice (public) 404s a previously-signed invoice', async () => {
        await txSvc.restoreTransaction(SENIOR_INCOME_TX_ID, 'restore to sign', ADMIN_1)

        // Manually insert a COUNTERPARTY signature row to simulate "already
        // signed" without exercising the full sign pipeline (which needs a
        // real S3 object) — verifyInvoice only reads `invoice_signatures`.
        const db = drizzle(_pool!, { schema })
        await db.insert(schema.invoiceSignatures).values({
          id: 'ad200004-0000-4000-e000-000000000001',
          transactionId: SENIOR_INCOME_TX_ID,
          signerRole: 'COUNTERPARTY',
          signerId: SENIOR_1.id,
          pdfHash: 'deadbeef'.repeat(8),
          method: 'MANUAL_CLICK',
        })

        const svc = makeInvoicesSvc()
        const verified = await svc.verifyInvoice(SENIOR_INCOME_TX_ID)
        expect(verified.transactionId).toBe(SENIOR_INCOME_TX_ID)

        await txSvc.adminDeleteTransaction(SENIOR_INCOME_TX_ID, 'HIGH-1 verify regression', ADMIN_1)
        await expect(svc.verifyInvoice(SENIOR_INCOME_TX_ID)).rejects.toThrow(NotFoundException)

        await db
          .delete(schema.invoiceSignatures)
          .where(inArray(schema.invoiceSignatures.transactionId, [SENIOR_INCOME_TX_ID]))
          .catch(() => undefined)
      })
    })

    // ── HIGH-2: CompanyAccountService.getDepositStatus ─────────────────────────

    describe('HIGH-2 — CompanyAccountService.getDepositStatus, real deleted-transaction proof', () => {
      function makeCompanyAccountSvc(): CompanyAccountService {
        return new CompanyAccountService(dbSvc, fakeEtherscan as EtherscanService)
      }

      it('a non-owner, non-privileged stranger gets 403 while the row is active (RBAC sanity check)', async () => {
        const svc = makeCompanyAccountSvc()
        await expect(svc.getDepositStatus(DEPOSIT_TX_ID, JUNIOR_STRANGER)).rejects.toThrow(
          ForbiddenException,
        )
      })

      it('owner sees the still-PENDING deposit while active (scripted Etherscan never confirms it)', async () => {
        const svc = makeCompanyAccountSvc()
        const status = await svc.getDepositStatus(DEPOSIT_TX_ID, SENIOR_1)
        expect(status.status).toBe('PENDING')
      })

      it('after adminDeleteTransaction: owner gets 404 (was a normal 200 before HIGH-2 was fixed)', async () => {
        await txSvc.adminDeleteTransaction(DEPOSIT_TX_ID, 'HIGH-2 regression proof', ADMIN_1)

        const svc = makeCompanyAccountSvc()
        await expect(svc.getDepositStatus(DEPOSIT_TX_ID, SENIOR_1)).rejects.toThrow(
          NotFoundException,
        )
      })

      it('ADMIN still gets a real PENDING status back — NOT a 400 (the MED this round fixed)', async () => {
        const svc = makeCompanyAccountSvc()
        const status = await svc.getDepositStatus(DEPOSIT_TX_ID, ADMIN_1)
        expect(status.status).toBe('PENDING')
        expect(status.confirmations).toBe(0)
      })
    })
  },
)
