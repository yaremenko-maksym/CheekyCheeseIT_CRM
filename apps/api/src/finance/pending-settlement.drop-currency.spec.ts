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
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SessionUser } from '@crm/shared'
import { transactions } from '../database/schema'
import { PendingSettlementService } from './pending-settlement.service'
import type { InvoicesService } from '../invoices/invoices.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import { convertToBase, type BalanceCurrency } from './balance.service'
import { isStorableExchangeRate, settledAmountError } from './exchange-rate.util'

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
    // task-settled-amount-snapshot: NULL by default — a row that has never
    // been settled carries no snapshot yet.
    settledAmount: null as string | null,
    settledCurrency: null as string | null,
    settledSharePercent: null as number | null,
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
  flips: Array<{ txId: string; set: Record<string, unknown>; rawSet: Record<string, unknown> }>
  // `stale?` — task-drop-payout-currency (MED-2): NbuCurrencyService.getRates
  // marks a fallback/cached result `stale: true`; every fixture below defaults
  // to a live (non-stale) rate.
  // `rateDate?` — owner addendum (round 3): the date the rate ACTUALLY came
  // from (see nbu-currency.service.ts) — set to distinguish a graceful,
  // dated fallback from a genuine outage.
  rates: typeof DEFAULT_RATES & { stale?: boolean; rateDate?: string }
  // owner addendum (round 3): per-date rate overrides, keyed by the
  // YYYYMMDD `date` argument settleByCompany passes to `getRates` (see the
  // `getRates` mock below). A date with no entry here falls back to
  // `rates` — every EXISTING fixture/test that never sets this keeps
  // getting the SAME rate regardless of which date is requested, exactly
  // the pre-existing mock behaviour.
  ratesByDate?: Record<string, typeof DEFAULT_RATES & { stale?: boolean; rateDate?: string }>
  /**
   * task-fix-obligation-amount-divergence follow-up (MED-1, TOCTOU race).
   * When set, `query.pendingObligations.findFirst` (the OUTSIDE-of-transaction
   * `loadObligation` read `settleByCompany` uses for the drop currency-
   * conversion block) returns THIS amount instead of `state.obligation.amount`
   * — simulating an edit that committed after that read but before the
   * conditional claim inside the transaction, which stays keyed on the REAL
   * `state.obligation.amount`.
   */
  staleLoadAmount?: string
  /**
   * task-drop-topup (task 3b, AC7): the company-account balance the ledger
   * sum returns. Default keeps every pre-existing fixture's behaviour (a
   * balance no settle can exhaust); a test that wants to observe WHICH figure
   * the money gate demands sets it just above/below the expected one.
   */
  companyBalance?: string
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

  // task-settled-amount-snapshot (MED-3, security-review PR #599 round 1):
  // settleByCompany writes `settledAmount` as a DB-native SQL fragment —
  // `coalesce(transactions.settledAmount, 0) + delta` — via drizzle's `sql`
  // tagged template, not a JS-computed literal. Mirrors the identical helper
  // in pending-settlement.spec.ts — see its comment for the runtime shape.
  // task-drop-topup (task 3b): `amount` is written by the SAME DB-native
  // expression as `settledAmount` on the drop branch, so the same resolution
  // applies to both columns. `rawSet` below keeps the UNRESOLVED fragments, for
  // the one assertion that is about the expressions themselves rather than
  // about the number they produce.
  const resolveSettledAmountPatch = (value: unknown, priorValue: unknown): unknown => {
    if (
      value &&
      typeof value === 'object' &&
      Array.isArray((value as { queryChunks?: unknown }).queryChunks)
    ) {
      const chunks = (value as { queryChunks: unknown[] }).queryChunks
      const delta = chunks.find((c) => typeof c === 'number') as number | undefined
      const prior = typeof priorValue === 'string' ? parseFloat(priorValue) : 0
      return (prior + (delta ?? 0)).toFixed(6)
    }
    // task-drop-topup (task 3b): a PLAIN string written into a
    // `numeric(18, 6)` column comes back from Postgres with all six decimals —
    // `String(2500)` goes in, `'2500.000000'` comes out (proved directly by
    // `cascade-apply.integration.spec.ts`, which asserts exactly that against a
    // real database for a value the service writes as a bare `String(...)`).
    // The double used to hand back the JS string verbatim, so a settle "wrote"
    // `'1000'` here and `'1000.000000'` in production. Rendering both column
    // forms the same way the column does keeps this file honest about what a
    // reader of the row would actually see.
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value).toFixed(6)
    }
    return value
  }

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
          return [{ total: count === 0 ? (state.companyBalance ?? '1000000') : '0' }]
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
                    const priorSettled = (state.sourceTx as Record<string, unknown>)[
                      'settledAmount'
                    ]
                    const resolvedPatch = { ...patch }
                    for (const column of ['settledAmount', 'amount'] as const) {
                      if (column in patch)
                        resolvedPatch[column] = resolveSettledAmountPatch(
                          patch[column],
                          priorSettled,
                        )
                    }
                    const flipped = { ...state.sourceTx, ...resolvedPatch }
                    state.sourceTx = flipped as ReturnType<typeof makeSourceTx>
                    state.flips.push({ txId: SOURCE_TX_ID, set: resolvedPatch, rawSet: patch })
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
                  // MED-1 (TOCTOU): `amount` is the REAL, committed value —
                  // `state.obligation.amount` — never `staleLoadAmount` (that
                  // override only affects the OUTSIDE-of-transaction
                  // `findFirst` read below, simulating a race where the two
                  // now genuinely disagree).
                  return [{ id: OBLIGATION_ID, amount: state.obligation.amount }]
                })()
          const result = Promise.resolve(rows) as Promise<Array<{ id: string; amount: string }>> & {
            returning: (..._args: unknown[]) => Promise<Array<{ id: string; amount: string }>>
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
        // MED-1 (TOCTOU): this IS `loadObligation` — the OUTSIDE-of-
        // transaction read whose `.amount` feeds the DROP currency-
        // conversion block above. `staleLoadAmount` overrides just that
        // field so a race test can make it disagree with the REAL,
        // in-transaction-committed `state.obligation.amount` the claim
        // above returns.
        findFirst: vi.fn(async () => ({
          ...state.obligation,
          status: obligationStatus,
          ...(state.staleLoadAmount !== undefined ? { amount: state.staleLoadAmount } : {}),
        })),
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

  // owner addendum (round 3): the mock now HONOURS the `date` argument —
  // returns the per-date override when one is set for the requested
  // YYYYMMDD, else the plain `state.rates` (every existing test's shape,
  // date-independent — matches the pre-existing mock behaviour exactly).
  const getRates = vi.fn(async (date?: string) => {
    if (date && state.ratesByDate?.[date]) return state.ratesByDate[date]
    return state.rates
  })
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
  // owner addendum (2026-08): the legacy/no-funding call path
  // (`settleByCompany(id, actor)`, no third arg at all — still exercised by
  // `settleByCompanySourceTransaction`'s own callers and older tests) must
  // not crash resolving the date-of-record when `funding` itself is
  // `undefined` — `funding?.txDate` must short-circuit safely rather than
  // dereferencing a property of `undefined`.
  it('no funding arg at all (legacy call) — resolves the date-of-record safely, defaults to COMPANY_ACCOUNT/USDT', async () => {
    const { svc, settledTx, obligationStatus } = makeService()
    await svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(obligationStatus()).toBe('PAID')
    const row = settledTx()
    expect(row['currency']).toBe('USDT')
    expect(row['amount']).toBe('1000.000000')
  })

  it('AC2/AC4: default currency (omitted) — no NBU call, amount unchanged, exchangeRate=1, original snapshot stamped', async () => {
    const { svc, settledTx, getRates } = makeService()
    await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      ...RECEIPT_EXPLORER,
    })
    const row = settledTx()
    expect(row['amount']).toBe('1000.000000')
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
    // LOW (security-review PR #521 round 1): the WRITTEN amount is rounded to
    // money precision (2dp) — compare against the ROUNDED prediction, the same
    // way a caller displaying `.toFixed(2)` would. This UAH pair happens to
    // round to itself (41500.00); the EUR test below exercises a real
    // fractional case.
    expect(parseFloat(row['amount'] as string)).toBeCloseTo(Math.round(predicted * 100) / 100, 6)
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

  it('AC3: EUR settle — amount matches convertToBase triangulation, rounded to money precision', async () => {
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
    expect(parseFloat(row['amount'] as string)).toBeCloseTo(Math.round(predicted * 100) / 100, 6)
    expect(row['currency']).toBe('EUR')
  })

  // LOW (security-review PR #521 round 1): the raw division this pair
  // produces (1000 USDT → EUR via UAH) carries far more than 2 decimals —
  // 926.339285714286… — a "fact of payment" nobody could actually transfer.
  // The written amount must be the ROUNDED, payable figure, not the raw one.
  it('LOW: the written amount is rounded to 2 decimals — not the raw division result', async () => {
    const { svc, settledTx, state } = makeService()
    await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      currency: 'EUR',
      ...RECEIPT_FILE,
    })
    const rawPredicted = convertToBase(1000, 'USDT' as BalanceCurrency, 'EUR' as BalanceCurrency, {
      ...state.rates,
    })
    // Sanity: this pair genuinely has more than 2 decimals — proves the test
    // exercises real rounding, not a coincidentally-round number.
    expect(Math.round(rawPredicted * 100) / 100).not.toBe(rawPredicted)
    const row = settledTx()
    const writtenAmount = row['amount'] as string
    // Asserted on the VALUE, not on the JS string that produced it. The column
    // is `numeric(18, 6)`, so whatever shape the service writes, a reader gets
    // six decimals back — the old string comparison here was describing the
    // mock rather than the database (task-drop-topup, task 3b).
    expect(Number(writtenAmount)).toBe(Math.round(rawPredicted * 100) / 100)
    // Never the untruncated raw value.
    expect(Number(writtenAmount)).not.toBe(rawPredicted)
    // Rounded to money precision: a whole number of hundredths, i.e. a figure
    // someone could actually transfer.
    expect(Number.isInteger(Math.round(Number(writtenAmount) * 100))).toBe(true)
    expect(Number(writtenAmount) * 100).toBeCloseTo(Math.round(Number(writtenAmount) * 100), 6)
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
    expect(row['amount']).toBe('1000.000000')
  })

  it('AC6: an unrepresentable ratio (rate below numeric(18,8) resolution) is recorded as NULL, not a wrong number', async () => {
    // task-drop-payout-currency (LOW round 2): the ratio (ratio = the rate
    // itself, for a USDT obligation) is independent of the obligation's
    // amount, but the WRITTEN (rounded-to-2dp) paidAmount is not — a $1000
    // obligation at this rate would round to exactly 0.00 and get rejected by
    // the LOW-2 finiteness/ceiling guard before ever reaching the
    // exchangeRate check. A 1e9 obligation keeps the converted figure a real,
    // non-zero, storable 5.00 while the ratio itself is still 5e-9 (< 1e-8).
    const { svc, settledTx } = makeService({
      obligation: makeObligation({ amount: '1000000000' }),
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
    expect(row['amount']).toBe('5.000000')
    expect(row['originalAmount']).toBe('1000000000')
  })

  it('AC6: an unrepresentable ratio (rate at/above the numeric(18,8) ceiling) is recorded as NULL', async () => {
    // task-drop-payout-currency (LOW round 2): a $1000 obligation at this
    // rate would convert to 2e13 — far past the LOW-2 MAX_TRANSACTION_AMOUNT
    // guard, throwing before the exchangeRate check is ever reached. Shrink
    // the obligation so the CONVERTED figure (200 000) stays under the
    // ceiling while the ratio itself is still 2e10 (>= the 1e10 floor).
    const { svc, settledTx } = makeService({
      obligation: makeObligation({ amount: '0.00001' }),
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
    expect(row['amount']).toBe('200000.000000')
  })

  // LOW round 2 (security-review PR #521): a corrupted NEGATIVE
  // obligation.amount (unreachable in practice — Zod's `.positive()` rejects
  // it at creation) now gets caught EARLIER and more directly than an
  // exchangeRate-NULL outcome — `paidAmount` (obligationAmount × a positive
  // rate) is negative too, and the LOW-2 `transactionAmountError` gate
  // rejects it outright before the exchangeRate ratio is ever computed.
  it('LOW (defense-in-depth): a corrupted NEGATIVE obligation.amount is rejected outright (caught by the paidAmount guard, not silently converted)', async () => {
    const { svc } = makeService({ obligation: makeObligation({ amount: '-100' }) })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'UAH',
        ...RECEIPT_FILE,
      }),
    ).rejects.toThrow(BadRequestException)
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

  // MED-A (security-review PR #521 round 3): settledAmountError's own
  // boundary — direct unit coverage (settleByCompany only ever exercises it
  // indirectly through realistic amounts, which doesn't pin the CEILING
  // boundary precisely enough to distinguish `>` from `>=`).
  it('sanity: settledAmountError boundary — zero passes, negative/NaN/Infinity/over-ceiling reject, the ceiling itself is INCLUSIVE (> not >=)', () => {
    expect(settledAmountError(0, 500_000)).toBeNull()
    expect(settledAmountError(500_000, 500_000)).toBeNull() // exactly at the ceiling — allowed
    expect(settledAmountError(500_000.01, 500_000)).not.toBeNull() // one cent over — rejected
    expect(settledAmountError(-0.01, 500_000)).not.toBeNull()
    expect(settledAmountError(NaN, 500_000)).not.toBeNull()
    expect(settledAmountError(Infinity, 500_000)).not.toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MED-1 (security-review PR #521 round 1) — the BIZ-03 exemption is justified
// by "the amount is genuinely converted, not relabeled", which is silent
// exactly on the NO-conversion path (target currency === obligation currency,
// NBU intentionally skipped). A corrupted/legacy obligation.currency ≠ USDT
// must be refused, not silently copied under a wrong label.
// ─────────────────────────────────────────────────────────────────────────────
describe('settleByCompany — DROP obligation.currency invariant (MED-1, security-review PR #521 round 1)', () => {
  it('a corrupted obligation.currency (EUR) with the SAME target currency (no conversion would run) is rejected, not silently relabeled', async () => {
    const { svc } = makeService({ obligation: makeObligation({ currency: 'EUR' }) })
    // No `currency` field → defaults to obligation.currency ('EUR') →
    // targetCurrency === obligationCurrency → the OLD code would have taken
    // this exact "no conversion needed" shortcut and copied `amount` verbatim
    // under the EUR label — a clean rename of a USDT-denominated figure.
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        ...RECEIPT_FILE,
      }),
    ).rejects.toThrow(/USDT/)
  })

  it('a corrupted obligation.currency (EUR) with a DIFFERENT target currency is ALSO rejected (invariant checked before either branch)', async () => {
    const { svc } = makeService({ obligation: makeObligation({ currency: 'EUR' }) })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'UAH',
        ...RECEIPT_FILE,
      }),
    ).rejects.toThrow(BadRequestException)
  })

  it('a normal USDT obligation is unaffected by the invariant check', async () => {
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
})

// ─────────────────────────────────────────────────────────────────────────────
// MED-2 (security-review PR #521 round 1) — NbuCurrencyService.getRates()
// NEVER throws; on an NBU outage it silently returns a cached/hardcoded rate
// with `stale: true`. This is the first consumer to bake that rate into a
// PERMANENT, irreversible payout amount — a stale rate must be refused, not
// silently recorded as fact.
// ─────────────────────────────────────────────────────────────────────────────
describe('settleByCompany — stale NBU rate (MED-2, security-review PR #521 round 1)', () => {
  it('a stale rate is REFUSED when a real conversion is needed — no amount is written', async () => {
    const { svc, settledTx } = makeService({ rates: { ...DEFAULT_RATES, stale: true } })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'UAH',
        ...RECEIPT_FILE,
      }),
    ).rejects.toThrow(/курс/i)
    // Nothing was written — the source IOU is still PENDING_PAYMENT.
    expect(settledTx().status).toBe('PENDING_PAYMENT')
  })

  it('a FRESH (non-stale) rate succeeds for the identical conversion', async () => {
    const { svc } = makeService({ rates: { ...DEFAULT_RATES, stale: false } })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'UAH',
        ...RECEIPT_FILE,
      }),
    ).resolves.toBeDefined()
  })

  it('a stale rate does NOT block a settle that needs no conversion (same currency — NBU is never even called)', async () => {
    const { svc, getRates } = makeService({ rates: { ...DEFAULT_RATES, stale: true } })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'USDT',
        ...RECEIPT_EXPLORER,
      }),
    ).resolves.toBeDefined()
    expect(getRates).not.toHaveBeenCalled()
  })

  it('a stale rate does NOT block COMPANY_ACCOUNT (forced USDT — no conversion, NBU never called)', async () => {
    const { svc, getRates } = makeService({ rates: { ...DEFAULT_RATES, stale: true } })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'COMPANY_ACCOUNT',
        ...RECEIPT_EXPLORER,
      }),
    ).resolves.toBeDefined()
    expect(getRates).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LOW round 2 (security-review PR #521 round 1) — the server-computed amount
// is exempt from Zod's client-boundary validation (there is no client
// `amount` field) but must still obey the SAME rules: finite, positive, and
// within MAX_TRANSACTION_AMOUNT.
// ─────────────────────────────────────────────────────────────────────────────
describe('settleByCompany — server-computed amount still bounded (LOW round 2, security-review PR #521 round 1)', () => {
  it('a realistic obligation converted past MAX_TRANSACTION_AMOUNT is rejected, not silently written', async () => {
    // 50 000 USDT is a perfectly ordinary obligation on its own (well under
    // the ceiling at creation) — but converted to UAH at ~41.50 it becomes
    // ~2 075 000, almost 4× the project's own MAX_TRANSACTION_AMOUNT (500 000).
    const { svc, settledTx } = makeService({ obligation: makeObligation({ amount: '50000' }) })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'UAH',
        ...RECEIPT_FILE,
      }),
    ).rejects.toThrow(/превышать/)
    expect(settledTx().status).toBe('PENDING_PAYMENT')
  })

  it('a corrupted (non-numeric) obligation.amount on the same-currency path is rejected — Number.isFinite gap', async () => {
    // Same-currency path never calls convertToBase (which has its own
    // internal rate-finiteness guards) — `paidAmount` is `obligationAmount`
    // directly, so a garbage DB value flows straight to `String(paidAmount)`
    // (Postgres numeric literally accepts the string `'NaN'`) unless caught.
    const { svc } = makeService({ obligation: makeObligation({ amount: 'not-a-number' }) })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'USDT',
        ...RECEIPT_EXPLORER,
      }),
    ).rejects.toThrow(BadRequestException)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MED-A (security-review PR #521 round 3) — the round-1 LOW-2 fix
// (`transactionAmountError`, floor "> 0") became a REGRESSION for DROP: a
// 0%-share drop obligation is legitimately booked at amount='0'
// (`bookCompanyObligations` does no zero-filtering; the share is
// `min(0)`-validated), so round 1's fix permanently stranded every such
// obligation in "Ожидает выплаты". `settledAmountError`'s floor is ">= 0" —
// zero settles, negative/NaN/Infinity/over-ceiling still don't.
// ─────────────────────────────────────────────────────────────────────────────
describe('settleByCompany — zero-amount DROP obligation closes (MED-A, security-review PR #521 round 3)', () => {
  it('a zero-amount obligation (0%-share drop) settles successfully — same currency, no conversion', async () => {
    const { svc, settledTx, obligationStatus } = makeService({
      obligation: makeObligation({ amount: '0' }),
    })
    const result = await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      currency: 'USDT',
      ...RECEIPT_EXPLORER,
    })
    expect(obligationStatus()).toBe('PAID')
    const row = settledTx()
    expect(row['amount']).toBe('0.000000')
    expect(row['originalAmount']).toBe('0')
    // 0/0 is undefined, not zero — recorded as NULL, same as any other
    // unrepresentable ratio (see the comment on `rawExchangeRate` in
    // pending-settlement.service.ts).
    expect(row['exchangeRate']).toBeNull()
    expect(result.obligation.status).toBe('PAID')
  })

  it('a zero-amount obligation settles successfully through an actual currency conversion too (0 × rate = 0)', async () => {
    const { svc, settledTx } = makeService({ obligation: makeObligation({ amount: '0' }) })
    await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      currency: 'UAH',
      ...RECEIPT_FILE,
    })
    const row = settledTx()
    expect(row['amount']).toBe('0.000000')
    expect(row['exchangeRate']).toBeNull()
  })

  it('negative/NaN/over-ceiling paid amounts are still rejected — only the floor moved from ">0" to ">=0"', async () => {
    const { svc: svcNegative } = makeService({ obligation: makeObligation({ amount: '-1' }) })
    await expect(
      svcNegative.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'USDT',
        ...RECEIPT_EXPLORER,
      }),
    ).rejects.toThrow(BadRequestException)

    const { svc: svcOverCeiling } = makeService({
      obligation: makeObligation({ amount: '50000' }),
    })
    await expect(
      svcOverCeiling.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'UAH',
        ...RECEIPT_FILE,
      }),
    ).rejects.toThrow(/превышать/)
  })

  // security-review PR #521 round 3 (LOW, on the reviewer's own follow-up
  // after auditing MED-A): 2dp rounding can collapse a genuinely NON-zero
  // obligation to exactly 0.00 in the target currency ("dust") — the SAME
  // observable shape as a real 0%-share obligation, but a DIFFERENT fact
  // (a debt that still exists vs. one that never did). `obligationAmount >
  // 0` is what distinguishes them; a 0%-share settle (asserted above) must
  // still succeed, dust must not.
  it('a NON-zero obligation that rounds to 0.00 in the target currency ("dust") is REFUSED, not silently recorded as zero', async () => {
    // 0.0001 USDT × 41.50 UAH/USD = 0.00415 UAH — rounds to 0.00, but the
    // obligation itself is genuinely non-zero.
    const { svc } = makeService({ obligation: makeObligation({ amount: '0.0001' }) })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'UAH',
        ...RECEIPT_FILE,
      }),
    ).rejects.toThrow(/после округления/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LOW (security-review PR #521 round 3) — the "nothing to convert" fast path
// used to key off an EXACT currency-string match only. USD⇄USDT is pegged
// 1:1 (convertToBase's own short-circuit) — the obligation is always USDT
// (MED-1), so paying it out in USD is likewise a no-op, not a real rate
// application, and must not be blocked by an NBU outage either.
// ─────────────────────────────────────────────────────────────────────────────
describe('settleByCompany — USD⇄USDT peg pair skips the NBU round-trip (LOW, security-review PR #521 round 3)', () => {
  it('paying a USDT obligation out in USD needs no rate — a stale/outage rate does NOT block it', async () => {
    const { svc, getRates, settledTx } = makeService({ rates: { ...DEFAULT_RATES, stale: true } })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'USD',
        ...RECEIPT_FILE,
      }),
    ).resolves.toBeDefined()
    expect(getRates).not.toHaveBeenCalled()
    expect(settledTx()['amount']).toBe('1000.000000') // passthrough, not "1 : 41.50"
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// owner addendum (2026-08, security-review PR #521 round 3) — «При оплате
// доли дропа должна быть возможность выбрать дату, и нужно считать курс
// согласно выбранной даты транзакции». The rate used to compute the paid
// amount, and the flipped row's `txDate`, both follow the OPERATOR-SELECTED
// date — not "today" — when one is sent.
// ─────────────────────────────────────────────────────────────────────────────
describe('settleByCompany — date-of-record: selected date drives BOTH the applied rate and txDate (owner addendum, round 3)', () => {
  // The single test the owner called out as the main one for this part: two
  // DIFFERENT past dates with two DIFFERENT known rates. Only a genuine
  // date-of-record implementation can pass both assertions — a fixture that
  // secretly ignores the date and always uses "today"/a single global rate
  // could not distinguish "used the selected date" from "used today".
  it("owner's main test — settling at two different SELECTED dates applies each date's OWN rate, and records THAT date as txDate", async () => {
    const DATE_A = '2026-07-10' // rate 40.00
    const DATE_B = '2026-07-20' // rate 45.00
    const svcA = makeService({
      obligation: makeObligation({ createdAt: new Date('2026-07-01T00:00:00Z') }),
      ratesByDate: {
        '20260710': { usdUah: '40.00', usdtUah: '40.00', eurUah: '44.80', date: '20260710' },
      },
    })
    const resultA = await svcA.svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      currency: 'UAH',
      txDate: DATE_A,
      ...RECEIPT_FILE,
    })
    const rowA = svcA.settledTx()
    expect(rowA['amount']).toBe('40000.000000') // 1000 USDT × 40.00
    expect((rowA['txDate'] as Date).toISOString().slice(0, 10)).toBe(DATE_A)
    expect(resultA.created[0]?.amount).toBe('40000.000000')

    const svcB = makeService({
      obligation: makeObligation({ createdAt: new Date('2026-07-01T00:00:00Z') }),
      ratesByDate: {
        '20260720': { usdUah: '45.00', usdtUah: '45.00', eurUah: '44.80', date: '20260720' },
      },
    })
    const resultB = await svcB.svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      currency: 'UAH',
      txDate: DATE_B,
      ...RECEIPT_FILE,
    })
    const rowB = svcB.settledTx()
    expect(rowB['amount']).toBe('45000.000000') // 1000 USDT × 45.00 — a DIFFERENT rate
    expect((rowB['txDate'] as Date).toISOString().slice(0, 10)).toBe(DATE_B)
    expect(resultB.created[0]?.amount).toBe('45000.000000')

    // The two settlements genuinely differ — proves this isn't a fixture
    // that would produce the same number regardless of which date was sent.
    expect(rowA['amount']).not.toBe(rowB['amount'])
  })

  it('no txDate sent → legacy behaviour: "now" is used for the rate, txDate column is left untouched', async () => {
    const { svc, settledTx, getRates, state } = makeService()
    const originalTxDate = state.sourceTx.txDate
    await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      currency: 'UAH',
      ...RECEIPT_FILE,
    })
    // getRates was called with NO date argument (⇒ NbuCurrencyService
    // defaults to today internally) — byte-for-byte the pre-existing call.
    expect(getRates).toHaveBeenCalledWith(undefined)
    const row = settledTx()
    expect(row['txDate']).toBe(originalTxDate) // untouched, not overwritten
  })

  it('a selected date BEFORE the obligation existed is rejected — nothing to backdate a payment of a not-yet-booked debt', async () => {
    const { svc } = makeService({
      obligation: makeObligation({ createdAt: new Date('2026-08-01T00:00:00Z') }),
    })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'USDT',
        txDate: '2026-07-31', // one day before the obligation's own creation
        ...RECEIPT_EXPLORER,
      }),
    ).rejects.toThrow(/раньше даты возникновения/)
  })

  it('a selected date EQUAL to the obligation creation date is accepted (the boundary is inclusive)', async () => {
    const { svc } = makeService({
      obligation: makeObligation({ createdAt: new Date('2026-08-01T00:00:00Z') }),
    })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'USDT',
        txDate: '2026-08-01',
        ...RECEIPT_EXPLORER,
      }),
    ).resolves.toBeDefined()
  })

  it('a same-currency settle still records the selected txDate even though no rate is fetched', async () => {
    const { svc, settledTx, getRates } = makeService({
      obligation: makeObligation({ createdAt: new Date('2026-08-01T00:00:00Z') }),
    })
    await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      currency: 'USDT',
      txDate: '2026-08-05',
      ...RECEIPT_EXPLORER,
    })
    expect(getRates).not.toHaveBeenCalled()
    const row = settledTx()
    expect((row['txDate'] as Date).toISOString().slice(0, 10)).toBe('2026-08-05')
  })

  // Refined MED-2 (owner addendum): a graceful, DATED fallback (a holiday
  // with no same-day publication, but a real number from the nearest prior
  // business day) is NOT the same failure as a genuine feed outage. Only
  // the outage case (no `rateDate` at all) is refused.
  it('a graceful, DATED fallback (rateDate set) is ACCEPTED — not the same as a genuine outage', async () => {
    const { svc, settledTx } = makeService({
      obligation: makeObligation({ createdAt: new Date('2026-08-01T00:00:00Z') }),
      ratesByDate: {
        '20260810': {
          usdUah: '42.00',
          usdtUah: '42.00',
          eurUah: '44.80',
          date: '20260810', // echoes the REQUESTED date (NbuCurrencyService convention)
          stale: true,
          rateDate: '20260809', // but the numbers actually came from the day before
        },
      },
    })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'UAH',
        txDate: '2026-08-10',
        ...RECEIPT_FILE,
      }),
    ).resolves.toBeDefined()
    expect(settledTx()['amount']).toBe('42000.000000') // used the FALLBACK rate, not refused
  })

  it('a genuine outage (stale, no rateDate at all) is STILL refused, even for a past selected date', async () => {
    const { svc } = makeService({
      obligation: makeObligation({ createdAt: new Date('2026-08-01T00:00:00Z') }),
      ratesByDate: {
        '20260810': {
          usdUah: '42.00',
          usdtUah: '42.00',
          eurUah: '44.80',
          date: '20260810',
          stale: true, // no rateDate — cache/hardcoded, no dated source at all
        },
      },
    })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'UAH',
        txDate: '2026-08-10',
        ...RECEIPT_FILE,
      }),
    ).rejects.toThrow(/курс/i)
  })
})

