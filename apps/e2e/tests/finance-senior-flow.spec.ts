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

const API = 'http://localhost:3001/api'
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
  await page.route(new RegExp(`${API}/transactions/senior-income/([^/?]+)$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...tx, status: 'PENDING', rejectionReason: null }) }),
  )
  await page.route(new RegExp(`${API}/transactions/([^/?]+)/(validate|pay|admin-edit)$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tx) }),
  )
  await page.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(tx) })
      : r.fulfill({ status: 200, contentType: 'application/json', body: listBody }),
  )
  await page.route(new RegExp(`${API}/payout-requests/([^/?]+)/pay$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(makePayoutRequest({ status: 'PAID', txHash: '0xdeadbeef' })) }),
  )
  // Single payout GET — used by PayoutDetailDialog when SENIOR opens an
  // existing pending payout from the inline «Оплатить» pill.
  await page.route(new RegExp(`${API}/payout-requests/([^/?]+)$`), (r) =>
    r.request().method() === 'GET'
      ? r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(makePayoutRequest()) })
      : r.fallback(),
  )
  await page.route(new RegExp(`${API}/payout-requests(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(makePayoutRequest()) })
      : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payoutReqs) }),
  )
  await page.route(`${API}/projects`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: PROJECT_ID, name: PROJECT_NAME, seniorId: USERS.senior.id }]) }),
  )
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper — заполнить форму SENIOR_INCOME с обязательным чеком (URL или документ)
// ═══════════════════════════════════════════════════════════════════════════════

