/**
 * Characterization of the L2 cluster of `PendingSettlementService.settleByCompany`
 * — the pure arithmetic and resolution logic that decides HOW MUCH is paid, FROM
 * WHICH pot, BY WHOM and in WHICH currency — pinned with EXACT assertions before
 * it is extracted into pure functions.
 *
 * Why a separate spec: `pending-settlement.spec.ts` and
 * `pending-settlement.drop-currency.spec.ts` pin the feature behaviour by task
 * (AC-numbered). They leave arithmetic mutants alive (rounding precision of the
 * remainder, the funding-source `> 0` boundary, the `useCompanyAccount` /
 * `debitsCompanyAccount` split, the cascade-origin guard keyed on the company
 * debit rather than the funding choice, ...). This file is organised by the
 * DECISION being pinned, each case stating both sides of its boundary:
 *
 *   1. remainingOwed          — 6dp rounding, float tail, overpaid boundary
 *   2. money gate             — `amount > balance`, lock only on company debit
 *   3. drop conversion        — peg-pair fast path vs NBU path, 2dp rounding,
 *                               dust boundary, cumulativePaid, exchangeRate
 *   4. top-up currency guard  — strict string compare (USD != USDT here)
 *   5. funding-source guard   — `(funding_source, sender_id)` pair, `> 0` boundary
 *   6. HIGH-1 cascade guard   — keyed on the COMPANY DEBIT, `!== false` fail-safe
 *   7. sender / currency / useCompanyAccount / debitsCompanyAccount resolution
 *   8. TOCTOU claim compare   — 6dp equality
 *
 * Test-only: no product file is touched. The db double mirrors the drizzle
 * chains `settleByCompany` drives, in order (mocked-db-shape coupling): a
 * change to the chain order in the service legitimately requires touching the
 * harness below. `insert is not a function` audit-log noise is expected.
 */
import { describe, expect, it, vi } from 'vitest'
import { Logger } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { transactions } from '../database/schema'
import { PendingSettlementService } from './pending-settlement.service'
import type { InvoicesService } from '../invoices/invoices.service'
import type { NbuCurrencyService } from './nbu-currency.service'

const DROP_ID = '33333333-3333-4333-8333-333333333333'
const SENIOR_ID = '44444444-4444-4444-8444-444444444444'
const OBLIGATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SOURCE_TX_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const ADMIN_A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ADMIN_B_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

const accountantUser: SessionUser = {
  id: 'acc-1',
  role: 'ACCOUNTANT',
  displayName: 'Accountant',
  email: 'a@x.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 0,
}
const adminAUser: SessionUser = { ...accountantUser, id: ADMIN_A_ID, role: 'ADMIN' }

const RATES = { usdUah: '41.50', usdtUah: '41.50', eurUah: '44.80', date: '20260812' }
const EXPLORER = { receiptExternalUrl: 'https://etherscan.io/tx/0xl2' }
const FILE = { receiptExternalUrl: 'https://drive.google.com/file/l2' }

type Rates = typeof RATES & { stale?: boolean; rateDate?: string }

function makeObligation(overrides: Record<string, unknown> = {}) {
  return {
    id: OBLIGATION_ID,
    creditorUserId: SENIOR_ID,
    debtorType: 'COMPANY' as 'COMPANY' | 'DROP',
    debtorUserId: null as string | null,
    sourceTransactionId: SOURCE_TX_ID,
    closingTransactionId: null as string | null,
    amount: '1000',
    currency: 'USDT' as string,
    status: 'PENDING' as const,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  }
}

function makeSource(overrides: Record<string, unknown> = {}) {
  return {
    id: SOURCE_TX_ID,
    type: 'SENIOR_PENDING_PAYOUT' as string,
    projectId: null,
    amount: '1000',
    currency: 'USDT',
    senderId: null as string | null,
    receiverId: SENIOR_ID,
    recipientId: SENIOR_ID,
    senderLabel: 'COMPANY' as string | null,
    receiverLabel: null,
    status: 'PENDING_PAYMENT' as const,
    payoutRequestId: null,
    dropCascadeOrigin: false as boolean | null,
    seniorSharePercent: 26,
    seniorSharePercentSource: 'PROJECT',
    dropSharePercent: null,
    dropSharePercentSource: null,
    settledAmount: null as string | null,
    settledCurrency: null as string | null,
    settledSharePercent: null as number | null,
    fundingSource: null as string | null,
    txHash: null,
    validatedBy: null,
    validatedAt: null,
    rejectionReason: null,
    notes: 'IOU',
    salaryMonth: null,
    txDate: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    invoiceDocumentId: null,
    createdBy: 'system',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    ...overrides,
  }
}

/** A DROP_PENDING_PAYOUT source row + its USDT obligation. */
function dropWorld(
  obligation: Record<string, unknown> = {},
  source: Record<string, unknown> = {},
): Pick<World, 'obligation' | 'sourceTx'> {
  return {
    obligation: makeObligation({ creditorUserId: DROP_ID, ...obligation }),
    sourceTx: makeSource({
      type: 'DROP_PENDING_PAYOUT',
      receiverId: DROP_ID,
      recipientId: DROP_ID,
      seniorSharePercent: null,
      dropSharePercent: 26,
      dropSharePercentSource: 'PROJECT',
      ...source,
    }),
  }
}

interface World {
  obligation: ReturnType<typeof makeObligation>
  sourceTx: ReturnType<typeof makeSource>
  rates: Rates
  /** What `loadObligation` returns as amount, when it must differ from the committed one. */
  staleLoadAmount?: string
  companyBalance: string
}