// ── task-fix-obligation-amount-divergence follow-up (MED-1, TOCTOU race —
// DROP branch). The SENIOR-side race is covered in pending-settlement.spec.ts;
// this is the SAME defect on the branch the reviewer flagged as strictly
// worse (MED-4): the DROP currency-conversion block above computes
// `paidAmount`/`originalAmount`/`exchangeRate` from `parseFloat(obligation.amount)`
// — the OUTSIDE-of-transaction snapshot — and writes `paidAmount` VERBATIM
// onto the flipped, about-to-be-CLOSED row. If that snapshot is stale, the
// written amount silently reverts to whatever the edit OVERWROTE, on a row
// that (post-settle) is a historical record — L4, unrecoverable after the
// fact. The guard added to settleByCompany runs BEFORE this whole
// currency-conversion block is even reached in real Postgres (loadObligation
// → the DB transaction → the claim+equality-check → THEN the flip that uses
// paidAmount) — but the derived values are actually computed OUTSIDE the
// transaction, earlier in the method, from the same stale `obligation`. This
// suite proves the claim-time equality check still catches it: no flip, no
// stale amount ever reaches a written row.
describe('settleByCompany — DROP obligation: MED-1 TOCTOU race (obligation.amount edited between the read and the claim)', () => {
  it('refuses when the amount changed since loadObligation — no flip, the stale-derived paidAmount is never written', async () => {
    const { svc, getRates } = makeService({ staleLoadAmount: '1' })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        ...RECEIPT_EXPLORER,
      }),
    ).rejects.toThrow(/изменилась после загрузки/)
    // Same-currency (default) path never needed a rate either way — the
    // refusal happens on the claim, well before any conversion could run.
    expect(getRates).not.toHaveBeenCalled()
  })

  it('refuses even through an actual currency conversion (UAH) — the stale amount is never converted or written', async () => {
    const { svc, settledTx } = makeService({ staleLoadAmount: '1' })
    const before = settledTx()
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'UAH',
        ...RECEIPT_FILE,
      }),
    ).rejects.toThrow(/изменилась после загрузки/)
    // The source IOU row is byte-identical to before the call — still
    // PENDING_PAYMENT, `amount` untouched (not overwritten with a paidAmount
    // derived from the stale snapshot).
    expect(settledTx()).toEqual(before)
  })

  it('an UNCHANGED amount settles normally — no false positive on the DROP branch either', async () => {
    const { svc, settledTx } = makeService({ staleLoadAmount: '1000' })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        ...RECEIPT_EXPLORER,
      }),
    ).resolves.toBeDefined()
    expect(settledTx()['status']).toBe('PAID')
    expect(settledTx()['amount']).toBe('1000.000000')
  })
})

