/**
 * senior-confirm-payout.spec.ts — task-drop-phase3-e2e (AC3).
 *
 * REAL-API + UI coverage of the Phase 3 manual payout confirmation flow
 * (spec §8.4) for a SENIOR-project (no DROP in the chain):
 *
 *   1. ADMIN creates a senior-project (no dropId).
 *   2. SENIOR posts a $1000 SENIOR_INCOME (PENDING).
 *   3. ACCOUNTANT validates → backend creates payout_request +
 *      placeholder PAYOUT row (PENDING_PAYMENT).
 *   4. ACCOUNTANT opens /finance, clicks «Подтвердить оплату» on the
 *      PAYOUT row, picks Kostya, submits — Phase 3 manual confirmation
 *      records that money already arrived to Kostya off-platform.
 *   5. Asserts:
 *      - DB: PAYOUT row → PAID + validatedBy/At set.
 *      - DB: new PAYOUT_CONFIRMED row exists with recipientId=Kostya,
 *        amount=PAYOUT.amount, projectId=PAYOUT.projectId.
 *      - UI: success toast, PAYOUT badge «Оплачено», new row visible.
 *
 * NOTE: Phase 3 confirm runs BEFORE `payPayoutRequest` — the idempotency
 * guard requires PAYOUT.status=PENDING_PAYMENT. The legacy Phase 2 senior
 * cascade (2× PAYOUT_ADMIN inserts) fires only if SENIOR actually pays;
 * this test deliberately skips that path.
 *
 * Cleanup: archive the project owner-side via the spec helper (none needed
 * for the senior — the SENIOR is a seed user, just delete the project).
 */

import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  KOSTYA_ID,
  loginViaApi,
  createSeniorProjectViaAPI,
  createSeniorIncomeViaAPI,
  validateTransactionViaAPI,
  createPayoutRequestViaAPI,
  findPendingPayoutsForProjectViaAPI,
  listTransactionsByProjectViaAPI,
  getTransactionViaAPI,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

const REAL_API = 'http://localhost:3001/api'

test.describe('Senior confirm-payout — manual confirmation (AC3)', () => {
  test('ACCOUNTANT confirms senior PAYOUT → row PAID + PAYOUT_CONFIRMED for Kostya', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()

    // ── Setup ────────────────────────────────────────────────────────────
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId, seniorId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `Senior Confirm Project ${suffix}`,
    })
    expect(seniorId).toBeTruthy()

    try {
      // SENIOR posts $1000 SENIOR_INCOME (PENDING).
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { txId: incomeTxId } = await createSeniorIncomeViaAPI(page, {
        projectId,
        amount: 1000,
        currency: 'USDT',
      })

      // ACCOUNTANT validates → SENIOR_INCOME becomes VALIDATED (no auto-payout).
      // feat/finance-payout-flow (#7): SENIOR must manually create the payout.
      await loginViaApi(page, SEED_EMAILS.accountant)
      await validateTransactionViaAPI(page, incomeTxId)

      // SENIOR creates the payout_request. We deliberately SKIP payPayoutRequest
      // because Phase 3 manual confirmation needs PAYOUT in PENDING_PAYMENT
      // (the idempotency guard would 400 a second confirm).
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { payoutRequestId } = await createPayoutRequestViaAPI(page, [incomeTxId])
      expect(payoutRequestId).toBeTruthy()

      // Switch back to ACCOUNTANT for the UI confirmation flow.
      await loginViaApi(page, SEED_EMAILS.accountant)

      // ── Pre-confirmation invariant ───────────────────────────────────
      const pendingPayouts = await findPendingPayoutsForProjectViaAPI(page, projectId)
      expect(pendingPayouts).toHaveLength(1)
      const payoutTx = pendingPayouts[0]!
      const payoutAmount = parseFloat(payoutTx.amount)
      expect(payoutAmount).toBeGreaterThan(0)

      // ── UI: ACCOUNTANT opens /finance and confirms ───────────────
      await page.goto('/finance')
      const confirmButton = page.getByTestId(`confirm-payout-button-${payoutTx.id}`)
      await expect(confirmButton).toBeVisible({ timeout: 15_000 })
      await confirmButton.click()

      const dialog = page.getByTestId('confirm-payout-dialog')
      await expect(dialog).toBeVisible()

      // Pick Kostya in the select. Phase 4 refactor (AC10): pick CASH method
      // to skip the now-required txHash entry.
      await page.getByTestId('confirm-payout-admin-select').click()
      await page.getByRole('option', { name: /Kostya/i }).click()
      await page.getByTestId('confirm-payout-method-cash').click()

      const submit = page.getByTestId('confirm-payout-submit')
      await expect(submit).toBeEnabled()
      await submit.click()

      await expect(page.getByText('Оплата подтверждена')).toBeVisible({ timeout: 10_000 })

      // ── DB asserts ───────────────────────────────────────────────────
      const updatedPayout = await getTransactionViaAPI(page, payoutTx.id)
      expect(updatedPayout.status).toBe('PAID')

      const payoutRaw = await page.request.get(`${REAL_API}/transactions/${payoutTx.id}`)
      const payoutBody = (await payoutRaw.json()) as {
        validatedBy: string | null
        validatedAt: string | null
      }
      expect(payoutBody.validatedBy).not.toBeNull()
      expect(payoutBody.validatedAt).not.toBeNull()

      const projectTxs = await listTransactionsByProjectViaAPI(page, projectId)
      const confirmedRows = projectTxs.filter((t) => t.type === 'PAYOUT_CONFIRMED')
      expect(confirmedRows).toHaveLength(1)
      const confirmedRow = confirmedRows[0]!
      expect(confirmedRow.status).toBe('PAID')
      expect(parseFloat(confirmedRow.amount)).toBeCloseTo(payoutAmount, 2)
      expect(confirmedRow.recipientId).toBe(KOSTYA_ID)
      expect(confirmedRow.projectId).toBe(projectId)
    } finally {
      // No archive needed — the project is throwaway and the senior is a
      // seed user. Test parallelism is bounded by unique project names per
      // suffix.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })
})
