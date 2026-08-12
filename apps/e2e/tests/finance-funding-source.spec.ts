/**
 * finance-funding-source.spec.ts — E2E coverage for the funding-source selector
 * in CreateTransactionDialog. Reworked for task-salary-pay-flow: SALARY no longer
 * has a funding selector at creation (the source + currency are chosen at pay
 * time, in PaySalaryDialog). EXPENSE keeps the original binary toggle.
 *
 * task-admin-income-unified (2026-08-12, §2): ADMIN_INCOME's toggle is GONE for
 * ADMIN — replaced by the flat "Счёт получателя" receiver Select
 * (`admin-income-receiver-trigger`, any active admin + «Счёт компании»).
 * ACCOUNTANT keeps a toggle-shaped selector (same `fundingSource` state/markup
 * EXPENSE uses) since the server denies them a specific-admin choice (AC10).
 *
 * AC coverage:
 *  AC5 — SALARY: NO funding-source section (neutral PENDING reminder); the salary
 *         POST payload carries NO fundingSource / payerAdminId.
 *  AC2 — EXPENSE: default legacy; switch to COMPANY_ACCOUNT → USDT-lock +
 *         company-balance-hint visible.
 *  AC3 — ADMIN_INCOME: ADMIN gets the flat receiver Select (not the toggle);
 *         ACCOUNTANT gets the toggle (default legacy → company → USDT-lock + hint).
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
  await page.goto('/finance')
  await expect(page.getByTestId('finance-page')).toBeVisible()
  await page.getByTestId('finance-create-transaction-button').click()
  const dialog = page.getByTestId('create-transaction-dialog')
  await expect(dialog).toBeVisible()
  return dialog
}

// ═══════════════════════════════════════════════════════════════════════════
// AC5 — SALARY: no funding-source section (funding chosen at pay time)
// ═══════════════════════════════════════════════════════════════════════════

test.describe('AC5 — SALARY has NO funding-source selector', () => {
  test('ADMIN: SALARY does NOT show the funding-source section', async ({ asAdmin }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)

    // ADMIN_INCOME is the default type — switch to SALARY.
    await dialog.getByTestId('create-transaction-type-salary').click()

    await expect(dialog.getByTestId('create-transaction-funding-source-section')).not.toBeVisible()
  })

  test('ADMIN: SALARY shows no company balance hint and no payer-admin section', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)
    await dialog.getByTestId('create-transaction-type-salary').click()

    await expect(dialog.getByTestId('create-transaction-company-balance-hint')).not.toBeVisible()
    await expect(dialog.getByTestId('create-transaction-payer-admin-section')).not.toBeVisible()
    await expect(dialog.getByTestId('create-transaction-funding-personal')).not.toBeVisible()
  })

  test('ADMIN: submitting SALARY sends NO fundingSource / payerAdminId (neutral reminder)', async ({
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

    // AmountCurrencyInput (task-mobile-keyboards.md: type="text" +
    // inputMode="decimal", not type="number" — target by its stable testid).
    const amountInput = dialog.getByTestId('amount-currency-amount-input')
    await amountInput.fill('500')

    await dialog.getByTestId('create-transaction-submit').click()
    await expect(dialog).not.toBeVisible()

    // Payload is a neutral reminder — no funding source / payer at creation.
    expect(capturedBody).not.toBeNull()
    expect(capturedBody!['fundingSource']).toBeUndefined()
    expect(capturedBody!['payerAdminId']).toBeUndefined()
    expect(capturedBody!['amount']).toBe(500)
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
// AC3 (task-admin-income-unified successor) — ADMIN_INCOME "Счёт получателя"
// ═══════════════════════════════════════════════════════════════════════════

test.describe('AC3 — ADMIN_INCOME "Счёт получателя" (task-admin-income-unified §2)', () => {
  test('ADMIN: flat receiver Select visible (default type on open), NOT the toggle section', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)

    // ADMIN_INCOME is selected by default — the flat Select must already be visible.
    await expect(dialog.getByTestId('admin-income-receiver-trigger')).toBeVisible()
    await expect(dialog.getByTestId('create-transaction-funding-source-section')).not.toBeVisible()
  })

  test('ADMIN: no balance hint before a receiver is chosen', async ({ asAdmin }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)

    await expect(dialog.getByTestId('create-transaction-company-balance-hint')).not.toBeVisible()
  })

  test('ADMIN: selecting «Счёт компании» in the receiver Select shows the balance hint', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)

    await dialog.getByTestId('admin-income-receiver-trigger').click()
    const listbox = asAdmin.locator('[role="listbox"]')
    await expect(listbox).toBeVisible()
    await listbox.getByRole('option', { name: 'Счёт компании' }).click()

    const hint = dialog.getByTestId('create-transaction-company-balance-hint')
    await expect(hint).toBeVisible()
    await expect(hint).toContainText(/9[\s,.]?876/)
  })

  test('ADMIN: ADMIN_INCOME + «Счёт компании» — currency select is disabled (USDT locked)', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)

    await dialog.getByTestId('admin-income-receiver-trigger').click()
    const listbox = asAdmin.locator('[role="listbox"]')
    await expect(listbox).toBeVisible()
    await listbox.getByRole('option', { name: 'Счёт компании' }).click()

    const currencyTrigger = dialog
      .getByRole('combobox')
      .filter({ hasText: /USDT|USD|EUR|UAH/ })
      .last()
    await expect(currencyTrigger).toBeDisabled()
  })

  // AC10: the accountant has never been a router of funds — the server
  // hard-credits the project's admin owner for this role. The interface
  // reflects that by keeping the OLD toggle-shaped selector (project owner /
  // «Счёт компании» only), never the flat any-admin Select.
  test('ACCOUNTANT: constrained "Счёт получателя" toggle visible, NOT the flat admin Select (AC10)', async ({
    asAccountant,
  }) => {
    await mockAdminDialogRoutes(asAccountant)
    const dialog = await openDialog(asAccountant)

    await expect(dialog.getByTestId('create-transaction-type-admin_income')).toBeVisible()
    await expect(dialog.getByTestId('admin-income-receiver-trigger')).not.toBeVisible()
    await expect(dialog.getByTestId('create-transaction-funding-source-section')).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Type-switch: SALARY hides the section, EXPENSE/ADMIN_INCOME reset to legacy
// ═══════════════════════════════════════════════════════════════════════════

test.describe('Type-switch resets funding source to per-type default', () => {
  test('switching from EXPENSE (COMPANY_ACCOUNT) to SALARY hides the section entirely', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)

    await dialog.getByTestId('create-transaction-type-expense').click()
    await dialog.getByTestId('create-transaction-funding-company').click()
    await expect(dialog.getByTestId('create-transaction-company-balance-hint')).toBeVisible()

    // Switch to SALARY → funding section disappears (chosen at pay time).
    await dialog.getByTestId('create-transaction-type-salary').click()
    await expect(dialog.getByTestId('create-transaction-funding-source-section')).not.toBeVisible()
  })

  test('switching from SALARY to EXPENSE shows the legacy default (no hint)', async ({
    asAdmin,
  }) => {
    await mockAdminDialogRoutes(asAdmin)
    const dialog = await openDialog(asAdmin)

    await dialog.getByTestId('create-transaction-type-salary').click()
    await expect(dialog.getByTestId('create-transaction-funding-source-section')).not.toBeVisible()

    // Switch to EXPENSE → section back, legacy default (no hint).
    await dialog.getByTestId('create-transaction-type-expense').click()
    await expect(dialog.getByTestId('create-transaction-funding-source-section')).toBeVisible()
    await expect(dialog.getByTestId('create-transaction-company-balance-hint')).not.toBeVisible()
    await expect(dialog.getByTestId('create-transaction-funding-legacy')).toBeVisible()
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

    await asSenior.goto('/finance')
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
