/**
 * Unit coverage for PayoutRequestService.createPayoutRequest with a db double:
 * the role gate, share selection (SENIOR snapshot vs DROP snapshot/user/default),
 * USDT conversion + decimal aggregation, every validation error code, the stale
 * NBU-rate refusal and the exact shape of the three writes (payout_request,
 * income link, placeholder PAYOUT row).
 */
import { ForbiddenException, HttpException } from '@nestjs/common'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import type { DatabaseService } from '../database/database.service'
import type { NbuCurrencyService } from './nbu-currency.service'
import type { PayoutRequestReadService } from './payout-request-read.service'
import { PayoutRequestService } from './payout-request.service'

function user(role: SessionUser['role'], id = `${role.toLowerCase()}-id`): SessionUser {
  return {
    id,
    role,
    displayName: `Test ${role}`,
    email: `${id}@test.com`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
    locale: 'en',
  }
}

function income(overrides: Record<string, unknown> = {}) {
  return {
    id: 'tx-1',
    type: 'SENIOR_INCOME',
    status: 'VALIDATED',
    amount: '1000',
    currency: 'USDT',
    projectId: 'proj-1',
    seniorSharePercent: 26,
    dropSharePercent: null,
    txDate: new Date('2026-03-10T00:00:00.000Z'),
    createdAt: new Date('2026-03-11T00:00:00.000Z'),
    ...overrides,
  }
}

interface Setup {
  rows?: unknown[]
  wallet?: string | null
  rate?: { usdUah: string; eurUah: string; stale?: boolean; rateDate?: string }
  dropUser?: { dropSharePercent: number | null } | null
}

function setup(opts: Setup = {}) {
  const rows = opts.rows ?? [income()]
  const wallet = opts.wallet === undefined ? '0xCompany' : opts.wallet
  const rate = opts.rate ?? { usdUah: '40', eurUah: '44' }

  const forMock = vi.fn(async () => rows)
  const selectWhere = vi.fn((_cond: unknown) => ({ for: forMock }))
  const select = vi.fn(() => ({ from: vi.fn(() => ({ where: selectWhere })) }))

  const requestValues = vi.fn(() => ({
    returning: vi.fn(async () => [{ id: 'new-req' }]),
  }))
  const payoutValues = vi.fn(async () => [])
  const insert = vi.fn((table: unknown) => {
    void table
    return insert.mock.calls.length === 1 ? { values: requestValues } : { values: payoutValues }
  })
  const updateWhere = vi.fn(async (_cond: unknown) => [])
  const updateSet = vi.fn(() => ({ where: updateWhere }))
  const update = vi.fn(() => ({ set: updateSet }))
  const companyAccountFindFirst = vi.fn(async () => (wallet ? { walletAddress: wallet } : null))
  const dbtx = {
    select,
    insert,
    update,
    query: { companyAccount: { findFirst: companyAccountFindFirst } },
  }

  const userFindFirst = vi.fn(async (_args: { where: unknown }) => opts.dropUser ?? null)
  const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(dbtx))
  const db = {
    db: { transaction, query: { users: { findFirst: userFindFirst } } },
  } as unknown as DatabaseService
  const getRates = vi.fn(async () => rate)
  const nbu = { getRates } as unknown as NbuCurrencyService
  const findPayoutRequest = vi.fn(async () => ({ id: 'read-back' }))
  const payoutRead = { findPayoutRequest } as unknown as PayoutRequestReadService

  return {
    svc: new PayoutRequestService(db, payoutRead, nbu),
    requestValues,
    payoutValues,
    updateSet,
    update,
    insert,
    select,
    forMock,
    transaction,
    userFindFirst,
    selectWhere,
    updateWhere,
    getRates,
    findPayoutRequest,
    companyAccountFindFirst,
  }
}

function render(cond: unknown): { sql: string; params: unknown[] } {
  return new PgDialect().sqlToQuery(cond as SQL)
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p
  } catch (e) {
    return (e as HttpException).getResponse
      ? ((e as HttpException).getResponse() as { code?: string }).code
      : undefined
  }
  return undefined
}

