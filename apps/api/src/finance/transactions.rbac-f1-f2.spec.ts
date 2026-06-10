/**
 * RBAC regression tests for F1 (HR salary leak) and F2 (payout-request IDOR).
 *
 * F1 — HR sees only own transactions, NOT all SALARY-type rows.
 * F2 — HR and JUNIOR cannot access payout requests via findPayoutRequest.
 *
 * TDD: RED first (before fixes land). After fixes, all tests turn GREEN.
 *
 * Harness follows the same pattern as transactions.get-summary.spec.ts:
 *   - DatabaseService stub with db.query.<entity>.findFirst/findMany mocks.
 *   - No real Postgres connection.
 *   - Never mock the method under test itself.
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { TransactionsService } from './transactions.service'

// ── Helpers ──────────────────────────────────────────────────────────────────

function user(role: SessionUser['role'], id = `${role.toLowerCase()}-id`): SessionUser {
  return {
    id,
    role,
    displayName: `Test ${role}`,
    email: `${id}@test.com`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
  }
}

type TxStub = {
  id: string
  type: string
  status: string
  amount: string
  currency: string
  senderId: string | null
  receiverId: string | null
  projectId: string | null
  createdAt: Date
  [k: string]: unknown
}

function makeTx(overrides: Partial<TxStub>): TxStub {
  return {
    id: `tx-${Math.random().toString(36).slice(2)}`,
    type: 'SALARY',
    status: 'PAID',
    amount: '1000',
    currency: 'USDT',
    senderId: null,
    receiverId: null,
    projectId: null,
    createdAt: new Date(),
    ...overrides,
  }
}

/** Build a minimal TransactionsService stub with controlled tx list.
 *  findMany always returns all rows (RBAC filtering is done inside the service).
 */
function makeServiceWithTxs(txs: TxStub[]): TransactionsService {
  const dbStub = {
    db: {
      query: {
        transactions: {
          findMany: () =>
            Promise.resolve(
              txs.map((tx) => ({
                ...tx,
                sender: tx.senderId ? { displayName: `sender-${tx.senderId}` } : null,
                receiver: tx.receiverId ? { displayName: `receiver-${tx.receiverId}` } : null,
                project: tx.projectId ? { name: `project-${tx.projectId}` } : null,
              })),
            ),
        },
        users: {
          findMany: () => Promise.resolve([]),
        },
        payoutRequests: {
          findFirst: () => Promise.resolve(null),
        },
      },
    },
  }
  return new TransactionsService(dbStub as never, {} as never)
}

/** Build a stub where findPayoutRequest can return a controlled payout-request row. */
function makeServiceWithPayoutRequest(
  req: {
    id: string
    seniorId: string
    incomeAmount: string
    payableAmount: string
    contractAddress: string | null
    txHash: string | null
    status: string
    createdAt: Date
    updatedAt: Date
  } | null,
): TransactionsService {
  const dbStub = {
    db: {
      query: {
        transactions: {
          findMany: () => Promise.resolve([]),
        },
        users: {
          findMany: () => Promise.resolve([]),
        },
        payoutRequests: {
          findFirst: () =>
            Promise.resolve(
              req
                ? {
                    ...req,
                    senior: { displayName: 'Test Senior' },
                    transactions: [],
                  }
                : null,
            ),
        },
      },
    },
  }
  return new TransactionsService(dbStub as never, {} as never)
}

// ── F1: HR salary leak ────────────────────────────────────────────────────────

const HR_ID = 'hr-id'
const FOREIGN_SENIOR_ID = 'senior-foreign-id'
const FOREIGN_JUNIOR_ID = 'junior-foreign-id'

