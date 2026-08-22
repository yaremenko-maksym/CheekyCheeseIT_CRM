import { describe, it, expect } from 'vitest'
import { roundShareAmount } from '../utils/money'
import { MAX_TRANSACTION_AMOUNT } from './finance'
import {
  amountsDiffer,
  computeCascadeVersion,
  resolveEditCascade,
  cascadeWarningCodeSchema,
  cascadePlanSchema,
  cascadeEditPreviewQuerySchema,
  cascadeEditPreviewBlockedReasonSchema,
  cascadeEditPreviewResponseSchema,
  type CascadeDerivativeSnapshot,
  type CascadeSnapshot,
  type CascadeWarning,
  type CascadeDerivativePlan,
  type CascadePlan,
  type CascadeEditPreviewResponse,
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
    hasSignedInvoice: false,
    originalAmount: null,
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
    // Exact message content pinned (not `expect.any(String)`) — a mutant that
    // blanks the literal string in the source is otherwise invisible here.
    expect(d.warnings).toEqual([
      {
        code: 'NO_SHARE_SNAPSHOT',
        message:
          'Нет снимка процента доли на этой строке — пересчитать невозможно, требуется ручное решение',
      },
    ])
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

describe('resolveEditCascade — defensive `obligation: null` (schema comment: "nullable defensively")', () => {
  it('treats a missing obligation as NOT settled — reads sharePercent/amount off the derivative row itself', () => {
    const s = snapshot({ amount: 1000 }, [
      makePendingDerivative({ sharePercent: 26, amount: 999, obligation: null }),
    ])
    const plan = resolveEditCascade(s, { amount: 2000 })
    const d = plan.derivatives[0]!
    // oldAmount falls back to the derivative's OWN amount, not obligation.amount
    // (there is no obligation to read it from) — pins the `?? derivative.amount`
    // fallback, not just "does not throw".
    expect(d.oldAmount).toBe(999)
    expect(d.newAmount).toBe(roundShareAmount(2000, 26))
    expect(d.needsReconfirm).toBe(false)
    expect(d.settledAmount).toBe(0)
  })

  it('an obligation.amount of exactly 0 is NOT treated as "no obligation" (?? not ||)', () => {
    const s = snapshot({ amount: 1000 }, [
      makePaidDerivative({
        amount: 500,
        obligation: {
          id: 'obl-1',
          status: 'PAID',
          amount: 0,
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      }),
    ])
    const plan = resolveEditCascade(s, { amount: 2000 })
    // A `||` fallback would read the truthy `derivative.amount` (500) instead —
    // `??` must keep the real, falsy 0 from the obligation row.
    expect(plan.derivatives[0]!.oldAmount).toBe(0)
  })
})

describe('resolveEditCascade — AC6 case 7: валюта расчёта не USDT', () => {
  it('warns when the settled currency is not USDT — sums are not directly comparable', () => {
    const s = snapshot({ amount: 1000 }, [
      makePaidDerivative({ settledCurrency: 'UAH', settledAmount: 9000 }),
    ])
    const plan = resolveEditCascade(s, { amount: 2000 })
    const d = plan.derivatives[0]!
    expect(d.warnings).toContainEqual({
      code: 'NON_USDT_CURRENCY',
      message:
        'Выплата по этой строке учтена в UAH, а не в USDT — «уже выплачено» и «новая доля» не в одной валюте',
    })
  })

  it('does not warn for the default USDT settlement', () => {
    const s = snapshot({ amount: 1000 }, [makePaidDerivative({ settledCurrency: 'USDT' })])
    const plan = resolveEditCascade(s, { amount: 2000 })
    expect(plan.derivatives[0]!.warnings.some((w) => w.code === 'NON_USDT_CURRENCY')).toBe(false)
  })

  it('does not warn when settled but settledCurrency is null (pins the `&&` chain, not just `isSettled`)', () => {
    const s = snapshot({ amount: 1000 }, [makePaidDerivative({ settledCurrency: null })])
    const plan = resolveEditCascade(s, { amount: 2000 })
    expect(plan.derivatives[0]!.warnings.some((w) => w.code === 'NON_USDT_CURRENCY')).toBe(false)
  })

  it('does not warn on a PENDING derivative whose settledCurrency is set but settledAmount is still null/0', () => {
    // Not a shape that ever occurs for real (settle is what sets both together),
    // but the mismatch guard is `settledAmount > 0 && settledCurrency !== null
    // && settledCurrency !== 'USDT'` (HIGH-1/HIGH-2 fix — no longer gated on
    // `isSettled`), and `makePendingDerivative`'s default `settledAmount: null`
    // must still keep it from firing — pins the leading `settledAmount > 0` operand.
    const s = snapshot({ amount: 1000 }, [makePendingDerivative({ settledCurrency: 'UAH' })])
    const plan = resolveEditCascade(s, { amount: 2000 })
    expect(plan.derivatives[0]!.warnings.some((w) => w.code === 'NON_USDT_CURRENCY')).toBe(false)
  })
})

describe('resolveEditCascade — HIGH-1 (security-review round 1): settled_amount is monotonic, never gated by the CURRENT obligation status', () => {
  it('a derivative sitting PENDING with a nonzero settled_amount accumulator (post-cascade-revert shape, AC3 "Механика возврата") reports the REAL accumulator, not zero', () => {
    // Before the fix, `settledAmount` was `isSettled ? (derivative.settledAmount
    // ?? 0) : 0` — for a PENDING obligation this collapsed to 0 regardless of
    // what `transactions.settled_amount` actually held. AC3's revert mechanic
    // (task 3) is EXACTLY this shape: obligation flips back to PENDING, the live
    // sharePercent snapshot is restored, but `settled_amount` (monotonic) stays.
    const s = snapshot({ amount: 1000 }, [
      makePendingDerivative({ sharePercent: 26, settledAmount: 100, settledCurrency: 'USDT' }),
    ])
    const plan = resolveEditCascade(s, { amount: 2000 }) // new share = 520
    const d = plan.derivatives[0]!
    expect(d.newAmount).toBe(roundShareAmount(2000, 26))
    // The bug this pins: the old code would report 0 here.
    expect(d.settledAmount).toBe(100)
    expect(d.remainingToPay).toBe(Number((d.newAmount! - 100).toFixed(6)))
  })

  it('the same PENDING + already-partially-paid shape, decreased below the accumulator, still reads the REAL remainingToPay of 0 — not the phantom "nothing paid yet" that a gated read would produce', () => {
    const s = snapshot({ amount: 1000 }, [
      makePendingDerivative({ sharePercent: 26, settledAmount: 260, settledCurrency: 'USDT' }),
    ])
    const plan = resolveEditCascade(s, { amount: 100 }) // new share = 26 < settled 260
    const d = plan.derivatives[0]!
    expect(d.settledAmount).toBe(260)
    // A gated read (old code) would have said settledAmount=0, remainingToPay=26
    // — presenting the FULL new share for (re-)payment on money already paid.
    expect(d.remainingToPay).toBe(0)
  })
})

describe('resolveEditCascade — HIGH-2 (security-review round 1): a cross-currency settled_amount is never subtracted from the USDT newAmount', () => {
  it('remainingToPay is null (not a fabricated difference) when settledCurrency is not USDT', () => {
    const s = snapshot({ amount: 1000 }, [
      makePaidDerivative({ settledCurrency: 'UAH', settledAmount: 9000 }),
    ])
    const plan = resolveEditCascade(s, { amount: 2000 }) // newAmount = 520 USDT
    const d = plan.derivatives[0]!
    expect(d.newAmount).toBe(520)
    expect(d.settledAmount).toBe(9000)
    expect(d.settledCurrency).toBe('UAH')
    // The bug this pins: `max(0, 520 - 9000)` used to silently yield 0 here,
    // reading as "fully paid" instead of "we cannot tell".
    expect(d.remainingToPay).toBeNull()
  })

  it('does NOT claim OVERPAYMENT purely because the non-USDT figure is numerically larger than the USDT share', () => {
    // 9000 UAH >> 520 USDT numerically — a naive cross-currency subtraction
    // would call this an overpayment. It is not comparable at all.
    const s = snapshot({ amount: 1000 }, [
      makePaidDerivative({ settledCurrency: 'UAH', settledAmount: 9000 }),
    ])
    const plan = resolveEditCascade(s, { amount: 2000 })
    expect(plan.derivatives[0]!.warnings.filter((w) => w.code === 'OVERPAYMENT')).toEqual([])
    expect(plan.derivatives[0]!.warnings.some((w) => w.code === 'NON_USDT_CURRENCY')).toBe(true)
  })

  it('needsReconfirm on a currency-mismatched SETTLED row reflects that the row IS settled — never the broken subtraction', () => {
    const s = snapshot({ amount: 1000 }, [
      makePaidDerivative({ settledCurrency: 'UAH', settledAmount: 9000 }),
    ])
    const plan = resolveEditCascade(s, { amount: 2000 })
    // isSettled=true, mismatch=true → true purely from status, not from
    // "520 > 9000" (which is false and, being cross-currency, meaningless).
    expect(plan.derivatives[0]!.needsReconfirm).toBe(true)
  })

  it('HIGH-1 + HIGH-2 combined: a PENDING derivative with a nonzero CROSS-CURRENCY accumulator also refuses to compare', () => {
    const s = snapshot({ amount: 1000 }, [
      makePendingDerivative({ sharePercent: 26, settledAmount: 2000, settledCurrency: 'UAH' }),
    ])
    const plan = resolveEditCascade(s, { amount: 2000 }) // newAmount = 520 USDT
    const d = plan.derivatives[0]!
    expect(d.settledAmount).toBe(2000)
    expect(d.remainingToPay).toBeNull()
    expect(d.warnings.some((w) => w.code === 'NON_USDT_CURRENCY')).toBe(true)
    // The obligation is currently PENDING (not settled) — needsReconfirm stays
    // false regardless of the currency mismatch.
    expect(d.needsReconfirm).toBe(false)
  })
})

describe('resolveEditCascade — MED-1 (security-review round 1): warnings about the SOURCE row itself', () => {
  it('flags SOURCE_ORIGINAL_AMOUNT_SET when the row being edited already carries a fact-of-payment originalAmount', () => {
    const s = snapshot({ originalAmount: 800 }, [])
    const plan = resolveEditCascade(s, { amount: 2000 })
    expect(plan.sourceWarnings).toEqual([
      { code: 'SOURCE_ORIGINAL_AMOUNT_SET', message: expect.stringContaining('800') },
    ])
  })

  it('flags SOURCE_SIGNED_INVOICE when the row being edited already carries a counterparty-signed invoice', () => {
    const s = snapshot({ hasSignedInvoice: true }, [])
    const plan = resolveEditCascade(s, { amount: 2000 })
    // Exact message content pinned (not `expect.any(String)`) — a mutant
    // that blanks the literal string in the source is otherwise invisible
    // here (mutation-gate finding, round 2).
    expect(plan.sourceWarnings).toEqual([
      {
        code: 'SOURCE_SIGNED_INVOICE',
        message:
          'По этой строке уже есть инвойс, подписанный контрагентом — правка суммы не отразится в подписанном документе',
      },
    ])
  })

  it('is present even when the proposed amount equals the stored one — a static fact about the row, not about the edit', () => {
    const s = snapshot({ amount: 1000, hasSignedInvoice: true }, [])
    const plan = resolveEditCascade(s, { amount: 1000 })
    expect(plan.sourceAmountChanged).toBe(false)
    expect(plan.sourceWarnings.some((w) => w.code === 'SOURCE_SIGNED_INVOICE')).toBe(true)
  })

  it('is empty by default (default fixture has neither flag set)', () => {
    const s = snapshot({}, [])
    const plan = resolveEditCascade(s, { amount: 2000 })
    expect(plan.sourceWarnings).toEqual([])
  })
})

describe('resolveEditCascade — signed-invoice warning (AC4 warning list)', () => {
  it('warns when the derivative already carries a counterparty signature', () => {
    const s = snapshot({ amount: 1000 }, [makePaidDerivative({ hasSignedInvoice: true })])
    const plan = resolveEditCascade(s, { amount: 2000 })
    expect(plan.derivatives[0]!.warnings).toContainEqual({
      code: 'SIGNED_INVOICE',
      message:
        'По этой строке инвойс уже подписан контрагентом — правка не отразится в подписанном документе',
    })
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

  // Pins the EXACT `src:<id>:<ts>|<derivId>:<derivTs>:<oblId>:<oblTs>` format —
  // an inequality-only assertion (above) cannot tell a blanked `:`/`|`
  // separator apart from a real one, since the joined string still differs
  // by SOME character whenever content changes.
  it('produces the exact "src:id:ts|derivId:derivTs:oblId:oblTs" format', () => {
    const s = snapshot({ id: 'src-9', amount: 1000, updatedAt: 'T1' }, [
      makePendingDerivative({
        id: 'd9',
        updatedAt: 'T2',
        obligation: { id: 'o9', status: 'PENDING', amount: 1, updatedAt: 'T3' },
      }),
    ])
    expect(computeCascadeVersion(s)).toBe('src:src-9:T1|d9:T2:o9:T3')
  })

  it('uses a literal "-" placeholder when a derivative has no obligation', () => {
    const s = snapshot({ id: 'src-9', amount: 1000, updatedAt: 'T1' }, [
      makePendingDerivative({ id: 'd9', updatedAt: 'T2', obligation: null }),
    ])
    expect(computeCascadeVersion(s)).toBe('src:src-9:T1|d9:T2:-')
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
  const SETTLED_CURRENCIES = ['USDT', 'UAH', 'EUR', 'USD'] as const

  it(`holds invariants across ${ITERATIONS} random (income, percent, obligation status, settled_amount, settled_currency) combinations (seed ${SEED})`, () => {
    // Coverage counters — HIGH-1 (security-review round 1): the ORIGINAL
    // generator derived `settledAmount` FROM `isSettled` (`isSettled ? rand()
    // * 150_000 : 0`), so "obligation PENDING + settled_amount > 0" — the
    // EXACT post-cascade-revert shape (AC3 "Механика возврата") the bug lived
    // in — could never be generated, and the property test proved nothing
    // about it. Both dimensions below are now generated INDEPENDENTLY, and
    // the counts are asserted > 0 after the loop so this test cannot silently
    // regress back to a generator that never exercises the disputed case.
    let pendingWithSettledHistory = 0
    let crossCurrencyMismatchCases = 0

    for (let i = 0; i < ITERATIONS; i++) {
      const income = 1 + rand() * 100_000
      const newIncome = 1 + rand() * 100_000
      const percent = Math.floor(rand() * 101) // 0..100
      const obligationStatus: 'PENDING' | 'PAID' = rand() < 0.5 ? 'PAID' : 'PENDING'
      const isSettled = obligationStatus === 'PAID'

      // Independent of `obligationStatus` — a monotonic accumulator (task 1,
      // PR #599) that a PENDING row can still carry after a settle+revert
      // cycle.
      const hasSettledHistory = rand() < 0.6
      const settledAmount = hasSettledHistory ? rand() * 150_000 : 0
      const settledCurrency = hasSettledHistory
        ? SETTLED_CURRENCIES[Math.floor(rand() * SETTLED_CURRENCIES.length)]!
        : null

      const deriv: CascadeDerivativeSnapshot = {
        id: 'deriv-1',
        type: isSettled ? 'SENIOR_INCOME' : 'SENIOR_PENDING_PAYOUT',
        status: isSettled ? 'PAID' : 'PENDING_PAYMENT',
        amount: 1,
        currency: 'USDT',
        updatedAt: '2026-08-01T00:00:00.000Z',
        // Mirrors resolveDerivative's own `isSettled ? settledSharePercent :
        // sharePercent` selection — settle nulls the live column, a revert
        // (AC3 point 3) restores it.
        sharePercent: isSettled ? null : percent,
        settledAmount: hasSettledHistory ? settledAmount : null,
        settledCurrency,
        settledSharePercent: isSettled
          ? percent
          : hasSettledHistory
            ? Math.floor(rand() * 101)
            : null,
        hasSignedInvoice: false,
        obligation: {
          id: 'obl-1',
          status: obligationStatus,
          amount: 1,
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      }

      if (obligationStatus === 'PENDING' && settledAmount > 0) pendingWithSettledHistory++

      const s = snapshot({ amount: income }, [deriv])
      const plan = resolveEditCascade(s, { amount: newIncome })

      if (!plan.sourceAmountChanged) continue // delta==0 path — covered separately
      const d = plan.derivatives[0]!
      expect(d.newAmount).toBe(roundShareAmount(newIncome, percent))

      // Invariant 1 (HIGH-1): the accumulator the plan REPORTS is exactly
      // what the snapshot carried — UNCONDITIONALLY, never gated by the
      // CURRENT obligation status.
      expect(d.settledAmount).toBe(settledAmount)
      expect(d.settledCurrency).toBe(settledCurrency)

      const currencyMismatch =
        settledAmount > 0 && settledCurrency !== null && settledCurrency !== 'USDT'
      if (currencyMismatch) crossCurrencyMismatchCases++

      // Invariant 2 (HIGH-2): remainingToPay is the plain subtraction ONLY
      // when the two figures share a currency; a cross-currency accumulator
      // yields `null`, never a fabricated number.
      const expectedRemaining = currencyMismatch
        ? null
        : Math.max(0, Number((d.newAmount! - settledAmount).toFixed(6)))
      expect(d.remainingToPay).toBe(expectedRemaining)

      // Invariant 3: needsReconfirm/OVERPAYMENT are never derived from a
      // cross-currency comparison. Under a mismatch, needsReconfirm collapses
      // to the pure status question (isSettled) and OVERPAYMENT never fires
      // (HIGH-2) — expected values computed via boolean expressions (not an
      // if/else around `expect`) so every iteration exercises the same
      // unconditional assertions.
      const expectedNeedsReconfirm = currencyMismatch
        ? isSettled
        : isSettled && d.newAmount! > settledAmount
      const expectedOverpaymentWarning =
        !currencyMismatch && isSettled && d.newAmount! < settledAmount
      expect(d.needsReconfirm).toBe(expectedNeedsReconfirm)
      expect(d.warnings.some((w) => w.code === 'OVERPAYMENT')).toBe(expectedOverpaymentWarning)
      expect(d.warnings.some((w) => w.code === 'NON_USDT_CURRENCY')).toBe(currencyMismatch)
    }

    // The disputed combinations MUST actually occur across the run, or every
    // assertion above passed vacuously on them — same failure mode as the
    // property test the review found (an invariant "proven" only where it
    // cannot break).
    expect(pendingWithSettledHistory).toBeGreaterThan(0)
    expect(crossCurrencyMismatchCases).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Zod wire-contract schemas — everything below `resolveEditCascade` in
// edit-cascade.ts crosses the wire (`GET /edit-preview`'s query + response),
// so it is worth pinning through `.parse()` directly, not just via TypeScript
// inference. `z.object({...})` gutted to `z.object({})` still "typechecks"
// against these tests' plain object literals AND `.parse()` does not throw on
// unrecognised extra keys by default — it silently STRIPS them. Every
// assertion below therefore checks the PARSED RESULT's fields, not merely
// that parsing succeeded, so a gutted schema is caught by a missing field,
// not by a thrown error.
// ---------------------------------------------------------------------------

describe('cascadeWarningCodeSchema — wire contract', () => {
  it('accepts exactly the six defined codes, unchanged', () => {
    const codes = [
      'NO_SHARE_SNAPSHOT',
      'SIGNED_INVOICE',
      'OVERPAYMENT',
      'NON_USDT_CURRENCY',
      'SOURCE_SIGNED_INVOICE',
      'SOURCE_ORIGINAL_AMOUNT_SET',
    ] as const
    for (const code of codes) {
      expect(cascadeWarningCodeSchema.parse(code)).toBe(code)
    }
  })

  it('rejects a code outside the defined set', () => {
    expect(() => cascadeWarningCodeSchema.parse('BOGUS')).toThrow()
  })
})

describe('cascadePlanSchema — full round-trip (also covers nested cascadeDerivativePlanSchema/cascadeWarningSchema)', () => {
  it('parses a full plan and retains every field at every nesting level', () => {
    const warning: CascadeWarning = { code: 'OVERPAYMENT', message: 'уже выплачено 260' }
    const sourceWarning: CascadeWarning = {
      code: 'SOURCE_ORIGINAL_AMOUNT_SET',
      message: 'фактический платёж уже зафиксирован',
    }
    const derivativePlan: CascadeDerivativePlan = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'SENIOR_PENDING_PAYOUT',
      oldAmount: 260,
      newAmount: 520,
      sharePercent: 26,
      settledAmount: 260,
      settledCurrency: 'USDT',
      remainingToPay: 260,
      needsReconfirm: false,
      warnings: [warning],
    }
    const plan: CascadePlan = {
      sourceId: '22222222-2222-4222-8222-222222222222',
      sourceAmountChanged: true,
      oldSourceAmount: 1000,
      newSourceAmount: 2000,
      derivatives: [derivativePlan],
      sourceWarnings: [sourceWarning],
    }
    // A gutted schema anywhere in the chain (plan / derivative / warning)
    // strips the fields it owns — `toEqual` catches ANY of the three.
    expect(cascadePlanSchema.parse(plan)).toEqual(plan)
  })
})

describe('cascadeEditPreviewQuerySchema — wire contract', () => {
  it('coerces a string query param and retains it as a number', () => {
    expect(cascadeEditPreviewQuerySchema.parse({ amount: '100' })).toEqual({ amount: 100 })
  })

  it('rejects an amount above MAX_TRANSACTION_AMOUNT', () => {
    expect(() =>
      cascadeEditPreviewQuerySchema.parse({ amount: MAX_TRANSACTION_AMOUNT + 1 }),
    ).toThrow()
  })

  it('accepts an amount exactly AT MAX_TRANSACTION_AMOUNT', () => {
    expect(cascadeEditPreviewQuerySchema.parse({ amount: MAX_TRANSACTION_AMOUNT })).toEqual({
      amount: MAX_TRANSACTION_AMOUNT,
    })
  })

  it('rejects a value below the money floor (moneyFloorAndPrecisionError, superRefine branch)', () => {
    expect(() => cascadeEditPreviewQuerySchema.parse({ amount: 1e-7 })).toThrowError(/минимум/)
  })

  it('rejects more than 6 decimal places (moneyFloorAndPrecisionError, superRefine branch)', () => {
    expect(() => cascadeEditPreviewQuerySchema.parse({ amount: 100.1234567 })).toThrowError(
      /знаков после запятой/,
    )
  })

  it('the superRefine issue is raised with code "custom" (Zod does not itself enforce this — worth pinning)', () => {
    // Zod v4 accepts ANY string in `ctx.addIssue({ code })` at runtime (no
    // runtime validation of the discriminant, only a TS-level one) — a
    // mutant blanking the literal `'custom'` to `''` still throws with the
    // SAME message text, so a message-only assertion cannot see it. Reading
    // the raw issue back is the only way to pin this specific field.
    const result = cascadeEditPreviewQuerySchema.safeParse({ amount: 1e-7 })
    expect(result.success).toBe(false)
    expect(result.error!.issues[0]!.code).toBe('custom')
  })
})

describe('cascadeEditPreviewBlockedReasonSchema — wire contract', () => {
  it('accepts exactly the two defined reasons, unchanged', () => {
    const reasons = ['PAYOUT_FAMILY', 'LINKED_TO_PAYOUT_REQUEST'] as const
    for (const reason of reasons) {
      expect(cascadeEditPreviewBlockedReasonSchema.parse(reason)).toBe(reason)
    }
  })

  it('rejects a reason outside the defined set', () => {
    expect(() => cascadeEditPreviewBlockedReasonSchema.parse('BOGUS')).toThrow()
  })
})

describe('cascadeEditPreviewResponseSchema — wire contract', () => {
  it('parses a "blocked" response and retains every field', () => {
    const response: CascadeEditPreviewResponse = {
      editable: false,
      blockedReason: 'PAYOUT_FAMILY',
      plan: null,
      version: null,
    }
    expect(cascadeEditPreviewResponseSchema.parse(response)).toEqual(response)
  })

  it('parses an "editable" response with a nested plan and retains every field', () => {
    const response: CascadeEditPreviewResponse = {
      editable: true,
      blockedReason: null,
      plan: {
        sourceId: '22222222-2222-4222-8222-222222222222',
        sourceAmountChanged: false,
        oldSourceAmount: 1000,
        newSourceAmount: 1000,
        derivatives: [],
        sourceWarnings: [],
      },
      version: 'src:22222222-2222-4222-8222-222222222222:2026-08-01T00:00:00.000Z',
    }
    expect(cascadeEditPreviewResponseSchema.parse(response)).toEqual(response)
  })
})
