/**
 * drop-share-usdt-income.spec.ts — task-drop-share-e2e (Flow 1, AC1).
 *
 * ADR `docs/architecture/2026-07-13-payment-type-income-routing.md` (D0/D3/D4/D5).
 * Real-API + real-UI coverage of the NEW admin-USDT income declaration flow:
 *
 *   1. ADMIN opens the finance «Новая транзакция» dialog, picks the new
 *      «USDT-приход» type, selects a USDT-payment drop-project, picks a
 *      receiver (another ADMIN partner, or «Счёт компании»), submits.
 *   2. The backend atomically books the gross ADMIN_INCOME row + TWO
 *      obligations: SENIOR_PENDING_PAYOUT (company owes the project's
 *      senior) and DROP_PENDING_PAYOUT (company owes the bound drop) —
 *      both visible on /finance.
 *   3. ADMIN/ACCOUNTANT settles the senior obligation via the EXISTING
 *      «Выплатить» UI action (SettleSeniorPayoutDialog) → SENIOR_INCOME
 *      appears, obligation row disappears.
 *
 * NOTE (documented gap — see task-drop-share-e2e report to PM): at the time
 * of writing, `TransactionRow.tsx` only wires the «Выплатить» action for
 * `SENIOR_PENDING_PAYOUT` rows (`task-senior-settle-in-tx-row` scope) — a
 * `DROP_PENDING_PAYOUT` row renders (label «Ожидаемая выплата дропу») but has
 * NO settle button, even though the backend's `settleByCompany` generic
 * endpoint (ADR D5) already routes a DROP_PENDING_PAYOUT source-transaction
 * to the new `PAYOUT_DROP` branch identically to the senior one. This spec
 * settles the drop leg directly via that endpoint
 * (`settleObligationBySourceTransactionViaAPI`) and asserts the backend
 * outcome (drop balance moves) — it is NOT a stand-in for a UI test, it
 * documents a real product gap pending a frontend follow-up.
 *
 * Per the purpose statement (feedback_mocked_e2e_guards lesson): RBAC 403 +
 * money invariants are already covered by backend integration tests
 * (task-drop-share-backend AC9-AC16 — real-DB, not mocked). This spec proves
 * the USER PATH through the real UI, not the endpoint contract in isolation.
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
  onboardDropViaAPI,
  findUserByEmailViaApi,
  listTransactionsByProjectViaAPI,
  settleObligationBySourceTransactionViaAPI,
  getCompanyAccountBalanceViaAPI,
  getDropSelfSummaryViaAPI,
} from './fixtures'

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

/**
 * Provision a fresh USDT drop-project: a new onboarded DROP bound to a
 * brand-new project whose senior is the seed non-ADMIN senior (seniorA).
 * Explicit `seniorSharePercentOverride` / `dropSharePercentOverride` make the
 * obligation math deterministic ($1000 × 20% = $200 senior, × 10% = $100 drop)
 * regardless of seed defaults.
 */
async function provisionUsdtDropProject(page: import('@playwright/test').Page): Promise<{
  dropId: string
  dropEmail: string
  projectId: string
  projectName: string
  seniorId: string
}> {
  const suffix = uniqueSuffix()
  const dropEmail = `usdt-drop-${suffix}@cheekycheese.dev`
  // Unique per test (down to the ms+random suffix) — the ADMIN's project
  // Select shows EVERY USDT project across the whole seed/scratch DB, so
  // concurrently-running tests need distinguishable exact names (strict-mode
  // safe `getByRole('option', { name, exact: true })` at the call-site).
  const projectName = `USDT Flow1 ${suffix}`

  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const { dropId } = await createDropViaAPI(page, {
    email: dropEmail,
    displayName: `USDT Drop ${suffix}`,
  })
  await onboardDropViaAPI(page, { dropId, dropEmail })

  await loginViaApi(page, SEED_ADMIN_EMAIL)
  const { projectId } = await createDropProjectViaAPI(page, {
    dropId,
    seniorEmail: SEED_EMAILS.seniorA,
    name: projectName,
    rate: 5000,
    currency: 'USDT',
    paymentType: 'USDT',
    seniorSharePercentOverride: 20,
    dropSharePercentOverride: 10,
  })

  const senior = await findUserByEmailViaApi(page, SEED_EMAILS.seniorA)
  if (!senior) throw new Error('Seed senior A not found')

  return { dropId, dropEmail, projectId, projectName, seniorId: senior.id }
}

