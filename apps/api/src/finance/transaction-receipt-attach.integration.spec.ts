/**
 * task-receipts-backend — generic attach/replace endpoint, real-DB integration.
 *
 * WHY (feedback_mocked_e2e_guards): the RBAC / status matrix, the currency-aware
 * USDT explorer gate, the 1:1 replace-with-delete, and the transaction_audit_log
 * write all commit against a REAL PostgreSQL — unit stubs cannot prove the
 * atomic swap + audit row + old-doc delete.
 *
 * COVERS (task AC):
 *   - RBAC: foreign author → 403; author attach own → ok; author replace after
 *     PAID → 403; ADMIN/ACCOUNTANT replace after PAID → ok.
 *   - Currency-aware: USDT tx attach file → 400; explorer url → ok; non-USDT tx
 *     attach file → ok.
 *   - audit-log: attach → action=ATTACH; replace → action=REPLACE (old/new in metadata).
 *   - replace file receipt → old documents row deleted (1:1) + S3 delete spy fired.
 *   - regression: a receiptless (legacy / systemic) row inserts + reads fine;
 *     a mandatory create path (declareUsdtProjectIncome) without a receipt → 400.
 *
 * DB-SKIP-GUARD: describe.skipIf(!hasDatabaseUrl()) when DATABASE_URL is
 * unset (reports SKIPPED, CI unit job). A DATABASE_URL that IS set but
 * unreachable throws in beforeAll (reports FAILED) — neither case can look
 * like "passed" with zero assertions.
 * S3: replaced with a spy-stub (no real MinIO).
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { TransactionsService } from './transactions.service'
import { DocumentsService } from '../documents/documents.service'
import { S3Service } from '../documents/s3.service'
import { CompressionService } from '../documents/compression.service'
import type { HrAccessService } from '../common/hr-access.service'
import { documents, transactions, transactionAuditLog } from '../database/schema'
import * as schema from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'

// ── Users (seed ids, mirror receipt-replace.integration.spec.ts) ─────────────

const ADMIN: SessionUser = {
  id: 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21',
  email: 'yaremenkomaksym99@gmail.com',
  displayName: 'Admin',
  avatarUrl: null,
  role: 'ADMIN',
  seniorSharePercent: 26,
  legalFullName: null,
}
const ARTEM: SessionUser = {
  id: 'd8f9e0b1-c2d3-4e4f-9a6b-7c8d9e0f1acc',
  email: 'artem.kravchenko@cheekycheese.dev',
  displayName: 'Artem Kravchenko',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const DMYTRO: SessionUser = {
  id: 'd2f3e4b5-c6d7-4e8f-9a0b-1c2d3e4f5a66',
  email: 'dmytro.marchenko@cheekycheese.dev',
  displayName: 'Dmytro Marchenko',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
  legalFullName: null,
}
const ACCOUNTANT: SessionUser = {
  id: 'c7e8d9a0-b1c2-4d3e-8f5a-6b7c8d9e0fbb',
  email: 'mykola.savchenko@cheekycheese.dev',
  displayName: 'Mykola Savchenko',
  avatarUrl: null,
  role: 'ACCOUNTANT',
  seniorSharePercent: 26,
  legalFullName: null,
}

// ── Namespaced fixtures ──────────────────────────────────────────────────────

const TAG = 'receipt-attach-integration'
const EXPLORER_URL = 'https://etherscan.io/tx/0xreceiptattach01'
const EXPLORER_URL_2 = 'https://tronscan.org/#/transaction/receiptattach02'
const ANY_URL = 'https://drive.google.com/file/receipt-attach'

const DOC_FILE_A = 'f2000001-0000-4000-a000-000000000001'
const DOC_FILE_A_S3 = `${TAG}/file-a.pdf`
const DOC_FILE_B = 'f2000001-0000-4000-a000-000000000002'
const DOC_FILE_B_S3 = `${TAG}/file-b.pdf`

const TX_URL = 'f2000002-0000-4000-b000-000000000001' // USD, ARTEM author, no receipt
const TX_USDT = 'f2000002-0000-4000-b000-000000000002' // USDT, ARTEM author, no receipt
const TX_FILE = 'f2000002-0000-4000-b000-000000000003' // USD, ARTEM author, no receipt
const TX_PAID = 'f2000002-0000-4000-b000-000000000004' // USD, ARTEM author, PAID + receipt
const TX_OLD = 'f2000002-0000-4000-b000-000000000005' // USD, ARTEM author, PAID, no receipt (legacy)

const ALL_TX = [TX_URL, TX_USDT, TX_FILE, TX_PAID, TX_OLD]
const ALL_DOCS = [DOC_FILE_A, DOC_FILE_B]

// ── S3 spy-stub ──────────────────────────────────────────────────────────────

const s3DeleteSpy = vi.fn().mockResolvedValue(undefined)
const stubS3: Partial<S3Service> = {
  upload: vi.fn().mockResolvedValue(undefined),
  getPresignedDownloadUrl: vi
    .fn()
    .mockResolvedValue({ url: 'https://stub/', expiresAt: new Date().toISOString() }),
  delete: s3DeleteSpy,
}
const stubCompression: Partial<CompressionService> = {
  compress: vi
    .fn()
    .mockResolvedValue({ buffer: Buffer.from(''), finalMimeType: 'application/pdf', sizeBytes: 0 }),
  makeThumbnail: vi.fn().mockResolvedValue(null),
}

let _pool: Pool | null = null
let db: ReturnType<typeof drizzle<typeof schema>>
let svc: TransactionsService

function docValues(id: string, ownerId: string, s3Key: string) {
  return {
    id,
    ownerId,
    projectId: null,
    category: 'RECEIPT' as const,
    name: `${TAG}-${id}.pdf`,
    originalName: `${TAG}-${id}.pdf`,
    s3Key,
    thumbnailS3Key: null,
    sizeBytes: 512,
    mimeType: 'application/pdf',
    uploadedBy: ownerId,
  }
}

async function auditRows(targetId: string) {
  return db.select().from(transactionAuditLog).where(eq(transactionAuditLog.targetId, targetId))
}

describe.skipIf(!hasDatabaseUrl())(
  'task-receipts-backend — attach/replace receipt (real backend integration)',
  () => {
    beforeAll(async () => {
      try {
        const probe = new Pool({ connectionString: process.env['DATABASE_URL'] })
        await probe.query('SELECT 1')
        await probe.end()
      } catch {
        throw new Error('[receipt-attach integration] FAILED — no DB reachable at DATABASE_URL')
      }

      _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      db = drizzle(_pool, { schema })

      const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
      Object.assign(dbSvc, { pool: _pool, db })
      // task-file-storage-hardening HIGH-1: DocumentsService now injects
      // HrAccessService — unused by the receipt-attach/replace paths this
      // suite exercises, stubbed to satisfy the constructor signature.
      const stubHrAccess = { getActiveTeamPeers: async () => [] } as unknown as HrAccessService
      const documentsService = new DocumentsService(
        dbSvc,
        stubS3 as S3Service,
        stubCompression as CompressionService,
        stubHrAccess,
      )
      svc = makeTransactionsService({ db: dbSvc, documentsService })

      // Clean any residue from a prior aborted run.
      for (const id of ALL_TX)
        await db
          .delete(transactionAuditLog)
          .where(eq(transactionAuditLog.targetId, id))
          .catch(() => undefined)
      for (const id of ALL_TX)
        await db
          .delete(transactions)
          .where(eq(transactions.id, id))
          .catch(() => undefined)
      for (const id of ALL_DOCS)
        await db
          .delete(documents)
          .where(eq(documents.id, id))
          .catch(() => undefined)

      // Docs owned by ARTEM (file receipts).
      await db.insert(documents).values(docValues(DOC_FILE_A, ARTEM.id, DOC_FILE_A_S3))
      await db.insert(documents).values(docValues(DOC_FILE_B, ARTEM.id, DOC_FILE_B_S3))

      const baseTx = {
        type: 'SENIOR_INCOME' as const,
        amount: '1000',
        // task-sender-receiver-invariant (backlog A-2, 2026-08-18): was
        // `senderId: ARTEM.id` alongside `receiverId: ARTEM.id` — a self-pay
        // fixture bug caught by the new `ck_transactions_sender_ne_receiver`
        // DB CHECK on `transactions` (found via CI's Integration Tests job,
        // which seeds the real ARTEM fixture this local scratch DB does not
        // have). Real SENIOR_INCOME rows never set senderId — see
        // createSeniorIncome/declareUsdtProjectIncome in transactions.service.ts.
        receiverId: ARTEM.id,
        createdBy: ARTEM.id,
      }
      await db.insert(transactions).values([
        { ...baseTx, id: TX_URL, status: 'VALIDATED', currency: 'USD' },
        { ...baseTx, id: TX_USDT, status: 'VALIDATED', currency: 'USDT' },
        { ...baseTx, id: TX_FILE, status: 'VALIDATED', currency: 'USD' },
        { ...baseTx, id: TX_PAID, status: 'PAID', currency: 'USD', receiptExternalUrl: ANY_URL },
        { ...baseTx, id: TX_OLD, status: 'PAID', currency: 'USD' },
      ])
    })

    afterAll(async () => {
      if (!db)
        throw new Error(
          '[require-real-db] db not initialized — beforeAll should have thrown already',
        )
      for (const id of ALL_TX)
        await db
          .delete(transactionAuditLog)
          .where(eq(transactionAuditLog.targetId, id))
          .catch(() => undefined)
      for (const id of ALL_TX)
        await db
          .delete(transactions)
          .where(eq(transactions.id, id))
          .catch(() => undefined)
      for (const id of ALL_DOCS)
        await db
          .delete(documents)
          .where(eq(documents.id, id))
          .catch(() => undefined)
      await _pool?.end()
    })

    // ── RBAC ───────────────────────────────────────────────────────────────────

    it('foreign non-author (DMYTRO) attaching to ARTEM tx → 403', async () => {
      await expect(
        svc.attachOrReplaceReceipt(TX_URL, { receiptExternalUrl: ANY_URL }, DMYTRO),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it('author (ARTEM) attach url on own tx → ok; audit action=ATTACH', async () => {
      await svc.attachOrReplaceReceipt(TX_URL, { receiptExternalUrl: ANY_URL }, ARTEM)

      const row = await db.query.transactions.findFirst({ where: eq(transactions.id, TX_URL) })
      expect(row?.receiptExternalUrl).toBe(ANY_URL)

      const audit = await auditRows(TX_URL)
      expect(audit).toHaveLength(1)
      expect(audit[0]!.action).toBe('ATTACH')
      expect(audit[0]!.actorId).toBe(ARTEM.id)
      expect((audit[0]!.metadata as Record<string, unknown>)['newExtUrl']).toBe(ANY_URL)
    })

    it('author (ARTEM) replace url on own tx → ok; audit action=REPLACE with old/new', async () => {
      const NEW_URL = 'https://drive.google.com/file/receipt-attach-2'
      await svc.attachOrReplaceReceipt(TX_URL, { receiptExternalUrl: NEW_URL }, ARTEM)

      const row = await db.query.transactions.findFirst({ where: eq(transactions.id, TX_URL) })
      expect(row?.receiptExternalUrl).toBe(NEW_URL)

      const audit = await auditRows(TX_URL)
      const replace = audit.find((a) => a.action === 'REPLACE')
      expect(replace).toBeDefined()
      const meta = replace!.metadata as Record<string, unknown>
      expect(meta['oldExtUrl']).toBe(ANY_URL)
      expect(meta['newExtUrl']).toBe(NEW_URL)
    })

    // ── Currency-aware (USDT explorer-only) ──────────────────────────────────────

    it('USDT tx attach a FILE receipt → 400 (explorer-only)', async () => {
      await expect(
        svc.attachOrReplaceReceipt(TX_USDT, { receiptDocumentId: DOC_FILE_A }, ARTEM),
      ).rejects.toBeInstanceOf(BadRequestException)
    })

    it('USDT tx attach a NON-explorer url → 400', async () => {
      await expect(
        svc.attachOrReplaceReceipt(TX_USDT, { receiptExternalUrl: ANY_URL }, ARTEM),
      ).rejects.toBeInstanceOf(BadRequestException)
    })

    it('USDT tx attach an explorer url → ok', async () => {
      await svc.attachOrReplaceReceipt(TX_USDT, { receiptExternalUrl: EXPLORER_URL }, ARTEM)
      const row = await db.query.transactions.findFirst({ where: eq(transactions.id, TX_USDT) })
      expect(row?.receiptExternalUrl).toBe(EXPLORER_URL)
      // A second explorer url is a valid REPLACE for a USDT tx.
      await svc.attachOrReplaceReceipt(TX_USDT, { receiptExternalUrl: EXPLORER_URL_2 }, ARTEM)
      const row2 = await db.query.transactions.findFirst({ where: eq(transactions.id, TX_USDT) })
      expect(row2?.receiptExternalUrl).toBe(EXPLORER_URL_2)
    })

    // ── File receipt: 1:1 replace-with-delete ────────────────────────────────────

    it('non-USDT tx attach a FILE → ok; then replace with another FILE → old doc row deleted + S3 delete', async () => {
      s3DeleteSpy.mockClear()

      // Attach file A.
      await svc.attachOrReplaceReceipt(TX_FILE, { receiptDocumentId: DOC_FILE_A }, ARTEM)
      let row = await db.query.transactions.findFirst({ where: eq(transactions.id, TX_FILE) })
      expect(row?.receiptDocumentId).toBe(DOC_FILE_A)

      // Replace with file B → old doc A row hard-deleted + its S3 key cleaned.
      await svc.attachOrReplaceReceipt(TX_FILE, { receiptDocumentId: DOC_FILE_B }, ARTEM)
      row = await db.query.transactions.findFirst({ where: eq(transactions.id, TX_FILE) })
      expect(row?.receiptDocumentId).toBe(DOC_FILE_B)

      const docA = await db.query.documents.findFirst({ where: eq(documents.id, DOC_FILE_A) })
      expect(docA).toBeUndefined() // 1:1 invariant — old doc removed
      expect(s3DeleteSpy).toHaveBeenCalledWith(DOC_FILE_A_S3)

      const audit = await auditRows(TX_FILE)
      expect(audit.map((a) => a.action).sort()).toEqual(['ATTACH', 'REPLACE'])
    })

    it("attaching another owner's document → 403 (self-ownership)", async () => {
      // DMYTRO is not the author of TX_FILE and also owns no doc here; use ADMIN
      // (privileged, allowed on any tx) trying to bind ARTEM's DOC_FILE_B which is
      // already bound → must fail ownership (ADMIN self-ownership check).
      await expect(
        svc.attachOrReplaceReceipt(TX_OLD, { receiptDocumentId: DOC_FILE_B }, ADMIN),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    // ── Status matrix (replace after PAID) ───────────────────────────────────────

    it('author (ARTEM) replace receipt AFTER PAID → 403', async () => {
      await expect(
        svc.attachOrReplaceReceipt(TX_PAID, { receiptExternalUrl: EXPLORER_URL }, ARTEM),
      ).rejects.toBeInstanceOf(ForbiddenException)
    })

    it('ACCOUNTANT replace receipt AFTER PAID → ok; audit REPLACE', async () => {
      const NEW_URL = 'https://drive.google.com/file/paid-replaced'
      await svc.attachOrReplaceReceipt(TX_PAID, { receiptExternalUrl: NEW_URL }, ACCOUNTANT)
      const row = await db.query.transactions.findFirst({ where: eq(transactions.id, TX_PAID) })
      expect(row?.receiptExternalUrl).toBe(NEW_URL)
      const audit = await auditRows(TX_PAID)
      expect(audit.some((a) => a.action === 'REPLACE' && a.actorId === ACCOUNTANT.id)).toBe(true)
    })

    it('ADMIN attach to ANY transaction (not author) → ok', async () => {
      // TX_OLD has no receipt; ADMIN is not the author (createdBy=ARTEM) but is
      // privileged → allowed.
      await svc.attachOrReplaceReceipt(TX_OLD, { receiptExternalUrl: ANY_URL }, ADMIN)
      const row = await db.query.transactions.findFirst({ where: eq(transactions.id, TX_OLD) })
      expect(row?.receiptExternalUrl).toBe(ANY_URL)
    })

    it('attach to a non-existent transaction → 404', async () => {
      await expect(
        svc.attachOrReplaceReceipt(
          'f2000002-0000-4000-b000-0000000000ff',
          { receiptExternalUrl: ANY_URL },
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(NotFoundException)
    })

    // ── Regression: systemic / legacy receiptless rows ───────────────────────────

    it('regression: a receiptless (systemic/legacy) row inserts + reads without error', async () => {
      // salary-cron / cascade-close insert directly via db.insert (bypassing the
      // create-schemas), so the Zod mandatory-refine never touches them. Mirror
      // that shape: a receiptless row must insert AND read back fine.
      const SYS_ID = 'f2000002-0000-4000-b000-0000000000aa'
      await db
        .delete(transactions)
        .where(eq(transactions.id, SYS_ID))
        .catch(() => undefined)
      await expect(
        db.insert(transactions).values({
          id: SYS_ID,
          type: 'SALARY',
          status: 'PENDING',
          amount: '800',
          currency: 'USD',
          salaryMonth: '2026-07',
          receiverId: ARTEM.id,
          createdBy: ADMIN.id,
        }),
      ).resolves.toBeDefined()

      const found = await svc.findOne(SYS_ID, ADMIN)
      expect(found).toBeDefined()
      expect(found.receiptExternalUrl ?? null).toBeNull()

      await db.delete(transactions).where(eq(transactions.id, SYS_ID))
    })

    it('regression: legacy PAID row with no receipt is readable via findOne', async () => {
      // TX_OLD started receiptless; after the ADMIN-attach test above it carries a
      // url. Re-assert findOne succeeds regardless (no throw on read).
      const found = await svc.findOne(TX_OLD, ADMIN)
      expect(found.id).toBe(TX_OLD)
    })

    // ── Regression: mandatory create path enforces receipt (service defense) ─────

    it('regression: declareUsdtProjectIncome without a receipt → 400 (mandatory)', async () => {
      await expect(
        svc.declareUsdtProjectIncome(
          {
            projectId: 'f2000002-0000-4000-c000-000000000001',
            amount: 100,
            receiverId: 'COMPANY_ACCOUNT',
            idempotencyKey: 'f2000002-0000-4000-d000-000000000001',
          },
          ADMIN,
        ),
      ).rejects.toBeInstanceOf(BadRequestException)
    })
  },
)
