/**
 * Полный сквозной флоу прихода синьора:
 *
 * 1.  SENIOR регистрирует приход (SENIOR_INCOME → PENDING)
 * 2a. ACCOUNTANT отклоняет транзакцию (→ REJECTED)
 * 2b. SENIOR видит причину отклонения и исправляет (→ PENDING снова)
 * 3.  ACCOUNTANT принимает транзакцию (→ VALIDATED)
 * 4.  SENIOR создаёт запрос выплаты (payout-request → PENDING)
 *     — выбирает транзакцию, видит расчёт суммы, подтверждает
 * 5.  SENIOR оплачивает выплату с TX hash (payout-request → PAID)
 *     — транзакция переходит в PAID
 *     — кнопка "Выплатить" исчезает (нет VALIDATED транзакций)
 */

import { test, expect, USERS, PROJECTS } from './fixtures'

const API = 'http://localhost:3001/api'
const PROJECT_ID = PROJECTS[0]!.id
const PROJECT_NAME = PROJECTS[0]!.name

// ─── Стейт-машина транзакции ─────────────────────────────────────────────────

function makeTx(overrides: object = {}) {
  return {
    id: 'flow-tx-1',
    type: 'SENIOR_INCOME',
    status: 'PENDING',
    amount: '5000.00',
    currency: 'USDT',
    senderId: USERS.senior.id,
    senderName: USERS.senior.displayName,
    senderLabel: null,
    receiverId: USERS.senior.id,
    receiverName: USERS.senior.displayName,
    receiverLabel: null,
    seniorSharePercent: 26,
    projectId: PROJECT_ID,
    projectName: PROJECT_NAME,
    receiptUrl: null,
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

function makePayoutRequest(overrides: object = {}) {
  return {
    id: 'flow-payout-1',
    seniorId: USERS.senior.id,
    incomeAmount: '5000.00',
    payableAmount: '3700.00',
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

async function setupTransactionMocks(page: MockPage, tx: object, payoutReqs: object[] = []) {
  // More specific routes first (Playwright LIFO — last registered wins, so register generic last)
  await page.route(new RegExp(`${API}/transactions/senior-income/([^/?]+)$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...tx, status: 'PENDING', rejectionReason: null }) }),
  )
  await page.route(new RegExp(`${API}/transactions/([^/?]+)/(validate|pay|admin-edit)$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tx) }),
  )
  await page.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(tx) })
      : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([tx]) }),
  )
  await page.route(new RegExp(`${API}/payout-requests/([^/?]+)/pay$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(makePayoutRequest({ status: 'PAID', txHash: '0xdeadbeef' })) }),
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
// ШАГ 1: SENIOR регистрирует приход
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — шаг 1: регистрация прихода', () => {
  test('SENIOR открывает диалог создания и видит только тип SENIOR_INCOME', async ({ asSenior }) => {
    await setupTransactionMocks(asSenior, makeTx())
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Новая транзакция/i }).click()
    await expect(asSenior.getByRole('dialog')).toBeVisible()

    // У SENIOR доступен только один тип
    await expect(asSenior.getByRole('button', { name: /Приход синьора/i })).toBeVisible()
    await expect(asSenior.getByRole('button', { name: /Расход компании/i })).not.toBeVisible()
    await expect(asSenior.getByRole('button', { name: /Зарплата сотруднику/i })).not.toBeVisible()
  })

  test('SENIOR заполняет форму: сумма + валюта + проект', async ({ asSenior }) => {
    await setupTransactionMocks(asSenior, makeTx())
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Новая транзакция/i }).click()
    await expect(asSenior.getByRole('dialog')).toBeVisible()

    // Тип SENIOR_INCOME уже выбран (единственный)
    await asSenior.getByRole('button', { name: /Приход синьора/i }).click()

    // Диалог содержит выбор проекта
    await expect(asSenior.getByText(/Проект/i).first()).toBeVisible()

    // Выбираем проект
    await asSenior.getByRole('dialog').getByRole('combobox').first().click()
    await asSenior.getByRole('option', { name: PROJECT_NAME }).click()

    // Сумма
    await asSenior.getByRole('dialog').locator('input[type="number"]').first().fill('5000')
  })

  test('SENIOR создаёт транзакцию — диалог закрывается, строка PENDING появляется в таблице', async ({ asSenior }) => {
    const pendingTx = makeTx()
    // GET всегда возвращает строку (fixture уже создал её — мы просто проверяем рендер)
    await setupTransactionMocks(asSenior, pendingTx)

    await asSenior.goto('/crm/finance')
    // Проверяем что строка уже отображается
    await expect(asSenior.getByText('Ожидает')).toBeVisible()
    await expect(asSenior.getByText('Приход синьора')).toBeVisible()

    // Открываем диалог создания и создаём ещё одну транзакцию
    await asSenior.getByRole('button', { name: /Новая транзакция/i }).click()
    await asSenior.getByRole('button', { name: /Приход синьора/i }).click()
    await asSenior.getByRole('dialog').getByRole('combobox').first().click()
    await asSenior.getByRole('option', { name: PROJECT_NAME }).click()
    await asSenior.getByRole('dialog').locator('input[type="number"]').first().fill('5000')
    await asSenior.getByRole('button', { name: 'Создать транзакцию' }).click()

    // Диалог закрылся
    await expect(asSenior.getByRole('dialog')).not.toBeVisible()
  })

  test('SENIOR прикрепляет ссылку на чек при создании', async ({ asSenior }) => {
    await setupTransactionMocks(asSenior, makeTx({ receiptUrl: 'https://drive.google.com/receipt.pdf' }))
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Новая транзакция/i }).click()
    await asSenior.getByRole('button', { name: /Приход синьора/i }).click()
    // Выбираем проект
    await asSenior.getByRole('dialog').getByRole('combobox').first().click()
    await asSenior.getByRole('option', { name: PROJECT_NAME }).click()
    // Переключаемся на URL-режим чека
    await asSenior.getByRole('dialog').getByRole('button', { name: /Ссылка/i }).click()
    await asSenior.getByPlaceholder('https://...').fill('https://drive.google.com/receipt.pdf')
    await asSenior.getByRole('dialog').locator('input[type="number"]').first().fill('5000')
    await asSenior.getByRole('button', { name: 'Создать транзакцию' }).click()
    await expect(asSenior.getByRole('dialog')).not.toBeVisible()
  })

  test('SENIOR не может создать транзакцию без суммы — показывается ошибка', async ({ asSenior }) => {
    await setupTransactionMocks(asSenior, makeTx())
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Новая транзакция/i }).click()
    await asSenior.getByRole('button', { name: /Приход синьора/i }).click()
    // Выбираем проект, НЕ вводим сумму
    await asSenior.getByRole('dialog').getByRole('combobox').first().click()
    await asSenior.getByRole('option', { name: PROJECT_NAME }).click()

    // Нажимаем создать без суммы — mutation бросает ошибку
    await asSenior.getByRole('button', { name: 'Создать транзакцию' }).click()
    await expect(asSenior.getByRole('dialog').getByText(/некорректная сумма/i)).toBeVisible()
    // Диалог остаётся открытым
    await expect(asSenior.getByRole('dialog')).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ШАГ 2а: ACCOUNTANT/ADMIN отклоняет транзакцию
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — шаг 2а: отклонение транзакции', () => {
  test('ACCOUNTANT видит PENDING транзакцию с кнопкой "Проверить"', async ({ page }) => {
    const { mockAuthAs } = await import('./fixtures')
    await mockAuthAs(page, USERS.accountant)
    await setupTransactionMocks(page, makeTx())
    await page.goto('/crm/finance')

    await expect(page.getByText('Приход синьора')).toBeVisible()
    await expect(page.getByText('Ожидает')).toBeVisible()
    await expect(page.getByRole('button', { name: /Проверить/i })).toBeVisible()
  })

  test('ACCOUNTANT открывает диалог валидации — видит детали транзакции', async ({ page }) => {
    const { mockAuthAs } = await import('./fixtures')
    await mockAuthAs(page, USERS.accountant)
    await setupTransactionMocks(page, makeTx())
    await page.goto('/crm/finance')

    await page.getByRole('button', { name: /Проверить/i }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    // Детали транзакции видны в диалоге
    const dlg = page.getByRole('dialog')
    await expect(dlg.getByText('Приход синьора')).toBeVisible()
    await expect(dlg.getByText(/₮5,000/i).first()).toBeVisible()
    await expect(dlg.getByText(PROJECT_NAME)).toBeVisible()
    await expect(dlg.getByText(USERS.senior.displayName)).toBeVisible()
  })

  test('ACCOUNTANT не может нажать "Отклонить" без причины', async ({ page }) => {
    const { mockAuthAs } = await import('./fixtures')
    await mockAuthAs(page, USERS.accountant)
    await setupTransactionMocks(page, makeTx())
    await page.goto('/crm/finance')

    await page.getByRole('button', { name: /Проверить/i }).click()
    const rejectBtn = page.getByRole('button', { name: 'Отклонить' })
    await expect(rejectBtn).toBeDisabled()
  })

  test('ACCOUNTANT вводит причину — кнопка "Отклонить" разблокируется', async ({ page }) => {
    const { mockAuthAs } = await import('./fixtures')
    await mockAuthAs(page, USERS.accountant)
    await setupTransactionMocks(page, makeTx())
    await page.goto('/crm/finance')

    await page.getByRole('button', { name: /Проверить/i }).click()
    await page.getByPlaceholder('Укажите причину при отклонении...').fill('Чек нечитаем')
    await expect(page.getByRole('button', { name: 'Отклонить' })).not.toBeDisabled()
  })

  test('ACCOUNTANT отклоняет транзакцию — диалог закрывается', async ({ page }) => {
    const { mockAuthAs } = await import('./fixtures')
    await mockAuthAs(page, USERS.accountant)

    const pendingTx = makeTx()
    const rejectedTx = makeTx({ status: 'REJECTED', rejectionReason: 'Чек нечитаем' })
    // GET возвращает PENDING (кнопка Проверить видна), PATCH /validate возвращает REJECTED
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

    await expect(asSenior.getByText('Отклонено')).toBeVisible()
    await expect(asSenior.getByText('Чек нечитаем')).toBeVisible()
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

  test('SENIOR исправляет сумму и переотправляет — диалог закрывается', async ({ asSenior }) => {
    const rejectedTx = makeTx({ status: 'REJECTED', receiverId: USERS.senior.id, rejectionReason: 'Чек нечитаем' })
    await setupTransactionMocks(asSenior, rejectedTx)
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Исправить/i }).click()
    await asSenior.getByRole('dialog').locator('input[type="number"]').first().fill('5500')
    await asSenior.getByRole('button', { name: 'Переотправить' }).click()

    await expect(asSenior.getByRole('dialog')).not.toBeVisible()
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

  test('После исправления транзакция снова в статусе PENDING — нет кнопки "Исправить"', async ({ asSenior }) => {
    // Сначала REJECTED — потом mock возвращает PENDING после редактирования
    const rejectedTx = makeTx({ status: 'REJECTED', receiverId: USERS.senior.id, rejectionReason: 'Чек нечитаем' })
    const pendingTx = makeTx({ status: 'PENDING', receiverId: USERS.senior.id })

    let edited = false
    await asSenior.route(new RegExp(`${API}/transactions/senior-income/([^/?]+)$`), (r) => {
      edited = true
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pendingTx) })
    })
    await asSenior.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([edited ? pendingTx : rejectedTx]) }),
    )
    await asSenior.route(new RegExp(`${API}/payout-requests(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
    await asSenior.route(`${API}/projects`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: PROJECT_ID, name: PROJECT_NAME, seniorId: USERS.senior.id }]) }),
    )

    await asSenior.goto('/crm/finance')
    await asSenior.getByRole('button', { name: /Исправить/i }).click()
    await asSenior.getByRole('button', { name: 'Переотправить' }).click()
    await expect(asSenior.getByRole('dialog')).not.toBeVisible()

    // Статус PENDING, кнопка Исправить пропала
    await expect(asSenior.getByText('Ожидает')).toBeVisible()
    await expect(asSenior.getByRole('button', { name: /Исправить/i })).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ШАГ 3: ACCOUNTANT принимает транзакцию (повторная валидация)
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — шаг 3: повторная валидация (принятие)', () => {
  test('ACCOUNTANT принимает транзакцию — диалог закрывается', async ({ page }) => {
    const { mockAuthAs } = await import('./fixtures')
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

  test('После принятия SENIOR видит статус "Подтверждено" и кнопку "Выплатить"', async ({ asSenior }) => {
    const validatedTx = makeTx({ status: 'VALIDATED', senderId: USERS.senior.id, receiverId: USERS.senior.id })
    await setupTransactionMocks(asSenior, validatedTx)
    await asSenior.goto('/crm/finance')

    // Статус в таблице
    await expect(asSenior.getByText('Подтверждено')).toBeVisible()
    // Кнопка выплаты появилась (1 validated tx без payout)
    await expect(asSenior.getByRole('button', { name: /Выплатить \(1\)/i })).toBeVisible()
  })

  test('SENIOR не видит кнопку "Проверить" — это только для ACCOUNTANT/ADMIN', async ({ asSenior }) => {
    const validatedTx = makeTx({ status: 'PENDING', senderId: USERS.senior.id, receiverId: USERS.senior.id })
    await setupTransactionMocks(asSenior, validatedTx)
    await asSenior.goto('/crm/finance')

    await expect(asSenior.getByRole('button', { name: /Проверить/i })).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ШАГ 4: SENIOR создаёт запрос выплаты
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — шаг 4: создание запроса на выплату', () => {
  test('SENIOR открывает PayoutDialog — видит VALIDATED транзакцию в списке', async ({ asSenior }) => {
    const validatedTx = makeTx({ status: 'VALIDATED', senderId: USERS.senior.id, receiverId: USERS.senior.id })
    await setupTransactionMocks(asSenior, validatedTx)
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Выплатить/i }).click()
    const dialog = asSenior.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText(PROJECT_NAME)).toBeVisible()
    await expect(dialog.getByText(/₮5,000/i).first()).toBeVisible()
  })

  test('Кнопка "Далее" недоступна пока не выбрана ни одна транзакция', async ({ asSenior }) => {
    const validatedTx = makeTx({ status: 'VALIDATED', senderId: USERS.senior.id, receiverId: USERS.senior.id })
    await setupTransactionMocks(asSenior, validatedTx)
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Выплатить/i }).click()
    await expect(asSenior.getByRole('button', { name: 'Далее' })).toBeDisabled()
  })

  test('После выбора транзакции — виден расчёт суммы к оплате', async ({ asSenior }) => {
    const validatedTx = makeTx({ status: 'VALIDATED', senderId: USERS.senior.id, receiverId: USERS.senior.id })
    await setupTransactionMocks(asSenior, validatedTx)
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Выплатить/i }).click()
    const dialog = asSenior.getByRole('dialog')

    // Ставим чекбокс
    await dialog.locator('input[type="checkbox"]').first().click()

    // Появляется блок с суммой к оплате
    await expect(dialog.getByText(/К оплате/i)).toBeVisible()
    // 5000 * (1 - 26/100) = 3700
    await expect(dialog.getByText(/₮3[,.]?700/)).toBeVisible()
  })

  test('SENIOR нажимает "Далее" — переходит к шагу оплаты', async ({ asSenior }) => {
    const validatedTx = makeTx({ status: 'VALIDATED', senderId: USERS.senior.id, receiverId: USERS.senior.id })
    await setupTransactionMocks(asSenior, validatedTx)
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Выплатить/i }).click()
    const dialog = asSenior.getByRole('dialog')
    await dialog.locator('input[type="checkbox"]').first().click()
    await dialog.getByRole('button', { name: 'Далее' }).click()

    // Переходим к шагу 2 — "Подтвердить выплату"
    await expect(dialog.getByRole('heading', { name: /Подтвердить выплату/i })).toBeVisible()
    // Поле TX Hash
    await expect(dialog.getByPlaceholder('0x...')).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ШАГ 5: SENIOR оплачивает выплату
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — шаг 5: оплата выплаты', () => {
  test('Кнопка "Оплатить" недоступна без TX hash', async ({ asSenior }) => {
    const validatedTx = makeTx({ status: 'VALIDATED', senderId: USERS.senior.id, receiverId: USERS.senior.id })
    await setupTransactionMocks(asSenior, validatedTx)
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Выплатить/i }).click()
    const dialog = asSenior.getByRole('dialog')
    await dialog.locator('input[type="checkbox"]').first().click()
    await dialog.getByRole('button', { name: 'Далее' }).click()

    await expect(dialog.getByRole('button', { name: 'Оплатить' })).toBeDisabled()
  })

  test('SENIOR вводит TX hash — кнопка "Оплатить" разблокируется', async ({ asSenior }) => {
    const validatedTx = makeTx({ status: 'VALIDATED', senderId: USERS.senior.id, receiverId: USERS.senior.id })
    await setupTransactionMocks(asSenior, validatedTx)
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Выплатить/i }).click()
    const dialog = asSenior.getByRole('dialog')
    await dialog.locator('input[type="checkbox"]').first().click()
    await dialog.getByRole('button', { name: 'Далее' }).click()

    await dialog.getByPlaceholder('0x...').fill('0xdeadbeef123456')
    await expect(dialog.getByRole('button', { name: 'Оплатить' })).not.toBeDisabled()
  })

  test('SENIOR нажимает "Оплатить" — диалог закрывается', async ({ asSenior }) => {
    const validatedTx = makeTx({ status: 'VALIDATED', senderId: USERS.senior.id, receiverId: USERS.senior.id })
    await setupTransactionMocks(asSenior, validatedTx)
    await asSenior.goto('/crm/finance')

    await asSenior.getByRole('button', { name: /Выплатить/i }).click()
    const dialog = asSenior.getByRole('dialog')
    await dialog.locator('input[type="checkbox"]').first().click()
    await dialog.getByRole('button', { name: 'Далее' }).click()
    await dialog.getByPlaceholder('0x...').fill('0xdeadbeef123456')
    await dialog.getByRole('button', { name: 'Оплатить' }).click()

    await expect(dialog).not.toBeVisible()
  })

  test('После оплаты транзакция переходит в PAID — кнопка "Выплатить" исчезает', async ({ asSenior }) => {
    const validatedTx = makeTx({ status: 'VALIDATED', senderId: USERS.senior.id, receiverId: USERS.senior.id })
    const paidTx = makeTx({ status: 'PAID', senderId: USERS.senior.id, receiverId: USERS.senior.id, payoutRequestId: 'flow-payout-1' })

    let paid = false
    await asSenior.route(new RegExp(`${API}/payout-requests/([^/?]+)/pay$`), (r) => {
      paid = true
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(makePayoutRequest({ status: 'PAID', txHash: '0xdeadbeef' })) })
    })
    await asSenior.route(new RegExp(`${API}/payout-requests(\\?.*)?$`), (r) =>
      r.request().method() === 'POST'
        ? r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(makePayoutRequest()) })
        : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
    await asSenior.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([paid ? paidTx : validatedTx]) }),
    )
    await asSenior.route(`${API}/projects`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: PROJECT_ID, name: PROJECT_NAME, seniorId: USERS.senior.id }]) }),
    )

    await asSenior.goto('/crm/finance')

    // Шаги 4 + 5 в одном тесте
    await asSenior.getByRole('button', { name: /Выплатить/i }).click()
    const dialog = asSenior.getByRole('dialog')
    await dialog.locator('input[type="checkbox"]').first().click()
    await dialog.getByRole('button', { name: 'Далее' }).click()
    await dialog.getByPlaceholder('0x...').fill('0xdeadbeef123456')
    await dialog.getByRole('button', { name: 'Оплатить' }).click()
    await expect(dialog).not.toBeVisible()

    // Транзакция теперь PAID
    await expect(asSenior.getByText('Оплачено')).toBeVisible()
    // Кнопка выплаты исчезла — нет VALIDATED транзакций
    await expect(asSenior.getByRole('button', { name: /Выплатить/i })).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// ПОЛНЫЙ СКВОЗНОЙ ФЛОУ в одном тесте
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('SENIOR INCOME — полный сквозной флоу', () => {
  test('SENIOR создаёт → ACCOUNTANT отклоняет → SENIOR исправляет → ACCOUNTANT принимает → SENIOR выплачивает', async ({ browser }) => {
    // Два контекста: senior и accountant
    const seniorCtx = await browser.newContext()
    const accountantCtx = await browser.newContext()
    const seniorPage = await seniorCtx.newPage()
    const accountantPage = await accountantCtx.newPage()

    const { mockAuthAs } = await import('./fixtures')
    await mockAuthAs(seniorPage, USERS.senior)
    await mockAuthAs(accountantPage, USERS.accountant)

    // === ШАГ 1: SENIOR создаёт транзакцию ===
    const pendingTx = makeTx()
    let txState = { ...pendingTx }

    await seniorPage.route(new RegExp(`${API}/transactions/senior-income/([^/?]+)$`), (r) => {
      txState = { ...txState, status: 'PENDING', rejectionReason: null }
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(txState) })
    })
    await seniorPage.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) => {
      if (r.request().method() === 'POST') {
        txState = pendingTx
        return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(txState) })
      }
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([txState]) })
    })
    await seniorPage.route(new RegExp(`${API}/payout-requests(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
    await seniorPage.route(`${API}/projects`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: PROJECT_ID, name: PROJECT_NAME, seniorId: USERS.senior.id }]) }),
    )

    await seniorPage.goto('/crm/finance')
    await seniorPage.getByRole('button', { name: /Новая транзакция/i }).click()
    await seniorPage.getByRole('button', { name: /Приход синьора/i }).click()
    await seniorPage.getByRole('dialog').getByRole('combobox').first().click()
    await seniorPage.getByRole('option', { name: PROJECT_NAME }).click()
    await seniorPage.getByRole('dialog').locator('input[type="number"]').first().fill('5000')
    await seniorPage.getByRole('button', { name: 'Создать транзакцию' }).click()
    await expect(seniorPage.getByRole('dialog')).not.toBeVisible()
    await expect(seniorPage.getByText('Ожидает')).toBeVisible()

    // === ШАГ 2а: ACCOUNTANT отклоняет ===
    const rejectedTx = makeTx({ status: 'REJECTED', rejectionReason: 'Нет чека' })

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
    await expect(accountantPage.getByText('Ожидает')).toBeVisible()
    await accountantPage.getByRole('button', { name: /Проверить/i }).click()
    await accountantPage.getByPlaceholder('Укажите причину при отклонении...').fill('Нет чека')
    await accountantPage.getByRole('button', { name: 'Отклонить' }).click()
    await expect(accountantPage.getByRole('dialog')).not.toBeVisible()

    // === ШАГ 2б: SENIOR видит отклонение и исправляет ===
    txState = rejectedTx
    const correctedTx = makeTx({ status: 'PENDING', receiptUrl: 'https://drive.google.com/receipt.pdf' })

    await seniorPage.route(new RegExp(`${API}/transactions/senior-income/([^/?]+)$`), (r) => {
      txState = correctedTx
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(correctedTx) })
    })

    // Обновляем список транзакций для senior
    await seniorPage.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([txState]) }),
    )

    await seniorPage.goto('/crm/finance')
    await expect(seniorPage.getByText('Отклонено')).toBeVisible()
    await expect(seniorPage.getByText('Нет чека')).toBeVisible()
    await seniorPage.getByRole('button', { name: /Исправить/i }).click()
    await expect(seniorPage.getByText('Причина отклонения:')).toBeVisible()
    await seniorPage.getByRole('dialog').getByRole('button', { name: /Ссылка/i }).click()
    await seniorPage.getByPlaceholder('https://...').fill('https://drive.google.com/receipt.pdf')
    await seniorPage.getByRole('button', { name: 'Переотправить' }).click()
    await expect(seniorPage.getByRole('dialog')).not.toBeVisible()

    // === ШАГ 3: ACCOUNTANT принимает ===
    const validatedTx = makeTx({ status: 'VALIDATED', validatedBy: USERS.accountant.id, receiptUrl: 'https://drive.google.com/receipt.pdf' })

    await accountantPage.route(new RegExp(`${API}/transactions/([^/?]+)/(validate|pay|admin-edit)$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(validatedTx) }),
    )
    await accountantPage.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([correctedTx]) }),
    )

    await accountantPage.goto('/crm/finance')
    await accountantPage.getByRole('button', { name: /Проверить/i }).click()
    // Открывает чек (ссылка должна быть видна)
    await expect(accountantPage.getByText('Открыть')).toBeVisible()
    await accountantPage.getByRole('button', { name: 'Подтвердить' }).click()
    await expect(accountantPage.getByRole('dialog')).not.toBeVisible()

    // === ШАГ 4+5: SENIOR создаёт и оплачивает выплату ===
    const paidTx = makeTx({ status: 'PAID', senderId: USERS.senior.id, receiverId: USERS.senior.id, payoutRequestId: 'flow-payout-1' })
    let payoutPaid = false

    await seniorPage.route(new RegExp(`${API}/payout-requests/([^/?]+)/pay$`), (r) => {
      payoutPaid = true
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(makePayoutRequest({ status: 'PAID', txHash: '0xdeadbeef' })) })
    })
    await seniorPage.route(new RegExp(`${API}/payout-requests(\\?.*)?$`), (r) =>
      r.request().method() === 'POST'
        ? r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(makePayoutRequest()) })
        : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
    await seniorPage.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([payoutPaid ? paidTx : validatedTx]) }),
    )

    await seniorPage.goto('/crm/finance')
    await expect(seniorPage.getByText('Подтверждено')).toBeVisible()
    await expect(seniorPage.getByRole('button', { name: /Выплатить \(1\)/i })).toBeVisible()

    await seniorPage.getByRole('button', { name: /Выплатить/i }).click()
    const dialog = seniorPage.getByRole('dialog')
    await dialog.locator('input[type="checkbox"]').first().click()
    await expect(dialog.getByText(/₮3[,.]?700/)).toBeVisible()
    await dialog.getByRole('button', { name: 'Далее' }).click()
    await expect(dialog.getByRole('heading', { name: /Подтвердить выплату/i })).toBeVisible()
    await dialog.getByPlaceholder('0x...').fill('0xdeadbeef123456')
    await dialog.getByRole('button', { name: 'Оплатить' }).click()
    await expect(dialog).not.toBeVisible()

    // Финальный статус: транзакция PAID, кнопка выплаты исчезла
    await expect(seniorPage.getByText('Оплачено')).toBeVisible()
    await expect(seniorPage.getByRole('button', { name: /Выплатить/i })).not.toBeVisible()

    await seniorCtx.close()
    await accountantCtx.close()
  })
})
