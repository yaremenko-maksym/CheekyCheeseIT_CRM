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
 *   3. GET /api/finance/summary REJECTS DROP (403) — the full financial
 *      summary (adminBalances / dropBalances-for-everyone / totalIncome) is
 *      ADMIN/ACCOUNTANT only; DROP's own numbers live behind the separate
 *      self-only `GET /api/finance/drop/me/summary` route. Backlog item 131
 *      fix (2026-08-18): this used to assert 200, which was wrong since PR
 *      #158 (10.06.2026) and only caught because the spec was audited for
 *      being outside the CI shard matrix — see the test body for the full
 *      history.
 *   4. GET /api/payout-requests as a DROP scoped to their own only.
 *
 * Backlog item 131 (second finding, same audit): this file predates the
 * Phase 6A onboarding gate (`OnboardingGuard`) and never called
 * `onboardDropViaAPI` after `createDropViaAPI` — every test here 403'd with
 * `ONBOARDING_REQUIRED` on its FIRST live request (drop-income /
 * finance/summary / payout-requests) before reaching the RBAC assertions
 * this file exists to make. All 4 tests now onboard the fresh DROP first,
 * matching the CI-gated `drop-role-end-to-end.spec.ts` pattern.
 *
 * Backlog item 131 (third finding, same audit): tests 3-4 also predate
 * `task-drop-payout-company-account`, which removed the auto-create-
 * payout_request-at-validate behaviour for DROP_INCOME (validate now only
 * flips status to VALIDATED, same as SENIOR_INCOME) — they asserted a
 * non-null `payoutRequestId` straight off `validateTransactionViaAPI`, which
 * is always null now. Both now call `createPayoutRequestViaAPI` as the DROP
 * to bundle the VALIDATED income explicitly, same as the SENIOR flow.
 *
 * Cleanup: cascade-archive the drop.
 */

import { test, expect, REAL_API_BASE } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  loginViaApi,
  createDropViaAPI,
  cleanupDropViaAPI,
  createDropProjectViaAPI,
  createDropIncomeViaAPI,
  onboardDropViaAPI,
  ensureCompanyWalletViaAPI,
  validateTransactionViaAPI,
  createPayoutRequestViaAPI,
} from './fixtures'

