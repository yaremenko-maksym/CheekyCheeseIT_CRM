/**
 * drop-backend-rbac-api.spec.ts — task-e2e-fragile-points-audit.
 *
 * Direct API regression for DROP-role RBAC on the finance / transactions
 * endpoints. PR #63 (drop phase 1 backend) introduced DROP scoping on
 * `TransactionsService.findAll` so a DROP user only sees rows where they
 * are the sender or receiver (no PAYOUT_ADMIN leak from senior payouts).
 *
 * The legacy `drop-rbac.spec.ts` covers UI (sidebar visibility, route
 * guards). NONE of the legacy specs actually call the live `/api/transactions`
 * endpoint as a DROP user and assert the response — meaning a regression
 * that widened the filter (e.g. removing the `senderId/receiverId` clause)
 * would silently re-leak data.
 *
 * This spec hits real backend via dev-login and asserts:
 *   1. GET /api/transactions as a fresh DROP user returns ONLY rows the
 *      DROP is a participant in (sender or receiver). Should NOT include
 *      OTHER seniors' SENIOR_INCOME, EXPENSE, SALARY, JUNIOR_PAYMENT, etc.
 *   2. The DROP user never sees PAYOUT_ADMIN rows even when they are
 *      indirectly tied to the payout request that generated them.
 *   3. GET /api/finance/summary works for DROP (200) without crashing on
 *      `summary.dropBalances` being undefined / null.
 *   4. GET /api/payout-requests as a DROP scoped to their own only.
 *
 * Cleanup: cascade-archive the drop.
 */

import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  loginViaApi,
  createDropViaAPI,
  cleanupDropViaAPI,
  createDropProjectViaAPI,
  createDropIncomeViaAPI,
  validateTransactionViaAPI,
  payPayoutRequestViaAPI,
} from './fixtures'

const REAL_API = 'http://localhost:3001/api'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('DROP backend RBAC — direct API regression', () => {
  test('GET /api/transactions as DROP returns ONLY rows where DROP is participant', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-api-rbac-${suffix}@cheekycheese.dev`

    // Step 1: provision DROP + drop-project + post DROP_INCOME so the DROP
    // has at least one tx that SHOULD surface in its scoped list.
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Drop API RBAC ${suffix}`,
    })

    try {
      const { projectId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
      })

      // DROP posts $500 DROP_INCOME.
      await loginViaApi(page, dropEmail)
      const { txId: ownTxId } = await createDropIncomeViaAPI(page, {
        projectId,
        amount: 500,
      })

      // Step 2: DROP fetches /api/transactions — must succeed (200).
      const listRes = await page.request.get(`${REAL_API}/transactions`)
      expect(listRes.status()).toBe(200)
      const list = (await listRes.json()) as Array<{
        id: string
        type: string
        senderId: string | null
        receiverId: string | null
      }>

      // Step 3: each returned row must satisfy DROP scope:
      //   tx.senderId === drop || tx.receiverId === drop, AND
      //   tx.type !== 'PAYOUT_ADMIN' (security guard).
      for (const tx of list) {
        const isParticipant = tx.senderId === dropId || tx.receiverId === dropId
        expect(
          isParticipant,
          `DROP must not see tx ${tx.id} (type=${tx.type}) — not sender or receiver`,
        ).toBe(true)
        expect(tx.type, `DROP must NEVER see PAYOUT_ADMIN rows (tx ${tx.id})`).not.toBe(
          'PAYOUT_ADMIN',
        )
      }

      // The DROP's own income MUST be in the list (sanity — not just empty).
      expect(list.find((t) => t.id === ownTxId)).toBeTruthy()
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('GET /api/finance/summary as DROP returns 200 and includes dropBalances field', async ({
    page,
  }) => {
    // Regression catcher: in dev round-1 the finance summary frontend
    // crashed with `Cannot read .length of undefined` when the backend
    // didn't surface `dropBalances`. Backend contract is to always send
    // `dropBalances: []` (empty array) — never undefined — so the frontend
    // can safely `summary.dropBalances?.length` without optional chaining
    // hacks. This spec verifies the contract directly.
    const suffix = uniqueSuffix()
    const dropEmail = `drop-api-summary-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Drop Summary ${suffix}`,
    })

    try {
      await loginViaApi(page, dropEmail)
      const res = await page.request.get(`${REAL_API}/finance/summary`)
      // The endpoint must respond 200 to DROP. Drop role - phase 1: DROP has
      // /finance access, so the summary endpoint is open to them.
      expect(res.status()).toBe(200)
      const body = (await res.json()) as {
        totalIncome: number
        adminBalances: unknown
        dropBalances: unknown
      }
      // `dropBalances` must be present (array — possibly empty) so the
      // frontend's `summary.dropBalances?.length` check doesn't crash.
      expect(Array.isArray(body.dropBalances)).toBe(true)
      // adminBalances is also always an array.
      expect(Array.isArray(body.adminBalances)).toBe(true)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('GET /api/payout-requests as DROP is scoped — never leaks other users requests', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-api-pr-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Drop PR Scope ${suffix}`,
    })

    try {
      const { projectId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
      })

      // Plant a payout-request flow so we have a DROP-owned PR in the DB.
      await loginViaApi(page, dropEmail)
      const { txId } = await createDropIncomeViaAPI(page, { projectId, amount: 300 })

      await loginViaApi(page, SEED_EMAILS.accountant)
      const { payoutRequestId } = await validateTransactionViaAPI(page, txId)
      expect(payoutRequestId).toBeTruthy()

      // DROP fetches /api/payout-requests.
      await loginViaApi(page, dropEmail)
      const res = await page.request.get(`${REAL_API}/payout-requests`)
      expect(res.status()).toBe(200)
      const list = (await res.json()) as Array<{
        id: string
        seniorId: string
      }>

      // Backend contract: in drop-project flows the `payout_requests.seniorId`
      // column is *reused* as "payout owner" — so for DROP it holds the
      // drop user's id. The RBAC filter is therefore `seniorId === drop.id`.
      // Each returned PR must belong to our DROP only.
      for (const pr of list) {
        expect(pr.seniorId, `DROP must not see payout-request ${pr.id} — seniorId mismatch`).toBe(
          dropId,
        )
      }

      // Our own PR is in the list.
      expect(list.find((pr) => pr.id === payoutRequestId)).toBeTruthy()
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('DROP pays their own payout-request → 200 (not 403)', async ({ page }) => {
    // Backlog AC4 fix (PR #66): `findPayoutRequest` widened to let DROP
    // read their OWN payout_request — matches the SENIOR rule. Before the
    // fix the PATCH /pay endpoint returned 403 to the DROP after the
    // post-pay re-read, hiding the actual cascade behind a misleading
    // error. This regression test asserts the live 200 contract end-to-end.
    const suffix = uniqueSuffix()
    const dropEmail = `drop-api-pay-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Drop Pay 200 ${suffix}`,
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

      // DROP pays — direct PATCH so we can assert HTTP 200 explicitly.
      await loginViaApi(page, dropEmail)
      const payRes = await page.request.patch(
        `${REAL_API}/payout-requests/${payoutRequestId}/pay`,
        { data: { simulateResult: 'success' }, timeout: 60_000 },
      )
      // The whole point of the regression test: status MUST be 200, never 403.
      expect(payRes.status()).toBe(200)
      const body = (await payRes.json()) as { status: string }
      expect(body.status).toBe('PAID')

      // Sanity helper-path: payPayoutRequestViaAPI throws on non-200, so a
      // second call would already fail if status had silently regressed.
      // We use the explicit fetch above as the load-bearing assertion.
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
