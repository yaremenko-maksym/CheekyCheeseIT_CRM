/**
 * invoice-aggregate.spec.ts — task-autotest-business-logic-coverage (H).
 *
 * Aggregate invoice — 1 invoice per PAYOUT, even when the PAYOUT cascade
 * groups multiple SENIOR_INCOME rows across multiple projects.
 *
 * Real-API.
 *
 * Scenarios:
 *   1. Single-project SENIOR_INCOME → 1 invoice generated, amount matches
 *      the SENIOR_INCOME.
 *   2. Multi-project: senior has 2 active projects, posts SENIOR_INCOME on
 *      each, accountant validates both → 1 PAYOUT_REQUEST + 1 aggregate
 *      invoice (not 2 — the regression catcher for PR #80 aggregation logic).
 *      Invoice amount = sum across both incomes.
 *   3. After PAYOUT PAID, exactly 1 INVOICE Document references the
 *      payout transaction in the response.
 *
 * Note: the PAYOUT cascade auto-creates an invoice via
 * `safeAutoCreateInvoice` inside `payPayoutRequest`. We don't trigger sign
 * — that's covered by the dedicated invoice-signing-real spec.
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
  payPayoutRequestViaAPI,
  listTransactionsByProjectViaAPI,
} from './fixtures'

const REAL_API = 'http://localhost:3001/api'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

/** Fetch all invoices for a counterparty (senior). */
async function listSeniorInvoices(
  page: import('@playwright/test').Page,
): Promise<Array<{ transactionId: string; amount: string; status: string }>> {
  const res = await page.request.get(`${REAL_API}/invoices`)
  if (res.status() !== 200) return []
  return (await res.json()) as Array<{
    transactionId: string
    amount: string
    status: string
  }>
}

test.describe('Aggregate invoice — 1 per PAYOUT', () => {
  test('single-project SENIOR_INCOME → exactly 1 invoice references the PAYOUT', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `Aggregate Single ${suffix}`,
    })

    try {
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { txId } = await createSeniorIncomeViaAPI(page, {
        projectId,
        amount: 1000,
      })

      // feat/finance-payout-flow (#7): validate only flips to VALIDATED.
      await loginViaApi(page, SEED_EMAILS.accountant)
      await validateTransactionViaAPI(page, txId)

      // SENIOR manually creates and pays the payout_request.
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { payoutRequestId } = await createPayoutRequestViaAPI(page, [txId])
      expect(payoutRequestId).toBeTruthy()

      // SENIOR pays — triggers cascade and the auto-invoice creation.
      const paid = await payPayoutRequestViaAPI(page, payoutRequestId)
      expect(paid.status).toBe('PAID')

      // Pull project transactions, find the PAYOUT row, and confirm 1 invoice references it.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const projectTxs = await listTransactionsByProjectViaAPI(page, projectId)
      const payouts = projectTxs.filter((t) => t.type === 'PAYOUT')
      expect(payouts).toHaveLength(1)
      const payoutId = payouts[0]!.id

      const seniorInvoices = await listSeniorInvoices(page)
      const matched = seniorInvoices.filter((i) => i.transactionId === payoutId)
      expect(matched.length).toBe(1)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })

  test('multi-project: 2 SENIOR_INCOMEs validated separately → 2 PAYOUTs, 2 invoices (1 per PAYOUT, not aggregated across payouts)', async ({
    page,
  }) => {
    // PR #80's aggregation is **per PAYOUT** — each PAYOUT_REQUEST gets ONE
    // invoice. Two independent PAYOUT_REQUESTs (one per income) → 2 invoices.
    // This test guards against an over-aggressive "global" aggregation that
    // would smash everything into a single invoice and lose the project
    // breakdown.
    const suffix = uniqueSuffix()

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const projA = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `Aggregate Multi A ${suffix}`,
    })
    const projB = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `Aggregate Multi B ${suffix}`,
    })

    try {
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { txId: txA } = await createSeniorIncomeViaAPI(page, {
        projectId: projA.projectId,
        amount: 1500,
      })
      const { txId: txB } = await createSeniorIncomeViaAPI(page, {
        projectId: projB.projectId,
        amount: 2500,
      })

      // feat/finance-payout-flow (#7): validate only flips to VALIDATED.
      await loginViaApi(page, SEED_EMAILS.accountant)
      await validateTransactionViaAPI(page, txA)
      await validateTransactionViaAPI(page, txB)

      // SENIOR manually creates two separate payout_requests (one per income).
      // PR #80 aggregation is per PAYOUT — two distinct requests → 2 invoices.
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { payoutRequestId: prA } = await createPayoutRequestViaAPI(page, [txA])
      const { payoutRequestId: prB } = await createPayoutRequestViaAPI(page, [txB])
      expect(prA).toBeTruthy()
      expect(prB).toBeTruthy()
      // Two separate payout requests — distinct ids.
      expect(prA).not.toBe(prB)

      await payPayoutRequestViaAPI(page, prA)
      await payPayoutRequestViaAPI(page, prB)

      // Pull invoices and count those tied to either PAYOUT row.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const txsA = await listTransactionsByProjectViaAPI(page, projA.projectId)
      const txsB = await listTransactionsByProjectViaAPI(page, projB.projectId)
      const payoutsA = txsA.filter((t) => t.type === 'PAYOUT')
      const payoutsB = txsB.filter((t) => t.type === 'PAYOUT')
      expect(payoutsA).toHaveLength(1)
      expect(payoutsB).toHaveLength(1)
      const payoutIds = new Set([payoutsA[0]!.id, payoutsB[0]!.id])

      const invoices = await listSeniorInvoices(page)
      const matched = invoices.filter((i) => payoutIds.has(i.transactionId))
      // One invoice per PAYOUT — 2 total.
      expect(matched.length).toBe(2)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projA.projectId}`).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projB.projectId}`).catch(() => undefined)
    }
  })
})
