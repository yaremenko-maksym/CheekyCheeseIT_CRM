import { describe, it, expect } from 'vitest'
import { roundShareAmount } from '../utils/money'
import { MAX_TRANSACTION_AMOUNT, adminUpdateTransactionSchema } from './finance'
import {
  amountsDiffer,
  computeCascadeVersion,
  resolveEditCascade,
  cascadeWarningCodeSchema,
  cascadePlanSchema,
  cascadeEditPreviewQuerySchema,
  cascadeEditPreviewBlockedReasonSchema,
  cascadeEditPreviewResponseSchema,
  cascadeLedgerFactReasonSchema,
  classifyEditedRowLedgerFact,
  CASCADE_LEDGER_FACT_MESSAGES,
  floorAmountAtAccumulator,
  isCascadeAmountEdit,
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
    settledAmount: null,
    hasClosedObligation: false,
    ...overrides,
  }
}

function makePendingDerivative(
  overrides: Partial<CascadeDerivativeSnapshot> = {},
): CascadeDerivativeSnapshot {
  return {
    id: 'deriv-1',
    type: 'SENIOR_PENDING_PAYOUT',
    // UX-1 — the share carries its OWN receiver; it is not inherited from the
    // edited row (on `ADMIN_INCOME`, the main path, the two are different people).
    receiverName: 'Иван Петров',
    status: 'PENDING_PAYMENT',
    amount: 260,
    currency: 'USDT',
    updatedAt: '2026-08-01T00:00:00.000Z',
    sharePercent: 26,
    settledAmount: null,
    settledCurrency: null,
    settledSharePercent: null,
    fundingSource: null,
    originalAmount: null,
    originalCurrency: null,
    exchangeRate: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    txDate: null,
    hasSignedInvoice: false,
    obligation: {
      id: 'obl-1',
      status: 'PENDING',
      amount: 260,
      currency: 'USDT',
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
    receiverName: 'Иван Петров',
    status: 'PAID',
    amount: 260,
    currency: 'USDT',
    updatedAt: '2026-08-01T00:00:00.000Z',
    sharePercent: null, // nulled by settleByCompany's flip
    settledAmount: 260,
    settledCurrency: 'USDT',
    settledSharePercent: 26,
    fundingSource: 'COMPANY_ACCOUNT',
    // task-drop-topup (task 3b): the payment-fact triplet is stamped by a DROP
    // settle only — a senior one leaves all three NULL (addendum 3b, 1.5).
    originalAmount: null,
    originalCurrency: null,
    exchangeRate: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    txDate: null,
    hasSignedInvoice: false,
    obligation: {
      id: 'obl-1',
      status: 'PAID',
      amount: 260,
      currency: 'USDT',
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

describe('floorAmountAtAccumulator — the floor, stated once (SR-M-6 / SR-M-2)', () => {
  it('raises a request that sits below what was already paid', () => {
    expect(floorAmountAtAccumulator(260, 100)).toBe(260)
  })

  it('leaves a request above the accumulator exactly as asked', () => {
    expect(floorAmountAtAccumulator(260, 900)).toBe(900)
  })

  it('is the identity when there is NO accumulator — including for negatives', () => {
    // The law is about the accumulator. `Math.max(requested, settledAmount ?? 0)`
    // reads identically for every figure the API can receive (both entrances
    // validate `.positive()`), but it quietly states a second rule — "never
    // below zero" — and clamps the resolver's negative probe to 0.
    expect(floorAmountAtAccumulator(null, 100)).toBe(100)
    expect(floorAmountAtAccumulator(undefined, 100)).toBe(100)
    expect(floorAmountAtAccumulator(null, -100)).toBe(-100)
  })

  it('accepts the raw numeric column as the string drizzle returns', () => {
    // The conversion lives here so no caller writes its own null-preserving
    // ternary — one did, and it was an unkillable mutant.
    expect(floorAmountAtAccumulator('260.000000', 100)).toBe(260)
  })

  it('treats a ZERO accumulator as a real floor, not as an absent one', () => {
    // `0` is a settle that happened and paid nothing; `null` is "never
    // settled". A truthiness check would collapse the two.
    expect(floorAmountAtAccumulator(0, -100)).toBe(0)
  })
})

describe('isCascadeAmountEdit — asked by both entrances (CR-M-2)', () => {
  const settledRow = { status: 'PAID', storedAmount: 260 }

  it('is true when a PAID row is asked to change', () => {
    expect(isCascadeAmountEdit({ ...settledRow, requestedAmount: 500 })).toBe(true)
  })

  it('is false when the figure asked for is the one already stored', () => {
    expect(isCascadeAmountEdit({ ...settledRow, requestedAmount: 260 })).toBe(false)
  })

  it('is false for a row that is not PAID, however much the figure moves', () => {
    expect(
      isCascadeAmountEdit({ status: 'PENDING_PAYMENT', storedAmount: 260, requestedAmount: 900 }),
    ).toBe(false)
  })

  /**
   * The regression this function was briefly written the wrong way round for.
   *
   * Round 4's first attempt compared the FLOORED figure here, reasoning that
   * the stored value is what matters. On a settled row `amount ===
   * settled_amount`, so every DOWNWARD request floors straight back to the
   * current value — "no change" — which skipped AC13 entirely and answered the
   * operator with a silent success, for exactly the population AC13 exists to
   * refuse. Two integration specs caught it; this pins it at the unit level
   * where the mutation gate can see it too.
   */
  it('stays TRUE for a downward edit of a settled row — the floor must not hide AC13', () => {
    expect(isCascadeAmountEdit({ ...settledRow, requestedAmount: 26 })).toBe(true)
  })

  /**
   * SR-M-1 (review round 5) — the divergence itself, measured.
   *
   * The two questions this codebase asks about an amount edit are NOT the same
   * question, and the input where they part company is reachable rather than
   * theoretical. Round 4 shipped a comment claiming both compared "the same
   * floored figure"; they do not, and the reason they must not is right here.
   * Without this test the claim and the code could only be compared by reading
   * them.
   */
  it('the two questions genuinely diverge on a settled row — and the predicate follows the RAW one', () => {
    const storedAmount = 260
    const settledAmount = 260
    const requestedAmount = 26

    const floored = floorAmountAtAccumulator(settledAmount, requestedAmount)

    // "Did the operator ask for a change?" — yes.
    expect(amountsDiffer(requestedAmount, storedAmount)).toBe(true)
    // "Would the stored figure move?" — no: the floor puts it straight back.
    expect(amountsDiffer(floored, storedAmount)).toBe(false)

    // So the two disagree here, which is the whole point:
    expect(amountsDiffer(requestedAmount, storedAmount)).not.toBe(
      amountsDiffer(floored, storedAmount),
    )

    // AC13 has to fire on this row, so the predicate follows the RAW question.
    // Following the floored one answers the operator with a silent success on
    // exactly the population AC13 exists to refuse.
    expect(isCascadeAmountEdit({ status: 'PAID', storedAmount, requestedAmount })).toBe(true)
  })
})

describe('classifyEditedRowLedgerFact — AC13 stated once (CR-M-1)', () => {
  it('names the fact-of-payment triplet', () => {
    expect(classifyEditedRowLedgerFact(makeSource({ originalAmount: 41500 }))).toBe(
      'PAYMENT_FACT_RECORDED',
    )
  })

  it('names the accumulator of actual payouts', () => {
    expect(classifyEditedRowLedgerFact(makeSource({ settledAmount: 260 }))).toBe(
      'SETTLED_AMOUNT_RECORDED',
    )
  })

  it('counts a zero accumulator as recorded — it is a settle that happened, not an absent one', () => {
    // `0` is a figure someone wrote down; `null` is "never settled". Reading
    // the first as the second is how a truthiness check would get this wrong.
    expect(classifyEditedRowLedgerFact(makeSource({ settledAmount: 0 }))).toBe(
      'SETTLED_AMOUNT_RECORDED',
    )
  })

  it('names a closed obligation the row stands behind', () => {
    expect(classifyEditedRowLedgerFact(makeSource({ hasClosedObligation: true }))).toBe(
      'CLOSES_OBLIGATION',
    )
  })

  it('names an on-chain deposit', () => {
    expect(classifyEditedRowLedgerFact(makeSource({ type: 'COMPANY_DEPOSIT' }))).toBe(
      'ONCHAIN_DEPOSIT',
    )
  })

  it.each(['ADMIN_INCOME', 'EXPENSE', 'DIVIDEND_TO_ADMIN'])(
    'leaves %s editable — it has no second carrier of the amount',
    (type) => {
      expect(classifyEditedRowLedgerFact(makeSource({ type }))).toBeNull()
    },
  )

  it('reports the most fundamental carrier first when a row has several', () => {
    // Order is not cosmetic: the operator should hear the reason that is
    // hardest to argue with, and every reason names a DIFFERENT remedy.
    expect(
      classifyEditedRowLedgerFact(
        makeSource({ originalAmount: 800, settledAmount: 260, hasClosedObligation: true }),
      ),
    ).toBe('PAYMENT_FACT_RECORDED')
    expect(
      classifyEditedRowLedgerFact(makeSource({ settledAmount: 260, hasClosedObligation: true })),
    ).toBe('SETTLED_AMOUNT_RECORDED')
  })

  it('has a distinct operator-facing message for every reason, each naming a carrier', () => {
    const messages = Object.values(CASCADE_LEDGER_FACT_MESSAGES)
    expect(messages).toHaveLength(cascadeLedgerFactReasonSchema.options.length)
    expect(new Set(messages).size).toBe(messages.length)
    for (const m of messages) expect(m.length).toBeGreaterThan(20)
  })

  it('carries exactly these four codes, spelled out', () => {
    // Written as literals ON PURPOSE. Reading the expected values back out of
    // `cascadeLedgerFactReasonSchema.options` would make this pass by
    // construction — the tautology the mutation gate catches by blanking an
    // option and watching nothing complain. These strings cross the wire to
    // task 5's UI; they are a contract, not an implementation detail.
    expect(cascadeLedgerFactReasonSchema.options).toEqual([
      'PAYMENT_FACT_RECORDED',
      'SETTLED_AMOUNT_RECORDED',
      'CLOSES_OBLIGATION',
      'ONCHAIN_DEPOSIT',
    ])
  })

  it('is a subset of what the preview can report — otherwise the write could refuse unnameably', () => {
    // Same reason as above: the four codes are named here independently of the
    // enum being checked, so an option that loses its value fails to parse.
    for (const reason of [
      'PAYMENT_FACT_RECORDED',
      'SETTLED_AMOUNT_RECORDED',
      'CLOSES_OBLIGATION',
      'ONCHAIN_DEPOSIT',
    ] as const) {
      expect(cascadeLedgerFactReasonSchema.safeParse(reason).success).toBe(true)
      expect(cascadeEditPreviewBlockedReasonSchema.safeParse(reason).success).toBe(true)
    }
  })

  it('leaves guards 1 and 2 in the preview enum — the ledger facts are additions, not a replacement', () => {
    for (const reason of ['PAYOUT_FAMILY', 'LINKED_TO_PAYOUT_REQUEST'] as const) {
      expect(cascadeEditPreviewBlockedReasonSchema.safeParse(reason).success).toBe(true)
      expect(cascadeLedgerFactReasonSchema.safeParse(reason).success).toBe(false)
    }
  })
})

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
    // QA-H-1: the share came out at 26 and the row will KEEP its 260 — this is
    // the write-nothing branch of `applyEditCascade` (a PAID obligation whose
    // recomputed share does not exceed what was paid stays exactly as it is).
    // The two figures are now stated separately instead of the plan reporting
    // the share as though it were the outcome.
    expect(d.recomputedShare).toBe(roundShareAmount(100, 26))
    expect(d.recomputedShare!).toBeLessThan(260)
    expect(d.newAmount).toBe(260)
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

  it('mutation-gate: the `settledAmount > 0` operand of `overpaid` is load-bearing at the settledAmount===0 boundary, not equivalent to `>=0` or `true`', () => {
    // AC1: `resolveEditCascade` is a PURE function — it validates nothing
    // about its own input (the wire schema's `.positive()` on
    // `cascadeEditPreviewQuerySchema.amount` is what keeps a negative amount
    // OUT at the HTTP boundary; the resolver itself is called directly here,
    // the way `resolveEditCascade` is documented to be exercised in this
    // file). A NEGATIVE proposed source amount makes `roundShareAmount`
    // return a NEGATIVE `newAmount` — the only way to make `newAmount <
    // settledAmount` true while `settledAmount` is exactly 0, which is the
    // one input combination that distinguishes `settledAmount > 0` from
    // both `settledAmount >= 0` and an unconditional `true`.
    const s = snapshot({ amount: 1000 }, [makePendingDerivative({ sharePercent: 26 })])
    const plan = resolveEditCascade(s, { amount: -100 }) // newAmount = -26, settledAmount = 0
    const d = plan.derivatives[0]!
    expect(d.newAmount).toBe(roundShareAmount(-100, 26))
    expect(d.newAmount).toBeLessThan(0)
    expect(d.settledAmount).toBe(0)
    // Both mutants would fire an OVERPAYMENT warning here (settledAmount>=0
    // is true at 0, and an unconditional true never gates at all); the real
    // rule requires a POSITIVE accumulator — nothing has actually been paid,
    // so there is nothing to warn about.
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
          currency: 'USDT',
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

  it('LOW (security-review round 2): DOES warn when settledAmount>0 but settledCurrency is null — an unrecorded currency is treated as "cannot compare", not silently assumed to match', () => {
    // Round 1 pinned the OPPOSITE behaviour here (no warning) to prove the
    // `settledCurrency !== null` operand was a real, live guard — the round
    // 2 fix REMOVES that guard on purpose (`null !== sourceCurrency` is
    // `true` for every real currency), because treating an unrecorded
    // currency as an implicit match is the same kind of guess the resolver
    // refuses to make everywhere else (see NO_SHARE_SNAPSHOT). Unreachable
    // in production today (settle always stamps both columns together) —
    // this pins the defensive behaviour anyway.
    const s = snapshot({ amount: 1000 }, [makePaidDerivative({ settledCurrency: null })])
    const plan = resolveEditCascade(s, { amount: 2000 })
    const d = plan.derivatives[0]!
    // Exact message content pinned (not `expect.any(String)`) — mutation-gate
    // (round 2 fix pass): a mutant that always takes the non-null message
    // branch (`settledCurrency === null` → `false`) OR blanks the null-branch
    // template to `` is otherwise invisible through a code-only assertion,
    // since both branches produce the SAME `NON_USDT_CURRENCY` code.
    expect(d.warnings).toEqual([
      {
        code: 'NON_USDT_CURRENCY',
        message:
          'Валюта уже выплаченной суммы (260) не зафиксирована — сравнить с новой долей в USDT нельзя',
      },
    ])
    expect(d.remainingToPay).toBeNull()
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
    // MED-A (security-review round 2): this is the EXACT scenario the finding
    // named — a revert to PENDING (settled_amount left at 260 by AC3's
    // "Механика возврата"), then a second edit whose recomputed share (26)
    // falls below that accumulator. `remainingToPay: 0` alone is not enough —
    // 234 USDT that already left the building must be flagged, and the OLD
    // `isSettled &&` gate on `overpaid` silently dropped this warning purely
    // because the row happens to read PENDING right now.
    expect(d.warnings).toEqual([
      {
        code: 'OVERPAYMENT',
        message: expect.stringContaining('260'),
      },
    ])
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

  it('QA-H-1. an OPEN obligation shows the figure that will actually be WRITTEN, not the raw share below the accumulator', () => {
    // Found by manual QA on live data, with a SQL dump either side: the panel
    // said «100 → 50» and the row came out at 100.
    //
    // Reachable in four steps: close a drop obligation in full → RAISE the
    // source (share now exceeds the accumulator, so the obligation reopens
    // into PENDING_PAYMENT still carrying `settled_amount`) → LOWER it again
    // until the recomputed share falls back below what was paid.
    //
    // `applyEditCascade` floors the write at the accumulator
    // (`floorAmountAtAccumulator`, the shared law extracted in #608) because a
    // row whose `amount` sits below `settled_amount` leaves a negative
    // remainder and an obligation nobody can close. The resolver did not, so
    // the preview described a number the system had already decided never to
    // store — the one thing AC4 of the ADR says must not happen, and it
    // happened because the law reached one of its two call sites.
    const s = snapshot({ amount: 1000 }, [
      makePendingDerivative({ settledAmount: 260, settledCurrency: 'USDT' }),
    ])

    // 26% of 500 = 130, below the 260 already paid.
    const d = resolveEditCascade(s, { amount: 500 }).derivatives[0]!

    expect(d.newAmount).toBe(260)
    expect(d.remainingToPay).toBe(0)
    // The overpayment is still a fact and must still be announced — flooring
    // the figure must not silence the warning about it.
    expect(d.warnings.some((w) => w.code === 'OVERPAYMENT')).toBe(true)
  })

  it('QA-H-1b. the overpayment text does not call an OPEN row «оплаченной»', () => {
    // Second layer of the same finding. The message was written for the one
    // state that existed when it was written — a PAID row that stays PAID —
    // and is simply false for the state above: the row is PENDING_PAYMENT
    // when it is shown and PENDING_PAYMENT after saving, with nothing left
    // to pay. One sentence describing two different outcomes.
    const open = resolveEditCascade(
      snapshot({ amount: 1000 }, [
        makePendingDerivative({ settledAmount: 260, settledCurrency: 'USDT' }),
      ]),
      { amount: 500 },
    ).derivatives[0]!
    const openText = open.warnings.find((w) => w.code === 'OVERPAYMENT')!.message
    expect(openText).not.toContain('остаётся оплаченной')

    // …while the PAID row, which really does stay paid, keeps saying so.
    const paid = resolveEditCascade(
      snapshot({ amount: 1000 }, [
        makePaidDerivative({ settledAmount: 260, settledCurrency: 'USDT' }),
      ]),
      { amount: 500 },
    ).derivatives[0]!
    const paidText = paid.warnings.find((w) => w.code === 'OVERPAYMENT')!.message
    expect(paidText).toContain('остаётся оплаченной')
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

describe("resolveEditCascade — HIGH-2-residual (security-review round 2): compares settledCurrency against the SOURCE's own currency, never a hardcoded USDT literal", () => {
  // A test that only changes the literal in a fixture cannot tell "compares
  // against sourceCurrency" apart from "compares against 'USDT'" whenever
  // sourceCurrency happens to BE 'USDT' — every other test in this file uses
  // the default fixture, so all of them pass identically whether the
  // resolver reads `source.currency` or a hardcoded string. These two tests
  // deliberately move the source OFF USDT to make the two implementations
  // disagree.
  it('a source booked in a non-USDT currency, settled in THAT SAME currency, is NOT flagged as a mismatch', () => {
    const s = snapshot({ amount: 1000, currency: 'EUR' }, [
      makePaidDerivative({ settledCurrency: 'EUR', settledAmount: 260 }),
    ])
    const plan = resolveEditCascade(s, { amount: 2000 })
    const d = plan.derivatives[0]!
    // A hardcoded `!== 'USDT'` check would flag this row (settledCurrency
    // 'EUR' !== 'USDT') even though nothing here is actually mismatched —
    // both the source and the settle are in EUR.
    expect(d.currency).toBe('EUR')
    expect(d.warnings.some((w) => w.code === 'NON_USDT_CURRENCY')).toBe(false)
    expect(d.remainingToPay).not.toBeNull()
    expect(d.remainingToPay).toBe(Number((d.newAmount! - 260).toFixed(6)))
  })

  it('a source booked in a non-USDT currency, settled in USDT, IS flagged — proves the comparison is not simply "is settledCurrency USDT"', () => {
    const s = snapshot({ amount: 1000, currency: 'EUR' }, [
      makePaidDerivative({ settledCurrency: 'USDT', settledAmount: 260 }),
    ])
    const plan = resolveEditCascade(s, { amount: 2000 })
    const d = plan.derivatives[0]!
    // A hardcoded `!== 'USDT'` check would treat this as MATCHING (settled
    // currency literally IS 'USDT') and silently subtract a USDT figure from
    // a EUR share — the exact inverse of the bug HIGH-2 already fixed for
    // the DROP/UAH case, mirrored onto the currency the source itself uses.
    expect(d.currency).toBe('EUR')
    expect(d.warnings.some((w) => w.code === 'NON_USDT_CURRENCY')).toBe(true)
    expect(d.remainingToPay).toBeNull()
  })

  it('cascadePlan carries the SOURCE currency at top level, and every derivative carries the currency oldAmount/newAmount are denominated in', () => {
    const s = snapshot({ amount: 1000, currency: 'EUR' }, [
      makePendingDerivative({ sharePercent: 26 }),
    ])
    const plan = resolveEditCascade(s, { amount: 2000 })
    expect(plan.sourceCurrency).toBe('EUR')
    expect(plan.derivatives[0]!.currency).toBe('EUR')
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
        obligation: { id: 'o9', status: 'PENDING', amount: 1, currency: 'USDT', updatedAt: 'T3' },
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
  /** Same set, named separately so the triplet's variation reads as its own axis. */
  const TRIPLET_CURRENCIES = SETTLED_CURRENCIES

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
    // MED-A (security-review round 2): the disputed combination for the
    // OVERPAYMENT flag specifically — obligation PENDING (isSettled=false),
    // yet the recomputed share sits BELOW a nonzero settledAmount. Before the
    // fix `overpaid` was gated on `isSettled`, so this exact combination
    // could occur without ever producing a warning; asserted > 0 below so a
    // regression back to the status-gated formula cannot silently stop being
    // exercised.
    let pendingOverpaidCases = 0

    // HIGH-2-residual (security-review round 2): the source's OWN currency
    // — every snapshot below uses the default fixture (`makeSource()`),
    // which is 'USDT', so this mirrors `source.currency` exactly. Kept as an
    // explicit local rather than the literal `'USDT'` so the intent of every
    // comparison below reads as "against the source", matching
    // `resolveDerivative`'s own parameter — not because this loop varies it
    // (the two HIGH-2-residual unit tests above are what prove the resolver
    // does not simply hardcode `'USDT'`).
    const sourceCurrency = 'USDT' as const

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
        receiverName: 'Иван Петров',
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
        // Anything that has been through a settle carries a funding marker;
        // an untouched IOU does not. Independent of the accumulator's size,
        // matching what `settleByCompany` actually writes.
        fundingSource: hasSettledHistory ? 'COMPANY_ACCOUNT' : null,
        // task-drop-topup (task 3b, backlog 87): the payment-fact triplet is
        // VARIED here on purpose, including shapes no writer produces (a rate
        // with no amount, a currency unlike the source's). Nothing below
        // asserts anything ABOUT it — that is the point: every assertion in
        // this loop has to keep holding while these three columns move
        // arbitrarily, which is what "the resolver does not read the triplet"
        // means operationally. A generator that derived them from the settled
        // figures would prove only that the resolver agrees with itself.
        originalAmount: rand() < 0.5 ? null : rand() * 5_000,
        originalCurrency:
          rand() < 0.5 ? null : TRIPLET_CURRENCIES[Math.floor(rand() * TRIPLET_CURRENCIES.length)]!,
        exchangeRate: rand() < 0.5 ? null : (rand() * 50).toFixed(8),
        receiptDocumentId: null,
        receiptExternalUrl: rand() < 0.5 ? null : 'https://etherscan.io/tx/0xproperty',
        txDate: rand() < 0.5 ? null : '2026-08-02T00:00:00.000Z',
        hasSignedInvoice: false,
        obligation: {
          id: 'obl-1',
          status: obligationStatus,
          amount: 1,
          currency: 'USDT',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      }

      if (obligationStatus === 'PENDING' && settledAmount > 0) pendingWithSettledHistory++

      const s = snapshot({ amount: income }, [deriv])
      const plan = resolveEditCascade(s, { amount: newIncome })

      if (!plan.sourceAmountChanged) continue // delta==0 path — covered separately
      const d = plan.derivatives[0]!
      // QA-H-1 split this into TWO invariants, because the plan now carries two
      // figures. The RECOMPUTED share is the pure arithmetic it always was…
      expect(d.recomputedShare).toBe(roundShareAmount(newIncome, percent))
      // …while `newAmount` is what will be WRITTEN: the share, floored at the
      // accumulator wherever the two are the same unit. This is the invariant
      // whose absence let the preview describe a figure that never got stored.
      const comparableAccumulator = settledAmount > 0 && settledCurrency === sourceCurrency
      expect(d.newAmount).toBe(
        comparableAccumulator
          ? Math.max(roundShareAmount(newIncome, percent), settledAmount)
          : roundShareAmount(newIncome, percent),
      )
      // Stated once more as the law itself rather than as a formula, so a
      // future refactor of the expression above cannot quietly satisfy the
      // arithmetic while breaking the rule: a row's amount is never written
      // below what has already been paid out of it.
      const neverBelowAccumulator = comparableAccumulator ? d.newAmount! >= settledAmount : true
      expect(neverBelowAccumulator).toBe(true)
      // The wire contract's currency tag — always the source's own currency,
      // regardless of everything else varied per iteration.
      expect(d.currency).toBe(sourceCurrency)

      // Invariant 1 (HIGH-1): the accumulator the plan REPORTS is exactly
      // what the snapshot carried — UNCONDITIONALLY, never gated by the
      // CURRENT obligation status.
      expect(d.settledAmount).toBe(settledAmount)
      expect(d.settledCurrency).toBe(settledCurrency)

      // HIGH-2-residual (security-review round 2): compared against the
      // SOURCE's currency, and the `settledCurrency !== null` guard round 1
      // had is gone — an unrecorded currency no longer reads as an implicit
      // match (LOW, round 2).
      const currencyMismatch = settledAmount > 0 && settledCurrency !== sourceCurrency
      if (currencyMismatch) crossCurrencyMismatchCases++

      // Invariant 2 (HIGH-2): remainingToPay is the plain subtraction ONLY
      // when the two figures share a currency; a cross-currency accumulator
      // yields `null`, never a fabricated number.
      const expectedRemaining = currencyMismatch
        ? null
        : Math.max(0, Number((d.newAmount! - settledAmount).toFixed(6)))
      expect(d.remainingToPay).toBe(expectedRemaining)

      // Invariant 3: needsReconfirm is never derived from a cross-currency
      // comparison — under a mismatch it collapses to the pure status
      // question (isSettled).
      const expectedNeedsReconfirm = currencyMismatch
        ? isSettled
        : isSettled && d.recomputedShare! > settledAmount
      expect(d.needsReconfirm).toBe(expectedNeedsReconfirm)

      // Invariant 4 (MED-A, security-review round 2): OVERPAYMENT is driven
      // PURELY by the monotonic accumulator (settledAmount > 0 && newAmount <
      // settledAmount) — AC3's own definition — never by the obligation's
      // CURRENT status. This is deliberately NOT "whatever the SUT computes"
      // reflected back: it is the accumulator-only rule the ADR specifies,
      // independent of `isSettled`, so a regression to the old
      // `isSettled && ...` gate changes `d.warnings` (via the SUT) without
      // changing this expected value — and the assertion catches the
      // divergence, on the `pendingOverpaidCases` iterations specifically.
      if (
        !currencyMismatch &&
        obligationStatus === 'PENDING' &&
        d.recomputedShare! < settledAmount
      ) {
        pendingOverpaidCases++
      }
      // QA-H-1: the overpayment is a property of the RECOMPUTED share, not of
      // the written figure. After the floor `newAmount >= settledAmount` always
      // holds, so asking it here would assert the warning never fires — on
      // exactly the population it exists for.
      const expectedOverpaymentWarning =
        !currencyMismatch && settledAmount > 0 && d.recomputedShare! < settledAmount
      expect(d.warnings.some((w) => w.code === 'OVERPAYMENT')).toBe(expectedOverpaymentWarning)
      expect(d.warnings.some((w) => w.code === 'NON_USDT_CURRENCY')).toBe(currencyMismatch)
    }

    // The disputed combinations MUST actually occur across the run, or every
    // assertion above passed vacuously on them — same failure mode as the
    // property test the review found (an invariant "proven" only where it
    // cannot break).
    expect(pendingWithSettledHistory).toBeGreaterThan(0)
    expect(crossCurrencyMismatchCases).toBeGreaterThan(0)
    expect(pendingOverpaidCases).toBeGreaterThan(0)
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
      receiverName: 'Иван Петров',
      oldAmount: 260,
      newAmount: 520,
      recomputedShare: 520,
      sharePercent: 26,
      currency: 'USDT',
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
      sourceCurrency: 'USDT',
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
        sourceCurrency: 'USDT',
        derivatives: [],
        sourceWarnings: [],
      },
      version: 'src:22222222-2222-4222-8222-222222222222:2026-08-01T00:00:00.000Z',
    }
    expect(cascadeEditPreviewResponseSchema.parse(response)).toEqual(response)
  })
})

// ---------------------------------------------------------------------------
// task-cascade-apply (task 3) — обязательство не в валюте источника.
//
// Пункт 95 бэклога / аддендум 3.5: `oldAmount` берётся из
// `pending_obligations.amount`, а каскад в эту же колонку ПИШЕТ долю,
// посчитанную от суммы источника. До задачи 3 совпадение валют держал BIZ-18,
// который задача 3 и снимает — значит валюту надо ПРОЧИТАТЬ (поле `currency`
// на снимке обязательства) и, при расхождении, сказать вслух, а не
// предположить совпадение.
// ---------------------------------------------------------------------------

describe('resolveEditCascade — OBLIGATION_CURRENCY_MISMATCH (пункт 95 бэклога)', () => {
  it('warns when the obligation is booked in a currency other than the source currency', () => {
    const s = snapshot({ amount: 1000, currency: 'USDT' }, [
      makePendingDerivative({
        obligation: {
          id: 'obl-1',
          status: 'PENDING',
          amount: 260,
          currency: 'EUR',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      }),
    ])
    const plan = resolveEditCascade(s, { amount: 2000 })
    const codes = plan.derivatives[0]!.warnings.map((w) => w.code)
    expect(codes).toContain('OBLIGATION_CURRENCY_MISMATCH')
  })

  it('names BOTH currencies in the message so a human can tell which is which', () => {
    const s = snapshot({ amount: 1000, currency: 'USDT' }, [
      makePendingDerivative({
        obligation: {
          id: 'obl-1',
          status: 'PENDING',
          amount: 260,
          currency: 'EUR',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      }),
    ])
    const warning = resolveEditCascade(s, { amount: 2000 }).derivatives[0]!.warnings.find(
      (w) => w.code === 'OBLIGATION_CURRENCY_MISMATCH',
    )
    expect(warning?.message).toContain('EUR')
    expect(warning?.message).toContain('USDT')
  })

  it('still computes newAmount normally — the NUMBER is right, writing it into a foreign-currency column is not', () => {
    const s = snapshot({ amount: 1000, currency: 'USDT' }, [
      makePendingDerivative({
        obligation: {
          id: 'obl-1',
          status: 'PENDING',
          amount: 260,
          currency: 'EUR',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      }),
    ])
    const plan = resolveEditCascade(s, { amount: 2000 })
    // 26% of 2000 — an independently known figure, not re-derived the way the
    // production code derives it.
    expect(plan.derivatives[0]!.newAmount).toBe(520)
    expect(plan.derivatives[0]!.sharePercent).toBe(26)
  })

  it('does NOT warn when the obligation currency equals the source currency', () => {
    const s = snapshot({ amount: 1000, currency: 'USDT' }, [makePendingDerivative()])
    const codes = resolveEditCascade(s, { amount: 2000 }).derivatives[0]!.warnings.map(
      (w) => w.code,
    )
    expect(codes).not.toContain('OBLIGATION_CURRENCY_MISMATCH')
  })

  it('does NOT warn when the derivative carries no obligation at all — nothing to compare', () => {
    const s = snapshot({ amount: 1000, currency: 'USDT' }, [
      makePendingDerivative({ obligation: null }),
    ])
    const codes = resolveEditCascade(s, { amount: 2000 }).derivatives[0]!.warnings.map(
      (w) => w.code,
    )
    expect(codes).not.toContain('OBLIGATION_CURRENCY_MISMATCH')
  })

  it('fires on a SETTLED obligation too — the check is about the column being written, not about status', () => {
    const s = snapshot({ amount: 1000, currency: 'USDT' }, [
      makePaidDerivative({
        obligation: {
          id: 'obl-1',
          status: 'PAID',
          amount: 260,
          currency: 'UAH',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      }),
    ])
    const codes = resolveEditCascade(s, { amount: 2000 }).derivatives[0]!.warnings.map(
      (w) => w.code,
    )
    expect(codes).toContain('OBLIGATION_CURRENCY_MISMATCH')
  })

  it('cascadeWarningCodeSchema accepts the new code', () => {
    expect(cascadeWarningCodeSchema.parse('OBLIGATION_CURRENCY_MISMATCH')).toBe(
      'OBLIGATION_CURRENCY_MISMATCH',
    )
  })
})

// ---------------------------------------------------------------------------
// task-cascade-apply (task 3) — the optimistic-locking token travels on the
// EDIT body. `GET :id/edit-preview` hands back `version`; `PATCH
// :id/admin-edit` sends it straight back so the server can refuse an edit
// built on a stale preview (ADR AC4: "отказ с просьбой обновить предпросмотр,
// а не молчаливый пересчёт").
// ---------------------------------------------------------------------------

describe('adminUpdateTransactionSchema.cascadeVersion — the preview token on the edit body', () => {
  it('accepts a body carrying a cascadeVersion and keeps its value verbatim', () => {
    const version = 'src:22222222-2222-4222-8222-222222222222:2026-08-01T00:00:00.000Z'
    const parsed = adminUpdateTransactionSchema.parse({ amount: 2000, cascadeVersion: version })
    expect(parsed.cascadeVersion).toBe(version)
  })

  it('stays optional — a metadata-only edit body without it still parses', () => {
    const parsed = adminUpdateTransactionSchema.parse({ notes: 'just a note' })
    expect(parsed.cascadeVersion).toBeUndefined()
  })

  it('rejects an EMPTY cascadeVersion — an empty token is not a token', () => {
    expect(adminUpdateTransactionSchema.safeParse({ cascadeVersion: '' }).success).toBe(false)
  })

  it('round-trips a version produced by computeCascadeVersion (the two ends agree)', () => {
    const s = snapshot({ amount: 1000 }, [makePendingDerivative()])
    const version = computeCascadeVersion(s)
    expect(adminUpdateTransactionSchema.parse({ cascadeVersion: version }).cascadeVersion).toBe(
      version,
    )
  })
})

/**
 * task-drop-topup (task 3b) — AC13 in both directions, once the cascade started
 * clearing the payment-fact triplet on a revert.
 *
 * The worry worth writing down: `classifyEditedRowLedgerFact` refuses an edit
 * when `originalAmount !== null` is its FIRST predicate, and 3b makes that
 * column go null on rows it never went null on before. Does clearing it open a
 * door?
 *
 * No — and the reason is structural, not a coincidence, which is why it is
 * pinned here: the refusal is a DISJUNCTION, and on any drop row that ever had
 * a triplet the other two disjuncts are independently true.
 */
describe('AC13 after task 3b: clearing the triplet opens nothing', () => {
  it('a closed drop row with NO triplet is still refused — by its accumulator', () => {
    // The shape a future revert leaves behind, asked of the classifier
    // directly: the row has been paid, so its `amount` is pinned to what left
    // the account whether or not the triplet says so.
    expect(
      classifyEditedRowLedgerFact(
        makeSource({ type: 'PAYOUT_DROP', originalAmount: null, settledAmount: 130 }),
      ),
    ).toBe('SETTLED_AMOUNT_RECORDED')
  })

  it('…and, with no accumulator either, by the obligation it closed', () => {
    // The pre-#599 shape: three layers, and the triplet is only the first.
    expect(
      classifyEditedRowLedgerFact(
        makeSource({
          type: 'PAYOUT_DROP',
          originalAmount: null,
          settledAmount: null,
          hasClosedObligation: true,
        }),
      ),
    ).toBe('CLOSES_OBLIGATION')
  })

  it.each(['ADMIN_INCOME', 'EXPENSE', 'DIVIDEND_TO_ADMIN'])(
    'and nothing new is refused: %s with no carrier at all stays editable',
    (type) => {
      // The other direction. 3b adds no predicate here, and an income row is
      // exactly what this whole decomposition exists to let people fix.
      expect(classifyEditedRowLedgerFact(makeSource({ type, originalAmount: null }))).toBeNull()
    },
  )

  it('a REVERTED drop row never reaches AC13 at all — a different rule holds it', () => {
    // Worth pinning so the next reader does not "close" a hole that is not
    // there. `isCascadeAmountEdit` requires `status === 'PAID'`, and a reverted
    // row is `PENDING_PAYMENT`, so the whole AC13 block (and the mandatory
    // preview with it) is skipped for it. What keeps its `amount` honest is
    // `floorAmountAtAccumulator`: no writer may put it below what was paid.
    expect(
      isCascadeAmountEdit({ status: 'PENDING_PAYMENT', storedAmount: 130, requestedAmount: 5 }),
    ).toBe(false)
    expect(floorAmountAtAccumulator(5, 130)).toBe(130)
  })
})
