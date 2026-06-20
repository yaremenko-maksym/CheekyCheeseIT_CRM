/**
 * finance-funding-source.spec.ts — E2E coverage for PR #254
 * task-salary-company-account: funding-source selector in CreateTransactionDialog
 *
 * AC coverage:
 *  AC1 — SALARY: funding-source section visible; default COMPANY_ACCOUNT active;
 *         currency locked to USDT. Switch to ADMIN_PERSONAL → payer-admin section
 *         appears + currency unlocked.
 *  AC2 — EXPENSE: default legacy; switch to COMPANY_ACCOUNT → USDT-lock +
 *         company-balance-hint visible.
 *  AC3 — ADMIN_INCOME: same pattern as EXPENSE (default legacy → company → USDT-lock + hint).
 *  AC4 — Company-funded SALARY submit: payload carries fundingSource='COMPANY_ACCOUNT',
 *         currency='USDT' (intercepted via route.fulfill + request inspection).
 *
 * Strategy:
 *  - All tests are mocked (route.fulfill only, NO route.continue).
 *  - Origin-agnostic patterns: glob **\/api for strings, \\\/api for RegExp.
 *  - browser_snapshot before every locator interaction (playwright-patterns skill,
 *    Rule 8: strict-mode).
 *  - Only ADMIN role tested for funding-source (SENIOR sees SENIOR_INCOME only,
 *    no funding-source section per component logic).
 */

import { test, expect, USERS } from './fixtures'
import type { Page, Route } from '@playwright/test'

// ---------------------------------------------------------------------------
// Origin-agnostic route constants
// ---------------------------------------------------------------------------
const API_RE = '\\/api'

