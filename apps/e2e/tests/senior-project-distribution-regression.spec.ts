/**
 * senior-project-distribution-regression.spec.ts — task-drop-phase2-e2e (AC7).
 *
 * **Reference regression for Phase 2.** Guarantees that the new
 * drop-distribution branch in `payPayoutRequest` did NOT contaminate the
 * existing senior-project flow.
 *
 * Pre-conditions: a fresh senior-project (no `dropId`) routed through
 * a seed SENIOR at the canonical 26% share.
 *
 * Flow:
 *   1. SENIOR posts $1000 SENIOR_INCOME (PENDING).
 *   2. ACCOUNTANT validates → PENDING_PAYMENT placeholder PAYOUT row
 *      with amount = 1000 * (1 − 0.26) = $740.
 *   3. SENIOR pays the payout_request (simulate=success) → backend
 *      settles the PAYOUT row (PAID, fundingSource='COMPANY_ACCOUNT').
 *      fix/payout-credits-company-account: the 50/50 PAYOUT_ADMIN split
 *      has been REMOVED. Company account is credited via PAYOUT directly.
 *
 * Backend assertions:
 *   - 2 distribution-relevant transactions exist for the project:
 *       1× SENIOR_INCOME (PAID, $1000),
 *       1× PAYOUT       (PAID, $740 — the placeholder, credits company account).
 *   - **0 PAYOUT_ADMIN rows** — regression canary for the split removal.
 *   - **NO PAYOUT_DROP rows** — this is the canary the regression must
 *     catch if a future change ever wires drop math to senior flow.
 *
 * UI assertion (mocked, separate test):
 *   - On a senior-project detail page the distribution breakdown card
 *     is HIDDEN — only drop-projects render `project-drop-distribution`.
 *
 * Cleanup: archive the project + nothing else (no drop to delete).
 */

import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  loginViaApi,
  createSeniorProjectViaAPI,
  createSeniorIncomeViaAPI,
  validateTransactionViaAPI,
  createPayoutRequestViaAPI,
  payPayoutRequestViaAPI,
  listPayoutRequestTransactionsViaAPI,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

const REAL_API = 'http://localhost:3001/api'

test.describe('Senior-project distribution regression — real API (AC7)', () => {
  test('senior pays $1000 income → 0 PAYOUT_ADMIN (company account credited via PAYOUT $740), NO PAYOUT_DROP', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()

    // 1) Provision a fresh senior-project (no dropId).
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `Senior Regression Project ${suffix}`,
    })

    try {
      // 2) SENIOR posts $1000 SENIOR_INCOME (PENDING).
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { txId } = await createSeniorIncomeViaAPI(page, {
        projectId,
        amount: 1000,
        currency: 'USDT',
      })

      // 3) ACCOUNTANT validates → SENIOR_INCOME becomes VALIDATED (no auto-payout).
      // feat/finance-payout-flow (#7): validate no longer auto-creates payout_request.
      await loginViaApi(page, SEED_EMAILS.accountant)
      await validateTransactionViaAPI(page, txId)

      // 4) SENIOR manually creates payout_request (single income).
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const { payoutRequestId } = await createPayoutRequestViaAPI(page, [txId])
      expect(payoutRequestId).toBeTruthy()

      // 5) SENIOR pays → legacy 50/50 partner split (no drop branch).
      const paid = await payPayoutRequestViaAPI(page, payoutRequestId)
      expect(paid.status).toBe('PAID')

      // 5) Full ledger via ADMIN read — fetch ALL transactions linked to
      //    the payout_request. Using payout_request_id-based helper for
      //    deterministic ordering of the assertions below.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const txs = await listPayoutRequestTransactionsViaAPI(page, payoutRequestId!)

      const seniorIncomes = txs.filter((t) => t.type === 'SENIOR_INCOME')
      const payouts = txs.filter((t) => t.type === 'PAYOUT')
      const payoutAdmins = txs.filter((t) => t.type === 'PAYOUT_ADMIN')
      // CANARY: this MUST be empty on a senior-project.
      const payoutDrops = txs.filter((t) => t.type === 'PAYOUT_DROP')
      const dropIncomes = txs.filter((t) => t.type === 'DROP_INCOME')

      expect(seniorIncomes).toHaveLength(1)
      expect(parseFloat(seniorIncomes[0]!.amount)).toBeCloseTo(1000, 2)
      expect(seniorIncomes[0]!.status).toBe('PAID')

      expect(payouts).toHaveLength(1)
      expect(payouts[0]!.status).toBe('PAID')
      expect(parseFloat(payouts[0]!.amount)).toBeCloseTo(740, 2)

      // PAYOUT_ADMIN — 0 rows (regression canary).
      // fix/payout-credits-company-account removed the automatic 50/50 split.
      // The company account is credited the full $740 payable via the PAYOUT
      // row's fundingSource='COMPANY_ACCOUNT' marker. No separate distribution
      // rows are emitted on settlement.
      expect(
        payoutAdmins,
        'PAYOUT_ADMIN rows must be absent after Variant-A split removal',
      ).toHaveLength(0)

      // CANARY: senior-project must never produce drop-related rows.
      expect(payoutDrops, 'Senior-project must NEVER produce PAYOUT_DROP').toHaveLength(0)
      expect(dropIncomes, 'Senior-project must NEVER produce DROP_INCOME').toHaveLength(0)
    } finally {
      // Archive the project — no drop to cascade-archive.
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })

  test('UI: senior-project detail page hides drop badge + breakdown (real-API)', async ({
    page,
  }) => {
    // Real-API UI regression — provision a fresh senior-project (no dropId)
    // and navigate to its detail page as ADMIN. The «Drop-проект» badge and
    // the distribution breakdown card MUST both be absent because the
    // project has no `dropId` on the DTO.
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createSeniorProjectViaAPI(page, {
      seniorEmail: SEED_EMAILS.seniorA,
      name: `Senior UI Regression ${suffix}`,
    })

    try {
      await page.goto(`/crm/projects/${projectId}`)

      // Wait for the detail shell to mount — the Archive button (testid set
      // in $projectId.tsx) is visible to ADMIN on non-archived projects.
      await expect(page.getByTestId('project-archive-button')).toBeVisible({
        timeout: 10_000,
      })

      // The Phase 2 «Drop-проект» badge MUST NOT appear on a senior-project.
      await expect(page.getByTestId('project-drop-badge')).toHaveCount(0)

      // The breakdown card (test-id `project-drop-distribution`) is the
      // Phase 2 widget — must be absent on the Финансы tab too. Switch to
      // Финансы and confirm.
      await page.getByTestId('tab-finance').click()
      await expect(page.getByTestId('project-drop-distribution')).toHaveCount(0)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await page.request.delete(`${REAL_API}/projects/${projectId}`).catch(() => undefined)
    }
  })
})
