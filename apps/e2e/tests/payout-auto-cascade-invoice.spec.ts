/**
 * payout-auto-cascade-invoice.spec.ts — task-autotest-business-logic-coverage (B).
 *
 * Phase 2 auto-50/50 cascade integration with the aggregate invoice creation.
 * The existing `drop-distribution.spec.ts` covers the cascade math; this spec
 * verifies that the PAYOUT cascade ALSO triggers the aggregate-invoice
 * generation in the same atomic flow.
 *
 * Real-API.
 *
 * Scenarios:
 *   1. SENIOR creates SENIOR_INCOME → ACCOUNTANT validates → SENIOR pays
 *      payout_request → cascade emits PAYOUT (PAID) + invoice (PENDING with
 *      COMPANY auto-sig).
 *   2. The invoice's `transactionId` equals the PAYOUT row id.
 *   3. The PAYOUT amount equals the invoice's amount (= SENIOR_INCOME × 0.74
 *      for a 26% senior share).
 */

import { test, expect, REAL_API_BASE } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  loginViaApi,
  createSeniorProjectViaAPI,
  createSeniorIncomeViaAPI,
  validateTransactionViaAPI,
  createPayoutRequestViaAPI,
  payPayoutRequestViaAPI,
  listTransactionsByProjectViaAPI,
} from './fixtures'

const REAL_API = `${REAL_API_BASE}/api`

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('Phase 2 PAYOUT cascade → aggregate invoice integration', () => {
  test('SENIOR pay → cascade emits PAYOUT + auto invoice (status=PENDING, COMPANY auto-sig)', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `Cascade Invoice ${suffix}`,
    })

    try {
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { txId } = await createSeniorIncomeViaAPI(page, { projectId, amount: 1000 })

      // feat/finance-payout-flow (#7): validate only flips to VALIDATED.
      await loginViaApi(page, SEED_EMAILS.accountant)
      await validateTransactionViaAPI(page, txId)

      // SENIOR manually creates the payout_request.
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { payoutRequestId } = await createPayoutRequestViaAPI(page, [txId])
      expect(payoutRequestId).toBeTruthy()

      const paid = await payPayoutRequestViaAPI(page, payoutRequestId)
      expect(paid.status).toBe('PAID')

      // PAYOUT row exists on the project.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const txs = await listTransactionsByProjectViaAPI(page, projectId)
      const payoutRows = txs.filter((t) => t.type === 'PAYOUT')
      expect(payoutRows).toHaveLength(1)
      const payoutRow = payoutRows[0]!
      expect(payoutRow.status).toBe('PAID')
      const payoutAmount = parseFloat(payoutRow.amount)
      // 1000 × (1 - 26/100) = 740.
      expect(payoutAmount).toBeCloseTo(740, 2)

      // Auto-invoice on the PAYOUT id. Retry briefly to allow async PDF gen.
      let invoice: Record<string, unknown> | null = null
      for (let attempt = 0; attempt < 5; attempt++) {
        const res = await page.request.get(`${REAL_API}/invoices/${payoutRow.id}`)
        if (res.status() === 200) {
          invoice = (await res.json()) as Record<string, unknown>
          break
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      expect(invoice, 'PAYOUT cascade must auto-create an invoice').toBeTruthy()
      expect(invoice!['status']).toBe('PENDING')
      expect(invoice!['transactionId']).toBe(payoutRow.id)
      // Amount equals the PAYOUT amount (74% of SENIOR_INCOME).
      expect(parseFloat(invoice!['amount'] as string)).toBeCloseTo(payoutAmount, 2)

      // 1 COMPANY auto-signature.
      const sigs = (invoice!['signatures'] as Array<Record<string, unknown>>) ?? []
      expect(sigs.length).toBe(1)
      expect(sigs[0]!['signerRole']).toBe('COMPANY')
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })
})
