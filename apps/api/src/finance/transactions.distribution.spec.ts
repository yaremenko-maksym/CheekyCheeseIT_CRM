/**
 * Drop role - phase 2 / task-drop-payout-company-account. Unit tests for the
 * distribution helper:
 *
 *   - `computeDropDistribution(income, project, drop, senior)` — drop-project
 *     math from spec §8.1: $1000, senior 26%, drop 5% → senior=260, drop=50.
 *     The remainder (income − senior − drop) is NOT split here anymore — it
 *     stays on the company account (the legacy 50/50 `partnerShares` /
 *     `computePartnersSplit` were removed with the payment-channel flow). Edge
 *     cases for 0/0, 50/50, >100% (BadRequest), and null defaults.
 *
 * The helper is pure (no DB writes, no side effects), so we instantiate the
 * service with stubs for the injected deps. Tests never reach those.
 */
import { BadRequestException } from '@nestjs/common'
import { describe, expect, it } from 'vitest'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

function makeService() {
  return makeTransactionsService({ db: {} as never })
}

const drop = { id: 'drop-1', dropSharePercent: 5 }
const senior = { id: 'sn-1', seniorSharePercent: 26 }
const project = { id: 'p-1', dropId: 'drop-1' }

describe('computeDropDistribution (spec §8.1 — no partner split)', () => {
  it('1000 income → senior 260, drop 50 (remainder 690 stays on company)', () => {
    const svc = makeService()
    const result = svc.computeDropDistribution(1000, project, drop, senior)

    expect(result.seniorShare.amount).toBeCloseTo(260, 6)
    expect(result.seniorShare.percent).toBe(26)
    expect(result.dropShare.amount).toBeCloseTo(50, 6)
    expect(result.dropShare.percent).toBe(5)
    // No partnerShares field anymore — the remainder is the company's.
    expect((result as { partnerShares?: unknown }).partnerShares).toBeUndefined()
    const companyRemainder = 1000 - result.seniorShare.amount - result.dropShare.amount
    expect(companyRemainder).toBeCloseTo(690, 6)
  })

  it('senior 50% + drop 50% → remainder=0 (nothing left for company)', () => {
    const svc = makeService()
    const result = svc.computeDropDistribution(
      1000,
      project,
      { ...drop, dropSharePercent: 50 },
      { ...senior, seniorSharePercent: 50 },
    )
    expect(result.seniorShare.amount).toBeCloseTo(500, 6)
    expect(result.dropShare.amount).toBeCloseTo(500, 6)
    expect(1000 - result.seniorShare.amount - result.dropShare.amount).toBeCloseTo(0, 6)
  })

  it('senior 0% + drop 0% → remainder=1000 (full income stays on company)', () => {
    const svc = makeService()
    const result = svc.computeDropDistribution(
      1000,
      project,
      { ...drop, dropSharePercent: 0 },
      { ...senior, seniorSharePercent: 0 },
    )
    expect(result.seniorShare.amount).toBe(0)
    expect(result.dropShare.amount).toBe(0)
    expect(1000 - result.seniorShare.amount - result.dropShare.amount).toBeCloseTo(1000, 6)
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