function makeService(initial: Partial<World> = {}) {
  const world: World = {
    obligation: makeObligation(),
    sourceTx: makeSource(),
    rates: RATES,
    companyBalance: '1000000',
    ...initial,
  }
  const flips: Array<{ set: Record<string, unknown>; raw: Record<string, unknown> }> = []
  const lock = vi.fn(async () => undefined)
  let obligationStatus: 'PENDING' | 'PAID' = 'PENDING'
  let ledgerSelects = 0

  // `coalesce(settled_amount, 0) + delta` as the DB would evaluate it, rendered
  // the way a `numeric(18, 6)` column hands it back.
  const resolveAccumulator = (value: unknown, prior: unknown): unknown => {
    const chunks = (value as { queryChunks?: unknown[] } | null)?.queryChunks
    if (Array.isArray(chunks)) {
      const delta = chunks.find((c) => typeof c === 'number') as number | undefined
      const base = typeof prior === 'string' ? parseFloat(prior) : 0
      return (base + (delta ?? 0)).toFixed(6)
    }
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value).toFixed(6)
    }
    return value
  }

  const collectStrings = (obj: unknown, acc: string[] = [], depth = 0): string[] => {
    if (acc.length > 120 || depth > 12 || obj === null || obj === undefined) return acc
    if (typeof obj === 'string') {
      acc.push(obj)
      return acc
    }
    if (typeof obj !== 'object') return acc
    if (Array.isArray(obj)) {
      for (const item of obj) collectStrings(item, acc, depth + 1)
      return acc
    }
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (key === 'table' || key === 'schema' || key === 'enumValues' || key === 'usedTables')
        continue
      collectStrings(val, acc, depth + 1)
    }
    return acc
  }

  const mkDbtx = () => ({
    execute: lock,
    select: () => ({
      from: () => ({
        where: async () => [{ total: ledgerSelects++ === 0 ? world.companyBalance : '0' }],
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: (predicate: unknown) => {
          const values = collectStrings(predicate)
          let rows: Array<Record<string, unknown>> = []
          if (table === transactions) {
            if (
              !values.includes('PENDING_PAYMENT') ||
              world.sourceTx.status === 'PENDING_PAYMENT'
            ) {
              const prior = (world.sourceTx as Record<string, unknown>)['settledAmount']
              const resolved = { ...patch }
              for (const column of ['settledAmount', 'amount'] as const) {
                if (column in patch) resolved[column] = resolveAccumulator(patch[column], prior)
              }
              const flipped = { ...world.sourceTx, ...resolved }
              world.sourceTx = flipped as typeof world.sourceTx
              flips.push({ set: resolved, raw: patch })
              rows = [flipped]
            }
          } else if (!values.includes('PENDING') || obligationStatus === 'PENDING') {
            if ('status' in patch) obligationStatus = patch['status'] as 'PAID'
            rows = [{ id: OBLIGATION_ID, amount: world.obligation.amount }]
          }
          const result = Promise.resolve(rows) as Promise<typeof rows> & {
            returning: () => Promise<typeof rows>
          }
          result.returning = async () => rows
          return result
        },
      }),
    }),
  })

  const admins = [
    { id: ADMIN_A_ID, displayName: 'Admin A', role: 'ADMIN' },
    { id: ADMIN_B_ID, displayName: 'Admin B', role: 'ADMIN' },
    { id: 'acc-1', displayName: 'Accountant', role: 'ACCOUNTANT' },
  ]
  const drizzle = {
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(mkDbtx()),
    query: {
      pendingObligations: {
        findFirst: vi.fn(async () => ({
          ...world.obligation,
          status: obligationStatus,
          ...(world.staleLoadAmount !== undefined ? { amount: world.staleLoadAmount } : {}),
        })),
      },
      transactions: { findFirst: vi.fn(async () => world.sourceTx) },
      projects: { findFirst: vi.fn(async () => null) },
      users: {
        findFirst: vi.fn(async (args: unknown) => {
          const values = collectStrings(args)
          return admins.find((a) => values.includes(a.id))
        }),
      },
    },
  }
  const getRates = vi.fn(async () => world.rates)
  const svc = new PendingSettlementService(
    { db: drizzle } as never,
    { autoCreateForSeniorPayout: vi.fn(async () => undefined) } as unknown as InvoicesService,
    { getRates } as unknown as NbuCurrencyService,
  )
  return {
    svc,
    world,
    flips,
    lock,
    getRates,
    row: () => world.sourceTx as unknown as Record<string, unknown>,
    status: () => obligationStatus,
  }
}

/** The numeric delta bound into the `coalesce(settled_amount, 0) + ?` fragment. */
function delta(fragment: unknown): number | undefined {
  const chunks = (fragment as { queryChunks?: unknown[] }).queryChunks
  return Array.isArray(chunks) ? (chunks.find((c) => typeof c === 'number') as number) : undefined
}

/** A SENIOR obligation that has already been paid `prior` of `amount` from `(fundingSource, senderId)`. */
function reopenedSenior(
  amount: string,
  prior: string,
  payer: { fundingSource: string | null; senderId: string | null } = {
    fundingSource: 'COMPANY_ACCOUNT',
    senderId: null,
  },
) {
  return {
    obligation: makeObligation({ amount }),
    sourceTx: makeSource({
      amount,
      settledAmount: prior,
      settledCurrency: 'USDT',
      settledSharePercent: 26,
      fundingSource: payer.fundingSource,
      senderId: payer.senderId,
      senderLabel: payer.senderId ? 'Prior Payer' : 'COMPANY',
    }),
  }
}

const personal = (payer: string, extra: Record<string, unknown> = {}) => ({
  fundingSource: 'ADMIN_PERSONAL' as const,
  payerAdminId: payer,
  currency: 'USDT' as const,
  ...EXPLORER,
  ...extra,
})

// ---------------------------------------------------------------------------
// 1. remainingOwed(obligationAmount, priorSettledAmount)
// ---------------------------------------------------------------------------
describe('L2 remainingOwed — the amount STILL owed (pre-transaction and money gate)', () => {
  it('first settle: the accumulator is NULL, the whole obligation is owed', async () => {
    const t = makeService({ ...reopenedSenior('680', '0'), companyBalance: '680' })
    t.world.sourceTx.settledAmount = null
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(delta(t.flips[0]!.raw['settledAmount'])).toBe(680)
    expect(t.row()['settledAmount']).toBe('680.000000')
  })

  it('top-up: owed = obligation - prior, exactly (680 - 560 = 120)', async () => {
    const t = makeService(reopenedSenior('680', '560.000000'))
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(delta(t.flips[0]!.raw['settledAmount'])).toBe(120)
    expect(t.row()['settledAmount']).toBe('680.000000')
  })

  it('a prior of exactly zero behaves as a first settle', async () => {
    const t = makeService(reopenedSenior('680', '0.000000'))
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(delta(t.flips[0]!.raw['settledAmount'])).toBe(680)
  })

  it('subtracts, never adds: prior 560 of 680 does not owe 1240', async () => {
    const t = makeService(reopenedSenior('680', '560.000000'))
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(delta(t.flips[0]!.raw['settledAmount'])).not.toBe(1240)
  })

  it('strips the binary float tail: 0.3 - 0.1 is exactly 0.2, not 0.19999999999999998', async () => {
    const t = makeService(reopenedSenior('0.3', '0.100000'))
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(delta(t.flips[0]!.raw['settledAmount'])).toBe(0.2)
  })

  it('rounds the remainder to SIX decimals (not 5, not 7)', async () => {
    // 10.1234567 -> 10.123457 at 6dp; 10.12346 at 5dp; 10.1234567 at 7dp.
    const t = makeService({ obligation: makeObligation({ amount: '10.1234567' }) })
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(delta(t.flips[0]!.raw['settledAmount'])).toBe(10.123457)
  })

  it('a prior equal to the obligation is an idempotent close with a delta of exactly 0', async () => {
    const t = makeService(reopenedSenior('100', '100.000000'))
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(t.status()).toBe('PAID')
    expect(delta(t.flips[0]!.raw['settledAmount'])).toBe(0)
    expect(t.row()['settledAmount']).toBe('100.000000')
  })

  it('a prior ONE micro-unit above the obligation is OVERPAID: refused, nothing written', async () => {
    const t = makeService(reopenedSenior('100', '100.000001'))
    await expect(t.svc.settleByCompany(OBLIGATION_ID, accountantUser)).rejects.toMatchObject({
      response: { code: 'FINANCE_OBLIGATION_OVERPAID', statusCode: 400 },
    })
    expect(t.flips).toHaveLength(0)
    expect(t.status()).toBe('PENDING')
  })
})

