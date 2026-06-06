/**
 * PR-3 receipt replace-with-delete — real backend integration spec.
 *
 * WHY this test exists (feedback_mocked_e2e_guards lesson):
 *   Unit tests stub the DB — they can't verify that the Drizzle transaction,
 *   the FK re-point, and the documents row delete all commit atomically against
 *   a real PostgreSQL. This spec hits the real DB.
 *
 * WHAT it covers (PR-3 AC 1-4):
 *   1. SENIOR resubmits REJECTED tx with a new receipt doc → old doc row gone,
 *      tx.receiptDocumentId == newDocId, status == PENDING.
 *   2. RBAC: only the receiverId SENIOR can resubmit (ForbiddenException for others).
 *   3. Validate → VALIDATED still works after resubmit (confirmation unchanged).
 *   4. S3.delete spy called for the old document's s3Key.
 *   5. 1:1 invariant: old documents row is removed (no orphan FK).
 *
 * DB-SKIP-GUARD:
 *   `dbAvailable = false` when DATABASE_URL is unreachable (CI unit job
 *   without Postgres service). Every test checks the flag and returns early.
 *
 * S3 STRATEGY:
 *   S3Service is replaced with a spy-stub. This avoids needing a real MinIO
 *   while still verifying that delete() is called with the correct key.
 *
 * SEED data:
 *   - ADMIN:      yaremenkomaksym99@gmail.com  (a8f4d3b1-...)
 *   - SENIOR:     artem.kravchenko             (d8f9e0b1-...)
 *   - SENIOR2:    dmytro.marchenko             (d2f3e4b5-...)
 *   - ACCOUNTANT: mykola.savchenko             (c7e8d9a0-...)
 *
 * SETUP: inserts test documents + transactions in beforeAll, cleans up in afterAll.
 *
 * WHY useFactory for providers:
 *   vitest uses esbuild which strips TS decorator metadata — explicit useFactory
 *   resolves DI correctly (mirrors PR-2 integration spec pattern).
 */
import { ForbiddenException } from '@nestjs/common'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { eq } from 'drizzle-orm'
// `update` used via db.update() (Drizzle instance method) — no extra import needed
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { TransactionsService } from './transactions.service'
import { DocumentsService } from '../documents/documents.service'
import { S3Service } from '../documents/s3.service'
import { CompressionService } from '../documents/compression.service'
import { InvoicesService } from '../invoices/invoices.service'
import { documents, transactions } from '../database/schema'
import * as schema from '../database/schema'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
  legalFullName: 'Марченко Дмитро Олексійович',
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

// ---------------------------------------------------------------------------
// Test row IDs — namespaced to avoid collision with seed data
// ---------------------------------------------------------------------------

const TAG = 'pr3-integration-spec'

// Old receipt (doc A) — will be deleted on resubmit
const DOC_A_ID = 'f0000001-0000-4000-a000-000000000001'
const DOC_A_S3_KEY = `${TAG}/receipt-a.pdf`

// New receipt (doc B) — replaces doc A
const DOC_B_ID = 'f0000001-0000-4000-a000-000000000002'
const DOC_B_S3_KEY = `${TAG}/receipt-b.pdf`

// Transaction (REJECTED, links doc A as receipt)
const TX_ID = 'f1000001-0000-4000-b000-000000000001'

// ---------------------------------------------------------------------------
// DB-skip-guard
// ---------------------------------------------------------------------------

let dbAvailable = true
let _pool: Pool | null = null

// ---------------------------------------------------------------------------
// S3 spy-stub — tracks delete() calls without hitting real S3
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test setup — direct service instantiation (no Nest app needed)
// Since we test service methods directly, we build the dependency graph manually:
//   TransactionsService ← DatabaseService, InvoicesService (stub), DocumentsService
//   DocumentsService ← DatabaseService, S3Service (spy-stub), CompressionService (stub)
// ---------------------------------------------------------------------------

