/**
 * task-drop-payout-currency — unit tests for `PendingSettlementService
 * .settleByCompany`'s DROP-only amount-conversion block.
 *
 * Mirrors the mock harness in `pending-settlement.spec.ts`, scoped to a
 * DROP_PENDING_PAYOUT source row (a SENIOR obligation's BIZ-03 currency guard
 * is already covered by `finance-bugs.unit.spec.ts` and is UNCHANGED by this
 * task — every fixture here uses `isDropObligation === true`).
 *
 * AC coverage (see .claude/tasks/task-drop-payout-currency.md):
 *   AC2 — default (omitted / same-as-obligation currency): no NBU round-trip,
 *         amount unchanged, exchangeRate = 1.
 *   AC3 — the written `amount` matches an independently-computed prediction
 *         via the SAME `convertToBase` function, to the penny.
 *   AC4 — original_amount/original_currency stamped on EVERY drop settle,
 *         including the same-currency case.
 *   AC5 — exchangeRate computed server-side; the client has no channel to
 *         supply one (SettleFunding carries no such field — TypeScript
 *         itself refuses an extra property, so there is nothing to smuggle).
 *         COMPANY_ACCOUNT ignores any currency the caller might still send
 *         (defense-in-depth, mirrors the schema-level refine).
 *   AC6 — an unrepresentable ratio is recorded as NULL, never a wrong number.
 *   AC7 — the obligation closes in full regardless of currency (no residual;
 *         the conditional UPDATE never compares amounts, only status).
 *   BIZ-03 exemption — a DROP settle in UAH/EUR does NOT throw (contrast with
 *         the SENIOR-scoped guard in finance-bugs.unit.spec.ts AC2-a/b).
 */