// ---------------------------------------------------------------------------
// 2. The company-account money gate
// ---------------------------------------------------------------------------
describe('L2 money gate — `remainder > balance` refuses, only a company debit takes the lock', () => {
  it('balance exactly equal to the remainder passes (the comparison is strict >)', async () => {
    const t = makeService({ ...reopenedSenior('680', '560.000000'), companyBalance: '120' })
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(t.status()).toBe('PAID')
  })

  it('one micro-unit short of the remainder refuses; the source IOU is never flipped', async () => {
    // (The double does not roll the claim back the way Postgres does, so the
    // obligation status is deliberately not asserted for an in-transaction refusal.)
    const t = makeService({ ...reopenedSenior('680', '560.000000'), companyBalance: '119.999999' })
    await expect(t.svc.settleByCompany(OBLIGATION_ID, accountantUser)).rejects.toMatchObject({
      response: { code: 'FINANCE_COMPANY_ACCOUNT_INSUFFICIENT_FUNDS', statusCode: 400 },
    })
    expect(t.flips).toHaveLength(0)
    expect(t.lock).toHaveBeenCalledTimes(1)
  })

  it('the gate measures the REMAINDER: a balance below the obligation but above the remainder passes', async () => {
    const t = makeService({ ...reopenedSenior('680', '560.000000'), companyBalance: '200' })
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(t.status()).toBe('PAID')
  })

  it('a company-funded settle takes the advisory lock exactly once', async () => {
    const t = makeService()
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(t.lock).toHaveBeenCalledTimes(1)
  })

  it('an ADMIN_PERSONAL settle takes no lock and is not gated by an empty company account', async () => {
    const t = makeService({ companyBalance: '0' })
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser, personal(ADMIN_A_ID))
    expect(t.lock).not.toHaveBeenCalled()
    expect(t.status()).toBe('PAID')
  })
})

// ---------------------------------------------------------------------------
// 3. DROP conversion: peg pair vs NBU, 2dp rounding, dust, cumulativePaid, rate
// ---------------------------------------------------------------------------
describe('L2 drop conversion — peg-pair fast path', () => {
  it('USDT -> USDT: no NBU call, amount is the UNROUNDED remainder, rate exactly 1', async () => {
    const t = makeService(dropWorld({ amount: '100.123456' }))
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser, personal(ADMIN_A_ID))
    expect(t.getRates).not.toHaveBeenCalled()
    const r = t.row()
    expect(r['amount']).toBe('100.123456')
    expect(r['currency']).toBe('USDT')
    expect(r['originalAmount']).toBe('100.123456')
    expect(r['originalCurrency']).toBe('USDT')
    expect(r['exchangeRate']).toBe('1.00000000')
  })

  it('USDT -> USD is also a peg pair: no NBU call (even in an outage), amount unrounded, rate 1', async () => {
    const t = makeService({
      ...dropWorld({ amount: '100.123456' }),
      rates: { ...RATES, stale: true },
    })
    await t.svc.settleByCompany(
      OBLIGATION_ID,
      accountantUser,
      personal(ADMIN_A_ID, { currency: 'USD', ...FILE }),
    )
    expect(t.getRates).not.toHaveBeenCalled()
    const r = t.row()
    expect(r['amount']).toBe('100.123456')
    expect(r['currency']).toBe('USD')
    expect(r['originalCurrency']).toBe('USDT')
    expect(r['exchangeRate']).toBe('1.00000000')
  })

  it('USDT -> UAH / EUR are NOT peg pairs: the NBU round-trip happens exactly once', async () => {
    for (const currency of ['UAH', 'EUR'] as const) {
      const t = makeService(dropWorld())
      await t.svc.settleByCompany(
        OBLIGATION_ID,
        accountantUser,
        personal(ADMIN_A_ID, { currency, ...FILE }),
      )
      expect(t.getRates).toHaveBeenCalledTimes(1)
    }
  })
})

