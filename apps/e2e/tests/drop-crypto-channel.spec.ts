/**
 * drop-crypto-channel.spec.ts — task-autotest-business-logic-coverage (E).
 *
 * Phase 4 drop crypto channel — coverage of
 * POST /api/payments/initiate-crypto and POST /api/payments/confirm-crypto:
 *
 *   1. /initiate-crypto returns recipients = [Maksym, Kostya] only (no senior
 *      direct line — senior share is a COMPANY debt now).
 *   2. /confirm-crypto with 2 txHashes →
 *        - 2× ADMIN_INCOME_CRYPTO inserted (status=PAID, recipientId per partner).
 *        - 1× SENIOR_PENDING_PAYOUT inserted (debtor=COMPANY, status=PENDING_PAYMENT).
 *        - Placeholder PAYOUT flipped to PAID.
 *   3. /confirm-crypto with empty txHashes array → 400.
 *   4. Idempotency — second /confirm-crypto on the same income → 400.
 *
 * Real-API. RBAC matrix spec covers the role-by-role enforcement; here we
 * stay focused on the cascade math + idempotency.
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
  listTransactionsByProjectViaAPI,
  findUserByEmailViaApi,
  findPendingPayoutsForProjectViaAPI,
  getTransactionViaAPI,
} from './fixtures'

const REAL_API = 'http://localhost:3001/api'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

async function plantValidatedDropIncome(page: import('@playwright/test').Page): Promise<{
  dropId: string
  projectId: string
  incomeTxId: string
  payoutTxId: string
  dropEmail: string
}> {
  const suffix = uniqueSuffix()
  const dropEmail = `crypto-${suffix}@cheekycheese.dev`

  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const { dropId } = await createDropViaAPI(page, {
    email: dropEmail,
    displayName: `Crypto Channel ${suffix}`,
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

  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const pending = await findPendingPayoutsForProjectViaAPI(page, projectId)
  if (pending.length === 0) {
    throw new Error('plant step did not produce PENDING_PAYMENT PAYOUT')
  }

  return { dropId, projectId, incomeTxId, payoutTxId: pending[0]!.id, dropEmail }
}

test.describe('Drop crypto channel — initiate + confirm (Phase 4)', () => {
  test('/initiate-crypto returns recipients = 2 admin partners only', async ({ page }) => {
    const { dropId, incomeTxId, dropEmail } = await plantValidatedDropIncome(page)

    try {
      // DROP themselves initiate — happy path.
      await loginViaApi(page, dropEmail)
      const res = await page.request.post(`${REAL_API}/payments/initiate-crypto`, {
        data: { incomeId: incomeTxId },
      })
      expect(res.status()).toBeLessThan(400)
      const body = (await res.json()) as {
        recipients: Array<{ role: string; userId: string; amount: string }>
        currency: string
      }

      // Exactly 2 ADMIN recipients (Maksym + Kostya). NO SENIOR direct line
      // — senior share is owed by the company now.
      expect(body.recipients.length).toBe(2)
      expect(body.recipients.every((r) => r.role === 'ADMIN')).toBe(true)
      const recipientIds = new Set(body.recipients.map((r) => r.userId))
      expect(recipientIds.has(MAKSYM_ID)).toBe(true)
      expect(recipientIds.has(KOSTYA_ID)).toBe(true)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('/confirm-crypto with 2 txHashes → 2 ADMIN_INCOME_CRYPTO + 1 SENIOR_PENDING_PAYOUT + PAYOUT to PAID', async ({
    page,
  }) => {
    const { dropId, projectId, incomeTxId, payoutTxId, dropEmail } =
      await plantValidatedDropIncome(page)

    try {
      await loginViaApi(page, dropEmail)
      const res = await page.request.post(`${REAL_API}/payments/confirm-crypto`, {
        data: { incomeId: incomeTxId, txHashes: ['0xhash1aaaaaa', '0xhash2bbbbbb'] },
      })
      expect(res.status()).toBeLessThan(400)
      const body = (await res.json()) as {
        income: { id: string; status: string }
        created: Array<{ id: string; type: string }>
      }
      expect(body.created.length).toBeGreaterThanOrEqual(3) // 2 admin + 1 pending

      // DB shape.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const txs = await listTransactionsByProjectViaAPI(page, projectId)

      const adminCrypto = txs.filter((t) => t.type === 'ADMIN_INCOME_CRYPTO')
      expect(adminCrypto).toHaveLength(2)
      const adminIds = new Set(adminCrypto.map((t) => t.recipientId))
      expect(adminIds.has(MAKSYM_ID)).toBe(true)
      expect(adminIds.has(KOSTYA_ID)).toBe(true)
      expect(adminCrypto.every((t) => t.status === 'PAID')).toBe(true)

      const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorA)
      expect(senior).toBeTruthy()
      const pending = txs.filter((t) => t.type === 'SENIOR_PENDING_PAYOUT')
      expect(pending).toHaveLength(1)
      expect(pending[0]!.status).toBe('PENDING_PAYMENT')
      expect(pending[0]!.receiverId).toBe(senior!.id)

      // Placeholder PAYOUT flipped to PAID.
      const payoutAfter = await getTransactionViaAPI(page, payoutTxId)
      expect(payoutAfter.status).toBe('PAID')
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('/confirm-crypto with empty txHashes → 400', async ({ page }) => {
    const { dropId, incomeTxId, dropEmail } = await plantValidatedDropIncome(page)

    try {
      await loginViaApi(page, dropEmail)
      const res = await page.request.post(`${REAL_API}/payments/confirm-crypto`, {
        data: { incomeId: incomeTxId, txHashes: [] },
      })
      expect(res.status()).toBe(400)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('idempotency: second /confirm-crypto on same income → 400', async ({ page }) => {
    const { dropId, incomeTxId, dropEmail } = await plantValidatedDropIncome(page)

    try {
      await loginViaApi(page, dropEmail)
      const first = await page.request.post(`${REAL_API}/payments/confirm-crypto`, {
        data: { incomeId: incomeTxId, txHashes: ['0xhash1', '0xhash2'] },
      })
      expect(first.status()).toBeLessThan(400)

      const second = await page.request.post(`${REAL_API}/payments/confirm-crypto`, {
        data: { incomeId: incomeTxId, txHashes: ['0xhash3', '0xhash4'] },
      })
      expect(second.status()).toBe(400)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