// ── task-settled-amount-snapshot (AC3, AC5) ─────────────────────────────────
// DROP-specific: a drop obligation can settle in a currency OTHER than its
// own USDT — proves settled_amount/settled_currency stamp the CONVERTED FACT
// (what actually got paid), never the obligation's own USDT figure, and that
// settled_share_percent snapshots the DROP side (dropSharePercent), never the
// SENIOR side (seniorSharePercent, always null on a drop row).
describe('settleByCompany — settled-amount snapshot, DROP currency conversion (task-settled-amount-snapshot)', () => {
  it('AC3/AC4: a DROP settle converted to EUR stamps settled_amount = the CONVERTED fact (not the 1000 USDT obligation amount) and settled_currency = EUR (not USDT)', async () => {
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
    const roundedPredicted = Math.round(predicted * 100) / 100
    const row = settledTx()
    // Independently-derived prediction — same source `convertToBase` the
    // service itself calls — matches the WRITTEN settled_amount, not the
    // obligation's own USDT amount (1000).
    expect(parseFloat(row['settledAmount'] as string)).toBeCloseTo(roundedPredicted, 6)
    expect(parseFloat(row['settledAmount'] as string)).not.toBeCloseTo(1000, 6)
    // settled_amount must equal the row's own written `amount` (the FACT) —
    // both come from the same `paidAmount`, so they can never disagree.
    expect(parseFloat(row['settledAmount'] as string)).toBeCloseTo(
      parseFloat(row['amount'] as string),
      6,
    )
    expect(row['settledCurrency']).toBe('EUR')
  })

  it('AC4: the same-currency (USDT) default settle stamps settled_amount = the full 1000, settled_currency = USDT', async () => {
    const { svc, settledTx } = makeService()
    await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      ...RECEIPT_EXPLORER,
    })
    const row = settledTx()
    expect(row['settledAmount']).toBe('1000.000000')
    expect(row['settledCurrency']).toBe('USDT')
  })

  it('AC5: settled_share_percent snapshots the DROP side (dropSharePercent=26), never the SENIOR side (seniorSharePercent, null on a drop row)', async () => {
    const { svc, settledTx } = makeService()
    await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      ...RECEIPT_EXPLORER,
    })
    const row = settledTx()
    expect(row['settledSharePercent']).toBe(26)
    // The original columns are nulled by this same flip (pre-existing
    // behaviour, unaffected by this task) — the snapshot is a COPY, not a
    // second reference to the same live column.
    expect(row['dropSharePercent']).toBeNull()
    expect(row['seniorSharePercent']).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// task-drop-topup (task 3b) — closing the REMAINDER of a drop obligation.
