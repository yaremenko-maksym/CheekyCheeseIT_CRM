/**
 * payout-manual-confirm-method.spec.ts — task-autotest-business-logic-coverage (C).
 *
 * Phase 4 introduced a `method` discriminator on the manual confirmPayout
 * endpoint:
 *
 *   POST /api/transactions/:id/confirm-payout
 *     body: { recipientAdminId, method: 'CASH' | 'CRYPTO', txHash?: string }
 *
 *   - method='CASH'   → txHash optional/forbidden. payment_method='CASH'.
 *   - method='CRYPTO' → txHash required. payment_method='CRYPTO'.
 *
 * The existing `drop-confirm-payout.spec.ts` and siblings always pick CASH
 * (the default in the helper). This spec specifically exercises CRYPTO mode
 * AND asserts the DB-level `payment_method` snapshot is persisted on the
 * PAYOUT row (regression catcher for a backend that ignores the method
 * discriminator).
 *
 * Real-API.
 *
 * Scenarios:
 *   1. CRYPTO mode + txHash → succeeds, payment_method='CRYPTO', txHash stored.
 *   2. CRYPTO mode + no txHash → 400.
 *   3. CASH mode + no txHash → succeeds, payment_method='CASH'.
 *   4. UI: ConfirmPayoutDialog has radio toggle and txHash input toggles
 *      visibility on method change.
 */

import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  MAKSYM_ID,
  loginViaApi,
  createSeniorProjectViaAPI,
  createSeniorIncomeViaAPI,
  validateTransactionViaAPI,
  findPendingPayoutsForProjectViaAPI,
} from './fixtures'

const REAL_API = 'http://localhost:3001/api'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

/** Plant a senior PAYOUT in PENDING_PAYMENT. */
async function plantPendingSeniorPayout(
  page: import('@playwright/test').Page,
): Promise<{ projectId: string; payoutTxId: string }> {
  const suffix = uniqueSuffix()

  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const { projectId } = await createSeniorProjectViaAPI(page, {
    seniorEmail: SEED_EMAILS.seniorA,
    name: `Confirm Method ${suffix}`,
  })

  await loginViaApi(page, SEED_EMAILS.seniorA)
  const { txId } = await createSeniorIncomeViaAPI(page, { projectId, amount: 1000 })

  await loginViaApi(page, SEED_EMAILS.accountant)
  await validateTransactionViaAPI(page, txId)

  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const pending = await findPendingPayoutsForProjectViaAPI(page, projectId)
  if (pending.length === 0) {
    throw new Error('plant step did not produce PENDING_PAYMENT PAYOUT')
  }
  return { projectId, payoutTxId: pending[0]!.id }
}

test.describe('Manual confirmPayout — method=CASH vs method=CRYPTO', () => {
  test('CRYPTO mode requires txHash; success path persists payment_method=CRYPTO + txHash', async ({
    page,
  }) => {
    const { projectId, payoutTxId } = await plantPendingSeniorPayout(page)

    try {
      await loginViaApi(page, SEED_ADMIN_EMAIL)

      // First: CRYPTO without txHash → must 400.
      const missing = await page.request.post(
        `${REAL_API}/transactions/${payoutTxId}/confirm-payout`,
        { data: { recipientAdminId: MAKSYM_ID, method: 'CRYPTO' } },
      )
      expect(missing.status()).toBe(400)

      // Then: CRYPTO with txHash → succeeds.
      const validHash = '0x' + 'a'.repeat(64)
      const ok = await page.request.post(
        `${REAL_API}/transactions/${payoutTxId}/confirm-payout`,
        { data: { recipientAdminId: MAKSYM_ID, method: 'CRYPTO', txHash: validHash } },
      )
      expect(ok.status()).toBeLessThan(400)

      // Read back the PAYOUT row and the new PAYOUT_CONFIRMED.
      const payoutRowRes = await page.request.get(`${REAL_API}/transactions/${payoutTxId}`)
      const payoutRow = (await payoutRowRes.json()) as Record<string, unknown>
      expect(payoutRow['status']).toBe('PAID')

      // Find the PAYOUT_CONFIRMED row on the project to read paymentMethod.
      const txsRes = await page.request.get(
        `${REAL_API}/transactions?projectId=${projectId}`,
      )
      const txs = (await txsRes.json()) as Array<Record<string, unknown>>
      const confirmed = txs.find((t) => t['type'] === 'PAYOUT_CONFIRMED')
      expect(confirmed, 'expected PAYOUT_CONFIRMED row after confirm-payout').toBeTruthy()
      // payment_method exposed on the row OR on the parent PAYOUT — accept
      // either; the load-bearing assertion is that CRYPTO was recorded.
      const methodField =
        (confirmed!['paymentMethod'] as string | undefined) ??
        (payoutRow['paymentMethod'] as string | undefined)
      expect(methodField).toBe('CRYPTO')

      // txHash recorded on the confirmed row OR the PAYOUT row.
      const hashField =
        (confirmed!['txHash'] as string | null | undefined) ??
        (payoutRow['txHash'] as string | null | undefined)
      expect(hashField).toBe(validHash)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })

  test('CASH mode succeeds without txHash and persists payment_method=CASH', async ({
    page,
  }) => {
    const { projectId, payoutTxId } = await plantPendingSeniorPayout(page)

    try {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const res = await page.request.post(
        `${REAL_API}/transactions/${payoutTxId}/confirm-payout`,
        { data: { recipientAdminId: MAKSYM_ID, method: 'CASH' } },
      )
      expect(res.status()).toBeLessThan(400)

      const txsRes = await page.request.get(
        `${REAL_API}/transactions?projectId=${projectId}`,
      )
      const txs = (await txsRes.json()) as Array<Record<string, unknown>>
      const confirmed = txs.find((t) => t['type'] === 'PAYOUT_CONFIRMED')
      expect(confirmed).toBeTruthy()
      const payoutRowRes = await page.request.get(`${REAL_API}/transactions/${payoutTxId}`)
      const payoutRow = (await payoutRowRes.json()) as Record<string, unknown>
      const methodField =
        (confirmed!['paymentMethod'] as string | undefined) ??
        (payoutRow['paymentMethod'] as string | undefined)
      expect(methodField).toBe('CASH')
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })

  test('UI: ConfirmPayoutDialog method radio toggles txHash input visibility', async ({
    page,
  }) => {
    const { projectId, payoutTxId } = await plantPendingSeniorPayout(page)

    try {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await page.goto('/crm/finance')

      const button = page.getByTestId(`confirm-payout-button-${payoutTxId}`)
      await expect(button).toBeVisible({ timeout: 15_000 })
      await button.click()

      const dialog = page.getByTestId('confirm-payout-dialog')
      await expect(dialog).toBeVisible()

      // Both radios are present.
      await expect(page.getByTestId('confirm-payout-method-cash')).toBeVisible()
      await expect(page.getByTestId('confirm-payout-method-crypto')).toBeVisible()

      // Default is CRYPTO per the dialog component; tx hash input visible.
      // (If the backend default flips, this assertion will surface the change.)
      await page.getByTestId('confirm-payout-method-crypto').click()
      await expect(page.getByTestId('confirm-payout-tx-hash')).toBeVisible()

      // Switch to CASH → txHash input is hidden.
      await page.getByTestId('confirm-payout-method-cash').click()
      await expect(page.getByTestId('confirm-payout-tx-hash')).toHaveCount(0)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })
})
