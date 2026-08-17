/**
 * task-finance-fix-wave1 / D-3 — a payout amount must never be baked from a
 * FALLBACK exchange rate.
 *
 * WHY (the defect these tests pin):
 *   `createPayoutRequest` fetched the NBU snapshot and never looked at
 *   `stale`. `NbuCurrencyService.getRates()` does not throw when the feed is
 *   down — it returns `HARDCODED_FALLBACK` with `stale: true` — so a total NBU
 *   outage silently converted EUR/UAH incomes into USDT at a made-up rate and
 *   wrote the result into `payout_requests.incomeAmount/payableAmount`, an
 *   irreversible INSERT. That figure is not a display value: `payPayoutRequest`
 *   later requires the on-chain transfer to match `payableAmount` EXACTLY (no
 *   percentage band), so a wrong number makes the payout either unpayable or
 *   payable at the wrong amount. Reachable by any SENIOR or DROP through the
 *   ordinary create-payout POST.
 *
 * The gate mirrors the one neighbouring path that already got this right —
 * `pending-settlement.service.ts` `settleByCompany`:
 *   - refuse ONLY a genuine feed outage: `stale && rateDate === undefined`.
 *     A weekend/holiday rate is `stale: true` WITH a real `rateDate` (an actual
 *     NBU publication from the nearest prior business day) — exact and final,
 *     and refusing it would break an ordinary working day.
 *   - refuse ONLY when a rate is actually applied: a batch already denominated
 *     in USDT (or USD, its 1:1 peg) converts by identity, so it must go through
 *     even with NBU completely unavailable.
 *
 * Both halves are asserted below, because a fix that only implemented the first
 * one would refuse legitimate payouts every weekend and every all-USDT batch.
 */
import { BadRequestException } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'

import { makeTransactionsService } from './__test-helpers__/make-transactions-service'
import type { EtherscanService } from './etherscan.service'
import type { NbuCurrencyService } from './nbu-currency.service'

const COMPANY_WALLET = '0xC0FFEE0000000000000000000000000000000001'

const SENIOR_USER: SessionUser = {
  id: 'senior-1',
  role: 'SENIOR',
  displayName: 'Senior',
  email: 'senior@test.spec',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
}

/**
 * NBU snapshots. 1 USD = 40 UAH, 1 EUR = 44 UAH ⇒ 1 EUR = 1.1 USDT.
 *
 *  - `live`     — ordinary healthy feed.
 *  - `weekend`  — `stale: true` WITH `rateDate`: a real publication from the
 *                 nearest prior business day. Legitimate, must be accepted.
 *  - `outage`   — `stale: true` and NO `rateDate`: the hardcoded fallback, i.e.
 *                 nobody knows today's rate. Must be refused when applied.
 */
function makeNbuStub(kind: 'live' | 'weekend' | 'outage'): NbuCurrencyService {
  const base = { usdUah: '40.0000', usdtUah: '40.0000', eurUah: '44.0000', date: '20260817' }
  const result =
    kind === 'live'
      ? { ...base, stale: false, rateDate: '20260817' }
      : kind === 'weekend'
        ? { ...base, stale: true, rateDate: '20260814' }
        : { ...base, stale: true } // rateDate absent — genuine outage
  return { getRates: vi.fn().mockResolvedValue(result) } as unknown as NbuCurrencyService
}

function makeEtherscanStub(): EtherscanService {
  return {
    verifyDeposit: vi.fn().mockResolvedValue({ found: false, confirmed: false }),
  } as unknown as EtherscanService
}

function makeIncome(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inc-1',
    type: 'SENIOR_INCOME' as const,
    status: 'VALIDATED' as const,
    amount: '1000',
    currency: 'USDT' as const,
    receiverId: SENIOR_USER.id,
    projectId: 'proj-1',
    payoutRequestId: null,
    deletedAt: null,
    seniorSharePercent: 26,
    createdBy: SENIOR_USER.id,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

const PR_ROW = {
  id: 'pr-1',
  seniorId: SENIOR_USER.id,
  incomeAmount: '1000',
  payableAmount: '740',
  contractAddress: COMPANY_WALLET,
  status: 'PENDING' as const,
  createdAt: new Date(),
  updatedAt: new Date(),
}

/**
 * Service whose `db.transaction()` runs the callback against a stubbed `dbtx`
 * wired for createPayoutRequest: SELECT … FOR UPDATE → the income rows,
 * companyAccount → the wallet, INSERT payout_requests → PR_ROW, then the
 * UPDATE + placeholder-PAYOUT INSERT.
 *
 * `prValues` captures what the payout_request was actually written with, so the
 * accept-cases assert the recorded amount and not merely the absence of a throw.
 */
function makeService(lockedRows: unknown[], nbu: 'live' | 'weekend' | 'outage') {
  const prValues = vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([PR_ROW]) })
  const payoutValues = vi.fn().mockResolvedValue([])

  let insertCall = 0
  const dbtx = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ for: vi.fn().mockResolvedValue(lockedRows) }),
      }),
    }),
    insert: vi.fn().mockImplementation(() => {
      insertCall += 1
      return insertCall === 1 ? { values: prValues } : { values: payoutValues }
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
    }),
    query: {
      companyAccount: {
        findFirst: vi.fn().mockResolvedValue({ walletAddress: COMPANY_WALLET }),
      },
    },
  }

  const db = {
    db: {
      query: {
        transactions: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
        users: { findFirst: vi.fn() },
        payoutRequests: {
          findFirst: vi.fn().mockResolvedValue({
            ...PR_ROW,
            senior: { displayName: 'Senior' },
            transactions: lockedRows,
          }),
        },
        teamMembers: { findMany: vi.fn().mockResolvedValue([]) },
      },
      transaction: vi.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(dbtx)),
    },
  } as never

  const svc = makeTransactionsService({
    db,
    nbuCurrencyService: makeNbuStub(nbu),
    etherscanService: makeEtherscanStub(),
  })
  return { svc, prValues }
}

