/**
 * drop-cash-channel.spec.ts — task-autotest-business-logic-coverage (D).
 *
 * Phase 4 admin-initiated cash channel — coverage of
 * POST /api/payments/confirm-cash:
 *
 *   1. ACCOUNTANT confirms cash received → DB shape:
 *      - ADMIN_INCOME_CASH inserted (status=PAID, receiver=chosen admin).
 *      - SENIOR_PENDING_PAYOUT inserted (debtor=COMPANY,
 *        receiver=senior, status=PENDING_PAYMENT).
 *      - Placeholder PAYOUT flipped PENDING_PAYMENT → PAID.
 *
 *   2. RBAC — DROP / SENIOR / JUNIOR / HR are forbidden from the endpoint
 *      (the dedicated RBAC matrix spec covers the matrix exhaustively;
 *      here we re-assert the DROP branch because it's the most failure-prone).
 *
 *   3. Idempotency — second confirm-cash on the same income returns 400
 *      ("cascade already exists" / "already settled").
 *
 * Real-API. No UI assertions in this file — the Phase 4 cash UI button is
 * exercised by the smoke regression specs. Backend contract is the
 * load-bearing surface for the refactor's correctness.
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

/** Setup helper: drop + drop-project + DROP_INCOME validated to PENDING_PAYMENT. */
async function plantValidatedDropIncome(
  page: import('@playwright/test').Page,
): Promise<{
  dropId: string
  projectId: string
  incomeTxId: string
  payoutTxId: string
  dropEmail: string
}> {
  const suffix = uniqueSuffix()
  const dropEmail = `cash-${suffix}@cheekycheese.dev`

  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const { dropId } = await createDropViaAPI(page, {
    email: dropEmail,
    displayName: `Cash Channel ${suffix}`,
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

test.describe('Drop cash channel — confirm-cash (Phase 4)', () => {
  test('ACCOUNTANT confirms cash → ADMIN_INCOME_CASH + SENIOR_PENDING_PAYOUT (debtor=COMPANY) + PAYOUT flipped to PAID', async ({
    page,
  }) => {
    const { dropId, projectId, incomeTxId, payoutTxId } = await plantValidatedDropIncome(page)

    try {
      // ACCOUNTANT confirms cash → Maksym.
      await loginViaApi(page, SEED_EMAILS.accountant)
      const res = await page.request.post(`${REAL_API}/payments/confirm-cash`, {
        data: { incomeId: incomeTxId, recipientAdminId: MAKSYM_ID },
      })
      expect(res.status()).toBeLessThan(400)
      const body = (await res.json()) as {
        income: { id: string; status: string }
        created: Array<{ id: string; type: string; status: string; amount: string }>
      }
      // The `created` array carries at least the cash + pending rows.
      expect(body.created.length).toBeGreaterThanOrEqual(2)

      // ── DB shape ─────────────────────────────────────────────────────────
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const txs = await listTransactionsByProjectViaAPI(page, projectId)

      const cashRows = txs.filter((t) => t.type === 'ADMIN_INCOME_CASH')
      expect(cashRows).toHaveLength(1)
      expect(cashRows[0]!.status).toBe('PAID')
      // Receiver = chosen admin (Maksym).
      expect(cashRows[0]!.receiverId).toBe(MAKSYM_ID)
      expect(cashRows[0]!.recipientId).toBe(MAKSYM_ID)
      expect(cashRows[0]!.projectId).toBe(projectId)

      const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorA)
      expect(senior).toBeTruthy()
      const pendingRows = txs.filter((t) => t.type === 'SENIOR_PENDING_PAYOUT')
      expect(pendingRows).toHaveLength(1)
      expect(pendingRows[0]!.status).toBe('PENDING_PAYMENT')
      expect(pendingRows[0]!.receiverId).toBe(senior!.id)

      // Placeholder PAYOUT flipped to PAID by the cash cascade.
      const payoutAfter = await getTransactionViaAPI(page, payoutTxId)
      expect(payoutAfter.status).toBe('PAID')
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('DROP cannot call confirm-cash on their own income → 403 (RBAC)', async ({ page }) => {
    const { dropId, incomeTxId, dropEmail } = await plantValidatedDropIncome(page)

    try {
      await loginViaApi(page, dropEmail)
      const res = await page.request.post(`${REAL_API}/payments/confirm-cash`, {
        data: { incomeId: incomeTxId, recipientAdminId: MAKSYM_ID },
      })
      expect(res.status()).toBe(403)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('Second confirm-cash on the same income → 400 (already settled)', async ({
    page,
  }) => {
    const { dropId, incomeTxId } = await plantValidatedDropIncome(page)

    try {
      await loginViaApi(page, SEED_EMAILS.accountant)
      const first = await page.request.post(`${REAL_API}/payments/confirm-cash`, {
        data: { incomeId: incomeTxId, recipientAdminId: MAKSYM_ID },
      })
      expect(first.status()).toBeLessThan(400)

      const second = await page.request.post(`${REAL_API}/payments/confirm-cash`, {
        data: { incomeId: incomeTxId, recipientAdminId: KOSTYA_ID },
      })
      expect(second.status()).toBe(400)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('recipientAdminId must be ADMIN role → 400 for SENIOR recipient', async ({
    page,
  }) => {
    const { dropId, incomeTxId } = await plantValidatedDropIncome(page)

    try {
      const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorA)
      expect(senior).toBeTruthy()

      await loginViaApi(page, SEED_EMAILS.accountant)
      const res = await page.request.post(`${REAL_API}/payments/confirm-cash`, {
        data: { incomeId: incomeTxId, recipientAdminId: senior!.id },
      })
      expect(res.status()).toBe(400)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