describe('PayoutRequestService.createPayoutRequest', () => {
  // SR-809-H-1: several tests below pin the clock beside their fixture dates
  // (see the comment on the happy path). Restoring real timers here rather than
  // in each body keeps the long test bodies readable, and is a no-op for the
  // tests that never fake time.
  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects every role except SENIOR and DROP before touching anything', async () => {
    for (const role of ['ADMIN', 'ACCOUNTANT', 'JUNIOR', 'HR'] as const) {
      const s = setup()
      await expect(s.svc.createPayoutRequest(['tx-1'], user(role))).rejects.toBeInstanceOf(
        ForbiddenException,
      )
      expect(s.getRates).not.toHaveBeenCalled()
      expect(s.transaction).not.toHaveBeenCalled()
    }
  })

  // SR-809-H-1: the clock is pinned beside the fixture dates. These tests are
  // about the "a payout cannot predate its income" bound, and they ran against
  // real time with March-2026 literals — so once the 31-day backdating window
  // existed a SENIOR fixture failed for an unrelated reason (the window), and
  // would otherwise have drifted in and out of passing as the calendar moved.
  // Pinning keeps each one testing the bound it was written for, permanently.
  it('SENIOR happy path: shares, writes and read-back', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-25T12:00:00.000Z'))
    const s = setup({ rows: [income({ amount: '1000', seniorSharePercent: 26 })] })
    const out = await s.svc.createPayoutRequest(['tx-1'], user('SENIOR', 'sen-1'), '2026-03-20')

    expect(out).toEqual({ id: 'read-back' })
    expect(s.findPayoutRequest).toHaveBeenCalledWith(
      'new-req',
      expect.objectContaining({ id: 'sen-1' }),
    )
    expect(s.userFindFirst).not.toHaveBeenCalled()
    // company keeps 1 - 26% = 74% of 1000
    expect(s.requestValues).toHaveBeenCalledWith({
      seniorId: 'sen-1',
      incomeAmount: '1000.000000',
      payableAmount: '740.000000',
      contractAddress: '0xCompany',
      status: 'PENDING',
    })
    expect(s.updateSet).toHaveBeenCalledWith({
      payoutRequestId: 'new-req',
      status: 'PENDING_PAYMENT',
      updatedAt: expect.any(Date),
    })
    expect(s.payoutValues).toHaveBeenCalledWith({
      type: 'PAYOUT',
      status: 'PENDING_PAYMENT',
      amount: '740.000000',
      currency: 'USDT',
      senderId: 'sen-1',
      receiverLabel: 'CheekyCheeseIT',
      payoutRequestId: 'new-req',
      projectId: 'proj-1',
      txDate: new Date('2026-03-20T00:00:00.000Z'),
      createdBy: 'sen-1',
    })
  })

  it('SENIOR without a snapshot falls back to the 26% default', async () => {
    const s = setup({ rows: [income({ seniorSharePercent: null })] })
    await s.svc.createPayoutRequest(['tx-1'], user('SENIOR'))
    expect(s.requestValues).toHaveBeenCalledWith(
      expect.objectContaining({ incomeAmount: '1000.000000', payableAmount: '740.000000' }),
    )
  })

  it('SENIOR snapshot of 0 is honoured (not treated as missing)', async () => {
    const s = setup({ rows: [income({ seniorSharePercent: 0 })] })
    await s.svc.createPayoutRequest(['tx-1'], user('SENIOR'))
    expect(s.requestValues).toHaveBeenCalledWith(
      expect.objectContaining({ payableAmount: '1000.000000' }),
    )
  })

  it('DROP uses the per-income dropSharePercent snapshot over the user default', async () => {
    const s = setup({
      rows: [income({ type: 'DROP_INCOME', dropSharePercent: 10, seniorSharePercent: 26 })],
      dropUser: { dropSharePercent: 20 },
    })
    await s.svc.createPayoutRequest(['tx-1'], user('DROP', 'drop-1'))
    expect(s.userFindFirst).toHaveBeenCalledTimes(1)
    expect(s.requestValues).toHaveBeenCalledWith(
      expect.objectContaining({ seniorId: 'drop-1', payableAmount: '900.000000' }),
    )
  })

  it('DROP without snapshot falls back to the user-level dropSharePercent', async () => {
    const s = setup({
      rows: [income({ type: 'DROP_INCOME', dropSharePercent: null })],
      dropUser: { dropSharePercent: 20 },
    })
    await s.svc.createPayoutRequest(['tx-1'], user('DROP'))
    expect(s.requestValues).toHaveBeenCalledWith(
      expect.objectContaining({ payableAmount: '800.000000' }),
    )
  })

  it('DROP without snapshot and without a user default falls back to 5%', async () => {
    const missingUser = setup({
      rows: [income({ type: 'DROP_INCOME', dropSharePercent: null })],
      dropUser: null,
    })
    await missingUser.svc.createPayoutRequest(['tx-1'], user('DROP'))
    expect(missingUser.requestValues).toHaveBeenCalledWith(
      expect.objectContaining({ payableAmount: '950.000000' }),
    )
    const nullShare = setup({
      rows: [income({ type: 'DROP_INCOME', dropSharePercent: null })],
      dropUser: { dropSharePercent: null },
    })
    await nullShare.svc.createPayoutRequest(['tx-1'], user('DROP'))
    expect(nullShare.requestValues).toHaveBeenCalledWith(
      expect.objectContaining({ payableAmount: '950.000000' }),
    )
  })

  it('converts EUR and UAH to USDT and sums income and company share separately', async () => {
    const s = setup({
      rate: { usdUah: '40', eurUah: '44' },
      rows: [
        income({ id: 'a', amount: '100', currency: 'EUR', seniorSharePercent: 50 }),
        income({ id: 'b', amount: '4000', currency: 'UAH', seniorSharePercent: 50 }),
        income({ id: 'c', amount: '10.5', currency: 'USD', seniorSharePercent: 50 }),
      ],
    })
    await s.svc.createPayoutRequest(['a', 'b', 'c'], user('SENIOR'))
    // EUR 100 -> 110 USDT, UAH 4000 -> 100 USDT, USD 10.5 -> 10.5 USDT; company keeps half
    expect(s.requestValues).toHaveBeenCalledWith(
      expect.objectContaining({ incomeAmount: '220.500000', payableAmount: '110.250000' }),
    )
  })

  it('refuses a batch whose size differs from the locked set', async () => {
    const s = setup({ rows: [income()] })
    expect(await codeOf(s.svc.createPayoutRequest(['tx-1', 'tx-2'], user('SENIOR')))).toBe(
      'FINANCE_PAYOUT_TRANSACTIONS_UNAVAILABLE',
    )
    expect(s.insert).not.toHaveBeenCalled()
    expect(s.findPayoutRequest).not.toHaveBeenCalled()
  })

  it('refuses a payout date before the latest source income date, allows the same day', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-12T12:00:00.000Z'))
    const before = setup({ rows: [income({ txDate: new Date('2026-03-10T08:00:00.000Z') })] })
    expect(
      await codeOf(before.svc.createPayoutRequest(['tx-1'], user('SENIOR'), '2026-03-09')),
    ).toBe('FINANCE_PAYOUT_DATE_BEFORE_INCOME')
    expect(before.insert).not.toHaveBeenCalled()
    const same = setup({ rows: [income({ txDate: new Date('2026-03-10T08:00:00.000Z') })] })
    await same.svc.createPayoutRequest(['tx-1'], user('SENIOR'), '2026-03-10')
    expect(same.insert).toHaveBeenCalled()
  })

  it('uses the latest of several source dates and falls back to createdAt without txDate', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-18T12:00:00.000Z'))
    const s = setup({
      rows: [
        income({ id: 'a', txDate: new Date('2026-03-01T00:00:00.000Z') }),
        income({ id: 'b', txDate: null, createdAt: new Date('2026-03-15T10:00:00.000Z') }),
        income({ id: 'c', txDate: new Date('2026-03-05T00:00:00.000Z') }),
      ],
    })
    expect(
      await codeOf(s.svc.createPayoutRequest(['a', 'b', 'c'], user('SENIOR'), '2026-03-14')),
    ).toBe('FINANCE_PAYOUT_DATE_BEFORE_INCOME')
    const ok = setup({
      rows: [
        income({ id: 'a', txDate: new Date('2026-03-01T00:00:00.000Z') }),
        income({ id: 'b', txDate: null, createdAt: new Date('2026-03-15T10:00:00.000Z') }),
      ],
    })
    await ok.svc.createPayoutRequest(['a', 'b'], user('SENIOR'), '2026-03-15')
    expect(ok.insert).toHaveBeenCalled()
  })

  // SR-809-M-1 (PR #868): an omitted date resolves to "now", and "now" is still
  // bound by the latest source date — omission is not a way around the check.
  it('without a payout date the effective date (now) is still bound by the source date', async () => {
    const s = setup({ rows: [income({ txDate: new Date('2999-01-01T00:00:00.000Z') })] })
    expect(await codeOf(s.svc.createPayoutRequest(['tx-1'], user('SENIOR')))).toBe(
      'FINANCE_PAYOUT_DATE_BEFORE_INCOME',
    )
    expect(s.payoutValues).not.toHaveBeenCalled()
  })

  it('without a payout date and a past source, the row is stamped now', async () => {
    const s = setup({ rows: [income({ txDate: new Date('2020-01-01T00:00:00.000Z') })] })
    const before = Date.now()
    await s.svc.createPayoutRequest(['tx-1'], user('SENIOR'))
    const call = s.payoutValues.mock.calls[0] as unknown as [{ txDate: Date }]
    expect(call[0].txDate.getTime()).toBeGreaterThanOrEqual(before)
    expect(call[0].txDate.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('DROP batches must be single-project; SENIOR batches may span projects', async () => {
    const rows = [
      income({ id: 'a', type: 'DROP_INCOME', projectId: 'p1' }),
      income({ id: 'b', type: 'DROP_INCOME', projectId: 'p2' }),
    ]
    const drop = setup({ rows, dropUser: { dropSharePercent: 5 } })
    expect(await codeOf(drop.svc.createPayoutRequest(['a', 'b'], user('DROP')))).toBe(
      'FINANCE_PAYOUT_SINGLE_PROJECT_ONLY',
    )
    expect(drop.insert).not.toHaveBeenCalled()
    const sameProject = setup({
      rows: [
        income({ id: 'a', type: 'DROP_INCOME', projectId: 'p1' }),
        income({ id: 'b', type: 'DROP_INCOME', projectId: 'p1' }),
      ],
    })
    await sameProject.svc.createPayoutRequest(['a', 'b'], user('DROP'))
    expect(sameProject.insert).toHaveBeenCalled()
    const senior = setup({
      rows: [income({ id: 'a', projectId: 'p1' }), income({ id: 'b', projectId: 'p2' })],
    })
    await senior.svc.createPayoutRequest(['a', 'b'], user('SENIOR'))
    expect(senior.payoutValues).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1' }))
  })

  it('refuses when the company wallet is missing or blank', async () => {
    for (const wallet of [null, '']) {
      const s = setup({ wallet })
      expect(await codeOf(s.svc.createPayoutRequest(['tx-1'], user('SENIOR')))).toBe(
        'FINANCE_COMPANY_WALLET_NOT_CONFIGURED',
      )
      expect(s.insert).not.toHaveBeenCalled()
    }
  })

  it('refuses a cross-currency batch on a stale rate with no rate date, before any write', async () => {
    const s = setup({
      rate: { usdUah: '40', eurUah: '44', stale: true },
      rows: [income({ currency: 'EUR' })],
    })
    expect(await codeOf(s.svc.createPayoutRequest(['tx-1'], user('SENIOR')))).toBe(
      'FINANCE_NBU_RATE_UNAVAILABLE',
    )
    expect(s.insert).not.toHaveBeenCalled()
    expect(s.update).not.toHaveBeenCalled()
  })

  it('accepts a stale rate that carries a real publication date, and non-stale rates', async () => {
    const withDate = setup({
      rate: { usdUah: '40', eurUah: '44', stale: true, rateDate: '2026-03-06' },
      rows: [income({ currency: 'UAH', amount: '400', seniorSharePercent: 0 })],
    })
    await withDate.svc.createPayoutRequest(['tx-1'], user('SENIOR'))
    expect(withDate.requestValues).toHaveBeenCalledWith(
      expect.objectContaining({ incomeAmount: '10.000000' }),
    )
    const fresh = setup({
      rate: { usdUah: '40', eurUah: '44', stale: false },
      rows: [income({ currency: 'EUR' })],
    })
    await fresh.svc.createPayoutRequest(['tx-1'], user('SENIOR'))
    expect(fresh.insert).toHaveBeenCalled()
  })

  it('USDT/USD-only batches go through on a stale rate with no date', async () => {
    const s = setup({
      rate: { usdUah: '40', eurUah: '44', stale: true },
      rows: [income({ currency: 'USDT' }), income({ id: 'tx-2', currency: 'USD' })],
    })
    await s.svc.createPayoutRequest(['tx-1', 'tx-2'], user('SENIOR'))
    expect(s.insert).toHaveBeenCalled()
  })

  it('fetches the NBU snapshot once, before opening the transaction', async () => {
    const s = setup()
    const order: string[] = []
    s.getRates.mockImplementation(async () => {
      order.push('rates')
      return { usdUah: '40', eurUah: '44' }
    })
    s.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      order.push('transaction')
      return fn({
        select: s.select,
        insert: s.insert,
        update: s.update,
        query: { companyAccount: { findFirst: s.companyAccountFindFirst } },
      })
    })
    await s.svc.createPayoutRequest(['tx-1'], user('SENIOR'))
    expect(order).toEqual(['rates', 'transaction'])
    expect(s.getRates).toHaveBeenCalledTimes(1)
  })

  it('locks the candidate rows FOR UPDATE and links exactly the locked ids', async () => {
    const s = setup({ rows: [income({ id: 'locked-1' }), income({ id: 'locked-2' })] })
    await s.svc.createPayoutRequest(['x', 'y'], user('SENIOR'))
    expect(s.forMock).toHaveBeenCalledWith('update')
    expect(s.update).toHaveBeenCalledTimes(1)
  })

  it('stores a null projectId on the PAYOUT row when the first income has none', async () => {
    const s = setup({ rows: [income({ projectId: null })] })
    await s.svc.createPayoutRequest(['tx-1'], user('SENIOR'))
    expect(s.payoutValues).toHaveBeenCalledWith(expect.objectContaining({ projectId: null }))
  })
})

