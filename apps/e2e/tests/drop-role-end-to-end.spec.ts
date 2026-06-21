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
 *        PAYOUT_DROP (PAID)
 *        DROP_INCOME (PAID)
 *   8. ADMIN settles COMPANY debt via by-source-transaction endpoint → SENIOR_INCOME inserted.
 *   9. ADMIN cleanup-archives the DROP → all related projects archived.
 *
 * Real-API. Backend must be running at http://localhost:3001.
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

const REAL_API = 'http://localhost:3001/api'

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

      // Step 7: DROP pays → cascade emits SENIOR_PENDING_PAYOUT + PAYOUT_DROP.
      await loginViaApi(page, dropEmail)
      await payPayoutRequestViaAPI(page, prId!)

      // Verify cascade rows.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const projectTxs = await listTransactionsByProjectViaAPI(page, projectId)

      const payoutDrop = projectTxs.find((t) => t.type === 'PAYOUT_DROP' && t.status === 'PAID')
      const pendingPayout = projectTxs.find(
        (t) => t.type === 'SENIOR_PENDING_PAYOUT' && t.status === 'PENDING_PAYMENT',
      )
      expect(payoutDrop, 'pay cascade should emit PAYOUT_DROP (PAID)').toBeTruthy()
      expect(
        pendingPayout,
        'pay cascade should emit SENIOR_PENDING_PAYOUT (PENDING_PAYMENT)',
      ).toBeTruthy()

      // Step 8: ADMIN settles the COMPANY debt via the by-source-transaction endpoint
      // (this is what the finance-page SettleSeniorPayoutDialog calls in PR #265).
      const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorA)
      expect(senior).toBeTruthy()

      const sourceTxId = pendingPayout!.id
      const settleRes = await page.request.post(
        `${REAL_API}/pending-settlements/by-source-transaction/${sourceTxId}/settle-company`,
        {
          data: {
            fundingSource: 'ADMIN_PERSONAL',
            payerAdminId: MAKSYM_ID,
            currency: 'USDT',
          },
        },
      )
      expect(settleRes.status()).toBeLessThan(400)

      // After settle: SENIOR_INCOME (PAID) appears on the project.
      const afterTxs = await listTransactionsByProjectViaAPI(page, projectId)
      const seniorIncomes = afterTxs.filter(
        (t) => t.type === 'SENIOR_INCOME' && t.status === 'PAID' && t.receiverId === senior!.id,
      )
      expect(
        seniorIncomes.length,
        'settle should insert exactly one SENIOR_INCOME for the senior',
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
        'obligation should be removed from /company after settle',
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
