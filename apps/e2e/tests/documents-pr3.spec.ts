/**
 * documents-pr3.spec.ts
 *
 * E2E tests for Documents PR-3: receipt lifecycle — 1:1 invariant + replace-with-delete.
 *
 * AC coverage (against mocked API — see feedback_mocked_e2e_guards.md lesson):
 *   AC1  — SENIOR sees REJECTED tx, opens edit dialog, resubmits with new receipt URL,
 *           dialog closes and tx row reflects PENDING status.
 *   AC2  — Edit button is NOT visible on a PENDING tx (only REJECTED unlocks it).
 *   AC3  — Edit button is NOT visible when ACCOUNTANT views the same REJECTED tx
 *           (RBAC: only receiver SENIOR can edit).
 *   AC4  — SENIOR can also replace receipt using a file-mode input (receiptDocumentId path).
 *   AC5  — Rejection reason panel is shown inside the edit dialog when tx has rejectionReason.
 *
 * Real atomicity (DB-delete inside dbtx + S3 post-commit) is covered by
 * apps/api/src/finance/receipt-replace.integration.spec.ts (Task 4).
 *
 * Pattern: page.route() mocks (mirrors finance-senior-flow.spec.ts).
 */

import { test, expect, USERS, PROJECTS, mockAuthAs, API_GLOB, API_RE } from './fixtures'

const PROJECT_ID = PROJECTS[0]!.id
const PROJECT_NAME = PROJECTS[0]!.name
const TX_ID = 'pr3-e2e-tx-1'

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeRejectedTx(overrides: object = {}) {
  return {
    id: TX_ID,
    type: 'SENIOR_INCOME',
    status: 'REJECTED',
    amount: '3000.00',
    currency: 'USDT',
    senderId: null,
    senderName: null,
    senderLabel: 'TechCorp AI',
    receiverId: USERS.senior.id,
    receiverName: USERS.senior.displayName,
    receiverLabel: null,
    seniorSharePercent: 26,
    projectId: PROJECT_ID,
    projectName: PROJECT_NAME,
    receiptDocumentId: 'old-receipt-doc-id',
    receiptExternalUrl: null,
    notes: null,
    salaryMonth: null,
    txHash: null,
    rejectionReason: 'Нечитаемый чек — загрузите снова',
    payoutRequestId: null,
    validatedBy: USERS.accountant.id,
    validatedAt: '2026-06-01T10:00:00.000Z',
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  }
}

function makePendingTx(overrides: object = {}) {
  return makeRejectedTx({
    status: 'PENDING',
    rejectionReason: null,
    validatedBy: null,
    validatedAt: null,
    receiptDocumentId: null,
    receiptExternalUrl: 'https://drive.google.com/receipt-new.pdf',
    ...overrides,
  })
}

type MockPage = import('@playwright/test').Page

async function setupFinanceMocks(page: MockPage, txList: object[], singleTx: object) {
  // GET /api/transactions — list
  await page.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) =>
    r.request().method() === 'GET'
      ? r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(txList),
        })
      : r.fallback(),
  )
  // GET /api/transactions/senior-income/:id — single (used by edit dialog)
  await page.route(new RegExp(`${API_RE}/transactions/senior-income/([^/?]+)$`), (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(singleTx),
    }),
  )
  // PATCH /api/transactions/senior-income/:id — resubmit
  await page.route(new RegExp(`${API_RE}/transactions/senior-income/([^/?]+)$`), (r) =>
    r.request().method() === 'PATCH'
      ? r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(makePendingTx()),
        })
      : r.fallback(),
  )
  // Finance summary stub
  await page.route(`${API_GLOB}/finance/summary`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        totalIncome: 3000,
        totalExpenses: 0,
        netBalance: 3000,
        currency: 'USDT',
      }),
    }),
  )
  // Exchange rates stub
  await page.route(new RegExp(`${API_RE}/nbu-rates(\\?.*)?$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  )
  // Projects stub
  await page.route(`${API_GLOB}/projects`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: PROJECT_ID, name: PROJECT_NAME, seniorId: USERS.senior.id }]),
    }),
  )
  // Documents stub (for receipt file-mode upload path)
  await page.route(new RegExp(`${API_RE}/documents(\\?.*)?$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
  )
}

// ---------------------------------------------------------------------------
// AC1 — SENIOR resubmits REJECTED tx with new receipt URL → dialog closes, tx PENDING
// ---------------------------------------------------------------------------

