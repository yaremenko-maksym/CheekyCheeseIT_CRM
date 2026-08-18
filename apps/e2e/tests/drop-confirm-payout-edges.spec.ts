/**
 * drop-confirm-payout-edges.spec.ts — task-drop-phase3-e2e (AC5).
 *
 * Edge cases for POST /api/transactions/:id/confirm-payout (spec §8.4):
 *
 *   1. Confirm a PAYOUT that's already PAID → 400 (idempotency / status guard).
 *   2. Confirm a non-PAYOUT row (e.g. SENIOR_INCOME) → 400 (type guard).
 *   3. Confirm with an invalid `recipientAdminId`:
 *      - malformed UUID → 400 (Zod schema rejects).
 *      - non-existent UUID → 400 («Recipient admin not found»).
 *      - existing user but role != ADMIN → 400 («Recipient must be an ADMIN»).
 *
 * The setup mirrors AC2/AC4: one fresh drop user + drop-project + paid
 * payout_request so the backend sits at a deterministic PAYOUT row.
 *
 * Cleanup: cascade-archive the drop.
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
  findUserByEmailViaApi,
  confirmPayoutRawViaAPI,
  confirmPayoutViaAPI,
  createSeniorProjectViaAPI,
  createSeniorIncomeViaAPI,
  REAL_API_BASE,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('Drop confirm-payout — edge cases (AC5)', () => {
  test('already PAID PAYOUT → 400 «Payout is not pending payment»', async ({ page }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-edge-paid-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Drop Edge Paid ${suffix}`,
      dropSharePercent: 5,
    })

    try {
      // Backlog item 139: a fresh DROP needs the onboarding gate cleared
      // (signed contract + ToS) before ANY non-bypassed route lets them
      // through — see the note in `onboardDropViaAPI`'s jsdoc.
      await onboardDropViaAPI(page, { dropId, dropEmail })
      // Required by `createPayoutRequestViaAPI` below — POST /payout-requests
      // 400s "Кошелёк компании не настроен" without a configured wallet.
      await ensureCompanyWalletViaAPI(page)

      const { projectId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
      })

      await loginViaApi(page, dropEmail)
      const { txId } = await createDropIncomeViaAPI(page, { projectId, amount: 1000 })

      await loginViaApi(page, SEED_EMAILS.accountant)
      await validateTransactionViaAPI(page, txId)

      // task-drop-payout-company-account (backlog item 131/139): validate no
      // longer auto-creates the payout_request — the DROP must bundle their
      // own VALIDATED income explicitly via POST /api/payout-requests, same
      // as SENIOR (see drop-backend-rbac-api.spec.ts for the reference flow).
      await loginViaApi(page, dropEmail)
      const { payoutRequestId } = await createPayoutRequestViaAPI(page, [txId])
      expect(payoutRequestId).toBeTruthy()

      // `createPayoutRequest` never stamps `projectId` on the placeholder
      // PAYOUT row it inserts — see the TRAP note on
      // `findPendingPayoutsForProjectViaAPI` in fixtures.ts. Find it by
      // payout_request id instead.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const payoutTxs = await listPayoutRequestTransactionsViaAPI(page, payoutRequestId)
      const payoutTx = payoutTxs.find((t) => t.type === 'PAYOUT')
      expect(payoutTx).toBeTruthy()
      const payoutTxId = payoutTx!.id

      // First confirm — succeeds (returns PAID).
      await confirmPayoutViaAPI(page, payoutTxId, MAKSYM_ID)

      // Second confirm — must 400.
      const second = await confirmPayoutRawViaAPI(page, payoutTxId, MAKSYM_ID)
      expect(second.status).toBe(400)
    } finally {
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('SENIOR_INCOME (wrong type) → 400 «Only PAYOUT transactions can be confirmed»', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `Senior Edge Type ${suffix}`,
    })

    try {
      // SENIOR creates an income row — type=SENIOR_INCOME, NOT a PAYOUT.
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { txId } = await createSeniorIncomeViaAPI(page, { projectId, amount: 1000 })

      // ADMIN tries to confirm-payout on the SENIOR_INCOME → 400.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const { status } = await confirmPayoutRawViaAPI(page, txId, MAKSYM_ID)
      expect(status).toBe(400)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await page.request.delete(`${REAL_API_BASE}/api/projects/${projectId}`).catch(() => undefined)
    }
  })

  test('invalid recipientAdminId — Zod rejects malformed UUID + 400 for non-existent + 400 for non-ADMIN', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-edge-recipient-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Drop Edge Recipient ${suffix}`,
      dropSharePercent: 5,
    })

    try {
      // See the onboarding + payout-request notes on the first test in this
      // file (backlog item 139).
      await onboardDropViaAPI(page, { dropId, dropEmail })
      await ensureCompanyWalletViaAPI(page)

      const { projectId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
      })

      await loginViaApi(page, dropEmail)
      const { txId } = await createDropIncomeViaAPI(page, { projectId, amount: 1000 })

      await loginViaApi(page, SEED_EMAILS.accountant)
      await validateTransactionViaAPI(page, txId)

      await loginViaApi(page, dropEmail)
      const { payoutRequestId } = await createPayoutRequestViaAPI(page, [txId])
      expect(payoutRequestId).toBeTruthy()

      // See the TRAP note on `findPendingPayoutsForProjectViaAPI` in
      // fixtures.ts — the placeholder PAYOUT row is never stamped with
      // `projectId`, so it must be found by payout_request id instead.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const payoutTxs = await listPayoutRequestTransactionsViaAPI(page, payoutRequestId)
      const payoutTx = payoutTxs.find((t) => t.type === 'PAYOUT')
      expect(payoutTx).toBeTruthy()
      const payoutTxId = payoutTx!.id

      // 1) Malformed UUID — Zod's regex check rejects with 400 (BadRequest
      //    from the NestJS Zod pipe — `confirmPayoutSchema.parse`).
      const malformed = await confirmPayoutRawViaAPI(page, payoutTxId, 'not-a-uuid')
      expect(malformed.status).toBe(400)

      // 2) Existing-shape UUID but no such user → 400 «Recipient admin not found».
      const ghostUuid = '11111111-1111-1111-1111-111111111111'
      const ghost = await confirmPayoutRawViaAPI(page, payoutTxId, ghostUuid)
      expect(ghost.status).toBe(400)

      // 3) Existing user but role != ADMIN. Use the seed senior — the
      //    service rejects with «Recipient must be an ADMIN». Pull the
      //    senior's real id from the API so we don't depend on a hardcoded
      //    UUID that drifts when seed.ts changes.
      const seniorUser = await findUserByEmailViaApi(page, SEED_EMAILS.seniorA)
      expect(seniorUser).not.toBeNull()
      const wrongRole = await confirmPayoutRawViaAPI(page, payoutTxId, seniorUser!.id)
      expect(wrongRole.status).toBe(400)

      // After all three errors the PAYOUT must STILL be PENDING_PAYMENT
      // (no partial state leaked).
      const stillPendingTxs = await listPayoutRequestTransactionsViaAPI(page, payoutRequestId)
      const stillPayout = stillPendingTxs.find((t) => t.type === 'PAYOUT')
      expect(stillPayout).toBeTruthy()
      expect(stillPayout!.status).toBe('PENDING_PAYMENT')
      expect(stillPayout!.id).toBe(payoutTxId)
    } finally {
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
