/**
 * MED-Q (security-review round 6) — the two receipt entrances
 * (`attachOrReplaceReceipt`, `adminUpdateTransaction`) map ONLY an on-chain
 * registry unique violation to FINANCE_TX_HASH_ALREADY_CONSUMED; any other
 * unique violation must pass through unchanged.
 *
 * Unit double (the mutation gate runs the unit suite only — see
 * `.claude/rules/common/mutation-gate-integration-specs.md`): the DB
 * transaction rejects with a Postgres 23505 and we assert what the caller sees.
 */
import { describe, expect, it } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

const ADMIN: SessionUser = {
  id: 'admin-id',
  role: 'ADMIN',
  displayName: 'Test ADMIN',
  email: 'admin-id@test.com',
  avatarUrl: null,
  avatarDocumentId: null,
  seniorSharePercent: 26,
} as SessionUser

const violation = (constraint: string) =>
  Object.assign(new Error('dup'), { code: '23505', constraint })

function txRow() {
  return {
    id: 'tx-1',
    type: 'ADMIN_INCOME',
    status: 'PENDING',
    amount: '10.000000',
    currency: 'UAH',
    senderId: null,
    receiverId: null,
    recipientId: null,
    projectId: null,
    fundingSource: null,
    payoutRequestId: null,
    notes: null,
    txHash: null,
    createdBy: 'admin-id',
    deletedAt: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    sender: null,
    receiver: null,
    project: null,
    payoutRequest: null,
  }
}

function makeSvc(thrown: unknown) {
  return makeTransactionsService({
    db: {
      db: {
        query: { transactions: { findFirst: async () => txRow() } },
        update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
        transaction: async () => {
          throw thrown
        },
      },
    } as never,
  })
}

describe.each([
  [
    'attachOrReplaceReceipt',
    (svc: ReturnType<typeof makeSvc>) =>
      svc.attachOrReplaceReceipt('tx-1', { receiptExternalUrl: 'https://example.test/r' }, ADMIN),
  ],
  [
    'adminUpdateTransaction',
    (svc: ReturnType<typeof makeSvc>) =>
      svc.adminUpdateTransaction('tx-1', { notes: 'edited' }, ADMIN),
  ],
])('%s — registry conflict mapping', (_name, run) => {
  it.each(['uq_consumed_tx_hashes_active_tx_hash', 'uq_consumed_tx_hashes_tx_hash'])(
    'maps a %s violation to a 400 FINANCE_TX_HASH_ALREADY_CONSUMED',
    async (constraint) => {
      await expect(run(makeSvc(violation(constraint)))).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({ code: 'FINANCE_TX_HASH_ALREADY_CONSUMED' }),
      })
    },
  )

  it('rethrows an unrelated unique violation unchanged', async () => {
    const other = violation('uq_transactions_salary_idempotency_key')
    await expect(run(makeSvc(other))).rejects.toBe(other)
  })
})
