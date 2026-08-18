/**
 * drop-confirm-payout-rbac.spec.ts — task-drop-phase3-e2e (AC4).
 *
 * RBAC matrix for the Phase 3 manual confirmation endpoint
 * (POST /api/transactions/:id/confirm-payout) + UI:
 *
 *   DROP / SENIOR / JUNIOR / HR  → 403 backend + button NOT rendered in UI.
 *   ADMIN / ACCOUNTANT           → 200 backend + button rendered.
 *
 * Setup (shared across the matrix) — one drop user + one drop-project +
 * one DROP_INCOME validated + paid through to a PENDING_PAYMENT PAYOUT row.
 * Each role then runs the same probe against that row. We do NOT actually
 * confirm in the negative cases (the assert is "403 happens"); the
 * positive cases (ADMIN, ACCOUNTANT) ARE confirmed for real to assert the
 * 200 path — these are split into separate `test()` blocks so cleanup
 * works without one role's confirmation leaking into the next.
 *
 * Cleanup: cascade-archive the drop after each test.
 */

import { test, expect } from './fixtures'
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
  listPayoutRequestTransactionsViaAPI,
  confirmPayoutRawViaAPI,
  confirmPayoutViaAPI,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

/**
 * Plant a DROP + drop-project + PENDING_PAYMENT PAYOUT row.
 *
 * Returns the drop id (for cleanup) + payout tx id + a hint of what role
 * was logged in last (the caller usually re-logins anyway).
 */
async function setupPendingPayout(page: import('@playwright/test').Page): Promise<{
  dropId: string
  projectId: string
  payoutTxId: string
  dropEmail: string
}> {
  const suffix = uniqueSuffix()
  const dropEmail = `drop-rbac-${suffix}@cheekycheese.dev`

  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const { dropId } = await createDropViaAPI(page, {
    email: dropEmail,
    displayName: `Drop RBAC ${suffix}`,
    dropSharePercent: 5,
  })

  // Backlog item 139: onboard the fresh DROP (contract + ToS) before ANY
  // non-bypassed route lets them through, and configure the company wallet
  // — required by `createPayoutRequestViaAPI` below.
  await onboardDropViaAPI(page, { dropId, dropEmail })
  await ensureCompanyWalletViaAPI(page)

  const { projectId } = await createDropProjectViaAPI(page, {
    dropId,
    seniorEmail: SEED_EMAILS.seniorA,
    rate: 5000,
    currency: 'USDT',
  })

  await loginViaApi(page, dropEmail)
  const { txId } = await createDropIncomeViaAPI(page, {
    projectId,
    amount: 1000,
    currency: 'USDT',
  })

  await loginViaApi(page, SEED_EMAILS.accountant)
  // task-drop-payout-company-account (backlog item 139): validate now ONLY
  // flips PENDING → VALIDATED — it no longer auto-creates a payout_request.
  await validateTransactionViaAPI(page, txId)

  // The DROP bundles their own VALIDATED income into a payout_request
  // explicitly, same as SENIOR — this is what creates the placeholder
  // PAYOUT (PENDING_PAYMENT) row the RBAC matrix probes below.
  await loginViaApi(page, dropEmail)
  const { payoutRequestId } = await createPayoutRequestViaAPI(page, [txId])
  if (!payoutRequestId) {
    throw new Error('setupPendingPayout: createPayoutRequest did not return an id')
  }

  // `createPayoutRequest` never stamps `projectId` on the placeholder
  // PAYOUT row it inserts — see the TRAP note on
  // `findPendingPayoutsForProjectViaAPI` in fixtures.ts. Find it by
  // payout_request id instead.
  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const payoutTxs = await listPayoutRequestTransactionsViaAPI(page, payoutRequestId)
  const payoutTx = payoutTxs.find((t) => t.type === 'PAYOUT')
  if (!payoutTx) {
    throw new Error('setupPendingPayout: no PENDING_PAYMENT PAYOUT row produced')
  }
  return { dropId, projectId, payoutTxId: payoutTx.id, dropEmail }
}

