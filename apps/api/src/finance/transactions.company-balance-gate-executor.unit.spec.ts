/**
 * WC-L2 — the company-account balance gate must read the ledger through the
 * SAME transaction that holds the advisory lock (MED-1 TOCTOU).
 *
 * `createExpense` and `paySalary` (company-funded) call
 * `computeCompanyAccountBalanceFromLedger(dbtx ?? this.db.db)` inside
 * `db.transaction(async (dbtx) => …)`. If the balance were read through the
 * pooled `this.db.db` connection instead of `dbtx`, the read would escape the
 * lock's serialized view and two concurrent debits could both pass the gate.
 *
 * Seam: the public service method; the ledger util is mocked and records WHICH
 * executor it was handed. Fully mocked db → runs in the unit job.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { DatabaseService } from '../database/database.service'
import type { SalaryService } from './salary.service'

const balanceMock = vi.hoisted(() => ({
  computeCompanyAccountBalanceFromLedger: vi.fn(),
  lockCompanyAccount: vi.fn(),
}))

vi.mock('./company-account-balance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./company-account-balance')>()),
  computeCompanyAccountBalanceFromLedger: balanceMock.computeCompanyAccountBalanceFromLedger,
  lockCompanyAccount: balanceMock.lockCompanyAccount,
}))

const ADMIN: SessionUser = {
  id: 'a8f4d3b1-0000-0000-0000-000000000001',
  email: 'admin@example.com',
  displayName: 'Admin',
  role: 'ADMIN',
}

const EXPLORER_URL = 'https://etherscan.io/tx/0xabc123def456'

// A distinct object per run: identity is the whole point of the assertion.
const DBTX = { __marker: 'dbtx', select: vi.fn() }
const POOLED_DB = { __marker: 'pooled-db' }

function makeDb(): DatabaseService {
  const db = {
    ...POOLED_DB,
    query: {
      transactions: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'tx-1',
          type: 'SALARY',
          status: 'PENDING',
          amount: '100.000000',
          currency: 'USD',
          receiverId: 'b9c5d2e1-0000-0000-0000-000000000002',
          deletedAt: null,
          notes: null,
          txDate: null,
          createdAt: new Date('2026-09-01T00:00:00Z'),
        }),
      },
    },
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(DBTX)),
  }
  return { db } as unknown as DatabaseService
}

describe('company-account balance gate reads through the locked transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Insufficient funds → the gate throws right after the read, so nothing
    // past the gate needs mocking.
    balanceMock.computeCompanyAccountBalanceFromLedger.mockResolvedValue(0)
    balanceMock.lockCompanyAccount.mockResolvedValue(undefined)
    DBTX.select.mockReturnValue({
      from: () => ({ where: () => Promise.resolve([{ status: 'PENDING' }]) }),
    })
  })

  it('createExpense (company-funded) hands the ledger util the transaction, not the pooled db', async () => {
    const svc = makeTransactionsService({ db: makeDb() })

    await expect(
      svc.createExpense(
        {
          amount: 50,
          currency: 'USDT',
          category: 'Hosting',
          receiptExternalUrl: EXPLORER_URL,
          fundingSource: 'COMPANY_ACCOUNT',
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS' } })

    expect(balanceMock.lockCompanyAccount).toHaveBeenCalledWith(DBTX)
    expect(balanceMock.computeCompanyAccountBalanceFromLedger).toHaveBeenCalledTimes(1)
    expect(balanceMock.computeCompanyAccountBalanceFromLedger.mock.calls[0]![0]).toBe(DBTX)
  })

  it('paySalary (company-funded) hands the ledger util the transaction, not the pooled db', async () => {
    const salaryService = {
      assertSalaryReceiverNotArchived: vi.fn().mockResolvedValue(undefined),
    } as unknown as SalaryService
    const svc = makeTransactionsService({ db: makeDb(), salaryService })

    await expect(
      svc.paySalary(
        'tx-1',
        {
          fundingSource: 'COMPANY_ACCOUNT',
          currency: 'USDT',
          receiptExternalUrl: EXPLORER_URL,
        },
        ADMIN,
      ),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS' } })

    expect(balanceMock.lockCompanyAccount).toHaveBeenCalledWith(DBTX)
    expect(balanceMock.computeCompanyAccountBalanceFromLedger).toHaveBeenCalledTimes(1)
    expect(balanceMock.computeCompanyAccountBalanceFromLedger.mock.calls[0]![0]).toBe(DBTX)
  })
})
