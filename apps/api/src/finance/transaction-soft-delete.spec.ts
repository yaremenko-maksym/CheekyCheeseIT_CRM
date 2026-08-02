/**
 * Unit tests (mocked db, no Postgres) for task-soft-delete-and-money-audit —
 * the `adminDeleteTransaction` / `restoreTransaction` mechanics themselves:
 * RBAC, mandatory reason, the existing delete-restriction rules (kept as-is),
 * the NEW pending_obligations source-row guard, and the DELETE/RESTORE
 * journal writes (including impersonation attribution).
 *
 * AC1: delete marks the row, never physically removes it. Reason mandatory.
 * AC5: journal entry written, attribution corrected under impersonation.
 * AC6: restore is ADMIN-only and journaled.
 *
 * RBAC visibility (AC2/AC3) and the balance-regression proof (AC4) are
 * covered separately by real-DB integration specs — a mocked db cannot
 * honestly prove either (see transaction-soft-delete-visibility.rbac
 * .integration.spec.ts and transaction-soft-delete-balance-regression
 * .integration.spec.ts).
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

const ADMIN_ID = 'aaaa0000-0000-4000-8000-00000000a001'
const REAL_ADMIN_ID = 'aaaa0000-0000-4000-8000-00000000a002'
const ACCOUNTANT_ID = 'aaaa0000-0000-4000-8000-00000000a003'
const SENIOR_ID = 'aaaa0000-0000-4000-8000-00000000a004'
const TX_ID = 'bbbb0000-0000-4000-8000-00000000b001'

const ADMIN_USER: SessionUser = {
  id: ADMIN_ID,
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'admin@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

/** ADMIN impersonating a SENIOR — `id` is the target, `impersonatorId` the real admin. */
const IMPERSONATED_ADMIN_USER: SessionUser = {
  id: SENIOR_ID,
  role: 'SENIOR',
  displayName: 'Senior (impersonated)',
  email: 'senior@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
  impersonatorId: REAL_ADMIN_ID,
}

