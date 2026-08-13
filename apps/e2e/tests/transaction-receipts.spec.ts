/**
 * transaction-receipts.spec.ts — task-receipts-e2e.
 *
 * E2E coverage for the mandatory-receipt feature (pm-brief
 * `.claude/briefs/pm-brief-transaction-receipts.md`, design spec
 * `docs/design/transaction-receipts.md`):
 *
 *   1. Create-block: creating any of the 9 user-facing create/pay flows
 *      WITHOUT a receipt is blocked client-side (no network call fires);
 *      the SALARY create-time reminder is the sole exception (A3).
 *   2. Non-USDT create with a receipt (file OR link) succeeds.
 *   3. USDT-currency flows require an explorer link — the file tab is not
 *      even rendered, and a non-allowlisted link is rejected.
 *   4. Pay/settle (PaySalaryDialog / SettleSeniorPayoutDialog) also gate on
 *      the receipt.
 *   5. The generic attach/replace endpoint (`PATCH /transactions/:id/receipt`)
 *      RBAC + status matrix: ADMIN/ACCOUNTANT any transaction; the author
 *      only their own; replace after PAID is privileged-only.
 *   6. Regression: pre-existing receipt-less rows (seed data / SALARY
 *      reminders) keep rendering without error.
 *
 * Real-API + real-UI (mocked E2E would not exercise the backend guards —
 * feedback_mocked_e2e_guards lesson). Backend must be running.
 *
 * Cross-references (NOT duplicated here):
 *   - SENIOR_INCOME without-receipt block + resubmit-with-receipt flow —
 *     `finance-senior-flow.spec.ts` ("SENIOR не может создать транзакцию без
 *     чека", "SENIOR прикрепляет новый чек (ссылка) и переотправляет").
 *   - DROP_INCOME WITH a receipt (happy path) — `drop-income-ui.spec.ts`.
 *   - A USDT-project declaration with a valid explorer link (happy path,
 *     both receiver branches) + SettleSeniorPayoutDialog WITH a receipt
 *     (happy path) — `drop-share-usdt-income.spec.ts`.
 *   - PaySalaryDialog WITH a receipt (happy path) — `finance.spec.ts`.
 *   - Document-level receipt badge (#356 `deriveStatusBadge`) — untouched by
 *     this feature (design-spec §6.1); covered by `documents-pr*.spec.ts`.
 */

import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import {
  SEED_ADMIN_EMAIL,
  SEED_EMAILS,
  loginViaApi,
  createDropViaAPI,
  cleanupDropViaAPI,
  createDropProjectViaAPI,
  onboardDropViaAPI,
  ensureCompanyWalletViaAPI,
  createSeniorIncomeViaAPI,
  createDropIncomeViaAPI,
  validateTransactionViaAPI,
  createPayoutRequestViaAPI,
  payPayoutRequestViaAPI,
  listTransactionsByProjectViaAPI,
  declareUsdtIncomeViaAPI,
} from './fixtures'

const REAL_API = `${process.env['E2E_REAL_API_BASE'] ?? 'http://localhost:3001'}/api`