describe('F1 — HR salary leak: findAll', () => {
  it('HR does NOT see SALARY transactions where they are neither sender nor receiver', async () => {
    // A SALARY payment to a foreign junior — HR is not involved
    const foreignSalaryTx = makeTx({
      id: 'tx-foreign-salary',
      type: 'SALARY',
      receiverId: FOREIGN_JUNIOR_ID,
      senderId: FOREIGN_SENIOR_ID,
    })
    const svc = makeServiceWithTxs([foreignSalaryTx])
    const hr = user('HR', HR_ID)

    const result = await svc.findAll(hr)

    // HR must NOT receive salary transactions belonging to other users
    expect(result.find((t) => t.id === 'tx-foreign-salary')).toBeUndefined()
  })

  it('HR DOES see transactions where they are the receiver', async () => {
    const hrReceivesTx = makeTx({
      id: 'tx-hr-receiver',
      type: 'SALARY',
      receiverId: HR_ID,
      senderId: FOREIGN_SENIOR_ID,
    })
    const svc = makeServiceWithTxs([hrReceivesTx])
    const hr = user('HR', HR_ID)

    const result = await svc.findAll(hr)

    expect(result.find((t) => t.id === 'tx-hr-receiver')).toBeDefined()
  })

  it('HR DOES see transactions where they are the sender', async () => {
    const hrSendsTx = makeTx({
      id: 'tx-hr-sender',
      type: 'SALARY',
      senderId: HR_ID,
      receiverId: FOREIGN_JUNIOR_ID,
    })
    const svc = makeServiceWithTxs([hrSendsTx])
    const hr = user('HR', HR_ID)

    const result = await svc.findAll(hr)

    expect(result.find((t) => t.id === 'tx-hr-sender')).toBeDefined()
  })

  it('HR sees ONLY own transactions when multiple SALARY rows present', async () => {
    const txs = [
      makeTx({
        id: 'tx-own-receiver',
        type: 'SALARY',
        receiverId: HR_ID,
        senderId: FOREIGN_SENIOR_ID,
      }),
      makeTx({
        id: 'tx-foreign-1',
        type: 'SALARY',
        receiverId: FOREIGN_JUNIOR_ID,
        senderId: FOREIGN_SENIOR_ID,
      }),
      makeTx({
        id: 'tx-foreign-2',
        type: 'SENIOR_INCOME',
        receiverId: FOREIGN_SENIOR_ID,
        senderId: null,
      }),
    ]
    const svc = makeServiceWithTxs(txs)
    const hr = user('HR', HR_ID)

    const result = await svc.findAll(hr)

    // Must contain only the one tx where HR is receiver
    expect(result.length).toBe(1)
    expect(result[0]!.id).toBe('tx-own-receiver')
  })
})

// ── F2: payout-request IDOR ───────────────────────────────────────────────────

const SENIOR_ID = 'senior-id'
const ANOTHER_SENIOR_ID = 'another-senior-id'

const baseReq = {
  id: 'req-1',
  seniorId: SENIOR_ID,
  incomeAmount: '1000',
  payableAmount: '740',
  contractAddress: null,
  txHash: null,
  status: 'PENDING',
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('F2 — payout-request IDOR: findPayoutRequest', () => {
  it('HR gets ForbiddenException when accessing any payout request', async () => {
    const svc = makeServiceWithPayoutRequest(baseReq)
    const hr = user('HR')

    await expect(svc.findPayoutRequest('req-1', hr)).rejects.toThrow(ForbiddenException)
  })

  it('JUNIOR gets ForbiddenException when accessing any payout request', async () => {
    const svc = makeServiceWithPayoutRequest(baseReq)
    const junior = user('JUNIOR')

    await expect(svc.findPayoutRequest('req-1', junior)).rejects.toThrow(ForbiddenException)
  })

  it('SENIOR gets ForbiddenException when accessing another senior payout request', async () => {
    const svc = makeServiceWithPayoutRequest(baseReq) // req.seniorId = SENIOR_ID
    const otherSenior = user('SENIOR', ANOTHER_SENIOR_ID)

    await expect(svc.findPayoutRequest('req-1', otherSenior)).rejects.toThrow(ForbiddenException)
  })

  it('ADMIN can access any payout request', async () => {
    const svc = makeServiceWithPayoutRequest(baseReq)
    const admin = user('ADMIN')

    await expect(svc.findPayoutRequest('req-1', admin)).resolves.toBeDefined()
  })

  it('ACCOUNTANT can access any payout request', async () => {
    const svc = makeServiceWithPayoutRequest(baseReq)
    const accountant = user('ACCOUNTANT')

    await expect(svc.findPayoutRequest('req-1', accountant)).resolves.toBeDefined()
  })

  it('owner SENIOR can access their own payout request', async () => {
    const svc = makeServiceWithPayoutRequest(baseReq) // req.seniorId = SENIOR_ID
    const ownerSenior = user('SENIOR', SENIOR_ID)

    await expect(svc.findPayoutRequest('req-1', ownerSenior)).resolves.toBeDefined()
  })

  it('returns NotFoundException for non-existent payout request', async () => {
    const svc = makeServiceWithPayoutRequest(null) // no req found
    const admin = user('ADMIN')

    await expect(svc.findPayoutRequest('req-missing', admin)).rejects.toThrow(NotFoundException)
  })
})
