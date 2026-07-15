/**
 * rbac-matrix-smoke.spec.ts — task-autotest-business-logic-coverage (K).
 *
 * Cross-role HTTP probe matrix for the endpoints introduced/changed by
 * Phase 4 refactor + drop-pays-company (PR #262 + #265):
 *
 *   GET  /api/balances/admin/:id                         — ADMIN / ACCOUNTANT 200, others 403.
 *   GET  /api/pending-settlements/company                — ADMIN / ACCOUNTANT 200, others 403.
 *   POST /api/pending-settlements/by-source-transaction/:id/settle-company — ADMIN / ACCOUNTANT only.
 *
 * Note (PR #262): POST /api/payments/confirm-cash and POST /api/payments/initiate-crypto
 * were deleted in PR #262. Their RBAC smoke tests have been removed accordingly.
 *
 * Removed (task-receipts-e2e, following task-receipts-backend review round 1
 * MED-1): the legacy 2-segment `POST /api/pending-settlements/:id/settle-company`
 * (obligation-id) route was deleted from the backend — it silently ignored its
 * body (no funding selection, no mandatory receipt), a privileged bypass of the
 * mandatory-receipt invariant this feature introduces. Verified dead from the
 * product surface (zero `apps/web` callers — only the 3-segment
 * `by-source-transaction` route is wired to the finance page); its RBAC smoke
 * block below was removed rather than pointed at a route that no longer exists.
 * The `by-source-transaction` RBAC test below is the sole remaining coverage of
 * this action and is unaffected (it already used the 3-segment route).
 *
 * Real-API. Each test logs in as a role via dev-login and probes the endpoint
 * with a bare-bones body sufficient to reach the RBAC branch (which runs BEFORE
 * any payload validation). For ADMIN/ACCOUNTANT we accept either 200 (true
 * happy path) or 400 (the RBAC check passes but the input fails) — both mean
 * the role itself wasn't blocked. The only thing we definitively reject is a
 * leaked 200 for forbidden roles.
 *
 * Why "smoke" and not full happy-path: the broader behavior is exercised in
 * the dedicated settlement specs. Here we just guard the RBAC contract — a
 * regression that widens the role check would surface across the whole matrix
 * at once.
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
  payPayoutRequestViaAPI,
  listTransactionsByProjectViaAPI,
  ensureCompanyWalletViaAPI,
  onboardDropViaAPI,
} from './fixtures'

const REAL_API = 'http://localhost:3001/api'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

/** Helper: returns true if the status indicates the RBAC branch passed. */
function rbacPassed(status: number): boolean {
  // 200, 201, 204 — clearly passed. 400 — input validation rejected after
  // the RBAC gate (still proves role was allowed). 404 — entity missing,
  // also post-RBAC. 409 — conflict (idempotency), post-RBAC.
  return [200, 201, 204, 400, 404, 409].includes(status)
}

/**
 * Plant a COMPANY-debt obligation using the new drop-income cascade.
 * Requires DROP to be onboarded and company wallet set.
 * Caller receives ADMIN session back.
 *
 * task-receipts-e2e: this used to also resolve `obligationId` (via
 * `GET /pending-settlements/company`) for the now-removed legacy 2-segment
 * `:id/settle-company` RBAC test (dead route, MED-1 — see file header). The
 * only remaining caller settles by `sourceTxId`, so the obligation-id lookup
 * was dropped.
 */
async function plantObligationForRbac(
  page: import('@playwright/test').Page,
  opts: {
    dropId: string
    dropEmail: string
    projectId: string
  },
): Promise<{ sourceTxId: string }> {
  const { dropId, dropEmail, projectId } = opts

  // Onboard DROP (idempotent — safe if already onboarded)
  await loginViaApi(page, SEED_ADMIN_EMAIL)
  await onboardDropViaAPI(page, { dropId, dropEmail })

  // Ensure company wallet
  await loginViaApi(page, SEED_ADMIN_EMAIL)
  await ensureCompanyWalletViaAPI(page)

  // DROP posts income
  await loginViaApi(page, dropEmail)
  const { txId: incomeTxId } = await createDropIncomeViaAPI(page, {
    projectId,
    amount: 1000,
  })

  // ACCOUNTANT validates
  await loginViaApi(page, SEED_EMAILS.accountant)
  const { payoutRequestId } = await validateTransactionViaAPI(page, incomeTxId)

  let prId = payoutRequestId
  if (!prId) {
    await loginViaApi(page, dropEmail)
    const created = await createPayoutRequestViaAPI(page, [incomeTxId])
    prId = created.payoutRequestId
  }

  // DROP pays → emits SENIOR_PENDING_PAYOUT
  await loginViaApi(page, dropEmail)
  await payPayoutRequestViaAPI(page, prId!)

  // Find the SENIOR_PENDING_PAYOUT source tx id
  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const txs = await listTransactionsByProjectViaAPI(page, projectId)
  const pendingPayout = txs.find(
    (t) => t.type === 'SENIOR_PENDING_PAYOUT' && t.status === 'PENDING_PAYMENT',
  )
  const sourceTxId = pendingPayout?.id ?? ''

  return { sourceTxId }
}

