import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import type { Transaction } from '../database/schema'
import { assertCanViewInvoice } from './invoice-view-access.util'

const viewer = (role: SessionUser['role'], id = 'viewer-1'): SessionUser =>
  ({ id, role }) as SessionUser

const tx = (over: Partial<Transaction>): Transaction =>
  ({
    type: 'SENIOR_INCOME',
    senderId: 'sender-1',
    receiverId: 'receiver-1',
    ...over,
  }) as Transaction

const DENIED = { response: { code: 'INVOICE_ACCESS_DENIED', statusCode: 403 } }

function caught(fn: () => void): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

describe('assertCanViewInvoice', () => {
  it('ADMIN and ACCOUNTANT may view any invoice', () => {
    expect(() => assertCanViewInvoice(viewer('ADMIN'), tx({}))).not.toThrow()
    expect(() => assertCanViewInvoice(viewer('ACCOUNTANT'), tx({}))).not.toThrow()
  })

  it.each(['SENIOR', 'JUNIOR', 'HR'] as const)('%s who is the counterparty may view', (role) => {
    expect(() => assertCanViewInvoice(viewer(role, 'receiver-1'), tx({}))).not.toThrow()
  })

  it.each(['SENIOR', 'JUNIOR', 'HR'] as const)(
    '%s who is not the counterparty is denied',
    (role) => {
      expect(caught(() => assertCanViewInvoice(viewer(role), tx({})))).toMatchObject(DENIED)
    },
  )

  it('PAYOUT counterparty is the sender, not the receiver', () => {
    const payout = tx({ type: 'PAYOUT' })
    expect(() => assertCanViewInvoice(viewer('SENIOR', 'sender-1'), payout)).not.toThrow()
    expect(
      caught(() => assertCanViewInvoice(viewer('SENIOR', 'receiver-1'), payout)),
    ).toMatchObject(DENIED)
  })

  it('a transaction with no counterparty is denied to non-privileged viewers', () => {
    expect(
      caught(() => assertCanViewInvoice(viewer('SENIOR', 'x'), tx({ type: 'EXPENSE' }))),
    ).toMatchObject(DENIED)
  })

  it('a NULL counterparty never matches a viewer id', () => {
    expect(
      caught(() =>
        assertCanViewInvoice(viewer('SENIOR', 'x'), tx({ type: 'SALARY', receiverId: null })),
      ),
    ).toMatchObject(DENIED)
  })
})
