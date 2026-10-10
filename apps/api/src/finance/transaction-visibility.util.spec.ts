import { ForbiddenException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import type { TxWithRelations } from './transaction-mapper.util'
import { assertTransactionReadAccess } from './transaction-visibility.util'

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
  it.each(['ADMIN', 'ACCOUNTANT'])('%s reads any row, including PAYOUT_ADMIN', (role) => {
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