test.describe('Admin-USDT income declaration — happy path (Flow 1, AC1)', () => {
  test('ADMIN declares USDT income via UI (receiver = ADMIN partner) → both obligations booked → senior settle via UI → drop settle moves drop balance', async ({
    page,
  }) => {
    const { dropId, dropEmail, projectId, projectName, seniorId } =
      await provisionUsdtDropProject(page)

    try {
      // Drop balance BEFORE any settle (should be 0 — a fresh drop has no
      // PAYOUT_DROP credits yet).
      await loginViaApi(page, dropEmail)
      const balanceBefore = await getDropSelfSummaryViaAPI(page)
      expect(balanceBefore.balance).toBe(0)

      // ── UI: ADMIN declares the USDT income ──────────────────────────────
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      await page.goto('/finance')

      await page.getByTestId('finance-create-transaction-button').click()
      const dialog = page.getByTestId('create-transaction-dialog')
      await expect(dialog).toBeVisible()

      await dialog.getByTestId('create-transaction-type-usdt_income').click()

      await dialog.getByTestId('create-transaction-project-trigger').click()
      await page.getByRole('option', { name: projectName, exact: true }).click()

      await dialog.getByTestId('usdt-income-receiver-trigger').click()
      // Kostya — the OTHER seed ADMIN (grouped under «Админы»), distinct from
      // the declaring ADMIN (Maksym) so the personal-credit branch is exercised.
      await page.getByRole('option', { name: 'Kostya', exact: true }).click()

      await dialog.getByPlaceholder('0.00').fill('1000')

      // task-receipts-e2e: USDT_INCOME is a mandatory, explorer-only receipt
      // type (design-spec §3.1/§4.3) — the dialog blocks submit without a
      // blockchain-explorer link (no file mode for USDT).
      await dialog.getByTestId('receipt-input-url-field').fill('https://etherscan.io/tx/0xabc123')

      const declareRes = page.waitForResponse(
        (r) => r.url().includes('/finance/usdt-income') && r.request().method() === 'POST',
      )
      await dialog.getByTestId('create-transaction-submit').click()
      const res = await declareRes
      expect(res.status()).toBeLessThan(300)
      const incomeTx = (await res.json()) as { id: string; receiverId: string; status: string }
      expect(incomeTx.status).toBe('PAID')
      expect(incomeTx.receiverId).toBe(KOSTYA_ID)

      // Dialog closes on success (onSuccess → onClose + resetForm).
      await expect(dialog).not.toBeVisible()

      // ── Obligations booked atomically — verify via API ──────────────────
      const txsAfterDeclare = await listTransactionsByProjectViaAPI(page, projectId)
      const seniorPending = txsAfterDeclare.find(
        (t) => t.type === 'SENIOR_PENDING_PAYOUT' && t.status === 'PENDING_PAYMENT',
      )
      const dropPending = txsAfterDeclare.find(
        (t) => t.type === 'DROP_PENDING_PAYOUT' && t.status === 'PENDING_PAYMENT',
      )
      expect(seniorPending, 'SENIOR_PENDING_PAYOUT obligation must be booked').toBeTruthy()
      expect(dropPending, 'DROP_PENDING_PAYOUT obligation must be booked').toBeTruthy()
      expect(seniorPending!.receiverId).toBe(seniorId)
      expect(dropPending!.receiverId).toBe(dropId)
      expect(parseFloat(seniorPending!.amount)).toBeCloseTo(200, 2) // 1000 × 20%
      expect(parseFloat(dropPending!.amount)).toBeCloseTo(100, 2) // 1000 × 10%

      // ── Obligations are visible in the finance table (UI) ───────────────
      await page.goto('/finance')
      const seniorRow = page.getByTestId(`tx-row-${seniorPending!.id}`)
      const dropRow = page.getByTestId(`tx-row-${dropPending!.id}`)
      await expect(seniorRow).toBeVisible()
      await expect(dropRow).toBeVisible()
      await expect(seniorRow).toContainText('Ожидаемая выплата синьору')
      await expect(dropRow).toContainText('Ожидаемая выплата дропу')

      // ── Settle the SENIOR obligation via the existing UI action ─────────
      // Fund from Kostya's ADMIN_PERSONAL account (avoids the company-account
      // balance gate — the scratch company account starts at $0).
      const settleSeniorBtn = page.getByTestId(`tx-row-settle-senior-payout-${seniorPending!.id}`)
      await expect(settleSeniorBtn).toBeVisible()
      await settleSeniorBtn.click()

      const settleDialog = page.getByTestId('settle-senior-dialog')
      await expect(settleDialog).toBeVisible()
      await settleDialog.getByTestId(`settle-senior-account-admin-${KOSTYA_ID}`).click()
      // task-receipts-e2e: SettleSeniorPayoutDialog now requires a mandatory
      // receipt too (design-spec §3.3); currency defaults/stays USDT after
      // picking the ADMIN_PERSONAL account → explorer-only.
      await settleDialog
        .getByTestId('receipt-input-url-field')
        .fill('https://etherscan.io/tx/0xsettle123')
      await settleDialog.getByTestId('settle-senior-submit').click()
      await expect(settleDialog).not.toBeVisible()
      await expect(page.getByText('Выплата синьору проведена')).toBeVisible({ timeout: 10_000 })

      // The IOU (SENIOR_PENDING_PAYOUT) transaction row itself is a historical
      // marker and keeps its original PENDING_PAYMENT status forever — the
      // closed/open state lives on the linked `pending_obligations` row, not
      // here (verified against a real DB read during spec authoring). The
      // authoritative proof of settlement is the new SENIOR_INCOME row below.
      const txsAfterSeniorSettle = await listTransactionsByProjectViaAPI(page, projectId)
      const seniorIncome = txsAfterSeniorSettle.find(
        (t) => t.type === 'SENIOR_INCOME' && t.status === 'PAID' && t.receiverId === seniorId,
      )
      expect(seniorIncome, 'settling the IOU must create a PAID SENIOR_INCOME row').toBeTruthy()
      expect(parseFloat(seniorIncome!.amount)).toBeCloseTo(200, 2)

      // ── Settle the DROP obligation via the generic settle endpoint ──────
      // (documented UI gap — see header comment). Same funding as senior.
      await settleObligationBySourceTransactionViaAPI(page, dropPending!.id, {
        fundingSource: 'ADMIN_PERSONAL',
        payerAdminId: KOSTYA_ID,
        currency: 'USDT',
      })

      const txsAfterDropSettle = await listTransactionsByProjectViaAPI(page, projectId)
      const payoutDrop = txsAfterDropSettle.find(
        (t) => t.type === 'PAYOUT_DROP' && t.status === 'PAID' && t.receiverId === dropId,
      )
      expect(payoutDrop, 'settling the drop IOU must create a PAID PAYOUT_DROP row').toBeTruthy()
      expect(parseFloat(payoutDrop!.amount)).toBeCloseTo(100, 2)

      // The drop's own aggregate balance moved by exactly the settled amount.
      await loginViaApi(page, dropEmail)
      const balanceAfter = await getDropSelfSummaryViaAPI(page)
      expect(balanceAfter.balance).toBeCloseTo(balanceBefore.balance + 100, 2)
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('ADMIN declares USDT income via UI (receiver = «Счёт компании») → gross credits the shared pool', async ({
    page,
  }) => {
    const { dropId, projectId, projectName } = await provisionUsdtDropProject(page)

    try {
      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const balanceBefore = await getCompanyAccountBalanceViaAPI(page)

      await page.goto('/finance')
      await page.getByTestId('finance-create-transaction-button').click()
      const dialog = page.getByTestId('create-transaction-dialog')
      await expect(dialog).toBeVisible()

      await dialog.getByTestId('create-transaction-type-usdt_income').click()
      await dialog.getByTestId('create-transaction-project-trigger').click()
      await page.getByRole('option', { name: projectName, exact: true }).click()

      await dialog.getByTestId('usdt-income-receiver-trigger').click()
      await page.getByRole('option', { name: 'Счёт компании', exact: true }).click()

      await dialog.getByPlaceholder('0.00').fill('1000')

      // task-receipts-e2e: mandatory explorer-only receipt (same as the other
      // USDT_INCOME test above).
      await dialog.getByTestId('receipt-input-url-field').fill('https://etherscan.io/tx/0xdef456')

      const declareRes = page.waitForResponse(
        (r) => r.url().includes('/finance/usdt-income') && r.request().method() === 'POST',
      )
      await dialog.getByTestId('create-transaction-submit').click()
      const res = await declareRes
      const incomeTx = (await res.json()) as { id: string; receiverId: string }
      // COMPANY_ACCOUNT sentinel → the row is credited to the CALLER (ADMIN)
      // personally in the DTO (receiverId=caller), but `fundingSource=
      // COMPANY_ACCOUNT` excludes it from the personal balance — proven below
      // by the shared pool actually moving by the gross amount.
      expect(incomeTx.receiverId).toBe(MAKSYM_ID)
      await expect(dialog).not.toBeVisible()

      const balanceAfter = await getCompanyAccountBalanceViaAPI(page)
      expect(balanceAfter).toBeCloseTo(balanceBefore + 1000, 2)

      // Obligations still booked identically (receiver choice doesn't affect
      // the obligation math — only where the gross lands).
      const txs = await listTransactionsByProjectViaAPI(page, projectId)
      expect(txs.find((t) => t.type === 'SENIOR_PENDING_PAYOUT')).toBeTruthy()
      expect(txs.find((t) => t.type === 'DROP_PENDING_PAYOUT')).toBeTruthy()
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('ACCOUNTANT does not see «USDT-приход» as a creatable transaction type (UI gate)', async ({
    page,
  }) => {
    // ADR Q4: only ADMIN may declare admin-USDT income — ACCOUNTANT keeps the
    // plain set (ADMIN_INCOME/EXPENSE/SALARY/ADMIN_TRANSFER), no USDT_INCOME
    // option. This is a UI-rendering check (availableTypes), NOT a duplicate
    // of the backend 403 guard (already covered by backend integration AC9).
    await loginViaApi(page, SEED_EMAILS.accountant)
    await page.goto('/finance')
    await page.getByTestId('finance-create-transaction-button').click()
    const dialog = page.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('create-transaction-type-usdt_income')).not.toBeAttached()
    await expect(dialog.getByTestId('create-transaction-type-admin_income')).toBeVisible()
  })
})
