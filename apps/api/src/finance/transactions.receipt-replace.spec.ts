/**
 * Unit tests for Task 2 (PR-3): replace-with-delete receipt on senior-income resubmit.
 *
 * Tests `updateSeniorIncome` — specifically the path where a REJECTED transaction
 * is resubmitted with a new receiptDocumentId. The old receipt document must be
 * hard-deleted (DB row inside the Drizzle dbtx, S3 post-commit via deleteS3Keys).
 *
 * Harness: pure unit — DB and DocumentsService are fully stubbed. We verify:
 *   1. dbtx.delete(documents) called when receipt doc changes (new docId provided).
 *   2. dbtx.delete NOT called when receipt is unchanged (same docId).
 *   3. dbtx.delete NOT called when there was no prior receipt (oldId null).
 *   4. Status resets to PENDING; validatedBy/At/rejectionReason cleared.
 *   5. RBAC: only receiver SENIOR can resubmit (ForbiddenException otherwise).
 *   6. Can only edit REJECTED transactions (BadRequestException otherwise).
 *   7. deleteS3Keys called with the OLD doc's S3 key post-commit.
 *   8. deleteS3Keys NOT called when there is no old doc to replace.
 *   9. Uses a DB transaction (atomic) for the receipt replace.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { DocumentsService } from '../documents/documents.service'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const s = (id: string, role: SessionUser['role'] = 'SENIOR'): SessionUser => ({
  id,
  role,
  displayName: id,
  email: `${id}@x.com`,
  avatar: null,
  seniorSharePercent: 26,
})

const SENIOR = s('senior-1')
const SENIOR2 = s('senior-2')

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface TxRow {
  id: string
  type: string
  status: string
  receiverId: string
  receiptDocumentId: string | null
  receiptExternalUrl: string | null
  amount: string
  currency: string
  notes: string | null
  rejectionReason: string | null
  validatedBy: string | null
  validatedAt: Date | null
  updatedAt: Date
}

interface DocRow {
  id: string
  ownerId: string
  category: string
  s3Key: string
  thumbnailS3Key: string | null
}

interface HarnessOpts {
  tx?: Partial<TxRow>
  doc?: Partial<DocRow> | null
}

function makeHarness(opts: HarnessOpts = {}) {
  const txRow: TxRow = {
    id: 'tx-1',
    type: 'SENIOR_INCOME',
    status: 'REJECTED',
    receiverId: SENIOR.id,
    receiptDocumentId: opts.tx?.receiptDocumentId ?? 'old-doc-id',
    receiptExternalUrl: opts.tx?.receiptExternalUrl ?? null,
    amount: opts.tx?.amount ?? '1000',
    currency: opts.tx?.currency ?? 'USD',
    notes: opts.tx?.notes ?? null,
    rejectionReason: opts.tx?.rejectionReason ?? 'Bad receipt',
    validatedBy: opts.tx?.validatedBy ?? 'acc-1',
    validatedAt: opts.tx?.validatedAt ?? new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...(opts.tx ?? {}),
  }

  // Track what was SET in the update call
  let lastSetValues: Record<string, unknown> = {}
  // Track whether DB transaction was started
  let dbTxStarted = false
  // Track dbtx.delete calls (document row deletion inside the tx)
  const dbtxDeleteWhere = vi.fn().mockResolvedValue(undefined)
  const dbtxDelete = vi.fn().mockReturnValue({ where: dbtxDeleteWhere })

  // docRow defaults include category=RECEIPT and ownerId=SENIOR.id so the
  // assertReceiptDocumentBindable guard passes for the existing replace-with-delete
  // unit tests (they test the replace mechanic, not the ownership guard).
  const docRow: DocRow | null =
    opts.doc === null
      ? null
      : {
          id: opts.doc?.id ?? 'old-doc-id',
          ownerId: opts.doc?.ownerId ?? SENIOR.id,
          category: opts.doc?.category ?? 'RECEIPT',
          s3Key: opts.doc?.s3Key ?? 'documents/RECEIPT/senior-1/old-doc.pdf',
          thumbnailS3Key: opts.doc?.thumbnailS3Key ?? null,
        }

  // Stub DocumentsService — tracks deleteS3Keys calls (post-commit S3 cleanup)
  const deleteS3Keys = vi.fn().mockResolvedValue(undefined)
  const documentsService = { deleteS3Keys }

  // Minimal DB stub that supports db.transaction() + update/query
  const db = {
    db: {
      query: {
        transactions: {
          findFirst: vi.fn().mockImplementation(async () => {
            return { ...txRow }
          }),
        },
        documents: {
          findFirst: vi.fn().mockImplementation(async () => {
            return docRow ? { ...docRow } : undefined
          }),
        },
      },
      transaction: vi.fn().mockImplementation(async (cb: (dbtx: unknown) => Promise<void>) => {
        dbTxStarted = true
        // dbtx stub — supports update().set().where() and delete().where()
        const dbtx = {
          update: (_table: unknown) => ({
            set: (values: Record<string, unknown>) => {
              lastSetValues = values
              return {
                where: async (_pred: unknown) => undefined,
              }
            },
          }),
          delete: dbtxDelete,
        }
        await cb(dbtx)
      }),
    },
  }

  const service = makeTransactionsService({
    db: db as never,
    documentsService: documentsService as never as DocumentsService,
  })

  // Stub findOne so updateSeniorIncome can complete
  vi.spyOn(service, 'findOne' as never).mockResolvedValue({
    id: 'tx-1',
    status: 'PENDING',
    receiptDocumentId: 'new-doc-id',
  } as never)

  return {
    service,
    deleteS3Keys,
    documentsService,
    db,
    dbtxDelete,
    dbtxDeleteWhere,
    getLastSetValues: () => lastSetValues,
    wasDbTxStarted: () => dbTxStarted,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TransactionsService.updateSeniorIncome — receipt replace-with-delete (Task 2)', () => {
  it('calls dbtx.delete for old doc (DB row) when receiptDocumentId changes', async () => {
    const h = makeHarness({
      tx: { receiptDocumentId: 'old-doc-id', status: 'REJECTED' },
    })
    await h.service.updateSeniorIncome('tx-1', { receiptDocumentId: 'new-doc-id' }, SENIOR)
    // The delete call must happen inside the Drizzle transaction (dbtx), not via pool
    expect(h.dbtxDelete).toHaveBeenCalled()
  })

  it('does NOT call dbtx.delete when receiptDocumentId is unchanged', async () => {
    const h = makeHarness({
      tx: { receiptDocumentId: 'same-doc-id', status: 'REJECTED' },
    })
    await h.service.updateSeniorIncome('tx-1', { receiptDocumentId: 'same-doc-id' }, SENIOR)
    expect(h.dbtxDelete).not.toHaveBeenCalled()
  })

  it('does NOT call dbtx.delete when old receipt was null', async () => {
    const h = makeHarness({
      tx: { receiptDocumentId: null, status: 'REJECTED' },
    })
    await h.service.updateSeniorIncome('tx-1', { receiptDocumentId: 'new-doc-id' }, SENIOR)
    expect(h.dbtxDelete).not.toHaveBeenCalled()
  })

  it('resets status to PENDING and clears validation fields', async () => {
    const h = makeHarness({
      tx: {
        receiptDocumentId: 'old-doc-id',
        status: 'REJECTED',
        rejectionReason: 'Bad image',
        validatedBy: 'acc-1',
        validatedAt: new Date('2026-01-01'),
      },
    })
    await h.service.updateSeniorIncome('tx-1', { receiptDocumentId: 'new-doc-id' }, SENIOR)
    const set = h.getLastSetValues()
    expect(set['status']).toBe('PENDING')
    expect(set['rejectionReason']).toBeNull()
    expect(set['validatedBy']).toBeNull()
    expect(set['validatedAt']).toBeNull()
  })

  it('throws ForbiddenException when caller is not the receiver', async () => {
    const h = makeHarness({ tx: { receiverId: SENIOR.id, status: 'REJECTED' } })
    await expect(
      h.service.updateSeniorIncome('tx-1', { receiptDocumentId: 'new-doc-id' }, SENIOR2),
    ).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('throws BadRequestException when status is not REJECTED', async () => {
    const h = makeHarness({ tx: { status: 'PENDING' } })
    await expect(
      h.service.updateSeniorIncome('tx-1', { receiptDocumentId: 'new-doc-id' }, SENIOR),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('throws NotFoundException when tx not found', async () => {
    const h = makeHarness()
    ;(h.db.db.query.transactions.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    await expect(
      h.service.updateSeniorIncome('tx-1', { receiptDocumentId: 'new-doc-id' }, SENIOR),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it('calls deleteS3Keys post-commit when switching to external URL (old doc gets removed)', async () => {
    const h = makeHarness({
      tx: { receiptDocumentId: 'old-doc-id', receiptExternalUrl: null, status: 'REJECTED' },
      doc: { id: 'old-doc-id', s3Key: 'documents/RECEIPT/senior-1/old-doc.pdf' },
    })
    // Providing receiptExternalUrl (XOR) — old doc receipt is replaced with URL
    await h.service.updateSeniorIncome(
      'tx-1',
      { receiptExternalUrl: 'https://etherscan.io/tx/0xabc' },
      SENIOR,
    )
    // DB delete inside dbtx
    expect(h.dbtxDelete).toHaveBeenCalled()
    // S3 cleanup post-commit via deleteS3Keys
    expect(h.deleteS3Keys).toHaveBeenCalledWith('documents/RECEIPT/senior-1/old-doc.pdf', null)
  })

  it('calls deleteS3Keys with correct old S3 key post-commit when doc changes', async () => {
    const h = makeHarness({
      tx: { receiptDocumentId: 'old-doc-id', status: 'REJECTED' },
      doc: {
        id: 'old-doc-id',
        s3Key: 'documents/RECEIPT/senior-1/old-doc.pdf',
        thumbnailS3Key: null,
      },
    })
    await h.service.updateSeniorIncome('tx-1', { receiptDocumentId: 'new-doc-id' }, SENIOR)
    expect(h.deleteS3Keys).toHaveBeenCalledWith('documents/RECEIPT/senior-1/old-doc.pdf', null)
  })

  it('does NOT call deleteS3Keys when there is no old doc to replace', async () => {
    const h = makeHarness({
      tx: { receiptDocumentId: null, status: 'REJECTED' },
    })
    await h.service.updateSeniorIncome('tx-1', { receiptDocumentId: 'new-doc-id' }, SENIOR)
    expect(h.deleteS3Keys).not.toHaveBeenCalled()
  })

  it('uses a DB transaction (atomic) for the receipt replace', async () => {
    const h = makeHarness({
      tx: { receiptDocumentId: 'old-doc-id', status: 'REJECTED' },
    })
    await h.service.updateSeniorIncome('tx-1', { receiptDocumentId: 'new-doc-id' }, SENIOR)
    expect(h.wasDbTxStarted()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// HIGH-1 IDOR guard — unit tests for assertReceiptDocumentBindable
// ---------------------------------------------------------------------------
//
// These tests verify the ownership + category guard that runs BEFORE
// the FK write in updateSeniorIncome (and other create/update methods).
// They use a harness where documents.findFirst is keyed by docId.

// Harness that resolves documents by looking up the docId
// argument passed to db.query.documents.findFirst.
function makeIdorHarnessV2(opts: {
  txReceiptDocumentId?: string | null
  docsById: Record<
    string,
    | {
        id: string
        ownerId: string
        category: string
        s3Key: string
        thumbnailS3Key: string | null
      }
    | undefined
  >
}) {
  const txRow = {
    id: 'tx-idor',
    type: 'SENIOR_INCOME',
    status: 'REJECTED',
    receiverId: SENIOR.id,
    receiptDocumentId: opts.txReceiptDocumentId ?? null,
    receiptExternalUrl: null,
    amount: '1000',
    currency: 'USD',
    notes: null,
    rejectionReason: 'test',
    validatedBy: 'acc-1',
    validatedAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  }

  const dbtxDelete = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) })
  const deleteS3Keys = vi.fn().mockResolvedValue(undefined)

  // Track which docId was last queried so we can resolve from the map.
  let lastQueriedDocId: string | null = null

  const db = {
    db: {
      query: {
        transactions: {
          findFirst: vi.fn().mockImplementation(async () => ({ ...txRow })),
        },
        documents: {
          // The service calls: db.db.query.documents.findFirst({ where: eq(documents.id, docId) })
          // We capture the docId by inspecting the call arguments to the mock.
          // Since Drizzle eq() returns an opaque SQL object, we intercept via
          // a tracking mechanism: the mock captures the last docId via closure.
          findFirst: vi.fn().mockImplementation(async () => {
            if (lastQueriedDocId === null) return undefined
            return opts.docsById[lastQueriedDocId] ?? undefined
          }),
        },
      },
      transaction: vi.fn().mockImplementation(async (cb: (dbtx: unknown) => Promise<void>) => {
        const dbtx = {
          update: (_table: unknown) => ({
            set: (_values: unknown) => ({ where: async () => undefined }),
          }),
          delete: dbtxDelete,
        }
        await cb(dbtx)
      }),
    },
  }

  const service = makeTransactionsService({
    db: db as never,
    documentsService: { deleteS3Keys } as never as DocumentsService,
  })
  vi.spyOn(service, 'findOne' as never).mockResolvedValue({
    id: 'tx-idor',
    status: 'PENDING',
  } as never)

  // Expose setter so caller can prime docId before calling service method
  return {
    service,
    db,
    dbtxDelete,
    setNextDocId: (id: string | null) => {
      lastQueriedDocId = id
    },
  }
}

describe('HIGH-1 IDOR guard — assertReceiptDocumentBindable (unit)', () => {
  it('blocks: SENIOR cannot bind a RECEIPT owned by another user (ForbiddenException)', async () => {
    const h = makeIdorHarnessV2({
      txReceiptDocumentId: null,
      docsById: {
        'victim-doc-id': {
          id: 'victim-doc-id',
          ownerId: SENIOR2.id, // belongs to a different senior
          category: 'RECEIPT',
          s3Key: 'documents/RECEIPT/senior-2/victim.pdf',
          thumbnailS3Key: null,
        },
      },
    })

    // Prime the doc resolver — the service will call documents.findFirst for 'victim-doc-id'
    h.setNextDocId('victim-doc-id')

    await expect(
      h.service.updateSeniorIncome('tx-idor', { receiptDocumentId: 'victim-doc-id' }, SENIOR),
    ).rejects.toBeInstanceOf(ForbiddenException)

    // FK write must not have happened (dbtx.delete = proxy for whether transaction ran)
    expect(h.dbtxDelete).not.toHaveBeenCalled()
  })

  it('blocks: cannot bind a non-RECEIPT document (BadRequestException)', async () => {
    const h = makeIdorHarnessV2({
      txReceiptDocumentId: null,
      docsById: {
        'scan-doc-id': {
          id: 'scan-doc-id',
          ownerId: SENIOR.id, // owned by SENIOR — but wrong category
          category: 'SCAN',
          s3Key: 'documents/SCAN/senior-1/scan.pdf',
          thumbnailS3Key: null,
        },
      },
    })
    h.setNextDocId('scan-doc-id')

    await expect(
      h.service.updateSeniorIncome('tx-idor', { receiptDocumentId: 'scan-doc-id' }, SENIOR),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('blocks: cannot bind a nonexistent document (NotFoundException)', async () => {
    const h = makeIdorHarnessV2({
      txReceiptDocumentId: null,
      docsById: {}, // empty — doc not found
    })
    h.setNextDocId('ghost-doc-id')

    await expect(
      h.service.updateSeniorIncome('tx-idor', { receiptDocumentId: 'ghost-doc-id' }, SENIOR),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it('allows: SENIOR can bind their own RECEIPT (no exception)', async () => {
    const h = makeIdorHarnessV2({
      txReceiptDocumentId: null,
      docsById: {
        'own-doc-id': {
          id: 'own-doc-id',
          ownerId: SENIOR.id, // owned by the caller
          category: 'RECEIPT',
          s3Key: 'documents/RECEIPT/senior-1/own.pdf',
          thumbnailS3Key: null,
        },
      },
    })
    h.setNextDocId('own-doc-id')

    await expect(
      h.service.updateSeniorIncome('tx-idor', { receiptDocumentId: 'own-doc-id' }, SENIOR),
    ).resolves.toBeDefined()
  })

  it('skips guard when receiptDocumentId is null (clearing the receipt)', async () => {
    // Clearing receipt to null must not trigger the guard (no ownership check needed)
    const h = makeIdorHarnessV2({
      txReceiptDocumentId: 'old-own-doc',
      docsById: {
        'old-own-doc': {
          id: 'old-own-doc',
          ownerId: SENIOR.id,
          category: 'RECEIPT',
          s3Key: 'documents/RECEIPT/senior-1/old.pdf',
          thumbnailS3Key: null,
        },
      },
    })
    h.setNextDocId('old-own-doc')

    // Passing null clears the receipt — guard should not fire on null
    await expect(
      h.service.updateSeniorIncome('tx-idor', { receiptDocumentId: null }, SENIOR),
    ).resolves.toBeDefined()
  })
})