describe('L2 drop conversion — NBU path: exact rounded amounts and exchangeRate derivation', () => {
  it('UAH: 1000 USDT x 41.50 = 41500.00, rate 41.50000000', async () => {
    const t = makeService(dropWorld())
    await t.svc.settleByCompany(
      OBLIGATION_ID,
      accountantUser,
      personal(ADMIN_A_ID, { currency: 'UAH', ...FILE }),
    )
    const r = t.row()
    expect(r['amount']).toBe('41500.000000')
    expect(r['currency']).toBe('UAH')
    expect(r['originalAmount']).toBe('1000')
    expect(r['originalCurrency']).toBe('USDT')
    expect(r['exchangeRate']).toBe('41.50000000')
    expect(r['settledAmount']).toBe('41500.000000')
    expect(r['settledCurrency']).toBe('UAH')
  })

  it('rounds half-up to 2dp, not floor and not ceil: 926.3392857... -> 926.34 (floor would give 926.33)', async () => {
    const t = makeService(dropWorld())
    await t.svc.settleByCompany(
      OBLIGATION_ID,
      accountantUser,
      personal(ADMIN_A_ID, { currency: 'EUR', ...FILE }),
    )
    expect(t.row()['amount']).toBe('926.340000')
    expect(t.row()['exchangeRate']).toBe('0.92634000')
  })

  it('rounds DOWN when the third decimal is below 5, not ceil: 41.514 -> 41.51 (ceil would give 41.52)', async () => {
    const t = makeService({
      ...dropWorld({ amount: '1' }),
      rates: { ...RATES, usdUah: '41.514', usdtUah: '41.514' },
    })
    await t.svc.settleByCompany(
      OBLIGATION_ID,
      accountantUser,
      personal(ADMIN_A_ID, { currency: 'UAH', ...FILE }),
    )
    expect(t.row()['amount']).toBe('41.510000')
    expect(t.row()['exchangeRate']).toBe('41.51000000')
  })

  it('rounds to exactly TWO decimals (not 1, not 3): 41.516 -> 41.52', async () => {
    const t = makeService({
      ...dropWorld({ amount: '1' }),
      rates: { ...RATES, usdUah: '41.516', usdtUah: '41.516' },
    })
    await t.svc.settleByCompany(
      OBLIGATION_ID,
      accountantUser,
      personal(ADMIN_A_ID, { currency: 'UAH', ...FILE }),
    )
    expect(t.row()['amount']).toBe('41.520000')
  })

  it('exchangeRate is the ROUNDED paid figure over the obligation, to 8 decimals: 2.78 / 3 = 0.92666667', async () => {
    // 3 USDT -> EUR = 2.7790178... -> paid 2.78 -> 2.78 / 3 = 0.926666666...
    const t = makeService(dropWorld({ amount: '3' }))
    await t.svc.settleByCompany(
      OBLIGATION_ID,
      accountantUser,
      personal(ADMIN_A_ID, { currency: 'EUR', ...FILE }),
    )
    expect(t.row()['amount']).toBe('2.780000')
    expect(t.row()['exchangeRate']).toBe('0.92666667')
  })

  it('the converted figure feeds the accumulator and the response, not the USDT obligation', async () => {
    const t = makeService(dropWorld())
    const res = await t.svc.settleByCompany(
      OBLIGATION_ID,
      accountantUser,
      personal(ADMIN_A_ID, { currency: 'UAH', ...FILE }),
    )
    expect(delta(t.flips[0]!.raw['settledAmount'])).toBe(41500)
    expect(res.created[0]!.currency).toBe('UAH')
  })
})

describe('L2 drop conversion — dust boundary (rounded paid amount of 0 on a non-zero remainder)', () => {
  it('0.004 UAH rounds to 0.00 on a real obligation: refused with the dust code, nothing written', async () => {
    const t = makeService({
      ...dropWorld({ amount: '1' }),
      rates: { ...RATES, usdUah: '0.004', usdtUah: '0.004' },
    })
    await expect(
      t.svc.settleByCompany(
        OBLIGATION_ID,
        accountantUser,
        personal(ADMIN_A_ID, { currency: 'UAH', ...FILE }),
      ),
    ).rejects.toMatchObject({
      response: { code: 'FINANCE_ROUNDED_PAYOUT_AMOUNT_ZERO', statusCode: 400 },
    })
    expect(t.flips).toHaveLength(0)
    expect(t.status()).toBe('PENDING')
  })

  it('0.005 UAH rounds UP to 0.01: one step above the dust line, accepted and recorded as 0.01', async () => {
    const t = makeService({
      ...dropWorld({ amount: '1' }),
      rates: { ...RATES, usdUah: '0.005', usdtUah: '0.005' },
    })
    await t.svc.settleByCompany(
      OBLIGATION_ID,
      accountantUser,
      personal(ADMIN_A_ID, { currency: 'UAH', ...FILE }),
    )
    expect(t.row()['amount']).toBe('0.010000')
    expect(t.row()['exchangeRate']).toBe('0.01000000')
  })

  it('a genuine zero obligation (0% share) converts to 0.00 and CLOSES — zero is not dust there', async () => {
    const t = makeService(dropWorld({ amount: '0' }))
    await t.svc.settleByCompany(
      OBLIGATION_ID,
      accountantUser,
      personal(ADMIN_A_ID, { currency: 'UAH', ...FILE }),
    )
    expect(t.status()).toBe('PAID')
    expect(t.row()['amount']).toBe('0.000000')
    expect(t.row()['exchangeRate']).toBeNull()
  })

  it('a zero REMAINDER on a non-zero obligation (prior == obligation) closes on the peg path', async () => {
    const t = makeService(
      dropWorld(
        { amount: '100' },
        { settledAmount: '100.000000', settledCurrency: 'USDT', fundingSource: 'COMPANY_ACCOUNT' },
      ),
    )
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(t.status()).toBe('PAID')
    expect(delta(t.flips[0]!.raw['settledAmount'])).toBe(0)
    expect(t.row()['exchangeRate']).toBe('1.00000000')
  })
})

describe('L2 drop conversion — cumulativePaid and the closure rate on a top-up', () => {
  const company = { fundingSource: 'COMPANY_ACCOUNT', senderId: null }

  it('cumulativePaid = prior + this payment: rate is 130/130 = 1, not 30/130', async () => {
    const t = makeService(
      dropWorld(
        { amount: '130' },
        { settledAmount: '100.000000', settledCurrency: 'USDT', ...company },
      ),
    )
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(delta(t.flips[0]!.raw['settledAmount'])).toBe(30)
    expect(t.row()['amount']).toBe('130.000000')
    expect(t.row()['exchangeRate']).toBe('1.00000000')
    expect(t.row()['originalAmount']).toBe('130')
  })

  it('cumulativePaid keeps SIX decimals: 100.1 + 30.200001 = 130.300001, rate stays 1.00000000 (5dp would give 0.99999999)', async () => {
    const t = makeService(
      dropWorld(
        { amount: '130.300001' },
        { settledAmount: '100.100000', settledCurrency: 'USDT', ...company },
      ),
    )
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(delta(t.flips[0]!.raw['settledAmount'])).toBe(30.200001)
    expect(t.row()['amount']).toBe('130.300001')
    expect(t.row()['exchangeRate']).toBe('1.00000000')
  })

  it('two partial payments of 0.1 + 0.2 record the accumulator as 0.3 and a rate of exactly 1', async () => {
    const t = makeService(
      dropWorld(
        { amount: '0.3' },
        { settledAmount: '0.100000', settledCurrency: 'USDT', ...company },
      ),
    )
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(delta(t.flips[0]!.raw['settledAmount'])).toBe(0.2)
    expect(t.row()['settledAmount']).toBe('0.300000')
    expect(t.row()['exchangeRate']).toBe('1.00000000')
  })

  it('a first settle in UAH stamps rate = paid / obligation; the rate is NOT carried into a later USDT top-up', async () => {
    // First: UAH payout of 1000 USDT.
    const first = makeService(dropWorld())
    await first.svc.settleByCompany(
      OBLIGATION_ID,
      accountantUser,
      personal(ADMIN_A_ID, { currency: 'UAH', ...FILE }),
    )
    expect(first.row()['exchangeRate']).toBe('41.50000000')
  })
})

