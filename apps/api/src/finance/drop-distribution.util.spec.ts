import { HttpException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import {
  computeDropAggregate,
  computeDropDistribution,
  DEFAULT_SENIOR_SHARE_PERCENT,
} from './drop-distribution.util'
import { DEFAULT_DROP_SHARE_PERCENT } from './drop-share-resolver'

const project = { id: 'p-1', dropId: 'drop-1' }
const drop = { id: 'drop-1', dropSharePercent: 5 }
const senior = { id: 'sn-1', seniorSharePercent: 26 }

describe('computeDropDistribution', () => {
  it('spec §8.1: income 1000, senior 26%, drop 5% -> 260 / 50', () => {
    expect(computeDropDistribution(1000, project, drop, senior)).toEqual({
      seniorShare: { amount: 260, percent: 26 },
      dropShare: { amount: 50, percent: 5 },
    })
  })

  it('defaults are 26 / 5 and applied when percents are null', () => {
    expect(DEFAULT_SENIOR_SHARE_PERCENT).toBe(26)
    expect(DEFAULT_DROP_SHARE_PERCENT).toBe(5)
    const r = computeDropDistribution(
      1000,
      project,
      { id: 'd', dropSharePercent: null },
      { id: 's', seniorSharePercent: null },
    )
    expect(r.seniorShare).toEqual({ amount: 260, percent: 26 })
    expect(r.dropShare).toEqual({ amount: 50, percent: 5 })
  })

  it('null senior only / null drop only fall back independently', () => {
    const a = computeDropDistribution(
      100,
      project,
      { id: 'd', dropSharePercent: 10 },
      { id: 's', seniorSharePercent: null },
    )
    expect(a.seniorShare.percent).toBe(26)
    expect(a.dropShare.percent).toBe(10)
    const b = computeDropDistribution(
      100,
      project,
      { id: 'd', dropSharePercent: null },
      { id: 's', seniorSharePercent: 40 },
    )
    expect(b.seniorShare.percent).toBe(40)
    expect(b.dropShare.percent).toBe(5)
  })

  it('explicit 0 percent is respected (not replaced by default)', () => {
    const r = computeDropDistribution(
      1000,
      project,
      { id: 'd', dropSharePercent: 0 },
      { id: 's', seniorSharePercent: 0 },
    )
    expect(r.seniorShare).toEqual({ amount: 0, percent: 0 })
    expect(r.dropShare).toEqual({ amount: 0, percent: 0 })
  })

  it('sum exactly 100 is allowed; 100.01 throws FINANCE_SHARES_SUM_EXCEEDS_100 (400)', () => {
    const ok = computeDropDistribution(
      200,
      project,
      { id: 'd', dropSharePercent: 50 },
      { id: 's', seniorSharePercent: 50 },
    )
    expect(ok.seniorShare.amount).toBe(100)
    expect(ok.dropShare.amount).toBe(100)

    let caught: unknown
    try {
      computeDropDistribution(
        200,
        project,
        { id: 'd', dropSharePercent: 50 },
        { id: 's', seniorSharePercent: 50.01 },
      )
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HttpException)
    const ex = caught as HttpException
    expect(ex.getStatus()).toBe(400)
    expect((ex.getResponse() as { code: string }).code).toBe('FINANCE_SHARES_SUM_EXCEEDS_100')
  })

  it('guard also triggers when defaults push the sum over 100', () => {
    expect(() =>
      computeDropDistribution(
        100,
        project,
        { id: 'd', dropSharePercent: null },
        { id: 's', seniorSharePercent: 95.5 },
      ),
    ).toThrow()
  })

  it('rounds each share once to 6-dp minor units (boundary)', () => {
    const r = computeDropDistribution(
      0.01,
      project,
      { id: 'd', dropSharePercent: 1 },
      { id: 's', seniorSharePercent: 33.333333 },
    )
    expect(r.seniorShare.amount).toBe(0.003333)
    expect(r.dropShare.amount).toBe(0.0001)
    const t = computeDropDistribution(
      1.005,
      project,
      { id: 'd', dropSharePercent: 0 },
      { id: 's', seniorSharePercent: 100 },
    )
    expect(t.seniorShare.amount).toBe(1.005)
  })
})

describe('computeDropAggregate', () => {
  const D = { id: 'drop-1', displayName: 'Drop One', dropSharePercent: 7 }
  type Row = {
    type: string
    status: string
    amount: string
    currency?: string
    senderId: string | null
    receiverId: string | null
  }
  const tx = (over: Partial<Row>): Row => ({
    type: 'PAYOUT_DROP',
    status: 'PAID',
    amount: '0',
    senderId: null,
    receiverId: null,
    ...over,
  })

  it('empty ledger -> zeros, identity fields, drop share percent', () => {
    expect(computeDropAggregate(D, [])).toEqual({
      userId: 'drop-1',
      displayName: 'Drop One',
      balance: 0,
      dropSharePercent: 7,
      pendingCount: 0,
      debtToCompany: 0,
      pendingObligationAmount: 0,
      pendingObligationCount: 0,
    })
  })

  it('null dropSharePercent falls back to default 5', () => {
    expect(computeDropAggregate({ ...D, dropSharePercent: null }, []).dropSharePercent).toBe(5)
  })

  it('balance = PAID PAYOUT_DROP received - sent; unpaid / other types / other drops ignored', () => {
    const rows = [
      tx({ amount: '100.50', receiverId: 'drop-1' }),
      tx({ amount: '20.25', senderId: 'drop-1' }),
      tx({ amount: '999', receiverId: 'drop-1', status: 'PENDING_PAYMENT' }),
      tx({ amount: '999', receiverId: 'drop-1', type: 'PAYOUT' }),
      tx({ amount: '999', senderId: 'drop-1', type: 'PAYOUT' }),
      tx({ amount: '999', receiverId: 'other' }),
      tx({ amount: '999', senderId: 'other' }),
    ]
    expect(computeDropAggregate(D, rows).balance).toBe(80.25)
  })

  it('balance can go negative and is float-drift free (0.1 + 0.2)', () => {
    expect(computeDropAggregate(D, [tx({ amount: '5', senderId: 'drop-1' })]).balance).toBe(-5)
    expect(
      computeDropAggregate(D, [
        tx({ amount: '0.1', receiverId: 'drop-1' }),
        tx({ amount: '0.2', receiverId: 'drop-1' }),
      ]).balance,
    ).toBe(0.3)
  })

  it('pendingCount counts DROP_INCOME to this drop in PENDING|VALIDATED only', () => {
    const inc = (status: string, receiverId = 'drop-1', type = 'DROP_INCOME') =>
      tx({ type, status, receiverId })
    const rows = [
      inc('PENDING'),
      inc('VALIDATED'),
      inc('PAID'),
      inc('REJECTED'),
      inc('PENDING', 'other'),
      inc('PENDING', 'drop-1', 'PAYOUT_DROP'),
    ]
    expect(computeDropAggregate(D, rows).pendingCount).toBe(2)
  })

  it('debtToCompany sums PAYOUT rows sent by drop in PENDING_PAYMENT only', () => {
    const rows = [
      tx({ type: 'PAYOUT', status: 'PENDING_PAYMENT', amount: '30.5', senderId: 'drop-1' }),
      tx({ type: 'PAYOUT', status: 'PENDING_PAYMENT', amount: '10', senderId: 'drop-1' }),
      tx({ type: 'PAYOUT', status: 'PAID', amount: '999', senderId: 'drop-1' }),
      tx({ type: 'PAYOUT', status: 'PENDING_PAYMENT', amount: '999', senderId: 'other' }),
      tx({ type: 'PAYOUT_DROP', status: 'PENDING_PAYMENT', amount: '999', senderId: 'drop-1' }),
    ]
    const a = computeDropAggregate(D, rows)
    expect(a.debtToCompany).toBe(40.5)
    expect(a.balance).toBe(0)
  })

  it('pending obligations: DROP_PENDING_PAYOUT received by drop in PENDING_PAYMENT; count + amount', () => {
    const o = (over: Partial<Row>) =>
      tx({ type: 'DROP_PENDING_PAYOUT', status: 'PENDING_PAYMENT', receiverId: 'drop-1', ...over })
    const rows = [
      o({ amount: '12.5' }),
      o({ amount: '7.5' }),
      o({ amount: '999', status: 'PAID' }),
      o({ amount: '999', receiverId: 'other' }),
      o({ amount: '999', type: 'PAYOUT_DROP' }),
    ]
    const a = computeDropAggregate(D, rows)
    expect(a.pendingObligationAmount).toBe(20)
    expect(a.pendingObligationCount).toBe(2)
    expect(a.balance).toBe(0)
  })

  it('without rates the amount is read as-is regardless of currency', () => {
    expect(
      computeDropAggregate(D, [tx({ amount: '10', currency: 'UAH', receiverId: 'drop-1' })])
        .balance,
    ).toBe(10)
  })

  it('with rates: UAH row converted to USD, USDT/absent currency identity', () => {
    const rates = { usdUah: '40', usdtUah: '40', eurUah: '44', date: '2026-01-01' }
    const a = computeDropAggregate(
      D,
      [
        tx({ amount: '400', currency: 'UAH', receiverId: 'drop-1' }),
        tx({ amount: '5', currency: 'USDT', receiverId: 'drop-1' }),
        tx({ amount: '2', receiverId: 'drop-1' }),
        tx({ amount: '44', currency: 'EUR', senderId: 'drop-1' }),
        tx({
          type: 'PAYOUT',
          status: 'PENDING_PAYMENT',
          amount: '80',
          currency: 'UAH',
          senderId: 'drop-1',
        }),
        tx({
          type: 'DROP_PENDING_PAYOUT',
          status: 'PENDING_PAYMENT',
          amount: '120',
          currency: 'UAH',
          receiverId: 'drop-1',
        }),
      ],
      rates,
    )
    // received 10 + 5 + 2 = 17 ; sent EUR 44 -> 44*44/40 = 48.4 ; balance = -31.4
    expect(a.balance).toBeCloseTo(-31.4, 6)
    expect(a.debtToCompany).toBe(2)
    expect(a.pendingObligationAmount).toBe(3)
  })
})