const OUTAGE_MESSAGE =
  'Курс НБУ недоступен — сумма выплаты в USDT не может быть рассчитана. Повторите позже.'

// ── AC6 + AC9(a): a genuine outage refuses when a rate is applied ────────────

describe('createPayoutRequest — AC6: a genuine NBU outage refuses a converted payout', () => {
  it('refuses an EUR income batch (nothing is written)', async () => {
    const { svc, prValues } = makeService([makeIncome({ currency: 'EUR' })], 'outage')

    await expect(svc.createPayoutRequest(['inc-1'], SENIOR_USER)).rejects.toThrow(OUTAGE_MESSAGE)
    expect(prValues).not.toHaveBeenCalled()
  })

  it('refuses a MIXED batch where only part of it needs the rate', async () => {
    // The USDT row converts by identity; the EUR row does not. One row that
    // needs the rate is enough to poison the recorded total.
    const { svc, prValues } = makeService(
      [makeIncome({ id: 'inc-1', currency: 'USDT' }), makeIncome({ id: 'inc-2', currency: 'EUR' })],
      'outage',
    )

    await expect(svc.createPayoutRequest(['inc-1', 'inc-2'], SENIOR_USER)).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(prValues).not.toHaveBeenCalled()
  })

  it('refuses a UAH income batch', async () => {
    const { svc } = makeService([makeIncome({ currency: 'UAH' })], 'outage')

    await expect(svc.createPayoutRequest(['inc-1'], SENIOR_USER)).rejects.toThrow(OUTAGE_MESSAGE)
  })
})

// ── AC9(b): a weekend rate is real — it must NOT be refused ─────────────────

describe('createPayoutRequest — AC9(b): a dated (weekend/holiday) rate is accepted', () => {
  it('converts an EUR income at the prior business day rate', async () => {
    const { svc, prValues } = makeService([makeIncome({ currency: 'EUR' })], 'weekend')

    await expect(svc.createPayoutRequest(['inc-1'], SENIOR_USER)).resolves.toBeDefined()

    // EUR→USDT ×1.1 (44/40): gross 1000 EUR → 1100 USDT; company keeps
    // 1 − 26% of 1000 EUR = 740 EUR → 814 USDT.
    expect(prValues).toHaveBeenCalledWith(
      expect.objectContaining({ incomeAmount: '1100.000000', payableAmount: '814.000000' }),
    )
  })
})

// ── AC7 + AC9(c): no conversion needed → no rate needed ─────────────────────

describe('createPayoutRequest — AC7: an already-USDT batch passes during an outage', () => {
  it('accepts an all-USDT batch with NBU completely unavailable', async () => {
    const { svc, prValues } = makeService([makeIncome({ currency: 'USDT' })], 'outage')

    await expect(svc.createPayoutRequest(['inc-1'], SENIOR_USER)).resolves.toBeDefined()

    // Identity conversion: 1000 gross, company keeps 740. No NBU rate applied,
    // so the outage is irrelevant to this batch.
    expect(prValues).toHaveBeenCalledWith(
      expect.objectContaining({ incomeAmount: '1000.000000', payableAmount: '740.000000' }),
    )
  })

  it('accepts an all-USD batch with NBU completely unavailable (1:1 peg to USDT)', async () => {
    const { svc, prValues } = makeService([makeIncome({ currency: 'USD' })], 'outage')

    await expect(svc.createPayoutRequest(['inc-1'], SENIOR_USER)).resolves.toBeDefined()

    expect(prValues).toHaveBeenCalledWith(
      expect.objectContaining({ incomeAmount: '1000.000000', payableAmount: '740.000000' }),
    )
  })

  it('accepts a cross-currency batch on a healthy feed (regression guard)', async () => {
    const { svc, prValues } = makeService([makeIncome({ currency: 'EUR' })], 'live')

    await expect(svc.createPayoutRequest(['inc-1'], SENIOR_USER)).resolves.toBeDefined()
    expect(prValues).toHaveBeenCalledWith(
      expect.objectContaining({ incomeAmount: '1100.000000', payableAmount: '814.000000' }),
    )
  })
})