// ---------------------------------------------------------------------------
// 4. Top-up currency guard
// ---------------------------------------------------------------------------
describe('L2 top-up currency guard — strict string compare against the obligation currency', () => {
  const adminPaid = { fundingSource: null, senderId: ADMIN_A_ID }

  it('a top-up in USD of a USDT obligation is REFUSED even though USD/USDT are pegged; params name the obligation currency', async () => {
    const t = makeService(
      dropWorld(
        { amount: '130' },
        { settledAmount: '100.000000', settledCurrency: 'USDT', ...adminPaid },
      ),
    )
    await expect(
      t.svc.settleByCompany(
        OBLIGATION_ID,
        accountantUser,
        personal(ADMIN_A_ID, { currency: 'USD', ...FILE }),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'FINANCE_SETTLEMENT_CURRENCY_MISMATCH_MANUAL_ONLY',
        statusCode: 400,
        params: { obligationCurrency: 'USDT' },
      },
    })
    expect(t.flips).toHaveLength(0)
  })

  it('a top-up in the SAME currency (USDT) passes the guard', async () => {
    const t = makeService(
      dropWorld(
        { amount: '130' },
        { settledAmount: '100.000000', settledCurrency: 'USDT', ...adminPaid },
      ),
    )
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser, personal(ADMIN_A_ID))
    expect(t.status()).toBe('PAID')
    expect(t.row()['settledAmount']).toBe('130.000000')
  })

  it('a FIRST settle in USD is not a top-up: no mismatch refusal, no NBU call, currency USD', async () => {
    const t = makeService(dropWorld())
    await t.svc.settleByCompany(
      OBLIGATION_ID,
      accountantUser,
      personal(ADMIN_A_ID, { currency: 'USD', ...FILE }),
    )
    expect(t.row()['currency']).toBe('USD')
    expect(t.getRates).not.toHaveBeenCalled()
  })

  it('a non-USDT drop obligation is refused as corrupted, params-free, before any conversion', async () => {
    const t = makeService(dropWorld({ currency: 'EUR' }))
    await expect(
      t.svc.settleByCompany(
        OBLIGATION_ID,
        accountantUser,
        personal(ADMIN_A_ID, { currency: 'EUR', ...FILE }),
      ),
    ).rejects.toMatchObject({
      response: { code: 'FINANCE_DROP_OBLIGATION_CORRUPTED_CURRENCY', statusCode: 400 },
    })
    expect(t.getRates).not.toHaveBeenCalled()
  })

  it('an accumulator held in another currency refuses the settle; params carry the prior currency', async () => {
    const t = makeService(reopenedSenior('680', '560.000000'))
    t.world.sourceTx.settledCurrency = 'UAH'
    await expect(t.svc.settleByCompany(OBLIGATION_ID, accountantUser)).rejects.toMatchObject({
      response: {
        code: 'FINANCE_SETTLEMENT_ALREADY_IN_OTHER_CURRENCY',
        statusCode: 400,
        params: { sourceSettledCurrency: 'UAH' },
      },
    })
    expect(t.flips).toHaveLength(0)
  })

  it('an accumulator in the SAME currency, and a NULL accumulator currency, both pass', async () => {
    const same = makeService(reopenedSenior('680', '560.000000'))
    await same.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(same.status()).toBe('PAID')

    const none = makeService(reopenedSenior('680', '560.000000'))
    none.world.sourceTx.settledCurrency = null
    await none.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(none.status()).toBe('PAID')
  })
})

// ---------------------------------------------------------------------------
// 5. Funding-source mismatch predicate: (funding_source, sender_id) pair
// ---------------------------------------------------------------------------
describe('L2 funding-source guard — a top-up must come from the SAME (pot, payer) pair', () => {
  type Pay = { fundingSource: string | null; senderId: string | null }
  const COMPANY: Pay = { fundingSource: 'COMPANY_ACCOUNT', senderId: null }
  const PERSONAL_A: Pay = { fundingSource: null, senderId: ADMIN_A_ID }

  /** `settleWith`: undefined -> legacy company default; else an ADMIN_PERSONAL payer. */
  const cases: Array<{
    name: string
    prior: Pay
    settleWith: string | undefined
    refused: boolean
  }> = [
    {
      name: 'company paid, company tops up',
      prior: COMPANY,
      settleWith: undefined,
      refused: false,
    },
    {
      name: 'company paid, admin A tops up (pot differs, payer differs)',
      prior: COMPANY,
      settleWith: ADMIN_A_ID,
      refused: true,
    },
    {
      name: 'admin A paid, company tops up (pot differs, payer differs)',
      prior: PERSONAL_A,
      settleWith: undefined,
      refused: true,
    },
    {
      name: 'admin A paid, admin A tops up',
      prior: PERSONAL_A,
      settleWith: ADMIN_A_ID,
      refused: false,
    },
    {
      name: 'admin A paid, admin B tops up (ONLY the payer differs)',
      prior: PERSONAL_A,
      settleWith: ADMIN_B_ID,
      refused: true,
    },
    {
      name: 'row carries no pot and no payer, company tops up (ONLY the pot differs)',
      prior: { fundingSource: null, senderId: null },
      settleWith: undefined,
      refused: true,
    },
    {
      name: 'company pot but a named payer on the row, company tops up (ONLY the payer differs)',
      prior: { fundingSource: 'COMPANY_ACCOUNT', senderId: ADMIN_A_ID },
      settleWith: undefined,
      refused: true,
    },
  ]

  const setup = (c: (typeof cases)[number]) => {
    const t = makeService(reopenedSenior('680', '560.000000', c.prior))
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const run = () =>
      t.svc.settleByCompany(
        OBLIGATION_ID,
        accountantUser,
        c.settleWith ? personal(c.settleWith) : undefined,
      )
    return { t, warn, run }
  }

  for (const c of cases.filter((x) => x.refused)) {
    it(`REFUSES: ${c.name}`, async () => {
      const { t, warn, run } = setup(c)
      await expect(run()).rejects.toMatchObject({
        response: { code: 'FINANCE_SETTLEMENT_FUNDING_SOURCE_MUST_MATCH', statusCode: 400 },
      })
      expect(t.flips).toHaveLength(0)
      expect(t.status()).toBe('PENDING')
      expect(warn).toHaveBeenCalledTimes(1)
      warn.mockRestore()
    })
  }

  for (const c of cases.filter((x) => !x.refused)) {
    it(`ALLOWS: ${c.name}`, async () => {
      const { t, warn, run } = setup(c)
      await run()
      expect(t.status()).toBe('PAID')
      expect(t.row()['settledAmount']).toBe('680.000000')
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
    })
  }

  it('the refusal carries NO params (the pot and the payer name are PII-adjacent: log-only)', async () => {
    const t = makeService(reopenedSenior('680', '560.000000', COMPANY))
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const err = await t.svc
      .settleByCompany(OBLIGATION_ID, accountantUser, personal(ADMIN_A_ID))
      .catch((e: unknown) => e)
    expect((err as { response: { params?: unknown } }).response.params).toBeUndefined()
    vi.restoreAllMocks()
  })

  it('the server log names the prior pot and the settle pot; the prior payer only when there was one', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const personalPrior = makeService(reopenedSenior('680', '560.000000', PERSONAL_A))
    await personalPrior.svc.settleByCompany(OBLIGATION_ID, accountantUser).catch(() => undefined)
    const personalLog = String(warn.mock.calls[0]![0])
    expect(personalLog).toContain('source=«особистий рахунок адміністратора»')
    expect(personalLog).toContain('Prior Payer')
    expect(personalLog).toContain('settle=«COMPANY_ACCOUNT»')

    warn.mockClear()
    const companyPrior = makeService(reopenedSenior('680', '560.000000', COMPANY))
    await companyPrior.svc
      .settleByCompany(OBLIGATION_ID, accountantUser, personal(ADMIN_A_ID))
      .catch(() => undefined)
    const companyLog = String(warn.mock.calls[0]![0])
    expect(companyLog).toContain('source=«COMPANY_ACCOUNT»')
    expect(companyLog).toContain('settle=«особистий рахунок адміністратора»')
    expect(companyLog).not.toContain('Prior Payer')
    vi.restoreAllMocks()
  })

  it('a FIRST settle (no accumulator) is never constrained, whatever the row says about pot or payer', async () => {
    const t = makeService({
      obligation: makeObligation({ amount: '680' }),
      sourceTx: makeSource({
        amount: '680',
        fundingSource: 'COMPANY_ACCOUNT',
        senderId: ADMIN_B_ID,
      }),
    })
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser, personal(ADMIN_A_ID))
    expect(t.status()).toBe('PAID')
  })

  it('an accumulator of exactly 0.000000 does not constrain either (the boundary is > 0)', async () => {
    const t = makeService(reopenedSenior('680', '0.000000', PERSONAL_A))
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(t.status()).toBe('PAID')
  })

  it('a SMALL accumulator (0.5) constrains: the boundary is "> 0", not "> 1"', async () => {
    const t = makeService(reopenedSenior('680', '0.500000', PERSONAL_A))
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    await expect(t.svc.settleByCompany(OBLIGATION_ID, accountantUser)).rejects.toMatchObject({
      response: { code: 'FINANCE_SETTLEMENT_FUNDING_SOURCE_MUST_MATCH' },
    })
    vi.restoreAllMocks()
  })

  it('applies to a DROP top-up too (the guard is not restricted to the senior branch)', async () => {
    const t = makeService(
      dropWorld(
        { amount: '130' },
        { settledAmount: '100.000000', settledCurrency: 'USDT', ...COMPANY },
      ),
    )
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    await expect(
      t.svc.settleByCompany(OBLIGATION_ID, accountantUser, personal(ADMIN_A_ID)),
    ).rejects.toMatchObject({
      response: { code: 'FINANCE_SETTLEMENT_FUNDING_SOURCE_MUST_MATCH' },
    })
    vi.restoreAllMocks()
  })
})

