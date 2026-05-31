/**
 * Drop role - phase 2. Unit tests for the distribution helpers extracted in
 * AC1/AC2:
 *
 *   - `computePartnersSplit(payable)` — regression for the pre-phase-2 50/50
 *     loop in `payPayoutRequest`. Senior-projects must produce byte-for-byte
 *     the same {MAKSYM_ID:half, KOSTYA_ID:half} pair.
 *   - `computeDropDistribution(income, project, drop, senior)` — the new
 *     drop-project math from spec §8.1: $1000, senior 26%, drop 5% →
 *     senior=260, drop=50, partners=[345, 345]. Edge cases for 0/0, 50/50,
 *     and >100% (BadRequest).
 *
 * The helpers are pure (no DB writes, no side effects), so we instantiate
 * the service with stubs for the injected `DatabaseService` and
 * `InvoicesService`. Tests never reach those.
 */
import { BadRequestException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { MAKSYM_ID, KOSTYA_ID } from '@crm/shared'
import { TransactionsService } from './transactions.service'

function makeService(): TransactionsService {
  const db = {} as never
  const invoicesService = {} as never
  return new TransactionsService(db, invoicesService)
}

const drop = { id: 'drop-1', dropSharePercent: 5 }
const senior = { id: 'sn-1', seniorSharePercent: 26 }
const project = { id: 'p-1', dropId: 'drop-1' }

describe('computePartnersSplit (AC1 regression)', () => {
  it('splits payable 50/50 in MAKSYM, KOSTYA order', () => {
    const svc = makeService()
    const result = svc.computePartnersSplit(1000)
    expect(result).toEqual([
      { adminId: MAKSYM_ID, amount: 500 },
      { adminId: KOSTYA_ID, amount: 500 },
    ])
  })

  it('handles 0 payable as [0, 0]', () => {
    const svc = makeService()
    expect(svc.computePartnersSplit(0)).toEqual([
      { adminId: MAKSYM_ID, amount: 0 },
      { adminId: KOSTYA_ID, amount: 0 },
    ])
  })

  it('handles fractional payable without rounding bias', () => {
    const svc = makeService()
    const result = svc.computePartnersSplit(123.45)
    expect(result[0]!.amount).toBeCloseTo(61.725, 6)
    expect(result[1]!.amount).toBeCloseTo(61.725, 6)
  })
})

describe('computeDropDistribution (AC2 — spec §8.1)', () => {
  it('1000 income → senior 260, drop 50, partners 345/345', () => {
    const svc = makeService()
    const result = svc.computeDropDistribution(1000, project, drop, senior)

    expect(result.seniorShare.amount).toBeCloseTo(260, 6)
    expect(result.seniorShare.percent).toBe(26)
    expect(result.dropShare.amount).toBeCloseTo(50, 6)
    expect(result.dropShare.percent).toBe(5)
    expect(result.partnerShares).toHaveLength(2)
    expect(result.partnerShares[0]!.adminId).toBe(MAKSYM_ID)
    expect(result.partnerShares[0]!.amount).toBeCloseTo(345, 6)
    expect(result.partnerShares[1]!.adminId).toBe(KOSTYA_ID)
    expect(result.partnerShares[1]!.amount).toBeCloseTo(345, 6)
  })

  it('senior 50% + drop 50% → remainder=0, partners=[0, 0]', () => {
    const svc = makeService()
    const result = svc.computeDropDistribution(
      1000,
      project,
      { ...drop, dropSharePercent: 50 },
      { ...senior, seniorSharePercent: 50 },
    )
    expect(result.seniorShare.amount).toBeCloseTo(500, 6)
    expect(result.dropShare.amount).toBeCloseTo(500, 6)
    expect(result.partnerShares.map((p) => p.amount)).toEqual([0, 0])
  })

  it('senior 0% + drop 0% → partners 500/500', () => {
    const svc = makeService()
    const result = svc.computeDropDistribution(
      1000,
      project,
      { ...drop, dropSharePercent: 0 },
      { ...senior, seniorSharePercent: 0 },
    )
    expect(result.seniorShare.amount).toBe(0)
    expect(result.dropShare.amount).toBe(0)
    expect(result.partnerShares).toEqual([
      { adminId: MAKSYM_ID, amount: 500 },
      { adminId: KOSTYA_ID, amount: 500 },
    ])
  })

  it('senior 60% + drop 50% → BadRequest', () => {
    const svc = makeService()
    expect(() =>
      svc.computeDropDistribution(
        1000,
        project,
        { ...drop, dropSharePercent: 50 },
        { ...senior, seniorSharePercent: 60 },
      ),
    ).toThrow(BadRequestException)
  })

  it('uses defaults when share percents are null', () => {
    const svc = makeService()
    const result = svc.computeDropDistribution(
      1000,
      project,
      { id: 'drop-1', dropSharePercent: null },
      { id: 'sn-1', seniorSharePercent: null },
    )
    // Defaults: senior 26, drop 5 → same as spec example.
    expect(result.seniorShare.amount).toBeCloseTo(260, 6)
    expect(result.seniorShare.percent).toBe(26)
    expect(result.dropShare.amount).toBeCloseTo(50, 6)
    expect(result.dropShare.percent).toBe(5)
  })
})
