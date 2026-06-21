/**
 * task-drop-company-debt-and-invoices.
 * Unit tests for `PendingSettlementService`.
 *
 * Coverage:
 *   - listSeniorObligations / listCompanyObligations RBAC (DROP cannot list
 *     company obligations).
 *   - settleByCompany: closes COMPANY-debt obligation + inserts SENIOR_INCOME
 *     row (status=PAID) + triggers invoice auto-create.
 *   - settleByCompany RBAC: ADMIN/ACCOUNTANT only; DROP → 403, SENIOR → 403.
 *   - settleByDrop / listDropObligations removed — no tests for them.
 *   - Edge: already-settled obligation → 400; non-existent obligation → 404.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { pendingObligations, transactions } from '../database/schema'
import { PendingSettlementService } from './pending-settlement.service'
import type { InvoicesService } from '../invoices/invoices.service'

// ── Fixtures ────────────────────────────────────────────────────────────────

const SENIOR_ID = '11111111-1111-4111-8111-111111111111'
const DROP_ID = '22222222-2222-4222-8222-222222222222'
const OBLIGATION_COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
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
    id: OBLIGATION_COMPANY,
    creditorUserId: SENIOR_ID,
    debtorType: 'COMPANY' as const,
    debtorUserId: null as string | null,
    sourceTransactionId: SOURCE_TX_ID,
    closingTransactionId: null as string | null,
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
    senderId: null,
    receiverId: SENIOR_ID,
    recipientId: SENIOR_ID,
    senderLabel: 'COMPANY',
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
    createdBy: 'system',
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
  invoiceCalls: string[]
  /** Company-account ledger balance the settleByCompany gate re-reads. */
  companyBalance?: number
  /** Counts ledger select() calls so the mock attributes balance to term 1. */
  ledgerSelectCount?: number
}