// ---------------------------------------------------------------------------
// 6. HIGH-1 cascade-origin guard (security-review PR #443)
// ---------------------------------------------------------------------------
describe('L2 HIGH-1 guard — a cascade-originated drop obligation never debits the company account', () => {
  const blocked = (
    t: ReturnType<typeof makeService>,
    funding?: Parameters<PendingSettlementService['settleByCompany']>[2],
  ) =>
    expect(t.svc.settleByCompany(OBLIGATION_ID, accountantUser, funding)).rejects.toMatchObject({
      response: { code: 'FINANCE_DROP_SHARE_NOT_VIA_COMPANY_ACCOUNT', statusCode: 400 },
    })
  const COMPANY_FUNDING = {
    fundingSource: 'COMPANY_ACCOUNT' as const,
    currency: 'USDT' as const,
    ...EXPLORER,
  }

  for (const origin of [true, null] as const) {
    it(`origin=${String(origin)} (cascade or UNKNOWN): the legacy no-funding default is refused, no lock, no write`, async () => {
      const t = makeService(dropWorld({}, { dropCascadeOrigin: origin }))
      await blocked(t)
      expect(t.lock).not.toHaveBeenCalled()
      expect(t.flips).toHaveLength(0)
      expect(t.status()).toBe('PENDING')
    })

    it(`origin=${String(origin)}: an explicit COMPANY_ACCOUNT funding is refused as well`, async () => {
      const t = makeService(dropWorld({}, { dropCascadeOrigin: origin }))
      await blocked(t, COMPANY_FUNDING)
      expect(t.flips).toHaveLength(0)
    })

    it(`origin=${String(origin)}: ADMIN_PERSONAL funding is NOT blocked — the personal pot pays`, async () => {
      const t = makeService(dropWorld({}, { dropCascadeOrigin: origin }))
      await t.svc.settleByCompany(OBLIGATION_ID, accountantUser, personal(ADMIN_A_ID))
      expect(t.status()).toBe('PAID')
      expect(t.row()['fundingSource']).toBeNull()
      expect(t.row()['senderId']).toBe(ADMIN_A_ID)
    })

    it(`origin=${String(origin)}: a LEGACY drop-debt (debtor DROP) is not a company debit, so it is not blocked`, async () => {
      const t = makeService(dropWorld({ debtorType: 'DROP' }, { dropCascadeOrigin: origin }))
      await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
      expect(t.status()).toBe('PAID')
      expect(t.lock).not.toHaveBeenCalled()
    })

    it(`origin=${String(origin)}: a legacy drop-debt with explicit COMPANY_ACCOUNT funding is not blocked (no company debit)`, async () => {
      const t = makeService(dropWorld({ debtorType: 'DROP' }, { dropCascadeOrigin: origin }))
      await t.svc.settleByCompany(OBLIGATION_ID, accountantUser, COMPANY_FUNDING)
      expect(t.status()).toBe('PAID')
      expect(t.lock).not.toHaveBeenCalled()
    })
  }

  it('origin=false (admin-declared): company funding is allowed and debits the company account', async () => {
    const t = makeService(dropWorld({}, { dropCascadeOrigin: false }))
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(t.status()).toBe('PAID')
    expect(t.row()['fundingSource']).toBe('COMPANY_ACCOUNT')
    expect(t.lock).toHaveBeenCalledTimes(1)

    const explicit = makeService(dropWorld({}, { dropCascadeOrigin: false }))
    await explicit.svc.settleByCompany(OBLIGATION_ID, accountantUser, COMPANY_FUNDING)
    expect(explicit.row()['fundingSource']).toBe('COMPANY_ACCOUNT')
  })

  it('the guard is a DROP guard: a SENIOR obligation is never blocked by dropCascadeOrigin', async () => {
    for (const origin of [true, null, false] as const) {
      const t = makeService({ sourceTx: makeSource({ dropCascadeOrigin: origin }) })
      await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
      expect(t.status()).toBe('PAID')
    }
  })
})

