/**
 * payout-admin-projectid-regression.spec.ts — task-e2e-fragile-points-audit.
 *
 * Originally tested (backlog AC5): PAYOUT_ADMIN rows for both senior-projects
 * and drop-projects carry a non-null `projectId` matching the originating
 * project, so that `?projectId=` filters return them correctly.
 *
 * fix/payout-credits-company-account (Variant A): the automatic 50/50
 * PAYOUT_ADMIN partner split has been REMOVED from BOTH cascade branches
 * (senior + drop). The company USDT account is credited the full `payable`
 * via the PAYOUT row's fundingSource='COMPANY_ACCOUNT' marker — the
 * PAYOUT_ADMIN rows were a double-distribution of the same money on top of
 * that credit. Admin income is now a deliberate manual flow (DIVIDEND_TO_ADMIN).
 *
 * This spec is therefore repurposed as a regression guard for the split
 * removal itself: after payout settlement, NEITHER branch (senior nor drop)
 * must produce ANY PAYOUT_ADMIN rows. The `?projectId=` filter invariant
 * (the original AC5 concern) is moot because there are no rows to filter.
 *
 * Two scenarios to cover both cascade branches independently:
 *   1. Senior-project: full income → validate → pay flow → assert 0 PAYOUT_ADMIN.
 *   2. Drop-project:   full income → validate → pay flow → assert 0 PAYOUT_ADMIN.
 *
 * A regression here is detectable immediately: if the split is re-introduced,
 * PAYOUT_ADMIN rows appear where we assert length 0.
 */

import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  loginViaApi,
  createSeniorProjectViaAPI,
  createSeniorIncomeViaAPI,
  createDropViaAPI,
  cleanupDropViaAPI,
  createDropProjectViaAPI,
  createDropIncomeViaAPI,
  validateTransactionViaAPI,
  createPayoutRequestViaAPI,
  payPayoutRequestViaAPI,
  listTransactionsByProjectViaAPI,
} from './fixtures'

const REAL_API = 'http://localhost:3001/api'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('0 PAYOUT_ADMIN after payout — both cascade branches (Variant-A split removal)', () => {
  test('senior-project: 0 PAYOUT_ADMIN rows after pay (split removed)', async ({ page }) => {
    const suffix = uniqueSuffix()

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `No-Split Senior ${suffix}`,
    })

    try {
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { txId } = await createSeniorIncomeViaAPI(page, {
        projectId,
        amount: 1000,
        currency: 'USDT',
      })

      await loginViaApi(page, SEED_EMAILS.accountant)
      await validateTransactionViaAPI(page, txId)

      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { payoutRequestId } = await createPayoutRequestViaAPI(page, [txId])
      expect(payoutRequestId).toBeTruthy()

      const paid = await payPayoutRequestViaAPI(page, payoutRequestId)
      expect(paid.status).toBe('PAID')

      // After Variant-A: no PAYOUT_ADMIN rows on senior-project payout.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const projectTxs = await listTransactionsByProjectViaAPI(page, projectId)
      const payoutAdmins = projectTxs.filter((t) => t.type === 'PAYOUT_ADMIN')

      expect(
        payoutAdmins,
        'Senior-project payout must NOT produce PAYOUT_ADMIN rows (Variant-A split removal)',
      ).toHaveLength(0)

      // Sanity: PAYOUT row was created and is PAID (company account credited).
      const payouts = projectTxs.filter((t) => t.type === 'PAYOUT')
      expect(payouts).toHaveLength(1)
      expect(payouts[0]!.status).toBe('PAID')
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })

  test('drop-project: 0 PAYOUT_ADMIN rows after pay (split removed)', async ({ page }) => {
    // Mirror of the senior path. Tests the drop cascade branch independently.
    const suffix = uniqueSuffix()
    const dropEmail = `drop-no-split-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Drop No Split ${suffix}`,
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

      // After Variant-A: no PAYOUT_ADMIN rows on drop-project payout.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const projectTxs = await listTransactionsByProjectViaAPI(page, projectId)
      const payoutAdmins = projectTxs.filter((t) => t.type === 'PAYOUT_ADMIN')

      expect(
        payoutAdmins,
        'Drop-project payout must NOT produce PAYOUT_ADMIN rows (Variant-A split removal)',
      ).toHaveLength(0)

      // Sanity: PAYOUT_DROP still created (drop's share is intact).
      const payoutDrops = projectTxs.filter((t) => t.type === 'PAYOUT_DROP')
      expect(payoutDrops).toHaveLength(1)
      expect(payoutDrops[0]!.status).toBe('PAID')
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
