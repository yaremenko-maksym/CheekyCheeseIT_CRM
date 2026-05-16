import { test, expect, USERS, PROJECTS, dismissDialog } from './fixtures'

const PROJECT = PROJECTS[0]!
const PROJECT_ID = PROJECT.id
const PROJECT_NAME = PROJECT.name

const API = 'http://localhost:3001/api'

// ── Shared transaction fixtures ────────────────────────────────────────────────

const TX_PENDING_SENIOR: object = {
  id: 'tx-pending-senior',
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
}

const TX_REJECTED_SENIOR: object = {
  ...TX_PENDING_SENIOR,
  id: 'tx-rejected-senior',
  status: 'REJECTED',
  rejectionReason: 'Чек недействителен',
}

const TX_VALIDATED_SENIOR: object = {
  ...TX_PENDING_SENIOR,
  id: 'tx-validated-senior',
  status: 'VALIDATED',
  validatedBy: USERS.accountant.id,
  validatedAt: '2026-05-02T10:00:00.000Z',
}

const TX_SALARY_PENDING: object = {
  id: 'tx-salary-pending',
  type: 'SALARY',
  status: 'PENDING',
  amount: '1000.00',
  currency: 'UAH',
  senderId: USERS.admin.id,
  senderName: USERS.admin.displayName,
  senderLabel: null,
  receiverId: USERS.hr.id,
  receiverName: USERS.hr.displayName,
  receiverLabel: null,
  projectId: null,
  projectName: null,
  receiptUrl: null,
  notes: null,
  salaryMonth: '2026-05',
  txHash: null,
  rejectionReason: null,
  payoutRequestId: null,
  validatedBy: null,
  validatedAt: null,
  createdAt: '2026-05-01T09:00:00.000Z',
  updatedAt: '2026-05-01T09:00:00.000Z',
}

const TX_EXPENSE: object = {
  id: 'tx-expense',
  type: 'EXPENSE',
  status: 'PAID',
  amount: '200.00',
  currency: 'USD',
  senderId: USERS.admin.id,
  senderName: USERS.admin.displayName,
  senderLabel: null,
  receiverId: null,
  receiverName: null,
  receiverLabel: 'Хостинг',
  projectId: null,
  projectName: null,
  receiptUrl: null,
  notes: 'AWS monthly',
  salaryMonth: null,
  txHash: null,
  rejectionReason: null,
  payoutRequestId: null,
  validatedBy: null,
  validatedAt: null,
  createdAt: '2026-05-03T08:00:00.000Z',
  updatedAt: '2026-05-03T08:00:00.000Z',
}

const TX_SALARY_HR: object = {
  ...TX_SALARY_PENDING,
  id: 'tx-salary-hr',
  status: 'PAID',
  receiverId: USERS.hr.id,
  receiverName: USERS.hr.displayName,
}

const TX_SALARY_JUNIOR: object = {
  ...TX_SALARY_PENDING,
  id: 'tx-salary-junior',
  status: 'PAID',
  receiverId: USERS.junior.id,
  receiverName: USERS.junior.displayName,
  txHash: '0xabc123def456789',
}

// ── Helper: mock transactions endpoint ────────────────────────────────────────

