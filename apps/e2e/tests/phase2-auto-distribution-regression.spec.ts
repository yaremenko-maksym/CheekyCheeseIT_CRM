/**
 * phase2-auto-distribution-regression.spec.ts — task-drop-phase3-e2e (AC6).
 *
 * Regression guard: the Phase 2 auto-distribution cascade (DROP_PENDING_PAYOUT
 * booked by `payPayoutRequest`) still works after Phase 3 (spec §8.4)
 * introduced the alternative manual `confirmPayout` flow.
 *
 * The two flows are mutually exclusive on a single PAYOUT row (the manual
 * confirm idempotency guard requires PENDING_PAYMENT, and `payPayoutRequest`
 * itself flips PAYOUT to PAID). The regression coverage therefore lives on
 * TWO independent drop projects in the same spec:
 *
 *   Project A — Phase 2 flow:
 *     DROP_INCOME → validate → payPayoutRequest (simulate=success) →
 *     assert 2 distribution rows (PAYOUT PAID @ $950, DROP_PENDING_PAYOUT
 *     PENDING_PAYMENT @ $50 — task-drop-share-pending-parity: no longer an
 *     instant PAYOUT_DROP), PAYOUT_ADMIN = 0 (removed by
 *     fix/payout-credits-company-account).
 *     Mirrors drop-distribution.spec.ts but re-runs the assertions here so
 *     any Phase 3 regression in the cascade surfaces in THIS spec too.
 *
 *   Project B — Phase 3 flow:
 *     DROP_INCOME → validate → confirmPayout (Maksym) →
 *     assert 2 rows total under the PAYOUT umbrella (PAYOUT PAID +
 *     PAYOUT_CONFIRMED for Maksym). No DROP_PENDING_PAYOUT / PAYOUT_ADMIN —
 *     the drop never paid via the cascade.
 *
 * Bonus assertion: the GET /api/transactions?projectId= response is
 * disjoint between the two projects (no row from A pollutes B).
 */

