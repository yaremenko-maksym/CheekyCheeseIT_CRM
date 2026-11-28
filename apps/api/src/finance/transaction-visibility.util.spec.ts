import { ForbiddenException, HttpException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import type { TxWithRelations } from './transaction-mapper.util'
import {
  assertTransactionReadAccess,
  assertTransactionVisible,
} from './transaction-visibility.util'

const ME = 'me-1'
const OTHER = 'other-1'

function user(role: string): SessionUser {
  return { id: ME, role } as unknown as SessionUser
}

function tx(over: { senderId?: string; receiverId?: string; type?: string }): TxWithRelations {
  return {
    senderId: OTHER,
    receiverId: OTHER,
    type: 'INCOME',
    ...over,
  } as unknown as TxWithRelations
}

/** Thunk so each test keeps its own inline `expect(...)`. */
const check = (t: TxWithRelations, role: string) => () => assertTransactionReadAccess(t, user(role))

describe('assertTransactionReadAccess', () => {
  it.each(['ADMIN'])('%s reads any row, including PAYOUT_ADMIN', (role) => {
    expect(check(tx({}), role)).not.toThrow()
    expect(check(tx({ type: 'PAYOUT_ADMIN' }), role)).not.toThrow()
    expect(check(tx({ type: 'PAYOUT_CONFIRMED' }), role)).not.toThrow()
  })

  it.each(['SENIOR', 'DROP'])('%s reads own sender and own receiver rows only', (role) => {
    expect(check(tx({ senderId: ME }), role)).not.toThrow()
    expect(check(tx({ receiverId: ME }), role)).not.toThrow()
    expect(check(tx({}), role)).toThrow(ForbiddenException)
  })

  it.each(['SENIOR', 'DROP'])(
    '%s never reads PAYOUT_ADMIN / PAYOUT_CONFIRMED, even own',
    (role) => {
      expect(check(tx({ senderId: ME, type: 'PAYOUT_ADMIN' }), role)).toThrow(ForbiddenException)
      expect(check(tx({ receiverId: ME, type: 'PAYOUT_ADMIN' }), role)).toThrow(ForbiddenException)
      expect(check(tx({ senderId: ME, type: 'PAYOUT_CONFIRMED' }), role)).toThrow(
        ForbiddenException,
      )
      expect(check(tx({ receiverId: ME, type: 'PAYOUT_CONFIRMED' }), role)).toThrow(
        ForbiddenException,
      )
    },
  )

  it('JUNIOR reads receiver rows only (own sender row is denied)', () => {
    expect(check(tx({ receiverId: ME }), 'JUNIOR')).not.toThrow()
    expect(check(tx({ senderId: ME }), 'JUNIOR')).toThrow(ForbiddenException)
    expect(check(tx({}), 'JUNIOR')).toThrow(ForbiddenException)
  })

  it('HR reads own sender and own receiver rows only; PAYOUT_ADMIN is not excluded', () => {
    expect(check(tx({ senderId: ME }), 'HR')).not.toThrow()
    expect(check(tx({ receiverId: ME }), 'HR')).not.toThrow()
    expect(check(tx({ senderId: ME, type: 'PAYOUT_ADMIN' }), 'HR')).not.toThrow()
    expect(check(tx({}), 'HR')).toThrow(ForbiddenException)
  })

  it('rejects an unknown role even on an own row', () => {
    expect(check(tx({ senderId: ME, receiverId: ME }), 'GUEST')).toThrow(ForbiddenException)
  })
})

describe('assertTransactionVisible — who may see a deleted row', () => {
  const deleted = { deletedAt: new Date('2026-01-01T00:00:00Z') }
  const live = { deletedAt: null }

  /** The HTTP status the gate threw, or null when it did not throw. */
  function statusOf(fn: () => void): number | null {
    try {
      fn()
      return null
    } catch (err) {
      if (err instanceof HttpException) return err.getStatus()
      throw err
    }
  }

  it('ADMIN sees a deleted row', () => {
    expect(statusOf(() => assertTransactionVisible(deleted, user('ADMIN')))).toBeNull()
  })

  it.each(['SENIOR', 'JUNIOR', 'HR', 'DROP', 'ACCOUNTANT', 'GUEST'])(
    '%s gets 404 on a deleted row',
    (role) => {
      expect(statusOf(() => assertTransactionVisible(deleted, user(role)))).toBe(404)
    },
  )

  it('an anonymous caller (null) gets 404 on a deleted row, not a crash', () => {
    expect(statusOf(() => assertTransactionVisible(deleted, null))).toBe(404)
  })

  it('an anonymous caller (null) sees a live row', () => {
    expect(statusOf(() => assertTransactionVisible(live, null))).toBeNull()
  })
})
