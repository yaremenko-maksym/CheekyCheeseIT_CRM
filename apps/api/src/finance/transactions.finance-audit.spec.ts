/**
 * Unit tests for the finance audit follow-ups (2026-06-28) that are cleanly
 * stub-testable WITHOUT a live DB:
 *
 *   #6  adminUpdateTransaction — reject money-field edits on a settled
 *       company-funded debit (SALARY / EXPENSE / SENIOR_INCOME, PAID,
 *       fundingSource=COMPANY_ACCOUNT). Metadata edits + non-company-funded /
 *       non-PAID rows stay editable.
 *   #7  createMonthlySalaries — resolve ANY admin as the `createdBy` author
 *       (no longer hardcoded to MAKSYM_ID); log + return when none exists.
 *   #11 paySalary (ADMIN_PERSONAL) — the PENDING→PAID flip is atomic; a lost race
 *       (0 rows updated) throws and does NOT fire a second invoice.
 *
 * BIZ-18-fix: adminUpdateTransaction — change-based guard (presence-based regression)
 *   Frontend always sends amount+currency in the PATCH body, even for receipt-only edits.
 *   Guard must block ONLY if a money-defining field actually CHANGES (new value ≠ stored value).
 *   Float-safe comparison: both sides rounded to 6 decimal places.
 *
 * The flows that need real transactional / FOR-UPDATE semantics (#3 cascade, #5
 * multi-project lock) are covered by the integration specs.
 */
