/**
 * task-cascade-preview-ui (task 5) — the Save gate, and the row-level
 * «выплачено / осталось» split.
 *
 * WHAT THE GATE IS. Not «are there warnings» (an overpayment is a warning and
 * the server accepts it), not «is the preview editable» (a plan can be
 * editable while one derivative inside it still refuses). It is a MIRROR of the
 * three refusals of `applyEditCascade`'s Phase 1 that are actually visible in
 * the plan — verified against that method line by line, not against the design
 * spec's restatement of it:
 *
 *   1. `newAmount === null`                  — no share snapshot to recompute
 *   2. `OBLIGATION_CURRENCY_MISMATCH`        — refuses unconditionally
 *   3. `needsReconfirm && NON_USDT_CURRENCY` — refuses only on a real revert
 *
 * The other two Phase-1 refusals (`amount` ≠ `settled_amount` on a
 * company-funded row; a missing accumulator on a pre-#599 row) read raw
 * snapshot columns that the plan does not carry, so no client can predict them.
 * They surface as the server's own 400 text at submit — deliberately, and
 * G-8 pins that this gate does NOT pretend to catch them.
 *
 * WHY IT MATTERS THAT THE GATE IS NEITHER TOO WIDE NOR TOO NARROW. Too narrow
 * and the operator hits a guaranteed 400 after typing. Too wide — blocking on
 * any warning — and a legitimate correction becomes impossible to save because
 * the system warned about an overpayment it has no objection to.
 */
import { describe, expect, it } from 'vitest'

import type { CascadeDerivativePlan, CascadeEditPreviewResponse } from '@crm/shared'

import { canSaveCascadeEdit, settlementSplit } from './cascade-preview'

function derivative(over: Partial<CascadeDerivativePlan> = {}): CascadeDerivativePlan {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'SENIOR_PENDING_PAYOUT',
    receiverName: 'Иван Петров',
    oldAmount: 8000,
    newAmount: 10000,
    sharePercent: 40,
    currency: 'USDT',
    settledAmount: 0,
    settledCurrency: null,
    remainingToPay: 10000,
    needsReconfirm: false,
    warnings: [],
    ...over,
  }
}

function preview(over: Partial<CascadeEditPreviewResponse> = {}): CascadeEditPreviewResponse {
  return {
    editable: true,
    blockedReason: null,
    plan: {
      sourceId: '22222222-2222-4222-8222-222222222222',
      sourceAmountChanged: true,
      oldSourceAmount: 20000,
      newSourceAmount: 25000,
      sourceCurrency: 'USDT',
      derivatives: [derivative()],
      sourceWarnings: [],
    },
    version: 'src:v1:2026-08-24T00:00:00.000Z',
    ...over,
  }
}

