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
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { eq } from 'drizzle-orm'
// `update` used via db.update() (Drizzle instance method) — no extra import needed
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { DatabaseService } from '../database/database.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
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

// IDOR test: doc C belongs to DMYTRO (victim), used to test the exploit
const DOC_C_ID = 'f0000001-0000-4000-a000-000000000003'
const DOC_C_S3_KEY = `${TAG}/receipt-c-victim.pdf`

// IDOR happy-path test: doc D belongs to ARTEM, dedicated to the happy-path test
// (DOC_B is consumed by AC1 and its unique index slot reused by TX_ID — so we
// need a fresh doc that is not bound to any other tx to avoid unique-index conflict)
const DOC_D_ID = 'f0000001-0000-4000-a000-000000000004'
const DOC_D_S3_KEY = `${TAG}/receipt-d-artem-happy.pdf`

// Transaction (REJECTED, links doc A as receipt)
const TX_ID = 'f1000001-0000-4000-b000-000000000001'

// IDOR exploit test: a second REJECTED tx owned by ARTEM (attacker)
const TX_IDOR_ID = 'f1000001-0000-4000-b000-000000000003'

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

    // TransactionsService — real, wired to spy DocumentsService
    // invoices not exercised here — factory default (no-op stub) is fine
    transactionsService = makeTransactionsService({ db: dbSvc, documentsService })

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

    // Doc C — belongs to DMYTRO (victim); used for IDOR exploit tests
    await db
      .insert(documents)
      .values({
        id: DOC_C_ID,
        ownerId: DMYTRO.id,
        projectId: null,
        category: 'RECEIPT',
        name: `${TAG}-receipt-c-victim.pdf`,
        originalName: `${TAG}-receipt-c-victim.pdf`,
        s3Key: DOC_C_S3_KEY,
        thumbnailS3Key: null,
        sizeBytes: 512,
        mimeType: 'application/pdf',
        uploadedBy: DMYTRO.id,
      })
      .onConflictDoNothing()

    // Doc D — belongs to ARTEM; used in IDOR happy-path test exclusively
    // (separate from DOC_B which is consumed/rebound by AC1 test)
    await db
      .insert(documents)
      .values({
        id: DOC_D_ID,
        ownerId: ARTEM.id,
        projectId: null,
        category: 'RECEIPT',
        name: `${TAG}-receipt-d-artem-happy.pdf`,
        originalName: `${TAG}-receipt-d-artem-happy.pdf`,
        s3Key: DOC_D_S3_KEY,
        thumbnailS3Key: null,
        sizeBytes: 512,
        mimeType: 'application/pdf',
        uploadedBy: ARTEM.id,
      })
      .onConflictDoNothing()

    // IDOR test tx — REJECTED, owned by ARTEM; no receipt initially
    await db
      .insert(transactions)
      .values({
        id: TX_IDOR_ID,
        type: 'SENIOR_INCOME',
        status: 'REJECTED',
        amount: '1000',
        currency: 'USD',
        senderId: ARTEM.id,
        receiverId: ARTEM.id,
        receiptDocumentId: null,
        rejectionReason: 'No receipt',
        validatedBy: ADMIN.id,
        validatedAt: new Date('2026-01-01'),
        createdBy: ADMIN.id,
      })
      .onConflictDoUpdate({
        target: transactions.id,
        set: {
          status: 'REJECTED',
          receiptDocumentId: null,
          rejectionReason: 'No receipt',
        },
      })

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
    await db
      .delete(transactions)
      .where(eq(transactions.id, TX_IDOR_ID))
      .catch(() => undefined)
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
    await db
      .delete(documents)
      .where(eq(documents.id, DOC_C_ID))
      .catch(() => undefined)
    await db
      .delete(documents)
      .where(eq(documents.id, DOC_D_ID))
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

  // ── HIGH-1 IDOR exploit regression ──────────────────────────────────────────

  it("HIGH-1 — IDOR blocked: ARTEM cannot bind DMYTRO's receipt doc (ForbiddenException)", async () => {
    if (!dbAvailable) return
    // Exploit attempt: SENIOR-ARTEM passes receiptDocumentId = DOC_C (owned by DMYTRO)
    // into their own REJECTED tx. Without the guard this would bind DMYTRO's doc as FK.
    await expect(
      transactionsService.updateSeniorIncome(
        TX_IDOR_ID,
        { receiptDocumentId: DOC_C_ID }, // DOC_C belongs to DMYTRO, not ARTEM
        ARTEM,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException)

    // Verify doc C was NOT touched — still exists under DMYTRO's ownership
    const docC = await db.query.documents.findFirst({ where: eq(documents.id, DOC_C_ID) })
    expect(docC).toBeDefined()
    expect(docC?.ownerId).toBe(DMYTRO.id)

    // Verify TX_IDOR still in REJECTED — no FK mutation occurred
    const txRow = await db.query.transactions.findFirst({
      where: eq(transactions.id, TX_IDOR_ID),
    })
    expect(txRow?.status).toBe('REJECTED')
    expect(txRow?.receiptDocumentId).toBeNull()
  })

  it('HIGH-1 — IDOR 2-step exploit blocked: bind→reject→resubmit cannot delete victim doc', async () => {
    if (!dbAvailable) return
    // This test verifies the exploit described in PR-3 security review:
    // Step 1: Attacker ARTEM tries to bind DMYTRO's doc (→ should be blocked at bind).
    // Step 2: If step 1 were allowed, a subsequent resubmit would delete DOC_C.
    // We verify that after step 1 is blocked, DOC_C remains intact.

    // Step 1 — bind attempt (must be blocked)
    await expect(
      transactionsService.updateSeniorIncome(TX_IDOR_ID, { receiptDocumentId: DOC_C_ID }, ARTEM),
    ).rejects.toBeInstanceOf(ForbiddenException)

    // Step 2 — even attempting a second resubmit with own doc must not delete DOC_C
    // (confirm by checking DOC_C is still present and owned by DMYTRO)
    const docC = await db.query.documents.findFirst({ where: eq(documents.id, DOC_C_ID) })
    expect(docC).toBeDefined()
    expect(docC?.ownerId).toBe(DMYTRO.id)
    // And S3 delete was never called for DOC_C's key
    expect(s3DeleteSpy).not.toHaveBeenCalledWith(DOC_C_S3_KEY)
  })

  it('HIGH-1 — non-RECEIPT doc is rejected (BadRequestException)', async () => {
    if (!dbAvailable) return
    // Insert a SCAN doc owned by ARTEM — trying to bind it as receipt must fail.
    // Uses ...000000000005 to avoid UUID collision with DOC_D_ID (...000000000004).
    const SCAN_DOC_ID = 'f0000001-0000-4000-a000-000000000005'
    await db
      .insert(documents)
      .values({
        id: SCAN_DOC_ID,
        ownerId: ARTEM.id,
        projectId: null,
        category: 'SCAN',
        name: `${TAG}-scan.pdf`,
        originalName: `${TAG}-scan.pdf`,
        s3Key: `${TAG}/scan.pdf`,
        thumbnailS3Key: null,
        sizeBytes: 512,
        mimeType: 'application/pdf',
        uploadedBy: ARTEM.id,
      })
      .onConflictDoNothing()

    try {
      await expect(
        transactionsService.updateSeniorIncome(
          TX_IDOR_ID,
          { receiptDocumentId: SCAN_DOC_ID },
          ARTEM,
        ),
      ).rejects.toBeInstanceOf(BadRequestException)
    } finally {
      await db
        .delete(documents)
        .where(eq(documents.id, SCAN_DOC_ID))
        .catch(() => undefined)
    }
  })

  it('HIGH-1 — nonexistent docId is rejected (NotFoundException)', async () => {
    if (!dbAvailable) return
    const FAKE_ID = 'f0000001-0000-4000-a000-000000000099'
    await expect(
      transactionsService.updateSeniorIncome(TX_IDOR_ID, { receiptDocumentId: FAKE_ID }, ARTEM),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it('HIGH-1 — ARTEM can bind their own RECEIPT doc (happy path)', async () => {
    if (!dbAvailable) return
    // Reset IDOR tx to REJECTED + no receipt before this test.
    // We use DOC_D (seeded in beforeAll, owned by ARTEM, never bound to another tx)
    // rather than DOC_B which: (a) was physically deleted by AC1, and (b) is now
    // bound to TX_ID — trying to rebind it would violate the unique index.
    await db
      .update(transactions)
      .set({ status: 'REJECTED', receiptDocumentId: null, rejectionReason: 'test reset' })
      .where(eq(transactions.id, TX_IDOR_ID))

    // DOC_D is owned by ARTEM and not bound to any tx — guard must allow this
    await expect(
      transactionsService.updateSeniorIncome(TX_IDOR_ID, { receiptDocumentId: DOC_D_ID }, ARTEM),
    ).resolves.toBeDefined()

    const txRow = await db.query.transactions.findFirst({
      where: eq(transactions.id, TX_IDOR_ID),
    })
    expect(txRow?.receiptDocumentId).toBe(DOC_D_ID)
    expect(txRow?.status).toBe('PENDING')
  })
})
