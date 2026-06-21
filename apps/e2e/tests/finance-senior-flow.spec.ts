/**
 * Полный сквозной флоу прихода синьора:
 *
 * 1.  SENIOR регистрирует приход (SENIOR_INCOME → PENDING)
 *     ВАЖНО: SENIOR_INCOME ТРЕБУЕТ чек (receiptDocumentId или receiptExternalUrl) — мутация в CreateTransactionDialog
 *     бросает "Прикрепите чек или укажите ссылку на подтверждение" если URL пустой.
 * 2a. ACCOUNTANT отклоняет транзакцию (→ REJECTED)
 * 2b. SENIOR видит причину отклонения и исправляет (→ PENDING снова)
 * 3.  ACCOUNTANT принимает транзакцию (→ VALIDATED)
 * 4.  SENIOR создаёт запрос выплаты (payout-request → PENDING)
 * 5.  SENIOR оплачивает выплату с TX hash (payout-request → PAID)
 */

import { test, expect, USERS, PROJECTS, mockAuthAs } from './fixtures'

// Origin-agnostic patterns — Playwright intercepts at the browser layer
// (http://localhost:3000/api/*). Using '**/api' glob for string routes and
// '\\/api' path segment for RegExp routes matches regardless of host/port.
const API = '**/api'
const API_RE = '\\/api'
const PROJECT_ID = PROJECTS[0]!.id
const PROJECT_NAME = PROJECTS[0]!.name

// ─── Стейт-машина транзакции ─────────────────────────────────────────────────

function makeTx(overrides: object = {}) {
  // SENIOR_INCOME shape mirrors what the real backend returns (see
  // transactions.service.ts createSeniorIncome):
  //   sender_id = NULL          (client company is a label only)
  //   sender_label = "TechCorp" (the client)
  //   receiver_id = senior.id   (the senior who registered the income)
  //   created_by  = senior.id
  // The earlier mock used senderId = senior.id which silently masked the
  // production bug where the «Оплатить» button filter scoped by senderId.
  return {
    id: 'flow-tx-1',
    type: 'SENIOR_INCOME',
    status: 'PENDING',
    amount: '5000.00',
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
    receiptDocumentId: null,
    receiptExternalUrl: null,
    notes: null,
    salaryMonth: null,
    txHash: null,
    rejectionReason: null,
    payoutRequestId: null,
    validatedBy: null,
    validatedAt: null,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  }
}

// Stable stub contract address shared across mocks so PayoutDetailDialog
// shows a deterministic value when the test asserts on it.
const FLOW_STUB_CONTRACT = '0x1234567890abcdef1234567890abcdef12345678'

function makePayoutRequest(overrides: object = {}) {
  return {
    id: 'flow-payout-1',
    seniorId: USERS.senior.id,
    seniorName: USERS.senior.displayName,
    incomeAmount: '5000.00',
    payableAmount: '3700.00',
    contractAddress: FLOW_STUB_CONTRACT,
    status: 'PENDING',
    txHash: null,
    transactions: [makeTx({ status: 'VALIDATED', payoutRequestId: 'flow-payout-1' })],
    createdAt: '2026-05-02T12:00:00.000Z',
    updatedAt: '2026-05-02T12:00:00.000Z',
    ...overrides,
  }
}

// ─── Вспомогательные моки ────────────────────────────────────────────────────

type MockPage = import('@playwright/test').Page

async function setupTransactionMocks(
  page: MockPage,
  tx: object,
  payoutReqs: object[] = [],
  // When provided, list endpoint returns this set instead of just `[tx]`.
  // Used by the new-flow tests that need both the SENIOR_INCOME and the
  // auto-created PAYOUT row visible in the same table.
  listOverride?: object[],
) {
  const listBody = JSON.stringify(listOverride ?? [tx])
  await page.route(new RegExp(`${API_RE}/transactions/senior-income/([^/?]+)$`), (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...tx, status: 'PENDING', rejectionReason: null }),
    }),
  )
  await page.route(new RegExp(`${API_RE}/transactions/([^/?]+)/(validate|pay|admin-edit)$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tx) }),
  )
  await page.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(tx) })
      : r.fulfill({ status: 200, contentType: 'application/json', body: listBody }),
  )
  await page.route(new RegExp(`${API_RE}/payout-requests/([^/?]+)/pay$`), (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(makePayoutRequest({ status: 'PAID', txHash: '0xdeadbeef' })),
    }),
  )
  // Single payout GET — used by PayoutDetailDialog when SENIOR opens an
  // existing pending payout from the inline «Оплатить» pill.
  await page.route(new RegExp(`${API_RE}/payout-requests/([^/?]+)$`), (r) =>
    r.request().method() === 'GET'
      ? r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(makePayoutRequest()),
        })
      : r.fallback(),
  )
  await page.route(new RegExp(`${API_RE}/payout-requests(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(makePayoutRequest()),
        })
      : r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(payoutReqs),
        }),
  )
  await page.route(`${API}/projects`, (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: PROJECT_ID, name: PROJECT_NAME, seniorId: USERS.senior.id }]),
    }),
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper — заполнить форму SENIOR_INCOME с обязательным чеком (URL или документ)
// ═══════════════════════════════════════════════════════════════════════════════