// ---------------------------------------------------------------------------
// 7. sender / currency / useCompanyAccount / debitsCompanyAccount resolution
// ---------------------------------------------------------------------------
describe('L2 resolution — useCompanyAccount, debitsCompanyAccount, sender, currency', () => {
  it('COMPANY debt, no funding: company pot, currency forced to USDT even if the obligation says USD, label COMPANY, lock taken', async () => {
    const t = makeService({ obligation: makeObligation({ currency: 'USD' }) })
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    const r = t.row()
    expect(r['currency']).toBe('USDT')
    expect(r['settledCurrency']).toBe('USDT')
    expect(r['fundingSource']).toBe('COMPANY_ACCOUNT')
    expect(r['senderId']).toBeNull()
    expect(r['senderLabel']).toBe('COMPANY')
    expect(t.lock).toHaveBeenCalledTimes(1)
  })

  it('COMPANY debt, COMPANY_ACCOUNT funding: same outputs; a smuggled currency is overwritten with USDT', async () => {
    const t = makeService()
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'COMPANY_ACCOUNT',
      currency: 'UAH' as never,
      ...EXPLORER,
    })
    const r = t.row()
    expect(r['currency']).toBe('USDT')
    expect(r['fundingSource']).toBe('COMPANY_ACCOUNT')
    expect(r['senderId']).toBeNull()
    expect(t.lock).toHaveBeenCalledTimes(1)
  })

  it('LEGACY drop-debt (debtor DROP), no funding: NO company marker, NO lock, currency NOT forced (stays the obligation currency), sender COMPANY label', async () => {
    const t = makeService({ obligation: makeObligation({ debtorType: 'DROP', currency: 'USD' }) })
    t.world.sourceTx.type = 'SENIOR_PENDING_PAYOUT'
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    const r = t.row()
    expect(r['currency']).toBe('USD')
    expect(r['fundingSource']).toBeNull()
    expect(r['senderId']).toBeNull()
    expect(r['senderLabel']).toBe('COMPANY')
    expect(t.lock).not.toHaveBeenCalled()
  })

  it('LEGACY drop-debt with explicit COMPANY_ACCOUNT funding: still no company marker, no lock, a ZERO company balance does not gate it', async () => {
    const t = makeService({
      obligation: makeObligation({ debtorType: 'DROP', currency: 'USD' }),
      companyBalance: '0',
    })
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'COMPANY_ACCOUNT',
      currency: 'USDT',
      ...EXPLORER,
    })
    const r = t.row()
    expect(r['fundingSource']).toBeNull()
    expect(r['currency']).toBe('USD')
    expect(t.lock).not.toHaveBeenCalled()
    expect(t.status()).toBe('PAID')
  })

  it('LEGACY drop-debt top-up after a company-marked first payment is refused: the settle pot is NULL, not the company pot', async () => {
    const t = makeService({
      ...reopenedSenior('680', '560.000000'),
      obligation: makeObligation({ amount: '680', debtorType: 'DROP' }),
    })
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    await expect(t.svc.settleByCompany(OBLIGATION_ID, accountantUser)).rejects.toMatchObject({
      response: { code: 'FINANCE_SETTLEMENT_FUNDING_SOURCE_MUST_MATCH' },
    })
    vi.restoreAllMocks()
  })

  it('LEGACY drop-debt with explicit COMPANY_ACCOUNT funding is ALSO compared as pot NULL: a company-marked prior payment still refuses the top-up', async () => {
    // useCompanyAccount is true here but debitsCompanyAccount is false; the
    // funding-source guard must compare the pot that is actually WRITTEN
    // (null), not the pot that was merely requested.
    const t = makeService({
      ...reopenedSenior('680', '560.000000'),
      obligation: makeObligation({ amount: '680', debtorType: 'DROP' }),
    })
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    await expect(
      t.svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'COMPANY_ACCOUNT',
        currency: 'USDT',
        ...EXPLORER,
      }),
    ).rejects.toMatchObject({
      response: { code: 'FINANCE_SETTLEMENT_FUNDING_SOURCE_MUST_MATCH' },
    })
    expect(t.flips).toHaveLength(0)
    vi.restoreAllMocks()
  })

  it('ADMIN_PERSONAL, explicit payer: sender is that admin, label is the display name, no marker, no lock, USDT default', async () => {
    const t = makeService({ obligation: makeObligation({ currency: 'USDT' }) })
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser, {
      fundingSource: 'ADMIN_PERSONAL',
      payerAdminId: ADMIN_B_ID,
      ...EXPLORER,
    })
    const r = t.row()
    expect(r['senderId']).toBe(ADMIN_B_ID)
    expect(r['senderLabel']).toBe('Admin B')
    expect(r['fundingSource']).toBeNull()
    expect(r['currency']).toBe('USDT')
    expect(t.lock).not.toHaveBeenCalled()
  })

  it('ADMIN_PERSONAL with no payerAdminId defaults to the calling ADMIN', async () => {
    const t = makeService()
    await t.svc.settleByCompany(OBLIGATION_ID, adminAUser, {
      fundingSource: 'ADMIN_PERSONAL',
      ...EXPLORER,
    })
    expect(t.row()['senderId']).toBe(ADMIN_A_ID)
    expect(t.row()['senderLabel']).toBe('Admin A')
  })

  it('ADMIN_PERSONAL with no payerAdminId and an ACCOUNTANT caller is refused: the accountant is not an ADMIN payer', async () => {
    const t = makeService()
    await expect(
      t.svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        ...EXPLORER,
      }),
    ).rejects.toMatchObject({
      response: { code: 'FINANCE_PAYER_ACCOUNT_MUST_BE_ADMIN', statusCode: 400 },
    })
    expect(t.flips).toHaveLength(0)
  })

  it('ADMIN_PERSONAL with an unknown payer id is refused', async () => {
    const t = makeService()
    await expect(
      t.svc.settleByCompany(
        OBLIGATION_ID,
        accountantUser,
        personal('99999999-9999-4999-8999-999999999999'),
      ),
    ).rejects.toMatchObject({
      response: { code: 'FINANCE_PAYER_ACCOUNT_MUST_BE_ADMIN', statusCode: 400 },
    })
  })

  it('SENIOR ADMIN_PERSONAL: an explicit USD currency is accepted and recorded; UAH / EUR are refused (BIZ-03 whitelist) with the currency in params', async () => {
    const usd = makeService()
    await usd.svc.settleByCompany(
      OBLIGATION_ID,
      accountantUser,
      personal(ADMIN_A_ID, { currency: 'USD', ...FILE }),
    )
    expect(usd.row()['currency']).toBe('USD')
    expect(usd.row()['settledCurrency']).toBe('USD')

    for (const currency of ['UAH', 'EUR'] as const) {
      const t = makeService()
      await expect(
        t.svc.settleByCompany(
          OBLIGATION_ID,
          accountantUser,
          personal(ADMIN_A_ID, { currency, ...FILE }),
        ),
      ).rejects.toMatchObject({
        response: {
          code: 'FINANCE_USDT_OBLIGATION_CLOSE_CURRENCY_UNSUPPORTED',
          statusCode: 400,
          params: { currency },
        },
      })
      expect(t.flips).toHaveLength(0)
    }
  })

  it('SENIOR defense-in-depth: a corrupted non-whitelisted OBLIGATION currency is refused on the default path', async () => {
    const t = makeService({ obligation: makeObligation({ currency: 'EUR' }) })
    await expect(
      t.svc.settleByCompany(OBLIGATION_ID, accountantUser, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: ADMIN_A_ID,
        ...FILE,
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'FINANCE_USDT_OBLIGATION_CLOSE_CURRENCY_UNSUPPORTED',
        params: { currency: 'EUR' },
      },
    })
  })

  it('DROP is exempt from the whitelist: UAH is accepted for ADMIN_PERSONAL, converted, labelled UAH', async () => {
    const t = makeService(dropWorld())
    await t.svc.settleByCompany(
      OBLIGATION_ID,
      accountantUser,
      personal(ADMIN_A_ID, { currency: 'UAH', ...FILE }),
    )
    expect(t.row()['currency']).toBe('UAH')
    expect(t.row()['type']).toBe('PAYOUT_DROP')
  })

  it('self-pay: an ADMIN_PERSONAL payer equal to the creditor is refused before any write', async () => {
    const t = makeService({ obligation: makeObligation({ creditorUserId: ADMIN_A_ID }) })
    await expect(
      t.svc.settleByCompany(OBLIGATION_ID, accountantUser, personal(ADMIN_A_ID)),
    ).rejects.toBeDefined()
    expect(t.flips).toHaveLength(0)
  })

  it('SENIOR vs DROP discriminator: the flipped type and the share snapshot follow the source type', async () => {
    const senior = makeService()
    await senior.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(senior.row()['type']).toBe('SENIOR_INCOME')
    expect(senior.row()['settledSharePercent']).toBe(26)
    expect(senior.row()['validatedBy']).toBe('acc-1')

    const drop = makeService(dropWorld())
    await drop.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(drop.row()['type']).toBe('PAYOUT_DROP')
    expect(drop.row()['settledSharePercent']).toBe(26)
    expect(drop.row()['validatedBy']).toBeNull()
  })

  it('only COMPANY / DROP debtor types settle here; anything else is refused with the type code', async () => {
    const t = makeService({ obligation: makeObligation({ debtorType: 'TOV' as never }) })
    await expect(t.svc.settleByCompany(OBLIGATION_ID, accountantUser)).rejects.toMatchObject({
      response: { code: 'FINANCE_OBLIGATION_NOT_COMPANY_TYPE', statusCode: 400 },
    })
  })
})

