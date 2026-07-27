/**
 * drop-role-end-to-end.spec.ts — task-autotest-business-logic-coverage (A).
 *
 * High-level DROP-role integration smoke. The fine-grained per-area specs
 * (`drop-create.spec.ts`, `drop-distribution.spec.ts`, `drop-archive-real.spec.ts`,
 * …) each prove one slice; this spec wires them end-to-end so a regression
 * that breaks the journey *between* the slices surfaces on a single failure.
 *
 * Full journey (reworked for PR #262 + #265):
 *   1. ADMIN provisions DROP user + drop-team via /api/users/drops.
 *   2. ADMIN onboards DROP (legalFullName → contract/ready → sign → tos/accept).
 *   3. ADMIN ensures company wallet is set (seed leaves walletAddress=NULL).
 *   4. ADMIN creates drop-project routed through the DROP.
 *   5. DROP posts DROP_INCOME via API.
 *   6. ACCOUNTANT validates → payout_request created.
 *   7. DROP pays payout_request → cascade emits:
 *        SENIOR_PENDING_PAYOUT (PENDING_PAYMENT) — COMPANY debt
 *        DROP_PENDING_PAYOUT (PENDING_PAYMENT) — COMPANY debt (task-drop-share-pending-parity)
 *        DROP_INCOME (PAID)
 *   8. ADMIN settles BOTH the senior + drop COMPANY debts via the
 *      by-source-transaction endpoint → SENIOR_INCOME + PAYOUT_DROP inserted in place.
 *   9. ADMIN cleanup-archives the DROP → all related projects archived.
 *
 * Real-API. Backend must be running at http://localhost:3001 (override via
 * E2E_REAL_API_BASE for an isolated scratch stand — mirrors fixtures.ts).
 *
 * Step 8 above is exercised by `task-settle-in-place` (ADR 2026-07-14,
 * PR #379): the settle now flips the SOURCE `*_PENDING_PAYOUT` row in
 * place instead of inserting a second transaction (see
 * drop-share-usdt-income.spec.ts / pending-settlement.spec.ts for the
 * dedicated in-place assertions — this smoke only needs the settle calls to
 * keep succeeding end-to-end).
 *
 * task-drop-share-pending-parity (2026-07-27): the drop's own slice used to
 * post directly as a PAID `PAYOUT_DROP` from the pay cascade (bypassing the
 * owner's "pending until confirmed with a receipt" rule). It now books a
 * `DROP_PENDING_PAYOUT` COMPANY debt — same shape as the senior's — and is
 * closed by the SAME settle endpoint used below for the senior debt.
 */

import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  MAKSYM_ID,
  loginViaApi,
  createDropViaAPI,
  createDropProjectViaAPI,
  createDropIncomeViaAPI,
  validateTransactionViaAPI,
  createPayoutRequestViaAPI,
  payPayoutRequestViaAPI,
  listTransactionsByProjectViaAPI,
  findUserByEmailViaApi,
  getDropProjectsViaAPI,
  cleanupDropViaAPI,
  ensureCompanyWalletViaAPI,
  onboardDropViaAPI,
} from './fixtures'

