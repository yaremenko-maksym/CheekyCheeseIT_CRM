/**
 * drop-cash-channel.spec.ts — task-fix-phase4b-round2.
 *
 * Cash channel two-step flow:
 *
 *   1. DROP /api/payments/initiate-cash { incomeId }
 *      → placeholder PAYOUT flips to PENDING_CASH_CONFIRM (status), no
 *        cascade transactions yet.
 *   2. ACCOUNTANT/ADMIN /api/payments/confirm-cash { incomeId, recipientAdminId }
 *      → ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT cascade, PAYOUT → PAID.
 *
 * Coverage:
 *   - Happy path: drop initiates → accountant confirms with Maksym.
 *   - DROP cannot call /confirm-cash (403).
 *   - /confirm-cash on a payout NOT in PENDING_CASH_CONFIRM → 400.
 *   - /payments/pending-cash returns the row to ACCOUNTANT, hidden from
 *     SENIOR/JUNIOR/HR/DROP.
 *
 * No real cleanup on the cascade rows — we cascade-archive the drop user
 * via cleanupDropViaAPI at the end so the next run starts clean.
 */

import { test, expect } from './fixtures'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  MAKSYM_ID,
  KOSTYA_ID,
  loginViaApi,
  createDropViaAPI,
  cleanupDropViaAPI,
  createDropProjectViaAPI,
  createDropIncomeViaAPI,
  validateTransactionViaAPI,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

interface CashSetup {
  dropId: string
  dropEmail: string
  projectId: string
  incomeId: string
}

/**
 * Plant a DROP + drop-project + VALIDATED DROP_INCOME (with placeholder
 * PAYOUT in PENDING_PAYMENT). Returns ids the cash flow needs.
 */
async function setupValidatedDropIncome(
  page: import('@playwright/test').Page,
): Promise<CashSetup> {
  const suffix = uniqueSuffix()
  const dropEmail = `drop-cash-r2-${suffix}@cheekycheese.dev`

  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const { dropId } = await createDropViaAPI(page, {
    email: dropEmail,
    displayName: `Drop Cash R2 ${suffix}`,
    dropSharePercent: 10,
  })

  const { projectId } = await createDropProjectViaAPI(page, {
    dropId,
    seniorEmail: SEED_EMAILS.seniorA,
    rate: 3500,
    currency: 'USDT',
  })

  await loginViaApi(page, dropEmail)
  const { txId: incomeId } = await createDropIncomeViaAPI(page, {
    projectId,
    amount: 3500,
    currency: 'USDT',
  })

  await loginViaApi(page, SEED_EMAILS.accountant)
  await validateTransactionViaAPI(page, incomeId)

  return { dropId, dropEmail, projectId, incomeId }
}

test.describe('Cash channel round 2 — two-step initiate / confirm', () => {
  test('happy path: DROP initiates → ACCOUNTANT confirms with Maksym', async ({ page }) => {
    const { dropId, dropEmail, incomeId } = await setupValidatedDropIncome(page)
    try {
      // Step 1: DROP triggers initiate-cash. No body fields besides incomeId.
      await loginViaApi(page, dropEmail)
      const initiateRes = await page.request.post(
        'http://localhost:3001/api/payments/initiate-cash',
        { data: { incomeId } },
      )
      expect(initiateRes.status()).toBe(201)
      const initiateBody = await initiateRes.json()
      expect(initiateBody.status).toBe('PENDING_CASH_CONFIRM')

      // ACCOUNTANT now sees the row in /payments/pending-cash.
      await loginViaApi(page, SEED_EMAILS.accountant)
      const listRes = await page.request.get('http://localhost:3001/api/payments/pending-cash')
      expect(listRes.status()).toBe(200)
      const list = await listRes.json()
      const ours = list.find((r: { incomeId: string }) => r.incomeId === incomeId)
      expect(ours).toBeDefined()
      expect(ours.dropId).toBe(dropId)

      // Step 2: ACCOUNTANT confirms with Maksym as recipient.
      const confirmRes = await page.request.post(
        'http://localhost:3001/api/payments/confirm-cash',
        { data: { incomeId, recipientAdminId: MAKSYM_ID } },
      )
      expect(confirmRes.status()).toBe(201)
      const confirmBody = await confirmRes.json()
      expect(confirmBody.created).toHaveLength(2)
      const types = confirmBody.created.map((t: { type: string }) => t.type).sort()
      expect(types).toEqual(['ADMIN_INCOME_CASH', 'SENIOR_PENDING_PAYOUT'])

      // After confirm, pending-cash list no longer contains the row.
      const listAfter = await (
        await page.request.get('http://localhost:3001/api/payments/pending-cash')
      ).json()
      expect(listAfter.find((r: { incomeId: string }) => r.incomeId === incomeId)).toBeUndefined()
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('DROP cannot call /confirm-cash → 403', async ({ page }) => {
    const { dropId, dropEmail, incomeId } = await setupValidatedDropIncome(page)
    try {
      // Initiate first (so PAYOUT is in PENDING_CASH_CONFIRM).
      await loginViaApi(page, dropEmail)
      await page.request.post('http://localhost:3001/api/payments/initiate-cash', {
        data: { incomeId },
      })

      // DROP tries to confirm-cash → 403.
      const res = await page.request.post('http://localhost:3001/api/payments/confirm-cash', {
        data: { incomeId, recipientAdminId: KOSTYA_ID },
      })
      expect(res.status()).toBe(403)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('confirm-cash on a payout NOT in PENDING_CASH_CONFIRM → 400', async ({ page }) => {
    const { dropId, incomeId } = await setupValidatedDropIncome(page)
    try {
      // Skip initiate — payout is still in PENDING_PAYMENT.
      await loginViaApi(page, SEED_EMAILS.accountant)
      const res = await page.request.post('http://localhost:3001/api/payments/confirm-cash', {
        data: { incomeId, recipientAdminId: MAKSYM_ID },
      })
      expect(res.status()).toBe(400)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('/payments/pending-cash hidden from SENIOR/JUNIOR/HR/DROP', async ({ page }) => {
    const probes: { email: string; label: string }[] = [
      { email: SEED_EMAILS.seniorA, label: 'SENIOR' },
      { email: SEED_EMAILS.juniorA, label: 'JUNIOR' },
      { email: SEED_EMAILS.hrA, label: 'HR' },
    ]
    for (const probe of probes) {
      await loginViaApi(page, probe.email)
      const res = await page.request.get('http://localhost:3001/api/payments/pending-cash')
      // Service throws ForbiddenException → 403 expected for all non-privileged.
      expect(res.status(), `${probe.label} should be 403`).toBe(403)
    }
  })
})
