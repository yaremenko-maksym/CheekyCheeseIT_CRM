/**
 * COMPANY_ACCOUNT_LABEL is a persisted wire code: it is stored in
 * `transactions.sender_label` / `receiver_label` and compared by the web
 * (`displayCounterpartyLabel`). Existing DB rows carry the literal 'COMPANY',
 * so the value is a contract — pin it against a known literal.
 */
import { describe, expect, it } from 'vitest'
import { COMPANY_ACCOUNT_LABEL } from './finance'

describe('COMPANY_ACCOUNT_LABEL', () => {
  it('is the literal code already stored in transactions rows', () => {
    expect(COMPANY_ACCOUNT_LABEL).toBe('COMPANY')
  })
})
