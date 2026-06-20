/**
 * task-drop-company-debt-and-invoices.
 * Unit tests for `PaymentChannelService`.
 *
 * Coverage:
 *   - Crypto path: 2× ADMIN_INCOME_CRYPTO + 1× SENIOR_PENDING_PAYOUT
 *     (debtor=COMPANY). Senior wallet is NOT included in `initiateCrypto`.
 *   - Cash path (admin-initiated): ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT
 *     (debtor=COMPANY) + obligation; DROP → 403.
 *   - Cash on non-VALIDATED → 400; cascade-exists guard → 400.
 *   - RBAC: SENIOR/JUNIOR/HR → 403 on initiate*. DROP — only own income.
 *   - Edge: already-paid DROP_INCOME (PAYOUT row in PAID) → 400.
 *   - Edge: status PENDING (not VALIDATED) → 400.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { MAKSYM_ID, KOSTYA_ID } from '@crm/shared'
import { pendingObligations, transactions } from '../database/schema'
import { PaymentChannelService } from './payment-channel.service'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

// ── Test fixtures ───────────────────────────────────────────────────────────

const DROP_ID = '11111111-1111-4111-8111-111111111111'
const SENIOR_ID = '22222222-2222-4222-8222-222222222222'
const PROJECT_ID = '33333333-3333-4333-8333-333333333333'
const INCOME_ID = '44444444-4444-4444-8444-444444444444'
const PAYOUT_ID = '55555555-5555-4555-8555-555555555555'
const PAYOUT_REQ_ID = '66666666-6666-4666-8666-666666666666'

const dropUser: SessionUser = {
  id: DROP_ID,
  role: 'DROP',
  displayName: 'Drop User',
  email: 'd@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const adminUser: SessionUser = {
  id: MAKSYM_ID,
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'a@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const accountantUser: SessionUser = {
  id: 'accountant-1',
  role: 'ACCOUNTANT',
  displayName: 'Accountant',
  email: 'acc@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const seniorUser: SessionUser = {
  id: SENIOR_ID,
  role: 'SENIOR',
  displayName: 'Senior',
  email: 's@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const juniorUser: SessionUser = {
  id: 'junior-1',
  role: 'JUNIOR',
  displayName: 'Junior',
  email: 'j@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const hrUser: SessionUser = {
  id: 'hr-1',
  role: 'HR',
  displayName: 'HR',
  email: 'h@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

function makeIncomeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INCOME_ID,
    type: 'DROP_INCOME' as const,
    status: 'VALIDATED' as const,
    amount: '3500',
    currency: 'USDT' as const,
    senderId: null,
    receiverId: DROP_ID,
    recipientId: DROP_ID,
    projectId: PROJECT_ID,
    payoutRequestId: PAYOUT_REQ_ID,
    senderLabel: null,
    receiverLabel: null,
    seniorSharePercent: null,
    txHash: null,
    validatedBy: null,
    validatedAt: null,
    rejectionReason: null,
    notes: null,
    salaryMonth: null,
    txDate: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    invoiceDocumentId: null,
    createdBy: DROP_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makePayoutRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYOUT_ID,
    type: 'PAYOUT' as const,
    status: 'PENDING_PAYMENT' as const,
    amount: '3150',
    currency: 'USDT' as const,
    senderId: DROP_ID,
    receiverLabel: 'CheekyCheeseIT',
    projectId: PROJECT_ID,
    payoutRequestId: PAYOUT_REQ_ID,
    createdBy: DROP_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    name: 'Drop Project',
    dropId: DROP_ID,
    seniorId: SENIOR_ID,
    ...overrides,
  }
}

function makeDropUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DROP_ID,
    role: 'DROP',
    displayName: 'Drop User',
    walletUsdtErc20: '0xDROPADDR',
    dropSharePercent: 10,
    archivedAt: null,
    ...overrides,
  }
}

function makeSeniorUserRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SENIOR_ID,
    role: 'SENIOR',
    displayName: 'Senior',
    walletUsdtErc20: '0xSENIORADDR',
    seniorSharePercent: 16,
    archivedAt: null,
    ...overrides,
  }
}

function makeAdminUserRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    role: 'ADMIN',
    displayName: id === MAKSYM_ID ? 'Maksym' : 'Kostya',
    walletUsdtErc20: id === MAKSYM_ID ? '0xMAKSYM' : '0xKOSTYA',
    archivedAt: null,
    ...overrides,
  }
}

// ── Mock builder ────────────────────────────────────────────────────────────

interface MockState {
  income: ReturnType<typeof makeIncomeRow> | null
  payout: ReturnType<typeof makePayoutRow> | null
  project: ReturnType<typeof makeProject> | null
  drop: ReturnType<typeof makeDropUserRow> | null
  senior: ReturnType<typeof makeSeniorUserRow> | null
  admins: Map<string, ReturnType<typeof makeAdminUserRow>>
  channelRows: ReturnType<typeof makeIncomeRow>[]
  inserts: Array<{ table: unknown; row: Record<string, unknown> }>
  updates: Array<{ table: unknown; set: Record<string, unknown> }>
}

function makeService(initial: Partial<MockState> = {}) {
  const state: MockState = {
    income: makeIncomeRow(),
    payout: makePayoutRow(),
    project: makeProject(),
    drop: makeDropUserRow(),
    senior: makeSeniorUserRow(),
    admins: new Map([
      [MAKSYM_ID, makeAdminUserRow(MAKSYM_ID)],
      [KOSTYA_ID, makeAdminUserRow(KOSTYA_ID)],
    ]),
    channelRows: [],
    inserts: [],
    updates: [],
    ...initial,
  }

  // Drizzle stub.
  const txFindFirstCalls: string[] = []
  const userFindFirstCalls: string[] = []

  const mkDbtx = () => ({
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (_predicate: unknown) => {
          state.updates.push({ table, set: patch })
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        const recorded = { table, row }
        state.inserts.push(recorded)
        const returning = async () => [{ id: `inserted-${state.inserts.length}` }]
        return { returning } as unknown as Promise<unknown[]> & {
          returning: typeof returning
        }
      },
    }),
  })

  // Walk a drizzle `eq(column, value)` operator (or `and(eq, eq, …)`) and
  // collect the right-hand string values without traversing PgTable cycles.
  const collectStringValues = (obj: unknown, acc: string[] = [], depth = 0): string[] => {
    if (acc.length > 50 || depth > 6 || obj === null || obj === undefined) return acc
    if (typeof obj === 'string') {
      acc.push(obj)
      return acc
    }
    if (typeof obj !== 'object') return acc
    if (Array.isArray(obj)) {
      for (const item of obj) collectStringValues(item, acc, depth + 1)
      return acc
    }
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (key === 'table' || key === 'schema' || key === 'enumValues') continue
      collectStringValues(val, acc, depth + 1)
    }
    return acc
  }

  const drizzleClient = {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const dbtx = mkDbtx()
      return cb(dbtx)
    },
    query: {
      transactions: {
        findFirst: vi.fn(async (args: unknown) => {
          const values = collectStringValues(args)
          txFindFirstCalls.push(values.join(','))
          if (txFindFirstCalls.length === 1) return state.income ?? undefined
          if (txFindFirstCalls.length === 2) return state.payout ?? undefined
          return state.income ?? undefined
        }),
        findMany: vi.fn(async () => state.channelRows),
      },
      projects: {
        findFirst: vi.fn(async () => state.project ?? undefined),
      },
      users: {
        findFirst: vi.fn(async (args: unknown) => {
          const values = collectStringValues(args)
          userFindFirstCalls.push(values.join(','))
          if (values.includes(DROP_ID)) return state.drop ?? undefined
          if (values.includes(SENIOR_ID)) return state.senior ?? undefined
          if (values.includes(MAKSYM_ID)) return state.admins.get(MAKSYM_ID) ?? undefined
          if (values.includes(KOSTYA_ID)) return state.admins.get(KOSTYA_ID) ?? undefined
          if (userFindFirstCalls.length === 1) return state.drop ?? undefined
          if (userFindFirstCalls.length === 2) return state.senior ?? undefined
          return undefined
        }),
      },
    },
  }
  const dbStub = { db: drizzleClient } as unknown

  const txService = makeTransactionsService({ db: dbStub as never })
  const svc = new PaymentChannelService(dbStub as never, txService)
  return {
    svc,
    state,
    getInsertsFor: (table: unknown) =>
      state.inserts.filter((i) => i.table === table).map((i) => i.row),
    getUpdatesFor: (table: unknown) =>
      state.updates.filter((u) => u.table === table).map((u) => u.set),
  }
}

// ── Crypto channel ──────────────────────────────────────────────────────────

describe('PaymentChannelService.initiateCryptoPayment', () => {
  it('returns 2 admin recipients only (no senior wallet) with correct amounts', async () => {
    const { svc } = makeService()
    const result = await svc.initiateCryptoPayment(INCOME_ID, dropUser)

    expect(result.contractAddress).toBeNull()
    expect(result.recipients).toHaveLength(2)
    const senior = result.recipients.find((r) => r.role === 'SENIOR')
    const admins = result.recipients.filter((r) => r.role === 'ADMIN')

    // Senior wallet must NOT be in the recipient list — drop pays company only.
    expect(senior).toBeUndefined()
    // 3500 - 350 - 560 = 2590 / 2 = 1295 per admin (16% senior, 10% drop).
    expect(admins).toHaveLength(2)
    for (const admin of admins) {
      expect(parseFloat(admin.amount)).toBeCloseTo(1295)
    }
  })

  it('SENIOR caller → 403', async () => {
    const { svc } = makeService()
    await expect(svc.initiateCryptoPayment(INCOME_ID, seniorUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('JUNIOR caller → 403', async () => {
    const { svc } = makeService()
    await expect(svc.initiateCryptoPayment(INCOME_ID, juniorUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('HR caller → 403', async () => {
    const { svc } = makeService()
    await expect(svc.initiateCryptoPayment(INCOME_ID, hrUser)).rejects.toThrow(ForbiddenException)
  })

  it('DROP caller on someone else’s income → 403', async () => {
    const { svc } = makeService()
    const otherDrop: SessionUser = { ...dropUser, id: 'other-drop' }
    await expect(svc.initiateCryptoPayment(INCOME_ID, otherDrop)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('ACCOUNTANT may call', async () => {
    const { svc } = makeService()
    await expect(svc.initiateCryptoPayment(INCOME_ID, accountantUser)).resolves.toBeDefined()
  })

  it('income missing → 404', async () => {
    const { svc } = makeService({ income: null })
    await expect(svc.initiateCryptoPayment(INCOME_ID, accountantUser)).rejects.toThrow(
      NotFoundException,
    )
  })

  it('income not VALIDATED → 400', async () => {
    const { svc } = makeService({ income: makeIncomeRow({ status: 'PENDING' }) })
    await expect(svc.initiateCryptoPayment(INCOME_ID, dropUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('income wrong type → 400', async () => {
    const { svc } = makeService({ income: makeIncomeRow({ type: 'SENIOR_INCOME' }) })
    await expect(svc.initiateCryptoPayment(INCOME_ID, dropUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('payout already PAID → 400', async () => {
    const { svc } = makeService({ payout: makePayoutRow({ status: 'PAID' }) })
    await expect(svc.initiateCryptoPayment(INCOME_ID, dropUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('channel cascade already exists → 400', async () => {
    const { svc } = makeService({
      channelRows: [makeIncomeRow({ type: 'ADMIN_INCOME_CRYPTO' })],
    })
    await expect(svc.initiateCryptoPayment(INCOME_ID, dropUser)).rejects.toThrow(
      BadRequestException,
    )
  })
})

describe('PaymentChannelService.confirmCryptoPayment', () => {
  it('creates 2× ADMIN_INCOME_CRYPTO + 1× SENIOR_PENDING_PAYOUT (debtor=COMPANY)', async () => {
    const { svc, getInsertsFor, getUpdatesFor } = makeService()
    const hashes = ['0xhash-maksym', '0xhash-kostya']
    await svc.confirmCryptoPayment(INCOME_ID, hashes, dropUser)

    const inserts = getInsertsFor(transactions)
    expect(inserts).toHaveLength(3)

    // No SENIOR_INCOME_CRYPTO — refactor moved senior share to a COMPANY debt.
    expect(inserts.find((r) => r['type'] === 'SENIOR_INCOME_CRYPTO')).toBeUndefined()

    const admins = inserts.filter((r) => r['type'] === 'ADMIN_INCOME_CRYPTO')
    expect(admins).toHaveLength(2)
    for (const a of admins) {
      expect(parseFloat(a['amount'] as string)).toBeCloseTo(1295)
      expect(a['senderId']).toBe(DROP_ID)
      expect(a['currency']).toBe('USDT')
    }

    const pending = inserts.find((r) => r['type'] === 'SENIOR_PENDING_PAYOUT')!
    expect(pending['status']).toBe('PENDING_PAYMENT')
    expect(pending['receiverId']).toBe(SENIOR_ID)
    expect(pending['senderLabel']).toBe('COMPANY')
    expect(parseFloat(pending['amount'] as string)).toBeCloseTo(560)

    // Obligation row created with debtor=COMPANY.
    const oblInserts = getInsertsFor(pendingObligations)
    expect(oblInserts).toHaveLength(1)
    expect(oblInserts[0]?.['debtorType']).toBe('COMPANY')
    expect(oblInserts[0]?.['creditorUserId']).toBe(SENIOR_ID)

    // Payout row flipped to PAID with the first hash recorded.
    const updates = getUpdatesFor(transactions)
    expect(updates.length).toBeGreaterThan(0)
    expect(updates[0]?.['status']).toBe('PAID')
    expect(updates[0]?.['txHash']).toBe('0xhash-maksym')
  })

  it('empty txHashes → 400', async () => {
    const { svc } = makeService()
    await expect(svc.confirmCryptoPayment(INCOME_ID, [], dropUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('DROP on someone else’s income → 403', async () => {
    const { svc } = makeService()
    const otherDrop: SessionUser = { ...dropUser, id: 'other-drop' }
    await expect(svc.confirmCryptoPayment(INCOME_ID, ['0xhash'], otherDrop)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('SENIOR → 403', async () => {
    const { svc } = makeService()
    await expect(svc.confirmCryptoPayment(INCOME_ID, ['0xhash'], seniorUser)).rejects.toThrow(
      ForbiddenException,
    )
  })
})

// ── Cash channel (admin-initiated) ──────────────────────────────────────────
//
// task-drop-company-debt-and-invoices. SENIOR_PENDING_PAYOUT carries
// debtorType='COMPANY' (was 'DROP' in the previous refactor).

describe('PaymentChannelService.confirmCashPayment', () => {
  it('creates ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT + obligation (COMPANY), closes PAYOUT', async () => {
    const { svc, getInsertsFor, getUpdatesFor } = makeService()
    await svc.confirmCashPayment(INCOME_ID, MAKSYM_ID, accountantUser)

    const txInserts = getInsertsFor(transactions)
    const oblInserts = getInsertsFor(pendingObligations)
    expect(txInserts).toHaveLength(2)

    const cash = txInserts.find((r) => r['type'] === 'ADMIN_INCOME_CASH')!
    const pending = txInserts.find((r) => r['type'] === 'SENIOR_PENDING_PAYOUT')!

    expect(cash['receiverId']).toBe(MAKSYM_ID)
    expect(cash['recipientId']).toBe(MAKSYM_ID)
    expect(parseFloat(cash['amount'] as string)).toBeCloseTo(2590)

    expect(parseFloat(pending['amount'] as string)).toBeCloseTo(560)
    expect(pending['receiverId']).toBe(SENIOR_ID)
    expect(pending['senderLabel']).toBe('COMPANY')

    expect(oblInserts).toHaveLength(1)
    expect(oblInserts[0]?.['debtorType']).toBe('COMPANY')
    expect(oblInserts[0]?.['creditorUserId']).toBe(SENIOR_ID)

    // PAYOUT row flipped to PAID.
    const txUpdates = getUpdatesFor(transactions)
    expect(txUpdates.some((u) => u['status'] === 'PAID')).toBe(true)
  })

  it('ADMIN can confirm', async () => {
    const { svc } = makeService()
    await expect(svc.confirmCashPayment(INCOME_ID, MAKSYM_ID, adminUser)).resolves.toBeDefined()
  })

  it('DROP caller → 403', async () => {
    const { svc } = makeService()
    await expect(svc.confirmCashPayment(INCOME_ID, MAKSYM_ID, dropUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('SENIOR caller → 403', async () => {
    const { svc } = makeService()
    await expect(svc.confirmCashPayment(INCOME_ID, MAKSYM_ID, seniorUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('JUNIOR caller → 403', async () => {
    const { svc } = makeService()
    await expect(svc.confirmCashPayment(INCOME_ID, MAKSYM_ID, juniorUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('income not VALIDATED → 400', async () => {
    const { svc } = makeService({ income: makeIncomeRow({ status: 'PENDING' }) })
    await expect(svc.confirmCashPayment(INCOME_ID, MAKSYM_ID, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('income wrong type → 400', async () => {
    const { svc } = makeService({ income: makeIncomeRow({ type: 'SENIOR_INCOME' }) })
    await expect(svc.confirmCashPayment(INCOME_ID, MAKSYM_ID, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('cascade already exists → 400 (second confirm)', async () => {
    const { svc } = makeService({
      channelRows: [makeIncomeRow({ type: 'ADMIN_INCOME_CASH' })],
    })
    await expect(svc.confirmCashPayment(INCOME_ID, MAKSYM_ID, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('payout already PAID → 400', async () => {
    const { svc } = makeService({ payout: makePayoutRow({ status: 'PAID' }) })
    await expect(svc.confirmCashPayment(INCOME_ID, MAKSYM_ID, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('Non-ADMIN recipient → 400', async () => {
    const { svc, state } = makeService()
    state.admins.set(MAKSYM_ID, { ...makeAdminUserRow(MAKSYM_ID), role: 'SENIOR' })
    await expect(svc.confirmCashPayment(INCOME_ID, MAKSYM_ID, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('Archived ADMIN recipient → 400', async () => {
    const { svc, state } = makeService()
    state.admins.set(MAKSYM_ID, { ...makeAdminUserRow(MAKSYM_ID), archivedAt: new Date() })
    await expect(svc.confirmCashPayment(INCOME_ID, MAKSYM_ID, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
  })
})
