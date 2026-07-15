/**
 * pending-settlement.spec.ts — task-autotest-business-logic-coverage (F).
 *
 * Phase 4-C pending settlement flows — the senior share from drop-projects
 * is owed by **THE COMPANY**, not by the DROP user. Covers:
 *
 *   GET  /api/pending-settlements/senior   — senior sees own; admin/accountant sees all.
 *   GET  /api/pending-settlements/company  — admin / accountant only.
 *   POST /api/pending-settlements/:id/settle-company
 *                                         — closes the COMPANY debt IN PLACE.
 *   POST /api/pending-settlements/by-source-transaction/:sourceTransactionId/settle-company
 *                                         — same cascade, resolved via SENIOR_PENDING_PAYOUT tx.
 *
 * Real-API. Backend must be running at http://localhost:3001 (override via
 * E2E_REAL_API_BASE for an isolated scratch stand — mirrors fixtures.ts).
 *
 * Reworked (PR #262 + #265): plantCompanyDebt now uses the new DROP-income cascade
 * (createDropIncome → validate → createPayoutRequest → pay) instead of the
 * deleted confirm-cash endpoint. Settle body updated to include fundingSource +
 * payerAdminId + currency as required by settleSeniorPayoutSchema.
 *
 * task-settle-in-place (ADR 2026-07-14, PR #379): `settleByCompany` no longer
 * INSERTS a second SENIOR_INCOME/PAYOUT_DROP row — it UPDATEs the SOURCE IOU
 * row (`*_PENDING_PAYOUT`) in place: same id, flipped type + status=PAID. The
 * settle assertions below were reworked from "a NEW matching row appeared" to
 * "the SAME row (by id) flipped, and the project's transaction COUNT did not
 * grow" — the previous insert-based assertions only checked amount/type, which
 * would still pass even if the fix regressed back to a phantom second row.
 *
 * /company response shape (from DTO):
 *   { obligationId, sourceTransactionId, debtorType, seniorId, amount, currency, ... }
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
  findUserByEmailViaApi,
  ensureCompanyWalletViaAPI,
  onboardDropViaAPI,
} from './fixtures'

// task-settle-in-place-e2e: was hardcoded to localhost:3001 — broke any
// isolated scratch stand (own DB + own ports, per lessons memory
// project_e2e_flaky_and_automerge / session_ops_lessons_2026_07_14). Mirrors
// the same env override fixtures.ts already uses for every typed helper in
// this file (loginViaApi, listTransactionsByProjectViaAPI, ...) so the WHOLE
// spec — not just the typed-helper calls — is portable to a throwaway API.
const REAL_API = `${process.env['E2E_REAL_API_BASE'] ?? 'http://localhost:3001'}/api`

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

/** Shape returned by GET /api/pending-settlements/company */
interface CompanyObligationDto {
  obligationId: string
  sourceTransactionId: string
  debtorType: string
  seniorId: string
  amount: string
  currency: string
}

/**
 * Plant a single COMPANY-debt obligation via the new DROP-income cascade:
 *   1. Create DROP + onboard
 *   2. Ensure company wallet (required for payout_request)
 *   3. Create DROP project
 *   4. DROP posts income → ACCOUNTANT validates → payout_request created → DROP pays
 *
 * The pay step books:
 *   - SENIOR_PENDING_PAYOUT (PENDING_PAYMENT) — the COMPANY debt obligation source tx
 *   - PAYOUT_DROP (PAID)
 *   - DROP_INCOME (PAID)
 *
 * Returns dropId, projectId, incomeTxId, seniorId so callers can probe
 * the pending-settlements endpoints and clean up.
 */