//
// Everything below was unreachable before this task: `settleByCompany` refused
// outright on `isDropObligation && priorSettledAmount > 0`, and the cascade
// refused to produce that state in the first place (AC15(a)).
//
// The stakes, in one line: get the conversion input wrong and the drop is paid
// the full obligation a SECOND time (Л1 of addendum 3b) — an error in the "+"
// direction on a path where nothing downstream recomputes the figure.
// ---------------------------------------------------------------------------

/** The numeric delta bound into a `coalesce(settled_amount, 0) + ?` fragment. */
function fragmentDelta(fragment: unknown): number | undefined {
  const chunks = (fragment as { queryChunks?: unknown[] }).queryChunks
  if (!Array.isArray(chunks)) return undefined
  return chunks.find((c) => typeof c === 'number') as number | undefined
}

/** The fragment as Postgres will actually receive it: text plus bound values. */
function compiled(fragment: unknown) {
  const { sql: text, params } = new PgDialect().sqlToQuery(fragment as SQL)
  return { text, params }
}

/**
 * A drop row that has ALREADY been paid part of its obligation and then had the
 * obligation reopened by a cascade revert: obligation 130, of which 100 is
 * recorded as paid. The revert nulled the payment-fact triplet (task 3b, AC2),
 * which is why the row carries no `originalAmount` here.
 */
