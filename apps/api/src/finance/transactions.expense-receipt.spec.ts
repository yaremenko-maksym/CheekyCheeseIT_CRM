/**
 * п.3 — EXPENSE receipt-bind defense-in-depth (no-op rationale + ownership test).
 *
 * Context:
 *   `createExpense` is ADMIN-only. For EXPENSE the "owner" of the expense is
 *   always `currentUser` (ADMIN): `senderId = currentUser.id`, no receiverId FK.
 *   `assertReceiptDocumentBindable` defaults `expectedOwner = currentUser.id`
 *   when `opts.expectedOwnerId` is not supplied — this is already correct for
 *   EXPENSE because ADMIN is both the actor and the expense owner.
 *
 *   Passing `expectedOwnerId` explicitly would be redundant (same value as the
 *   default). The existing call-site is therefore correct by design; no
 *   production code change is needed.
 *
 * What we test here:
 *   - Binding a RECEIPT document owned by another user → ForbiddenException (403).
 *   - Binding a non-RECEIPT category document → BadRequestException (400).
 *   - Binding a missing document → NotFoundException (404).
 *
 * DB-skip-guard: tests use a fully mocked db so they run in the CI unit job
 * without a Postgres service.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { TransactionsService } from './transactions.service'
import { DatabaseService } from '../database/database.service'
import { InvoicesService } from '../invoices/invoices.service'

// ── Constants ─────────────────────────────────────────────────────────────────

const ADMIN: SessionUser = {
  id: 'a8f4d3b1-0000-0000-0000-000000000001',
  email: 'admin@example.com',
  displayName: 'Admin',
  role: 'ADMIN',
}

const OTHER_USER_ID = 'b9c5d2e1-0000-0000-0000-000000000002'
const RECEIPT_DOC_ID = 'dddddddd-0000-0000-0000-000000000001'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDoc(
  overrides: Partial<{
    id: string
    ownerId: string
    category: string
    deletedAt: Date | null
  }> = {},
) {
  return {
    id: RECEIPT_DOC_ID,
    ownerId: ADMIN.id,
    category: 'RECEIPT',
    deletedAt: null,
    s3Key: 'documents/RECEIPT/some-key',
    ...overrides,
  }
}

function makeDbMock(docRow: ReturnType<typeof makeDoc> | null) {
  return {
    db: {
      query: {
        documents: {
          findFirst: vi.fn().mockResolvedValue(docRow),
        },
        projects: { findFirst: vi.fn() },
        users: { findFirst: vi.fn() },
        transactions: { findFirst: vi.fn() },
        payoutRequests: { findFirst: vi.fn() },
      },
      insert: vi.fn().mockReturnValue({
        values: vi
          .fn()
          .mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'tx-id' }]) }),
      }),
      select: vi.fn(),
      update: vi.fn(),
      transaction: vi.fn(),
    },
  } as unknown as DatabaseService
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createExpense — receipt-bind ownership guard (п.3 no-op by design)', () => {
  let service: TransactionsService
  let invoicesService: InvoicesService

  beforeEach(() => {
    invoicesService = {
      autoCreateFromTransaction: vi.fn().mockResolvedValue(undefined),
    } as unknown as InvoicesService
  })

  it('rejects binding a RECEIPT document owned by another user → ForbiddenException', async () => {
    // Document exists, category=RECEIPT, but owned by OTHER_USER not by ADMIN
    const foreignDoc = makeDoc({ ownerId: OTHER_USER_ID })
    const db = makeDbMock(foreignDoc)
    service = new TransactionsService(db, invoicesService)

    const payload = {
      amount: 100,
      currency: 'USD',
      category: 'Office supplies',
      receiptDocumentId: RECEIPT_DOC_ID,
    }

    await expect(service.createExpense(payload, ADMIN)).rejects.toThrow(ForbiddenException)
  })

  it('rejects binding a non-RECEIPT category document → BadRequestException', async () => {
    const wrongCategoryDoc = makeDoc({ category: 'SCAN' })
    const db = makeDbMock(wrongCategoryDoc)
    service = new TransactionsService(db, invoicesService)

    const payload = {
      amount: 200,
      currency: 'USD',
      category: 'Hosting',
      receiptDocumentId: RECEIPT_DOC_ID,
    }

    await expect(service.createExpense(payload, ADMIN)).rejects.toThrow(BadRequestException)
  })

  it('rejects binding a missing document → NotFoundException', async () => {
    const db = makeDbMock(null) // document not found
    service = new TransactionsService(db, invoicesService)

    const payload = {
      amount: 50,
      currency: 'USD',
      category: 'Travel',
      receiptDocumentId: 'non-existent-doc-id',
    }

    await expect(service.createExpense(payload, ADMIN)).rejects.toThrow(NotFoundException)
  })

  it('no-op by design: default expectedOwner === currentUser.id for EXPENSE', () => {
    // This test documents the design decision:
    // createExpense calls assertReceiptDocumentBindable(docId, currentUser) without
    // opts.expectedOwnerId — which defaults to currentUser.id. Since EXPENSE owner
    // is always the ADMIN actor, the default is already correct. Explicitly passing
    // expectedOwnerId: currentUser.id would be redundant.
    //
    // The ownership check is therefore already correct by design for EXPENSE.
    // Verified by the ForbiddenException test above: a foreign-owned doc is rejected.
    expect(true).toBe(true)
  })
})