// task-settle-in-place-e2e: env-aware (was hardcoded to localhost:3001) —
// mirrors fixtures.ts / pending-settlement.spec.ts so this file is portable
// to an isolated scratch stand.
const REAL_API = `${process.env['E2E_REAL_API_BASE'] ?? 'http://localhost:3001'}/api`

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('DROP role — end-to-end journey', () => {
  test('create → onboard → income → validate → pay → company settle → archive', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `e2e-drop-${suffix}@cheekycheese.dev`

    // Step 1: ADMIN provisions DROP.
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId, teamId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `E2E Drop ${suffix}`,
    })
    expect(dropId).toBeTruthy()
    expect(teamId).toBeTruthy()

    let projectId: string | null = null
    try {
      // Step 2: Onboard DROP — required before income endpoints are accessible.
      await onboardDropViaAPI(page, { dropId, dropEmail })

      // Step 3: Ensure company wallet (seed leaves walletAddress=NULL;
      // payout_request creation will fail without it).
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await ensureCompanyWalletViaAPI(page)

      // Step 4: Create drop-project.
      const proj = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
      })
      projectId = proj.projectId

      // Step 5: DROP posts income.
      await loginViaApi(page, dropEmail)
      const { txId } = await createDropIncomeViaAPI(page, {
        projectId,
        amount: 1000,
      })
      expect(txId).toBeTruthy()

      // Step 6: ACCOUNTANT validates → payout_request created.
      await loginViaApi(page, SEED_EMAILS.accountant)
      const { payoutRequestId } = await validateTransactionViaAPI(page, txId)

      let prId = payoutRequestId
      if (!prId) {
        // Some builds create payout_request lazily — create it explicitly.
        await loginViaApi(page, dropEmail)
        const created = await createPayoutRequestViaAPI(page, [txId])
        prId = created.payoutRequestId
      }

      // Step 7: DROP pays → cascade emits SENIOR_PENDING_PAYOUT + DROP_PENDING_PAYOUT
      // (task-drop-share-pending-parity: the drop's own slice is no longer an
      // instant PAID PAYOUT_DROP — it is a COMPANY debt now, same as the senior's).
      await loginViaApi(page, dropEmail)
      await payPayoutRequestViaAPI(page, prId!)

      // Verify cascade rows.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const projectTxs = await listTransactionsByProjectViaAPI(page, projectId)

      const dropPending = projectTxs.find(
        (t) => t.type === 'DROP_PENDING_PAYOUT' && t.status === 'PENDING_PAYMENT',
      )
      const pendingPayout = projectTxs.find(
        (t) => t.type === 'SENIOR_PENDING_PAYOUT' && t.status === 'PENDING_PAYMENT',
      )
      expect(
        dropPending,
        'pay cascade should emit DROP_PENDING_PAYOUT (PENDING_PAYMENT)',
      ).toBeTruthy()
      expect(
        pendingPayout,
        'pay cascade should emit SENIOR_PENDING_PAYOUT (PENDING_PAYMENT)',
      ).toBeTruthy()
      // Not yet credited — the drop's balance only moves once ADMIN/ACCOUNTANT
      // confirms the payout with a receipt (settle step below).
      expect(
        projectTxs.some((t) => t.type === 'PAYOUT_DROP'),
        'no PAYOUT_DROP should exist before the drop obligation is settled',
      ).toBe(false)

      // Step 8: ADMIN settles BOTH COMPANY debts via the by-source-transaction
      // endpoint (this is what the finance-page SettleSeniorPayoutDialog calls).
      const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorA)
      expect(senior).toBeTruthy()

      const sourceTxId = pendingPayout!.id
      // task-receipts-backend (#10): settleSeniorPayoutSchema now requires a
      // mandatory, currency-aware receipt — USDT ⇒ explorer link only.
      const settleRes = await page.request.post(
        `${REAL_API}/pending-settlements/by-source-transaction/${sourceTxId}/settle-company`,
        {
          data: {
            fundingSource: 'ADMIN_PERSONAL',
            payerAdminId: MAKSYM_ID,
            currency: 'USDT',
            receiptExternalUrl: 'https://etherscan.io/tx/0xdroproleend2end0001',
          },
        },
      )
      expect(settleRes.status()).toBeLessThan(400)

      // task-drop-share-pending-parity: settle the drop's own COMPANY debt the
      // same way — flips DROP_PENDING_PAYOUT → PAYOUT_DROP (PAID) in place.
      const dropSourceTxId = dropPending!.id
      const settleDropRes = await page.request.post(
        `${REAL_API}/pending-settlements/by-source-transaction/${dropSourceTxId}/settle-company`,
        {
          data: {
            fundingSource: 'ADMIN_PERSONAL',
            payerAdminId: MAKSYM_ID,
            currency: 'USDT',
            receiptExternalUrl: 'https://etherscan.io/tx/0xdroproleend2end0002',
          },
        },
      )
      expect(settleDropRes.status()).toBeLessThan(400)

      // After settle: SENIOR_INCOME (PAID) + PAYOUT_DROP (PAID) appear on the project.
      const afterTxs = await listTransactionsByProjectViaAPI(page, projectId)
      const seniorIncomes = afterTxs.filter(
        (t) => t.type === 'SENIOR_INCOME' && t.status === 'PAID' && t.receiverId === senior!.id,
      )
      expect(
        seniorIncomes.length,
        'settle should insert exactly one SENIOR_INCOME for the senior',
      ).toBeGreaterThanOrEqual(1)
      const payoutDropRows = afterTxs.filter(
        (t) => t.type === 'PAYOUT_DROP' && t.status === 'PAID' && t.receiverId === dropId,
      )
      expect(
        payoutDropRows.length,
        'settle should flip the drop IOU into exactly one PAYOUT_DROP',
      ).toBeGreaterThanOrEqual(1)

      // Obligation is gone from /company list — match by sourceTransactionId (precise)
      // since seniorA may have other pending obligations from parallel test runs.
      const companyListRes = await page.request.get(`${REAL_API}/pending-settlements/company`)
      const companyList = (await companyListRes.json()) as Array<{
        seniorId: string
        sourceTransactionId: string
      }>
      expect(
        companyList.find((o) => o.sourceTransactionId === sourceTxId),
        'senior obligation should be removed from /company after settle',
      ).toBeFalsy()
      expect(
        companyList.find((o) => o.sourceTransactionId === dropSourceTxId),
        'drop obligation should be removed from /company after settle',
      ).toBeFalsy()
    } finally {
      // Step 9: cleanup (archive-cascades team + projects).
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)

      // Verify archive cascade — projects of this drop should be archived.
      const archivedProjects = await getDropProjectsViaAPI(page, dropId).catch(() => [])
      for (const p of archivedProjects) {
        expect(p.archivedAt, `project ${p.id} should be archived`).not.toBeNull()
      }
    }
  })
})
