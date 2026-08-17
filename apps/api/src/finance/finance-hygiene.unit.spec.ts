/**
 * TDD unit tests for finance-hygiene-final findings:
 *
 * AC1 — BIZ-06: createAdminTransfer — ADMIN cannot debit a partner (MED)
 * AC2 — BIZ-12: EXPENSE must be PAID-gated in getAdminBalance / getSeniorBalance
 * AC3 — BIZ-18: adminUpdateTransaction blocks amount/currency on any settled (PAID) non-PAYOUT tx
 * AC4 — BIZ-17: updateDropIncome resubmit path for REJECTED DROP_INCOME
 * AC5 — SEC-13: assertCanReadAdminBalance scopes ADMIN to own balance only
 * AC7 — SEC-19: sign-schema uses .strict() (no passthrough)
 * AC8 — BIZ-21 (grab-bag):
 *   - income PAID-gated in getAdminBalance (ADMIN_INCOME types always PAID on creation — documented)
 *   - HrAccessService .limit(50) truncation
 */

import { BadRequestException, ForbiddenException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { BalanceService } from './balance.service'

// ── helpers ───────────────────────────────────────────────────────────────────

function makeRates(usdUah = '40.0000', eurUah = '44.0000') {
  return { usdUah, usdtUah: usdUah, eurUah, date: '20260531' }
}

interface MockTx {
  id?: string
  type: string
  status?: string
  amount: string
  currency: 'USDT' | 'USD' | 'EUR' | 'UAH'
  senderId?: string | null
  senderLabel?: string | null
  receiverId?: string | null
  receiverLabel?: string | null
  recipientId?: string | null
  projectId?: string | null
  fundingSource?: string | null
  payoutRequestId?: string | null
  notes?: string | null
  salaryMonth?: string | null
  txHash?: string | null
  validatedBy?: string | null
  validatedAt?: Date | null
  rejectionReason?: string | null
  createdBy?: string | null
  createdAt?: Date
  updatedAt?: Date
  // BIZ-04: null = net pass-through; number = gross, multiply by pct/100
  seniorSharePercent?: number | null
}

function makeTx(overrides: Partial<MockTx>): MockTx {
  return {
    id: `tx-${Math.random().toString(36).slice(2)}`,
    status: 'PAID',
    amount: '0',
    currency: 'USD',
    senderId: null,
    receiverId: null,
    recipientId: null,
    projectId: null,
    fundingSource: null,
    payoutRequestId: null,
    type: 'TOV_INCOME',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  }
}

function makeViewer(role: SessionUser['role'], id = `${role.toLowerCase()}-id`): SessionUser {
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

function makeBalanceService(transactions: MockTx[] = []): BalanceService {
  const db = {
    db: {
      query: {
        pendingObligations: { findMany: async () => [] },
      },
      // security-review PR #456 round 2: getAdminBalance/getSeniorBalance now
      // read the `nonDeletedTransactions` VIEW via `.select().from(...)`.
      select: () => ({
        from: async () => transactions,
      }),
    },
  } as never
  const nbu = { getRates: async () => makeRates() } as never
  return new BalanceService(db, nbu)
}

// ── AC2 — BIZ-12: EXPENSE must be PAID-gated ─────────────────────────────────

describe('AC2 BIZ-12 — EXPENSE PAID-gating in getAdminBalance', () => {
  const ADMIN_ID = 'admin-0000-0000-0000-000000000001'

  it('PENDING EXPENSE does NOT debit admin balance', async () => {
    const svc = makeBalanceService([
      makeTx({
        type: 'ADMIN_INCOME', // C-2 fix: this is the real, always-created type
        status: 'PAID',
        amount: '1000',
        currency: 'USD',
        recipientId: ADMIN_ID,
      }),
      makeTx({
        type: 'EXPENSE',
        status: 'PENDING',
        amount: '200',
        currency: 'USD',
        senderId: ADMIN_ID,
      }),
    ])
    const result = await svc.getAdminBalance(ADMIN_ID, 'USD')
    // PENDING EXPENSE must NOT reduce the balance
    expect(result.balance).toBeCloseTo(1000, 6)
    expect(result.breakdown.expenses).toBeCloseTo(0, 6)
  })

  it('PAID EXPENSE debits admin balance', async () => {
    const svc = makeBalanceService([
      makeTx({
        type: 'ADMIN_INCOME', // C-2 fix: this is the real, always-created type
        status: 'PAID',
        amount: '1000',
        currency: 'USD',
        recipientId: ADMIN_ID,
      }),
      makeTx({
        type: 'EXPENSE',
        status: 'PAID',
        amount: '200',
        currency: 'USD',
        senderId: ADMIN_ID,
      }),
    ])
    const result = await svc.getAdminBalance(ADMIN_ID, 'USD')
    expect(result.balance).toBeCloseTo(800, 6)
    expect(result.breakdown.expenses).toBeCloseTo(200, 6)
  })
})

describe('AC2 BIZ-12 — EXPENSE PAID-gating in getSeniorBalance', () => {
  const SENIOR_ID = 'senior-0000-0000-0000-000000000001'

  it('PENDING EXPENSE does NOT debit senior balance', async () => {
    const svc = makeBalanceService([
      makeTx({
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '1000',
        currency: 'USD',
        receiverId: SENIOR_ID,
        // BIZ-04: null seniorSharePercent means amount is already the net senior
        // share (settled by company); use as-is to avoid NaN from pct multiply.
        seniorSharePercent: null,
      }),
      makeTx({
        type: 'EXPENSE',
        status: 'PENDING',
        amount: '200',
        currency: 'USD',
        senderId: SENIOR_ID,
      }),
    ])
    const result = await svc.getSeniorBalance(SENIOR_ID, 'USD')
    expect(result.balance).toBeCloseTo(1000, 6)
    expect(result.breakdown.expenses).toBeCloseTo(0, 6)
  })

  it('PAID EXPENSE debits senior balance', async () => {
    const svc = makeBalanceService([
      makeTx({
        type: 'SENIOR_INCOME',
        status: 'PAID',
        amount: '1000',
        currency: 'USD',
        receiverId: SENIOR_ID,
        // BIZ-04: null → net pass-through (no pct multiply)
        seniorSharePercent: null,
      }),
      makeTx({
        type: 'EXPENSE',
        status: 'PAID',
        amount: '200',
        currency: 'USD',
        senderId: SENIOR_ID,
      }),
    ])
    const result = await svc.getSeniorBalance(SENIOR_ID, 'USD')
    expect(result.balance).toBeCloseTo(800, 6)
    expect(result.breakdown.expenses).toBeCloseTo(200, 6)
  })
})

// ── AC5 — SEC-13: assertCanReadAdminBalance scopes ADMIN to own balance ───────

describe('AC5 SEC-13 — assertCanReadAdminBalance: ADMIN scoped to own target', () => {
  const ADMIN_A_ID = 'admin-a-0000-0000-0000-000000000001'
  const ADMIN_B_ID = 'admin-b-0000-0000-0000-000000000002'

  it('ADMIN can read their OWN admin balance', () => {
    const svc = makeBalanceService()
    const viewer = makeViewer('ADMIN', ADMIN_A_ID)
    expect(() => svc.assertCanReadAdminBalance(viewer, ADMIN_A_ID)).not.toThrow()
  })

  it('ADMIN cannot read a DIFFERENT admin balance → ForbiddenException', () => {
    const svc = makeBalanceService()
    const viewer = makeViewer('ADMIN', ADMIN_A_ID)
    expect(() => svc.assertCanReadAdminBalance(viewer, ADMIN_B_ID)).toThrow(ForbiddenException)
  })

  it('ACCOUNTANT can read ANY admin balance (privileged reader)', () => {
    const svc = makeBalanceService()
    const viewer = makeViewer('ACCOUNTANT')
    expect(() => svc.assertCanReadAdminBalance(viewer, ADMIN_A_ID)).not.toThrow()
    expect(() => svc.assertCanReadAdminBalance(viewer, ADMIN_B_ID)).not.toThrow()
  })

  it('SENIOR cannot read admin balance → ForbiddenException', () => {
    const svc = makeBalanceService()
    expect(() => svc.assertCanReadAdminBalance(makeViewer('SENIOR'), ADMIN_A_ID)).toThrow(
      ForbiddenException,
    )
  })

  it('JUNIOR cannot read admin balance → ForbiddenException', () => {
    const svc = makeBalanceService()
    expect(() => svc.assertCanReadAdminBalance(makeViewer('JUNIOR'), ADMIN_A_ID)).toThrow(
      ForbiddenException,
    )
  })
})

// ── AC1 — BIZ-06: TransactionsService.createAdminTransfer ────────────────────
//
// Tested via a lightweight service stub because createAdminTransfer needs DB
// calls. We test the GUARD LOGIC separately using a mock that records which
// effectiveSenderId was used for the INSERT.
//
// Key invariant: ADMIN-caller MUST have effectiveSenderId forced to currentUser.id
// regardless of data.senderId supplied.

import { TransactionsService } from './transactions.service'

function makeAdminTransferService(
  userMap: Record<string, { id: string; role: string }>,
  capturedInserts: Array<{ senderId: string }>,
) {
  // Shared inserted-tx slot: set by insert().values() so findFirst (called by
  // findOne after insert) can return the same row with relation stubs.
  let lastInserted: Record<string, unknown> | null = null

  const db = {
    db: {
      query: {
        users: {
          findFirst: async ({ where }: { where: unknown }) => {
            // Drizzle eq() produces a circular PgTable AST — walk it manually
            // with a visited-set guard and collect all UUID strings encountered.
            const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            const visited = new Set<unknown>()
            function collectUuids(node: unknown): string[] {
              if (node === null || node === undefined) return []
              if (visited.has(node)) return []
              if (typeof node === 'string') return uuidRe.test(node) ? [node] : []
              if (typeof node !== 'object') return []
              visited.add(node)
              return Object.values(node as Record<string, unknown>).flatMap(collectUuids)
            }
            for (const id of collectUuids(where)) {
              if (userMap[id]) return userMap[id]
            }
            return null
          },
        },
        transactions: {
          findFirst: async () => {
            if (!lastInserted) return null
            // Return with the relation stubs findOne / assertReadAccess expect.
            return {
              ...lastInserted,
              sender: null,
              receiver: null,
              project: null,
              payoutRequest: null,
            }
          },
        },
      },
      insert: (_table: unknown) => ({
        values: (row: { senderId: string; receiverId?: string }) => {
          capturedInserts.push({ senderId: row.senderId })
          lastInserted = {
            id: 'new-tx-id',
            type: 'ADMIN_TRANSFER',
            status: 'PAID',
            amount: '100',
            currency: 'USDT',
            senderId: row.senderId,
            receiverId: row.receiverId ?? null,
            senderLabel: null,
            receiverLabel: null,
            payoutRequestId: null,
            projectId: null,
            fundingSource: null,
            notes: null,
            salaryMonth: null,
            txHash: null,
            validatedBy: null,
            validatedAt: null,
            rejectionReason: null,
            createdBy: null,
            seniorSharePercent: null,
            seniorSharePercentSource: null,
            receiptDocumentId: null,
            receiptExternalUrl: null,
            txDate: null,
            recipientId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }
          return {
            returning: async () => [lastInserted],
          }
        },
      }),
    },
  } as never

  const nbu = { getRates: async () => makeRates() } as never
  const etherscan = {} as never
  const invoices = {} as never
  const documents = {} as never
  return new TransactionsService(db, invoices, documents, nbu, etherscan)
}

describe('AC1 BIZ-06 — createAdminTransfer: ADMIN cannot debit a partner', () => {
  const ADMIN_A_ID = 'aaaaaaaa-0000-0000-0000-000000000001'
  const ADMIN_B_ID = 'bbbbbbbb-0000-0000-0000-000000000002'

  const userMap = {
    [ADMIN_A_ID]: { id: ADMIN_A_ID, role: 'ADMIN' },
    [ADMIN_B_ID]: { id: ADMIN_B_ID, role: 'ADMIN' },
  }

  it('ADMIN caller with senderId=partnerB must have effectiveSenderId forced to self', async () => {
    const captured: Array<{ senderId: string }> = []
    const svc = makeAdminTransferService(userMap, captured)
    const caller = makeViewer('ADMIN', ADMIN_A_ID)

    // Attempt: ADMIN_A passes senderId=ADMIN_B (tries to debit partner)
    await svc.createAdminTransfer(
      {
        senderId: ADMIN_B_ID,
        receiverId: ADMIN_B_ID,
        amount: 100,
        currency: 'USDT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xabc123',
      },
      caller,
    )
    // The INSERT must use ADMIN_A's id, not ADMIN_B's
    expect(captured[0]!.senderId).toBe(ADMIN_A_ID)
  })

  it('ADMIN caller without senderId uses self as sender', async () => {
    const captured: Array<{ senderId: string }> = []
    const svc = makeAdminTransferService(userMap, captured)
    const caller = makeViewer('ADMIN', ADMIN_A_ID)

    await svc.createAdminTransfer(
      {
        receiverId: ADMIN_B_ID,
        amount: 100,
        currency: 'USDT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xabc123',
      },
      caller,
    )
    expect(captured[0]!.senderId).toBe(ADMIN_A_ID)
  })

  it('ACCOUNTANT caller with senderId=ADMIN_A can book transfer FROM that admin', async () => {
    const captured: Array<{ senderId: string }> = []
    const svc = makeAdminTransferService(userMap, captured)
    const accountant = makeViewer('ACCOUNTANT', 'acct-0000-0000-0000-000000000003')

    await svc.createAdminTransfer(
      {
        senderId: ADMIN_A_ID,
        receiverId: ADMIN_B_ID,
        amount: 100,
        currency: 'USDT',
        receiptExternalUrl: 'https://etherscan.io/tx/0xabc123',
      },
      accountant,
    )
    expect(captured[0]!.senderId).toBe(ADMIN_A_ID)
  })

  it('ACCOUNTANT caller without senderId → BadRequestException', async () => {
    const captured: Array<{ senderId: string }> = []
    const svc = makeAdminTransferService(userMap, captured)
    const accountant = makeViewer('ACCOUNTANT', 'acct-0000-0000-0000-000000000003')

    await expect(
      svc.createAdminTransfer(
        { receiverId: ADMIN_B_ID, amount: 100, currency: 'USDT' },
        accountant,
      ),
    ).rejects.toThrow(BadRequestException)
  })
})

// ── AC3 — BIZ-18: adminUpdateTransaction blocks amount/currency on any PAID ───

describe('AC3 BIZ-18 — adminUpdateTransaction: blocks edits to PAID non-company-funded tx', () => {
  function makeTxServiceWithExistingTx(tx: Partial<MockTx>) {
    const fullTx = makeTx(tx)
    const db = {
      db: {
        query: {
          transactions: {
            findFirst: async () => ({
              ...fullTx,
              sender: null,
              receiver: null,
              project: null,
              payoutRequest: null,
            }),
          },
        },
        update: () => ({
          set: () => ({ where: async () => {} }),
        }),
        // MED-F (security-review round 4): adminUpdateTransaction now writes the
        // row and (for a crediting admin income) its registry claim inside ONE
        // transaction, so the fake must run the callback against a handle.
        transaction: async (cb: (dbtx: unknown) => Promise<unknown>) =>
          cb({
            update: () => ({ set: () => ({ where: async () => {} }) }),
            insert: () => ({ values: async () => {} }),
          }),
      },
    } as never
    const nbu = { getRates: async () => makeRates() } as never
    return new TransactionsService(db, {} as never, {} as never, nbu, {} as never)
  }

  it('PAID ADMIN_INCOME (non-company-funded) — editing amount throws BadRequestException', async () => {
    const svc = makeTxServiceWithExistingTx({
      id: 'tx-paid-001',
      type: 'ADMIN_INCOME',
      status: 'PAID',
      fundingSource: null,
    })
    const admin = makeViewer('ADMIN', 'admin-id')
    await expect(svc.adminUpdateTransaction('tx-paid-001', { amount: 999 }, admin)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('PAID ADMIN_INCOME (non-company-funded) — editing currency throws BadRequestException', async () => {
    const svc = makeTxServiceWithExistingTx({
      id: 'tx-paid-002',
      type: 'ADMIN_INCOME',
      status: 'PAID',
      fundingSource: null,
    })
    const admin = makeViewer('ADMIN', 'admin-id')
    await expect(
      svc.adminUpdateTransaction('tx-paid-002', { currency: 'EUR' }, admin),
    ).rejects.toThrow(BadRequestException)
  })

  it('PAID ADMIN_INCOME (non-company-funded) — editing notes is allowed', async () => {
    // notes-only edit on a PAID tx must succeed (metadata, not money-defining)
    const db = {
      db: {
        query: {
          transactions: {
            findFirst: async (args: unknown) => {
              void args
              // Return a "found" tx for findFirst (used both in adminUpdateTransaction and findOne)
              return {
                ...makeTx({
                  id: 'tx-paid-003',
                  type: 'ADMIN_INCOME',
                  status: 'PAID',
                  fundingSource: null,
                }),
                sender: null,
                receiver: null,
                project: null,
                payoutRequest: null,
              }
            },
          },
        },
        update: () => ({
          set: () => ({
            where: () => Promise.resolve(),
          }),
        }),
        // MED-F (round 4): row write + registry claim share ONE transaction.
        // security-review PR #456 (MED-1): adminUpdateTransaction's UPDATE now
        // chains `.returning(...)` and checks the affected row count — the
        // stub must expose `.returning()` resolving a non-empty array.
        transaction: async (cb: (dbtx: unknown) => Promise<unknown>) =>
          cb({
            update: () => ({
              set: () => ({
                where: () => ({ returning: () => Promise.resolve([{ id: 'tx-paid-003' }]) }),
              }),
            }),
            insert: () => ({ values: () => Promise.resolve() }),
          }),
      },
    } as never
    const svc = new TransactionsService(
      db,
      {} as never,
      {} as never,
      { getRates: async () => makeRates() } as never,
      {} as never,
    )
    const admin = makeViewer('ADMIN', 'admin-id')
    // Should not throw — notes-only edit
    await expect(
      svc.adminUpdateTransaction('tx-paid-003', { notes: 'updated note' }, admin),
    ).resolves.toBeDefined()
  })

  it('PENDING tx — editing amount is allowed', async () => {
    const db = {
      db: {
        query: {
          transactions: {
            findFirst: async () => ({
              ...makeTx({
                id: 'tx-pend-001',
                type: 'ADMIN_INCOME',
                status: 'PENDING',
                fundingSource: null,
              }),
              sender: null,
              receiver: null,
              project: null,
              payoutRequest: null,
            }),
          },
        },
        update: () => ({
          set: () => ({
            where: () => Promise.resolve(),
          }),
        }),
        // MED-F (round 4): row write + registry claim share ONE transaction.
        // security-review PR #456 (MED-1): see the notes-only test above —
        // same `.returning()` chain requirement.
        transaction: async (cb: (dbtx: unknown) => Promise<unknown>) =>
          cb({
            update: () => ({
              set: () => ({
                where: () => ({ returning: () => Promise.resolve([{ id: 'tx-pend-001' }]) }),
              }),
            }),
            insert: () => ({ values: () => Promise.resolve() }),
          }),
      },
    } as never
    const svc = new TransactionsService(
      db,
      {} as never,
      {} as never,
      { getRates: async () => makeRates() } as never,
      {} as never,
    )
    const admin = makeViewer('ADMIN', 'admin-id')
    await expect(
      svc.adminUpdateTransaction('tx-pend-001', { amount: 999 }, admin),
    ).resolves.toBeDefined()
  })
})

// ── AC4 — BIZ-17: updateDropIncome resubmit path for REJECTED DROP_INCOME ────

describe('AC4 BIZ-17 — updateDropIncome: resubmit REJECTED DROP_INCOME', () => {
  function makeTxServiceForDropUpdate(tx: Partial<MockTx>) {
    const fullTx = makeTx(tx)
    const db = {
      db: {
        query: {
          transactions: {
            findFirst: async () => ({
              ...fullTx,
              sender: null,
              receiver: null,
              project: null,
              payoutRequest: null,
            }),
          },
        },
        transaction: async (cb: (dbtx: unknown) => Promise<unknown>) => {
          // security-review PR #456 (MED-1): replaceReceiptAtomic's UPDATE
          // (called by updateDropIncome) now chains `.returning(...)` and
          // checks the affected row count — the stub must expose it.
          const dbtx = {
            update: () => ({
              set: () => ({
                where: () => ({ returning: () => Promise.resolve([{ id: fullTx.id }]) }),
              }),
            }),
            delete: () => ({ where: () => Promise.resolve() }),
          }
          return cb(dbtx)
        },
      },
    } as never
    const nbu = { getRates: async () => makeRates() } as never
    return new TransactionsService(db, {} as never, {} as never, nbu, {} as never)
  }

  it('DROP can resubmit their own REJECTED DROP_INCOME', async () => {
    const DROP_ID = 'drop-id-0000-0000-0000-000000000001'
    const svc = makeTxServiceForDropUpdate({
      id: 'drop-tx-001',
      type: 'DROP_INCOME',
      status: 'REJECTED',
      receiverId: DROP_ID,
    })
    const drop = makeViewer('DROP', DROP_ID)
    await expect(svc.updateDropIncome('drop-tx-001', { amount: 500 }, drop)).resolves.toBeDefined()
  })

  it('DROP cannot resubmit a PENDING DROP_INCOME (only REJECTED)', async () => {
    const DROP_ID = 'drop-id-0000-0000-0000-000000000001'
    const svc = makeTxServiceForDropUpdate({
      id: 'drop-tx-002',
      type: 'DROP_INCOME',
      status: 'PENDING',
      receiverId: DROP_ID,
    })
    const drop = makeViewer('DROP', DROP_ID)
    await expect(svc.updateDropIncome('drop-tx-002', { amount: 500 }, drop)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('DROP cannot resubmit another DROP income (ownership check)', async () => {
    const DROP_A = 'drop-a-0000-0000-0000-000000000001'
    const DROP_B = 'drop-b-0000-0000-0000-000000000002'
    const svc = makeTxServiceForDropUpdate({
      id: 'drop-tx-003',
      type: 'DROP_INCOME',
      status: 'REJECTED',
      receiverId: DROP_B, // owned by B
    })
    const dropA = makeViewer('DROP', DROP_A)
    await expect(svc.updateDropIncome('drop-tx-003', { amount: 500 }, dropA)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('non-DROP caller cannot use updateDropIncome → ForbiddenException', async () => {
    const ADMIN_ID = 'admin-0000-0000-0000-000000000001'
    const svc = makeTxServiceForDropUpdate({
      id: 'drop-tx-004',
      type: 'DROP_INCOME',
      status: 'REJECTED',
      receiverId: ADMIN_ID,
    })
    const admin = makeViewer('ADMIN', ADMIN_ID)
    await expect(svc.updateDropIncome('drop-tx-004', { amount: 500 }, admin)).rejects.toThrow(
      ForbiddenException,
    )
  })
})

// ── AC7 — SEC-19: sign-schema strict (no passthrough) ────────────────────────

describe('AC7 SEC-19 — sign schema: .strict() rejects unknown fields', () => {
  it('signContractSchema rejects unknown fields', async () => {
    // Import dynamically to keep test self-contained
    const { signContractSchema } = await import('@crm/shared')
    // Empty body is valid (typedName is optional)
    expect(() => signContractSchema.parse({})).not.toThrow()
    // typedName field is valid
    expect(() => signContractSchema.parse({ typedName: 'John Doe' })).not.toThrow()
    // Unknown field must throw in strict mode
    expect(() =>
      signContractSchema.parse({ typedName: 'John Doe', unknownField: 'should-fail' }),
    ).toThrow()
    // Unknown-only field must also throw
    expect(() => signContractSchema.parse({ contractId: 'anything' })).toThrow()
  })
})

// ── AC8 — BIZ-21: HrAccessService .limit(50) truncation ──────────────────────

describe('AC8 BIZ-21 — HrAccessService: limit(50) truncation documented', () => {
  it('hrSharesActiveTeamWith returns false when HR has no team memberships (limit guard)', async () => {
    // This is a documentation test: verifies the service uses a DB query with
    // .limit(50). Real truncation at >50 teams is an improbable edge-case (no
    // HR has 50+ teams in production). The fix raises the cap to 200.
    const { HrAccessService } = await import('../common/hr-access.service')
    const db = {
      db: {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: (n: number) => {
                // Verify the cap is at least 200 (raised from 50)
                expect(n).toBeGreaterThanOrEqual(200)
                return Promise.resolve([])
              },
            }),
          }),
        }),
      },
    } as never
    const svc = new HrAccessService(db)
    const result = await svc.hrSharesActiveTeamWith('hr-id', 'user-id')
    expect(result).toBe(false)
  })
})
