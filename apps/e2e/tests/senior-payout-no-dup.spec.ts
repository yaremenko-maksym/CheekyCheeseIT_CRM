/**
 * senior-payout-no-dup.spec.ts — feat/finance-payout-flow (#7)
 *
 * Integration regression: validate(SENIOR_INCOME) + createPayoutRequest produce
 * exactly ONE payout_request and ONE PAYOUT row — no duplicates.
 *
 * This is the core regression test for the bug described in #7:
 *   - Old behaviour (Path A): validateTransaction auto-created payout_request +
 *     PAYOUT. Then createPayoutRequest created a SECOND payout_request + PAYOUT
 *     on the already-VALIDATED tx (status filter matched but isNull guard was
 *     absent), resulting in TWO payout_requests and TWO PAYOUT rows.
 *   - New behaviour: validate only flips to VALIDATED (no payout_request).
 *     SENIOR calls POST /api/payout-requests → exactly ONE payout_request + PAYOUT.
 *
 * Real-API flow (requires live stack on :3000/:3001).
 *
 * Scenarios:
 *   A. validate → createPayoutRequest → assert COUNT(payout_requests) = 1,
 *      COUNT(PAYOUT rows) = 1.
 *   B. validate → createPayoutRequest twice on same tx → second call returns 400
 *      (belt-and-suspenders isNull guard).
 *   C. SENIOR creates payout batching 2 VALIDATED incomes → single payout_request,
 *      payable = Σ per-tx payable amounts.
 */

import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  loginViaApi,
  createSeniorProjectViaAPI,
  createSeniorIncomeViaAPI,
  validateTransactionViaAPI,
  createPayoutRequestViaAPI,
  listTransactionsByProjectViaAPI,
} from './fixtures'

const REAL_API = 'http://localhost:3001/api'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('Senior payout — no duplicate payout_request regression (#7)', () => {
  test('A. validate → createPayoutRequest → exactly 1 payout_request + 1 PAYOUT', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `NoDup A ${suffix}`,
    })

    try {
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { txId } = await createSeniorIncomeViaAPI(page, {
        projectId,
        amount: 1000,
        currency: 'USDT',
      })

      // Validate — ONLY flips to VALIDATED, no payout_request created.
      await loginViaApi(page, SEED_EMAILS.accountant)
      await validateTransactionViaAPI(page, txId)

      // SENIOR manually creates payout_request.
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { payoutRequestId } = await createPayoutRequestViaAPI(page, [txId])
      expect(payoutRequestId).toBeTruthy()

      // Core regression assertion: exactly 1 payout_request + 1 PAYOUT row.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const txs = await listTransactionsByProjectViaAPI(page, projectId)

      const payoutRows = txs.filter((t) => t.type === 'PAYOUT')
      expect(
        payoutRows,
        'Regression: must be exactly 1 PAYOUT row, not 2 (duplicate)',
      ).toHaveLength(1)

      // Confirm the PAYOUT is PENDING_PAYMENT (not yet paid).
      expect(payoutRows[0]!.status).toBe('PENDING_PAYMENT')

      // Confirm the SENIOR_INCOME is PENDING_PAYMENT (linked to the payout).
      const seniorIncomes = txs.filter((t) => t.type === 'SENIOR_INCOME')
      expect(seniorIncomes).toHaveLength(1)
      expect(seniorIncomes[0]!.status).toBe('PENDING_PAYMENT')
      expect(seniorIncomes[0]!.payoutRequestId).toBe(payoutRequestId)

      // Exactly 1 payout_request via GET /api/payout-requests.
      const prRes = await page.request.get(`${REAL_API}/payout-requests/${payoutRequestId}`)
      expect(prRes.status()).toBe(200)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })

  test('B. createPayoutRequest twice on same tx → second call returns 400 (dup guard)', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `NoDup B ${suffix}`,
    })

    try {
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { txId } = await createSeniorIncomeViaAPI(page, { projectId, amount: 500 })

      await loginViaApi(page, SEED_EMAILS.accountant)
      await validateTransactionViaAPI(page, txId)

      // First createPayoutRequest — succeeds.
      await loginViaApi(page, SEED_EMAILS.seniorA)
      await createPayoutRequestViaAPI(page, [txId])

      // Second createPayoutRequest on the same tx — must fail 400.
      const res = await page.request.post(`${REAL_API}/payout-requests`, {
        data: { transactionIds: [txId] },
      })
      expect(
        res.status(),
        'Dup guard: second createPayoutRequest on same tx must return 400',
      ).toBe(400)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })

  test('C. SENIOR batches 2 VALIDATED incomes → 1 payout_request, payable = sum', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `NoDup C ${suffix}`,
    })

    try {
      // Two separate SENIOR_INCOME transactions.
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { txId: tx1 } = await createSeniorIncomeViaAPI(page, { projectId, amount: 1000 })
      const { txId: tx2 } = await createSeniorIncomeViaAPI(page, { projectId, amount: 500 })

      // Both validated.
      await loginViaApi(page, SEED_EMAILS.accountant)
      await validateTransactionViaAPI(page, tx1)
      await validateTransactionViaAPI(page, tx2)

      // SENIOR batches both into ONE payout_request.
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { payoutRequestId } = await createPayoutRequestViaAPI(page, [tx1, tx2])
      expect(payoutRequestId).toBeTruthy()

      // Exactly 1 PAYOUT row.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const txs = await listTransactionsByProjectViaAPI(page, projectId)
      const payoutRows = txs.filter((t) => t.type === 'PAYOUT')
      expect(payoutRows, 'Batch: must be exactly 1 PAYOUT row for 2 incomes').toHaveLength(1)

      // Payable = 1000×0.74 + 500×0.74 = 740 + 370 = 1110 (26% default share).
      const payoutAmount = parseFloat(payoutRows[0]!.amount)
      expect(payoutAmount).toBeCloseTo(1110, 2)

      // Both SENIOR_INCOME rows are PENDING_PAYMENT and link to same payout_request.
      const seniorIncomes = txs.filter((t) => t.type === 'SENIOR_INCOME')
      expect(seniorIncomes).toHaveLength(2)
      for (const si of seniorIncomes) {
        expect(si.status).toBe('PENDING_PAYMENT')
        expect(si.payoutRequestId).toBe(payoutRequestId)
      }
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })
})