async function mockTransactions(page: import('@playwright/test').Page, rows: object[]) {
  await page.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) => {
    if (r.request().method() === 'POST') {
      return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...TX_PENDING_SENIOR, id: 'tx-new' }) })
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) })
  })
  await page.route(new RegExp(`${API}/transactions/([^/?]+)$`), (r) => {
    const id = r.request().url().split('/').at(-1)!
    const found = rows.find((t) => (t as { id: string }).id === id) ?? rows[0]
    if (r.request().method() === 'DELETE') {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ deleted: true }) })
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...(found as object), ...(JSON.parse(r.request().postData() ?? '{}') as object) }) })
  })
  await page.route(new RegExp(`${API}/transactions/([^/?]+)/(validate|pay|admin-edit)`), (r) => {
    const id = r.request().url().split('/').at(-2)!
    const found = rows.find((t) => (t as { id: string }).id === id) ?? rows[0]
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...(found as object) }) })
  })
  await page.route(new RegExp(`${API}/transactions/senior-income/([^/?]+)$`), (r) => {
    const id = r.request().url().split('/').at(-1)!
    const found = rows.find((t) => (t as { id: string }).id === id) ?? rows[0]
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...(found as object), status: 'PENDING' }) })
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. PAGE LOAD — роли
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Finance — page load', () => {
  test('ADMIN: отображает заголовок и кнопку создания', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [])
    await asAdmin.goto('/crm/finance')
    await expect(asAdmin.getByRole('heading', { name: 'Финансы' })).toBeVisible()
    await expect(asAdmin.getByRole('button', { name: /Новая транзакция/i })).toBeVisible()
  })

  test('SENIOR: видит кнопку создания, нет кнопки Выплатить без валидированных', async ({ asSenior }) => {
    await mockTransactions(asSenior, [])
    await asSenior.goto('/crm/finance')
    await expect(asSenior.getByRole('button', { name: /Новая транзакция/i })).toBeVisible()
    await expect(asSenior.getByRole('button', { name: /Выплатить/i })).not.toBeVisible()
  })

  test('SENIOR: кнопка Выплатить появляется при наличии валидированных транзакций', async ({ asSenior }) => {
    const validatedTx = { ...TX_VALIDATED_SENIOR, senderId: USERS.senior.id }
    await mockTransactions(asSenior, [validatedTx])
    await asSenior.goto('/crm/finance')
    await expect(asSenior.getByRole('button', { name: /Выплатить/i })).toBeVisible()
  })

  test('HR: видит только заголовок "История ваших выплат", нет кнопки создания', async ({ asHr }) => {
    await mockTransactions(asHr, [TX_SALARY_HR])
    await asHr.goto('/crm/finance')
    await expect(asHr.getByText(/история ваших выплат/i)).toBeVisible()
    await expect(asHr.getByRole('button', { name: /Новая транзакция/i })).not.toBeVisible()
  })

  test('JUNIOR: видит "Ваши выплаты", столбец TX Hash', async ({ asJunior }) => {
    await mockTransactions(asJunior, [TX_SALARY_JUNIOR])
    await asJunior.goto('/crm/finance')
    await expect(asJunior.getByText(/ваши выплаты/i)).toBeVisible()
    await expect(asJunior.getByText(/TX Hash/i)).toBeVisible()
  })

  test('ACCOUNTANT: видит полную таблицу, нет кнопки создания', async ({ page }) => {
    await (await import('./fixtures')).mockAuthAs(page, USERS.accountant)
    await mockTransactions(page, [TX_PENDING_SENIOR])
    await page.goto('/crm/finance')
    await expect(page.getByRole('heading', { name: 'Финансы' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Новая транзакция/i })).not.toBeVisible()
  })

  test('пустое состояние: "Нет данных"', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [])
    await asAdmin.goto('/crm/finance')
    await expect(asAdmin.getByText('Нет данных')).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 2. ТАБЛИЦА — рендер строк, статусы, типы
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Finance — таблица транзакций', () => {
  test('ADMIN: отображает строки для всех типов транзакций', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_PENDING_SENIOR, TX_EXPENSE, TX_SALARY_PENDING])
    await asAdmin.goto('/crm/finance')
    await expect(asAdmin.getByText('Приход синьора')).toBeVisible()
    await expect(asAdmin.getByText('Расход')).toBeVisible()
    await expect(asAdmin.getByText('Зарплата')).toBeVisible()
  })

  test('ADMIN: статус-бейдж "Ожидает" виден на PENDING транзакции', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_PENDING_SENIOR])
    await asAdmin.goto('/crm/finance')
    await expect(asAdmin.getByText('Ожидает')).toBeVisible()
  })

  test('ADMIN: статус-бейдж "Отклонено" и причина на REJECTED транзакции', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_REJECTED_SENIOR])
    await asAdmin.goto('/crm/finance')
    await expect(asAdmin.getByText('Отклонено')).toBeVisible()
    await expect(asAdmin.getByText('Чек недействителен')).toBeVisible()
  })

  test('SENIOR: видит только свою REJECTED транзакцию с кнопкой "Исправить"', async ({ asSenior }) => {
    const myRejected = { ...TX_REJECTED_SENIOR, senderId: USERS.senior.id, receiverId: USERS.senior.id }
    await mockTransactions(asSenior, [myRejected])
    await asSenior.goto('/crm/finance')
    await expect(asSenior.getByRole('button', { name: /Исправить/i })).toBeVisible()
  })

  test('ADMIN/ACCOUNTANT: кнопка "Проверить" видна на PENDING SENIOR_INCOME', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_PENDING_SENIOR])
    await asAdmin.goto('/crm/finance')
    await expect(asAdmin.getByRole('button', { name: /Проверить/i })).toBeVisible()
  })

  test('ADMIN: кнопки редактирования и удаления видны на не-PAYOUT транзакциях', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_PENDING_SENIOR, TX_EXPENSE])
    await asAdmin.goto('/crm/finance')
    // Два edit и два delete (по одному на каждую строку)
    await expect(asAdmin.getByTitle('Редактировать').first()).toBeVisible()
    await expect(asAdmin.getByTitle('Удалить').first()).toBeVisible()
  })

  test('ADMIN: кнопка "Выплатить" видна на SALARY PENDING', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_SALARY_PENDING])
    await asAdmin.goto('/crm/finance')
    await expect(asAdmin.getByRole('button', { name: 'Выплатить' })).toBeVisible()
  })

  test('HR: видит свои выплаты в упрощённой таблице', async ({ asHr }) => {
    await mockTransactions(asHr, [TX_SALARY_HR])
    await asHr.goto('/crm/finance')
    await expect(asHr.getByText('₴1,000.00')).toBeVisible()
    await expect(asHr.getByText('2026-05')).toBeVisible()
  })

  test('JUNIOR: видит txHash в таблице', async ({ asJunior }) => {
    await mockTransactions(asJunior, [TX_SALARY_JUNIOR])
    await asJunior.goto('/crm/finance')
    // Hash truncated to 14 chars + …
    await expect(asJunior.getByText(/0xabc123def456/i)).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 3. ФИЛЬТРЫ И ПОИСК
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Finance — фильтры и поиск', () => {
  test('поиск фильтрует строки по имени', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_PENDING_SENIOR, TX_EXPENSE])
    await asAdmin.goto('/crm/finance')
    // Убеждаемся что обе строки видны
    await expect(asAdmin.getByText('Приход синьора')).toBeVisible()
    await expect(asAdmin.getByText('Расход')).toBeVisible()
    // Ищем по имени senior
    await asAdmin.getByPlaceholder('Поиск…').fill(USERS.senior.displayName)
    await expect(asAdmin.getByText('Приход синьора')).toBeVisible()
    // Расход не содержит имя seniorа
    await expect(asAdmin.getByText('Расход')).not.toBeVisible()
  })

  test('поиск без результатов показывает "Ничего не найдено"', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_PENDING_SENIOR])
    await asAdmin.goto('/crm/finance')
    await asAdmin.getByPlaceholder('Поиск…').fill('zzznomatch')
    await expect(asAdmin.getByText('Ничего не найдено')).toBeVisible()
  })

  test('кнопка "Сбросить" появляется при активном фильтре и очищает его', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_PENDING_SENIOR])
    await asAdmin.goto('/crm/finance')
    await asAdmin.getByPlaceholder('Поиск…').fill('что-то')
    await expect(asAdmin.getByRole('button', { name: /Сбросить/i })).toBeVisible()
    await asAdmin.getByRole('button', { name: /Сбросить/i }).click()
    await expect(asAdmin.getByPlaceholder('Поиск…')).toHaveValue('')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 4. СОЗДАНИЕ ТРАНЗАКЦИИ — CreateTransactionDialog
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Finance — создание транзакции', () => {
  test('ADMIN: открывает диалог создания', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [])
    await asAdmin.goto('/crm/finance')
    await asAdmin.getByRole('button', { name: /Новая транзакция/i }).click()
    await expect(asAdmin.getByRole('dialog')).toBeVisible()
    await expect(asAdmin.getByRole('heading', { name: /Новая транзакция/i })).toBeVisible()
  })

  test('ADMIN: закрывает диалог по кнопке Отмена', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [])
    await asAdmin.goto('/crm/finance')
    await asAdmin.getByRole('button', { name: /Новая транзакция/i }).click()
    await dismissDialog(asAdmin)
    await expect(asAdmin.getByRole('dialog')).not.toBeVisible()
  })

  test('SENIOR: открывает диалог, видит только SENIOR_INCOME', async ({ asSenior }) => {
    await mockTransactions(asSenior, [])
    await asSenior.goto('/crm/finance')
    await asSenior.getByRole('button', { name: /Новая транзакция/i }).click()
    await expect(asSenior.getByRole('dialog')).toBeVisible()
    await expect(asSenior.getByText('Приход синьора')).toBeVisible()
    await expect(asSenior.getByText('Приход Admin')).not.toBeVisible()
  })

  test('ADMIN: создаёт EXPENSE транзакцию', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [])
    await asAdmin.route(`${API}/projects`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: PROJECT_ID, name: PROJECT_NAME, seniorId: USERS.senior.id }]) }),
    )
    await asAdmin.route(`${API}/users`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([USERS.senior, USERS.junior]) }),
    )
    await asAdmin.goto('/crm/finance')
    await asAdmin.getByRole('button', { name: /Новая транзакция/i }).click()
    await expect(asAdmin.getByRole('dialog')).toBeVisible()

    // ADMIN видит EXPENSE (Расход) в списке типов — кликаем по кнопке-карточке
    await asAdmin.getByRole('button', { name: /Расход компании/i }).click()

    // Заполняем сумму
    const dialog = asAdmin.getByRole('dialog')
    await dialog.locator('input[type="number"]').first().fill('500')

    // Нажимаем Создать
    await asAdmin.getByRole('button', { name: 'Создать' }).click()
    await expect(asAdmin.getByRole('dialog')).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 5. ВАЛИДАЦИЯ / ОТКЛОНЕНИЕ — ValidateDialog
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Finance — валидация транзакции', () => {
  test('ADMIN: открывает диалог валидации по "Проверить"', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_PENDING_SENIOR])
    await asAdmin.goto('/crm/finance')
    await asAdmin.getByRole('button', { name: /Проверить/i }).click()
    await expect(asAdmin.getByRole('dialog')).toBeVisible()
    await expect(asAdmin.getByRole('heading', { name: /Валидация транзакции/i })).toBeVisible()
  })

  test('ADMIN: валидирует транзакцию кнопкой Подтвердить', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_PENDING_SENIOR])
    await asAdmin.goto('/crm/finance')
    await asAdmin.getByRole('button', { name: /Проверить/i }).click()
    await asAdmin.getByRole('button', { name: 'Подтвердить' }).click()
    await expect(asAdmin.getByRole('dialog')).not.toBeVisible()
  })

  test('ADMIN: отклоняет транзакцию — требует причину', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_PENDING_SENIOR])
    await asAdmin.goto('/crm/finance')
    await asAdmin.getByRole('button', { name: /Проверить/i }).click()

    // Нажимаем Отклонить без причины — кнопка должна быть disabled
    const rejectBtn = asAdmin.getByRole('button', { name: 'Отклонить' })
    await expect(rejectBtn).toBeDisabled()

    // Вводим причину
    await asAdmin.getByPlaceholder('Укажите причину при отклонении...').fill('Чек не подходит')
    await expect(rejectBtn).not.toBeDisabled()
    await rejectBtn.click()
    await expect(asAdmin.getByRole('dialog')).not.toBeVisible()
  })

  test('ACCOUNTANT: тоже видит кнопку Проверить и может валидировать', async ({ page }) => {
    const { mockAuthAs } = await import('./fixtures')
    await mockAuthAs(page, USERS.accountant)
    await mockTransactions(page, [TX_PENDING_SENIOR])
    await page.goto('/crm/finance')
    await expect(page.getByRole('button', { name: /Проверить/i })).toBeVisible()
    await page.getByRole('button', { name: /Проверить/i }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button', { name: 'Подтвердить' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 6. ИСПРАВЛЕНИЕ ОТКЛОНЁННОЙ ТРАНЗАКЦИИ — EditSeniorIncomeDialog
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Finance — исправление REJECTED транзакции (SENIOR)', () => {
  test('SENIOR: открывает диалог исправления', async ({ asSenior }) => {
    const myRejected = { ...TX_REJECTED_SENIOR, senderId: USERS.senior.id, receiverId: USERS.senior.id }
    await mockTransactions(asSenior, [myRejected])
    await asSenior.goto('/crm/finance')
    await asSenior.getByRole('button', { name: /Исправить/i }).click()
    await expect(asSenior.getByRole('dialog')).toBeVisible()
    await expect(asSenior.getByRole('heading', { name: /Исправить транзакцию/i })).toBeVisible()
  })

  test('SENIOR: показывает причину отклонения в диалоге', async ({ asSenior }) => {
    const myRejected = { ...TX_REJECTED_SENIOR, senderId: USERS.senior.id, receiverId: USERS.senior.id }
    await mockTransactions(asSenior, [myRejected])
    await asSenior.goto('/crm/finance')
    await asSenior.getByRole('button', { name: /Исправить/i }).click()
    await expect(asSenior.getByText('Причина отклонения:')).toBeVisible()
    // rejectionReason из фикстуры
    await expect(asSenior.getByRole('dialog').getByText('Чек недействителен')).toBeVisible()
  })

  test('SENIOR: исправляет транзакцию и переотправляет', async ({ asSenior }) => {
    const myRejected = { ...TX_REJECTED_SENIOR, senderId: USERS.senior.id, receiverId: USERS.senior.id }
    await mockTransactions(asSenior, [myRejected])
    await asSenior.route(`${API}/projects`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: PROJECT_ID, name: PROJECT_NAME, seniorId: USERS.senior.id }]) }),
    )
    await asSenior.goto('/crm/finance')
    await asSenior.getByRole('button', { name: /Исправить/i }).click()
    await expect(asSenior.getByRole('dialog')).toBeVisible()

    // Меняем сумму
    const dialog = asSenior.getByRole('dialog')
    await dialog.locator('input[type="number"]').first().fill('5500')

    await asSenior.getByRole('button', { name: 'Переотправить' }).click()
    await expect(asSenior.getByRole('dialog')).not.toBeVisible()
  })

  test('SENIOR: может добавить ссылку на чек через переключатель Ссылка', async ({ asSenior }) => {
    const myRejected = { ...TX_REJECTED_SENIOR, senderId: USERS.senior.id, receiverId: USERS.senior.id }
    await mockTransactions(asSenior, [myRejected])
    await asSenior.route(`${API}/projects`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: PROJECT_ID, name: PROJECT_NAME, seniorId: USERS.senior.id }]) }),
    )
    await asSenior.goto('/crm/finance')
    await asSenior.getByRole('button', { name: /Исправить/i }).click()
    await expect(asSenior.getByRole('dialog')).toBeVisible()

    // Переключаем на ссылку — кнопка "Ссылка" в ReceiptInput
    await asSenior.getByRole('dialog').getByRole('button', { name: /Ссылка/i }).click()
    await asSenior.getByPlaceholder('https://...').fill('https://drive.google.com/receipt.pdf')

    await asSenior.getByRole('button', { name: 'Переотправить' }).click()
    await expect(asSenior.getByRole('dialog')).not.toBeVisible()
  })

  test('SENIOR: не видит кнопку Исправить на PENDING транзакции', async ({ asSenior }) => {
    const myPending = { ...TX_PENDING_SENIOR, senderId: USERS.senior.id, receiverId: USERS.senior.id }
    await mockTransactions(asSenior, [myPending])
    await asSenior.goto('/crm/finance')
    await expect(asSenior.getByRole('button', { name: /Исправить/i })).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 7. ADMIN EDIT — AdminEditTransactionDialog
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Finance — редактирование транзакции (ADMIN)', () => {
  test('ADMIN: открывает диалог редактирования', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_PENDING_SENIOR])
    await asAdmin.goto('/crm/finance')
    await asAdmin.getByTitle('Редактировать').first().click()
    await expect(asAdmin.getByRole('dialog')).toBeVisible()
    await expect(asAdmin.getByRole('heading', { name: /Редактировать транзакцию/i })).toBeVisible()
  })

  test('ADMIN: сохраняет изменения', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_PENDING_SENIOR])
    await asAdmin.goto('/crm/finance')
    await asAdmin.getByTitle('Редактировать').first().click()
    await expect(asAdmin.getByRole('dialog')).toBeVisible()

    // Поле суммы — input type=number внутри диалога
    const dialog = asAdmin.getByRole('dialog')
    const amountInput = dialog.locator('input[type="number"]').first()
    await amountInput.fill('5500')

    await asAdmin.getByRole('button', { name: 'Сохранить' }).click()
    await expect(asAdmin.getByRole('dialog')).not.toBeVisible()
  })

  test('ADMIN: отменяет редактирование', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_PENDING_SENIOR])
    await asAdmin.goto('/crm/finance')
    await asAdmin.getByTitle('Редактировать').first().click()
    await dismissDialog(asAdmin)
    await expect(asAdmin.getByRole('dialog')).not.toBeVisible()
  })

  test('SENIOR: не видит кнопку Редактировать (иконка без title)', async ({ asSenior }) => {
    const myPending = { ...TX_PENDING_SENIOR, senderId: USERS.senior.id, receiverId: USERS.senior.id }
    await mockTransactions(asSenior, [myPending])
    await asSenior.goto('/crm/finance')
    await expect(asSenior.getByTitle('Редактировать')).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 8. УДАЛЕНИЕ ТРАНЗАКЦИИ
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Finance — удаление транзакции (ADMIN)', () => {
  test('ADMIN: открывает диалог подтверждения удаления', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_EXPENSE])
    await asAdmin.goto('/crm/finance')
    await asAdmin.getByTitle('Удалить').first().click()
    await expect(asAdmin.getByRole('dialog')).toBeVisible()
    await expect(asAdmin.getByText(/удалить транзакцию/i)).toBeVisible()
  })

  test('ADMIN: отменяет удаление', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_EXPENSE])
    await asAdmin.goto('/crm/finance')
    await asAdmin.getByTitle('Удалить').first().click()
    await asAdmin.getByRole('button', { name: /Отмена/i }).click()
    await expect(asAdmin.getByRole('dialog')).not.toBeVisible()
  })

  test('ADMIN: подтверждает удаление', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_EXPENSE])
    await asAdmin.goto('/crm/finance')
    await asAdmin.getByTitle('Удалить').first().click()
    await asAdmin.getByRole('button', { name: /Удалить/i }).last().click()
    await expect(asAdmin.getByRole('dialog')).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 9. ВЫПЛАТА ЗАРПЛАТЫ — PaySalaryDialog
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Finance — выплата зарплаты (ADMIN)', () => {
  test('ADMIN: открывает диалог выплаты зарплаты', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_SALARY_PENDING])
    await asAdmin.goto('/crm/finance')
    await asAdmin.getByRole('button', { name: 'Выплатить' }).click()
    await expect(asAdmin.getByRole('dialog')).toBeVisible()
  })

  test('ADMIN: выплачивает зарплату с TX hash', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_SALARY_PENDING])
    await asAdmin.goto('/crm/finance')
    await asAdmin.getByRole('button', { name: 'Выплатить' }).click()
    await expect(asAdmin.getByRole('dialog')).toBeVisible()

    const hashInput = asAdmin.getByPlaceholder('0x...')
    await hashInput.fill('0xabc123def456')

    await asAdmin.getByRole('button', { name: 'Отметить как оплачено' }).click()
    await expect(asAdmin.getByRole('dialog')).not.toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 10. ЗАПРОС ВЫПЛАТЫ — PayoutDialog (SENIOR)
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Finance — запрос выплаты (SENIOR)', () => {
  test('SENIOR: открывает диалог выплаты при наличии VALIDATED транзакций', async ({ asSenior }) => {
    const validatedTx = { ...TX_VALIDATED_SENIOR, senderId: USERS.senior.id }
    await mockTransactions(asSenior, [validatedTx])
    // payout-requests мокаем пустым
    await asSenior.route(new RegExp(`${API}/payout-requests(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
    await asSenior.goto('/crm/finance')
    await expect(asSenior.getByRole('button', { name: /Выплатить/i })).toBeVisible()
    await asSenior.getByRole('button', { name: /Выплатить/i }).click()
    await expect(asSenior.getByRole('dialog')).toBeVisible()
  })

  test('SENIOR: диалог выплаты показывает список транзакций', async ({ asSenior }) => {
    const validatedTx = { ...TX_VALIDATED_SENIOR, senderId: USERS.senior.id }
    await mockTransactions(asSenior, [validatedTx])
    await asSenior.route(new RegExp(`${API}/payout-requests(\\?.*)?$`), (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }),
    )
    await asSenior.goto('/crm/finance')
    await asSenior.getByRole('button', { name: /Выплатить/i }).click()
    await expect(asSenior.getByRole('dialog')).toBeVisible()
    // Транзакция ₮5,000.00 должна быть в диалоге
    await expect(asSenior.getByRole('dialog').getByText(/₮5,000/i).first()).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 11. ДЕТАЛИ ТРАНЗАКЦИИ — TransactionDetailDialog
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Finance — детали транзакции', () => {
  test('ADMIN: клик по строке открывает диалог деталей', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_PENDING_SENIOR])
    await asAdmin.goto('/crm/finance')
    // Кликаем по типу-бейджу (первая ячейка строки)
    await asAdmin.getByText('Приход синьора').first().click()
    await expect(asAdmin.getByRole('dialog')).toBeVisible()
  })

  test('ADMIN: диалог деталей показывает сумму и статус', async ({ asAdmin }) => {
    await mockTransactions(asAdmin, [TX_PENDING_SENIOR])
    await asAdmin.goto('/crm/finance')
    await asAdmin.getByText('Приход синьора').first().click()
    await expect(asAdmin.getByRole('dialog')).toBeVisible()
    // Сумма или статус присутствуют
    await expect(asAdmin.getByText(/₮5,000/i).first()).toBeVisible()
  })
})

// ═══════════════════════════════════════════════════════════════════════════════
// 12. RBAC — видимость кнопок по ролям
// ═══════════════════════════════════════════════════════════════════════════════

test.describe('Finance — RBAC', () => {
  test('HR: не видит кнопки действий (validate/edit/delete)', async ({ asHr }) => {
    await mockTransactions(asHr, [TX_SALARY_HR])
    await asHr.goto('/crm/finance')
    await expect(asHr.getByRole('button', { name: /Проверить/i })).not.toBeVisible()
    await expect(asHr.getByTitle('Редактировать')).not.toBeVisible()
    await expect(asHr.getByTitle('Удалить')).not.toBeVisible()
  })

  test('JUNIOR: не видит кнопки действий', async ({ asJunior }) => {
    await mockTransactions(asJunior, [TX_SALARY_JUNIOR])
    await asJunior.goto('/crm/finance')
    await expect(asJunior.getByRole('button', { name: /Проверить/i })).not.toBeVisible()
    await expect(asJunior.getByTitle('Редактировать')).not.toBeVisible()
  })

  test('SENIOR: не видит кнопку Проверить', async ({ asSenior }) => {
    const myPending = { ...TX_PENDING_SENIOR, senderId: USERS.senior.id, receiverId: USERS.senior.id }
    await mockTransactions(asSenior, [myPending])
    await asSenior.goto('/crm/finance')
    await expect(asSenior.getByRole('button', { name: /Проверить/i })).not.toBeVisible()
  })

  test('SENIOR: не видит кнопку удаления', async ({ asSenior }) => {
    const myPending = { ...TX_PENDING_SENIOR, senderId: USERS.senior.id, receiverId: USERS.senior.id }
    await mockTransactions(asSenior, [myPending])
    await asSenior.goto('/crm/finance')
    await expect(asSenior.getByTitle('Удалить')).not.toBeVisible()
  })

  test('SENIOR: видит кнопку Исправить только на своей REJECTED транзакции', async ({ asSenior }) => {
    const notMine = { ...TX_REJECTED_SENIOR, id: 'not-mine', senderId: 'other-id', receiverId: 'other-id' }
    await mockTransactions(asSenior, [notMine])
    await asSenior.goto('/crm/finance')
    await expect(asSenior.getByRole('button', { name: /Исправить/i })).not.toBeVisible()
  })
})
