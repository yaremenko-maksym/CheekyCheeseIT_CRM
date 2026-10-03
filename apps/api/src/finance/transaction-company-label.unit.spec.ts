/**
 * server-text PR3 — the company account is booked as the CODE `'COMPANY'`
 * (not the Russian «Счёт компании» prose), and masking treats both markers the
 * same during the rollout window.
 *
 * RBAC invariant (security-critical): swapping the stored marker must not
 * widen who sees the real label. Non-privileged viewers (SENIOR / JUNIOR /
 * DROP / HR) always get the brand `CheekyCheeseIT` with the id stripped;
 * ADMIN / ACCOUNTANT get the stored value verbatim (the web localizes the code).
 *
 * The two markers are exercised through the same `findAll` / `findOne` call
 * sites `mapTx` serves, with a unit double (the mutation gate cannot execute
 * integration specs — `mutation-gate-integration-specs.md`).
 */
import { describe, expect, it } from 'vitest'

import { COMPANY_ACCOUNT_LABEL, type SessionUser } from '@crm/shared'

import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

const ADMIN_ID = '22222222-2222-4222-8222-222222222222'
const ACCOUNTANT_ID = '44444444-4444-4444-8444-444444444444'
const VIEWER_ID = '11111111-1111-4111-8111-111111111111'
const ROW_ID = '33333333-3333-4333-8333-333333333333'

// Legacy stored prose that rows written before the code switch may still carry.
const LEGACY_MARKER = 'Счёт компании'

function user(role: SessionUser['role'], id: string): SessionUser {
  return {
    id,
    email: `${role.toLowerCase()}@example.com`,
    displayName: role,
    avatarUrl: null,
    role,
  } as SessionUser
}

/**
 * A company-paid row. `side: 'sender'` — the company is the sender and the
 * viewer is the receiver; `side: 'receiver'` — the viewer deposited into the
 * company account (COMPANY_DEPOSIT).
 */
function companyPaidRow(
  type: string,
  viewerRole: string,
  marker: string,
  side: 'sender' | 'receiver' = 'sender',
) {
  return {
    id: ROW_ID,
    type,
    status: 'PAID',
    amount: '100.000000',
    currency: 'USDT',
    settledAmount: null,
    settledCurrency: null,
    originalAmount: null,
    originalCurrency: null,
    exchangeRate: null,
    senderId: side === 'sender' ? null : VIEWER_ID,
    senderLabel: side === 'sender' ? marker : null,
    receiverId: side === 'sender' ? VIEWER_ID : null,
    receiverLabel: side === 'receiver' ? marker : null,
    projectId: null,
    payoutRequestId: null,
    dropCascadeOrigin: null,
    seniorSharePercent: null,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    txHash: null,
    validatedBy: null,
    validatedAt: null,
    rejectionReason: null,
    notes: null,
    salaryMonth: null,
    txDate: null,
    fundingSource: null,
    createdBy: ADMIN_ID,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    deletedAt: null,
    deletedBy: null,
    deletionReason: null,
    sender: side === 'receiver' ? { displayName: 'Иван Петров', role: viewerRole } : null,
    receiver: side === 'sender' ? { displayName: 'Иван Петров', role: viewerRole } : null,
    project: null,
    payoutRequest: null,
  }
}

function serviceReturning(row: unknown) {
  return makeTransactionsService({
    db: {
      db: {
        query: {
          transactions: {
            findMany: async () => [row],
            findFirst: async () => row,
          },
        },
      },
    } as never,
  })
}

describe('COMPANY_ACCOUNT_LABEL contract', () => {
  it('is the stable code the web localizes — not prose', () => {
    expect(COMPANY_ACCOUNT_LABEL).toBe('COMPANY')
  })
})

describe.each([
  ['code (new writes)', COMPANY_ACCOUNT_LABEL],
  ['legacy prose (pre-migration rows)', LEGACY_MARKER],
])('company-account counterparty masking — %s', (_name, marker) => {
  it.each([
    ['SENIOR', 'SENIOR_PENDING_PAYOUT'],
    ['DROP', 'PAYOUT_DROP'],
    ['JUNIOR', 'SALARY'],
  ] as const)('%s viewer sees CheekyCheeseIT, no id (sender side)', async (role, type) => {
    const svc = serviceReturning(companyPaidRow(type, role, marker))

    const [dto] = await svc.findAll(user(role, VIEWER_ID))

    expect(dto?.senderLabel).toBe('CheekyCheeseIT')
    expect(dto?.senderId).toBeNull()
    expect(dto?.senderName).toBeNull()
  })

  it('COMPANY_DEPOSIT receiver side is masked for the depositing SENIOR', async () => {
    const svc = serviceReturning(companyPaidRow('COMPANY_DEPOSIT', 'SENIOR', marker, 'receiver'))

    const dto = await svc.findOne(ROW_ID, user('SENIOR', VIEWER_ID))

    expect(dto.receiverLabel).toBe('CheekyCheeseIT')
  })

  it.each([
    ['ADMIN', ADMIN_ID],
    ['ACCOUNTANT', ACCOUNTANT_ID],
  ] as const)('%s sees the stored marker verbatim', async (role, id) => {
    const svc = serviceReturning(companyPaidRow('SENIOR_PENDING_PAYOUT', 'SENIOR', marker))

    const [dto] = await svc.findAll(user(role, id))

    expect(dto?.senderLabel).toBe(marker)
  })
})
