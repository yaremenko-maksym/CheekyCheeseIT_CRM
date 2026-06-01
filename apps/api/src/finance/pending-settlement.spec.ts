/**
 * Drop role - phase 4-C. Unit tests for `PendingSettlementService`.
 *
 * Coverage:
 *   - listSeniorObligations / listDropObligations / listTovObligations RBAC.
 *   - settleByDrop: closes obligation + inserts SENIOR_PAID; DROP can only
 *     close own debt; non-DROP obligation rejected.
 *   - settleByTov: insufficient TOV balance → 400; happy path inserts both
 *     EXPENSE (FIAT_TOV) + SENIOR_PAID and patches obligation.
 *   - Edge: already-settled obligation → 400; non-existent obligation → 404.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { pendingObligations, transactions } from '../database/schema'
import { BalanceService } from './balance.service'
import { PendingSettlementService } from './pending-settlement.service'

// ── Fixtures ────────────────────────────────────────────────────────────────

const SENIOR_ID = '11111111-1111-4111-8111-111111111111'
const DROP_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_DROP_ID = '33333333-3333-4333-8333-333333333333'
const OBLIGATION_DROP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OBLIGATION_TOV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SOURCE_TX_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PROJECT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const dropUser: SessionUser = {
  id: DROP_ID,
  role: 'DROP',
  displayName: 'Drop',
  email: 'd@x.com',
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
const accountantUser: SessionUser = {
  id: 'acc-1',
  role: 'ACCOUNTANT',
  displayName: 'Accountant',
  email: 'a@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const adminUser: SessionUser = {
  id: 'adm-1',
  role: 'ADMIN',
  displayName: 'Admin',
  email: 'ad@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}
const juniorUser: SessionUser = {
  id: 'jun-1',
  role: 'JUNIOR',
  displayName: 'Junior',
  email: 'j@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

function makeObligation(overrides: Record<string, unknown> = {}) {
  return {
    id: OBLIGATION_DROP,
    creditorUserId: SENIOR_ID,
    debtorType: 'DROP' as const,
    debtorUserId: DROP_ID,
    sourceTransactionId: SOURCE_TX_ID,
    closingTransactionId: null,
    amount: '560',
    currency: 'USDT' as const,
    status: 'PENDING' as const,
    createdAt: new Date('2026-05-30T12:00:00Z'),
    updatedAt: new Date('2026-05-30T12:00:00Z'),
    ...overrides,
  }
}

function makeSourceTx(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_TX_ID,
    type: 'SENIOR_PENDING_PAYOUT' as const,
    projectId: PROJECT_ID,
    amount: '560',
    currency: 'USDT' as const,
    senderId: DROP_ID,
    receiverId: SENIOR_ID,
    recipientId: SENIOR_ID,
    senderLabel: 'DROP',
    receiverLabel: null,
    status: 'PENDING_PAYMENT' as const,
    payoutRequestId: null,
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

function makeProject() {
  return { id: PROJECT_ID, name: 'Drop Project' }
}

function makeSeniorRow() {
  return { id: SENIOR_ID, displayName: 'Senior', role: 'SENIOR' }
}

function makeDropRow() {
  return { id: DROP_ID, displayName: 'Drop', role: 'DROP' }
}

interface MockState {
  obligations: Map<string, ReturnType<typeof makeObligation>>
  sourceTxs: Map<string, ReturnType<typeof makeSourceTx>>
  project: ReturnType<typeof makeProject> | null
  senior: ReturnType<typeof makeSeniorRow> | null
  drop: ReturnType<typeof makeDropRow> | null
  inserts: Array<{ table: unknown; row: Record<string, unknown> }>
  updates: Array<{ table: unknown; set: Record<string, unknown>; obligationId: string }>
}

function makeService(initial: Partial<MockState> = {}, tovBalance: number = 10000) {
  const state: MockState = {
    obligations: new Map([[OBLIGATION_DROP, makeObligation()]]),
    sourceTxs: new Map([[SOURCE_TX_ID, makeSourceTx()]]),
    project: makeProject(),
    senior: makeSeniorRow(),
    drop: makeDropRow(),
    inserts: [],
    updates: [],
    ...initial,
  }

  // Match obligation id by extracting the literal embedded inside the
  // `where: eq(pendingObligations.id, X)` operator. We don't traverse
  // PgTable cycles — just collect shallow string values.
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

  let lastUpdateObligationId = ''

  const mkDbtx = () => ({
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (predicate: unknown) => {
          // The service always updates a specific obligation row — the id is
          // the only literal in the eq() predicate.
          const values = collectStringValues(predicate)
          const oblId = values.find((v) => v === OBLIGATION_DROP || v === OBLIGATION_TOV) ?? ''
          lastUpdateObligationId = oblId
          state.updates.push({ table, set: patch, obligationId: oblId })
          // Mutate the in-memory obligation so the post-update findFirst
          // returns the patched row.
          const existing = state.obligations.get(oblId)
          if (existing) {
            state.obligations.set(oblId, {
              ...existing,
              ...patch,
            } as ReturnType<typeof makeObligation>)
          }
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: Record<string, unknown>) => {
        const id = `inserted-${state.inserts.length + 1}`
        state.inserts.push({ table, row: { ...row, id } })
        const returning = async () => [{ id }]
        return { returning } as unknown as Promise<unknown[]> & { returning: typeof returning }
      },
    }),
  })

  const drizzleClient = {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      const dbtx = mkDbtx()
      return cb(dbtx)
    },
    query: {
      pendingObligations: {
        findFirst: vi.fn(async (args: unknown) => {
          const values = collectStringValues(args)
          const obl = values.find((v) => state.obligations.has(v)) ?? lastUpdateObligationId
          if (obl && state.obligations.has(obl)) return state.obligations.get(obl)
          return undefined
        }),
        findMany: vi.fn(async (args: unknown) => {
          const values = collectStringValues(args)
          let rows = Array.from(state.obligations.values())
          // Status conjunct — always PENDING in our tests.
          rows = rows.filter((r) => r.status === 'PENDING')
          // creditorUserId / debtorType / debtorUserId predicates: filter by
          // literal presence. Crude but matches what the service emits.
          if (values.includes(SENIOR_ID)) {
            rows = rows.filter((r) => r.creditorUserId === SENIOR_ID)
          }
          if (values.includes(DROP_ID)) {
            rows = rows.filter((r) => r.debtorUserId === DROP_ID)
          }
          if (values.includes('TOV')) {
            rows = rows.filter((r) => r.debtorType === 'TOV')
          } else if (values.includes('DROP') && !values.includes(SENIOR_ID)) {
            // listDropObligations passes debtorType='DROP'
            rows = rows.filter((r) => r.debtorType === 'DROP')
          }
          return rows
        }),
      },
      transactions: {
        findFirst: vi.fn(async (args: unknown) => {
          const values = collectStringValues(args)
          for (const v of values) {
            if (state.sourceTxs.has(v)) return state.sourceTxs.get(v)
          }
          return undefined
        }),
        findMany: vi.fn(async () => [] as unknown[]),
      },
      projects: {
        findFirst: vi.fn(async () => state.project ?? undefined),
      },
      users: {
        findFirst: vi.fn(async (args: unknown) => {
          const values = collectStringValues(args)
          if (values.includes(SENIOR_ID)) return state.senior ?? undefined
          if (values.includes(DROP_ID)) return state.drop ?? undefined
          return undefined
        }),
      },
    },
  }
  const dbStub = { db: drizzleClient } as unknown

  // Mock BalanceService — only getTOVBalance is consumed by settleByTov.
  const balanceStub = {
    getTOVBalance: vi.fn(async () => ({
      balance: tovBalance,
      currency: 'USDT',
      breakdown: { income: tovBalance, dividends_paid: 0, expenses: 0, tax: 0 },
    })),
  } as unknown as BalanceService

  const svc = new PendingSettlementService(dbStub as never, balanceStub)
  return {
    svc,
    state,
    getInsertsFor: (table: unknown) =>
      state.inserts.filter((i) => i.table === table).map((i) => i.row),
    getUpdatesFor: (table: unknown) =>
      state.updates.filter((u) => u.table === table).map((u) => u.set),
  }
}

// ── settleByDrop ────────────────────────────────────────────────────────────

describe('PendingSettlementService.settleByDrop', () => {
  it('closes obligation + inserts SENIOR_PAID transaction', async () => {
    const { svc, getInsertsFor, getUpdatesFor, state } = makeService()
    const result = await svc.settleByDrop(OBLIGATION_DROP, dropUser)

    const txInserts = getInsertsFor(transactions)
    expect(txInserts).toHaveLength(1)
    expect(txInserts[0]?.['type']).toBe('SENIOR_PAID')
    expect(txInserts[0]?.['senderId']).toBe(DROP_ID)
    expect(txInserts[0]?.['senderLabel']).toBe('DROP')
    expect(txInserts[0]?.['receiverId']).toBe(SENIOR_ID)
    expect(txInserts[0]?.['amount']).toBe('560')

    const oblUpdates = getUpdatesFor(pendingObligations)
    expect(oblUpdates).toHaveLength(1)
    expect(oblUpdates[0]?.['status']).toBe('PAID')
    expect(oblUpdates[0]?.['closingTransactionId']).toBe('inserted-1')

    expect(result.obligation.status).toBe('PAID')
    expect(result.created).toHaveLength(1)
    expect(state.obligations.get(OBLIGATION_DROP)?.status).toBe('PAID')
  })

  it('ACCOUNTANT may close any DROP debt', async () => {
    const { svc, getInsertsFor } = makeService()
    await svc.settleByDrop(OBLIGATION_DROP, accountantUser)
    expect(getInsertsFor(transactions)).toHaveLength(1)
  })

  it('ADMIN may close any DROP debt', async () => {
    const { svc, getInsertsFor } = makeService()
    await svc.settleByDrop(OBLIGATION_DROP, adminUser)
    expect(getInsertsFor(transactions)).toHaveLength(1)
  })

  it("DROP cannot close someone else's debt → 403", async () => {
    const { svc } = makeService({
      obligations: new Map([[OBLIGATION_DROP, makeObligation({ debtorUserId: OTHER_DROP_ID })]]),
    })
    await expect(svc.settleByDrop(OBLIGATION_DROP, dropUser)).rejects.toThrow(ForbiddenException)
  })

  it('SENIOR cannot settle (only ACCOUNTANT/ADMIN/debtor-DROP) → 403', async () => {
    const { svc } = makeService()
    await expect(svc.settleByDrop(OBLIGATION_DROP, seniorUser)).rejects.toThrow(ForbiddenException)
  })

  it('JUNIOR cannot settle → 403', async () => {
    const { svc } = makeService()
    await expect(svc.settleByDrop(OBLIGATION_DROP, juniorUser)).rejects.toThrow(ForbiddenException)
  })

  it('already-PAID obligation → 400', async () => {
    const { svc } = makeService({
      obligations: new Map([[OBLIGATION_DROP, makeObligation({ status: 'PAID' })]]),
    })
    await expect(svc.settleByDrop(OBLIGATION_DROP, dropUser)).rejects.toThrow(BadRequestException)
  })

  it('debtorType=TOV cannot be closed by settleByDrop → 400', async () => {
    const { svc } = makeService({
      obligations: new Map([
        [OBLIGATION_DROP, makeObligation({ debtorType: 'TOV', debtorUserId: null })],
      ]),
    })
    await expect(svc.settleByDrop(OBLIGATION_DROP, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('obligation not found → 404', async () => {
    const { svc } = makeService({ obligations: new Map() })
    await expect(svc.settleByDrop(OBLIGATION_DROP, accountantUser)).rejects.toThrow(
      NotFoundException,
    )
  })
})

// ── settleByTov ─────────────────────────────────────────────────────────────

describe('PendingSettlementService.settleByTov', () => {
  it('inserts TOV_EXPENSE (FIAT_TOV) + SENIOR_PAID and patches obligation', async () => {
    const { svc, getInsertsFor, getUpdatesFor, state } = makeService({
      obligations: new Map([
        [
          OBLIGATION_TOV,
          makeObligation({ id: OBLIGATION_TOV, debtorType: 'TOV', debtorUserId: null }),
        ],
      ]),
    })
    await svc.settleByTov(OBLIGATION_TOV, accountantUser)

    const txInserts = getInsertsFor(transactions)
    expect(txInserts).toHaveLength(2)
    const expense = txInserts.find((r) => r['type'] === 'EXPENSE')!
    const paid = txInserts.find((r) => r['type'] === 'SENIOR_PAID')!
    expect(expense['receiverLabel']).toBe('FIAT_TOV')
    expect(expense['amount']).toBe('560')
    expect(paid['receiverId']).toBe(SENIOR_ID)
    expect(paid['senderLabel']).toBe('ТОВ')

    const oblUpdates = getUpdatesFor(pendingObligations)
    expect(oblUpdates).toHaveLength(1)
    expect(oblUpdates[0]?.['status']).toBe('PAID')
    expect(state.obligations.get(OBLIGATION_TOV)?.status).toBe('PAID')
  })

  it('ADMIN may settle TOV', async () => {
    const { svc, getInsertsFor } = makeService({
      obligations: new Map([
        [
          OBLIGATION_TOV,
          makeObligation({ id: OBLIGATION_TOV, debtorType: 'TOV', debtorUserId: null }),
        ],
      ]),
    })
    await svc.settleByTov(OBLIGATION_TOV, adminUser)
    expect(getInsertsFor(transactions)).toHaveLength(2)
  })

  it('DROP cannot settle from TOV → 403', async () => {
    const { svc } = makeService({
      obligations: new Map([
        [
          OBLIGATION_TOV,
          makeObligation({ id: OBLIGATION_TOV, debtorType: 'TOV', debtorUserId: null }),
        ],
      ]),
    })
    await expect(svc.settleByTov(OBLIGATION_TOV, dropUser)).rejects.toThrow(ForbiddenException)
  })

  it('SENIOR cannot settle from TOV → 403', async () => {
    const { svc } = makeService({
      obligations: new Map([
        [
          OBLIGATION_TOV,
          makeObligation({ id: OBLIGATION_TOV, debtorType: 'TOV', debtorUserId: null }),
        ],
      ]),
    })
    await expect(svc.settleByTov(OBLIGATION_TOV, seniorUser)).rejects.toThrow(ForbiddenException)
  })

  it('insufficient TOV balance → 400', async () => {
    const { svc } = makeService(
      {
        obligations: new Map([
          [
            OBLIGATION_TOV,
            makeObligation({ id: OBLIGATION_TOV, debtorType: 'TOV', debtorUserId: null }),
          ],
        ]),
      },
      100,
    )
    await expect(svc.settleByTov(OBLIGATION_TOV, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('debtorType=DROP cannot be closed by settleByTov → 400', async () => {
    const { svc } = makeService()
    await expect(svc.settleByTov(OBLIGATION_DROP, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('already-PAID obligation → 400', async () => {
    const { svc } = makeService({
      obligations: new Map([
        [
          OBLIGATION_TOV,
          makeObligation({
            id: OBLIGATION_TOV,
            debtorType: 'TOV',
            debtorUserId: null,
            status: 'PAID',
          }),
        ],
      ]),
    })
    await expect(svc.settleByTov(OBLIGATION_TOV, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
  })
})

// ── list endpoints RBAC ─────────────────────────────────────────────────────

describe('PendingSettlementService.listSeniorObligations', () => {
  it('SENIOR sees only own obligations', async () => {
    const { svc } = makeService()
    const result = await svc.listSeniorObligations(seniorUser)
    expect(result).toHaveLength(1)
    expect(result[0]?.seniorId).toBe(SENIOR_ID)
  })

  it('ACCOUNTANT sees all senior obligations', async () => {
    const { svc } = makeService()
    const result = await svc.listSeniorObligations(accountantUser)
    expect(result).toHaveLength(1)
  })

  it('ADMIN sees all', async () => {
    const { svc } = makeService()
    const result = await svc.listSeniorObligations(adminUser)
    expect(result).toHaveLength(1)
  })

  it('DROP forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.listSeniorObligations(dropUser)).rejects.toThrow(ForbiddenException)
  })

  it('JUNIOR forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.listSeniorObligations(juniorUser)).rejects.toThrow(ForbiddenException)
  })
})

describe('PendingSettlementService.listDropObligations', () => {
  it('DROP sees only own debts', async () => {
    const { svc } = makeService()
    const result = await svc.listDropObligations(dropUser)
    expect(result).toHaveLength(1)
    expect(result[0]?.debtorUserId).toBe(DROP_ID)
  })

  it('ACCOUNTANT sees all drop debts', async () => {
    const { svc } = makeService()
    const result = await svc.listDropObligations(accountantUser)
    expect(result).toHaveLength(1)
  })

  it('SENIOR forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.listDropObligations(seniorUser)).rejects.toThrow(ForbiddenException)
  })

  it('JUNIOR forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.listDropObligations(juniorUser)).rejects.toThrow(ForbiddenException)
  })
})

describe('PendingSettlementService.listTovObligations', () => {
  it('ACCOUNTANT sees all TOV debts', async () => {
    const { svc } = makeService({
      obligations: new Map([
        [
          OBLIGATION_TOV,
          makeObligation({ id: OBLIGATION_TOV, debtorType: 'TOV', debtorUserId: null }),
        ],
      ]),
    })
    const result = await svc.listTovObligations(accountantUser)
    expect(result).toHaveLength(1)
    expect(result[0]?.debtorType).toBe('TOV')
  })

  it('ADMIN sees all TOV debts', async () => {
    const { svc } = makeService({
      obligations: new Map([
        [
          OBLIGATION_TOV,
          makeObligation({ id: OBLIGATION_TOV, debtorType: 'TOV', debtorUserId: null }),
        ],
      ]),
    })
    const result = await svc.listTovObligations(adminUser)
    expect(result).toHaveLength(1)
  })

  it('DROP forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.listTovObligations(dropUser)).rejects.toThrow(ForbiddenException)
  })

  it('SENIOR forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.listTovObligations(seniorUser)).rejects.toThrow(ForbiddenException)
  })
})