let db: ReturnType<typeof drizzle>
let transactionsService: TransactionsService
let documentsService: DocumentsService

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('PR-3 receipt replace-with-delete — real backend integration', () => {
  beforeAll(async () => {
    // ── DB availability probe ────────────────────────────────────────────────
    try {
      const probePool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      await probePool.query('SELECT 1')
      await probePool.end()
    } catch {
      console.warn(
        '[pr3-receipt integration] SKIPPED — no DB reachable at DATABASE_URL (expected in CI unit job)',
      )
      dbAvailable = false
      return
    }

    // ── Build real DB + services ─────────────────────────────────────────────
    _pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    db = drizzle(_pool, { schema })

    // Build DatabaseService instance (mirrors PR-2 integration spec pattern)
    const dbSvc = Object.create(DatabaseService.prototype) as DatabaseService
    Object.assign(dbSvc, { pool: _pool, db })

    // DocumentsService with spy S3
    documentsService = new DocumentsService(
      dbSvc,
      stubS3 as S3Service,
      stubCompression as CompressionService,
    )

    // InvoicesService — stub (we don't test invoice flows here)
    const invoicesServiceStub = {} as InvoicesService

    // TransactionsService — real, wired to spy DocumentsService
    transactionsService = new TransactionsService(dbSvc, invoicesServiceStub, documentsService)

    // ── Insert test rows ─────────────────────────────────────────────────────
    // Doc A — the OLD receipt (will be deleted on resubmit)
    await db
      .insert(documents)
      .values({
        id: DOC_A_ID,
        ownerId: ARTEM.id,
        projectId: null,
        category: 'RECEIPT',
        name: `${TAG}-receipt-a.pdf`,
        originalName: `${TAG}-receipt-a.pdf`,
        s3Key: DOC_A_S3_KEY,
        thumbnailS3Key: null,
        sizeBytes: 512,
        mimeType: 'application/pdf',
        uploadedBy: ARTEM.id,
      })
      .onConflictDoNothing()

    // Doc B — the NEW receipt (replaces A)
    await db
      .insert(documents)
      .values({
        id: DOC_B_ID,
        ownerId: ARTEM.id,
        projectId: null,
        category: 'RECEIPT',
        name: `${TAG}-receipt-b.pdf`,
        originalName: `${TAG}-receipt-b.pdf`,
        s3Key: DOC_B_S3_KEY,
        thumbnailS3Key: null,
        sizeBytes: 512,
        mimeType: 'application/pdf',
        uploadedBy: ARTEM.id,
      })
      .onConflictDoNothing()

    // Transaction — REJECTED, links Doc A as receipt.
    // onConflictDoUpdate forces REJECTED status even if the row already exists
    // from a previous run that left it in VALIDATED (i.e. afterAll cleanup
    // failed on a prior run). This makes the spec re-runnable.
    await db
      .insert(transactions)
      .values({
        id: TX_ID,
        type: 'SENIOR_INCOME',
        status: 'REJECTED',
        amount: '2000',
        currency: 'USD',
        senderId: ARTEM.id,
        receiverId: ARTEM.id,
        receiptDocumentId: DOC_A_ID,
        rejectionReason: 'Bad quality receipt',
        validatedBy: ADMIN.id,
        validatedAt: new Date('2026-01-01'),
        createdBy: ADMIN.id,
      })
      .onConflictDoUpdate({
        target: transactions.id,
        set: {
          status: 'REJECTED',
          receiptDocumentId: DOC_A_ID,
          rejectionReason: 'Bad quality receipt',
          validatedBy: ADMIN.id,
          validatedAt: new Date('2026-01-01'),
        },
      })
  })

  afterAll(async () => {
    if (!dbAvailable || !db) return
    // Clean up in reverse FK order
    await db.delete(transactions).where(eq(transactions.id, TX_ID))
    // Doc A may already be deleted by the test — ignore if gone
    await db
      .delete(documents)
      .where(eq(documents.id, DOC_A_ID))
      .catch(() => undefined)
    await db
      .delete(documents)
      .where(eq(documents.id, DOC_B_ID))
      .catch(() => undefined)
    await _pool?.end()
  })

  it('AC1 — resubmit replaces receipt: old doc A deleted, tx links doc B, status PENDING', async () => {
    if (!dbAvailable) return

    // Re-seed doc A and tx state in case a previous run left them in a
    // partially mutated state. This makes the spec idempotent.
    await db
      .insert(documents)
      .values({
        id: DOC_A_ID,
        ownerId: ARTEM.id,
        projectId: null,
        category: 'RECEIPT',
        name: `${TAG}-receipt-a.pdf`,
        originalName: `${TAG}-receipt-a.pdf`,
        s3Key: DOC_A_S3_KEY,
        thumbnailS3Key: null,
        sizeBytes: 512,
        mimeType: 'application/pdf',
        uploadedBy: ARTEM.id,
      })
      .onConflictDoUpdate({
        target: documents.id,
        set: { s3Key: DOC_A_S3_KEY, deletedAt: null },
      })

    await db
      .update(transactions)
      .set({
        status: 'REJECTED',
        receiptDocumentId: DOC_A_ID,
        rejectionReason: 'Bad quality receipt',
        validatedBy: ADMIN.id,
        validatedAt: new Date('2026-01-01'),
      })
      .where(eq(transactions.id, TX_ID))

    // Reset spy before this test
    s3DeleteSpy.mockClear()

    await transactionsService.updateSeniorIncome(TX_ID, { receiptDocumentId: DOC_B_ID }, ARTEM)

    // Verify tx was updated
    const txRow = await db.query.transactions.findFirst({
      where: eq(transactions.id, TX_ID),
    })
    expect(txRow).toBeDefined()
    expect(txRow?.status).toBe('PENDING')
    expect(txRow?.receiptDocumentId).toBe(DOC_B_ID)
    expect(txRow?.rejectionReason).toBeNull()
    expect(txRow?.validatedBy).toBeNull()
    expect(txRow?.validatedAt).toBeNull()

    // Verify old doc A row is gone (1:1 invariant — no orphan)
    const docARow = await db.query.documents.findFirst({
      where: eq(documents.id, DOC_A_ID),
    })
    expect(docARow).toBeUndefined()

    // Verify S3 delete was called for doc A's key
    expect(s3DeleteSpy).toHaveBeenCalledWith(DOC_A_S3_KEY)
  })

  it('AC2 — RBAC: only receiverId SENIOR can resubmit (DMYTRO → ForbiddenException)', async () => {
    if (!dbAvailable) return

    // At this point tx is PENDING (from AC1). To test RBAC we need REJECTED again
    // — but since we can't reset easily, we test with the PENDING tx (wrong status
    // check fires before RBAC). Instead, seed a second minimal REJECTED tx inline.
    const TX_RBAC_ID = 'f1000001-0000-4000-b000-000000000002'
    await db
      .insert(transactions)
      .values({
        id: TX_RBAC_ID,
        type: 'SENIOR_INCOME',
        status: 'REJECTED',
        amount: '500',
        currency: 'USD',
        senderId: ARTEM.id,
        receiverId: ARTEM.id,
        receiptDocumentId: null,
        createdBy: ADMIN.id,
      })
      .onConflictDoNothing()

    try {
      await expect(
        transactionsService.updateSeniorIncome(
          TX_RBAC_ID,
          { receiptDocumentId: DOC_B_ID },
          DMYTRO, // not the receiverId
        ),
      ).rejects.toBeInstanceOf(ForbiddenException)
    } finally {
      // Cleanup the RBAC test tx
      await db
        .delete(transactions)
        .where(eq(transactions.id, TX_RBAC_ID))
        .catch(() => undefined)
    }
  })

  it('AC3 — validate still works after resubmit (confirmation unchanged)', async () => {
    if (!dbAvailable) return

    // tx is now PENDING (from AC1). ACCOUNTANT validates it.
    await transactionsService.validateTransaction(TX_ID, 'validate', null, ACCOUNTANT)

    const txRow = await db.query.transactions.findFirst({
      where: eq(transactions.id, TX_ID),
    })
    expect(txRow?.status).toBe('VALIDATED')
    expect(txRow?.validatedBy).toBe(ACCOUNTANT.id)
    expect(txRow?.validatedAt).toBeDefined()
  })

  it('AC4 — S3 delete was invoked for old receipt S3 key (AC1 already covers this)', () => {
    if (!dbAvailable) return
    // AC1 already verified this — adding explicit assertion for traceability.
    expect(s3DeleteSpy).toHaveBeenCalledWith(DOC_A_S3_KEY)
  })
})