test.describe('Drop confirm-payout — RBAC (AC4)', () => {
  test('DROP → 403 (backend) + button NOT in UI on /finance', async ({ page }) => {
    const { dropId, payoutTxId, dropEmail } = await setupPendingPayout(page)
    try {
      // DROP can see their PAYOUT row (it's their own send), but the
      // «Подтвердить оплату» button is ADMIN/ACCOUNTANT-only.
      //
      // Backlog item 139: `/finance` renders a role-specific component —
      // DROP gets `DropFinancePage` (routes/_authenticated/finance/index.tsx
      // `if (isDrop) return <DropFinancePage />`), which lists outgoing
      // payments via GET /finance/drop/me/payments in a card with
      // `data-testid="drop-payment-row-<id>"` — NOT the shared
      // `tx-row-<id>` grid the ADMIN/ACCOUNTANT table uses. This spec
      // predates that split (or was never updated for it) and asserted the
      // wrong testid, which never turned red because the file isn't in any
      // CI shard. `DropFinancePage` also never renders a
      // `confirm-payout-button-*` at all (that assertion already held for
      // the right reason).
      await loginViaApi(page, dropEmail)
      await page.goto('/finance')
      // Sanity: the DROP DOES see the PAYOUT row.
      await expect(page.getByTestId(`drop-payment-row-${payoutTxId}`)).toBeVisible({
        timeout: 15_000,
      })
      // But the Phase 3 button must NOT be rendered.
      await expect(page.getByTestId(`confirm-payout-button-${payoutTxId}`)).toHaveCount(0)

      // Direct API call → 403.
      const { status } = await confirmPayoutRawViaAPI(page, payoutTxId, MAKSYM_ID)
      expect(status).toBe(403)
    } finally {
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('SENIOR → 403 (backend)', async ({ page }) => {
    const { dropId, payoutTxId } = await setupPendingPayout(page)
    try {
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { status } = await confirmPayoutRawViaAPI(page, payoutTxId, MAKSYM_ID)
      expect(status).toBe(403)
    } finally {
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('JUNIOR → 403 (backend)', async ({ page }) => {
    const { dropId, payoutTxId } = await setupPendingPayout(page)
    try {
      await loginViaApi(page, SEED_EMAILS.juniorA)
      const { status } = await confirmPayoutRawViaAPI(page, payoutTxId, MAKSYM_ID)
      expect(status).toBe(403)
    } finally {
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('HR → 403 (backend)', async ({ page }) => {
    const { dropId, payoutTxId } = await setupPendingPayout(page)
    try {
      await loginViaApi(page, SEED_EMAILS.hrA)
      const { status } = await confirmPayoutRawViaAPI(page, payoutTxId, MAKSYM_ID)
      expect(status).toBe(403)
    } finally {
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('ADMIN → 200 (backend) — confirms the PAYOUT', async ({ page }) => {
    const { dropId, payoutTxId } = await setupPendingPayout(page)
    try {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const { payout, confirmed } = await confirmPayoutViaAPI(page, payoutTxId, MAKSYM_ID)
      expect(payout.status).toBe('PAID')
      // The read-back is NOT racy, despite what this comment used to claim:
      // `confirmPayout` inserts the PAYOUT_CONFIRMED row inside a db
      // transaction and only reads it back AFTER that transaction resolves,
      // by a predicate that includes the per-confirmation `notes` marker
      // (transactions.service.ts). A null here means the row the endpoint
      // promised to create is not there — which is exactly what this test
      // should fail on.
      //
      // The previous form, `expect(confirmed?.recipientId ?? MAKSYM_ID)
      // .toBe(MAKSYM_ID)`, compared a value with itself whenever `confirmed`
      // was null, so it could not fail on that path (code-review MED-2).
      // Worse than the `if` it replaced: an `if` is at least visible to the
      // no-conditional-expect rule this PR turns on, whereas a `??` default
      // hides the skip from both the linter and the reader.
      expect(
        confirmed,
        'confirm-payout must return the PAYOUT_CONFIRMED row it created',
      ).not.toBeNull()
      expect(confirmed?.recipientId).toBe(MAKSYM_ID)
    } finally {
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('ACCOUNTANT → 200 (backend) — confirms the PAYOUT', async ({ page }) => {
    const { dropId, payoutTxId } = await setupPendingPayout(page)
    try {
      await loginViaApi(page, SEED_EMAILS.accountant)
      const { payout } = await confirmPayoutViaAPI(page, payoutTxId, MAKSYM_ID)
      expect(payout.status).toBe('PAID')
    } finally {
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