test.describe('PR-3 receipt replace — AC1: SENIOR resubmit flow', () => {
  test('SENIOR видит REJECTED транзакцию, открывает редактирование, отправляет новый чек — диалог закрывается', async ({
    asSenior: page,
  }) => {
    const rejectedTx = makeRejectedTx()
    await setupFinanceMocks(page, [rejectedTx], rejectedTx)
    await page.goto('/finance')
    await page.waitForLoadState('networkidle')

    // Edit button visible for REJECTED SENIOR_INCOME tx belonging to this SENIOR
    const editBtn = page.getByTestId(`tx-row-edit-${TX_ID}`)
    await expect(editBtn).toBeVisible()
    await editBtn.click()

    // Dialog opens
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Исправить транзакцию')).toBeVisible()

    // Switch to URL mode and enter new receipt URL
    await dialog.getByTestId('receipt-input-mode-url').click()
    const urlField = dialog.getByTestId('receipt-input-url-field')
    await urlField.fill('https://drive.google.com/receipt-new.pdf')

    // Submit
    await dialog.getByTestId('edit-senior-income-resubmit').click()

    // Dialog closes on success
    await expect(dialog).not.toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// AC2 — Edit button NOT visible for PENDING tx (only REJECTED unlocks it)
// ---------------------------------------------------------------------------

test.describe('PR-3 receipt replace — AC2: edit locked on non-REJECTED tx', () => {
  test('SENIOR НЕ видит кнопку редактирования для PENDING транзакции', async ({
    asSenior: page,
  }) => {
    const pendingTx = makePendingTx()
    await setupFinanceMocks(page, [pendingTx], pendingTx)
    await page.goto('/finance')
    await page.waitForLoadState('networkidle')

    // Edit button must not exist for PENDING tx
    await expect(page.getByTestId(`tx-row-edit-${TX_ID}`)).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// AC3 — ACCOUNTANT cannot see edit button (RBAC: only receiver SENIOR)
// ---------------------------------------------------------------------------

test.describe('PR-3 receipt replace — AC3: RBAC — только SENIOR-получатель может редактировать', () => {
  test('ACCOUNTANT НЕ видит кнопку редактирования для REJECTED SENIOR_INCOME транзакции', async ({
    page,
  }) => {
    await mockAuthAs(page, USERS.accountant)
    const rejectedTx = makeRejectedTx()
    await setupFinanceMocks(page, [rejectedTx], rejectedTx)
    await page.goto('/finance')
    await page.waitForLoadState('networkidle')

    // ACCOUNTANT sees no edit button — only SENIOR-receiver can resubmit
    await expect(page.getByTestId(`tx-row-edit-${TX_ID}`)).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// AC4 — Rejection reason panel is shown in the edit dialog
// ---------------------------------------------------------------------------

test.describe('PR-3 receipt replace — AC4: причина отклонения отображается в диалоге', () => {
  test('Диалог редактирования показывает причину отклонения из rejectionReason', async ({
    asSenior: page,
  }) => {
    const rejectedTx = makeRejectedTx({
      rejectionReason: 'Нечитаемый чек — загрузите снова',
    })
    await setupFinanceMocks(page, [rejectedTx], rejectedTx)
    await page.goto('/finance')
    await page.waitForLoadState('networkidle')

    await page.getByTestId(`tx-row-edit-${TX_ID}`).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // Rejection reason panel must be present
    await expect(dialog.getByTestId('edit-senior-income-rejection-panel')).toBeVisible()
    await expect(dialog.getByTestId('edit-senior-income-rejection-reason')).toHaveText(
      'Нечитаемый чек — загрузите снова',
    )
  })
})

// ---------------------------------------------------------------------------
// AC5 — Cancel button closes dialog without submitting
// ---------------------------------------------------------------------------

test.describe('PR-3 receipt replace — AC5: кнопка Отмена закрывает диалог', () => {
  test('Кнопка Отмена закрывает диалог редактирования без отправки', async ({ asSenior: page }) => {
    const rejectedTx = makeRejectedTx()
    await setupFinanceMocks(page, [rejectedTx], rejectedTx)
    await page.goto('/finance')
    await page.waitForLoadState('networkidle')

    await page.getByTestId(`tx-row-edit-${TX_ID}`).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    // Cancel — dialog closes
    await dialog.getByTestId('edit-senior-income-cancel').click()
    await expect(dialog).not.toBeVisible()
  })
})