async function plantCompanyDebt(page: import('@playwright/test').Page): Promise<{
  dropId: string
  projectId: string
  incomeTxId: string
  seniorId: string
}> {
  const suffix = uniqueSuffix()
  const dropEmail = `pending-${suffix}@cheekycheese.dev`

  // Step 1: create DROP as ADMIN
  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const { dropId } = await createDropViaAPI(page, {
    email: dropEmail,
    displayName: `Pending Settlement ${suffix}`,
  })

  // Step 2: onboard DROP so income endpoints are accessible
  await onboardDropViaAPI(page, { dropId, dropEmail })

  // Step 3: ensure company wallet (seed leaves walletAddress=NULL, payout_request needs it)
  await loginViaApi(page, SEED_ADMIN_EMAIL)
  await ensureCompanyWalletViaAPI(page)

  // Step 4: create DROP project (attaches seniorA as senior)
  const { projectId } = await createDropProjectViaAPI(page, {
    dropId,
    seniorEmail: SEED_EMAILS.seniorA,
  })

  // Step 5: DROP posts income
  await loginViaApi(page, dropEmail)
  const { txId: incomeTxId } = await createDropIncomeViaAPI(page, {
    projectId,
    amount: 1000,
  })

  // Step 6: ACCOUNTANT validates → get payoutRequestId
  await loginViaApi(page, SEED_EMAILS.accountant)
  const { payoutRequestId } = await validateTransactionViaAPI(page, incomeTxId)

  // Step 7: if validate didn't auto-create payout_request, create it explicitly
  let prId = payoutRequestId
  if (!prId) {
    await loginViaApi(page, dropEmail)
    const created = await createPayoutRequestViaAPI(page, [incomeTxId])
    prId = created.payoutRequestId
  }

  // Step 8: DROP pays → cascade books SENIOR_PENDING_PAYOUT + PAYOUT_DROP
  await loginViaApi(page, dropEmail)
  await payPayoutRequestViaAPI(page, prId!)

  // Restore ADMIN session for callers
  await loginViaApi(page, SEED_ADMIN_EMAIL)

  const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorA)
  if (!senior) throw new Error('Seed senior A not found')

  return { dropId, projectId, incomeTxId, seniorId: senior.id }
}

