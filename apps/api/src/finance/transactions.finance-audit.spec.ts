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
    const updateSpy = vi.fn()
    const dbStub = {
      db: {
        query: {
          transactions: { findFirst: () => Promise.resolve(row) },
        },
        update: () => ({ set: () => ({ where: updateSpy.mockResolvedValue(undefined) }) }),
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
            return { onConflictDoNothing: () => Promise.resolve(undefined) }
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
})