async function fillSeniorIncomeForm(
  page: MockPage,
  { amount, withReceipt = true }: { amount: string; withReceipt?: boolean },
) {
  const dialog = page.getByTestId('create-transaction-dialog')

  // Выбираем проект через native Select (Radix combobox — accessibility role)
  await dialog.getByRole('combobox').first().click()
  await page.getByRole('option', { name: PROJECT_NAME }).click()

  // Сумма — input type=number (no testid; semantic input is the contract)
  await dialog.locator('input[type="number"]').first().fill(amount)

  // Чек — обязателен для SENIOR_INCOME. Переключаемся на "Ссылка" режим.
  if (withReceipt) {
    await dialog.getByTestId('receipt-input-mode-url').click()
    await dialog.getByTestId('receipt-input-url-field').fill('https://drive.google.com/receipt.pdf')
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ШАГ 1: SENIOR регистрирует приход
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — шаг 1: регистрация прихода', () => {
  test('SENIOR открывает диалог создания и видит только тип SENIOR_INCOME', async ({
    asSenior,
  }) => {
    await setupTransactionMocks(asSenior, makeTx())
    await asSenior.goto('/finance')

    await asSenior.getByTestId('finance-create-transaction-button').click()
    await expect(asSenior.getByTestId('create-transaction-dialog')).toBeVisible()

    const dialog = asSenior.getByRole('dialog')
    await expect(dialog.getByTestId('create-transaction-type-senior_income')).toBeVisible()
    await expect(dialog.getByTestId('create-transaction-type-expense')).not.toBeVisible()
    await expect(dialog.getByTestId('create-transaction-type-salary')).not.toBeVisible()
  })

  test('SENIOR создаёт транзакцию с чеком — диалог закрывается', async ({ asSenior }) => {
    await setupTransactionMocks(
      asSenior,
      makeTx({ receiptExternalUrl: 'https://drive.google.com/receipt.pdf' }),
    )
    await asSenior.goto('/finance')

    await asSenior.getByTestId('finance-create-transaction-button').click()
    await fillSeniorIncomeForm(asSenior, { amount: '5000' })

    await asSenior.getByTestId('create-transaction-submit').click()
    await expect(asSenior.getByTestId('create-transaction-dialog')).not.toBeVisible()
  })

  test('SENIOR прикрепляет ссылку на чек при создании', async ({ asSenior }) => {
    await setupTransactionMocks(
      asSenior,
      makeTx({ receiptExternalUrl: 'https://drive.google.com/receipt.pdf' }),
    )
    await asSenior.goto('/finance')

    await asSenior.getByTestId('finance-create-transaction-button').click()
    await fillSeniorIncomeForm(asSenior, { amount: '5000' })

    await asSenior.getByTestId('create-transaction-submit').click()
    await expect(asSenior.getByTestId('create-transaction-dialog')).not.toBeVisible()
  })

  test('SENIOR не может создать транзакцию без чека — показывается ошибка', async ({
    asSenior,
  }) => {
    await setupTransactionMocks(asSenior, makeTx())
    await asSenior.goto('/finance')

    await asSenior.getByTestId('finance-create-transaction-button').click()
    await fillSeniorIncomeForm(asSenior, { amount: '5000', withReceipt: false })

    await asSenior.getByTestId('create-transaction-submit').click()
    // The Russian error text IS the contract here — `containText` regex keeps
    // intent visible. Dialog itself anchored by its testid.
    const dialog = asSenior.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(/прикрепите чек|подтверждение/i)
  })

  test('SENIOR не может создать транзакцию без суммы — показывается ошибка', async ({
    asSenior,
  }) => {
    await setupTransactionMocks(asSenior, makeTx())
    await asSenior.goto('/finance')

    await asSenior.getByTestId('finance-create-transaction-button').click()
    const dialog = asSenior.getByTestId('create-transaction-dialog')
    await dialog.getByRole('combobox').first().click()
    await asSenior.getByRole('option', { name: PROJECT_NAME }).click()

    await asSenior.getByTestId('create-transaction-submit').click()
    await expect(dialog).toBeVisible()
    // AC4: amount validation now renders inline next to the field («Укажите
    // корректную сумму») instead of the old single «Некорректная сумма»
    // banner. Assert via the dedicated error testid.
    await expect(dialog.getByTestId('create-transaction-error-amount')).toBeVisible()
    await expect(dialog).toContainText(/корректную сумму/i)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ШАГ 2а: ACCOUNTANT/ADMIN отклоняет транзакцию
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — шаг 2а: отклонение транзакции', () => {
  test('ACCOUNTANT видит PENDING транзакцию с кнопкой "Проверить"', async ({ page }) => {
    await mockAuthAs(page, USERS.accountant)
    const tx = makeTx()
    await setupTransactionMocks(page, tx)
    await page.goto('/finance')

    await expect(page.getByTestId(`tx-row-${tx.id}`)).toBeVisible()
    await expect(page.getByTestId('tx-status-badge-pending').first()).toBeVisible()
    await expect(page.getByTestId(`tx-row-validate-${tx.id}`)).toBeVisible()
  })

  test('ACCOUNTANT открывает диалог валидации — видит детали транзакции', async ({ page }) => {
    await mockAuthAs(page, USERS.accountant)
    const tx = makeTx()
    await setupTransactionMocks(page, tx)
    await page.goto('/finance')

    await page.getByTestId(`tx-row-${tx.id}`).getByTestId(`tx-row-validate-${tx.id}`).click()
    const dlg = page.getByTestId('validate-transaction-dialog')
    await expect(dlg).toBeVisible()

    // Project name is dynamic seed data — text assertion is the contract for
    // "the dialog actually surfaced the row I clicked". Same for the Russian
    // type label «Приход синьора» — it's how the user verifies the row type.
    await expect(dlg).toContainText('Приход синьора')
    await expect(dlg).toContainText(PROJECT_NAME)
  })

  test('ACCOUNTANT не может нажать "Отклонить" без причины', async ({ page }) => {
    await mockAuthAs(page, USERS.accountant)
    const tx = makeTx()
    await setupTransactionMocks(page, tx)
    await page.goto('/finance')

    await page.getByTestId(`tx-row-validate-${tx.id}`).click()
    await expect(page.getByTestId('validate-transaction-reject')).toBeDisabled()
  })

  test('ACCOUNTANT вводит причину — кнопка "Отклонить" разблокируется', async ({ page }) => {
    await mockAuthAs(page, USERS.accountant)
    const tx = makeTx()
    await setupTransactionMocks(page, tx)
    await page.goto('/finance')

    await page.getByTestId(`tx-row-validate-${tx.id}`).click()
    // Placeholder copy is part of the form contract for the rejection reason
    // textarea — kept as-is.
    await page.getByPlaceholder('Укажите причину при отклонении...').fill('Чек нечитаем')
    await expect(page.getByTestId('validate-transaction-reject')).not.toBeDisabled()
  })

  test('ACCOUNTANT отклоняет транзакцию — диалог закрывается', async ({ page }) => {
    await mockAuthAs(page, USERS.accountant)

    const pendingTx = makeTx()
    const rejectedTx = makeTx({ status: 'REJECTED', rejectionReason: 'Чек нечитаем' })
    await page.route(
      new RegExp(`${API_RE}/transactions/([^/?]+)/(validate|pay|admin-edit)$`),
      (r) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(rejectedTx),
        }),
    )
    await page.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([pendingTx]),
      }),
    )
    await page.route(new RegExp(`${API_RE}/payout-requests(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )

    await page.goto('/finance')
    await page.getByTestId(`tx-row-validate-${pendingTx.id}`).click()
    await page.getByPlaceholder('Укажите причину при отклонении...').fill('Чек нечитаем')
    await page.getByTestId('validate-transaction-reject').click()

    await expect(page.getByTestId('validate-transaction-dialog')).not.toBeVisible()
  })

  test('После отклонения SENIOR видит статус "Отклонено" и причину в таблице', async ({
    asSenior,
  }) => {
    const rejectedTx = makeTx({
      status: 'REJECTED',
      receiverId: USERS.senior.id,
      rejectionReason: 'Чек нечитаем',
    })
    await setupTransactionMocks(asSenior, rejectedTx)
    await asSenior.goto('/finance')

    await expect(asSenior.getByTestId('tx-status-badge-rejected').first()).toBeVisible()
    // Rejection reason text comes from API data — text assertion stays as
    // dynamic-data contract, but scoped to the row to avoid cross-row noise.
    await expect(asSenior.getByTestId(`tx-row-${rejectedTx.id}`)).toContainText('Чек нечитаем')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ШАГ 2б: SENIOR исправляет отклонённую транзакцию
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — шаг 2б: исправление отклонённой транзакции', () => {
  test('SENIOR видит кнопку "Исправить" только на своей REJECTED транзакции', async ({
    asSenior,
  }) => {
    const rejectedTx = makeTx({
      status: 'REJECTED',
      receiverId: USERS.senior.id,
      rejectionReason: 'Чек нечитаем',
    })
    await setupTransactionMocks(asSenior, rejectedTx)
    await asSenior.goto('/finance')

    await expect(asSenior.getByTestId(`tx-row-edit-${rejectedTx.id}`)).toBeVisible()
  })

  test('SENIOR открывает диалог — видит причину отклонения', async ({ asSenior }) => {
    const rejectedTx = makeTx({
      status: 'REJECTED',
      receiverId: USERS.senior.id,
      rejectionReason: 'Чек нечитаем',
    })
    await setupTransactionMocks(asSenior, rejectedTx)
    await asSenior.goto('/finance')

    await asSenior.getByTestId(`tx-row-edit-${rejectedTx.id}`).click()
    await expect(asSenior.getByRole('dialog')).toBeVisible()
    await expect(asSenior.getByTestId('edit-senior-income-rejection-panel')).toBeVisible()
    await expect(asSenior.getByTestId('edit-senior-income-rejection-reason')).toHaveText(
      'Чек нечитаем',
    )
  })

  test('SENIOR прикрепляет новый чек (ссылка) и переотправляет', async ({ asSenior }) => {
    const rejectedTx = makeTx({
      status: 'REJECTED',
      receiverId: USERS.senior.id,
      rejectionReason: 'Без чека',
    })
    await setupTransactionMocks(asSenior, rejectedTx)
    await asSenior.goto('/finance')

    await asSenior.getByTestId(`tx-row-edit-${rejectedTx.id}`).click()

    // Переключаем на ссылку — ReceiptInput URL-mode pill anchored by testid.
    await asSenior.getByRole('dialog').getByTestId('receipt-input-mode-url').click()
    await asSenior
      .getByTestId('receipt-input-url-field')
      .fill('https://drive.google.com/new-receipt.pdf')

    await asSenior.getByTestId('edit-senior-income-resubmit').click()
    await expect(asSenior.getByRole('dialog')).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ШАГ 3: ACCOUNTANT принимает транзакцию (повторная валидация)
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — шаг 3: повторная валидация (принятие)', () => {
  test('ACCOUNTANT принимает транзакцию — диалог закрывается', async ({ page }) => {
    await mockAuthAs(page, USERS.accountant)

    const validatedTx = makeTx({
      status: 'VALIDATED',
      validatedBy: USERS.accountant.id,
      validatedAt: '2026-05-02T10:00:00.000Z',
    })
    await page.route(new RegExp(`${API_RE}/transactions/([^/?]+)/validate$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(validatedTx),
      }),
    )
    await page.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([makeTx()]) }),
    )
    await page.route(new RegExp(`${API_RE}/payout-requests(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )

    await page.goto('/finance')
    await page.getByTestId(`tx-row-validate-${makeTx().id}`).click()
    await page.getByTestId('validate-transaction-confirm').click()
    await page.getByTestId('validate-confirm-ok').click()

    await expect(page.getByTestId('validate-transaction-dialog')).not.toBeVisible()
  })

  test('После принятия SENIOR видит auto-created «Выплата» с кнопкой «Оплатить»', async ({
    asSenior,
  }) => {
    // New flow (task-payout-auto-on-validate): ACCOUNTANT validate atomically
    // moves SENIOR_INCOME → PENDING_PAYMENT and inserts the «Выплата» PAYOUT
    // row carrying the inline «Оплатить» pill.
    const incomeAfterValidate = makeTx({
      status: 'PENDING_PAYMENT',
      receiverId: USERS.senior.id,
      payoutRequestId: 'flow-payout-1',
    })
    const payoutRow = {
      ...makeTx({
        id: 'flow-payout-row-1',
        type: 'PAYOUT',
        status: 'PENDING_PAYMENT',
        senderId: USERS.senior.id,
        senderName: USERS.senior.displayName,
        senderLabel: null,
        receiverId: null,
        receiverName: null,
        receiverLabel: 'CheekyCheeseIT',
        amount: '3700.00',
        payoutRequestId: 'flow-payout-1',
      }),
    }
    await setupTransactionMocks(asSenior, incomeAfterValidate, [], [incomeAfterValidate, payoutRow])
    await asSenior.goto('/finance')

    await expect(asSenior.getByTestId('tx-status-badge-pending_payment').first()).toBeVisible()
    await expect(asSenior.getByTestId(`row-pay-payout-${payoutRow.id}`)).toBeVisible()
    // Old batch header button is gone.
    await expect(asSenior.getByTestId('header-payout-button')).not.toBeVisible()
  })

  test('SENIOR не видит кнопку "Проверить" — это только для ACCOUNTANT/ADMIN', async ({
    asSenior,
  }) => {
    const validatedTx = makeTx({ status: 'PENDING', receiverId: USERS.senior.id })
    await setupTransactionMocks(asSenior, validatedTx)
    await asSenior.goto('/finance')

    await expect(asSenior.getByTestId(`tx-row-validate-${validatedTx.id}`)).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ШАГ 4 (новый флоу): «Выплата» (PAYOUT row) auto-creates при validate
//
// task-payout-auto-on-validate removed batch PayoutDialog. ACCOUNTANT click
// «Подтвердить» now atomically creates the PAYOUT row server-side, the
// SENIOR sees it directly in the table with an inline «Оплатить» pill.
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — шаг 4: «Выплата» появляется после validate', () => {
  test('SENIOR видит «Выплата» row с кнопкой «Оплатить» сразу после ACCOUNTANT validate', async ({
    asSenior,
  }) => {
    const incomeAfterValidate = makeTx({
      status: 'PENDING_PAYMENT',
      receiverId: USERS.senior.id,
      payoutRequestId: 'flow-payout-1',
    })
    const payoutRow = makeTx({
      id: 'flow-payout-row-1',
      type: 'PAYOUT',
      status: 'PENDING_PAYMENT',
      senderId: USERS.senior.id,
      senderName: USERS.senior.displayName,
      senderLabel: null,
      receiverId: null,
      receiverName: null,
      receiverLabel: 'CheekyCheeseIT',
      amount: '3700.00',
      payoutRequestId: 'flow-payout-1',
    })
    await setupTransactionMocks(asSenior, incomeAfterValidate, [], [incomeAfterValidate, payoutRow])
    await asSenior.goto('/finance')

    await expect(asSenior.getByTestId(`row-pay-payout-${payoutRow.id}`)).toBeVisible()
    // SENIOR_INCOME row no longer carries any inline pay-out button.
    await expect(asSenior.getByTestId(`row-pay-payout-${incomeAfterValidate.id}`)).not.toBeVisible()
  })

  test('Старый header-button «Выплатить (N)» НЕ виден ни на каком статусе', async ({
    asSenior,
  }) => {
    const validatedTx = makeTx({ status: 'VALIDATED', receiverId: USERS.senior.id })
    await setupTransactionMocks(asSenior, validatedTx)
    await asSenior.goto('/finance')

    await expect(asSenior.getByTestId('header-payout-button')).not.toBeVisible()
    // Defensive duplicate — no row-level pay-salary pill either on a
    // SENIOR_INCOME validated row.
    await expect(asSenior.getByTestId(`tx-row-pay-salary-${validatedTx.id}`)).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ШАГ 5: SENIOR оплачивает выплату
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — шаг 5: оплата выплаты (PayoutDetailDialog)', () => {
  // Step 5 — auto-created «Выплата» (PAYOUT row) carries the inline
  // «Оплатить» pill. Click → PayoutDetailDialog. Dialog shows the contract
  // address; SENIOR submits the on-chain tx hash to mark PAID.

  // Build the «Выплата» row (matches what the backend inserts in
  // validateTransaction after task-payout-auto-on-validate).
  function makePayoutRowTx() {
    return makeTx({
      id: 'flow-payout-row-1',
      type: 'PAYOUT',
      status: 'PENDING_PAYMENT',
      senderId: USERS.senior.id,
      senderName: USERS.senior.displayName,
      senderLabel: null,
      receiverId: null,
      receiverName: null,
      receiverLabel: 'CheekyCheeseIT',
      amount: '3700.00',
      payoutRequestId: 'flow-payout-1',
    })
  }

  test('Кнопка «Подтвердить оплату» недоступна без TX hash', async ({ asSenior }) => {
    const payoutRow = makePayoutRowTx()
    await setupTransactionMocks(asSenior, payoutRow, [], [payoutRow])

    await asSenior.goto('/finance')
    await asSenior.getByTestId(`row-pay-payout-${payoutRow.id}`).click()

    const dialog = asSenior.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-submit')).toBeDisabled()
  })

  test('PayoutDetailDialog показывает адрес контракта + payable amount', async ({ asSenior }) => {
    const payoutRow = makePayoutRowTx()
    await setupTransactionMocks(asSenior, payoutRow, [], [payoutRow])

    await asSenior.goto('/finance')
    await asSenior.getByTestId(`row-pay-payout-${payoutRow.id}`).click()

    const dialog = asSenior.getByRole('dialog')
    await expect(dialog.getByTestId('payout-detail-contract-address')).toContainText(
      FLOW_STUB_CONTRACT,
    )
    // payable = 5000 * 0.74 = 3700. AC3 switched the banner to the shared
    // ru-RU formatter («3 700,00 USDT», non-breaking-space separator) — the
    // char class tolerates space / comma / dot / none.
    await expect(dialog.getByTestId('payout-detail-payable')).toContainText(/3[\s,.]?700/)
  })

  test('SENIOR в dev-режиме выбирает «Симулировать успех» + вводит TX hash — submit разблокируется', async ({
    asSenior,
  }) => {
    // PR #56 added a dev-simulate radio. In dev «Реальная проверка» is the
    // default and intentionally disabled — the SENIOR has to opt into a
    // simulate path. So this test picks «Симулировать успех» first.
    //
    // CI runs a production build (`vite preview`) where `import.meta.env.DEV`
    // is `false` → the entire dev-simulate block is tree-shaken out. In that
    // case the radio testid is absent, but a ≥10-char hash alone unlocks
    // submit (PR #56 final UT gate logic). The test handles both modes.
    const payoutRow = makePayoutRowTx()
    await setupTransactionMocks(asSenior, payoutRow, [], [payoutRow])

    await asSenior.goto('/finance')
    await asSenior.getByTestId(`row-pay-payout-${payoutRow.id}`).click()

    const dialog = asSenior.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // Click simulate-success only when the dev block is actually mounted.
    // `isVisible()` resolves instantly without waiting for a missing element.
    const simulateRadio = dialog.getByTestId('payout-detail-dev-simulate-success')
    if (await simulateRadio.isVisible()) {
      await simulateRadio.click()
    }
    await dialog.getByTestId('payout-detail-tx-hash-input').fill('0xdeadbeef123456')
    await expect(dialog.getByTestId('payout-detail-submit')).not.toBeDisabled()
  })

  test('SENIOR в dev-режиме нажимает «Подтвердить оплату» — диалог закрывается', async ({
    asSenior,
  }) => {
    const payoutRow = makePayoutRowTx()
    await setupTransactionMocks(asSenior, payoutRow, [], [payoutRow])

    await asSenior.goto('/finance')
    await asSenior.getByTestId(`row-pay-payout-${payoutRow.id}`).click()

    const dialog = asSenior.getByRole('dialog')
    await expect(dialog).toBeVisible()
    // Simulate-success unlocks submit in dev when hash is short. In CI's
    // production build the block is tree-shaken — a ≥10-char hash unlocks
    // submit directly. Either path lands on the same payMutation.
    const simulateRadio = dialog.getByTestId('payout-detail-dev-simulate-success')
    if (await simulateRadio.isVisible()) {
      await simulateRadio.click()
    }
    await dialog.getByTestId('payout-detail-tx-hash-input').fill('0xdeadbeef123456')
    await dialog.getByTestId('payout-detail-submit').click()

    await expect(dialog).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow A2 (task-autotest-strengthen-e2e-pr56-flows): validate-idempotency
//
// PR #56 backend gate: validateTransaction(tx_id) is a no-op on a row that
// is no longer PENDING. From the UI side we assert the consequence — once
// VALIDATED, the ACCOUNTANT no longer sees a «Проверить» button on that row
// and cannot trigger a second auto-payout creation.
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — A2: validate idempotency (PR #56)', () => {
  test('VALIDATED row has no «Проверить» button (cannot re-validate, no duplicate payout)', async ({
    page,
  }) => {
    await mockAuthAs(page, USERS.accountant)
    const validatedTx = makeTx({
      status: 'VALIDATED',
      validatedBy: USERS.accountant.id,
      validatedAt: '2026-05-02T10:00:00.000Z',
    })
    await setupTransactionMocks(page, validatedTx)
    await page.goto('/finance')

    await expect(page.getByTestId('tx-status-badge-validated').first()).toBeVisible()
    await expect(page.getByTestId(`tx-row-validate-${validatedTx.id}`)).not.toBeVisible()
  })

  test('PENDING_PAYMENT income row has no «Проверить» (already past validate gate)', async ({
    page,
  }) => {
    await mockAuthAs(page, USERS.accountant)
    const pendingPaymentTx = makeTx({
      status: 'PENDING_PAYMENT',
      payoutRequestId: 'flow-payout-1',
      validatedBy: USERS.accountant.id,
      validatedAt: '2026-05-02T10:00:00.000Z',
    })
    await setupTransactionMocks(page, pendingPaymentTx)
    await page.goto('/finance')

    await expect(page.getByTestId('tx-status-badge-pending_payment').first()).toBeVisible()
    await expect(page.getByTestId(`tx-row-validate-${pendingPaymentTx.id}`)).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Flow D (task-autotest-strengthen-e2e-pr56-flows): transaction list sort
//
// E2E counterpart to the existing unit tests in apps/web/app/routes/finance/
// __tests__/sort.test.ts. The unit test pins the compareTxByDate behaviour;
// here we verify the integrated outcome — mixed income/payout rows render
// in the right order in the UI. Regression target: bug bf5dc2e where the
// midnight-txDate income sorted ABOVE a later-createdAt payout because the
// comparator used txDate ?? createdAt as the primary key.
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — D: transactions sorted by createdAt DESC (regression bf5dc2e)', () => {
  test('mixed income (midnight txDate) + payout (null txDate) sorted by createdAt only', async ({
    asAdmin,
  }) => {
    // Income created LATER but txDate=midnight (a backend default for
    // legacy rows without an explicit pick-date). Old comparator put the
    // payout first because txDate=null fell back to createdAt=07:37 while
    // income.txDate=00:00 lost. New comparator ignores txDate entirely:
    // income.createdAt=08:17 > payout.createdAt=07:37 → income first.
    const incomeLater = {
      ...makeTx({
        id: 'sort-income-1',
        amount: '4000.00',
        createdAt: '2026-05-28T08:17:00.000Z',
        // The "txDate=midnight" gotcha — server backfills this for legacy
        // income rows where the user did not pick a date.
      }),
      txDate: '2026-05-28T00:00:00.000Z',
    }
    const payoutEarlier = makeTx({
      id: 'sort-payout-1',
      type: 'PAYOUT',
      status: 'PAID',
      senderId: USERS.senior.id,
      senderName: USERS.senior.displayName,
      senderLabel: null,
      receiverId: null,
      receiverName: null,
      receiverLabel: 'CheekyCheeseIT',
      amount: '8222.14',
      createdAt: '2026-05-28T07:37:20.000Z',
      txHash: '0xpayoutsort',
      payoutRequestId: 'flow-payout-sort',
    })

    await setupTransactionMocks(asAdmin, incomeLater, [], [incomeLater, payoutEarlier])
    await asAdmin.goto('/finance')

    // Wait for both row amounts to render — the finance page lazy-renders
    // the transactions section under a Suspense-like skeleton.
    await expect(asAdmin.getByText(/4[,.]?000/).first()).toBeVisible()
    await expect(asAdmin.getByText(/8[,.]?222/).first()).toBeVisible()

    // Compare vertical position of the two amounts. The row physically
    // higher on the page (smaller y) comes first in the DESC sort.
    const incomeBox = await asAdmin
      .getByText(/4[,.]?000/)
      .first()
      .boundingBox()
    const payoutBox = await asAdmin
      .getByText(/8[,.]?222/)
      .first()
      .boundingBox()
    expect(incomeBox, 'income row box').not.toBeNull()
    expect(payoutBox, 'payout row box').not.toBeNull()
    // Income has later createdAt → must appear ABOVE payout in DESC order.
    expect(incomeBox!.y, 'income above payout').toBeLessThan(payoutBox!.y)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ПОЛНЫЙ СКВОЗНОЙ ФЛОУ в одном тесте
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — полный сквозной флоу', () => {
  test('SENIOR создаёт → ACCOUNTANT отклоняет → SENIOR исправляет → ACCOUNTANT принимает → SENIOR выплачивает', async ({
    browser,
  }) => {
    const seniorCtx = await browser.newContext()
    const accountantCtx = await browser.newContext()
    const seniorPage = await seniorCtx.newPage()
    const accountantPage = await accountantCtx.newPage()

    await mockAuthAs(seniorPage, USERS.senior)
    await mockAuthAs(accountantPage, USERS.accountant)

    // === ШАГ 1: SENIOR создаёт транзакцию ===
    const pendingTx = makeTx({ receiptExternalUrl: 'https://drive.google.com/receipt.pdf' })

    await seniorPage.route(new RegExp(`${API_RE}/transactions/senior-income/([^/?]+)$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...pendingTx, status: 'PENDING', rejectionReason: null }),
      }),
    )
    await seniorPage.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) => {
      if (r.request().method() === 'POST') {
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(pendingTx),
        })
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([pendingTx]),
      })
    })
    await seniorPage.route(new RegExp(`${API_RE}/payout-requests(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
    await seniorPage.route(`${API}/projects`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: PROJECT_ID, name: PROJECT_NAME, seniorId: USERS.senior.id }]),
      }),
    )

    await seniorPage.goto('/finance')
    await seniorPage.getByTestId('finance-create-transaction-button').click()
    const createDialog = seniorPage.getByTestId('create-transaction-dialog')
    await createDialog.getByRole('combobox').first().click()
    await seniorPage.getByRole('option', { name: PROJECT_NAME }).click()
    await createDialog.locator('input[type="number"]').first().fill('5000')
    // Receipt URL обязателен — переключаемся и заполняем
    await createDialog.getByTestId('receipt-input-mode-url').click()
    await createDialog
      .getByTestId('receipt-input-url-field')
      .fill('https://drive.google.com/receipt.pdf')
    await seniorPage.getByTestId('create-transaction-submit').click()
    await expect(createDialog).not.toBeVisible()
    await expect(seniorPage.getByTestId('tx-status-badge-pending').first()).toBeVisible()

    // === ШАГ 2а: ACCOUNTANT отклоняет ===
    const rejectedTx = makeTx({
      status: 'REJECTED',
      rejectionReason: 'Нет чека',
      receiptExternalUrl: 'https://drive.google.com/receipt.pdf',
    })

    await accountantPage.route(
      new RegExp(`${API_RE}/transactions/([^/?]+)/(validate|pay|admin-edit)$`),
      (r) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(rejectedTx),
        }),
    )
    await accountantPage.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([pendingTx]),
      }),
    )
    await accountantPage.route(new RegExp(`${API_RE}/payout-requests(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )

    await accountantPage.goto('/finance')
    await expect(accountantPage.getByTestId('tx-status-badge-pending').first()).toBeVisible()
    await accountantPage.getByTestId(`tx-row-validate-${pendingTx.id}`).click()
    await accountantPage.getByPlaceholder('Укажите причину при отклонении...').fill('Нет чека')
    await accountantPage.getByTestId('validate-transaction-reject').click()
    await expect(accountantPage.getByTestId('validate-transaction-dialog')).not.toBeVisible()

    // === ШАГ 2б: SENIOR исправляет ===
    const correctedTx = makeTx({
      status: 'PENDING',
      receiptExternalUrl: 'https://drive.google.com/new-receipt.pdf',
    })

    await seniorPage.route(new RegExp(`${API_RE}/transactions/senior-income/([^/?]+)$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(correctedTx),
      }),
    )
    await seniorPage.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([rejectedTx]),
      }),
    )

    await seniorPage.goto('/finance')
    await expect(seniorPage.getByTestId('tx-status-badge-rejected').first()).toBeVisible()
    await seniorPage.getByTestId(`tx-row-edit-${rejectedTx.id}`).click()
    await expect(seniorPage.getByTestId('edit-senior-income-rejection-panel')).toBeVisible()
    await seniorPage.getByRole('dialog').getByTestId('receipt-input-mode-url').click()
    await seniorPage
      .getByTestId('receipt-input-url-field')
      .fill('https://drive.google.com/new-receipt.pdf')
    await seniorPage.getByTestId('edit-senior-income-resubmit').click()
    await expect(seniorPage.getByRole('dialog')).not.toBeVisible()

    // === ШАГ 3: ACCOUNTANT принимает ===
    const validatedTx = makeTx({
      status: 'VALIDATED',
      validatedBy: USERS.accountant.id,
      receiptExternalUrl: 'https://drive.google.com/new-receipt.pdf',
    })

    await accountantPage.route(
      new RegExp(`${API_RE}/transactions/([^/?]+)/(validate|pay|admin-edit)$`),
      (r) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(validatedTx),
        }),
    )
    await accountantPage.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([correctedTx]),
      }),
    )

    await accountantPage.goto('/finance')
    await accountantPage.getByTestId(`tx-row-validate-${correctedTx.id}`).click()
    await accountantPage.getByTestId('validate-transaction-confirm').click()
    await accountantPage.getByTestId('validate-confirm-ok').click()
    await expect(accountantPage.getByTestId('validate-transaction-dialog')).not.toBeVisible()

    // === ШАГ 4 + 5: «Выплата» auto-created server-side; SENIOR оплачивает ===
    // task-payout-auto-on-validate collapsed old steps 4 (PayoutDialog) and 5
    // (PayoutDetailDialog) into one. ACCOUNTANT's earlier «Подтвердить»
    // would atomically insert the PAYOUT row, so the SENIOR now arrives at
    // /finance and sees the «Выплата» row directly.
    const pendingPaymentIncome = {
      ...validatedTx,
      status: 'PENDING_PAYMENT',
      payoutRequestId: 'flow-payout-1',
      receiverId: USERS.senior.id,
    }
    const payoutRow = makeTx({
      id: 'flow-payout-row-1',
      type: 'PAYOUT',
      status: 'PENDING_PAYMENT',
      senderId: USERS.senior.id,
      senderName: USERS.senior.displayName,
      senderLabel: null,
      receiverId: null,
      receiverName: null,
      receiverLabel: 'CheekyCheeseIT',
      amount: '3700.00',
      payoutRequestId: 'flow-payout-1',
    })

    await seniorPage.route(new RegExp(`${API_RE}/payout-requests/([^/?]+)/pay$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(makePayoutRequest({ status: 'PAID', txHash: '0xdeadbeef' })),
      }),
    )
    await seniorPage.route(new RegExp(`${API_RE}/payout-requests/([^/?]+)$`), (r) =>
      r.request().method() === 'GET'
        ? r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(makePayoutRequest()),
          })
        : r.fallback(),
    )
    await seniorPage.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([pendingPaymentIncome, payoutRow]),
      }),
    )

    await seniorPage.goto('/finance')
    // Old batch header button must not exist anymore.
    await expect(seniorPage.getByTestId('header-payout-button')).not.toBeVisible()
    // SENIOR opens the auto-created «Выплата» row via its inline pill.
    await seniorPage.getByTestId(`row-pay-payout-${payoutRow.id}`).click()
    const detailDialog = seniorPage.getByRole('dialog')
    await expect(detailDialog).toBeVisible()
    await expect(detailDialog.getByTestId('payout-detail-contract-address')).toContainText(
      FLOW_STUB_CONTRACT,
    )
    // PR #56 dev-simulate gate: in `vite` dev real mode is disabled and the
    // SENIOR has to pick simulate-success to unlock submit. In CI's
    // production build (`vite preview`) the whole dev block is tree-shaken
    // out — a ≥10-char hash alone unlocks submit. Click only when visible.
    const flowSimulateRadio = detailDialog.getByTestId('payout-detail-dev-simulate-success')
    if (await flowSimulateRadio.isVisible()) {
      await flowSimulateRadio.click()
    }
    await detailDialog.getByTestId('payout-detail-tx-hash-input').fill('0xdeadbeef123456')
    await detailDialog.getByTestId('payout-detail-submit').click()
    await expect(detailDialog).not.toBeVisible()

    await seniorCtx.close()
    await accountantCtx.close()
  })
})