describe('canSaveCascadeEdit — the Save gate', () => {
  it('G-1. no preview yet ⇒ the ordinary (non-cascade) edit is not blocked', () => {
    // A VALIDATED/PENDING row never asks for a preview at all; the dialog must
    // keep behaving exactly as it did before this feature existed.
    expect(canSaveCascadeEdit(undefined)).toBe(true)
  })

  it('G-2. a clean plan saves', () => {
    expect(canSaveCascadeEdit(preview())).toBe(true)
  })

  it('G-3. editable:false blocks — the server already refused', () => {
    expect(
      canSaveCascadeEdit(
        preview({ editable: false, blockedReason: 'PAYMENT_FACT_RECORDED', plan: null }),
      ),
    ).toBe(false)
  })

  it('G-4. a derivative with no share snapshot blocks (refusal 1)', () => {
    const p = preview()
    p.plan!.derivatives = [derivative({ newAmount: null, sharePercent: null })]

    expect(canSaveCascadeEdit(p)).toBe(false)
  })

  it('G-5. OBLIGATION_CURRENCY_MISMATCH blocks unconditionally (refusal 2)', () => {
    const p = preview()
    p.plan!.derivatives = [
      derivative({
        needsReconfirm: false,
        warnings: [{ code: 'OBLIGATION_CURRENCY_MISMATCH', message: 'учтено в другой валюте' }],
      }),
    ]

    expect(canSaveCascadeEdit(p)).toBe(false)
  })

  it('G-6. NON_USDT_CURRENCY blocks only when the row is actually reverting (refusal 3)', () => {
    const warnings: CascadeDerivativePlan['warnings'] = [
      { code: 'NON_USDT_CURRENCY', message: 'выплата учтена в UAH' },
    ]

    const reverting = preview()
    reverting.plan!.derivatives = [derivative({ needsReconfirm: true, warnings })]

    const notReverting = preview()
    notReverting.plan!.derivatives = [derivative({ needsReconfirm: false, warnings })]

    // Same warning, opposite verdicts — this pair is the whole point of
    // refusal 3 and the reason it cannot be simplified to "has the warning".
    expect(canSaveCascadeEdit(reverting)).toBe(false)
    expect(canSaveCascadeEdit(notReverting)).toBe(true)
  })

  it('G-6b. a reverting row with an UNRELATED warning still saves', () => {
    const p = preview()
    p.plan!.derivatives = [
      derivative({
        needsReconfirm: true,
        warnings: [{ code: 'SIGNED_INVOICE', message: 'Инвойс уже подписан контрагентом' }],
      }),
    ]

    // Refusal 3 is «reverting AND the accumulator is in another currency», not
    // «reverting AND anything at all is flagged». Without this case the code
    // could ask `.some(() => true)` — blocking every warned revert — and G-6
    // would not notice, because its fixture carries the very warning it looks
    // for.
    expect(canSaveCascadeEdit(p)).toBe(true)
  })

  it('G-7. an overpayment does NOT block — the server accepts it', () => {
    const p = preview()
    p.plan!.derivatives = [
      derivative({
        newAmount: 3000,
        settledAmount: 5000,
        settledCurrency: 'USDT',
        remainingToPay: 0,
        warnings: [{ code: 'OVERPAYMENT', message: 'Уже выплачено 5000 — строка остаётся PAID' }],
      }),
    ]

    // Refusing here would make an honest downward correction unsaveable, and
    // the row legitimately just stays PAID (AC7 of task 3).
    expect(canSaveCascadeEdit(p)).toBe(true)
  })

  it('G-8. needsReconfirm on its own does NOT block — reverting a share is the ordinary case', () => {
    const p = preview()
    p.plan!.derivatives = [derivative({ needsReconfirm: true, settledAmount: 4000 })]

    expect(canSaveCascadeEdit(p)).toBe(true)
  })

  it('G-9. one bad derivative among good ones blocks the whole cascade', () => {
    const p = preview()
    p.plan!.derivatives = [
      derivative({ id: '33333333-3333-4333-8333-333333333333' }),
      derivative({ id: '44444444-4444-4444-8444-444444444444', newAmount: null }),
    ]

    // Phase 1 is all-or-nothing: a half-applied cascade is the defect the
    // whole decomposition exists to close.
    expect(canSaveCascadeEdit(p)).toBe(false)
  })

  it('G-10b. editable with NO plan at all does not block', () => {
    // The server never sends this shape today (`editable: true` always carries
    // a plan), which is precisely why the branch needs a test: without one the
    // guard could be deleted and nothing would notice until a contract change
    // made the shape real — and then it would throw on `plan.derivatives`
    // rather than fall through to a sane default.
    expect(canSaveCascadeEdit(preview({ plan: null }))).toBe(true)
  })

  it('G-10. an empty plan (no derivatives at all) saves', () => {
    const p = preview()
    p.plan!.derivatives = []

    expect(canSaveCascadeEdit(p)).toBe(true)
  })
})

describe('settlementSplit — what a row shows about its own accumulator', () => {
  it('S-1. nothing settled ⇒ nothing to show', () => {
    expect(settlementSplit({ amount: '8000', currency: 'USDT', settledAmount: null })).toBeNull()
  })

  it('S-2. a zero accumulator is still nothing to show', () => {
    // A settle that moved nothing is not a state the operator needs told about,
    // and rendering «выплачено 0» on every untouched row would be noise on the
    // busiest screen in the product.
    expect(settlementSplit({ amount: '8000', currency: 'USDT', settledAmount: '0' })).toBeNull()
  })

  it('S-3. partly settled ⇒ paid and remaining, both figures', () => {
    expect(
      settlementSplit({
        amount: '8000',
        currency: 'USDT',
        settledAmount: '5000',
        settledCurrency: 'USDT',
      }),
    ).toEqual({ settled: 5000, settledCurrency: 'USDT', remaining: 3000 })
  })

  it('S-4. an omitted settledCurrency reads as the row currency, not as a mismatch', () => {
    // The column is written together with the amount, so an absent value on a
    // NON-zero accumulator only happens on a legacy row. Treating it as the
    // row's own currency keeps the subtraction meaningful for the population
    // that actually exists; the plan-level resolver is stricter because it
    // subtracts from a HYPOTHETICAL share, not from the stored figure.
    expect(settlementSplit({ amount: '8000', currency: 'USDT', settledAmount: '5000' })).toEqual({
      settled: 5000,
      settledCurrency: 'USDT',
      remaining: 3000,
    })
  })

  it('S-5. a real currency mismatch reports the paid figure but refuses a remainder', () => {
    expect(
      settlementSplit({
        amount: '50',
        currency: 'USDT',
        settledAmount: '2000',
        settledCurrency: 'UAH',
      }),
    ).toEqual({ settled: 2000, settledCurrency: 'UAH', remaining: null })
  })

  it('S-6. overpaid ⇒ remaining is 0, never negative', () => {
    expect(
      settlementSplit({
        amount: '3000',
        currency: 'USDT',
        settledAmount: '5000',
        settledCurrency: 'USDT',
      }),
    ).toEqual({ settled: 5000, settledCurrency: 'USDT', remaining: 0 })
  })
})
