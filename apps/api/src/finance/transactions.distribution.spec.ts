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

  // Audit 2026-06-27 (LOW #4): decimal-safe share math (SCALE=1e6 + Math.round +
  // toFixed(6)). Naive `(income * percent) / 100` accumulates IEEE-754 drift; the
  // rounded helper must emit values clean at the 6-decimal `numeric(18,6)`
  // precision the amount column stores — never a 0.30000000000000004-style tail.
  it('rounds shares to 6-decimal precision (no float drift) for awkward inputs', () => {
    const svc = makeService()
    // 1000.10 income at 26% / 5% → naive math gives 260.026 / 50.005 but with a
    // trailing binary tail; the SCALE math returns exact 6-decimal numbers.
    const result = svc.computeDropDistribution(
      1000.1,
      project,
      { ...drop, dropSharePercent: 5 },
      { ...senior, seniorSharePercent: 26 },
    )
    expect(result.seniorShare.amount).toBe(260.026)
    expect(result.dropShare.amount).toBe(50.005)
    // Each amount, re-stringified to 6 decimals, round-trips exactly (the value
    // the `String(amount)` insert persists has NO lossy tail).
    expect(Number(result.seniorShare.amount.toFixed(6))).toBe(result.seniorShare.amount)
    expect(Number(result.dropShare.amount.toFixed(6))).toBe(result.dropShare.amount)
  })

  it('classic 0.1+0.2 float case: 0.3 income at 100% senior → exactly 0.3', () => {
    const svc = makeService()
    // income 0.3 at senior 100% / drop 0%: naive `(0.3 * 100) / 100` is fine, but
    // an income that itself carries drift (0.1 + 0.2 = 0.30000000000000004) is
    // normalised by the scale-round so the persisted amount is exactly 0.3.
    const drifty = 0.1 + 0.2 // 0.30000000000000004
    const result = svc.computeDropDistribution(
      drifty,
      project,
      { ...drop, dropSharePercent: 0 },
      { ...senior, seniorSharePercent: 100 },
    )
    expect(result.seniorShare.amount).toBe(0.3)
    expect(result.dropShare.amount).toBe(0)
  })
})