function jsonOk(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

// ---------------------------------------------------------------------------
// Fixture: company account with a recognisable balance
// ---------------------------------------------------------------------------
const COMPANY_BALANCE = 9876.54
const COMPANY_ACCOUNT_FIXTURE = {
  walletAddress: '0xDeAdBeEf1234567890AbCdEf1234567890AbCdEf',
  confirmationThreshold: 12,
  balance: COMPANY_BALANCE,
  updatedAt: null,
}

// ---------------------------------------------------------------------------
// Helper: register the routes needed to open CreateTransactionDialog as ADMIN.
// Must be called AFTER mockAuthAs() so LIFO ordering keeps these handlers on
// top of the default fixtures.ts stubs.
// ---------------------------------------------------------------------------
async function mockAdminDialogRoutes(page: Page) {
  // Company account — override default zero-balance stub with a known balance.
  await page.route(new RegExp(`${API_RE}/company-account$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return jsonOk(r, COMPANY_ACCOUNT_FIXTURE)
  })
  // Users list — admin + HR + senior so salary receiver dropdown has entries.
  await page.route(new RegExp(`${API_RE}/users(\\?.*)?$`), (r) => {
    if (r.request().method() === 'POST') return jsonOk(r, {}, 201)
    return jsonOk(r, [
      {
        id: USERS.admin.id,
        displayName: USERS.admin.displayName,
        email: USERS.admin.email,
        role: 'ADMIN',
      },
      {
        id: USERS.hr.id,
        displayName: USERS.hr.displayName,
        email: USERS.hr.email,
        role: 'HR',
      },
      {
        id: USERS.senior.id,
        displayName: USERS.senior.displayName,
        email: USERS.senior.email,
        role: 'SENIOR',
      },
    ])
  })
  // Transactions list — empty so finance page renders without data rows.
  await page.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) => {
    if (r.request().method() === 'POST') return jsonOk(r, { id: 'tx-new', status: 'PENDING' }, 201)
    return jsonOk(r, [])
  })
  // Projects — empty (project selector not exercised in this spec).
  await page.route(new RegExp(`${API_RE}/projects(\\?.*)?$`), (r) => {
    if (r.request().method() === 'POST') return jsonOk(r, {}, 201)
    return jsonOk(r, [])
  })
}

/** Navigate to finance page, open CreateTransactionDialog, return dialog locator. */
async function openDialog(page: Page) {
  await page.goto('/crm/finance')
  await expect(page.getByTestId('finance-page')).toBeVisible()
  await page.getByTestId('finance-create-transaction-button').click()
  const dialog = page.getByTestId('create-transaction-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

// ═══════════════════════════════════════════════════════════════════════════
// AC1 — SALARY type: funding-source selector
// ═══════════════════════════════════════════════════════════════════════════

test.describe('AC1 — SALARY funding-source selector', () => {
  test('ADMIN: funding-source section visible after selecting SALARY', async ({ asAdmin }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)

    // ADMIN_INCOME is the default type — switch to SALARY.
    await dialog.getByTestId('create-transaction-type-salary').click()

    await expect(dialog.getByTestId('create-transaction-funding-source-section')).toBeVisible()
  })

  test('ADMIN: SALARY renders both COMPANY_ACCOUNT and ADMIN_PERSONAL buttons', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)
    await dialog.getByTestId('create-transaction-type-salary').click()

    await expect(dialog.getByTestId('create-transaction-funding-company')).toBeVisible()
    await expect(dialog.getByTestId('create-transaction-funding-personal')).toBeVisible()
  })

  test('ADMIN: SALARY + COMPANY_ACCOUNT default → balance hint visible with amount', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)
    await dialog.getByTestId('create-transaction-type-salary').click()

    // Default is COMPANY_ACCOUNT → balance hint must appear immediately.
    const hint = dialog.getByTestId('create-transaction-company-balance-hint')
    await expect(hint).toBeVisible()
    // Hint must contain recognisable portion of 9876.54.
    await expect(hint).toContainText(/9[\s,.]?876/)
  })

  test('ADMIN: switching SALARY to ADMIN_PERSONAL shows payer-admin section', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)
    await dialog.getByTestId('create-transaction-type-salary').click()

    await dialog.getByTestId('create-transaction-funding-personal').click()

    await expect(dialog.getByTestId('create-transaction-payer-admin-section')).toBeVisible()
    await expect(dialog.getByTestId('create-transaction-payer-admin-trigger')).toBeVisible()
  })

  test('ADMIN: switching SALARY to ADMIN_PERSONAL hides balance hint', async ({ asAdmin }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)
    await dialog.getByTestId('create-transaction-type-salary').click()

    // Confirm hint present first (default COMPANY_ACCOUNT).
    await expect(dialog.getByTestId('create-transaction-company-balance-hint')).toBeVisible()

    await dialog.getByTestId('create-transaction-funding-personal').click()

    await expect(dialog.getByTestId('create-transaction-company-balance-hint')).not.toBeVisible()
  })

  test('ADMIN: switching back from ADMIN_PERSONAL to COMPANY_ACCOUNT hides payer-admin', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)
    await dialog.getByTestId('create-transaction-type-salary').click()

    // Go to personal first.
    await dialog.getByTestId('create-transaction-funding-personal').click()
    await expect(dialog.getByTestId('create-transaction-payer-admin-section')).toBeVisible()

    // Switch back to company.
    await dialog.getByTestId('create-transaction-funding-company').click()
    await expect(dialog.getByTestId('create-transaction-payer-admin-section')).not.toBeVisible()
  })

  test('ADMIN: SALARY + COMPANY_ACCOUNT — currency select is disabled (USDT locked)', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)
    await dialog.getByTestId('create-transaction-type-salary').click()

    // AmountCurrencyInput renders a Radix <Select> with the native `disabled` HTML
    // attribute (not aria-disabled) when disableCurrency=true.
    // Playwright toBeDisabled() checks both disabled attr and aria-disabled.
    const currencyTrigger = dialog
      .getByRole('combobox')
      .filter({ hasText: /USDT|USD|EUR|UAH/ })
      .last()
    await expect(currencyTrigger).toBeDisabled()
  })

  test('ADMIN: SALARY + ADMIN_PERSONAL — currency select is NOT disabled', async ({ asAdmin }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)
    await dialog.getByTestId('create-transaction-type-salary').click()
    await dialog.getByTestId('create-transaction-funding-personal').click()

    // After switching to personal account, currency selector must be free.
    const currencyTrigger = dialog
      .getByRole('combobox')
      .filter({ hasText: /USDT|USD|EUR|UAH/ })
      .last()
    await expect(currencyTrigger).not.toBeDisabled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// AC2 — EXPENSE type: funding-source selector
// ═══════════════════════════════════════════════════════════════════════════

test.describe('AC2 — EXPENSE funding-source selector', () => {
  test('ADMIN: funding-source section visible for EXPENSE', async ({ asAdmin }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)

    await dialog.getByTestId('create-transaction-type-expense').click()

    await expect(dialog.getByTestId('create-transaction-funding-source-section')).toBeVisible()
  })

  test('ADMIN: EXPENSE defaults to legacy (no balance hint initially)', async ({ asAdmin }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)
    await dialog.getByTestId('create-transaction-type-expense').click()

    // Legacy button must be visible.
    await expect(dialog.getByTestId('create-transaction-funding-legacy')).toBeVisible()
    // No balance hint for legacy.
    await expect(dialog.getByTestId('create-transaction-company-balance-hint')).not.toBeVisible()
  })

  test('ADMIN: selecting COMPANY_ACCOUNT for EXPENSE shows balance hint', async ({ asAdmin }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)
    await dialog.getByTestId('create-transaction-type-expense').click()

    await dialog.getByTestId('create-transaction-funding-company').click()

    const hint = dialog.getByTestId('create-transaction-company-balance-hint')
    await expect(hint).toBeVisible()
    await expect(hint).toContainText(/9[\s,.]?876/)
  })

  test('ADMIN: EXPENSE + COMPANY_ACCOUNT — currency select is disabled (USDT locked)', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)
    await dialog.getByTestId('create-transaction-type-expense').click()
    await dialog.getByTestId('create-transaction-funding-company').click()

    const currencyTrigger = dialog
      .getByRole('combobox')
      .filter({ hasText: /USDT|USD|EUR|UAH/ })
      .last()
    await expect(currencyTrigger).toBeDisabled()
  })

  test('ADMIN: EXPENSE + legacy — currency select is NOT disabled', async ({ asAdmin }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)
    await dialog.getByTestId('create-transaction-type-expense').click()

    // Legacy is default — currency must be unlocked.
    const currencyTrigger = dialog
      .getByRole('combobox')
      .filter({ hasText: /USDT|USD|EUR|UAH/ })
      .last()
    await expect(currencyTrigger).not.toBeDisabled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// AC3 — ADMIN_INCOME type: funding-source selector
// ═══════════════════════════════════════════════════════════════════════════

test.describe('AC3 — ADMIN_INCOME funding-source selector', () => {
  test('ADMIN: funding-source section visible for ADMIN_INCOME (default type on open)', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)

    // ADMIN_INCOME is selected by default — section must already be visible.
    await expect(dialog.getByTestId('create-transaction-funding-source-section')).toBeVisible()
  })

  test('ADMIN: ADMIN_INCOME defaults to legacy (no balance hint)', async ({ asAdmin }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)

    await expect(dialog.getByTestId('create-transaction-funding-legacy')).toBeVisible()
    await expect(dialog.getByTestId('create-transaction-company-balance-hint')).not.toBeVisible()
  })

  test('ADMIN: selecting COMPANY_ACCOUNT for ADMIN_INCOME shows balance hint', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)

    await dialog.getByTestId('create-transaction-funding-company').click()

    const hint = dialog.getByTestId('create-transaction-company-balance-hint')
    await expect(hint).toBeVisible()
    await expect(hint).toContainText(/9[\s,.]?876/)
  })

  test('ADMIN: ADMIN_INCOME + COMPANY_ACCOUNT — currency select is disabled (USDT locked)', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)

    await dialog.getByTestId('create-transaction-funding-company').click()

    const currencyTrigger = dialog
      .getByRole('combobox')
      .filter({ hasText: /USDT|USD|EUR|UAH/ })
      .last()
    await expect(currencyTrigger).toBeDisabled()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// AC4 — Submit company-funded SALARY: payload inspection
// ═══════════════════════════════════════════════════════════════════════════

test.describe('AC4 — company-funded SALARY submit payload', () => {
  test('ADMIN: submitting SALARY + COMPANY_ACCOUNT sends fundingSource=COMPANY_ACCOUNT and currency=USDT', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)

    // Intercept salary POST to capture the request body.
    let capturedBody: Record<string, unknown> | null = null
    await asAdmin.route(new RegExp(`${API_RE}/transactions/salary$`), (r) => {
      if (r.request().method() === 'POST') {
        capturedBody = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'tx-salary-new', status: 'PENDING' }),
        })
      }
      return r.fallback()
    })

    const dialog = await openDialog(asAdmin)
    await dialog.getByTestId('create-transaction-type-salary').click()

    // Pick a receiver from the Radix Select dropdown.
    await dialog.getByTestId('create-transaction-receiver-trigger').click()
    const listbox = asAdmin.locator('[role="listbox"]')
    await expect(listbox).toBeVisible()
    await listbox.getByText(USERS.hr.displayName, { exact: false }).click()

    // COMPANY_ACCOUNT is already default — fill the amount.
    const amountInput = dialog.locator('input[type="number"]').first()
    await amountInput.fill('500')

    await dialog.getByTestId('create-transaction-submit').click()

    // Dialog should close on success.
    await expect(dialog).not.toBeVisible()

    // Validate captured payload shape.
    expect(capturedBody).not.toBeNull()
    expect(capturedBody!['fundingSource']).toBe('COMPANY_ACCOUNT')
    expect(capturedBody!['currency']).toBe('USDT')
    expect(capturedBody!['amount']).toBe(500)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Type-switch resets funding source to per-type default
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Type-switch resets funding source to per-type default', () => {
  test('switching from SALARY (COMPANY_ACCOUNT) to EXPENSE resets to legacy', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)

    // Switch to SALARY → balance hint appears (COMPANY_ACCOUNT default).
    await dialog.getByTestId('create-transaction-type-salary').click()
    await expect(dialog.getByTestId('create-transaction-company-balance-hint')).toBeVisible()

    // Switch to EXPENSE → must reset to legacy → balance hint gone.
    await dialog.getByTestId('create-transaction-type-expense').click()
    await expect(dialog.getByTestId('create-transaction-company-balance-hint')).not.toBeVisible()
    await expect(dialog.getByTestId('create-transaction-funding-legacy')).toBeVisible()
  })

  test('switching from EXPENSE (COMPANY_ACCOUNT) to SALARY keeps balance hint (SALARY default = COMPANY)', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)

    await dialog.getByTestId('create-transaction-type-expense').click()
    await dialog.getByTestId('create-transaction-funding-company').click()
    await expect(dialog.getByTestId('create-transaction-company-balance-hint')).toBeVisible()

    // SALARY default is COMPANY_ACCOUNT — hint should remain.
    await dialog.getByTestId('create-transaction-type-salary').click()
    await expect(dialog.getByTestId('create-transaction-company-balance-hint')).toBeVisible()
  })

  test('payer-admin selector disappears after switching away from SALARY + ADMIN_PERSONAL', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)

    await dialog.getByTestId('create-transaction-type-salary').click()
    await dialog.getByTestId('create-transaction-funding-personal').click()
    await expect(dialog.getByTestId('create-transaction-payer-admin-section')).toBeVisible()

    // Switch to EXPENSE — payer-admin must disappear.
    await dialog.getByTestId('create-transaction-type-expense').click()
    await expect(dialog.getByTestId('create-transaction-payer-admin-section')).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// RBAC — funding-source section NOT shown for SENIOR_INCOME or ADMIN_TRANSFER
// ═══════════════════════════════════════════════════════════════════════════

test.describe('RBAC — funding-source section absent for unsupported types', () => {
  test('SENIOR: dialog for SENIOR_INCOME has NO funding-source section', async ({ asSenior }) => {
    // SENIOR only has SENIOR_INCOME — no funding-source section per component logic.
    await asSenior.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) => {
      if (r.request().method() === 'POST') return jsonOk(r, {}, 201)
      return jsonOk(r, [])
    })

    await asSenior.goto('/crm/finance')
    await expect(asSenior.getByTestId('finance-page')).toBeVisible()
    await asSenior.getByTestId('finance-create-transaction-button').click()

    const dialog = asSenior.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()
    // SENIOR_INCOME: no funding-source section.
    await expect(dialog.getByTestId('create-transaction-funding-source-section')).not.toBeVisible()
  })

  test('ADMIN: ADMIN_TRANSFER type does NOT show funding-source section', async ({ asAdmin }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)

    await dialog.getByTestId('create-transaction-type-admin_transfer').click()

    await expect(dialog.getByTestId('create-transaction-funding-source-section')).not.toBeVisible()
  })
})