const ACCOUNTANT_USER: SessionUser = {
  id: ACCOUNTANT_ID,
  role: 'ACCOUNTANT',
  displayName: 'Accountant',
  email: 'accountant@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

const SENIOR_USER: SessionUser = {
  id: SENIOR_ID,
  role: 'SENIOR',
  displayName: 'Senior',
  email: 'senior2@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

function makeTxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TX_ID,
    type: 'EXPENSE' as const,
    status: 'PAID' as const,
    amount: '500',
    currency: 'USDT' as const,
    payoutRequestId: null,
    deletedAt: null,
    deletedBy: null,
    deletionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

/**
 * Builds a mocked DatabaseService whose `db.transaction(fn)` runs `fn` with a
 * `dbtx` exposing spy-able `update`/`insert` chains, so tests can assert
 * exactly what was written without a real Postgres connection.
 */
function makeDb(opts: {
  txRow: ReturnType<typeof makeTxRow> | undefined
  obligationRow?: { id: string } | null
  /** Second+ call to `query.transactions.findFirst` (used by `findOne` after
   *  the mutation) — defaults to the post-mutation shape of `txRow`. */
  refetchRow?: Record<string, unknown>
}) {
  // security-review PR #456 (MED-1): production now chains
  // `.where(...).returning(...)` and checks the affected row count (delete↔
  // write TOCTOU close) — the mock chain must expose `.returning()` too.
  const updateWhereMock = vi.fn().mockReturnValue({
    returning: vi.fn().mockResolvedValue([{ id: TX_ID }]),
  })
  const updateSetMock = vi.fn().mockReturnValue({ where: updateWhereMock })
  const dbtxUpdateMock = vi.fn().mockReturnValue({ set: updateSetMock })
  const dbtxInsertValuesMock = vi.fn().mockResolvedValue([])
  const dbtxInsertMock = vi.fn().mockReturnValue({ values: dbtxInsertValuesMock })
  const deleteMock = vi.fn()

  const findFirstMock = vi
    .fn()
    .mockResolvedValueOnce(opts.txRow) // guard fetch inside adminDeleteTransaction/restoreTransaction
    .mockResolvedValue(
      opts.refetchRow ?? {
        ...opts.txRow,
        sender: null,
        receiver: null,
        project: null,
        payoutRequest: null,
      },
    ) // findOne's enrichment fetch(es) afterwards

  // security-review PR #456 (MED-1): the pending_obligations re-check now runs
  // INSIDE the transaction (on `dbtx.query`, not `this.db.db.query`) to shrink
  // the create-obligation↔delete race window — the mocked `dbtx` must expose
  // the same `query.pendingObligations.findFirst` the outer `db` does.
  const dbtxPendingObligationsFindFirstMock = vi.fn().mockResolvedValue(opts.obligationRow ?? null)
  const transactionMock = vi.fn().mockImplementation((fn: (dbtx: unknown) => Promise<unknown>) =>
    fn({
      update: dbtxUpdateMock,
      insert: dbtxInsertMock,
      query: {
        pendingObligations: { findFirst: dbtxPendingObligationsFindFirstMock },
      },
    }),
  )

  const db = {
    db: {
      query: {
        transactions: { findFirst: findFirstMock, findMany: vi.fn().mockResolvedValue([]) },
        pendingObligations: {
          findFirst: vi.fn().mockResolvedValue(opts.obligationRow ?? null),
        },
      },
      transaction: transactionMock,
      delete: deleteMock,
    },
  } as never

  return {
    db,
    updateSetMock,
    dbtxUpdateMock,
    dbtxInsertMock,
    dbtxInsertValuesMock,
    deleteMock,
    transactionMock,
    findFirstMock,
  }
}

function makeService(mocks: ReturnType<typeof makeDb>) {
  return makeTransactionsService({ db: mocks.db })
}

// ─────────────────────────────────────────────────────────────────────────────
// adminDeleteTransaction
// ─────────────────────────────────────────────────────────────────────────────

describe('adminDeleteTransaction — RBAC + mandatory reason', () => {
  it('rejects a non-ADMIN caller with ForbiddenException, DB never touched', async () => {
    const mocks = makeDb({ txRow: makeTxRow() })
    const svc = makeService(mocks)

    await expect(svc.adminDeleteTransaction(TX_ID, 'valid reason', SENIOR_USER)).rejects.toThrow(
      ForbiddenException,
    )
    expect(mocks.findFirstMock).not.toHaveBeenCalled()
  })

  it('rejects ACCOUNTANT — delete is ADMIN-only (visibility ≠ delete rights)', async () => {
    const mocks = makeDb({ txRow: makeTxRow() })
    const svc = makeService(mocks)

    await expect(
      svc.adminDeleteTransaction(TX_ID, 'valid reason', ACCOUNTANT_USER),
    ).rejects.toThrow(ForbiddenException)
  })

  it('rejects a blank reason with BadRequestException, DB never queried', async () => {
    const mocks = makeDb({ txRow: makeTxRow() })
    const svc = makeService(mocks)

    await expect(svc.adminDeleteTransaction(TX_ID, '   ', ADMIN_USER)).rejects.toThrow(
      BadRequestException,
    )
    expect(mocks.findFirstMock).not.toHaveBeenCalled()
  })

  it('throws NotFoundException when the transaction does not exist', async () => {
    const mocks = makeDb({ txRow: undefined })
    const svc = makeService(mocks)

    await expect(svc.adminDeleteTransaction(TX_ID, 'valid reason', ADMIN_USER)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('rejects an already-deleted transaction with BadRequestException (no double-delete)', async () => {
    const mocks = makeDb({ txRow: makeTxRow({ deletedAt: new Date() }) })
    const svc = makeService(mocks)

    await expect(svc.adminDeleteTransaction(TX_ID, 'valid reason', ADMIN_USER)).rejects.toThrow(
      BadRequestException,
    )
    expect(mocks.transactionMock).not.toHaveBeenCalled()
  })

  // Existing restrictions — must survive the hard→soft migration byte-for-byte.
  for (const type of ['PAYOUT', 'PAYOUT_ADMIN', 'PAYOUT_CONFIRMED']) {
    it(`still rejects deleting a ${type} row (kept as-is)`, async () => {
      const mocks = makeDb({ txRow: makeTxRow({ type }) })
      const svc = makeService(mocks)

      await expect(svc.adminDeleteTransaction(TX_ID, 'valid reason', ADMIN_USER)).rejects.toThrow(
        BadRequestException,
      )
      expect(mocks.transactionMock).not.toHaveBeenCalled()
    })
  }

  it('still rejects a transaction linked to a payout request (kept as-is)', async () => {
    const mocks = makeDb({ txRow: makeTxRow({ payoutRequestId: 'pr-1' }) })
    const svc = makeService(mocks)

    await expect(svc.adminDeleteTransaction(TX_ID, 'valid reason', ADMIN_USER)).rejects.toThrow(
      BadRequestException,
    )
    expect(mocks.transactionMock).not.toHaveBeenCalled()
  })

  // NEW guard — replicates the protection `pending_obligations
  // .source_transaction_id`'s `ON DELETE RESTRICT` gave for free under the
  // OLD hard-delete regime (see the guard's doc in transactions.service.ts).
  it('rejects deleting a transaction that is the source of a company obligation (NEW guard)', async () => {
    const mocks = makeDb({
      txRow: makeTxRow({ type: 'SENIOR_PENDING_PAYOUT' }),
      obligationRow: { id: 'obligation-1' },
    })
    const svc = makeService(mocks)

    await expect(svc.adminDeleteTransaction(TX_ID, 'valid reason', ADMIN_USER)).rejects.toThrow(
      BadRequestException,
    )
    // security-review PR #456 (MED-1): the obligation re-check moved INSIDE
    // db.transaction (right before the UPDATE) to shrink the create-obligation
    // ↔ delete race window — the transaction callback now DOES run (and
    // throws from inside it), it just never reaches the UPDATE/journal insert.
    expect(mocks.transactionMock).toHaveBeenCalledTimes(1)
    expect(mocks.dbtxUpdateMock).not.toHaveBeenCalled()
    expect(mocks.dbtxInsertMock).not.toHaveBeenCalled()
  })
})

describe('adminDeleteTransaction — soft-delete mechanics + journal (AC1, AC5)', () => {
  it('marks the row (deletedAt/deletedBy/deletionReason) instead of physically deleting it', async () => {
    const mocks = makeDb({ txRow: makeTxRow() })
    const svc = makeService(mocks)

    const result = await svc.adminDeleteTransaction(TX_ID, '  Ошибочная транзакция  ', ADMIN_USER)

    expect(result).toEqual({ deleted: true })
    // AC1: the hard `db.delete(transactions)` call is GONE.
    expect(mocks.deleteMock).not.toHaveBeenCalled()
    // The soft-delete UPDATE runs inside db.transaction (atomic with the journal).
    expect(mocks.transactionMock).toHaveBeenCalledTimes(1)
    expect(mocks.dbtxUpdateMock).toHaveBeenCalledTimes(1)
    const setArg = mocks.updateSetMock.mock.calls[0]![0] as Record<string, unknown>
    expect(setArg['deletedAt']).toBeInstanceOf(Date)
    expect(setArg['deletedBy']).toBe(ADMIN_ID)
    // Reason is trimmed before storage.
    expect(setArg['deletionReason']).toBe('Ошибочная транзакция')
  })

  it('writes exactly one DELETE journal entry, atomically with the state change', async () => {
    const mocks = makeDb({ txRow: makeTxRow({ type: 'EXPENSE', amount: '777', currency: 'USD' }) })
    const svc = makeService(mocks)

    await svc.adminDeleteTransaction(TX_ID, 'test reason', ADMIN_USER)

    expect(mocks.dbtxInsertMock).toHaveBeenCalledTimes(1)
    const insertArg = mocks.dbtxInsertValuesMock.mock.calls[0]![0] as Record<string, unknown>
    expect(insertArg['action']).toBe('DELETE')
    expect(insertArg['targetId']).toBe(TX_ID)
    expect(insertArg['actorId']).toBe(ADMIN_ID)
    const metadata = insertArg['metadata'] as Record<string, unknown>
    expect(metadata['reason']).toBe('test reason')
    expect(metadata['type']).toBe('EXPENSE')
    expect(metadata['amount']).toBe('777')
    expect(metadata['currency']).toBe('USD')
  })

  it('attributes the journal entry to the REAL admin under impersonation, not the impersonated target', async () => {
    // adminDeleteTransaction is ADMIN-only, so the only reachable
    // impersonation scenario is an ADMIN impersonating ANOTHER ADMIN — the
    // effective session always carries the TARGET's role.
    const impersonatedButAdmin: SessionUser = {
      ...IMPERSONATED_ADMIN_USER,
      id: ADMIN_ID,
      role: 'ADMIN',
    }
    const mocks = makeDb({ txRow: makeTxRow() })
    const svc = makeService(mocks)

    await svc.adminDeleteTransaction(TX_ID, 'impersonated delete', impersonatedButAdmin)

    const insertArg = mocks.dbtxInsertValuesMock.mock.calls[0]![0] as Record<string, unknown>
    expect(insertArg['actorId']).toBe(REAL_ADMIN_ID)
    expect(insertArg['actorId']).not.toBe(ADMIN_ID)
    const setArg = mocks.updateSetMock.mock.calls[0]![0] as Record<string, unknown>
    expect(setArg['deletedBy']).toBe(REAL_ADMIN_ID)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// restoreTransaction
// ─────────────────────────────────────────────────────────────────────────────

describe('restoreTransaction — RBAC + mandatory reason (AC6)', () => {
  it('rejects a non-ADMIN caller (ACCOUNTANT can see, not restore)', async () => {
    const mocks = makeDb({ txRow: makeTxRow({ deletedAt: new Date() }) })
    const svc = makeService(mocks)

    await expect(svc.restoreTransaction(TX_ID, 'valid reason', ACCOUNTANT_USER)).rejects.toThrow(
      ForbiddenException,
    )
    expect(mocks.findFirstMock).not.toHaveBeenCalled()
  })

  it('rejects a blank reason with BadRequestException', async () => {
    const mocks = makeDb({ txRow: makeTxRow({ deletedAt: new Date() }) })
    const svc = makeService(mocks)

    await expect(svc.restoreTransaction(TX_ID, '', ADMIN_USER)).rejects.toThrow(BadRequestException)
    expect(mocks.findFirstMock).not.toHaveBeenCalled()
  })

  it('throws NotFoundException when the transaction does not exist', async () => {
    const mocks = makeDb({ txRow: undefined })
    const svc = makeService(mocks)

    await expect(svc.restoreTransaction(TX_ID, 'valid reason', ADMIN_USER)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('rejects restoring a transaction that is not deleted', async () => {
    const mocks = makeDb({ txRow: makeTxRow({ deletedAt: null }) })
    const svc = makeService(mocks)

    await expect(svc.restoreTransaction(TX_ID, 'valid reason', ADMIN_USER)).rejects.toThrow(
      BadRequestException,
    )
    expect(mocks.transactionMock).not.toHaveBeenCalled()
  })
})

describe('restoreTransaction — mechanics + journal (AC1, AC6)', () => {
  it('clears deletedAt/deletedBy/deletionReason and writes exactly one RESTORE journal entry', async () => {
    const mocks = makeDb({
      txRow: makeTxRow({
        deletedAt: new Date(),
        deletedBy: ADMIN_ID,
        deletionReason: 'старая причина',
      }),
    })
    const svc = makeService(mocks)

    await svc.restoreTransaction(TX_ID, '  вернули по ошибке  ', ADMIN_USER)

    expect(mocks.transactionMock).toHaveBeenCalledTimes(1)
    const setArg = mocks.updateSetMock.mock.calls[0]![0] as Record<string, unknown>
    expect(setArg['deletedAt']).toBeNull()
    expect(setArg['deletedBy']).toBeNull()
    expect(setArg['deletionReason']).toBeNull()

    expect(mocks.dbtxInsertMock).toHaveBeenCalledTimes(1)
    const insertArg = mocks.dbtxInsertValuesMock.mock.calls[0]![0] as Record<string, unknown>
    expect(insertArg['action']).toBe('RESTORE')
    expect(insertArg['targetId']).toBe(TX_ID)
    expect(insertArg['actorId']).toBe(ADMIN_ID)
    const metadata = insertArg['metadata'] as Record<string, unknown>
    expect(metadata['reason']).toBe('вернули по ошибке')
    expect(metadata['previousDeletionReason']).toBe('старая причина')
  })

  it('attributes the RESTORE journal entry to the REAL admin under impersonation', async () => {
    // ADMIN restoring while impersonating requires role==='ADMIN' on the
    // effective session — impersonation always carries the TARGET's role, so
    // this scenario is only reachable if an ADMIN impersonates another ADMIN.
    const impersonatedButAdmin: SessionUser = {
      ...IMPERSONATED_ADMIN_USER,
      id: ADMIN_ID,
      role: 'ADMIN',
    }
    const mocks = makeDb({ txRow: makeTxRow({ deletedAt: new Date() }) })
    const svc = makeService(mocks)

    await svc.restoreTransaction(TX_ID, 'restore under impersonation', impersonatedButAdmin)

    const insertArg = mocks.dbtxInsertValuesMock.mock.calls[0]![0] as Record<string, unknown>
    expect(insertArg['actorId']).toBe(REAL_ADMIN_ID)
  })
})