const REAL_API = `${REAL_API_BASE}/api`

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
      // Backlog item 131 (second finding): the OnboardingGuard (Phase 6A,
      // postdates this spec) rejects any non-ADMIN caller with
      // `403 ONBOARDING_REQUIRED` until they have a SIGNED employee_contract
      // + a ToS acceptance for the current version — `POST
      // /transactions/drop-income` below is not in the guard's bypass list.
      // A freshly `createDropViaAPI`'d user has neither. Without this call
      // every test in this file failed at the FIRST live request, before
      // ever reaching the RBAC assertions this file exists to make — see
      // `drop-role-end-to-end.spec.ts` (CI-gated) for the same required
      // step on the same helper.
      await onboardDropViaAPI(page, { dropId, dropEmail })

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

  test('GET /api/finance/summary as DROP is rejected (403) — DROP has no access to the full financial summary', async ({
    page,
  }) => {
    // Backlog item 131 fix: this test used to assert `200` for DROP, which was
    // WRONG the day it was written and stayed wrong, unnoticed, for ~2 months —
    // `TransactionsService.getSummary` has thrown `ForbiddenException` for any
    // role other than ADMIN/ACCOUNTANT since PR #158 (10.06.2026, git blame),
    // i.e. BEFORE this spec (task-e2e-fragile-points-audit) existed. The false
    // assertion never turned red because this file is not wired into any CI
    // shard (`scripts/devops/check-e2e-shard-coverage.py` KNOWN_UNSHARDED —
    // "debt: not gated, migrate to drop shard later").
    //
    // Since PR #566 (backlog item 121, security-review on #560) the route also
    // carries `@Roles('ADMIN','ACCOUNTANT')` as a SECOND, independent guard
    // layer (`FinanceSummaryController.getSummary` in transactions.controller.ts)
    // — the class-level `RolesGuard` now rejects DROP BEFORE the handler runs,
    // so the request never even reaches `TransactionsService.getSummary`
    // (see transactions.summary.roles-guard.spec.ts for the guard-level unit
    // proof that the handler is unreached). Both layers agree DROP is
    // forbidden — this spec pins the live, end-to-end HTTP contract a fresh
    // caller actually gets: 403. (Code-review round on #569: the message
    // assertion below does NOT additionally prove WHICH of the two layers
    // produced it — see that comment for what it does and doesn't pin.)
    const suffix = uniqueSuffix()
    const dropEmail = `drop-api-summary-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Drop Summary ${suffix}`,
    })

    try {
      // See the onboarding note in the first test in this file — a fresh
      // DROP needs a signed contract + ToS acceptance before OnboardingGuard
      // lets ANY non-bypassed route through, `/finance/summary` included.
      // Without this the request never even reaches the @Roles guard this
      // test is pinning — it 403s on ONBOARDING_REQUIRED instead, which
      // would have made the (fixed) assertion below pass for the WRONG
      // reason.
      await onboardDropViaAPI(page, { dropId, dropEmail })

      await loginViaApi(page, dropEmail)
      const res = await page.request.get(`${REAL_API}/finance/summary`)
      // DROP has NO access to the full financial summary (adminBalances,
      // dropBalances, totalIncome, dropSharePercent for every drop) — that
      // surface is ADMIN/ACCOUNTANT only. DROP's own numbers are exposed via
      // the separate self-only `GET /api/finance/drop/me/summary` route
      // (untouched by #566, still gated by service-side ownership).
      expect(res.status()).toBe(403)
      const body = (await res.json()) as { message?: string; error?: string }
      // Code-review round on #569 (MED-1): this assertion does NOT tell the
      // `RolesGuard` layer's 403 apart from `TransactionsService.getSummary`'s
      // own 403 — both used to mention "ADMIN"/"ACCOUNTANT" in free text, so
      // `toContain` couldn't distinguish them either.
      //
      // backlog item 133 (2026-08-18): `RolesGuard`'s message no longer names
      // the allowed roles at all (genericized on purpose — see
      // roles.guard.ts), so that old "contains ADMIN/ACCOUNTANT" check is
      // gone; a role-gate 403 now differs from an onboarding-gate 403 by
      // PRESENCE of `message`, not its wording:
      //   - `RolesGuard` throws a plain-string `ForbiddenException`, which
      //     Nest always wraps as `{ statusCode, message, error }` — `message`
      //     is present (the guard's generic sentence).
      //   - `OnboardingGuard` throws `{ error: 'ONBOARDING_REQUIRED',
      //     missing }` — an object response used VERBATIM as the body, no
      //     `message` field at all — so on that path `body.message` is
      //     `undefined`.
      // That is the exact confusion this file had before the original #569
      // fix (see the onboarding note above): without `onboardDropViaAPI`,
      // the status-only assertion would have passed for the wrong reason
      // (onboarding-gate 403, not role-gate 403). This still catches it.
      //
      // Security-review round on #577 (LOW-2): a body that HAS `message`
      // structurally cannot also be `OnboardingGuard`'s
      // `{ error: 'ONBOARDING_REQUIRED', missing }` payload (Nest never
      // merges the two shapes) — so `body.message.toContain(/* anything */
      // 'ONBOARDING_REQUIRED')` was always trivially true once `typeof
      // body.message === 'string'` had already passed; it could never
      // observe a real failure. Replaced with a structural check on `error`
      // instead of a content check on `message` — this one is NOT implied
      // by the line above and would catch a future regression where a
      // response carried BOTH fields.
      expect(typeof body.message).toBe('string')
      expect(body).not.toHaveProperty('error', 'ONBOARDING_REQUIRED')
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
      // See the onboarding note in the first test in this file.
      await onboardDropViaAPI(page, { dropId, dropEmail })

      // Seed leaves the company wallet unset — POST /payout-requests 400s
      // ("Кошелёк компании не настроен") without it. onboardDropViaAPI
      // restores the ADMIN session on exit, matching the golden pattern in
      // the CI-gated drop-role-end-to-end.spec.ts.
      await ensureCompanyWalletViaAPI(page)

      const { projectId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
      })

      // Plant a payout-request flow so we have a DROP-owned PR in the DB.
      await loginViaApi(page, dropEmail)
      const { txId } = await createDropIncomeViaAPI(page, { projectId, amount: 300 })

      // Backlog item 131 (third finding, same audit): `task-drop-payout-
      // company-account` REMOVED the auto-create-payout_request-at-validate
      // behaviour for DROP_INCOME (see `TransactionsService.validateTransaction`
      // — validate now ONLY flips status to VALIDATED for both SENIOR_INCOME
      // and DROP_INCOME). The DROP must now explicitly bundle their VALIDATED
      // income into a payout via `POST /api/payout-requests`, same as SENIOR —
      // `validateTransactionViaAPI` no longer returns a payoutRequestId.
      await loginViaApi(page, SEED_EMAILS.accountant)
      await validateTransactionViaAPI(page, txId)

      await loginViaApi(page, dropEmail)
      const { payoutRequestId } = await createPayoutRequestViaAPI(page, [txId])
      expect(payoutRequestId).toBeTruthy()

      // DROP fetches /api/payout-requests.
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
      // See the onboarding + company-wallet notes on the previous test in
      // this file.
      await onboardDropViaAPI(page, { dropId, dropEmail })
      await ensureCompanyWalletViaAPI(page)

      const { projectId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
      })
      await loginViaApi(page, dropEmail)
      const { txId } = await createDropIncomeViaAPI(page, { projectId, amount: 1000 })

      // See the third onboarding/flow note on the previous test in this file:
      // validate no longer auto-creates the payout_request for DROP_INCOME
      // either — the DROP bundles their own VALIDATED income explicitly.
      await loginViaApi(page, SEED_EMAILS.accountant)
      await validateTransactionViaAPI(page, txId)

      await loginViaApi(page, dropEmail)
      const { payoutRequestId } = await createPayoutRequestViaAPI(page, [txId])
      expect(payoutRequestId).toBeTruthy()

      // DROP pays — direct PATCH so we can assert HTTP 200 explicitly.
      const payRes = await page.request.patch(
        `${REAL_API}/payout-requests/${payoutRequestId}/pay`,
        { data: { simulateResult: 'success' }, timeout: 60_000 },
      )
      // The whole point of the regression test: status MUST be 200, never 403.
      expect(payRes.status()).toBe(200)
      const body = (await payRes.json()) as { status: string }
      expect(body.status).toBe('PAID')
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
