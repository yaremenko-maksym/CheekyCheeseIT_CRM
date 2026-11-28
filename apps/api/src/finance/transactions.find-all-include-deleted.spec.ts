/**
 * PR #1521 (ACCOUNTANT removed): `findAll`'s «show deleted» toggle widens the
 * query only for ADMIN. Every other role, and an unknown one, keeps the
 * `deleted_at IS NULL` filter even when it passes `includeDeleted: true`.
 *
 * The seam is the query the service hands to `db.query.transactions.findMany`:
 * whether it carries a `where` is the whole decision under test.
 */
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

function user(role: string): SessionUser {
  return {
    id: `${role.toLowerCase()}-id`,
    role,
    displayName: `Test ${role}`,
    email: `${role.toLowerCase()}@test.com`,
    avatarUrl: null,
    avatarDocumentId: null,
    seniorSharePercent: 26,
  } as unknown as SessionUser
}

/** Runs findAll and returns the options object passed to findMany. */
async function findManyArgs(
  role: string,
  filters?: { includeDeleted?: boolean },
): Promise<Record<string, unknown>> {
  const calls: Record<string, unknown>[] = []
  const dbStub = {
    db: {
      query: {
        transactions: {
          findMany: (args: Record<string, unknown>) => {
            calls.push(args)
            return Promise.resolve([])
          },
        },
        users: { findMany: () => Promise.resolve([]) },
      },
    },
  }
  const svc = makeTransactionsService({ db: dbStub as never })
  await svc.findAll(user(role), filters)
  expect(calls).toHaveLength(1)
  return calls[0]!
}

describe('TransactionsService.findAll — includeDeleted widens the query only for ADMIN', () => {
  it('ADMIN with includeDeleted: true → no deleted_at filter', async () => {
    const args = await findManyArgs('ADMIN', { includeDeleted: true })
    expect(args).not.toHaveProperty('where')
  })

  it('ADMIN without includeDeleted → deleted_at filter stays', async () => {
    const args = await findManyArgs('ADMIN')
    expect(args).toHaveProperty('where')
  })

  it.each(['SENIOR', 'JUNIOR', 'HR', 'DROP', 'ACCOUNTANT', 'GUEST'])(
    '%s with includeDeleted: true → deleted_at filter stays',
    async (role) => {
      const args = await findManyArgs(role, { includeDeleted: true })
      expect(args).toHaveProperty('where')
    },
  )
})