test.describe('Pending settlement — debtor=COMPANY (Phase 4-C)', () => {
  test('after drop-income cascade → /senior surfaces the obligation for the senior', async ({
    page,
  }) => {
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

  test('after drop-income cascade → /company surfaces the obligation for ADMIN', async ({
    page,
  }) => {
    const { dropId, seniorId } = await plantCompanyDebt(page)

    try {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const res = await page.request.get(`${REAL_API}/pending-settlements/company`)
      expect(res.status()).toBe(200)
      const list = (await res.json()) as CompanyObligationDto[]

      // The newly-planted row credits our senior.
      // /company only returns PENDING obligations (server-side filter).
      const row = list.find((o) => o.seniorId === seniorId)
      expect(row, 'company list must include our senior as creditor').toBeTruthy()
      expect(row!.debtorType).toBe('COMPANY')
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('DROP cannot read /senior nor /company — 403', async ({ page }) => {
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

  test('ADMIN settles COMPANY debt → SOURCE row flips in place (no second transaction) + obligation drops from /company', async ({
    page,
  }) => {
    const { dropId, projectId, seniorId } = await plantCompanyDebt(page)

    try {
      // Capture the obligation row.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const beforeRes = await page.request.get(`${REAL_API}/pending-settlements/company`)
      const beforeList = (await beforeRes.json()) as CompanyObligationDto[]
      const row = beforeList.find((o) => o.seniorId === seniorId)
      expect(row, 'plant step must yield an obligation for our senior').toBeTruthy()
      const obligationAmount = parseFloat(row!.amount)
      const obligationId = row!.obligationId
      const sourceTransactionId = row!.sourceTransactionId

      // task-settle-in-place: capture the project's transaction COUNT before
      // settling — the in-place flip must NOT change it (no second row).
      const txsBefore = await listTransactionsByProjectViaAPI(page, projectId)

      // task-receipts-backend (review round 1, MED-1): the legacy 2-segment
      // `POST /pending-settlements/:id/settle-company` (obligation-id) route was
      // REMOVED — it silently ignored its body (no funding selection, no
      // mandatory receipt), a privileged bypass of the mandatory-receipt
      // invariant. Only the 3-segment `by-source-transaction` route remains
      // (see pending-settlement.controller.ts header comment); the /company DTO
      // already carries `sourceTransactionId`, so we settle through that
      // instead. `settleSeniorPayoutSchema` also now requires a mandatory,
      // currency-aware receipt (task-receipts-backend #10) — USDT ⇒ explorer
      // link only.
      const settleRes = await page.request.post(
        `${REAL_API}/pending-settlements/by-source-transaction/${sourceTransactionId}/settle-company`,
        {
          data: {
            fundingSource: 'ADMIN_PERSONAL',
            payerAdminId: MAKSYM_ID,
            currency: 'USDT',
            receiptExternalUrl: 'https://etherscan.io/tx/0xsettlecompany000001',
          },
        },
      )
      expect(settleRes.status()).toBeLessThan(400)
      const settleBody = (await settleRes.json()) as { created: Array<{ id: string }> }
      // task-settle-in-place: the settle response's `created` row REUSES the
      // source transaction id — proof the backend flipped the row in place
      // instead of allocating a new one.
      expect(settleBody.created).toHaveLength(1)
      expect(settleBody.created[0]!.id).toBe(sourceTransactionId)

      // /company no longer contains our row.
      const afterRes = await page.request.get(`${REAL_API}/pending-settlements/company`)
      const afterList = (await afterRes.json()) as CompanyObligationDto[]
      expect(afterList.find((o) => o.obligationId === obligationId)).toBeFalsy()

      // task-settle-in-place: NO second transaction — the project's row COUNT
      // is unchanged, and the SOURCE row (same id) is now the PAID SENIOR_INCOME.
      const txsAfter = await listTransactionsByProjectViaAPI(page, projectId)
      expect(txsAfter.length, 'settling in place must NOT create a second transaction row').toBe(
        txsBefore.length,
      )
      const settled = txsAfter.find((t) => t.id === sourceTransactionId)
      expect(settled, 'the SOURCE IOU row must still exist under the SAME id').toBeTruthy()
      expect(settled!.type).toBe('SENIOR_INCOME')
      expect(settled!.status).toBe('PAID')
      expect(settled!.receiverId).toBe(seniorId)
      expect(Math.abs(parseFloat(settled!.amount) - obligationAmount)).toBeLessThan(0.01)
      // No lingering «Ожидает выплаты» phantom for this source id.
      expect(
        txsAfter.some((t) => t.id === sourceTransactionId && t.type === 'SENIOR_PENDING_PAYOUT'),
      ).toBe(false)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  // task-senior-settle-in-tx-row: the finance-page transactions list pays the
  // senior directly from the SENIOR_PENDING_PAYOUT row, which knows the SOURCE
  // transaction id (not the obligation id). The new endpoint resolves the linked
  // obligation and runs the SAME settleByCompany cascade.
  test('ADMIN settles by SOURCE transaction id → SAME row flips in place; idempotent; SENIOR 403', async ({
    page,
  }) => {
    const { dropId, projectId, seniorId } = await plantCompanyDebt(page)

    try {
      // Find the SENIOR_PENDING_PAYOUT row (the source tx the finance-page row
      // carries) for our senior on this project. `txs` also doubles as the
      // BEFORE snapshot for the task-settle-in-place count-stability check below.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const txs = await listTransactionsByProjectViaAPI(page, projectId)
      const pendingRow = txs.find(
        (t) =>
          t.type === 'SENIOR_PENDING_PAYOUT' &&
          t.status === 'PENDING_PAYMENT' &&
          t.receiverId === seniorId,
      )
      expect(pendingRow, 'plant step must yield a SENIOR_PENDING_PAYOUT row').toBeTruthy()
      const sourceTxId = pendingRow!.id
      const obligationAmount = parseFloat(pendingRow!.amount)

      // RBAC: SENIOR cannot settle their own IOU → 403, before any money moves.
      await loginViaApi(page, SEED_EMAILS.seniorA)
      const seniorAttempt = await page.request.post(
        `${REAL_API}/pending-settlements/by-source-transaction/${sourceTxId}/settle-company`,
        {
          data: {
            fundingSource: 'ADMIN_PERSONAL',
            payerAdminId: MAKSYM_ID,
            currency: 'USDT',
          },
        },
      )
      expect(seniorAttempt.status()).toBe(403)

      // ADMIN settles via the source-transaction endpoint. task-receipts-backend
      // (#10): settleSeniorPayoutSchema now requires a mandatory, currency-aware
      // receipt — USDT ⇒ explorer link only.
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const settleRes = await page.request.post(
        `${REAL_API}/pending-settlements/by-source-transaction/${sourceTxId}/settle-company`,
        {
          data: {
            fundingSource: 'ADMIN_PERSONAL',
            payerAdminId: MAKSYM_ID,
            currency: 'USDT',
            receiptExternalUrl: 'https://etherscan.io/tx/0xsourcesettle000001',
          },
        },
      )
      expect(settleRes.status()).toBeLessThan(400)
      const settleBody = (await settleRes.json()) as { created: Array<{ id: string }> }
      // task-settle-in-place: the settle response reuses the SOURCE transaction
      // id — no second row was allocated.
      expect(settleBody.created).toHaveLength(1)
      expect(settleBody.created[0]!.id).toBe(sourceTxId)

      // The specific obligation (identified by sourceTransactionId) is gone from /company.
      // Note: seniorId alone is too broad — other tests may have left obligations
      // for the same seed senior. Use sourceTransactionId for a precise match.
      const afterRes = await page.request.get(`${REAL_API}/pending-settlements/company`)
      const afterList = (await afterRes.json()) as CompanyObligationDto[]
      expect(afterList.find((o) => o.sourceTransactionId === sourceTxId)).toBeFalsy()

      // task-settle-in-place: the project's transaction COUNT is unchanged
      // (the SAME row flipped — no second SENIOR_INCOME was inserted).
      const txsAfter = await listTransactionsByProjectViaAPI(page, projectId)
      expect(txsAfter.length, 'settling in place must NOT create a second transaction row').toBe(
        txs.length,
      )
      const settled = txsAfter.find((t) => t.id === sourceTxId)
      expect(settled, 'the SOURCE IOU row must still exist under the SAME id').toBeTruthy()
      expect(settled!.type).toBe('SENIOR_INCOME')
      expect(settled!.status).toBe('PAID')
      expect(settled!.receiverId).toBe(seniorId)
      expect(Math.abs(parseFloat(settled!.amount) - obligationAmount)).toBeLessThan(0.01)

      // Idempotent: a second settle of the SAME source tx pays nothing more
      // (no open obligation left → 4xx, never a second SENIOR_INCOME). Keep a
      // VALID receipt here too — the point is to prove the idempotency/no-open-
      // obligation gate rejects it, not to accidentally reject on the (now
      // unrelated) mandatory-receipt check.
      const secondAttempt = await page.request.post(
        `${REAL_API}/pending-settlements/by-source-transaction/${sourceTxId}/settle-company`,
        {
          data: {
            fundingSource: 'ADMIN_PERSONAL',
            payerAdminId: MAKSYM_ID,
            currency: 'USDT',
            receiptExternalUrl: 'https://etherscan.io/tx/0xsourcesettle000002',
          },
        },
      )
      expect(secondAttempt.status()).toBeGreaterThanOrEqual(400)

      const txsFinal = await listTransactionsByProjectViaAPI(page, projectId)
      const seniorIncomes = txsFinal.filter(
        (t) =>
          t.type === 'SENIOR_INCOME' &&
          t.status === 'PAID' &&
          t.receiverId === seniorId &&
          Math.abs(parseFloat(t.amount) - obligationAmount) < 0.01,
      )
      expect(
        seniorIncomes.length,
        'exactly one SENIOR_INCOME for the senior share — no double payout',
      ).toBe(1)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})
