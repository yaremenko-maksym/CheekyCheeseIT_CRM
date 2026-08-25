/**
 * task-cascade-preview-ui (task 5) — the wire contract for the settle
 * accumulator (`settledAmount` / `settledCurrency`).
 *
 * WHY THE CURRENCY ENUM IS PINNED FIGURE BY FIGURE. `settledCurrency` is not
 * decoration: the whole «уже выплачено / к доплате» arithmetic is only valid
 * when it EQUALS the row's own `currency`, and the cascade plan refuses to
 * subtract across a mismatch on purpose (`NON_USDT_CURRENCY`). A schema that
 * silently accepted `'BTC'` — or, as the mutation gate demonstrated on this
 * exact line, an EMPTY member list — would let a figure the UI is about to
 * subtract arrive in a unit nobody checked. So each of the four accepted
 * currencies is asserted by name and an unknown one is asserted rejected: that
 * is the behaviour, and it is also what makes the line observable.
 */
import { describe, expect, it } from 'vitest'

import { transactionSchema } from './finance'

const BASE_TX = {
  id: '33333333-3333-4333-8333-333333333333',
  type: 'SENIOR_PENDING_PAYOUT',
  status: 'PENDING_PAYMENT',
  amount: '8000',
  currency: 'USDT',
  senderId: null,
  senderLabel: 'COMPANY',
  senderName: null,
  receiverId: null,
  receiverLabel: null,
  receiverName: 'Иван Петров',
  projectId: null,
  projectName: null,
  payoutRequestId: null,
  seniorSharePercent: 40,
  receiptDocumentId: null,
  receiptExternalUrl: null,
  txHash: null,
  txFromAddress: null,
  validatedBy: null,
  validatedAt: null,
  rejectionReason: null,
  notes: null,
  salaryMonth: null,
  txDate: null,
  createdBy: '44444444-4444-4444-8444-444444444444',
  createdAt: '2026-08-05T10:00:00.000Z',
  updatedAt: '2026-08-05T10:00:00.000Z',
}

describe('transactionSchema — settle accumulator (task 5)', () => {
  it('SA-1. carries the partly-settled figure through untouched', () => {
    const result = transactionSchema.safeParse({
      ...BASE_TX,
      settledAmount: '5000.000000',
      settledCurrency: 'USDT',
    })

    expect(result.success).toBe(true)
    // The obligation and what has actually been paid against it are two
    // different numbers, and both survive the round-trip. Before this task the
    // second one was stripped here, which is why the settle dialog could only
    // ever show the first.
    expect(result.data?.amount).toBe('8000')
    expect(result.data?.settledAmount).toBe('5000.000000')
    expect(result.data?.settledCurrency).toBe('USDT')
  })

  it('SA-2. a legacy DTO with neither field still parses', () => {
    const result = transactionSchema.safeParse(BASE_TX)

    expect(result.success).toBe(true)
    expect(result.data?.settledAmount).toBeUndefined()
    expect(result.data?.settledCurrency).toBeUndefined()
  })

  it('SA-3. an explicit null survives as null — "never settled", not "settled nothing"', () => {
    const result = transactionSchema.safeParse({
      ...BASE_TX,
      settledAmount: null,
      settledCurrency: null,
    })

    expect(result.success).toBe(true)
    expect(result.data?.settledAmount).toBeNull()
    expect(result.data?.settledCurrency).toBeNull()
  })

  it.each(['USDT', 'USD', 'EUR', 'UAH'])(
    'SA-4. accepts %s as a settle currency — each of the four by name',
    (currency) => {
      const result = transactionSchema.safeParse({
        ...BASE_TX,
        settledAmount: '10',
        settledCurrency: currency,
      })

      expect(result.success).toBe(true)
      expect(result.data?.settledCurrency).toBe(currency)
    },
  )

  it.each(['BTC', 'GBP', 'usdt', ''])(
    'SA-5. rejects %p — a unit nobody agreed on never reaches the subtraction',
    (currency) => {
      const result = transactionSchema.safeParse({
        ...BASE_TX,
        settledAmount: '10',
        settledCurrency: currency,
      })

      expect(result.success).toBe(false)
    },
  )
})
