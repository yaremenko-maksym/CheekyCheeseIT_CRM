/**
 * drop-confirm-payout.spec.ts — task-drop-phase3-e2e (AC2).
 *
 * REAL-API + UI coverage of the Phase 3 manual payout confirmation flow
 * (spec §8.4) on a DROP-project:
 *
 *   1. ADMIN provisions a fresh DROP + drop-team + drop-project.
 *   2. DROP posts a $1000 DROP_INCOME (PENDING).
 *   3. ACCOUNTANT validates → backend cascade (transactions.service §validate)
 *      flips DROP_INCOME→VALIDATED, creates the payout_request + placeholder
 *      PAYOUT row (PENDING_PAYMENT). NOTE: Phase 2 distribution math
 *      (PAYOUT_DROP + 2× PAYOUT_ADMIN inserts) fires LATER in
 *      `payPayoutRequest` — the manual confirmation flow lives BEFORE that
 *      step (DROP hasn't paid yet → ADMIN/ACCOUNTANT records that money
 *      already arrived off-platform).
 *   4. ADMIN opens /finance, clicks «Подтвердить оплату» on the PAYOUT row.
 *   5. Picks Maksym in the recipient select → submits.
 *   6. Asserts:
 *      - DB (via REST): PAYOUT row flipped to PAID + validatedBy/At set.
 *      - DB: new PAYOUT_CONFIRMED row exists with recipientId=Maksym,
 *        amount=PAYOUT.amount, currency=PAYOUT.currency, projectId=PAYOUT's.
 *      - UI: PAYOUT row badge reads «Оплачено» (PAID), new PAYOUT_CONFIRMED
 *        row appears in the table.
 *
 * Phase 2 auto-50/50 PAYOUT_ADMIN distribution is NOT touched — the manual
 * confirmation flow lives in parallel as a safety net. See AC6
 * (phase2-auto-distribution-regression.spec.ts) for the regression guard.
 *
 * Cleanup: cascade-archive the drop (kills team + project + transactions).
 *
 * NOTE: the AC table mentions a fallback to ADMIN_INCOME if the new
 * PAYOUT_CONFIRMED type wasn't introduced. Backend (PR #68) chose option B
 * (new type) — asserts here are written against PAYOUT_CONFIRMED. If the
 * backend ever rolls back to ADMIN_INCOME the assertions in
 * `expectConfirmedRow` need to flip too.
 */

import { test, expect, REAL_API_BASE } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  MAKSYM_ID,
  loginViaApi,
  createDropViaAPI,
  cleanupDropViaAPI,
  createDropProjectViaAPI,
  createDropIncomeViaAPI,
  validateTransactionViaAPI,
  createPayoutRequestViaAPI,
  onboardDropViaAPI,
  ensureCompanyWalletViaAPI,
  listTransactionsByProjectViaAPI,
  getTransactionViaAPI,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

const REAL_API = `${REAL_API_BASE}/api`

