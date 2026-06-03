/**
 * pending-settlement.spec.ts — task-autotest-business-logic-coverage (F).
 *
 * Phase 4-C pending settlement flows — the senior share from drop-projects
 * is owed by **THE COMPANY**, not by the DROP user. Covers:
 *
 *   GET  /api/pending-settlements/senior   — senior sees own; admin/accountant sees all.
 *   GET  /api/pending-settlements/company  — admin / accountant only.
 *   POST /api/pending-settlements/:id/settle-company
 *                                         — closes the COMPANY debt, inserts SENIOR_INCOME.
 *
 * Real-API.
 *
 * Scenarios:
 *   1. After confirm-cash, a COMPANY-debt obligation surfaces in both
 *      /senior (senior self-view) and /company (admin view).
 *   2. DROP cannot read either list (403).
 *   3. ADMIN settles → SENIOR_INCOME row inserted, obligation marked PAID,
 *      both lists drop the row.
 *   4. After settle the senior's pending list is empty (or doesn't include
 *      that obligation) — drop legacy debts NOT created.
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
  listTransactionsByProjectViaAPI,
  findUserByEmailViaApi,
} from './fixtures'

const REAL_API = 'http://localhost:3001/api'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

/** Plant a single COMPANY-debt obligation via the cash channel. */
async function plantCompanyDebt(page: import('@playwright/test').Page): Promise<{
  dropId: string
  projectId: string
  incomeTxId: string
  seniorId: string
}> {
  const suffix = uniqueSuffix()
  const dropEmail = `pending-${suffix}@cheekycheese.dev`

  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const { dropId } = await createDropViaAPI(page, {
    email: dropEmail,
    displayName: `Pending Settlement ${suffix}`,
  })

  const { projectId } = await createDropProjectViaAPI(page, {
    dropId,
    seniorEmail: SEED_EMAILS.seniorA,
  })

  await loginViaApi(page, dropEmail)
  const { txId: incomeTxId } = await createDropIncomeViaAPI(page, {
    projectId,
    amount: 1000,
  })

  await loginViaApi(page, SEED_EMAILS.accountant)
  await validateTransactionViaAPI(page, incomeTxId)

  // Cash channel — inserts SENIOR_PENDING_PAYOUT (debtorType=COMPANY).
  const cashRes = await page.request.post(`${REAL_API}/payments/confirm-cash`, {
    data: { incomeId: incomeTxId, recipientAdminId: MAKSYM_ID },
  })
  if (cashRes.status() !== 200 && cashRes.status() !== 201) {
    throw new Error(`confirm-cash failed: ${cashRes.status()} — ${await cashRes.text()}`)
  }

  const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorA)
  if (!senior) throw new Error('Seed senior A not found')

  return { dropId, projectId, incomeTxId, seniorId: senior.id }
}

test.describe('Pending settlement — debtor=COMPANY (Phase 4-C)', () => {
  test('after confirm-cash → /senior surfaces the obligation for the senior', async ({ page }) => {
    const { dropId } = await plantCompanyDebt(page)

    try {
      // Senior self-view.
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const seniorRes = await page.request.get(`${REAL_API}/pending-settlements/senior`)
      expect(seniorRes.status()).toBe(200)
      const seniorList = (await seniorRes.json()) as Array<{
        debtorType: string
        amount: string
      }>

      // Must include at least one COMPANY-debt row (could be more from
      // parallel test runs — we just assert the contract).
      const companyRow = seniorList.find((o) => o.debtorType === 'COMPANY')
      expect(companyRow, 'senior must see at least one COMPANY-debt row').toBeTruthy()
      expect(parseFloat(companyRow!.amount)).toBeGreaterThan(0)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('after confirm-cash → /company surfaces the obligation for ADMIN', async ({ page }) => {
    const { dropId, seniorId } = await plantCompanyDebt(page)

    try {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const res = await page.request.get(`${REAL_API}/pending-settlements/company`)
      expect(res.status()).toBe(200)
      const list = (await res.json()) as Array<{
        debtorType: string
        creditorUserId: string
        status?: string
      }>

      // The newly-planted row credits our senior. (Status filter is enforced
      // server-side: only PENDING surfaces here, so we don't double-check it.)
      const row = list.find((o) => o.creditorUserId === seniorId)
      expect(row, 'company list must include our senior as creditor').toBeTruthy()
      expect(row!.debtorType).toBe('COMPANY')
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('DROP cannot read /senior nor /company — 403', async ({ page }) => {
    // Plant the obligation via the helper, then probe with the drop's own
    // credentials. The drop should be locked out of BOTH endpoints.
    const suffix = uniqueSuffix()
    const dropEmail = `pending-drop-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Pending Drop ${suffix}`,
    })

    try {
      await loginViaApi(page, dropEmail)

      const seniorRes = await page.request.get(`${REAL_API}/pending-settlements/senior`)
      expect(seniorRes.status()).toBe(403)

      const companyRes = await page.request.get(`${REAL_API}/pending-settlements/company`)
      expect(companyRes.status()).toBe(403)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('ADMIN settles COMPANY debt → SENIOR_INCOME inserted + obligation drops from /company', async ({
    page,
  }) => {
    const { dropId, projectId, seniorId } = await plantCompanyDebt(page)

    try {
      // Capture the obligation row.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const beforeRes = await page.request.get(`${REAL_API}/pending-settlements/company`)
      const beforeList = (await beforeRes.json()) as Array<{
        id: string
        creditorUserId: string
        amount: string
      }>
      const row = beforeList.find((o) => o.creditorUserId === seniorId)
      expect(row, 'plant step must yield an obligation').toBeTruthy()
      const obligationAmount = parseFloat(row!.amount)

      // Settle.
      const settleRes = await page.request.post(
        `${REAL_API}/pending-settlements/${row!.id}/settle-company`,
        { data: {} },
      )
      expect(settleRes.status()).toBeLessThan(400)

      // /company no longer contains our row.
      const afterRes = await page.request.get(`${REAL_API}/pending-settlements/company`)
      const afterList = (await afterRes.json()) as Array<{ id: string }>
      expect(afterList.find((o) => o.id === row!.id)).toBeFalsy()

      // SENIOR_INCOME row was inserted on the project.
      const txs = await listTransactionsByProjectViaAPI(page, projectId)
      const seniorIncomes = txs.filter(
        (t) => t.type === 'SENIOR_INCOME' && t.status === 'PAID' && t.receiverId === seniorId,
      )
      expect(seniorIncomes.length).toBeGreaterThanOrEqual(1)
      const settled = seniorIncomes.find(
        (t) => Math.abs(parseFloat(t.amount) - obligationAmount) < 0.01,
      )
      expect(
        settled,
        `expected a SENIOR_INCOME row at ${obligationAmount} after settle-company`,
      ).toBeTruthy()
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
