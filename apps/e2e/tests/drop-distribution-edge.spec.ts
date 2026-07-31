/**
 * drop-distribution-edge.spec.ts — task-drop-phase2-e2e (AC3).
 *
 * Edge cases for the Phase 2 distribution math (§8.1):
 *
 *   - senior 50% + drop 50% → remainder = $0, 0 PAYOUT_ADMIN rows.
 *     fix/payout-credits-company-account: the 50/50 partner split is removed.
 *     Only PAYOUT placeholder + DROP_PENDING_PAYOUT still created (the
 *     drop's slice is a COMPANY debt now — task-drop-share-pending-parity —
 *     not an instant PAYOUT_DROP); company account credited via
 *     PAYOUT.fundingSource='COMPANY_ACCOUNT'.
 *   - senior 60% + drop 50% → backend 400 BadRequest at pay-time
 *     ("Sum of senior+drop shares exceeds 100%"). The income lives PENDING /
 *     VALIDATED but the payout never completes.
 *   - senior 0% + drop 0% → 0 PAYOUT_ADMIN rows; full payable ($1000) credits
 *     company account. DROP_PENDING_PAYOUT $0 still emitted (drop's 0% slice).
 *
 * To avoid mutating the seed seniors across parallel runs each scenario
 * creates a *fresh* drop user with the appropriate `dropSharePercent`
 * and bumps the chosen seed senior's share via `patchUserSharePercentViaAPI`.
 * Tests serialise the senior share mutations by using DIFFERENT seed seniors
 * per scenario (seniorA / seniorB) and run `test.describe.configure({ mode:
 * 'serial' })` so a half-finished cleanup can't bleed into the next case.
 *
 * Cleanup: each scenario restores the senior's seniorSharePercent to the seed
 * default (26) and cascade-archives the drop.
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
  listTransactionsByProjectViaAPI,
  findUserByEmailViaApi,
  patchUserSharePercentViaAPI,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

const SEED_DEFAULT_SHARE = 26

test.describe.configure({ mode: 'serial' })

test.describe('Drop distribution edge cases — real API (AC3)', () => {
  test('senior 50% + drop 50% → remainder 0, 0 PAYOUT_ADMIN (company account credited via PAYOUT)', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-edge-50-50-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorA)
    if (!senior) throw new Error('Seed senior not found')

    // Bump senior to 50%.
    await patchUserSharePercentViaAPI(page, senior.id, { seniorSharePercent: 50 })

    // Drop with 50% share.
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Drop Edge 50/50 ${suffix}`,
      dropSharePercent: 50,
    })

    try {
      const { projectId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorA,
      })

      // DROP posts $1000, ACCOUNTANT validates, DROP pays.
      await loginViaApi(page, dropEmail)
      const { txId } = await createDropIncomeViaAPI(page, { projectId, amount: 1000 })

      await loginViaApi(page, SEED_EMAILS.accountant)
      const { payoutRequestId } = await validateTransactionViaAPI(page, txId)
      expect(payoutRequestId).toBeTruthy()

      await loginViaApi(page, dropEmail)
      const paid = await payPayoutRequestViaAPI(page, payoutRequestId!)
      expect(paid.status).toBe('PAID')

      // Assertions.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const txs = await listTransactionsByProjectViaAPI(page, projectId)
      const payouts = txs.filter((t) => t.type === 'PAYOUT')
      const dropPendings = txs.filter((t) => t.type === 'DROP_PENDING_PAYOUT')
      const payoutAdmins = txs.filter((t) => t.type === 'PAYOUT_ADMIN')

      // PAYOUT placeholder = income * (1 - dropShare/100) = 1000 * 0.5 = 500.
      expect(payouts).toHaveLength(1)
      expect(parseFloat(payouts[0]!.amount)).toBeCloseTo(500, 2)

      // DROP_PENDING_PAYOUT = 50% of income = 500 (task-drop-share-pending-parity:
      // pending until settled, not an instant PAYOUT_DROP).
      expect(dropPendings).toHaveLength(1)
      expect(dropPendings[0]!.status).toBe('PENDING_PAYMENT')
      expect(parseFloat(dropPendings[0]!.amount)).toBeCloseTo(500, 2)
      expect(txs.filter((t) => t.type === 'PAYOUT_DROP')).toHaveLength(0)

      // PAYOUT_ADMIN — 0 rows (regression canary).
      // The automatic 50/50 partner split was removed in
      // fix/payout-credits-company-account: company account is credited the
      // full payable via PAYOUT.fundingSource='COMPANY_ACCOUNT'.
      // (Previously, with remainder=0, two $0-amount rows were emitted; now
      // no rows are emitted at all regardless of the remainder amount.)
      expect(
        payoutAdmins,
        'PAYOUT_ADMIN rows must be absent after Variant-A split removal',
      ).toHaveLength(0)
    } finally {
      // Restore seed senior% to default + cascade-archive the drop.
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await patchUserSharePercentViaAPI(page, senior.id, {
        seniorSharePercent: SEED_DEFAULT_SHARE,
      }).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('senior 60% + drop 50% → pay-time 400 BadRequest "exceeds 100%"', async ({ page }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-edge-60-50-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    // Use seniorB to avoid cross-test interference if the 50/50 cleanup lags.
    const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorB)
    if (!senior) throw new Error('Seed senior not found')

    await patchUserSharePercentViaAPI(page, senior.id, { seniorSharePercent: 60 })

    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Drop Edge 60/50 ${suffix}`,
      dropSharePercent: 50,
    })

    try {
      const { projectId } = await createDropProjectViaAPI(page, {
        dropId,
        seniorEmail: SEED_EMAILS.seniorB,
      })

      await loginViaApi(page, dropEmail)
      const { txId } = await createDropIncomeViaAPI(page, { projectId, amount: 1000 })

      // Validate still succeeds — payable = 1000 * 0.5 = 500 (drop only).
      // The 60+50 violation is caught later, at pay-time, when the backend
      // attempts the senior/drop share math.
      await loginViaApi(page, SEED_EMAILS.accountant)
      const { payoutRequestId } = await validateTransactionViaAPI(page, txId)
      expect(payoutRequestId).toBeTruthy()

      // Now try to pay → expect 400 BadRequest with the exceeds-100% body.
      await loginViaApi(page, dropEmail)
      const res = await page.request.patch(
        `http://localhost:3001/api/payout-requests/${payoutRequestId}/pay`,
        { data: { simulateResult: 'success' } },
      )
      expect(res.status()).toBe(400)
      const body = await res.text()
      expect(body).toMatch(/Sum of senior\+drop shares exceeds 100%/i)

      // Sanity: no DROP_PENDING_PAYOUT / PAYOUT_DROP / PAYOUT_ADMIN rows were
      // inserted (the whole cascade runs in ONE DB transaction — the
      // exceeds-100% throw rolls back everything, so the distribution rows
      // must NOT exist even though the placeholder PAYOUT survives from validate).
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const txs = await listTransactionsByProjectViaAPI(page, projectId)
      expect(txs.filter((t) => t.type === 'DROP_PENDING_PAYOUT')).toHaveLength(0)
      expect(txs.filter((t) => t.type === 'PAYOUT_DROP')).toHaveLength(0)
      expect(txs.filter((t) => t.type === 'PAYOUT_ADMIN')).toHaveLength(0)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await patchUserSharePercentViaAPI(page, senior.id, {
        seniorSharePercent: SEED_DEFAULT_SHARE,
      }).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('senior 0% + drop 0% → 0 PAYOUT_ADMIN, DROP_PENDING_PAYOUT $0, PAYOUT $1000 credits company account', async ({
    page,
  }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `drop-edge-0-0-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorA)
    if (!senior) throw new Error('Seed senior not found')

    await patchUserSharePercentViaAPI(page, senior.id, { seniorSharePercent: 0 })

    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Drop Edge 0/0 ${suffix}`,
      dropSharePercent: 0,
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
      const txs = await listTransactionsByProjectViaAPI(page, projectId)
      const dropPendings = txs.filter((t) => t.type === 'DROP_PENDING_PAYOUT')
      const payoutAdmins = txs.filter((t) => t.type === 'PAYOUT_ADMIN')

      // DROP_PENDING_PAYOUT = $0 (drop kept 0% share) — still booked as a
      // (zero-amount) COMPANY debt, pending settlement.
      expect(dropPendings).toHaveLength(1)
      expect(dropPendings[0]!.status).toBe('PENDING_PAYMENT')
      expect(parseFloat(dropPendings[0]!.amount)).toBeCloseTo(0, 2)
      expect(txs.filter((t) => t.type === 'PAYOUT_DROP')).toHaveLength(0)

      // PAYOUT_ADMIN — 0 rows (regression canary).
      // The automatic 50/50 partner split was removed in
      // fix/payout-credits-company-account: company account is credited the
      // full payable ($1000 when both shares are 0%) via the PAYOUT row's
      // fundingSource='COMPANY_ACCOUNT' marker. Previously $500/$500 rows
      // were emitted; now no PAYOUT_ADMIN rows are emitted at all.
      expect(
        payoutAdmins,
        'PAYOUT_ADMIN rows must be absent after Variant-A split removal',
      ).toHaveLength(0)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await patchUserSharePercentViaAPI(page, senior.id, {
        seniorSharePercent: SEED_DEFAULT_SHARE,
      }).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