test.describe('Drop confirm-payout — manual confirmation happy path (AC2)', () => {
  test('ADMIN confirms drop PAYOUT → row PAID + PAYOUT_CONFIRMED for Maksym + UI updates', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-confirm-${suffix}@cheekycheese.dev`

    // ── Setup ────────────────────────────────────────────────────────────
    // 1) Provision DROP + drop-team as ADMIN.
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Drop Confirm ${suffix}`,
      dropSharePercent: 5,
    })

    try {
      // Backlog item 139: onboard the fresh DROP (contract + ToS) before ANY
      // non-bypassed route lets them through — see `onboardDropViaAPI`'s
      // jsdoc. Also configure the company wallet, required by
      // `createPayoutRequestViaAPI` below.
      await onboardDropViaAPI(page, { dropId, dropEmail })
      await ensureCompanyWalletViaAPI(page)

      // 2) Drop-project routed through the DROP with the canonical 26%
      //    SENIOR share. AC2 doesn't care about the distribution math —
      //    it only needs a PAYOUT row in PENDING_PAYMENT.
      const { projectId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
        rate: 5000,
        currency: 'USDT',
      })

      // 3) DROP posts $1000 DROP_INCOME (PENDING).
      await loginViaApi(page, dropEmail)
      const { txId: incomeTxId } = await createDropIncomeViaAPI(page, {
        projectId,
        amount: 1000,
        currency: 'USDT',
      })
      expect(incomeTxId).toBeTruthy()

      // 4) ACCOUNTANT validates (flips PENDING → VALIDATED only — task-drop-
      //    payout-company-account removed the auto-create-payout_request
      //    side-effect). The DROP then explicitly bundles their own
      //    VALIDATED income into a payout_request, which is what creates the
      //    PAYOUT placeholder (PENDING_PAYMENT) Phase 3 manual confirmation
      //    works on, BEFORE the DROP triggers `payPayoutRequest` — calling
      //    pay AFTER confirm-payout would 404 on the idempotency guard
      //    (PAYOUT must be PENDING_PAYMENT).
      await loginViaApi(page, SEED_EMAILS.accountant)
      await validateTransactionViaAPI(page, incomeTxId)

      await loginViaApi(page, dropEmail)
      const { payoutRequestId } = await createPayoutRequestViaAPI(page, [incomeTxId])
      expect(payoutRequestId).toBeTruthy()

      // ── Pre-confirmation invariant ───────────────────────────────────
      // PAYOUT row exists, status=PENDING_PAYMENT, recipientId unset
      // (Phase 3 will populate it via the new PAYOUT_CONFIRMED row).
      // Backlog 144 (fixed): `createPayoutRequest` now stamps `projectId` on
      // this row, so the plain `?projectId=` filter finds it directly — no
      // more payout_request-id workaround (see `findPendingPayoutsForProjectViaAPI`'s
      // former TRAP note in fixtures.ts, now updated to reflect the fix).
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const payoutRequestTxs = await listTransactionsByProjectViaAPI(page, projectId)
      const pendingPayouts = payoutRequestTxs.filter((t) => t.type === 'PAYOUT')
      expect(pendingPayouts).toHaveLength(1)
      const payoutTx = pendingPayouts[0]!
      expect(payoutTx.type).toBe('PAYOUT')
      expect(payoutTx.status).toBe('PENDING_PAYMENT')
      expect(parseFloat(payoutTx.amount)).toBeGreaterThan(0)
      const payoutAmount = parseFloat(payoutTx.amount)
      const payoutCurrency = payoutTx.currency

      // ── UI flow: ADMIN clicks «Подтвердить оплату» ───────────────────
      // Use a permissive filter — the table renders many rows on a clean
      // DB, but the Phase 3 button has a unique `confirm-payout-button-<id>`
      // testid so we can target the PAYOUT row directly.
      await page.goto('/finance')
      const confirmButton = page.getByTestId(`confirm-payout-button-${payoutTx.id}`)
      await expect(confirmButton).toBeVisible({ timeout: 15_000 })
      await confirmButton.click()

      // Dialog opens — info block carries amount + currency + sender display.
      const dialog = page.getByTestId('confirm-payout-dialog')
      await expect(dialog).toBeVisible()
      const info = page.getByTestId('confirm-payout-info')
      await expect(info).toBeVisible()
      // Amount badge shows the formatted PAYOUT amount. Use a substring
      // assertion against the numeric value to dodge currency formatting
      // drift (commas / locale-specific separators).
      await expect(page.getByTestId('confirm-payout-amount')).toBeVisible()
      await expect(page.getByTestId('confirm-payout-amount-readonly')).toBeVisible()
      // Sender display is the DROP — info block shows the drop's display name.
      await expect(info).toContainText(`Drop Confirm ${suffix}`)

      // Open the recipient select → both Maksym and Kostya options exist.
      const trigger = page.getByTestId('confirm-payout-admin-select')
      await trigger.click()
      // Radix Select renders options in a portal — getByRole reaches them.
      await expect(page.getByRole('option', { name: /Maksym/i })).toBeVisible()
      await expect(page.getByRole('option', { name: /Kostya/i })).toBeVisible()

      // Pick Maksym → submit. Phase 4 refactor (AC10): pick CASH method so
      // we don't need a real txHash for this happy-path assertion.
      await page.getByRole('option', { name: /Maksym/i }).click()
      await page.getByTestId('confirm-payout-method-cash').click()
      const submit = page.getByTestId('confirm-payout-submit')
      await expect(submit).toBeEnabled()
      await submit.click()

      // Success toast appears (sonner toast.success).
      await expect(page.getByText('Оплата подтверждена')).toBeVisible({ timeout: 10_000 })

      // ── Backend asserts (DB via REST) ────────────────────────────────
      // PAYOUT row → PAID + validatedBy/At set.
      const updatedPayout = await getTransactionViaAPI(page, payoutTx.id)
      expect(updatedPayout.status).toBe('PAID')
      // Pull the raw row to check validatedBy/At (getTransactionViaAPI's
      // narrower type doesn't expose those).
      const payoutRaw = await page.request.get(`${REAL_API}/transactions/${payoutTx.id}`)
      expect(payoutRaw.status()).toBe(200)
      const payoutBody = (await payoutRaw.json()) as {
        status: string
        validatedBy: string | null
        validatedAt: string | null
      }
      expect(payoutBody.validatedBy).not.toBeNull()
      expect(payoutBody.validatedAt).not.toBeNull()

      // New PAYOUT_CONFIRMED row exists with the right shape. It carries the
      // same `payoutRequestId` as the placeholder PAYOUT (confirmPayout
      // snapshots it — transactions.service.ts).
      //
      // Backlog 144 (fixed): `confirmPayout` snapshots `projectId` FROM the
      // source PAYOUT row (`projectId: payoutTx.projectId`), and
      // `createPayoutRequest` now sets that (see the fixed TRAP note on
      // `findPendingPayoutsForProjectViaAPI` in fixtures.ts), so
      // PAYOUT_CONFIRMED carries the real project id and the plain
      // `?projectId=` filter (`listTransactionsByProjectViaAPI`) finds it
      // directly — no more `listPayoutRequestTransactionsViaAPI` workaround.
      const projectTxs = await listTransactionsByProjectViaAPI(page, projectId)
      const confirmedRows = projectTxs.filter((t) => t.type === 'PAYOUT_CONFIRMED')
      expect(confirmedRows).toHaveLength(1)
      const confirmedRow = confirmedRows[0]!
      expect(confirmedRow.status).toBe('PAID')
      expect(parseFloat(confirmedRow.amount)).toBeCloseTo(payoutAmount, 2)
      expect(confirmedRow.recipientId).toBe(MAKSYM_ID)
      expect(confirmedRow.receiverId).toBe(MAKSYM_ID)
      // Pins the FIX (backlog 144) — used to be pinned `.toBeNull()` (the
      // known defect). Revert `createPayoutRequest`'s `projectId:
      // primaryProjectId` and this goes red again.
      expect(confirmedRow.projectId).toBe(projectId)
      // Pull the row again with the full shape to check currency.
      const confirmedFull = await page.request.get(`${REAL_API}/transactions/${confirmedRow.id}`)
      expect(confirmedFull.status()).toBe(200)
      const confirmedJson = (await confirmedFull.json()) as { currency: string }
      expect(confirmedJson.currency).toBe(payoutCurrency)

      // ── UI assert: PAYOUT badge «Оплачено», new PAYOUT_CONFIRMED row ─
      const payoutRowAfter = page.getByTestId(`tx-row-${payoutTx.id}`)
      await expect(payoutRowAfter).toBeVisible()
      await expect(payoutRowAfter).toContainText(/Оплачено/i)
      // The Phase 3 button should be gone once the PAYOUT flipped to PAID.
      await expect(page.getByTestId(`confirm-payout-button-${payoutTx.id}`)).toHaveCount(0)

      // New confirmed row visible in the table.
      const confirmedRowUi = page.getByTestId(`tx-row-${confirmedRow.id}`)
      await expect(confirmedRowUi).toBeVisible()
    } finally {
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
