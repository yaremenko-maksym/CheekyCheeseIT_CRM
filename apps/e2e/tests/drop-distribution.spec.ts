/**
 * drop-distribution.spec.ts — task-drop-phase2-e2e (AC2).
 *
 * REAL-API coverage of the Phase 2 distribution math (§8.1 of the spec):
 *   income $1000, senior 26%, drop 5% → senior=$260, drop=$50, partners=[$345, $345].
 *
 * This spec exercises the full backend cascade end-to-end on the live
 * NestJS instance (no Playwright route mocks). Steps:
 *   1. ADMIN provisions a fresh DROP user + drop-team (real API).
 *   2. ADMIN creates a drop-project routed through that DROP user
 *      (using a seed SENIOR with the canonical 26% share).
 *   3. DROP logs in and posts a $1000 DROP_INCOME (PENDING).
 *   4. ACCOUNTANT validates the income → backend creates the
 *      payout_request + placeholder PAYOUT row (PENDING_PAYMENT).
 *   5. DROP pays the payout_request (simulate=success) → backend
 *      runs `computeDropDistribution` and inserts:
 *        * PAYOUT (placeholder, mutated to PAID with payable=950)
 *        * PAYOUT_DROP ($50, recipient = drop)
 *        * 2× PAYOUT_ADMIN ($345 to Maksym + $345 to Kostya)
 *   6. Assert via REST: 4 distinct rows (PAYOUT + PAYOUT_DROP + 2× PAYOUT_ADMIN),
 *      sum-of-distribution = $1000 ($260 senior keep + $50 drop + $345+$345 partners).
 *
 * The "senior keep" portion lives implicitly on the SENIOR — the backend
 * does NOT insert a separate PAYOUT for the senior's slice (the senior
 * was already paid off-platform by the DROP). We assert this gap by
 * confirming the PAYOUT_DROP + PAYOUT_ADMIN rows sum to exactly $740
 * (= 1000 − 260) and the PAYOUT placeholder row (which represents the
 * total transferred off-platform = payable amount) matches the validate
 * step's recorded payable.
 *
 * Cleanup: each test calls `cleanupDropViaAPI` to roll the drop user back
 * to archived state — cascades to the drop-team + project + transactions.
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
  listTransactionsByProjectViaAPI,
  getTransactionViaAPI,
} from './fixtures'

// MAKSYM_ID / KOSTYA_ID are re-exported from fixtures.ts (synced with the
// backend's `@crm/shared` constants — same UUIDs the seed writes).

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('Drop distribution math — real API (AC2)', () => {
  test('$1000 → senior $260 / drop $50 / partners $345 + $345 (spec §8.1)', async ({ page }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-dist-${suffix}@cheekycheese.dev`

    // Step 1: provision DROP user + drop-team via the admin endpoint.
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Drop Dist ${suffix}`,
      // Canonical 5% drop share — matches spec §8.1 example.
      dropSharePercent: 5,
    })

    try {
      // Step 2: create a drop-project routed through the DROP, with a
      // seed SENIOR at the canonical 26% share (seed default).
      const { projectId, seniorId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
        rate: 5000,
        currency: 'USDT',
      })
      expect(seniorId).toBeTruthy()

      // Step 3: DROP logs in and posts DROP_INCOME $1000.
      await loginViaApi(page, dropEmail)
      const { txId: incomeTxId } = await createDropIncomeViaAPI(page, {
        projectId,
        amount: 1000,
        currency: 'USDT',
      })

      // Status sanity — backend always lands DROP_INCOME in PENDING.
      const pending = await getTransactionViaAPI(page, incomeTxId)
      expect(pending.status).toBe('PENDING')

      // Step 4: ACCOUNTANT validates (flips to VALIDATED + creates payout_request).
      await loginViaApi(page, SEED_EMAILS.accountant)
      const { payoutRequestId } = await validateTransactionViaAPI(page, incomeTxId)
      expect(payoutRequestId).toBeTruthy()

      // Step 5: DROP pays the payout_request → triggers the distribution
      // cascade (insert PAYOUT_DROP + 2× PAYOUT_ADMIN, mutate the
      // placeholder PAYOUT to PAID).
      // NOTE: backend returns 403 to the DROP caller because the post-pay
      // `findPayoutRequest` response read blocks DROP — the helper papers
      // over this (see `payPayoutRequestViaAPI` jsdoc) and re-reads as
      // ADMIN below. The DB-side cascade has already committed.
      await loginViaApi(page, dropEmail)
      const paid = await payPayoutRequestViaAPI(page, payoutRequestId!)
      expect(paid.status).toBe('PAID')
      expect(paid.txHash).toBeTruthy()

      // Optional double-check via ADMIN read — confirms DB state matches.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const adminCheck = await page.request.get(
        `http://localhost:3001/api/payout-requests/${payoutRequestId}`,
      )
      expect(adminCheck.status()).toBe(200)
      const adminPayout = (await adminCheck.json()) as { status: string }
      expect(adminPayout.status).toBe('PAID')

      // Step 6: full project ledger via ADMIN read.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const projectTxs = await listTransactionsByProjectViaAPI(page, projectId)

      // Filter by type so the regression assertions are explicit and
      // resilient to incidental rows (e.g. auto-generated invoice trace).
      const dropIncomeRows = projectTxs.filter((t) => t.type === 'DROP_INCOME')
      const payoutRows = projectTxs.filter((t) => t.type === 'PAYOUT')
      const payoutDropRows = projectTxs.filter((t) => t.type === 'PAYOUT_DROP')
      const payoutAdminRows = projectTxs.filter((t) => t.type === 'PAYOUT_ADMIN')

      // DROP_INCOME = 1 row, PAID after `payPayoutRequest`.
      expect(dropIncomeRows).toHaveLength(1)
      expect(dropIncomeRows[0]!.status).toBe('PAID')
      expect(parseFloat(dropIncomeRows[0]!.amount)).toBeCloseTo(1000, 2)

      // PAYOUT placeholder (1 row). Amount = payable recorded at validate
      // time = 1000 * (1 - drop% / 100) = 1000 * (1 - 5/100) = 950.
      expect(payoutRows).toHaveLength(1)
      expect(payoutRows[0]!.status).toBe('PAID')
      expect(parseFloat(payoutRows[0]!.amount)).toBeCloseTo(950, 2)

      // PAYOUT_DROP (1 row, $50, receiver = drop).
      expect(payoutDropRows).toHaveLength(1)
      expect(payoutDropRows[0]!.status).toBe('PAID')
      expect(parseFloat(payoutDropRows[0]!.amount)).toBeCloseTo(50, 2)
      expect(payoutDropRows[0]!.receiverId).toBe(dropId)
      // Phase 2 introduces `recipientId` as the semantic alias for
      // PAYOUT_DROP — must match the drop user id.
      expect(payoutDropRows[0]!.recipientId).toBe(dropId)

      // PAYOUT_ADMIN (2 rows, $345 each, one Maksym + one Kostya).
      expect(payoutAdminRows).toHaveLength(2)
      const maksymRow = payoutAdminRows.find((r) => r.receiverId === MAKSYM_ID)
      const kostyaRow = payoutAdminRows.find((r) => r.receiverId === KOSTYA_ID)
      expect(maksymRow).toBeTruthy()
      expect(kostyaRow).toBeTruthy()
      expect(parseFloat(maksymRow!.amount)).toBeCloseTo(345, 2)
      expect(parseFloat(kostyaRow!.amount)).toBeCloseTo(345, 2)
      expect(maksymRow!.status).toBe('PAID')
      expect(kostyaRow!.status).toBe('PAID')

      // Conservation: distribution buckets (drop + partners) total the
      // residual after the senior keeps 26% off-platform.
      // 50 + 345 + 345 = 740 = 1000 − 260 ✓.
      const distributionTotal =
        parseFloat(payoutDropRows[0]!.amount) +
        parseFloat(maksymRow!.amount) +
        parseFloat(kostyaRow!.amount)
      expect(distributionTotal).toBeCloseTo(740, 2)

    } finally {
      // Cascade-archive the drop (cleans up team + project + transactions).
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
