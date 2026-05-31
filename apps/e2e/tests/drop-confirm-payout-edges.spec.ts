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
  findPendingPayoutsForProjectViaAPI,
  findUserByEmailViaApi,
  confirmPayoutRawViaAPI,
  confirmPayoutViaAPI,
  createSeniorProjectViaAPI,
  createSeniorIncomeViaAPI,
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
      const { projectId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
      })

      await loginViaApi(page, dropEmail)
      const { txId } = await createDropIncomeViaAPI(page, { projectId, amount: 1000 })

      await loginViaApi(page, SEED_EMAILS.accountant)
      const { payoutRequestId } = await validateTransactionViaAPI(page, txId)
      expect(payoutRequestId).toBeTruthy()

      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const pending = await findPendingPayoutsForProjectViaAPI(page, projectId)
      expect(pending).toHaveLength(1)
      const payoutTxId = pending[0]!.id

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
      await page
        .request.delete(`http://localhost:3001/api/projects/${projectId}`)
        .catch(() => undefined)
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
      const { projectId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
      })

      await loginViaApi(page, dropEmail)
      const { txId } = await createDropIncomeViaAPI(page, { projectId, amount: 1000 })

      await loginViaApi(page, SEED_EMAILS.accountant)
      const { payoutRequestId } = await validateTransactionViaAPI(page, txId)
      expect(payoutRequestId).toBeTruthy()

      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const pending = await findPendingPayoutsForProjectViaAPI(page, projectId)
      const payoutTxId = pending[0]!.id

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
      const wrongRole = await confirmPayoutRawViaAPI(
        page,
        payoutTxId,
        seniorUser!.id,
      )
      expect(wrongRole.status).toBe(400)

      // After all three errors the PAYOUT must STILL be PENDING_PAYMENT
      // (no partial state leaked).
      const stillPending = await findPendingPayoutsForProjectViaAPI(page, projectId)
      expect(stillPending).toHaveLength(1)
      expect(stillPending[0]!.id).toBe(payoutTxId)
    } finally {
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
