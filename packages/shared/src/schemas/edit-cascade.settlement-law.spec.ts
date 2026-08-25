/**
 * task-cascade-preview-ui (task 5) — the «сколько ещё осталось выплатить» law,
 * extracted so it has ONE implementation instead of four.
 *
 * WHERE IT WAS ABOUT TO BE COPIED. `resolveDerivative` already stated it for a
 * RECOMPUTED share (`remainingToPay`). Task 5 needs the same subtraction for a
 * row's OWN stored amount in three more places — the transactions list, the
 * detail dialog, and `SettleSeniorPayoutDialog`'s summary — and the arithmetic
 * is not the interesting part: the two REFUSALS are.
 *
 *   1. Never negative. An overpaid row owes nothing; «осталось −100» is not a
 *      debt, it is a number the operator cannot act on.
 *   2. Null across a currency boundary. Subtracting a UAH accumulator from a
 *      USDT share is not an approximation, it is a wrong number — the same
 *      refusal-to-guess `NON_USDT_CURRENCY` exists to state (HIGH-2,
 *      security-review round 1). A screen that renders that difference as
 *      «к доплате» would be inviting a payment computed from two units.
 *
 * A copy of this on the frontend would agree on the day it was written and
 * drift on the first rounding change — the file's own `floorAmountAtAccumulator`
 * doc says it in one line: «A law with three implementations is three laws».
 */
import { describe, expect, it } from 'vitest'

import { remainingAgainstAccumulator, settledCurrencyMismatch } from './edit-cascade'

describe('settledCurrencyMismatch — when the two figures are not the same unit', () => {
  it('SL-1. no accumulator at all ⇒ no mismatch, whatever the currency column says', () => {
    expect(settledCurrencyMismatch(0, null, 'USDT')).toBe(false)
    expect(settledCurrencyMismatch(0, 'UAH', 'USDT')).toBe(false)
  })

  it('SL-2. same currency ⇒ comparable', () => {
    expect(settledCurrencyMismatch(500, 'USDT', 'USDT')).toBe(false)
  })

  it('SL-3. different currency ⇒ not comparable', () => {
    expect(settledCurrencyMismatch(500, 'UAH', 'USDT')).toBe(true)
  })

  it('SL-4. money paid in an UNRECORDED currency counts as a mismatch, not as a match', () => {
    // "Unknown" is not "assume it matches" — the same principle
    // NO_SHARE_SNAPSHOT applies one field over.
    expect(settledCurrencyMismatch(500, null, 'USDT')).toBe(true)
  })
})

describe('remainingAgainstAccumulator — what is still owed on a row', () => {
  it('SL-5. subtracts what has actually been paid from what is owed', () => {
    expect(remainingAgainstAccumulator(8000, 5000, false)).toBe(3000)
  })

  it('SL-6. nothing settled ⇒ the whole amount is still owed', () => {
    expect(remainingAgainstAccumulator(8000, 0, false)).toBe(8000)
  })

  it('SL-7. overpaid ⇒ zero, never a negative debt', () => {
    expect(remainingAgainstAccumulator(3000, 5000, false)).toBe(0)
  })

  it('SL-8. a currency mismatch yields null — no invented difference', () => {
    expect(remainingAgainstAccumulator(50, 2000, true)).toBeNull()
  })

  it('SL-9. rounds at money scale — no float tail reaches an operator', () => {
    // 0.1 + 0.2 arithmetic in the money path is how «199.99999999999997»
    // reaches a screen. Six decimals is the DB's own numeric(_, 6) scale.
    expect(remainingAgainstAccumulator(200.3, 0.30000000000000004, false)).toBe(200)
  })
})
