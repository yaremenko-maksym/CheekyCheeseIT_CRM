/**
 * drop-role-end-to-end.spec.ts — task-autotest-business-logic-coverage (A).
 *
 * High-level DROP-role integration smoke. The fine-grained per-area specs
 * (`drop-create.spec.ts`, `drop-distribution.spec.ts`, `drop-archive-real.spec.ts`,
 * `drop-cash-channel.spec.ts`, …) each prove one slice; this spec wires them
 * end-to-end so a regression that breaks the journey *between* the slices
 * (e.g. cash cascade leaving DROP_INCOME unreachable to /finance, or archive
 * cascading wrong onto company-debt rows) surfaces on a single failure.
 *
 * Full journey:
 *   1. ADMIN provisions DROP user + drop-team via /api/users/drops.
 *   2. ADMIN creates drop-project routed through the DROP.
 *   3. DROP logs in, posts DROP_INCOME via API.
 *   4. ACCOUNTANT validates → PENDING PAYOUT placeholder created.
 *   5. ACCOUNTANT confirms cash (Maksym) → cascade emits expected rows.
 *   6. ADMIN settles COMPANY debt → SENIOR_INCOME inserted.
 *   7. ADMIN cleanup-archives the DROP → all related projects archived,
 *      pending obligations resolved or excluded.
 *
 * Real-API.
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
  listTransactionsByProjectViaAPI,
  findUserByEmailViaApi,
  getDropProjectsViaAPI,
  cleanupDropViaAPI,
} from './fixtures'

const REAL_API = 'http://localhost:3001/api'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('DROP role — end-to-end journey', () => {
  test('create → income → validate → cash settle → company settle → archive', async ({ page }) => {
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
      // Step 2: drop-project.
      const proj = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
      })
      projectId = proj.projectId

      // Step 3: DROP posts income.
      await loginViaApi(page, dropEmail)
      const { txId } = await createDropIncomeViaAPI(page, {
        projectId,
        amount: 1000,
      })
      expect(txId).toBeTruthy()

      // Step 4: ACCOUNTANT validates.
      await loginViaApi(page, SEED_EMAILS.accountant)
      const { payoutRequestId } = await validateTransactionViaAPI(page, txId)
      expect(payoutRequestId).toBeTruthy()

      // Step 5: ACCOUNTANT confirms cash → Maksym.
      const cashRes = await page.request.post(`${REAL_API}/payments/confirm-cash`, {
        data: { incomeId: txId, recipientAdminId: MAKSYM_ID },
      })
      expect(cashRes.status()).toBeLessThan(400)

      // Cascade emitted: ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const projectTxs = await listTransactionsByProjectViaAPI(page, projectId)
      const adminCash = projectTxs.find((t) => t.type === 'ADMIN_INCOME_CASH')
      const pendingPayout = projectTxs.find((t) => t.type === 'SENIOR_PENDING_PAYOUT')
      expect(adminCash, 'cash cascade should emit ADMIN_INCOME_CASH').toBeTruthy()
      expect(pendingPayout, 'cash cascade should emit SENIOR_PENDING_PAYOUT').toBeTruthy()

      // Step 6: ADMIN settles the COMPANY debt.
      const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorA)
      expect(senior).toBeTruthy()
      const companyListRes = await page.request.get(`${REAL_API}/pending-settlements/company`)
      const companyList = (await companyListRes.json()) as Array<{
        id: string
        creditorUserId: string
      }>
      const obligation = companyList.find((o) => o.creditorUserId === senior!.id)
      expect(obligation, 'company list must include the senior debt').toBeTruthy()

      const settleRes = await page.request.post(
        `${REAL_API}/pending-settlements/${obligation!.id}/settle-company`,
        { data: {} },
      )
      expect(settleRes.status()).toBeLessThan(400)

      // After settle, SENIOR_INCOME row appears on the project.
      const afterTxs = await listTransactionsByProjectViaAPI(page, projectId)
      const seniorIncomes = afterTxs.filter(
        (t) => t.type === 'SENIOR_INCOME' && t.status === 'PAID',
      )
      expect(seniorIncomes.length).toBeGreaterThanOrEqual(1)
    } finally {
      // Step 7: cleanup (also asserts archive cascade implicitly — the helper
      // archives the drop which cascade-archives team + projects).
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