import { BadRequestException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

function admin(id = 'admin-1'): SessionUser {
  return {
    id,
    role: 'ADMIN',
    displayName: 'Admin',
    email: 'admin@test.com',
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
  }
}

// ── #6: adminUpdateTransaction settled-company-funded guard ───────────────────
describe('adminUpdateTransaction — #6: settled company-funded edit guard', () => {
  function makeSvc(row: Record<string, unknown>) {
    const findOne = vi.fn().mockResolvedValue({ id: row.id })
    // security-review PR #456 (MED-1): adminUpdateTransaction's UPDATE now
    // chains `.returning(...)` and checks the affected row count — `updateSpy`
    // must resolve a non-empty array when called as the `.where()` step.
    const updateSpy = vi.fn().mockReturnValue({
      returning: () => Promise.resolve([{ id: row.id }]),
    })
    const dbStub = {
      db: {
        query: {
          transactions: { findFirst: () => Promise.resolve(row) },
        },
        update: () => ({ set: () => ({ where: updateSpy }) }),
        // MED-F (security-review round 4): the row write + registry claim now
        // share ONE transaction; run the callback against an equivalent handle
        // so `updateSpy` still observes the write.
        transaction: (cb: (dbtx: unknown) => Promise<unknown>) =>
          cb({
            update: () => ({ set: () => ({ where: updateSpy }) }),
            insert: () => ({ values: () => Promise.resolve() }),
          }),
      },
    }
    const svc = makeTransactionsService({ db: dbStub as never })
    // findOne is called at the end of the happy path; stub it so the allowed
    // edits resolve without touching the real read.
    ;(svc as unknown as { findOne: typeof findOne }).findOne = findOne
    return { svc, updateSpy }
  }

  const settledSalary = {
    id: 'tx-1',
    type: 'SALARY',
    status: 'PAID',
    fundingSource: 'COMPANY_ACCOUNT',
    amount: '500',
    currency: 'USD',
    payoutRequestId: null,
    receiverId: 'emp-1',
    receiptDocumentId: null,
    receiptExternalUrl: null,
  }

  it('rejects an amount edit on a PAID company-funded SALARY', async () => {
    const { svc } = makeSvc(settledSalary)
    await expect(
      svc.adminUpdateTransaction('tx-1', { amount: 999 }, admin()),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('rejects a currency edit on a PAID company-funded EXPENSE', async () => {
    const { svc } = makeSvc({ ...settledSalary, type: 'EXPENSE' })
    await expect(
      svc.adminUpdateTransaction('tx-1', { currency: 'EUR' }, admin()),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('rejects a salaryMonth edit on a PAID company-funded SENIOR_INCOME', async () => {
    const { svc } = makeSvc({ ...settledSalary, type: 'SENIOR_INCOME' })
    await expect(
      svc.adminUpdateTransaction('tx-1', { salaryMonth: '2026-01' }, admin()),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('ALLOWS a notes-only edit on a PAID company-funded SALARY (metadata not locked)', async () => {
    const { svc, updateSpy } = makeSvc(settledSalary)
    await expect(
      svc.adminUpdateTransaction('tx-1', { notes: 'hi' }, admin()),
    ).resolves.toBeDefined()
    expect(updateSpy).toHaveBeenCalled()
  })

  it('ALLOWS an amount edit on a PENDING company-funded SALARY (not settled)', async () => {
    const { svc, updateSpy } = makeSvc({ ...settledSalary, status: 'PENDING' })
    await expect(
      svc.adminUpdateTransaction('tx-1', { amount: 999 }, admin()),
    ).resolves.toBeDefined()
    expect(updateSpy).toHaveBeenCalled()
  })

  // BIZ-18: AC3 broadened the guard — ALL PAID transactions are now immutable
  // for money-defining fields (amount/currency/salaryMonth), not just
  // company-funded ones. A PAID admin-personal SALARY has already cleared
  // cash; retroactive amount edits would desync the ledger.
  it('BLOCKS an amount edit on a PAID admin-personal SALARY (BIZ-18 broadened guard)', async () => {
    const { svc } = makeSvc({ ...settledSalary, fundingSource: 'ADMIN_PERSONAL' })
    await expect(svc.adminUpdateTransaction('tx-1', { amount: 999 }, admin())).rejects.toThrow(
      BadRequestException,
    )
  })
})

// ── #7: createMonthlySalaries resolves ANY admin ──────────────────────────────
describe('createMonthlySalaries — #7: resolve any admin as author', () => {
  function makeSvc(opts: {
    employees: Array<{ id: string; monthlySalary: string | null }>
    juniors?: Array<{ id: string; monthlySalary: string | null }>
    admin: { id: string } | undefined
  }) {
    const insertValues = vi.fn()
    let findManyCall = 0
    const dbStub = {
      db: {
        query: {
          users: {
            // 1st findMany → HR/ACCOUNTANT employees; later findMany (juniors) → [].
            findMany: () => {
              findManyCall += 1
              return Promise.resolve(findManyCall === 1 ? opts.employees : (opts.juniors ?? []))
            },
            findFirst: () => Promise.resolve(opts.admin),
          },
          projects: { findMany: () => Promise.resolve([]) },
          projectMembers: { findMany: () => Promise.resolve([]) },
        },
        insert: () => ({
          values: (v: unknown) => {
            insertValues(v)
            // task-salary-month-gap-and-status (HIGH-1): createMonthlySalaries
            // now chains `.returning(...)` after `.onConflictDoNothing(...)`
            // — no test in this block passes an `actor`, so the resolved
            // value is inert; it just has to be chainable.
            return { onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }) }
          },
        }),
      },
    }
    const svc = makeTransactionsService({ db: dbStub as never })
    return { svc, insertValues }
  }

  it('uses a NON-MAKSYM admin id as createdBy and still inserts salary reminders', async () => {
    const NON_MAKSYM = 'some-other-admin-uuid'
    const { svc, insertValues } = makeSvc({
      employees: [{ id: 'hr-1', monthlySalary: '1500' }],
      admin: { id: NON_MAKSYM },
    })
    await svc.createMonthlySalaries('2099-11')
    expect(insertValues).toHaveBeenCalledTimes(1)
    expect(insertValues.mock.calls[0]![0]).toMatchObject({
      type: 'SALARY',
      receiverId: 'hr-1',
      createdBy: NON_MAKSYM,
    })
  })

  it('no admin present → logs error and creates NOTHING (does not throw)', async () => {
    const { svc, insertValues } = makeSvc({
      employees: [{ id: 'hr-1', monthlySalary: '1500' }],
      admin: undefined,
    })
    await expect(svc.createMonthlySalaries('2099-11')).resolves.toBeUndefined()
    expect(insertValues).not.toHaveBeenCalled()
  })
})

// ── BIZ-18-fix: adminUpdateTransaction — change-based guard ───────────────────
//
// Regression: the BIZ-18 guard blocked ANY PATCH that included amount/currency
// in the payload, even when those values were IDENTICAL to what is already stored.
// Frontend edit-form always sends the full form state (amount+currency+notes+receipt),
// so metadata-only edits on PAID rows were falsely rejected with 400.
//
// Fix: block ONLY if a money-defining field CHANGES (stored ≠ incoming).
// Float-safe: both sides normalised to Number(…).toFixed(6) for comparison.

describe('BIZ-18-fix — adminUpdateTransaction: change-based guard (not presence-based)', () => {
  // DB amount is stored as a numeric string with trailing zeros e.g. '233304.560000'
  const STORED_AMOUNT_STR = '233304.560000'
  const SAME_AMOUNT_NUM = 233304.56

  // Receipt document stub — matches the receiverId of paidAdminIncome so that
  // assertReceiptDocumentBindable (called when receiptDocumentId changes) passes.
  const RECEIPT_DOC_ID = 'doc-new-uuid'
  const RECEIVER_ID = 'recv-1'
  const receiptDocStub = {
    id: RECEIPT_DOC_ID,
    category: 'RECEIPT',
    ownerId: RECEIVER_ID,
  }

  function makeSvc(row: Record<string, unknown>) {
    const findOne = vi.fn().mockResolvedValue({ id: row['id'] })
    // security-review PR #456 (MED-1): see the sibling stub above — the
    // `.where()` step now needs a `.returning()` resolving a non-empty array.
    const updateSpy = vi.fn().mockReturnValue({
      returning: () => Promise.resolve([{ id: row['id'] }]),
    })
    const dbStub = {
      db: {
        query: {
          transactions: { findFirst: () => Promise.resolve(row) },
          // Required by assertReceiptDocumentBindable when receiptDocumentId changes.
          documents: { findFirst: () => Promise.resolve(receiptDocStub) },
        },
        update: () => ({ set: () => ({ where: updateSpy }) }),
        // MED-F (round 4): see the note on the sibling stub above.
        transaction: (cb: (dbtx: unknown) => Promise<unknown>) =>
          cb({
            update: () => ({ set: () => ({ where: updateSpy }) }),
            insert: () => ({ values: () => Promise.resolve() }),
          }),
      },
    }
    const svc = makeTransactionsService({ db: dbStub as never })
    ;(svc as unknown as { findOne: typeof findOne }).findOne = findOne
    return { svc, updateSpy }
  }

  const paidAdminIncome = {
    id: 'tx-biz18-001',
    type: 'ADMIN_INCOME',
    status: 'PAID',
    fundingSource: null,
    amount: STORED_AMOUNT_STR,
    currency: 'USD',
    payoutRequestId: null,
    receiverId: RECEIVER_ID,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    salaryMonth: null,
    notes: null,
    sender: null,
    receiver: null,
    project: null,
    payoutRequest: null,
  }

  // AC1 (RED on current code): PAID ADMIN_INCOME — payload sends same amount+currency
  // + new receiptDocumentId → must SUCCEED (metadata-only change, no money diff).
  it('PAID ADMIN_INCOME — same amount+currency + new receiptDocumentId → 200 (not 400)', async () => {
    const { svc, updateSpy } = makeSvc(paidAdminIncome)
    await expect(
      svc.adminUpdateTransaction(
        'tx-biz18-001',
        {
          amount: SAME_AMOUNT_NUM,
          currency: 'USD',
          receiptDocumentId: 'doc-new-uuid',
        },
        admin(),
      ),
    ).resolves.toBeDefined()
    expect(updateSpy).toHaveBeenCalled()
  })

  // AC2: PAID + truly different amount → must BLOCK (400).
  it('PAID ADMIN_INCOME — different amount in payload → 400', async () => {
    const { svc } = makeSvc(paidAdminIncome)
    await expect(
      svc.adminUpdateTransaction('tx-biz18-001', { amount: 999, currency: 'USD' }, admin()),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  // AC3: PAID + different currency → must BLOCK (400).
  it('PAID ADMIN_INCOME — different currency in payload → 400', async () => {
    const { svc } = makeSvc(paidAdminIncome)
    await expect(
      svc.adminUpdateTransaction(
        'tx-biz18-001',
        { amount: SAME_AMOUNT_NUM, currency: 'EUR' },
        admin(),
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  // AC4: PAID + different salaryMonth → must BLOCK (400).
  it('PAID ADMIN_INCOME — different salaryMonth in payload → 400', async () => {
    const { svc } = makeSvc({ ...paidAdminIncome, salaryMonth: '2026-01' })
    await expect(
      svc.adminUpdateTransaction('tx-biz18-001', { salaryMonth: '2026-02' }, admin()),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  // AC5: PENDING (not PAID) + changed amount → must SUCCEED.
  it('PENDING tx — different amount in payload → 200 (not settled)', async () => {
    const { svc, updateSpy } = makeSvc({ ...paidAdminIncome, status: 'PENDING' })
    await expect(
      svc.adminUpdateTransaction('tx-biz18-001', { amount: 999, currency: 'USD' }, admin()),
    ).resolves.toBeDefined()
    expect(updateSpy).toHaveBeenCalled()
  })

  // AC6 (float edge): DB stores '233304.560000', frontend sends 233304.56
  // → numerically identical → must SUCCEED (not considered a change).
  it('float-safe: DB "233304.560000" vs incoming 233304.56 → NOT a change → 200', async () => {
    const { svc, updateSpy } = makeSvc(paidAdminIncome)
    await expect(
      svc.adminUpdateTransaction(
        'tx-biz18-001',
        { amount: SAME_AMOUNT_NUM, currency: 'USD', notes: 'just updating notes' },
        admin(),
      ),
    ).resolves.toBeDefined()
    expect(updateSpy).toHaveBeenCalled()
  })
})

// ── #11: paySalary ADMIN_PERSONAL atomic flip ─────────────────────────────────
describe('paySalary — #11: ADMIN_PERSONAL atomic flip (no duplicate invoice)', () => {
  function makeSvc(updateReturning: Array<{ id: string }>) {
    const invoiceSpy = vi.fn().mockResolvedValue(undefined)
    const findOne = vi.fn().mockResolvedValue({ id: 'sal-1' })
    const dbStub = {
      db: {
        query: {
          transactions: {
            findFirst: () =>
              Promise.resolve({ id: 'sal-1', type: 'SALARY', status: 'PENDING', notes: null }),
          },
          users: {
            // payerAdmin resolution for ADMIN_PERSONAL.
            findFirst: () =>
              Promise.resolve({ id: 'admin-1', role: 'ADMIN', displayName: 'Admin' }),
          },
        },
        update: () => ({
          set: () => ({ where: () => ({ returning: () => Promise.resolve(updateReturning) }) }),
        }),
      },
    }
    const svc = makeTransactionsService({ db: dbStub as never })
    ;(svc as unknown as { safeAutoCreateInvoice: typeof invoiceSpy }).safeAutoCreateInvoice =
      invoiceSpy
    ;(svc as unknown as { findOne: typeof findOne }).findOne = findOne
    return { svc, invoiceSpy }
  }

  const payData = {
    fundingSource: 'ADMIN_PERSONAL' as const,
    payerAdminId: 'admin-1',
    currency: 'USD' as const,
    // task-receipts-backend: pay-time proof mandatory (USD → file/url).
    receiptExternalUrl: 'https://drive.google.com/f/receipt',
  }

  it('winner (1 row flipped) → fires exactly one invoice', async () => {
    const { svc, invoiceSpy } = makeSvc([{ id: 'sal-1' }])
    await expect(svc.paySalary('sal-1', payData, admin())).resolves.toBeDefined()
    expect(invoiceSpy).toHaveBeenCalledTimes(1)
  })

  it('loser of the race (0 rows flipped — already PAID) → throws, NO invoice', async () => {
    const { svc, invoiceSpy } = makeSvc([])
    await expect(svc.paySalary('sal-1', payData, admin())).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(invoiceSpy).not.toHaveBeenCalled()
  })

  // security-review round 2 (MED-1, mutation gate): the `selfPayError`
  // defense-in-depth guard (senderId === tx.receiverId) is not reachable
  // through legitimate role data today — verified by reading (not assuming)
  // both role-mutation doors: `UsersService.changeRole` and
  // `.adminUpdateUser` BOTH unconditionally refuse `role === 'ADMIN'`, so a
  // SALARY receiver (never ADMIN by construction) can never become the same
  // row as an ADMIN payer. Engineer the collision directly through the mock
  // (tx.receiverId === the ADMIN_PERSONAL payer's own id) so the guard's OWN
  // logic is exercised and provably fires — this kills the
  // ConditionalExpression mutant on `if (paySalarySelfPayErr) throw ...`, not
  // a claim that the scenario is reachable in production.
  it('tx.receiverId === payerAdminId (engineered) → BadRequestException, NO update/invoice', async () => {
    const invoiceSpy = vi.fn().mockResolvedValue(undefined)
    const findOne = vi.fn().mockResolvedValue({ id: 'sal-1' })
    const updateSpy = vi.fn()
    const dbStub = {
      db: {
        query: {
          transactions: {
            findFirst: () =>
              Promise.resolve({
                id: 'sal-1',
                type: 'SALARY',
                status: 'PENDING',
                notes: null,
                // Same id as the ADMIN_PERSONAL payer below — the collision.
                receiverId: 'admin-1',
              }),
          },
          users: {
            // Serves BOTH the archived-receiver check (receiverId='admin-1')
            // AND the ADMIN_PERSONAL payer resolution (payerAdminId='admin-1')
            // — same underlying row, on purpose (that IS the self-pay).
            findFirst: () =>
              Promise.resolve({
                id: 'admin-1',
                role: 'ADMIN',
                displayName: 'Admin',
                archivedAt: null,
              }),
          },
        },
        update: (..._args: unknown[]) => {
          updateSpy()
          return { set: () => ({ where: () => ({ returning: () => Promise.resolve([]) }) }) }
        },
      },
    }
    const svc = makeTransactionsService({ db: dbStub as never })
    ;(svc as unknown as { safeAutoCreateInvoice: typeof invoiceSpy }).safeAutoCreateInvoice =
      invoiceSpy
    ;(svc as unknown as { findOne: typeof findOne }).findOne = findOne

    await expect(svc.paySalary('sal-1', payData, admin())).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(updateSpy).not.toHaveBeenCalled()
    expect(invoiceSpy).not.toHaveBeenCalled()
  })
})