function uniqueSuffix(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

/**
 * A random YYYY-MM far outside the seed data's real range (2025/2026) and
 * spread across ~720 combinations — `createSalary` enforces ONE reminder per
 * (receiver, month), so a fixed month would collide across repeated test
 * runs (and with itself across `--repeat-each`). Random, not sequential, so
 * parallel workers can't collide either.
 */
function randomSalaryMonth(): string {
  const year = 2030 + Math.floor(Math.random() * 60)
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0')
  return `${year}-${month}`
}

/** A tiny valid 1x1 PNG — avoids depending on an on-disk fixture asset. */
const TINY_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

interface TxDto {
  id: string
  type: string
  status: string
  currency: string
  createdBy: string | null
  receiptDocumentId: string | null
  receiptExternalUrl: string | null
}

/** Resolve a seed user's id by email via the (already-authenticated) API. */
async function userIdByEmail(page: Page, email: string): Promise<string> {
  const res = await page.request.get(`${REAL_API}/users`)
  const users = (await res.json()) as Array<{ id: string; email: string }>
  const found = users.find((u) => u.email === email)
  if (!found) throw new Error(`Seed user not found: ${email}`)
  return found.id
}

/**
 * Find the FIRST transaction matching `predicate` from the full ADMIN-visible
 * list — used by the regression/attach tests to pick real (dynamic, non-
 * hardcoded) seed rows instead of baking in a specific id/amount.
 */
async function findTx(page: Page, predicate: (t: TxDto) => boolean): Promise<TxDto> {
  const res = await page.request.get(`${REAL_API}/transactions`)
  const all = (await res.json()) as TxDto[]
  const found = all.find(predicate)
  if (!found) throw new Error('No matching transaction found for predicate')
  return found
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. CREATE-BLOCK — mandatory receipt (missing → client-side block, no network)
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Transaction receipts — create-block без чека (mandatory)', () => {
  test('ADMIN_INCOME без чека → submit заблокирован (ADMIN)', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/finance')

    await page.getByTestId('finance-create-transaction-button').click()
    const dialog = page.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('create-transaction-type-admin_income').click()

    // ADMIN_INCOME requires a project — pick any (receipt is the only thing
    // deliberately left empty).
    await dialog.getByTestId('create-transaction-project-trigger').click()
    await page.getByRole('option').first().click()
    await dialog.getByPlaceholder('0.00').fill('123')

    await dialog.getByTestId('create-transaction-submit').click()
    await expect(dialog.getByTestId('create-transaction-error-receipt')).toBeVisible()
    await expect(dialog).toBeVisible() // still open — no network call fired
  })

  test('EXPENSE без чека → submit заблокирован (ADMIN)', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/finance')

    await page.getByTestId('finance-create-transaction-button').click()
    const dialog = page.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('create-transaction-type-expense').click()
    await dialog.getByPlaceholder('0.00').fill('50')

    await dialog.getByTestId('create-transaction-submit').click()
    await expect(dialog.getByTestId('create-transaction-error-receipt')).toBeVisible()
    await expect(dialog).toBeVisible()
  })

  test('ADMIN_TRANSFER без чека → submit заблокирован (ADMIN)', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/finance')

    await page.getByTestId('finance-create-transaction-button').click()
    const dialog = page.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('create-transaction-type-admin_transfer').click()
    // Sender/receiver auto-default to the two seed ADMIN partners — only the
    // amount + (deliberately empty) receipt need filling.
    await dialog.getByPlaceholder('0.00').fill('10')

    await dialog.getByTestId('create-transaction-submit').click()
    await expect(dialog.getByTestId('create-transaction-error-receipt')).toBeVisible()
    await expect(dialog).toBeVisible()
  })

  test('DIVIDEND без чека → submit заблокирован (ADMIN)', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/finance')

    await page.getByTestId('finance-create-transaction-button').click()
    const dialog = page.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('create-transaction-type-dividend').click()
    // Receiver defaults to self (the calling ADMIN) — only amount + receipt.
    await dialog.getByTestId('create-transaction-dividend-amount').fill('1')

    await dialog.getByTestId('create-transaction-submit').click()
    await expect(dialog.getByTestId('create-transaction-error-receipt')).toBeVisible()
    await expect(dialog).toBeVisible()
  })

  test('USDT-проект без чека → submit заблокирован (ADMIN)', async ({ page }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `receipts-usdt-block-${suffix}@cheekycheese.dev`
    const projectName = `Receipts USDT Block ${suffix}`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Receipts USDT Block ${suffix}`,
    })
    await onboardDropViaAPI(page, { dropId, dropEmail })
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await createDropProjectViaAPI(page, {
      dropId,
      seniorEmail: SEED_EMAILS.seniorA,
      name: projectName,
      paymentType: 'USDT',
    })

    try {
      await page.goto('/finance')
      await page.getByTestId('finance-create-transaction-button').click()
      const dialog = page.getByTestId('create-transaction-dialog')
      await expect(dialog).toBeVisible()
      // task-admin-income-unified: ADMIN_INCOME is the default/only
      // admin-income type — selecting a USDT-payment project is what routes
      // this submit to declareUsdtProjectIncome (explorer-only receipt).
      await dialog.getByTestId('create-transaction-project-trigger').click()
      await page.getByRole('option', { name: projectName, exact: true }).click()
      await dialog.getByTestId('admin-income-receiver-trigger').click()
      await page.getByRole('option', { name: 'Счёт компании', exact: true }).click()
      await dialog.getByPlaceholder('0.00').fill('100')

      // A USDT-payment project is ALWAYS explorer-only — the file tab must not even render.
      await expect(dialog.getByTestId('receipt-input-mode-file')).not.toBeAttached()

      await dialog.getByTestId('create-transaction-submit').click()
      await expect(dialog.getByTestId('create-transaction-error-receipt')).toBeVisible()
      await expect(dialog).toBeVisible()
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  test('DROP_INCOME без чека → submit заблокирован (DROP)', async ({ page }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `receipts-drop-block-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Receipts Drop Block ${suffix}`,
    })
    await onboardDropViaAPI(page, { dropId, dropEmail })
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await createDropProjectViaAPI(page, { dropId, seniorEmail: SEED_EMAILS.seniorA })

    try {
      await loginViaApi(page, dropEmail)
      await page.goto('/finance')
      await page.getByTestId('drop-register-income-btn').click()
      const dialog = page.getByTestId('create-transaction-dialog')
      await expect(dialog).toBeVisible()

      await dialog.getByTestId('create-transaction-project-trigger').click()
      await page.getByRole('option').first().click()
      await dialog.getByPlaceholder('0.00').fill('750')

      await dialog.getByTestId('create-transaction-submit').click()
      await expect(dialog.getByTestId('create-transaction-error-receipt')).toBeVisible()
      await expect(dialog).toBeVisible()
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  // A3: the SALARY create-time row is a NEUTRAL reminder (no money moves yet,
  // fundingSource=null) — the receipt is required later, at PAY time
  // (PaySalaryDialog), not here. `showReceipt` deliberately excludes SALARY,
  // so no receipt UI renders at all for this type.
  test('SALARY-reminder БЕЗ чека → создаётся (чек не требуется на создании)', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/finance')

    await page.getByTestId('finance-create-transaction-button').click()
    const dialog = page.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('create-transaction-type-salary').click()

    // Receiver select — pick the first eligible employee.
    await dialog.getByTestId('create-transaction-receiver-trigger').click()
    await page.getByRole('option').first().click()
    await dialog.getByPlaceholder('0.00').fill('900')
    // createSalary enforces one reminder per (receiver, month) — the dialog
    // defaults to last calendar month, which could collide with a prior test
    // run's reminder for whichever receiver happens to be "first" in the
    // list. Force a random far-future month so this test never collides with
    // itself or with any other spec/run.
    await dialog.getByTestId('create-transaction-salary-month').fill(randomSalaryMonth())

    // No receipt input at all for SALARY.
    await expect(dialog.getByTestId('receipt-input-url-field')).not.toBeAttached()

    await dialog.getByTestId('create-transaction-submit').click()
    await expect(dialog).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. CREATE с чеком (не-USDT) — file ИЛИ link → ok
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Transaction receipts — создание с чеком (не-USDT)', () => {
  test('ADMIN_INCOME с файлом-чеком → создаётся', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/finance')

    await page.getByTestId('finance-create-transaction-button').click()
    const dialog = page.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('create-transaction-type-admin_income').click()

    await dialog.getByTestId('create-transaction-project-trigger').click()
    await page.getByRole('option').first().click()
    // task-admin-income-unified (§2): ADMIN always picks an explicit receiver
    // for ADMIN_INCOME now — no silent default. Pick whichever active admin
    // sorts first (self is one of the options).
    await dialog.getByTestId('admin-income-receiver-trigger').click()
    await page.getByRole('option').first().click()
    await dialog.getByPlaceholder('0.00').fill('321')

    // Default receipt mode is 'file' — upload directly (no tab click needed).
    const uploadRes = page.waitForResponse(
      (r) => r.url().includes('/documents') && r.request().method() === 'POST',
    )
    await dialog
      .locator('input[type="file"]')
      .setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: TINY_PNG_BUFFER })
    await uploadRes

    await dialog.getByTestId('create-transaction-submit').click()
    await expect(dialog).not.toBeVisible()
  })

  test('EXPENSE со ссылкой-чеком → создаётся', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/finance')

    await page.getByTestId('finance-create-transaction-button').click()
    const dialog = page.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('create-transaction-type-expense').click()
    await dialog.getByPlaceholder('0.00').fill('75')

    await dialog.getByTestId('receipt-input-mode-url').click()
    await dialog.getByTestId('receipt-input-url-field').fill('https://drive.example.com/exp.pdf')

    await dialog.getByTestId('create-transaction-submit').click()
    await expect(dialog).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. USDT explorer-only
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Transaction receipts — USDT explorer-only', () => {
  test('USDT-проект: не-explorer ссылка → блок с явной ошибкой', async ({ page }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `receipts-usdt-badlink-${suffix}@cheekycheese.dev`
    const projectName = `Receipts USDT BadLink ${suffix}`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Receipts USDT BadLink ${suffix}`,
    })
    await onboardDropViaAPI(page, { dropId, dropEmail })
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await createDropProjectViaAPI(page, {
      dropId,
      seniorEmail: SEED_EMAILS.seniorA,
      name: projectName,
      paymentType: 'USDT',
    })

    try {
      await page.goto('/finance')
      await page.getByTestId('finance-create-transaction-button').click()
      const dialog = page.getByTestId('create-transaction-dialog')
      await expect(dialog).toBeVisible()
      // ADMIN_INCOME is the default/only admin-income type — the USDT-payment
      // project selection is what routes this submit to declareUsdtProjectIncome.
      await dialog.getByTestId('create-transaction-project-trigger').click()
      await page.getByRole('option', { name: projectName, exact: true }).click()
      await dialog.getByTestId('admin-income-receiver-trigger').click()
      await page.getByRole('option', { name: 'Счёт компании', exact: true }).click()
      await dialog.getByPlaceholder('0.00').fill('100')

      // Explorer hint is shown; the tab toggle is absent (already asserted in
      // the block test above) — here we exercise the NON-allowlist rejection.
      await expect(dialog.getByTestId('receipt-input-explorer-hint')).toBeVisible()
      await dialog.getByTestId('receipt-input-url-field').fill('https://example.com/tx/0xabc')

      await dialog.getByTestId('create-transaction-submit').click()
      await expect(dialog.getByTestId('create-transaction-error-receipt')).toContainText(
        /blockchain-explorer/i,
      )
      await expect(dialog).toBeVisible()
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })

  // Happy-path USDT-project-declaration-with-explorer-link is covered
  // end-to-end by drop-share-usdt-income.spec.ts (both receiver branches). DIVIDEND is the
  // other ALWAYS-explorer-only type in this dialog — exercised fresh here.
  test('DIVIDEND: file-режим недоступен, explorer-ссылка → создаётся', async ({ page }) => {
    // Self-contained balance top-up — DIVIDEND amount must not exceed the
    // company-account balance, and this test must not depend on side effects
    // left behind by other spec files/runs.
    const suffix = uniqueSuffix()
    const dropEmail = `receipts-dividend-${suffix}@cheekycheese.dev`
    const projectName = `Receipts Dividend Topup ${suffix}`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Receipts Dividend ${suffix}`,
    })
    await onboardDropViaAPI(page, { dropId, dropEmail })
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { projectId } = await createDropProjectViaAPI(page, {
      dropId,
      seniorEmail: SEED_EMAILS.seniorA,
      name: projectName,
      paymentType: 'USDT',
    })
    await declareUsdtIncomeViaAPI(page, {
      projectId,
      amount: 500,
      receiverId: 'COMPANY_ACCOUNT',
    })

    try {
      await page.goto('/finance')
      await page.getByTestId('finance-create-transaction-button').click()
      const dialog = page.getByTestId('create-transaction-dialog')
      await expect(dialog).toBeVisible()
      await dialog.getByTestId('create-transaction-type-dividend').click()

      // Always explorer-only — no file tab at all for DIVIDEND.
      await expect(dialog.getByTestId('receipt-input-mode-file')).not.toBeAttached()
      await expect(dialog.getByTestId('receipt-input-url-field')).toBeVisible()

      await dialog.getByTestId('create-transaction-dividend-amount').fill('1')
      await dialog
        .getByTestId('receipt-input-url-field')
        .fill('https://etherscan.io/tx/0xdividend0001')

      await dialog.getByTestId('create-transaction-submit').click()
      await expect(dialog).not.toBeVisible()
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. PAY / SETTLE — mandatory receipt (block only; "с чеком → ok" already
//    covered by finance.spec.ts PaySalaryDialog + drop-share-usdt-income.spec.ts
//    SettleSeniorPayoutDialog).
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Transaction receipts — pay/settle без чека → блок', () => {
  test('PaySalaryDialog: pay без чека → submit заблокирован', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)

    // Fresh PENDING SALARY reminder — freshest createdAt, guaranteed to be on
    // finance-page 1 (default sort = date desc) regardless of how much data
    // other specs/runs have accumulated.
    const receiverId = await userIdByEmail(page, SEED_EMAILS.juniorA)
    const createRes = await page.request.post(`${REAL_API}/transactions/salary`, {
      data: { receiverId, amount: 654, currency: 'USD', salaryMonth: randomSalaryMonth() },
    })
    expect(createRes.status()).toBeLessThan(300)
    const salaryTx = (await createRes.json()) as { id: string }

    await page.goto('/finance')
    const row = page.getByTestId(`tx-row-${salaryTx.id}`)
    await expect(row).toBeVisible()
    await row.getByTestId(`tx-row-pay-salary-${salaryTx.id}`).click()

    const dialog = page.getByTestId('pay-salary-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Отметить как оплачено' }).click()
    await expect(dialog.getByTestId('pay-salary-error-receipt')).toBeVisible()
    await expect(dialog).toBeVisible()
  })

  test('SettleSeniorPayoutDialog: settle без чека → submit заблокирован', async ({ page }) => {
    const suffix = uniqueSuffix()
    const dropEmail = `receipts-settle-block-${suffix}@cheekycheese.dev`

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const { dropId } = await createDropViaAPI(page, {
      email: dropEmail,
      displayName: `Receipts Settle Block ${suffix}`,
    })
    await onboardDropViaAPI(page, { dropId, dropEmail })
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await ensureCompanyWalletViaAPI(page)
    const { projectId } = await createDropProjectViaAPI(page, {
      dropId,
      seniorEmail: SEED_EMAILS.seniorA,
    })

    try {
      // Plant a fresh SENIOR_PENDING_PAYOUT via the same drop-income cascade
      // used elsewhere (pending-settlement.spec.ts `plantCompanyDebt`): drop
      // posts income (WITH a receipt — mandatory) → accountant validates →
      // drop pays → cascade books the company-owes-senior IOU.
      await loginViaApi(page, dropEmail)
      const { txId: incomeTxId } = await createDropIncomeViaAPI(page, { projectId, amount: 400 })

      await loginViaApi(page, SEED_EMAILS.accountant)
      const { payoutRequestId } = await validateTransactionViaAPI(page, incomeTxId)
      let prId = payoutRequestId
      if (!prId) {
        await loginViaApi(page, dropEmail)
        const created = await createPayoutRequestViaAPI(page, [incomeTxId])
        prId = created.payoutRequestId
      }

      await loginViaApi(page, dropEmail)
      await payPayoutRequestViaAPI(page, prId!)

      await loginViaApi(page, SEED_ADMIN_EMAIL)
      const txs = await listTransactionsByProjectViaAPI(page, projectId)
      const pendingPayout = txs.find(
        (t) => t.type === 'SENIOR_PENDING_PAYOUT' && t.status === 'PENDING_PAYMENT',
      )
      expect(pendingPayout, 'cascade must yield a SENIOR_PENDING_PAYOUT row').toBeTruthy()

      await page.goto('/finance')
      const row = page.getByTestId(`tx-row-${pendingPayout!.id}`)
      await expect(row).toBeVisible()
      await row.getByTestId(`tx-row-settle-senior-payout-${pendingPayout!.id}`).click()

      const dialog = page.getByTestId('settle-senior-dialog')
      await expect(dialog).toBeVisible()
      // Default account = «Счёт компании» (COMPANY_ACCOUNT, currency locked
      // USDT) — leave it, just try to submit without a receipt.
      await dialog.getByRole('button', { name: 'Отметить как оплачено' }).click()
      await expect(dialog.getByTestId('settle-senior-error-receipt')).toBeVisible()
      await expect(dialog).toBeVisible()
    } finally {
      await loginViaApi(page, SEED_ADMIN_EMAIL).catch(() => undefined)
      await cleanupDropViaAPI(page, dropId)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 5. ATTACH / REPLACE — RBAC + status matrix
//    (`PATCH /transactions/:id/receipt`, `canAttachReceipt`, `AttachReceiptSheet`)
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Transaction receipts — attach/replace (RBAC + статусы)', () => {
  test('UI: ADMIN прикрепляет чек через row-иконку, затем заменяет через confirm-диалог', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const receiverId = await userIdByEmail(page, SEED_EMAILS.hrA)
    const createRes = await page.request.post(`${REAL_API}/transactions/salary`, {
      data: { receiverId, amount: 500, currency: 'USD', salaryMonth: randomSalaryMonth() },
    })
    const salaryTx = (await createRes.json()) as { id: string }

    await page.goto('/finance')
    const row = page.getByTestId(`tx-row-${salaryTx.id}`)
    await expect(row).toBeVisible()

    // First attach — no confirm dialog (no existing receipt yet).
    await row.getByTestId(`tx-row-attach-receipt-${salaryTx.id}`).click()
    const sheet = page.getByTestId('attach-receipt-sheet')
    await expect(sheet).toBeVisible()
    await expect(sheet.getByText('Прикрепить чек')).toBeVisible()
    await sheet.getByTestId('receipt-input-mode-url').click()
    await sheet
      .getByTestId('receipt-input-url-field')
      .fill('https://drive.example.com/attach-1.pdf')
    await sheet.getByTestId('attach-receipt-sheet-submit').click()
    await expect(sheet).not.toBeVisible()
    await expect(page.getByText('Чек прикреплён')).toBeVisible()

    // Second click — now a REPLACE (existing receipt) → confirm dialog gate.
    await row.getByTestId(`tx-row-attach-receipt-${salaryTx.id}`).click()
    const sheet2 = page.getByTestId('attach-receipt-sheet')
    await expect(sheet2).toBeVisible()
    await expect(sheet2.getByText('Заменить чек')).toBeVisible()
    await sheet2.getByTestId('receipt-input-mode-url').click()
    await sheet2
      .getByTestId('receipt-input-url-field')
      .fill('https://drive.example.com/attach-2.pdf')
    await sheet2.getByTestId('attach-receipt-sheet-submit').click()

    const confirm = page.getByTestId('attach-receipt-confirm-replace')
    await expect(confirm).toBeVisible()
    await confirm.getByTestId('attach-receipt-confirm-submit').click()
    await expect(confirm).not.toBeVisible()
    await expect(page.getByText('Чек заменён')).toBeVisible()
  })

  // Note: `canAttachReceipt` allows the author on ANY non-PAID row regardless
  // of whether it already carries a receipt (`!hasReceipt || status !== 'PAID'`
  // — the OR is trivially true here since status !== 'PAID'). So this
  // deliberately does NOT restrict to receiptless rows — that would exhaust
  // the (finite, ~3) seed PENDING pool after a few `--repeat-each` runs and
  // make the test flaky. Any PENDING row the senior authored proves the rule.
  test('API: автор прикрепляет/заменяет чек на своей PENDING транзакции → ok', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const seniorAId = await userIdByEmail(page, SEED_EMAILS.seniorA)
    const target = await findTx(
      page,
      (t) => t.type === 'SENIOR_INCOME' && t.status === 'PENDING' && t.createdBy === seniorAId,
    )

    await loginViaApi(page, SEED_EMAILS.seniorA)
    const res = await page.request.patch(`${REAL_API}/transactions/${target.id}/receipt`, {
      data: { receiptExternalUrl: `https://etherscan.io/tx/0xauthorattach${uniqueSuffix()}` },
    })
    expect(res.status()).toBeLessThan(300)
    const body = (await res.json()) as { receiptExternalUrl: string | null }
    expect(body.receiptExternalUrl).toBeTruthy()
  })

  test('API: не-автор, не-ADMIN/ACCOUNTANT → 403', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const seniorAId = await userIdByEmail(page, SEED_EMAILS.seniorA)
    const target = await findTx(
      page,
      (t) => t.type === 'SENIOR_INCOME' && t.createdBy === seniorAId,
    )

    // A different SENIOR (seniorB) is neither the author nor privileged.
    await loginViaApi(page, SEED_EMAILS.seniorB)
    const res = await page.request.patch(`${REAL_API}/transactions/${target.id}/receipt`, {
      data: { receiptExternalUrl: 'https://etherscan.io/tx/0xshouldnotwork' },
    })
    expect(res.status()).toBe(403)
  })

  test('API: replace после PAID — автор 403, ADMIN/ACCOUNTANT ok', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const seniorAId = await userIdByEmail(page, SEED_EMAILS.seniorA)
    const target = await findTx(
      page,
      (t) => t.type === 'SENIOR_INCOME' && t.status === 'PAID' && t.createdBy === seniorAId,
    )

    // Force hasReceipt=true deterministically (idempotent across repeat runs —
    // this is what makes step 2 below always a genuine REPLACE, regardless of
    // whether a previous run already attached one).
    const forceRes = await page.request.patch(`${REAL_API}/transactions/${target.id}/receipt`, {
      data: { receiptExternalUrl: `https://etherscan.io/tx/0xforce${uniqueSuffix()}` },
    })
    expect(forceRes.status()).toBeLessThan(300)

    // Author tries to REPLACE a PAID + already-has-receipt row → 403.
    await loginViaApi(page, SEED_EMAILS.seniorA)
    const authorRes = await page.request.patch(`${REAL_API}/transactions/${target.id}/receipt`, {
      data: { receiptExternalUrl: 'https://etherscan.io/tx/0xauthorreplaceattempt' },
    })
    expect(authorRes.status()).toBe(403)

    // ACCOUNTANT (privileged) CAN replace it.
    await loginViaApi(page, SEED_EMAILS.accountant)
    const accountantRes = await page.request.patch(
      `${REAL_API}/transactions/${target.id}/receipt`,
      { data: { receiptExternalUrl: `https://etherscan.io/tx/0xaccountant${uniqueSuffix()}` } },
    )
    expect(accountantRes.status()).toBeLessThan(300)
  })

  test('API: attach к USDT-транзакции файлом → блок; explorer-ссылкой → ok', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const seniorAId = await userIdByEmail(page, SEED_EMAILS.seniorA)
    const projectsRes = await page.request.get(`${REAL_API}/projects`)
    const projects = (await projectsRes.json()) as Array<{ id: string; seniorId: string }>
    const ownProject = projects.find((p) => p.seniorId === seniorAId)
    if (!ownProject) throw new Error('Seed senior A has no project to post income on')

    await loginViaApi(page, SEED_EMAILS.seniorA)
    // Fresh USDT-currency SENIOR_INCOME (already has a receipt from creation —
    // the attach endpoint validates identically for attach AND replace, so
    // this exercises the currency-aware rule either way).
    const { txId } = await createSeniorIncomeViaAPI(page, {
      projectId: ownProject.id,
      amount: 200,
      currency: 'USDT',
    })

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    // File → rejected: currency-aware validation runs BEFORE the document-
    // ownership check, so a random (non-existent) uuid is enough to prove the
    // 400 comes from the USDT/explorer-only rule, not a 404 on the document.
    const fileRes = await page.request.patch(`${REAL_API}/transactions/${txId}/receipt`, {
      data: { receiptDocumentId: '11111111-1111-1111-1111-111111111111' },
    })
    expect(fileRes.status()).toBe(400)

    // Non-allowlisted link → also rejected.
    const badLinkRes = await page.request.patch(`${REAL_API}/transactions/${txId}/receipt`, {
      data: { receiptExternalUrl: 'https://example.com/not-an-explorer' },
    })
    expect(badLinkRes.status()).toBe(400)

    // Explorer link → ok.
    const okRes = await page.request.patch(`${REAL_API}/transactions/${txId}/receipt`, {
      data: { receiptExternalUrl: `https://etherscan.io/tx/0xattachusdt${uniqueSuffix()}` },
    })
    expect(okRes.status()).toBeLessThan(300)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 6. REGRESSION — history without a receipt keeps working
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Transaction receipts — регрессия истории', () => {
  test('Старая (сид) транзакция без чека читается через API без ошибки', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const old = await findTx(
      page,
      (t) =>
        t.type === 'SENIOR_INCOME' &&
        t.status === 'PAID' &&
        !t.receiptDocumentId &&
        !t.receiptExternalUrl,
    )
    const res = await page.request.get(`${REAL_API}/transactions/${old.id}`)
    expect(res.status()).toBe(200)
    const body = (await res.json()) as TxDto
    expect(body.receiptDocumentId).toBeNull()
    expect(body.receiptExternalUrl).toBeNull()
  })

  test('SALARY-reminder без чека открывается в деталях — пустое состояние, не ошибка', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    const receiverId = await userIdByEmail(page, SEED_EMAILS.hrB)
    const createRes = await page.request.post(`${REAL_API}/transactions/salary`, {
      data: { receiverId, amount: 111, currency: 'USD', salaryMonth: randomSalaryMonth() },
    })
    const salaryTx = (await createRes.json()) as { id: string }

    await page.goto('/finance')
    const row = page.getByTestId(`tx-row-${salaryTx.id}`)
    await expect(row).toBeVisible()
    await row.click()

    await expect(page.getByRole('heading', { name: /Детали транзакции/i })).toBeVisible()
    await expect(page.getByTestId('receipt-panel-empty')).toBeVisible()
    await expect(page.getByText('Нет прикреплённого чека')).toBeVisible()
    // Privileged viewer (ADMIN) + no receipt yet → the attach entry-point is
    // offered, proving the empty-state doesn't dead-end the flow.
    await expect(page.getByTestId('detail-attach-receipt')).toBeVisible()
  })
})