async function fillSeniorIncomeForm(page: MockPage, { amount, withReceipt = true }: { amount: string; withReceipt?: boolean }) {
  const dialog = page.getByRole('dialog')

  // Выбираем проект через native Select (Radix combobox)
  await dialog.getByRole('combobox').first().click()
  await page.getByRole('option', { name: PROJECT_NAME }).click()

  // Сумма — input type=number
  await dialog.locator('input[type="number"]').first().fill(amount)

  // Чек — обязателен для SENIOR_INCOME. Переключаемся на "Ссылка" режим.
  if (withReceipt) {
    await dialog.getByRole('button', { name: /Ссылка/i }).click()
    await dialog.getByPlaceholder('https://...').fill('https://drive.google.com/receipt.pdf')
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ШАГ 1: SENIOR регистрирует приход
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — шаг 1: регистрация прихода', () => {
  test('SENIOR открывает диалог создания и видит только тип SENIOR_INCOME', async ({ asSenior }) => {
    await setupTransactionMocks(asSenior, makeTx())
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Новая транзакция/i }).click()
    await expect(asSenior.getByRole('dialog')).toBeVisible()

    const dialog = asSenior.getByRole('dialog')
    await expect(dialog.getByText('Приход синьора')).toBeVisible()
    await expect(dialog.getByText('Расход компании')).not.toBeVisible()
    await expect(dialog.getByText('Зарплата сотруднику')).not.toBeVisible()
  })

  test('SENIOR создаёт транзакцию с чеком — диалог закрывается', async ({ asSenior }) => {
    await setupTransactionMocks(asSenior, makeTx({ receiptExternalUrl: 'https://drive.google.com/receipt.pdf' }))
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Новая транзакция/i }).click()
    await fillSeniorIncomeForm(asSenior, { amount: '5000' })

    await asSenior.getByRole('button', { name: 'Создать транзакцию' }).click()
    await expect(asSenior.getByRole('dialog')).not.toBeVisible()
  })

  test('SENIOR прикрепляет ссылку на чек при создании', async ({ asSenior }) => {
    await setupTransactionMocks(asSenior, makeTx({ receiptExternalUrl: 'https://drive.google.com/receipt.pdf' }))
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Новая транзакция/i }).click()
    await fillSeniorIncomeForm(asSenior, { amount: '5000' })

    await asSenior.getByRole('button', { name: 'Создать транзакцию' }).click()
    await expect(asSenior.getByRole('dialog')).not.toBeVisible()
  })

  test('SENIOR не может создать транзакцию без чека — показывается ошибка', async ({ asSenior }) => {
    await setupTransactionMocks(asSenior, makeTx())
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Новая транзакция/i }).click()
    await fillSeniorIncomeForm(asSenior, { amount: '5000', withReceipt: false })

    await asSenior.getByRole('button', { name: 'Создать транзакцию' }).click()
    // Ошибка в диалоге — банер ошибки внизу
    await expect(asSenior.getByRole('dialog').getByText(/прикрепите чек|подтверждение/i).first()).toBeVisible()
    await expect(asSenior.getByRole('dialog')).toBeVisible()
  })

  test('SENIOR не может создать транзакцию без суммы — показывается ошибка', async ({ asSenior }) => {
    await setupTransactionMocks(asSenior, makeTx())
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Новая транзакция/i }).click()
    const dialog = asSenior.getByRole('dialog')
    await dialog.getByRole('combobox').first().click()
    await asSenior.getByRole('option', { name: PROJECT_NAME }).click()

    await asSenior.getByRole('button', { name: 'Создать транзакцию' }).click()
    await expect(dialog.getByText(/некорректная сумма/i)).toBeVisible()
    await expect(dialog).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ШАГ 2а: ACCOUNTANT/ADMIN отклоняет транзакцию
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — шаг 2а: отклонение транзакции', () => {
  test('ACCOUNTANT видит PENDING транзакцию с кнопкой "Проверить"', async ({ page }) => {
    await mockAuthAs(page, USERS.accountant)
    await setupTransactionMocks(page, makeTx())
    await page.goto('/crm/finance')

    await expect(page.getByText('Приход синьора').first()).toBeVisible()
    await expect(page.getByText('Ожидает').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /Проверить/i })).toBeVisible()
  })

  test('ACCOUNTANT открывает диалог валидации — видит детали транзакции', async ({ page }) => {
    await mockAuthAs(page, USERS.accountant)
    await setupTransactionMocks(page, makeTx())
    await page.goto('/crm/finance')

    await page.getByRole('button', { name: /Проверить/i }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const dlg = page.getByRole('dialog')
    await expect(dlg.getByText('Приход синьора')).toBeVisible()
    await expect(dlg.getByText(PROJECT_NAME)).toBeVisible()
  })

  test('ACCOUNTANT не может нажать "Отклонить" без причины', async ({ page }) => {
    await mockAuthAs(page, USERS.accountant)
    await setupTransactionMocks(page, makeTx())
    await page.goto('/crm/finance')

    await page.getByRole('button', { name: /Проверить/i }).click()
    const rejectBtn = page.getByRole('button', { name: 'Отклонить' })
    await expect(rejectBtn).toBeDisabled()
  })

  test('ACCOUNTANT вводит причину — кнопка "Отклонить" разблокируется', async ({ page }) => {
    await mockAuthAs(page, USERS.accountant)
    await setupTransactionMocks(page, makeTx())
    await page.goto('/crm/finance')

    await page.getByRole('button', { name: /Проверить/i }).click()
    await page.getByPlaceholder('Укажите причину при отклонении...').fill('Чек нечитаем')
    await expect(page.getByRole('button', { name: 'Отклонить' })).not.toBeDisabled()
  })

  test('ACCOUNTANT отклоняет транзакцию — диалог закрывается', async ({ page }) => {
    await mockAuthAs(page, USERS.accountant)

    const pendingTx = makeTx()
    const rejectedTx = makeTx({ status: 'REJECTED', rejectionReason: 'Чек нечитаем' })
    await page.route(new RegExp(`${API}/transactions/([^/?]+)/(validate|pay|admin-edit)$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rejectedTx) }),
    )
    await page.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([pendingTx]) }),
    )
    await page.route(new RegExp(`${API}/payout-requests(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )

    await page.goto('/crm/finance')
    await page.getByRole('button', { name: /Проверить/i }).click()
    await page.getByPlaceholder('Укажите причину при отклонении...').fill('Чек нечитаем')
    await page.getByRole('button', { name: 'Отклонить' }).click()

    await expect(page.getByRole('dialog')).not.toBeVisible()
  })

  test('После отклонения SENIOR видит статус "Отклонено" и причину в таблице', async ({ asSenior }) => {
    const rejectedTx = makeTx({
      status: 'REJECTED',
      receiverId: USERS.senior.id,
      rejectionReason: 'Чек нечитаем',
    })
    await setupTransactionMocks(asSenior, rejectedTx)
    await asSenior.goto('/crm/finance')

    await expect(asSenior.getByText('Отклонено').first()).toBeVisible()
    await expect(asSenior.getByText('Чек нечитаем').first()).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ШАГ 2б: SENIOR исправляет отклонённую транзакцию
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — шаг 2б: исправление отклонённой транзакции', () => {
  test('SENIOR видит кнопку "Исправить" только на своей REJECTED транзакции', async ({ asSenior }) => {
    const rejectedTx = makeTx({ status: 'REJECTED', receiverId: USERS.senior.id, rejectionReason: 'Чек нечитаем' })
    await setupTransactionMocks(asSenior, rejectedTx)
    await asSenior.goto('/crm/finance')

    await expect(asSenior.getByRole('button', { name: /Исправить/i })).toBeVisible()
  })

  test('SENIOR открывает диалог — видит причину отклонения', async ({ asSenior }) => {
    const rejectedTx = makeTx({ status: 'REJECTED', receiverId: USERS.senior.id, rejectionReason: 'Чек нечитаем' })
    await setupTransactionMocks(asSenior, rejectedTx)
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Исправить/i }).click()
    await expect(asSenior.getByRole('dialog')).toBeVisible()
    await expect(asSenior.getByText('Причина отклонения:')).toBeVisible()
    await expect(asSenior.getByRole('dialog').getByText('Чек нечитаем')).toBeVisible()
  })

  test('SENIOR прикрепляет новый чек (ссылка) и переотправляет', async ({ asSenior }) => {
    const rejectedTx = makeTx({ status: 'REJECTED', receiverId: USERS.senior.id, rejectionReason: 'Без чека' })
    await setupTransactionMocks(asSenior, rejectedTx)
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Исправить/i }).click()

    // Переключаем на ссылку
    await asSenior.getByRole('dialog').getByRole('button', { name: /Ссылка/i }).click()
    await asSenior.getByPlaceholder('https://...').fill('https://drive.google.com/new-receipt.pdf')

    await asSenior.getByRole('button', { name: 'Переотправить' }).click()
    await expect(asSenior.getByRole('dialog')).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ШАГ 3: ACCOUNTANT принимает транзакцию (повторная валидация)
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — шаг 3: повторная валидация (принятие)', () => {
  test('ACCOUNTANT принимает транзакцию — диалог закрывается', async ({ page }) => {
    await mockAuthAs(page, USERS.accountant)

    const validatedTx = makeTx({ status: 'VALIDATED', validatedBy: USERS.accountant.id, validatedAt: '2026-05-02T10:00:00.000Z' })
    await page.route(new RegExp(`${API}/transactions/([^/?]+)/validate$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(validatedTx) }),
    )
    await page.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([makeTx()]) }),
    )
    await page.route(new RegExp(`${API}/payout-requests(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )

    await page.goto('/crm/finance')
    await page.getByRole('button', { name: /Проверить/i }).click()
    await page.getByRole('button', { name: 'Подтвердить' }).click()

    await expect(page.getByRole('dialog')).not.toBeVisible()
  })

  test('После принятия SENIOR видит auto-created «Выплата» с кнопкой «Оплатить»', async ({ asSenior }) => {
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
    await asSenior.goto('/crm/finance')

    await expect(asSenior.getByText(/Ожидает выплаты/i).first()).toBeVisible()
    await expect(asSenior.getByTestId(`row-pay-payout-${payoutRow.id}`)).toBeVisible()
    // Old batch header button is gone.
    await expect(asSenior.getByRole('button', { name: /Выплатить \(/i })).not.toBeVisible()
  })

  test('SENIOR не видит кнопку "Проверить" — это только для ACCOUNTANT/ADMIN', async ({ asSenior }) => {
    const validatedTx = makeTx({ status: 'PENDING', receiverId: USERS.senior.id })
    await setupTransactionMocks(asSenior, validatedTx)
    await asSenior.goto('/crm/finance')

    await expect(asSenior.getByRole('button', { name: /Проверить/i })).not.toBeVisible()
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
  test('SENIOR видит «Выплата» row с кнопкой «Оплатить» сразу после ACCOUNTANT validate', async ({ asSenior }) => {
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
    await asSenior.goto('/crm/finance')

    await expect(asSenior.getByTestId(`row-pay-payout-${payoutRow.id}`)).toBeVisible()
    // SENIOR_INCOME row no longer carries any inline pay-out button.
    await expect(asSenior.getByTestId(`row-pay-payout-${incomeAfterValidate.id}`)).not.toBeVisible()
  })

  test('Старый header-button «Выплатить (N)» НЕ виден ни на каком статусе', async ({ asSenior }) => {
    const validatedTx = makeTx({ status: 'VALIDATED', receiverId: USERS.senior.id })
    await setupTransactionMocks(asSenior, validatedTx)
    await asSenior.goto('/crm/finance')

    await expect(asSenior.getByTestId('header-payout-button')).not.toBeVisible()
    await expect(asSenior.getByRole('button', { name: /Выплатить \(/i })).not.toBeVisible()
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

    await asSenior.goto('/crm/finance')
    await asSenior.getByTestId(`row-pay-payout-${payoutRow.id}`).click()

    const dialog = asSenior.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-submit')).toBeDisabled()
  })

  test('PayoutDetailDialog показывает адрес контракта + payable amount', async ({ asSenior }) => {
    const payoutRow = makePayoutRowTx()
    await setupTransactionMocks(asSenior, payoutRow, [], [payoutRow])

    await asSenior.goto('/crm/finance')
    await asSenior.getByTestId(`row-pay-payout-${payoutRow.id}`).click()

    const dialog = asSenior.getByRole('dialog')
    await expect(dialog.getByTestId('payout-detail-contract-address')).toContainText(
      FLOW_STUB_CONTRACT,
    )
    // payable = 5000 * 0.74 = 3700
    await expect(dialog.getByTestId('payout-detail-payable')).toContainText(/3[,.]?700/)
  })

  test('SENIOR вводит TX hash — «Подтвердить оплату» разблокируется', async ({ asSenior }) => {
    const payoutRow = makePayoutRowTx()
    await setupTransactionMocks(asSenior, payoutRow, [], [payoutRow])

    await asSenior.goto('/crm/finance')
    await asSenior.getByTestId(`row-pay-payout-${payoutRow.id}`).click()

    const dialog = asSenior.getByRole('dialog')
    await dialog.getByTestId('payout-detail-tx-hash-input').fill('0xdeadbeef123456')
    await expect(dialog.getByTestId('payout-detail-submit')).not.toBeDisabled()
  })

  test('SENIOR нажимает «Подтвердить оплату» — диалог закрывается', async ({ asSenior }) => {
    const payoutRow = makePayoutRowTx()
    await setupTransactionMocks(asSenior, payoutRow, [], [payoutRow])

    await asSenior.goto('/crm/finance')
    await asSenior.getByTestId(`row-pay-payout-${payoutRow.id}`).click()

    const dialog = asSenior.getByRole('dialog')
    await dialog.getByTestId('payout-detail-tx-hash-input').fill('0xdeadbeef123456')
    await dialog.getByTestId('payout-detail-submit').click()

    await expect(dialog).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ПОЛНЫЙ СКВОЗНОЙ ФЛОУ в одном тесте
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — полный сквозной флоу', () => {
  test('SENIOR создаёт → ACCOUNTANT отклоняет → SENIOR исправляет → ACCOUNTANT принимает → SENIOR выплачивает', async ({ browser }) => {
    const seniorCtx = await browser.newContext()
    const accountantCtx = await browser.newContext()
    const seniorPage = await seniorCtx.newPage()
    const accountantPage = await accountantCtx.newPage()

    await mockAuthAs(seniorPage, USERS.senior)
    await mockAuthAs(accountantPage, USERS.accountant)

    // === ШАГ 1: SENIOR создаёт транзакцию ===
    const pendingTx = makeTx({ receiptExternalUrl: 'https://drive.google.com/receipt.pdf' })

    await seniorPage.route(new RegExp(`${API}/transactions/senior-income/([^/?]+)$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...pendingTx, status: 'PENDING', rejectionReason: null }) }),
    )
    await seniorPage.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) => {
      if (r.request().method() === 'POST') {
        return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(pendingTx) })
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([pendingTx]) })
    })
    await seniorPage.route(new RegExp(`${API}/payout-requests(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
    await seniorPage.route(`${API}/projects`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: PROJECT_ID, name: PROJECT_NAME, seniorId: USERS.senior.id }]) }),
    )

    await seniorPage.goto('/crm/finance')
    await seniorPage.getByRole('button', { name: /Новая транзакция/i }).click()
    const createDialog = seniorPage.getByRole('dialog')
    await createDialog.getByRole('combobox').first().click()
    await seniorPage.getByRole('option', { name: PROJECT_NAME }).click()
    await createDialog.locator('input[type="number"]').first().fill('5000')
    // Receipt URL обязателен — переключаемся и заполняем
    await createDialog.getByRole('button', { name: /Ссылка/i }).click()
    await createDialog.getByPlaceholder('https://...').fill('https://drive.google.com/receipt.pdf')
    await seniorPage.getByRole('button', { name: 'Создать транзакцию' }).click()
    await expect(seniorPage.getByRole('dialog')).not.toBeVisible()
    await expect(seniorPage.getByText('Ожидает').first()).toBeVisible()

    // === ШАГ 2а: ACCOUNTANT отклоняет ===
    const rejectedTx = makeTx({ status: 'REJECTED', rejectionReason: 'Нет чека', receiptExternalUrl: 'https://drive.google.com/receipt.pdf' })

    await accountantPage.route(new RegExp(`${API}/transactions/([^/?]+)/(validate|pay|admin-edit)$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rejectedTx) }),
    )
    await accountantPage.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([pendingTx]) }),
    )
    await accountantPage.route(new RegExp(`${API}/payout-requests(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )

    await accountantPage.goto('/crm/finance')
    await expect(accountantPage.getByText('Ожидает').first()).toBeVisible()
    await accountantPage.getByRole('button', { name: /Проверить/i }).click()
    await accountantPage.getByPlaceholder('Укажите причину при отклонении...').fill('Нет чека')
    await accountantPage.getByRole('button', { name: 'Отклонить' }).click()
    await expect(accountantPage.getByRole('dialog')).not.toBeVisible()

    // === ШАГ 2б: SENIOR исправляет ===
    const correctedTx = makeTx({ status: 'PENDING', receiptExternalUrl: 'https://drive.google.com/new-receipt.pdf' })

    await seniorPage.route(new RegExp(`${API}/transactions/senior-income/([^/?]+)$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(correctedTx) }),
    )
    await seniorPage.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([rejectedTx]) }),
    )

    await seniorPage.goto('/crm/finance')
    await expect(seniorPage.getByText('Отклонено').first()).toBeVisible()
    await seniorPage.getByRole('button', { name: /Исправить/i }).click()
    await expect(seniorPage.getByText('Причина отклонения:')).toBeVisible()
    await seniorPage.getByRole('dialog').getByRole('button', { name: /Ссылка/i }).click()
    await seniorPage.getByPlaceholder('https://...').fill('https://drive.google.com/new-receipt.pdf')
    await seniorPage.getByRole('button', { name: 'Переотправить' }).click()
    await expect(seniorPage.getByRole('dialog')).not.toBeVisible()

    // === ШАГ 3: ACCOUNTANT принимает ===
    const validatedTx = makeTx({ status: 'VALIDATED', validatedBy: USERS.accountant.id, receiptExternalUrl: 'https://drive.google.com/new-receipt.pdf' })

    await accountantPage.route(new RegExp(`${API}/transactions/([^/?]+)/(validate|pay|admin-edit)$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(validatedTx) }),
    )
    await accountantPage.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([correctedTx]) }),
    )

    await accountantPage.goto('/crm/finance')
    await accountantPage.getByRole('button', { name: /Проверить/i }).click()
    await accountantPage.getByRole('button', { name: 'Подтвердить' }).click()
    await expect(accountantPage.getByRole('dialog')).not.toBeVisible()

    // === ШАГ 4 + 5: «Выплата» auto-created server-side; SENIOR оплачивает ===
    // task-payout-auto-on-validate collapsed old steps 4 (PayoutDialog) and 5
    // (PayoutDetailDialog) into one. ACCOUNTANT's earlier «Подтвердить»
    // would atomically insert the PAYOUT row, so the SENIOR now arrives at
    // /crm/finance and sees the «Выплата» row directly.
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

    await seniorPage.route(new RegExp(`${API}/payout-requests/([^/?]+)/pay$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(makePayoutRequest({ status: 'PAID', txHash: '0xdeadbeef' })),
      }),
    )
    await seniorPage.route(new RegExp(`${API}/payout-requests/([^/?]+)$`), (r) =>
      r.request().method() === 'GET'
        ? r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(makePayoutRequest()),
          })
        : r.fallback(),
    )
    await seniorPage.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([pendingPaymentIncome, payoutRow]),
      }),
    )

    await seniorPage.goto('/crm/finance')
    // Old batch header button must not exist anymore.
    await expect(seniorPage.getByTestId('header-payout-button')).not.toBeVisible()
    // SENIOR opens the auto-created «Выплата» row via its inline pill.
    await seniorPage.getByTestId(`row-pay-payout-${payoutRow.id}`).click()
    const detailDialog = seniorPage.getByRole('dialog')
    await expect(detailDialog.getByTestId('payout-detail-contract-address')).toContainText(
      FLOW_STUB_CONTRACT,
    )
    await detailDialog.getByTestId('payout-detail-tx-hash-input').fill('0xdeadbeef123456')
    await detailDialog.getByTestId('payout-detail-submit').click()
    await expect(detailDialog).not.toBeVisible()

    await seniorCtx.close()
    await accountantCtx.close()
  })
})