import { BadRequestException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { transactions } from '../database/schema'
import { PendingSettlementService } from './pending-settlement.service'
import type { InvoicesService } from '../invoices/invoices.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import { convertToBase, type BalanceCurrency } from './balance.service'
import { isStorableExchangeRate } from './exchange-rate.util'

const DROP_ID = '33333333-3333-4333-8333-333333333333'
const OBLIGATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SOURCE_TX_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const ADMIN_PAYER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const accountantUser: SessionUser = {
  id: 'acc-1',
  role: 'ACCOUNTANT',
  displayName: 'Accountant',
  email: 'a@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 0,
}

const DEFAULT_RATES = { usdUah: '41.50', usdtUah: '41.50', eurUah: '44.80', date: '20260812' }

function makeObligation(overrides: Record<string, unknown> = {}) {
  return {
    id: OBLIGATION_ID,
    creditorUserId: DROP_ID,
    debtorType: 'COMPANY' as const,
    debtorUserId: null as string | null,
    sourceTransactionId: SOURCE_TX_ID,
    closingTransactionId: null as string | null,
    amount: '1000',
    currency: 'USDT' as const,
    status: 'PENDING' as const,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  }
}

function makeSourceTx(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_TX_ID,
    type: 'DROP_PENDING_PAYOUT' as const,
    projectId: null,
    amount: '1000',
    currency: 'USDT' as const,
    senderId: null,
    receiverId: DROP_ID,
    recipientId: DROP_ID,
    senderLabel: 'COMPANY',
    receiverLabel: null,
    status: 'PENDING_PAYMENT' as const,
    payoutRequestId: null,
    // declareUsdtProjectIncome-booked (non-cascade) — «Счёт компании» is a
    // legal funding choice; not the HIGH-1 cascade case (out of scope here).
    dropCascadeOrigin: false,
    seniorSharePercent: null,
    seniorSharePercentSource: null,
    dropSharePercent: 26,
    dropSharePercentSource: 'PROJECT',
    fundingSource: null,
    txHash: null,
    validatedBy: null,
    validatedAt: null,
    rejectionReason: null,
    notes: 'Drop IOU (debtor=COMPANY)',
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

interface MockState {
  obligation: ReturnType<typeof makeObligation>
  sourceTx: ReturnType<typeof makeSourceTx>
  admins: Array<{ id: string; displayName: string; role: string }>
  flips: Array<{ txId: string; set: Record<string, unknown> }>
  rates: typeof DEFAULT_RATES
}

function makeService(initial: Partial<MockState> = {}) {
  const state: MockState = {
    obligation: makeObligation(),
    sourceTx: makeSourceTx(),
    admins: [{ id: ADMIN_PAYER_ID, displayName: 'Admin Payer', role: 'ADMIN' }],
    flips: [],
    rates: DEFAULT_RATES,
    ...initial,
  }

  const collectStringValues = (obj: unknown, acc: string[] = [], depth = 0): string[] => {
    if (acc.length > 120 || depth > 12 || obj === null || obj === undefined) return acc
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
      if (key === 'table' || key === 'schema' || key === 'enumValues' || key === 'usedTables')
        continue
      collectStringValues(val, acc, depth + 1)
    }
    return acc
  }

  let obligationStatus: 'PENDING' | 'PAID' | 'CANCELLED' = state.obligation.status
  let ledgerSelectCount = 0

  const mkDbtx = () => ({
    execute: vi.fn(async () => undefined),
    // computeCompanyAccountBalanceFromLedger sums N ledger terms (one select
    // per term). Attribute the whole balance to the FIRST term and 0 to every
    // other so the derived balance equals exactly 1_000_000 (gate passes) —
    // mirrors pending-settlement.spec.ts's makeService.
    select: () => ({
      from: () => ({
        where: async () => {
          const count = ledgerSelectCount++
          return [{ total: count === 0 ? '1000000' : '0' }]
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (predicate: unknown) => {
          const values = collectStringValues(predicate)
          if (table === transactions) {
            const isStatusGuarded = values.includes('PENDING_PAYMENT')
            const stillPendingPayment = state.sourceTx.status === 'PENDING_PAYMENT'
            const rows =
              isStatusGuarded && !stillPendingPayment
                ? []
                : (() => {
                    const flipped = { ...state.sourceTx, ...patch }
                    state.sourceTx = flipped as ReturnType<typeof makeSourceTx>
                    state.flips.push({ txId: SOURCE_TX_ID, set: patch })
                    return [flipped]
                  })()
            const result = Promise.resolve(rows) as Promise<Array<Record<string, unknown>>> & {
              returning: (..._args: unknown[]) => Promise<Array<Record<string, unknown>>>
            }
            result.returning = async () => rows
            return result
          }
          // pending_obligations conditional UPDATE.
          const isStatusGuarded = values.includes('PENDING')
          const rows =
            isStatusGuarded && obligationStatus !== 'PENDING'
              ? []
              : (() => {
                  if ('status' in patch)
                    obligationStatus = patch['status'] as typeof obligationStatus
                  return [{ id: OBLIGATION_ID }]
                })()
          const result = Promise.resolve(rows) as Promise<Array<{ id: string }>> & {
            returning: (..._args: unknown[]) => Promise<Array<{ id: string }>>
          }
          result.returning = async () => rows
          return result
        },
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) => ({
        returning: async () => [{ id: 'unused', ...row }],
      }),
    }),
  })

  const drizzleClient = {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mkDbtx()),
    // Best-effort audit-log insert runs OUTSIDE the transaction (fire-and-
    // forget — a logging hiccup must never turn a successful settle into a
    // 500). Not asserted on here; just needs to not throw.
    insert: () => ({
      values: async () => undefined,
    }),
    query: {
      pendingObligations: {
        findFirst: vi.fn(async () => ({ ...state.obligation, status: obligationStatus })),
      },
      transactions: {
        findFirst: vi.fn(async () => state.sourceTx),
      },
      projects: { findFirst: vi.fn(async () => null) },
      users: {
        findFirst: vi.fn(async (args: unknown) => {
          const values = collectStringValues(args)
          return state.admins.find((a) => values.includes(a.id))
        }),
      },
    },
  }
  const db = { db: drizzleClient } as never

  const invoicesMock = {
    autoCreateForSeniorPayout: vi.fn(async () => undefined),
  } as unknown as InvoicesService

  const getRates = vi.fn(async () => state.rates)
  const nbuMock = { getRates } as unknown as NbuCurrencyService

  const svc = new PendingSettlementService(db, invoicesMock, nbuMock)
  return {
    svc,
    state,
    getRates,
    settledTx: () => state.sourceTx as unknown as Record<string, unknown>,
    obligationStatus: () => obligationStatus,
  }
}

const RECEIPT_EXPLORER = { receiptExternalUrl: 'https://etherscan.io/tx/0xdropcurrency' }
const RECEIPT_FILE = { receiptExternalUrl: 'https://drive.google.com/file/dropcurrency' }

describe('settleByCompany — DROP obligation, currency conversion (task-drop-payout-currency)', () => {
  it('AC2/AC4: default currency (omitted) — no NBU call, amount unchanged, exchangeRate=1, original snapshot stamped', async () => {
    const { svc, settledTx, getRates } = makeService()
    await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      ...RECEIPT_EXPLORER,
    })
    const row = settledTx()
    expect(row['amount']).toBe('1000')
    expect(row['originalAmount']).toBe('1000')
    expect(row['originalCurrency']).toBe('USDT')
    expect(parseFloat(row['exchangeRate'] as string)).toBeCloseTo(1, 6)
    // Same-currency short-circuit — the NBU round-trip is skipped entirely.
    expect(getRates).not.toHaveBeenCalled()
  })

  it('AC3/AC4: UAH settle — amount matches an independently-computed convertToBase prediction to the penny', async () => {
    const { svc, settledTx, state } = makeService()
    const result = await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      currency: 'UAH',
      ...RECEIPT_FILE,
    })
    const predicted = convertToBase(1000, 'USDT' as BalanceCurrency, 'UAH' as BalanceCurrency, {
      ...state.rates,
    })
    const row = settledTx()
    expect(parseFloat(row['amount'] as string)).toBeCloseTo(predicted, 6)
    expect(predicted).toBeCloseTo(41500, 2) // 1000 USDT * 41.50 UAH/USD
    expect(row['originalAmount']).toBe('1000')
    expect(row['originalCurrency']).toBe('USDT')
    expect(row['currency']).toBe('UAH')
    expect(parseFloat(row['exchangeRate'] as string)).toBeCloseTo(41.5, 6)

    // task-drop-payout-currency (mutation-gate): the RESPONSE DTO
    // (`toTransactionDto`) must surface the same snapshot too — a reader of
    // the settle response (not just the raw DB row) needs to see it.
    const created = result.created[0]
    expect(created).toBeTruthy()
    expect(parseFloat(created!.originalAmount!)).toBeCloseTo(1000, 6)
    expect(created!.originalCurrency).toBe('USDT')
    expect(created!.exchangeRate).not.toBeNull()
    expect(parseFloat(created!.exchangeRate!)).toBeCloseTo(41.5, 6)
  })

  it('AC3: EUR settle — amount matches convertToBase triangulation exactly', async () => {
    const { svc, settledTx, state } = makeService()
    await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      currency: 'EUR',
      ...RECEIPT_FILE,
    })
    const predicted = convertToBase(1000, 'USDT' as BalanceCurrency, 'EUR' as BalanceCurrency, {
      ...state.rates,
    })
    const row = settledTx()
    expect(parseFloat(row['amount'] as string)).toBeCloseTo(predicted, 6)
    expect(row['currency']).toBe('EUR')
  })

  it('AC7: the obligation closes in FULL regardless of the settled currency — no residual left', async () => {
    const { svc, obligationStatus } = makeService()
    const result = await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      currency: 'EUR',
      ...RECEIPT_FILE,
    })
    expect(obligationStatus()).toBe('PAID')
    expect(result.obligation.status).toBe('PAID')
    // A second settle of the SAME obligation is rejected — nothing left open.
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'USD',
        ...RECEIPT_FILE,
      }),
    ).rejects.toThrow(BadRequestException)
  })

  it('BIZ-03 exemption: a DROP settle in UAH does NOT throw (contrast with the SENIOR-only guard)', async () => {
    const { svc } = makeService()
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'UAH',
        ...RECEIPT_FILE,
      }),
    ).resolves.toBeDefined()
  })

  it('BIZ-03 exemption: a DROP settle in EUR does NOT throw', async () => {
    const { svc } = makeService()
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'EUR',
        ...RECEIPT_FILE,
      }),
    ).resolves.toBeDefined()
  })

  it('AC5 (defense-in-depth): COMPANY_ACCOUNT forces USDT even if a caller bypasses the schema and sends a mismatched currency', async () => {
    const { svc, settledTx } = makeService()
    // The shared Zod schema (refineCompanyAccountUsdt) would reject this at
    // the HTTP boundary — this proves the SERVICE itself does not trust an
    // out-of-band caller either: `currency` is force-overwritten to USDT in
    // the COMPANY_ACCOUNT branch regardless of what `funding.currency` says.
    await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'COMPANY_ACCOUNT',
      currency: 'UAH' as never,
      ...RECEIPT_EXPLORER,
    })
    const row = settledTx()
    expect(row['currency']).toBe('USDT')
    expect(row['amount']).toBe('1000')
  })

  it('AC6: an unrepresentable ratio (rate below numeric(18,8) resolution) is recorded as NULL, not a wrong number', async () => {
    const { svc, settledTx } = makeService({
      rates: { usdUah: '0.000000005', usdtUah: '0.000000005', eurUah: '44.80', date: '20260812' },
    })
    await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      currency: 'UAH',
      ...RECEIPT_FILE,
    })
    const row = settledTx()
    // Both amounts ARE storable (the obligation and the tiny converted
    // figure) — only the ratio (5e-9, below the 1e-8 floor) cannot be.
    expect(row['exchangeRate']).toBeNull()
    expect(row['amount']).not.toBeNull()
    expect(row['originalAmount']).toBe('1000')
  })

  it('AC6: an unrepresentable ratio (rate at/above the numeric(18,8) ceiling) is recorded as NULL', async () => {
    const { svc, settledTx } = makeService({
      rates: { usdUah: '20000000000', usdtUah: '20000000000', eurUah: '44.80', date: '20260812' },
    })
    await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      currency: 'UAH',
      ...RECEIPT_FILE,
    })
    const row = settledTx()
    expect(row['exchangeRate']).toBeNull()
    expect(row['amount']).not.toBeNull()
  })

  // mutation-gate: a NEGATIVE obligation.amount (unreachable in practice —
  // Zod's `.positive()` rejects it at creation — but the guard exists
  // defensively) is the ONLY value that actually distinguishes
  // `Number.isFinite(x) && x > 0` from a version that skips the check
  // (`true`) or loosens it (`x >= 0`, `||`): at exactly 0 the ratio collapses
  // to 0/0=NaN under EVERY reading (still NULL either way — see the
  // Stryker-disable comment on `> 0` in the source), but at a genuine
  // negative value `paidAmount/obligationAmount` is a real, POSITIVE,
  // storable number (two negatives), which the guard must still refuse.
  it('AC6 (defense-in-depth): a corrupted NEGATIVE obligation.amount still yields NULL exchangeRate, never a computed number', async () => {
    const { svc, settledTx } = makeService({ obligation: makeObligation({ amount: '-100' }) })
    await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      currency: 'UAH',
      ...RECEIPT_FILE,
    })
    const row = settledTx()
    // Sanity: the ratio WOULD be a real, storable 41.5 if the guard were
    // bypassed (-4150 / -100 = 41.5) — proving this is a genuine behavioural
    // fork, not a vacuous check.
    expect(row['exchangeRate']).toBeNull()
  })

  it('sanity: isStorableExchangeRate boundary matches what settleByCompany relies on', () => {
    expect(isStorableExchangeRate(41.5)).toBe(true)
    expect(isStorableExchangeRate(1e-8)).toBe(true)
    expect(isStorableExchangeRate(1e-9)).toBe(false)
    expect(isStorableExchangeRate(9.999999999e9)).toBe(true)
    expect(isStorableExchangeRate(1e10)).toBe(false)
    expect(isStorableExchangeRate(NaN)).toBe(false)
    expect(isStorableExchangeRate(Infinity)).toBe(false)
  })
})
