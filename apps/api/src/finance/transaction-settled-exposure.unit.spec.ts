/**
 * task-cascade-preview-ui (task 5) — `settledAmount` / `settledCurrency` reach
 * the wire.
 *
 * WHY THIS EXISTS. The columns landed with task 1 (PR #599) and are read all
 * over `loadCascadeSnapshot` / `applyEditCascade`, but `mapTx` never projected
 * them and `transactionSchema` never listed them — and because every response
 * crosses `transactionSchema.parse()`, the field was physically stripped even
 * if a caller had returned it. Three screens of task 5 («Выплачено / осталось»
 * in the list, in the detail dialog, and the corrective figure in
 * `SettleSeniorPayoutDialog`) cannot be computed from anything else that is
 * already exposed, so this is a contract change, not a nicety.
 *
 * WHY A UNIT DOUBLE AND NOT ONLY THE REAL-DB SPEC. The mutation gate runs the
 * UNIT suite only and cannot execute an `*.integration.spec.ts` at all
 * (`mutation-gate-integration-specs.md`), so a projection line proved solely by
 * the real-DB spec next door would report as `NoCoverage`. The double here
 * exercises `mapTx` through its real call sites (`findAll` / `findOne`); the
 * companion integration spec still proves the Drizzle column actually arrives.
 *
 * VISIBILITY (the decision this spec pins, not merely describes). The figure is
 * exposed UNMASKED, exactly like `originalAmount`/`exchangeRate` before it, and
 * for the same stated reason: it is a fact about money whose `amount` this
 * viewer is ALREADY shown on this very row. A non-privileged viewer only ever
 * receives rows they are a party to (`findAll`'s SENIOR/JUNIOR/HR/DROP filters
 * scope on `senderId`/`receiverId`), so «сколько из этой суммы уже выплачено»
 * discloses no third party and no counterparty identity. Masking it while
 * leaving `amount` visible would only make the two numbers contradict each
 * other on the operator's screen. SE-4/SE-5 below hold that line: they are the
 * regression guard if someone later "hardens" the projection by nulling it for
 * the very people whose own money it describes.
 */
import { describe, expect, it } from 'vitest'

import { transactionSchema, type SessionUser } from '@crm/shared'

import { makeTransactionsService } from './__test-helpers__/make-transactions-service'

const SENIOR_ID = '11111111-1111-4111-8111-111111111111'
const ADMIN_ID = '22222222-2222-4222-8222-222222222222'
const ROW_ID = '33333333-3333-4333-8333-333333333333'

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
 * A `SENIOR_PENDING_PAYOUT` IOU that has been PARTLY settled: the obligation is
 * 8000 USDT, 5000 of it has actually left the account. This is precisely the
 * population that made the settle dialog lie (it showed 8000 before a payment
 * that would move 3000).
 */
function partlySettledRow() {
  return {
    id: ROW_ID,
    type: 'SENIOR_PENDING_PAYOUT',
    status: 'PENDING_PAYMENT',
    amount: '8000.000000',
    currency: 'USDT',
    settledAmount: '5000.000000',
    settledCurrency: 'USDT',
    originalAmount: null,
    originalCurrency: null,
    exchangeRate: null,
    senderId: null,
    senderLabel: 'COMPANY',
    receiverId: SENIOR_ID,
    receiverLabel: null,
    projectId: null,
    payoutRequestId: null,
    dropCascadeOrigin: null,
    seniorSharePercent: 40,
    receiptDocumentId: null,
    receiptExternalUrl: null,
    txHash: null,
    validatedBy: null,
    validatedAt: null,
    rejectionReason: null,
    notes: null,
    salaryMonth: null,
    txDate: null,
    createdBy: ADMIN_ID,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    deletedAt: null,
    deletedBy: null,
    deletionReason: null,
    sender: null,
    receiver: { displayName: 'Иван Петров', role: 'SENIOR' },
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

describe('settled accumulator on the transaction wire (task 5)', () => {
  it('SE-1. findAll exposes settledAmount/settledCurrency to ADMIN', async () => {
    const svc = serviceReturning(partlySettledRow())

    const [dto] = await svc.findAll(user('ADMIN', ADMIN_ID))

    expect(dto).toMatchObject({ settledAmount: '5000.000000', settledCurrency: 'USDT' })
  })

  it('SE-2. findOne exposes them too — the second mapTx call site', async () => {
    const svc = serviceReturning(partlySettledRow())

    const dto = await svc.findOne(ROW_ID, user('ADMIN', ADMIN_ID))

    expect(dto).toMatchObject({ settledAmount: '5000.000000', settledCurrency: 'USDT' })
  })

  it('SE-3. the wire schema keeps them — a response really does carry the field', async () => {
    const svc = serviceReturning(partlySettledRow())

    const [dto] = await svc.findAll(user('ADMIN', ADMIN_ID))
    const parsed = transactionSchema.parse(dto)

    // The point of this assertion is the `.parse()` in between: the schema is
    // what stripped the field before this task, so a passing SE-1 with a
    // schema that omits it would still ship nothing to the browser.
    expect(parsed.settledAmount).toBe('5000.000000')
    expect(parsed.settledCurrency).toBe('USDT')
  })

  it('SE-4. the senior whose own IOU it is sees their own settled figure', async () => {
    const svc = serviceReturning(partlySettledRow())

    const [dto] = await svc.findAll(user('SENIOR', SENIOR_ID))

    expect(dto?.settledAmount).toBe('5000.000000')
  })

  it('SE-5. a row that never went through a settle reports null, not 0', async () => {
    const svc = serviceReturning({
      ...partlySettledRow(),
      settledAmount: null,
      settledCurrency: null,
    })

    const [dto] = await svc.findAll(user('ADMIN', ADMIN_ID))

    // `null` and `0` are different claims: "never settled" vs "settled nothing".
    // The UI keys its whole «Выплачено» surface off `> 0`, and coercing null to
    // 0 here would be indistinguishable from a real zero at the boundary.
    expect(dto?.settledAmount).toBeNull()
    expect(dto?.settledCurrency).toBeNull()
  })
})