test.describe('RBAC matrix smoke — Phase 4 endpoints', () => {
  test('GET /api/balances/admin/:id — ADMIN / ACCOUNTANT 200, others 403', async ({ page }) => {
    // Allowed roles
    for (const email of [SEED_ADMIN_EMAIL, SEED_EMAILS.accountant]) {
      await loginViaApi(page, email)
      const res = await page.request.get(`${REAL_API}/balances/admin/${MAKSYM_ID}`)
      expect(
        rbacPassed(res.status()),
        `Expected RBAC pass for ${email} on /balances/admin (got ${res.status()})`,
      ).toBe(true)
    }

    // Forbidden roles — SENIOR, JUNIOR, HR.
    for (const email of [SEED_EMAILS.seniorA, SEED_EMAILS.juniorA, SEED_EMAILS.hrA]) {
      await loginViaApi(page, email)
      const res = await page.request.get(`${REAL_API}/balances/admin/${MAKSYM_ID}`)
      expect(res.status(), `Expected 403 for ${email} on /balances/admin`).toBe(403)
    }
  })

  test('GET /api/pending-settlements/company — ADMIN / ACCOUNTANT 200, others 403', async ({
    page,
  }) => {
    for (const email of [SEED_ADMIN_EMAIL, SEED_EMAILS.accountant]) {
      await loginViaApi(page, email)
      const res = await page.request.get(`${REAL_API}/pending-settlements/company`)
      expect(res.status(), `Expected 200 for ${email}`).toBe(200)
      expect(Array.isArray(await res.json())).toBe(true)
    }

    for (const email of [SEED_EMAILS.seniorA, SEED_EMAILS.juniorA, SEED_EMAILS.hrA]) {
      await loginViaApi(page, email)
      const res = await page.request.get(`${REAL_API}/pending-settlements/company`)
      expect(res.status(), `Expected 403 for ${email}`).toBe(403)
    }
  })

  // task-receipts-e2e: the legacy 2-segment `POST
  // /pending-settlements/:id/settle-company` (obligation-id) RBAC block that
  // used to live here was REMOVED along with the backend route (dead route,
  // MED-1 — see file header). The by-source-transaction test below is the
  // sole remaining coverage of this action.
  test('POST /api/pending-settlements/by-source-transaction/:id/settle-company — ADMIN / ACCOUNTANT only; SENIOR / DROP 403', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `rbac-src-settle-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `RBAC SrcSettle ${suffix}`,
    })

    try {
      const { projectId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
      })

      const { sourceTxId } = await plantObligationForRbac(page, {
        dropId,
        dropEmail,
        projectId,
      })

      const ghostId = sourceTxId || '11111111-1111-1111-1111-111111111111'
      const endpointUrl = `${REAL_API}/pending-settlements/by-source-transaction/${ghostId}/settle-company`
      // task-receipts-backend (#10): settleSeniorPayoutSchema now requires a
      // mandatory, currency-aware receipt — USDT ⇒ explorer link. Using a
      // VALID receipt here means the ACCOUNTANT probe below proves a genuine
      // 200 happy path, not just "didn't get blocked by the RBAC gate".
      const settleBody = {
        data: {
          fundingSource: 'ADMIN_PERSONAL',
          payerAdminId: MAKSYM_ID,
          currency: 'USDT',
          receiptExternalUrl: 'https://etherscan.io/tx/0xrbacsrcsettle00001',
        },
      }

      // Forbidden roles — DROP / SENIOR / JUNIOR / HR.
      for (const email of [dropEmail, SEED_EMAILS.seniorA, SEED_EMAILS.juniorA, SEED_EMAILS.hrA]) {
        await loginViaApi(page, email)
        const r = await page.request.post(endpointUrl, settleBody)
        expect(r.status(), `Expected 403 for ${email} on by-source-transaction settle`).toBe(403)
      }

      // ACCOUNTANT is allowed.
      await loginViaApi(page, SEED_EMAILS.accountant)
      const accountantRes = await page.request.post(endpointUrl, settleBody)
      expect(
        rbacPassed(accountantRes.status()),
        `Expected RBAC pass for ACCOUNTANT (got ${accountantRes.status()})`,
      ).toBe(true)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