import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  MAKSYM_ID,
  KOSTYA_ID,
  loginViaApi,
  createDropViaAPI,
  cleanupDropViaAPI,
  createDropProjectViaAPI,
  createDropIncomeViaAPI,
  validateTransactionViaAPI,
  payPayoutRequestViaAPI,
  findPendingPayoutsForProjectViaAPI,
  listTransactionsByProjectViaAPI,
  confirmPayoutViaAPI,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('Phase 2 distribution still works post-Phase 3 (AC6)', () => {
  test('cascade emits PAYOUT+DROP_PENDING_PAYOUT on validate+pay (0 PAYOUT_ADMIN); manual confirm path emits 2 rows; both paths co-exist', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropAEmail = `drop-regression-a-${suffix}@cheekycheese.dev`
    const dropBEmail = `drop-regression-b-${suffix}@cheekycheese.dev`

    // ── Project A — Phase 2 cascade ───────────────────────────────────
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId: dropIdA } = await createDropViaAPI(page, {
      email: dropAEmail,
      displayName: `Drop Regression A ${suffix}`,
      dropSharePercent: 5,
    })

    let dropIdB: string | null = null

    try {
      const { projectId: projectIdA } = await createDropProjectViaAPI(page, {
        dropId: dropIdA,
        seniorEmail: SEED_EMAILS.seniorA,
        rate: 5000,
        currency: 'USDT',
      })

      await loginViaApi(page, dropAEmail)
      const { txId: incomeTxIdA } = await createDropIncomeViaAPI(page, {
        projectId: projectIdA,
        amount: 1000,
        currency: 'USDT',
      })

      await loginViaApi(page, SEED_EMAILS.accountant)
      const { payoutRequestId: payoutReqIdA } = await validateTransactionViaAPI(page, incomeTxIdA)
      expect(payoutReqIdA).toBeTruthy()

      // DROP pays → cascade books a DROP_PENDING_PAYOUT COMPANY debt (no
      // longer an instant PAYOUT_DROP — task-drop-share-pending-parity),
      // flips PAYOUT to PAID.
      // No PAYOUT_ADMIN rows emitted (removed by fix/payout-credits-company-account).
      await loginViaApi(page, dropAEmail)
      const paid = await payPayoutRequestViaAPI(page, payoutReqIdA!)
      expect(paid.status).toBe('PAID')

      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const txA = await listTransactionsByProjectViaAPI(page, projectIdA)
      const payoutA = txA.filter((t) => t.type === 'PAYOUT')
      const dropPendingA = txA.filter((t) => t.type === 'DROP_PENDING_PAYOUT')
      const payoutAdminA = txA.filter((t) => t.type === 'PAYOUT_ADMIN')
      const payoutConfirmedA = txA.filter((t) => t.type === 'PAYOUT_CONFIRMED')

      // PAYOUT placeholder (1 row, $950 = payable after 5% drop share).
      expect(payoutA).toHaveLength(1)
      expect(payoutA[0]!.status).toBe('PAID')
      expect(parseFloat(payoutA[0]!.amount)).toBeCloseTo(950, 2)

      // DROP_PENDING_PAYOUT (1 row, PENDING_PAYMENT, $50 = drop's 5% share) —
      // NOT yet credited; an ADMIN/ACCOUNTANT must settle it with a receipt.
      expect(dropPendingA).toHaveLength(1)
      expect(dropPendingA[0]!.status).toBe('PENDING_PAYMENT')
      expect(parseFloat(dropPendingA[0]!.amount)).toBeCloseTo(50, 2)
      expect(dropPendingA[0]!.recipientId).toBe(dropIdA)
      expect(txA.filter((t) => t.type === 'PAYOUT_DROP')).toHaveLength(0)

      // PAYOUT_ADMIN — 0 rows (regression canary).
      // fix/payout-credits-company-account removed the automatic 50/50 split.
      // The company account is credited via PAYOUT.fundingSource='COMPANY_ACCOUNT'.
      expect(
        payoutAdminA,
        'PAYOUT_ADMIN rows must be absent after Variant-A split removal',
      ).toHaveLength(0)

      // No PAYOUT_CONFIRMED on the cascade path — Phase 3 stays orthogonal.
      expect(payoutConfirmedA).toHaveLength(0)

      // ── Project B — Phase 3 manual confirmation path ─────────────────
      const { dropId: dropIdBLocal } = await createDropViaAPI(page, {
        email: dropBEmail,
        displayName: `Drop Regression B ${suffix}`,
        dropSharePercent: 5,
      })
      dropIdB = dropIdBLocal

      const { projectId: projectIdB } = await createDropProjectViaAPI(page, {
        dropId: dropIdBLocal,
        seniorEmail: SEED_EMAILS.seniorB,
        rate: 5000,
        currency: 'USDT',
      })

      await loginViaApi(page, dropBEmail)
      const { txId: incomeTxIdB } = await createDropIncomeViaAPI(page, {
        projectId: projectIdB,
        amount: 1000,
        currency: 'USDT',
      })

      await loginViaApi(page, SEED_EMAILS.accountant)
      await validateTransactionViaAPI(page, incomeTxIdB)

      // ADMIN confirms-payout → Maksym. Phase 2 cascade does NOT fire.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const pendingB = await findPendingPayoutsForProjectViaAPI(page, projectIdB)
      expect(pendingB).toHaveLength(1)
      const payoutTxB = pendingB[0]!
      await confirmPayoutViaAPI(page, payoutTxB.id, MAKSYM_ID)

      const txB = await listTransactionsByProjectViaAPI(page, projectIdB)
      const payoutB = txB.filter((t) => t.type === 'PAYOUT')
      const payoutDropB = txB.filter((t) => t.type === 'PAYOUT_DROP')
      const payoutAdminB = txB.filter((t) => t.type === 'PAYOUT_ADMIN')
      const payoutConfirmedB = txB.filter((t) => t.type === 'PAYOUT_CONFIRMED')

      // PAYOUT flipped to PAID by Phase 3.
      expect(payoutB).toHaveLength(1)
      expect(payoutB[0]!.status).toBe('PAID')
      expect(payoutB[0]!.id).toBe(payoutTxB.id)

      // No Phase 2 cascade rows on Project B.
      expect(payoutDropB).toHaveLength(0)
      expect(payoutAdminB).toHaveLength(0)

      // Exactly one PAYOUT_CONFIRMED, crediting Maksym.
      expect(payoutConfirmedB).toHaveLength(1)
      expect(payoutConfirmedB[0]!.recipientId).toBe(MAKSYM_ID)
      expect(payoutConfirmedB[0]!.status).toBe('PAID')
      expect(parseFloat(payoutConfirmedB[0]!.amount)).toBeCloseTo(950, 2)

      // ── Bonus: Project A's transactions are NOT visible on Project B ─
      // GET /api/transactions?projectId=B returns ONLY B's rows.
      const projectIdsB = new Set(txB.map((t) => t.projectId))
      expect(projectIdsB.size).toBeLessThanOrEqual(1)
      if (projectIdsB.size === 1) {
        expect(projectIdsB.has(projectIdB)).toBe(true)
      }
    } finally {
      await cleanupDropViaAPI(page, dropIdA)
      if (dropIdB) {
        await cleanupDropViaAPI(page, dropIdB)
      }
    }
  })
})
