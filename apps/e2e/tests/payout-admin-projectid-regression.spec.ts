/**
 * payout-admin-projectid-regression.spec.ts — task-e2e-fragile-points-audit.
 *
 * Backlog AC5 regression: PAYOUT_ADMIN rows for senior-projects used to be
 * inserted WITHOUT `projectId`, which meant a `?projectId=` filter missed
 * them. The fix (PR #66) sets `projectId` on every PAYOUT_ADMIN row in both
 * branches (senior + drop) of `payPayoutRequest`.
 *
 * The existing `senior-project-distribution-regression.spec.ts` uses the
 * payoutRequestId-based join helper specifically to dodge the projectId
 * issue. NONE of the specs assert the post-fix invariant: every
 * PAYOUT_ADMIN row carries a non-null `projectId` matching the project
 * that generated it.
 *
 * A regression here is silent — no UI crash, just stats / reports that
 * silently drop PAYOUT_ADMIN rows when filtered by project.
 *
 * This spec:
 *   1. Provisions a fresh senior-project (no dropId).
 *   2. Runs the full income → validate → pay flow.
 *   3. Lists transactions via BOTH endpoints:
 *      a) `?payoutRequestId=` (always returns everything linked)
 *      b) `?projectId=` (must now include PAYOUT_ADMIN rows post-fix)
 *   4. Asserts that the projectId-filter results CONTAIN both PAYOUT_ADMIN
 *      rows AND each row's `projectId === projectId`.
 *
 * Same regression check for a drop-project (the cascade is different but
 * the projectId invariant must hold on both branches).
 */

import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  MAKSYM_ID,
  KOSTYA_ID,
  loginViaApi,
  createSeniorProjectViaAPI,
  createSeniorIncomeViaAPI,
  createDropViaAPI,
  cleanupDropViaAPI,
  createDropProjectViaAPI,
  createDropIncomeViaAPI,
  validateTransactionViaAPI,
  payPayoutRequestViaAPI,
  listTransactionsByProjectViaAPI,
} from './fixtures'

const REAL_API = 'http://localhost:3001/api'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('PAYOUT_ADMIN.projectId regression — both cascade branches', () => {
  test('senior-project: PAYOUT_ADMIN rows carry projectId after pay', async ({ page }) => {
    const suffix = uniqueSuffix()

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `PR Regression Senior ${suffix}`,
    })

    try {
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { txId } = await createSeniorIncomeViaAPI(page, {
        projectId,
        amount: 1000,
        currency: 'USDT',
      })

      await loginViaApi(page, SEED_EMAILS.accountant)
      const { payoutRequestId } = await validateTransactionViaAPI(page, txId)
      expect(payoutRequestId).toBeTruthy()

      await loginViaApi(page, SEED_EMAILS.seniorA)
      const paid = await payPayoutRequestViaAPI(page, payoutRequestId!)
      expect(paid.status).toBe('PAID')

      // Fetch via the ?projectId= filter — backlog AC5 fix means
      // PAYOUT_ADMIN rows MUST surface here.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const projectTxs = await listTransactionsByProjectViaAPI(page, projectId)

      const payoutAdmins = projectTxs.filter((t) => t.type === 'PAYOUT_ADMIN')

      // Two PAYOUT_ADMIN rows expected (one per partner).
      expect(payoutAdmins).toHaveLength(2)

      // Each row's projectId MUST be set + equal to our project.
      for (const row of payoutAdmins) {
        expect(
          row.projectId,
          `PAYOUT_ADMIN row ${row.id} missing projectId — backlog AC5 regression`,
        ).toBe(projectId)
      }

      // Sanity: both partner rows exist by receiverId.
      const maksym = payoutAdmins.find((r) => r.receiverId === MAKSYM_ID)
      const kostya = payoutAdmins.find((r) => r.receiverId === KOSTYA_ID)
      expect(maksym).toBeTruthy()
      expect(kostya).toBeTruthy()
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })

  test('drop-project: PAYOUT_ADMIN rows carry projectId after pay (canary)', async ({
    page,
  }) => {
    // Mirror of the senior path. PR #65 wired projectId on the drop branch
    // too — without this canary, a future refactor could regress one
    // branch without the other.
    const suffix = uniqueSuffix()
    const dropEmail = `drop-payoutadmin-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Drop PayoutAdmin ${suffix}`,
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

      await loginViaApi(page, dropEmail)
      await payPayoutRequestViaAPI(page, payoutRequestId!)

      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const projectTxs = await listTransactionsByProjectViaAPI(page, projectId)
      const payoutAdmins = projectTxs.filter((t) => t.type === 'PAYOUT_ADMIN')

      // Drop cascade always produces 2 PAYOUT_ADMIN rows.
      expect(payoutAdmins).toHaveLength(2)
      for (const row of payoutAdmins) {
        expect(
          row.projectId,
          `Drop-cascade PAYOUT_ADMIN row ${row.id} missing projectId`,
        ).toBe(projectId)
      }
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
