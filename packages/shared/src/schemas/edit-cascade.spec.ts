import { describe, it, expect } from 'vitest'
import { roundShareAmount } from '../utils/money'
import {
  amountsDiffer,
  computeCascadeVersion,
  resolveEditCascade,
  type CascadeDerivativeSnapshot,
  type CascadeSnapshot,
} from './edit-cascade'

// ---------------------------------------------------------------------------
// Fixture builders — every test starts from a MINIMAL, explicit snapshot so a
// failing assertion always points at the one field the test actually varies
// (task-cascade-resolver-preview AC6: "резолвер не мокать" applies equally to
// not hiding the real shape behind a magic global fixture).
// ---------------------------------------------------------------------------

function makeSource(overrides: Partial<CascadeSnapshot['source']> = {}): CascadeSnapshot['source'] {
  return {
    id: 'src-1',
    type: 'ADMIN_INCOME',
    status: 'PAID',
    amount: 1000,
    currency: 'USDT',
    payoutRequestId: null,
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }
}

function makePendingDerivative(
  overrides: Partial<CascadeDerivativeSnapshot> = {},
): CascadeDerivativeSnapshot {
  return {
    id: 'deriv-1',
    type: 'SENIOR_PENDING_PAYOUT',
    status: 'PENDING_PAYMENT',
    amount: 260,
    currency: 'USDT',
    updatedAt: '2026-08-01T00:00:00.000Z',
    sharePercent: 26,
    settledAmount: null,
    settledCurrency: null,
    settledSharePercent: null,
    hasSignedInvoice: false,
    obligation: {
      id: 'obl-1',
      status: 'PENDING',
      amount: 260,
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    ...overrides,
  }
}

function makePaidDerivative(
  overrides: Partial<CascadeDerivativeSnapshot> = {},
): CascadeDerivativeSnapshot {
  return {
    id: 'deriv-1',
    type: 'SENIOR_INCOME',
    status: 'PAID',
    amount: 260,
    currency: 'USDT',
    updatedAt: '2026-08-01T00:00:00.000Z',
    sharePercent: null, // nulled by settleByCompany's flip
    settledAmount: 260,
    settledCurrency: 'USDT',
    settledSharePercent: 26,
    hasSignedInvoice: false,
    obligation: {
      id: 'obl-1',
      status: 'PAID',
      amount: 260,
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
    ...overrides,
  }
}

function snapshot(
  sourceOverrides: Partial<CascadeSnapshot['source']>,
  derivatives: CascadeDerivativeSnapshot[],
): CascadeSnapshot {
  return { source: makeSource(sourceOverrides), derivatives }
}

describe('resolveEditCascade — AC1 purity', () => {
  it('is deterministic: identical input yields byte-for-byte identical output', () => {
    const s = snapshot({ amount: 1000 }, [makePendingDerivative()])
    const a = resolveEditCascade(s, { amount: 1500 })
    const b = resolveEditCascade(s, { amount: 1500 })
    expect(a).toEqual(b)
  })

  it('does not mutate its inputs', () => {
    const s = snapshot({ amount: 1000 }, [makePendingDerivative(), makePaidDerivative()])
    const frozen = JSON.parse(JSON.stringify(s)) as CascadeSnapshot
    resolveEditCascade(s, { amount: 1500 })
    expect(s).toEqual(frozen)
  })
})

describe('resolveEditCascade — AC6 case 8: дельта == 0 ⇒ нет каскада, не «нулевое обязательство»', () => {
  it('returns an empty derivatives list when the proposed amount equals the stored one', () => {
    const s = snapshot({ amount: 1000 }, [makePendingDerivative()])
    const plan = resolveEditCascade(s, { amount: 1000 })
    expect(plan.sourceAmountChanged).toBe(false)
    expect(plan.derivatives).toEqual([])
  })

  it('treats a sub-epsilon float difference as unchanged (same toFixed(6) rule as BIZ-18)', () => {
    const s = snapshot({ amount: 1000 }, [makePendingDerivative()])
    const plan = resolveEditCascade(s, { amount: 1000.0000001 })
    expect(plan.sourceAmountChanged).toBe(false)
  })
})

describe('resolveEditCascade — AC6 case 1: increase, derivative already PENDING', () => {
  it('computes a new pending amount directly — no reconfirm, settledAmount 0', () => {
    const s = snapshot({ amount: 1000 }, [makePendingDerivative({ sharePercent: 26 })])
    const plan = resolveEditCascade(s, { amount: 2000 })
    expect(plan.sourceAmountChanged).toBe(true)
    expect(plan.derivatives).toHaveLength(1)
    const d = plan.derivatives[0]!
    expect(d.newAmount).toBe(roundShareAmount(2000, 26))
    expect(d.settledAmount).toBe(0)
    expect(d.remainingToPay).toBe(d.newAmount)
    expect(d.needsReconfirm).toBe(false)
    expect(d.warnings).toEqual([])
  })
})

describe('resolveEditCascade — AC6 case 6: derivative PAID, increase ⇒ needsReconfirm', () => {
  it('flags needsReconfirm true when the recomputed share still exceeds what was settled', () => {
    const s = snapshot({ amount: 1000 }, [makePaidDerivative({ settledAmount: 260 })])
    const plan = resolveEditCascade(s, { amount: 2000 })
    const d = plan.derivatives[0]!
    expect(d.newAmount).toBe(roundShareAmount(2000, 26)) // 520
    expect(d.settledAmount).toBe(260)
    expect(d.remainingToPay).toBe(260)
    expect(d.needsReconfirm).toBe(true)
    expect(d.warnings).toEqual([])
  })
})

describe('resolveEditCascade — AC6 case 2: decrease WITHOUT overpayment', () => {
  it('still needs reconfirm when the new share is below old but above settled', () => {
    // old share (before edit) = 26% * 1000 = 260, settled = 100 (partial-looking
    // legacy data — settledAmount is always <= what was ever owed in practice,
    // this just exercises the arithmetic branch cleanly).
    const s = snapshot({ amount: 1000 }, [makePaidDerivative({ settledAmount: 100 })])
    const plan = resolveEditCascade(s, { amount: 500 }) // new share = 130
    const d = plan.derivatives[0]!
    expect(d.newAmount).toBe(roundShareAmount(500, 26))
    expect(d.newAmount).toBeGreaterThan(100)
    expect(d.remainingToPay).toBe(Number((d.newAmount! - 100).toFixed(6)))
    expect(d.needsReconfirm).toBe(true)
    expect(d.warnings.some((w) => w.code === 'OVERPAYMENT')).toBe(false)
  })
})

describe('resolveEditCascade — AC6 case 3: decrease WITH overpayment', () => {
  it('does NOT mark the row for return to PENDING; warns instead with both sums', () => {
    const s = snapshot({ amount: 1000 }, [makePaidDerivative({ settledAmount: 260 })])
    const plan = resolveEditCascade(s, { amount: 100 }) // new share = 26
    const d = plan.derivatives[0]!
    expect(d.newAmount).toBe(roundShareAmount(100, 26))
    expect(d.newAmount).toBeLessThan(260)
    expect(d.needsReconfirm).toBe(false)
    expect(d.remainingToPay).toBe(0)
    expect(d.warnings).toEqual([
      {
        code: 'OVERPAYMENT',
        message: expect.stringContaining('260'),
      },
    ])
  })

  it('an exact match (newAmount === settledAmount) is NOT an overpayment', () => {
    // Settle the obligation for EXACTLY what the recomputed share will be —
    // constructed from the same formula under test so the equality is
    // guaranteed, not hoped for via a hand-picked amount.
    const newAmount = roundShareAmount(2000, 26)
    const s = snapshot({ amount: 1000 }, [makePaidDerivative({ settledAmount: newAmount })])
    const plan = resolveEditCascade(s, { amount: 2000 })
    const d = plan.derivatives[0]!
    expect(d.newAmount).toBe(newAmount)
    expect(d.needsReconfirm).toBe(false)
    expect(d.remainingToPay).toBe(0)
    expect(d.warnings.some((w) => w.code === 'OVERPAYMENT')).toBe(false)
  })
})

describe('resolveEditCascade — AC6 case 4: no share snapshot ⇒ refuse, not guess', () => {
  it('PENDING derivative with sharePercent=null', () => {
    const s = snapshot({ amount: 1000 }, [makePendingDerivative({ sharePercent: null })])
    const plan = resolveEditCascade(s, { amount: 2000 })
    const d = plan.derivatives[0]!
    expect(d.newAmount).toBeNull()
    expect(d.sharePercent).toBeNull()
    expect(d.remainingToPay).toBeNull()
    expect(d.needsReconfirm).toBe(false)
    expect(d.warnings).toEqual([{ code: 'NO_SHARE_SNAPSHOT', message: expect.any(String) }])
  })

  it('PAID derivative with settledSharePercent=null (legacy flip, pre-task-1 row)', () => {
    const s = snapshot({ amount: 1000 }, [makePaidDerivative({ settledSharePercent: null })])
    const plan = resolveEditCascade(s, { amount: 2000 })
    const d = plan.derivatives[0]!
    expect(d.newAmount).toBeNull()
    expect(d.needsReconfirm).toBe(false)
    expect(d.warnings.map((w) => w.code)).toEqual(['NO_SHARE_SNAPSHOT'])
  })
})

describe('resolveEditCascade — AC6 case 5: derivative already PENDING (обязательство ещё не закрыто)', () => {
  it('never sets needsReconfirm, regardless of increase or decrease', () => {
    const inc = resolveEditCascade(snapshot({ amount: 1000 }, [makePendingDerivative()]), {
      amount: 5000,
    })
    const dec = resolveEditCascade(snapshot({ amount: 1000 }, [makePendingDerivative()]), {
      amount: 10,
    })
    expect(inc.derivatives[0]!.needsReconfirm).toBe(false)
    expect(dec.derivatives[0]!.needsReconfirm).toBe(false)
  })
})

describe('resolveEditCascade — AC6 case 7: валюта расчёта не USDT', () => {
  it('warns when the settled currency is not USDT — sums are not directly comparable', () => {
    const s = snapshot({ amount: 1000 }, [
      makePaidDerivative({ settledCurrency: 'UAH', settledAmount: 9000 }),
    ])
    const plan = resolveEditCascade(s, { amount: 2000 })
    const d = plan.derivatives[0]!
    expect(d.warnings.some((w) => w.code === 'NON_USDT_CURRENCY')).toBe(true)
  })

  it('does not warn for the default USDT settlement', () => {
    const s = snapshot({ amount: 1000 }, [makePaidDerivative({ settledCurrency: 'USDT' })])
    const plan = resolveEditCascade(s, { amount: 2000 })
    expect(plan.derivatives[0]!.warnings.some((w) => w.code === 'NON_USDT_CURRENCY')).toBe(false)
  })
})

describe('resolveEditCascade — signed-invoice warning (AC4 warning list)', () => {
  it('warns when the derivative already carries a counterparty signature', () => {
    const s = snapshot({ amount: 1000 }, [makePaidDerivative({ hasSignedInvoice: true })])
    const plan = resolveEditCascade(s, { amount: 2000 })
    expect(plan.derivatives[0]!.warnings.some((w) => w.code === 'SIGNED_INVOICE')).toBe(true)
  })
})

describe('resolveEditCascade — multiple derivatives (senior + drop from the same income)', () => {
  it('resolves each derivative independently, in the snapshot order', () => {
    const s = snapshot({ amount: 1000 }, [
      makePendingDerivative({ id: 'senior', sharePercent: 26 }),
      makePendingDerivative({ id: 'drop', type: 'DROP_PENDING_PAYOUT', sharePercent: 5 }),
    ])
    const plan = resolveEditCascade(s, { amount: 2000 })
    expect(plan.derivatives.map((d) => d.id)).toEqual(['senior', 'drop'])
    expect(plan.derivatives[0]!.newAmount).toBe(roundShareAmount(2000, 26))
    expect(plan.derivatives[1]!.newAmount).toBe(roundShareAmount(2000, 5))
  })
})

describe('amountsDiffer', () => {
  it('matches Number(x).toFixed(6) inequality, not a naive !==', () => {
    expect(amountsDiffer(1000, 1000.0000001)).toBe(false)
    expect(amountsDiffer(1000, 1000.000001)).toBe(true)
    expect(amountsDiffer(1000, 1000)).toBe(false)
  })
})

describe('computeCascadeVersion', () => {
  it('is order-independent over derivatives (sorted internally)', () => {
    const a = snapshot({ amount: 1000 }, [
      makePendingDerivative({ id: 'a' }),
      makePendingDerivative({ id: 'b' }),
    ])
    const b = snapshot({ amount: 1000 }, [
      makePendingDerivative({ id: 'b' }),
      makePendingDerivative({ id: 'a' }),
    ])
    expect(computeCascadeVersion(a)).toBe(computeCascadeVersion(b))
  })

  it('changes when any updatedAt changes', () => {
    const base = snapshot({ amount: 1000 }, [makePendingDerivative()])
    const touched = snapshot({ amount: 1000 }, [
      makePendingDerivative({ updatedAt: '2026-08-02T00:00:00.000Z' }),
    ])
    expect(computeCascadeVersion(base)).not.toBe(computeCascadeVersion(touched))
  })

  it('changes when the source updatedAt changes', () => {
    const base = snapshot({ amount: 1000, updatedAt: '2026-08-01T00:00:00.000Z' }, [])
    const touched = snapshot({ amount: 1000, updatedAt: '2026-08-02T00:00:00.000Z' }, [])
    expect(computeCascadeVersion(base)).not.toBe(computeCascadeVersion(touched))
  })
})

// ---------------------------------------------------------------------------
// AC7 — property test. No fast-check in this repo's dependency graph (task
// file: no new deps without explicit sign-off) — a seeded PRNG loop over many
// random combinations gives the same guarantee (deterministic, reproducible
// on failure via the printed seed) without adding one.
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('resolveEditCascade — AC7 property test', () => {
  const SEED = 20260822
  const rand = mulberry32(SEED)
  const ITERATIONS = 500

  it(`holds invariants across ${ITERATIONS} random (income, percent, settled, delta-sign) combinations (seed ${SEED})`, () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const income = 1 + rand() * 100_000
      const newIncome = 1 + rand() * 100_000
      const percent = Math.floor(rand() * 101) // 0..100
      const isSettled = rand() < 0.5
      // settledAmount is bounded loosely — the resolver must not assume it
      // never exceeds the theoretical old share; overpayment is exactly the
      // case where it does.
      const settledAmount = isSettled ? rand() * 150_000 : 0

      const deriv: CascadeDerivativeSnapshot = isSettled
        ? makePaidDerivative({ settledAmount, settledSharePercent: percent, sharePercent: null })
        : makePendingDerivative({ sharePercent: percent, settledAmount: null })

      const s = snapshot({ amount: income }, [deriv])
      const plan = resolveEditCascade(s, { amount: newIncome })

      if (!plan.sourceAmountChanged) continue // delta==0 path — covered separately
      const d = plan.derivatives[0]!
      expect(d.newAmount).toBe(roundShareAmount(newIncome, percent))

      // Invariant 1: remainingToPay = max(0, newAmount - settledAmount).
      const expectedRemaining = Math.max(0, Number((d.newAmount! - d.settledAmount).toFixed(6)))
      expect(d.remainingToPay).toBe(expectedRemaining)

      // Invariant 2: the accumulator the plan REPORTS is exactly what the
      // snapshot carried — the resolver never derives or adjusts it (only
      // `settleByCompany`, outside this pure function, is allowed to
      // increment it).
      expect(d.settledAmount).toBe(settledAmount)

      // Invariant 3: sign of (newAmount - settledAmount) agrees with
      // needsReconfirm for a settled row, and needsReconfirm is always false
      // for a not-yet-settled one. Expected values computed via boolean
      // expressions (not an if/else around `expect`) so every iteration
      // exercises the same unconditional assertions.
      const expectedNeedsReconfirm = isSettled && d.newAmount! > settledAmount
      const expectedOverpaymentWarning = isSettled && d.newAmount! < settledAmount
      expect(d.needsReconfirm).toBe(expectedNeedsReconfirm)
      expect(d.warnings.some((w) => w.code === 'OVERPAYMENT')).toBe(expectedOverpaymentWarning)
    }
  })
})
