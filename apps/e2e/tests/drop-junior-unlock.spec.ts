/**
 * drop-junior-unlock.spec.ts — task-drop-phase2-e2e (AC4).
 *
 * AC5 of the Phase 2 backend task extends junior salary unlock to fire on
 * a validated DROP_INCOME (not only SENIOR_INCOME). The cron service path
 * `transactions.service.createMonthlySalaries` decides between LOCKED /
 * PENDING based on whether the project has a validated income for the
 * month — checking both `SENIOR_INCOME` and `DROP_INCOME`:
 *
 *   ```ts
 *   const hasValidatedIncome = await this.db.db.query.transactions.findFirst({
 *     where: and(
 *       or(eq(transactions.type, 'SENIOR_INCOME'), eq(transactions.type, 'DROP_INCOME')),
 *       eq(transactions.projectId, project.id),
 *       eq(transactions.status, 'VALIDATED'),
 *     ),
 *   })
 *   ```
 *
 * Two observable invariants on the public API that prove the integration:
 *
 *   1. Validating a DROP_INCOME creates a row visible via
 *      `GET /api/transactions?projectId=&status=VALIDATED&type=DROP_INCOME`.
 *      This is the EXACT predicate the cron reads.
 *   2. Validating a DROP_INCOME does NOT crash the post-validate
 *      `unlockJuniorSalaryForProject` cascade (which fires inside
 *      `validateTransaction`). The validate call returns 200 with a
 *      payout_request id, proving the cascade reached the end.
 *
 * The full LOCKED → PENDING flip is exercised by the backend UTs
 * (`apps/api/src/finance/transactions.distribution.spec.ts` + the cron
 * test) — this E2E sticks to the public-API contract because there's no
 * test-only endpoint to trigger the monthly cron and the seed juniors
 * are already on other active projects (max 1 active project / junior).
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
  listTransactionsByProjectViaAPI,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

test.describe('Drop income → junior salary unlock signal (AC4)', () => {
  test('VALIDATED DROP_INCOME visible on /transactions — cron predicate satisfied', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-junior-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Drop Junior ${suffix}`,
    })

    try {
      const { projectId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
      })

      // DROP posts DROP_INCOME $1000 → ACCOUNTANT validates.
      await loginViaApi(page, dropEmail)
      const { txId } = await createDropIncomeViaAPI(page, { projectId, amount: 1000 })

      await loginViaApi(page, SEED_EMAILS.accountant)
      const { payoutRequestId } = await validateTransactionViaAPI(page, txId)
      // payoutRequestId being non-null proves that `validateTransaction`
      // reached the end of its db.transaction(...) — meaning the
      // `unlockJuniorSalaryForProject` side-effect also ran without
      // crashing the cascade.
      expect(payoutRequestId).toBeTruthy()

      // Verify the project HAS a VALIDATED DROP_INCOME row — this is the
      // signal `createMonthlySalaries` reads to decide PENDING vs. LOCKED.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const txs = await listTransactionsByProjectViaAPI(page, projectId)
      const validatedDropIncome = txs.find(
        (t) => t.type === 'DROP_INCOME' && t.status === 'VALIDATED',
      )
      expect(validatedDropIncome).toBeTruthy()
      expect(parseFloat(validatedDropIncome!.amount)).toBeCloseTo(1000, 2)

      // The validate cascade also created the placeholder PAYOUT (PENDING_PAYMENT)
      // — that's the per-income payable bucket for `payPayoutRequest`. Sanity
      // assertion that the surrounding flow is intact.
      const placeholderPayout = txs.find(
        (t) => t.type === 'PAYOUT' && t.status === 'PENDING_PAYMENT',
      )
      expect(placeholderPayout).toBeTruthy()
    } finally {
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