// ---------------------------------------------------------------------------
// 8. In-transaction claim compare (TOCTOU): equality at six decimals
// ---------------------------------------------------------------------------
describe('L2 claim compare — loaded amount vs committed amount at SIX decimals', () => {
  it('a difference at the 6th decimal is a race: refused, nothing written, balance gate never reached', async () => {
    const t = makeService({
      obligation: makeObligation({ amount: '1000.000002' }),
      staleLoadAmount: '1000.000001',
      companyBalance: '0',
    })
    await expect(t.svc.settleByCompany(OBLIGATION_ID, accountantUser)).rejects.toMatchObject({
      response: { code: 'FINANCE_OBLIGATION_AMOUNT_CHANGED', statusCode: 400 },
    })
    expect(t.flips).toHaveLength(0)
    expect(t.lock).not.toHaveBeenCalled()
  })

  it('a difference only beyond the 6th decimal is the same number to Postgres: accepted', async () => {
    const t = makeService({
      obligation: makeObligation({ amount: '1000.0000002' }),
      staleLoadAmount: '1000.0000001',
    })
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(t.status()).toBe('PAID')
  })

  it('"1000" and "1000.000000" are the same amount: accepted', async () => {
    const t = makeService({
      obligation: makeObligation({ amount: '1000.000000' }),
      staleLoadAmount: '1000',
    })
    await t.svc.settleByCompany(OBLIGATION_ID, accountantUser)
    expect(t.status()).toBe('PAID')
  })
})

// ---------------------------------------------------------------------------
// 9. NBU rate admissibility on the conversion path
// ---------------------------------------------------------------------------
describe('L2 NBU rate admissibility', () => {
  it('stale WITHOUT a rate date is refused; stale WITH a rate date and non-stale WITHOUT one are accepted', async () => {
    const outage = makeService({ ...dropWorld(), rates: { ...RATES, stale: true } })
    await expect(
      outage.svc.settleByCompany(
        OBLIGATION_ID,
        accountantUser,
        personal(ADMIN_A_ID, { currency: 'UAH', ...FILE }),
      ),
    ).rejects.toMatchObject({ response: { code: 'FINANCE_NBU_RATE_UNAVAILABLE', statusCode: 400 } })
    expect(outage.flips).toHaveLength(0)

    const dated = makeService({
      ...dropWorld(),
      rates: { ...RATES, stale: true, rateDate: '20260810' },
    })
    await dated.svc.settleByCompany(
      OBLIGATION_ID,
      accountantUser,
      personal(ADMIN_A_ID, { currency: 'UAH', ...FILE }),
    )
    expect(dated.row()['amount']).toBe('41500.000000')

    const fresh = makeService({ ...dropWorld(), rates: { ...RATES, stale: false } })
    await fresh.svc.settleByCompany(
      OBLIGATION_ID,
      accountantUser,
      personal(ADMIN_A_ID, { currency: 'UAH', ...FILE }),
    )
    expect(fresh.row()['amount']).toBe('41500.000000')
  })
})
