/**
 * invoice-signing-real.spec.ts — task-autotest-business-logic-coverage (I).
 *
 * Real-API coverage of the invoice signing flow. The existing mock spec
 * (`invoices-signing-flow.spec.ts`) covers the UI happy path with stubbed
 * responses; this spec hits the live NestJS backend so a regression in the
 * sign cascade (hash check, second signature insert, PDF regen) surfaces.
 *
 * Real-API.
 *
 * Scenarios:
 *   1. After SENIOR_INCOME → PAID cascade, the auto-created invoice has
 *      status='PENDING' and exactly 1 COMPANY signature (Maksym auto-sign).
 *   2. SENIOR signs via POST /api/invoices/:txId/sign → status flips to
 *      SIGNED, 2 signatures present (COMPANY + COUNTERPARTY).
 *   3. RBAC: a SENIOR signing an invoice they are NOT the counterparty for
 *      → 403.
 *
 * Sign endpoint takes an empty body (server pulls signer from JWT).
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

/** Drive SENIOR_INCOME → PAID + return the PAYOUT id (the invoice surrogate). */
async function plantSignedReadyPayout(
  page: import('@playwright/test').Page,
): Promise<{ projectId: string; payoutTxId: string }> {
  const suffix = uniqueSuffix()

  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const { projectId } = await createSeniorProjectViaAPI(page, {
    seniorEmail: SEED_EMAILS.seniorA,
    name: `Invoice Sign ${suffix}`,
  })

  await loginViaApi(page, SEED_EMAILS.seniorA)
  const { txId } = await createSeniorIncomeViaAPI(page, { projectId, amount: 1000 })

  // feat/finance-payout-flow (#7): validate only flips to VALIDATED.
  await loginViaApi(page, SEED_EMAILS.accountant)
  await validateTransactionViaAPI(page, txId)

  // SENIOR manually creates and pays the payout_request.
  await loginViaApi(page, SEED_EMAILS.seniorA)
  const { payoutRequestId } = await createPayoutRequestViaAPI(page, [txId])
  await payPayoutRequestViaAPI(page, payoutRequestId)

  // Find the PAYOUT row id — that's the invoice's transactionId.
  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const txs = await listTransactionsByProjectViaAPI(page, projectId)
  const payoutRow = txs.find((t) => t.type === 'PAYOUT')
  if (!payoutRow) throw new Error('cascade did not produce a PAYOUT row')

  return { projectId, payoutTxId: payoutRow.id }
}

test.describe('Invoice signing — real API', () => {
  test('after SENIOR_INCOME PAID → 1 PENDING invoice exists with COMPANY auto-sig', async ({
    page,
  }) => {
    const { projectId, payoutTxId } = await plantSignedReadyPayout(page)

    try {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const invoiceRes = await page.request.get(`${REAL_API}/invoices/${payoutTxId}`)
      // The invoice may not be ready immediately if the backend defers PDF
      // creation; retry a couple of times.
      let invoice: Record<string, unknown> | null = null
      for (let attempt = 0; attempt < 5; attempt++) {
        const res =
          attempt === 0 ? invoiceRes : await page.request.get(`${REAL_API}/invoices/${payoutTxId}`)
        if (res.status() === 200) {
          invoice = (await res.json()) as Record<string, unknown>
          break
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      expect(invoice, 'invoice should exist after PAYOUT cascade').toBeTruthy()

      // PENDING status + exactly 1 signature (COMPANY auto).
      expect(invoice!['status']).toBe('PENDING')
      const sigs = (invoice!['signatures'] as Array<Record<string, unknown>>) ?? []
      expect(sigs.length).toBe(1)
      expect(sigs[0]!['signerRole']).toBe('COMPANY')
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })

  test('counterparty SENIOR signs → status=SIGNED + 2 signatures', async ({ page }) => {
    const { projectId, payoutTxId } = await plantSignedReadyPayout(page)

    try {
      // Wait briefly for invoice to be ready.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await page.request.get(`${REAL_API}/invoices/${payoutTxId}`)
        if (r.status() === 200) break
        await new Promise((res) => setTimeout(res, 500))
      }

      // SENIOR signs.
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const signRes = await page.request.post(`${REAL_API}/invoices/${payoutTxId}/sign`, {
        data: {},
      })
      expect(signRes.status()).toBeLessThan(400)

      const after = (await signRes.json()) as {
        status: string
        signatures: Array<{ signerRole: string }>
      }
      expect(after.status).toBe('SIGNED')
      expect(after.signatures.length).toBe(2)
      const roles = new Set(after.signatures.map((s) => s.signerRole))
      expect(roles.has('COMPANY')).toBe(true)
      expect(roles.has('COUNTERPARTY')).toBe(true)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })

  test('RBAC: non-counterparty SENIOR cannot sign — 403', async ({ page }) => {
    const { projectId, payoutTxId } = await plantSignedReadyPayout(page)

    try {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      // Wait for invoice to be ready.
      for (let attempt = 0; attempt < 5; attempt++) {
        const r = await page.request.get(`${REAL_API}/invoices/${payoutTxId}`)
        if (r.status() === 200) break
        await new Promise((res) => setTimeout(res, 500))
      }

      // SeniorB is NOT the counterparty (seniorA is) → 403.
      await loginViaApi(page, SEED_EMAILS.seniorB)
      const res = await page.request.post(`${REAL_API}/invoices/${payoutTxId}/sign`, {
        data: {},
      })
      expect([401, 403]).toContain(res.status())
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })
})