function makeService(initial: Partial<MockState> = {}) {
  const state: MockState = {
    obligations: new Map([[OBLIGATION_COMPANY, makeObligation()]]),
    sourceTxs: new Map([[SOURCE_TX_ID, makeSourceTx()]]),
    project: makeProject(),
    senior: makeSeniorRow(),
    drop: makeDropRow(),
    inserts: [],
    updates: [],
    invoiceCalls: [],
    ...initial,
  }

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
    // task-drop-payout-company-account: settleByCompany on a COMPANY debt now
    // (1) acquires the company-account advisory lock (pg_advisory_xact_lock via
    // dbtx.execute) and (2) re-reads the ledger balance via select().from().where().
    // The mock returns a large balance so the gate passes; `companyBalance` in
    // overrides lets a test drive the insufficient-funds branch.
    execute: vi.fn(async () => undefined),
    select: () => ({
      from: () => ({
        // computeCompanyAccountBalanceFromLedger sums N ledger terms (one select
        // per term, run in a fixed order via Promise.all). The FIRST term is
        // COMPANY_DEPOSIT (a +credit); attribute the whole balance to it and 0
        // to every other term so the derived balance equals exactly
        // `companyBalance` (default 1_000_000 → gate passes).
        where: async () => {
          const count = state.ledgerSelectCount ?? 0
          state.ledgerSelectCount = count + 1
          const total = count === 0 ? String(state.companyBalance ?? 1_000_000) : '0'
          return [{ total }]
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (predicate: unknown) => {
          const values = collectStringValues(predicate)
          const oblId = values.find((v) => state.obligations.has(v)) ?? lastUpdateObligationId
          lastUpdateObligationId = oblId
          state.updates.push({ table, set: patch, obligationId: oblId })
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
        const returning = async () => [{ id, ...row, type: row['type'] }]
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
          rows = rows.filter((r) => r.status === 'PENDING')
          if (values.includes(SENIOR_ID)) {
            rows = rows.filter((r) => r.creditorUserId === SENIOR_ID)
          }
          if (values.includes('TOV')) {
            rows = rows.filter((r) => r.debtorType === 'TOV')
          } else if (values.includes('COMPANY') && !values.includes('DROP')) {
            // listCompanyObligations passes only debtorType='COMPANY'
            rows = rows.filter((r) => r.debtorType === 'COMPANY')
          } else if (values.includes('COMPANY') && values.includes('DROP')) {
            // listSeniorObligations passes inArray(['COMPANY','DROP'])
            rows = rows.filter((r) => r.debtorType === 'COMPANY' || r.debtorType === 'DROP')
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

  // Mock InvoicesService — only `autoCreateForSeniorPayout` is called.
  const invoicesMock = {
    autoCreateForSeniorPayout: vi.fn(async (transactionId: string) => {
      state.invoiceCalls.push(transactionId)
    }),
  } as unknown as InvoicesService

  const svc = new PendingSettlementService(dbStub as never, invoicesMock)
  return {
    svc,
    state,
    invoicesMock,
    getInsertsFor: (table: unknown) =>
      state.inserts.filter((i) => i.table === table).map((i) => i.row),
    getUpdatesFor: (table: unknown) =>
      state.updates.filter((u) => u.table === table).map((u) => u.set),
  }
}

// ── settleByCompany ─────────────────────────────────────────────────────────

describe('PendingSettlementService.settleByCompany', () => {
  it('closes COMPANY obligation + inserts SENIOR_INCOME transaction', async () => {
    const { svc, getInsertsFor, getUpdatesFor, state } = makeService()
    const result = await svc.settleByCompany(OBLIGATION_COMPANY, accountantUser)

    const txInserts = getInsertsFor(transactions)
    expect(txInserts).toHaveLength(1)
    expect(txInserts[0]?.['type']).toBe('SENIOR_INCOME')
    expect(txInserts[0]?.['senderLabel']).toBe('COMPANY')
    expect(txInserts[0]?.['receiverId']).toBe(SENIOR_ID)
    expect(txInserts[0]?.['amount']).toBe('560')
    expect(txInserts[0]?.['status']).toBe('PAID')
    // task-drop-payout-company-account: a COMPANY-debt settlement debits the
    // company account, so the closing SENIOR_INCOME carries the COMPANY_ACCOUNT
    // funding marker (the ledger SSOT subtracts it).
    expect(txInserts[0]?.['fundingSource']).toBe('COMPANY_ACCOUNT')

    const oblUpdates = getUpdatesFor(pendingObligations)
    expect(oblUpdates).toHaveLength(1)
    expect(oblUpdates[0]?.['status']).toBe('PAID')
    expect(oblUpdates[0]?.['closingTransactionId']).toBe('inserted-1')

    expect(result.obligation.status).toBe('PAID')
    expect(result.created).toHaveLength(1)
    expect(state.obligations.get(OBLIGATION_COMPANY)?.status).toBe('PAID')
  })

  it('triggers invoice auto-create on SENIOR_INCOME row', async () => {
    const { svc, state } = makeService()
    await svc.settleByCompany(OBLIGATION_COMPANY, accountantUser)
    expect(state.invoiceCalls).toHaveLength(1)
    expect(state.invoiceCalls[0]).toBe('inserted-1')
  })

  it('ADMIN may settle', async () => {
    const { svc, getInsertsFor } = makeService()
    await svc.settleByCompany(OBLIGATION_COMPANY, adminUser)
    expect(getInsertsFor(transactions)).toHaveLength(1)
  })

  it('rejects when company balance is insufficient for the obligation', async () => {
    // task-drop-payout-company-account: the company-account debit gate refuses to
    // drive the balance negative. Obligation is 560; balance only 100.
    const { svc, getInsertsFor } = makeService({ companyBalance: 100 })
    await expect(svc.settleByCompany(OBLIGATION_COMPANY, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
    // Nothing booked when the gate fails.
    expect(getInsertsFor(transactions)).toHaveLength(0)
  })

  it('DROP forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.settleByCompany(OBLIGATION_COMPANY, dropUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('SENIOR forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.settleByCompany(OBLIGATION_COMPANY, seniorUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('JUNIOR forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.settleByCompany(OBLIGATION_COMPANY, juniorUser)).rejects.toThrow(
      ForbiddenException,
    )
  })

  it('legacy DROP-debt can also be closed by company (admin clean-up)', async () => {
    const { svc, getInsertsFor } = makeService({
      obligations: new Map([
        [OBLIGATION_COMPANY, makeObligation({ debtorType: 'DROP', debtorUserId: DROP_ID })],
      ]),
    })
    await svc.settleByCompany(OBLIGATION_COMPANY, adminUser)
    expect(getInsertsFor(transactions)).toHaveLength(1)
  })

  it('TOV obligation rejected → 400', async () => {
    const { svc } = makeService({
      obligations: new Map([
        [OBLIGATION_COMPANY, makeObligation({ debtorType: 'TOV', debtorUserId: null })],
      ]),
    })
    await expect(svc.settleByCompany(OBLIGATION_COMPANY, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('already-PAID obligation → 400', async () => {
    const { svc } = makeService({
      obligations: new Map([[OBLIGATION_COMPANY, makeObligation({ status: 'PAID' })]]),
    })
    await expect(svc.settleByCompany(OBLIGATION_COMPANY, accountantUser)).rejects.toThrow(
      BadRequestException,
    )
  })

  it('obligation not found → 404', async () => {
    const { svc } = makeService({ obligations: new Map() })
    await expect(svc.settleByCompany(OBLIGATION_COMPANY, accountantUser)).rejects.toThrow(
      NotFoundException,
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
    expect(result[0]?.debtorType).toBe('COMPANY')
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

describe('PendingSettlementService.listCompanyObligations', () => {
  it('ADMIN sees pending COMPANY debts', async () => {
    const { svc } = makeService()
    const result = await svc.listCompanyObligations(adminUser)
    expect(result).toHaveLength(1)
    expect(result[0]?.debtorType).toBe('COMPANY')
  })

  it('ACCOUNTANT sees pending COMPANY debts', async () => {
    const { svc } = makeService()
    const result = await svc.listCompanyObligations(accountantUser)
    expect(result).toHaveLength(1)
  })

  it('DROP forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.listCompanyObligations(dropUser)).rejects.toThrow(ForbiddenException)
  })

  it('SENIOR forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.listCompanyObligations(seniorUser)).rejects.toThrow(ForbiddenException)
  })

  it('JUNIOR forbidden → 403', async () => {
    const { svc } = makeService()
    await expect(svc.listCompanyObligations(juniorUser)).rejects.toThrow(ForbiddenException)
  })
})