describe('PayoutRequestService.createPayoutRequest predicates', () => {
  it('locks SENIOR_INCOME rows for a SENIOR with the full candidate predicate', async () => {
    const s = setup()
    await s.svc.createPayoutRequest(['tx-a'], user('SENIOR', 'sen-1'))
    const { sql: text, params } = render(s.selectWhere.mock.calls[0]![0])
    expect(params).toEqual(['tx-a', 'SENIOR_INCOME', 'VALIDATED', 'sen-1'])
    expect(text).toContain('"payout_request_id" is null')
    expect(text).toContain('"deleted_at" is null')
  })

  it('locks DROP_INCOME rows for a DROP and reads the user default by id', async () => {
    const s = setup({ rows: [income({ type: 'DROP_INCOME' })], dropUser: { dropSharePercent: 5 } })
    await s.svc.createPayoutRequest(['tx-a'], user('DROP', 'drop-1'))
    expect(render(s.selectWhere.mock.calls[0]![0]).params).toEqual([
      'tx-a',
      'DROP_INCOME',
      'VALIDATED',
      'drop-1',
    ])
    const lookup = render(s.userFindFirst.mock.calls[0]![0].where)
    expect(lookup.params).toEqual(['drop-1'])
  })

  it('links exactly the locked ids, not the caller-supplied ones', async () => {
    const s = setup({ rows: [income({ id: 'locked-1' }), income({ id: 'locked-2' })] })
    await s.svc.createPayoutRequest(['req-1', 'req-2'], user('SENIOR'))
    expect(render(s.updateWhere.mock.calls[0]![0]).params).toEqual(['locked-1', 'locked-2'])
  })
})