function toppedUpService(overrides: Partial<MockState> = {}) {
  return makeService({
    obligation: makeObligation({ amount: '130' }),
    sourceTx: makeSourceTx({
      amount: '100.000000',
      settledAmount: '100.000000',
      settledCurrency: 'USDT',
      settledSharePercent: 26,
      // The first payment came from the company account, with no personal
      // payer — the pair the AC14 guard (#607) requires the top-up to match.
      fundingSource: 'COMPANY_ACCOUNT',
      senderId: null,
      senderLabel: 'COMPANY',
    }),
    ...overrides,
  })
}

describe('settleByCompany — DROP top-up of a partly paid obligation (task 3b)', () => {
  it('AC3: the conversion runs on the REMAINDER — 30 leaves, not the obligation`s full 130', async () => {
    // Л1, the expensive one. Feeding the conversion the obligation's full
    // figure pays 130 on a debt of which 100 is already paid: 230 out the door
    // for a 130 obligation, and `amount` (130) parts ways with `settled_amount`
    // (230), which is the invariant ledger term 9 stands on.
    const { svc, state } = toppedUpService()
    await svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(state.flips).toHaveLength(1)
    expect(fragmentDelta(state.flips[0]!.rawSet['settledAmount'])).toBe(30)
  })

  it('AC4: `amount` and the accumulator are written from ONE expression object', async () => {
    // Asserted as REFERENCE identity, not as equal compiled text — deliberately,
    // and the difference is the whole finding CR-M-1 raised.
    //
    // While the expression was written out twice, comparing the compiled forms
    // was the only thing standing between the two columns; now they come from
    // one `const`, so comparing compiled text would pass by construction — a
    // tautology, the kind of test that cannot fail and therefore says nothing.
    // `toBe` still can fail, on exactly the regression worth catching: someone
    // re-inlining a fresh `sql\`…\`` into one of the two keys. Identical text,
    // different object, red here.
    const { svc, state } = toppedUpService()
    await svc.settleByCompany(OBLIGATION_ID, accountantUser)
    const raw = state.flips[0]!.rawSet
    expect(raw['amount']).toBe(raw['settledAmount'])
    // …and it IS a DB-side expression, not a JS literal that happens to match.
    expect(compiled(raw['amount']).text).toContain('coalesce')
    expect(compiled(raw['amount']).params).toContain(30)
  })

  it('AC4: both columns therefore land on the accumulated figure, not on this payment', async () => {
    const { svc, settledTx } = toppedUpService()
    await svc.settleByCompany(OBLIGATION_ID, accountantUser)
    const row = settledTx()
    expect(row['amount']).toBe('130.000000')
    expect(row['settledAmount']).toBe('130.000000')
    // The unit label travels with the figure — both of them.
    expect(row['currency']).toBe('USDT')
    expect(row['settledCurrency']).toBe('USDT')
  })

  it('AC5: the recorded rate is the CLOSURE`s, not the last payment`s', async () => {
    // Л2: `paidAmount / obligationAmount` would record 30/130 = 0.23 for a
    // USDT→USDT settle that converted nothing, and T1
    // (`amount = original_amount × exchange_rate`) would be false on the row.
    const { svc, settledTx } = toppedUpService()
    await svc.settleByCompany(OBLIGATION_ID, accountantUser)
    const row = settledTx()
    expect(row['originalAmount']).toBe('130')
    expect(row['originalCurrency']).toBe('USDT')
    expect(row['exchangeRate']).toBe('1.00000000')
    // T1, asserted as the identity itself rather than as three separate values.
    expect(Number(row['amount'])).toBeCloseTo(
      Number(row['originalAmount']) * Number(row['exchangeRate']),
      6,
    )
  })

  it('AC5 / Л3: the stamp is MOVED, not left over from the first payment', async () => {
    // The obligation was 100 when it was first closed and is 130 now. Asserting
    // "not the old value" as well as "the new one" is what tells a re-stamp
    // apart from an implementation that never touched the columns.
    const { svc, settledTx } = toppedUpService()
    await svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(settledTx()['originalAmount']).not.toBe('100')
    expect(settledTx()['originalAmount']).toBe('130')
  })

  it('AC5: on a FIRST settle the formula is the pre-existing one, byte for byte', async () => {
    // `cumulativePaid === paidAmount` when the accumulator is empty — the whole
    // reason AC3/AC5 could be changed without a branch.
    const { svc, settledTx } = makeService()
    await svc.settleByCompany(OBLIGATION_ID, accountantUser)
    const row = settledTx()
    expect(row['amount']).toBe('1000.000000')
    expect(row['originalAmount']).toBe('1000')
    expect(row['exchangeRate']).toBe('1.00000000')
  })

  it('AC5: a zero obligation still records NO rate rather than a made-up one', async () => {
    // 0/0 is not 1. `isStorableExchangeRate` refuses it and the column stays
    // NULL — the third of the three sets this arithmetic has to get right.
    const { svc, settledTx } = makeService({
      obligation: makeObligation({ amount: '0' }),
      sourceTx: makeSourceTx({ amount: '0', dropSharePercent: 0 }),
    })
    await svc.settleByCompany(OBLIGATION_ID, accountantUser)
    const row = settledTx()
    expect(row['originalAmount']).toBe('0')
    expect(row['originalCurrency']).toBe('USDT')
    expect(row['exchangeRate']).toBeNull()
  })

  it('AC6: closing on a ZERO remainder is allowed — it is an idempotent close, not dust', async () => {
    // Reachable by "edit the income up, then back down": the cascade writes
    // `max(newAmount, settledAmount)` into both copies, so the next settle finds
    // the obligation exactly as large as what is already paid. Refusing here
    // (the dust check, if it still compared against the obligation's full
    // figure) leaves a reopened obligation with nothing that can close it —
    // the dead end AC15 exists to prevent.
    const { svc, settledTx, obligationStatus } = makeService({
      obligation: makeObligation({ amount: '100' }),
      sourceTx: makeSourceTx({
        amount: '100.000000',
        settledAmount: '100.000000',
        settledCurrency: 'USDT',
        fundingSource: 'COMPANY_ACCOUNT',
        senderId: null,
        senderLabel: 'COMPANY',
      }),
    })
    await svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(obligationStatus()).toBe('PAID')
    const row = settledTx()
    expect(row['amount']).toBe('100.000000')
    expect(row['settledAmount']).toBe('100.000000')
    expect(row['exchangeRate']).toBe('1.00000000')
  })

  it('AC6: genuine dust is still refused — a real remainder must not record as 0.00', async () => {
    // The mirror. A fractional remainder converted into a currency that
    // collapses it below one hundredth is NOT a close; recording 0.00 would
    // misrepresent a debt that demonstrably still exists.
    const { svc } = makeService({
      obligation: makeObligation({ amount: '0.0001' }),
      sourceTx: makeSourceTx({ amount: '0.0001' }),
      rates: { ...DEFAULT_RATES, usdUah: '0.0001', usdtUah: '0.0001' },
    })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'UAH',
        ...RECEIPT_FILE,
      }),
    ).rejects.toThrow(/сумма выплаты получилась нулевой/)
  })

  it('AC7: the money gate demands the REMAINDER, not the obligation`s full figure', async () => {
    // 30 is owed and the account holds exactly 30. Gating on the full 130 would
    // refuse a top-up the company can demonstrably afford.
    const { svc, obligationStatus } = toppedUpService({ companyBalance: '30' })
    await svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(obligationStatus()).toBe('PAID')
  })

  it('AC7: and it is still a real gate — one cent short and the settle refuses', async () => {
    const { svc } = toppedUpService({ companyBalance: '29.99' })
    await expect(svc.settleByCompany(OBLIGATION_ID, accountantUser)).rejects.toThrow(
      /Недостаточно средств/,
    )
  })

  it('AC8: a top-up in a currency other than the obligation`s is refused, in the place the rate is stamped', async () => {
    // The recorded rate would otherwise become an AVERAGE of two payments, and
    // no payment was ever made at that rate. The refusal sits inside the block
    // that computes the triplet — not three files away — so removing any of the
    // five refusals it leans on makes the system say so out loud instead of
    // writing a number nobody can trace to a transfer.
    const { svc, state } = makeService({
      obligation: makeObligation({ amount: '130' }),
      sourceTx: makeSourceTx({
        amount: '100.000000',
        settledAmount: '100.000000',
        settledCurrency: 'USDT',
        // ADMIN_PERSONAL on both sides, same payer — so the funding-source and
        // payer guards (#607) have nothing to say, and the refusal under test
        // is unambiguously this one.
        fundingSource: null,
        senderId: ADMIN_PAYER_ID,
        senderLabel: 'Admin Payer',
      }),
    })
    await expect(
      svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'UAH',
        ...RECEIPT_FILE,
      }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(state.flips).toHaveLength(0)
  })

  it('AC8: the refusal names the invariant and the currency, and does not read as a fault', async () => {
    const { svc } = makeService({
      obligation: makeObligation({ amount: '130' }),
      sourceTx: makeSourceTx({
        amount: '100.000000',
        settledAmount: '100.000000',
        settledCurrency: 'USDT',
        fundingSource: null,
        senderId: ADMIN_PAYER_ID,
        senderLabel: 'Admin Payer',
      }),
    })
    let caught: unknown
    try {
      await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_PAYER_ID,
        currency: 'UAH',
        ...RECEIPT_FILE,
      })
    } catch (e) {
      caught = e
    }
    const message = (caught as Error).message
    // What is already paid, and in which unit — the operator's starting point.
    expect(message).toContain('уже выплачено 100 USDT')
    // The currency the top-up CAN go in, named rather than implied.
    expect(message).toContain('возможна только в USDT')
    // WHY: what the recorded rate actually is…
    expect(message).toContain('записанный курс — это отношение всей выплаченной')
    // …and what it would become, which is the whole reason for the refusal.
    expect(message).toContain('средним')
    expect(message).toContain('не проходил ни один платёж')
    // And a way out that does not require guessing.
    expect(message).toContain('вручную')
    // A boundary of what the system can express, not a fault report.
    expect(message).not.toMatch(/ошибк/i)
    expect(message).not.toMatch(/поврежд/i)
  })

  it('AC8: and it does NOT fire on a first settle — the existing cross-currency drop payout still works', async () => {
    // The mirror that keeps the refusal from being "no drop settle in another
    // currency, ever": with an empty accumulator there is no earlier rate for a
    // second one to average with, and `task-drop-payout-currency` keeps working
    // exactly as it did.
    const { svc, settledTx } = makeService()
    await svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_PAYER_ID,
      currency: 'UAH',
      ...RECEIPT_FILE,
    })
    const row = settledTx()
    expect(row['currency']).toBe('UAH')
    expect(row['originalCurrency']).toBe('USDT')
    expect(parseFloat(row['exchangeRate'] as string)).toBeCloseTo(41.5, 6)
  })

  it('AC12: a second top-up on an already-closed row hits the existing idempotency refusal', async () => {
    const { svc } = toppedUpService()
    await svc.settleByCompany(OBLIGATION_ID, accountantUser)
    await expect(svc.settleByCompany(OBLIGATION_ID, accountantUser)).rejects.toThrow(
      /закрыт или отменён/,
    )
  })

  /**
   * Property test — the currency axis (backlog 86/87).
   *
   * The defect class it is aimed at: a currency label sitting NEXT TO a figure
   * without entering the arithmetic. A generator that derived the payment's
   * currency from the obligation's would never produce the disputed pair, and
   * the invariant would be asserted only where it could not break — which is
   * how four HIGH findings got written in one day.
   *
   * So both currencies vary INDEPENDENTLY, and the accumulator varies
   * independently of both. The claim: for every combination, the settle either
   * REFUSES, or leaves a row on which T1 holds and the units agree. Never a
   * number produced from two different units.
   */
  it('property: across obligation × payment currencies, the settle either refuses or T1 holds', async () => {
    const CURRENCIES = ['USDT', 'UAH', 'EUR', 'USD'] as const
    interface Case {
      label: string
      obligationCurrency: string
      refused: boolean
      flips: number
      stampedCurrency: unknown
      /** `amount === original_amount × exchange_rate`, to the cent. Vacuously true when refused. */
      identityHolds: boolean
      crossCurrencyTopUp: boolean
    }
    const cases: Case[] = []

    for (const obligationCurrency of CURRENCIES) {
      for (const targetCurrency of CURRENCIES) {
        for (const prior of [null, '100.000000'] as const) {
          const obligationAmount = prior === null ? '1000' : '1300'
          const { svc, settledTx, state } = makeService({
            obligation: makeObligation({ amount: obligationAmount, currency: obligationCurrency }),
            sourceTx: makeSourceTx({
              amount: prior ?? '1000',
              settledAmount: prior,
              settledCurrency: prior === null ? null : 'USDT',
              // ADMIN_PERSONAL on both sides, one payer — so the funding-source
              // and payer guards have nothing to say and the currency axis is
              // the only thing varying.
              fundingSource: null,
              senderId: ADMIN_PAYER_ID,
              senderLabel: 'Admin Payer',
            }),
          })
          let refused = false
          await svc
            .settleByCompany(OBLIGATION_ID, accountantUser, {
              fundingSource: 'ADMIN_PERSONAL',
              payerAdminId: ADMIN_PAYER_ID,
              currency: targetCurrency,
              ...RECEIPT_FILE,
            })
            .catch(() => {
              refused = true
            })
          const row = refused ? null : settledTx()
          cases.push({
            label: `${obligationCurrency}→${targetCurrency}, prior=${prior ?? 'none'}`,
            obligationCurrency,
            refused,
            flips: state.flips.length,
            stampedCurrency: row?.['originalCurrency'] ?? null,
            identityHolds:
              row === null ||
              Math.abs(
                Number(row['amount']) - Number(row['originalAmount']) * Number(row['exchangeRate']),
              ) < 0.01,
            crossCurrencyTopUp: prior !== null && targetCurrency !== obligationCurrency,
          })
        }
      }
    }

    for (const c of cases) {
      // A refusal writes NOTHING — half a settle is worse than none.
      expect(c.flips, c.label).toBe(c.refused ? 0 : 1)
      // The snapshot's unit is the OBLIGATION's, never the payment's.
      expect(c.stampedCurrency, c.label).toBe(c.refused ? null : c.obligationCurrency)
      // T1 holds on every row that was actually written.
      expect(c.identityHolds, c.label).toBe(true)
      // The claim this property exists for: a top-up in a currency other than
      // the obligation's never produces a number — it refuses.
      expect(c.refused || !c.crossCurrencyTopUp, c.label).toBe(true)
    }

    // The generator actually produced the disputed combination, and both
    // outcomes — otherwise the assertions above would be holding in a
    // population where they cannot fail.
    expect(cases.filter((c) => c.crossCurrencyTopUp).length).toBeGreaterThan(0)
    expect(cases.filter((c) => c.refused).length).toBeGreaterThan(0)
    expect(cases.filter((c) => !c.refused).length).toBeGreaterThan(0)
  })
})
