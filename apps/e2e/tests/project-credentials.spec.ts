/**
 * project-credentials.spec.ts — PR #178 «Пароли проекта»
 *
 * Покрывает AC7 (UI) и AC9 (playwright coverage):
 *
 * JUNIOR /project (хаб):
 *   - Карточка «Пароли проекта» видна (credentials-section)
 *   - Empty state: «Нет сохранённых паролей» — кнопка «Добавить» ОТСУТСТВУЕТ
 *   - Список: label/login видны, пароль маской (••••••••), edit/delete ОТСУТСТВУЮТ
 *   - Reveal: клик глаза → fetch reveal → plaintext виден; повторный клик скрывает
 *   - Reveal: кнопка copy появляется при открытом пароле
 *   - Reveal error 403 → inline error, plaintext не виден
 *   - 403 на list → секция скрыта, не error-краш
 *
 * ADMIN /projects/$projectId (overview):
 *   - Секция видна, add/edit/delete доступны
 *   - Add-диалог: открывается, cancel закрывает
 *   - Submit add-диалога → диалог закрывается, список обновляется
 *   - Delete: confirm-диалог → после подтверждения элемент исчезает
 *   - Reveal: plaintext виден, повторный клик скрывает
 *
 * SENIOR → credentials-section отсутствует (canManageCredentials=false на странице)
 *
 * ВАЖНО: все credential-фикстуры используют настоящие UUID —
 *   projectCredentialSchema требует z.string().uuid() для id и projectId.
 *   Нарушение → Zod parse throws → useCredentials возвращает null → секция прячется.
 *
 * Паттерн: все per-test моки регистрируются в теле теста ПОСЛЕ fixture setup
 *   (LIFO — позже зарегистрированный обработчик побеждает дефолтный из mockAuthAs).
 */

import { test, expect, USERS } from './fixtures'

const API = 'http://localhost:3001/api'

// ---------------------------------------------------------------------------
// Project IDs — UUID-format (обязательно для Zod-схем)
// ---------------------------------------------------------------------------

/** Junior hub project ID — используется в /project */
const JUNIOR_PROJECT_ID = 'a0000000-0000-4000-8000-000000000099'

/** Admin project detail ID — из PROJECTS[0] в фикстурах */
const ADMIN_PROJECT_ID = 'a0000000-0000-4000-8000-000000000010'

// ---------------------------------------------------------------------------
// Credential fixtures — все UUID валидные
// ---------------------------------------------------------------------------

const CRED_ID_1 = 'd0000000-0000-4000-8000-000000000001'
const CRED_ID_2 = 'd0000000-0000-4000-8000-000000000002'

/** Credential для junior-hub */
const CREDENTIAL_JUNIOR_1 = {
  id: CRED_ID_1,
  projectId: JUNIOR_PROJECT_ID,
  label: 'GitHub',
  login: 'john.doe@company.com',
  url: 'https://github.com',
  notes: null,
  createdAt: '2024-01-15T00:00:00.000Z',
  updatedAt: '2024-01-15T00:00:00.000Z',
}

const CREDENTIAL_JUNIOR_2 = {
  id: CRED_ID_2,
  projectId: JUNIOR_PROJECT_ID,
  label: 'Jira',
  login: 'john.doe',
  url: 'https://jira.company.com',
  notes: null,
  createdAt: '2024-01-16T00:00:00.000Z',
  updatedAt: '2024-01-16T00:00:00.000Z',
}

/** Credential для admin project detail */
const CREDENTIAL_ADMIN_1 = {
  id: CRED_ID_1,
  projectId: ADMIN_PROJECT_ID,
  label: 'GitHub',
  login: 'admin@company.com',
  url: 'https://github.com',
  notes: null,
  createdAt: '2024-01-15T00:00:00.000Z',
  updatedAt: '2024-01-15T00:00:00.000Z',
}

const CREDENTIAL_ADMIN_2 = {
  id: CRED_ID_2,
  projectId: ADMIN_PROJECT_ID,
  label: 'Jira',
  login: null,
  url: null,
  notes: null,
  createdAt: '2024-01-16T00:00:00.000Z',
  updatedAt: '2024-01-16T00:00:00.000Z',
}

/** Plaintext для reveal */
const PLAINTEXT_PASSWORD = 'p4ssw0rd!2024$'

// ---------------------------------------------------------------------------
// Junior hub project fixture — masked (seniorId/rate скрыты для JUNIOR)
// ---------------------------------------------------------------------------

const JUNIOR_PROJECT = {
  id: JUNIOR_PROJECT_ID,
  name: 'AI Platform v2',
  companyName: 'TechCorp AI',
  domain: 'AI',
  logoDocumentId: null as string | null,
  logoExternalUrl: null as string | null,
  seniorId: null as string | null,
  seniorName: 'Олександр П.',
  seniorPresentedRole: 'Lead Developer',
  rate: null as number | null,
  currency: null as string | null,
  seniorSharePercentOverride: null,
  seniorSharePercentDefault: 26,
  startDate: '2024-01-15T00:00:00.000Z',
  archivedAt: null,
  createdAt: '2024-01-15T00:00:00.000Z',
  updatedAt: '2024-01-15T00:00:00.000Z',
  members: [],
}

/** Admin project fixture — стандартный полный DTO */
const ADMIN_PROJECT = {
  id: ADMIN_PROJECT_ID,
  name: 'AI Platform v2',
  companyName: 'TechCorp AI',
  domain: 'AI',
  logoDocumentId: null as string | null,
  logoExternalUrl: null as string | null,
  seniorId: USERS.senior.id,
  seniorName: USERS.senior.displayName,
  rate: 5000,
  currency: 'USDT',
  seniorSharePercentOverride: null,
  seniorSharePercentDefault: 26,
  startDate: '2024-01-15T00:00:00.000Z',
  archivedAt: null,
  createdAt: '2024-01-15T00:00:00.000Z',
  updatedAt: '2024-01-15T00:00:00.000Z',
  members: [],
}

// ---------------------------------------------------------------------------
// Helpers: минимальный набор per-тестовых моков для junior hub
// Регистрируется В ТЕЛЕ ТЕСТА после fixture setup → LIFO побеждает
// ---------------------------------------------------------------------------

async function setupJuniorHub(page: import('@playwright/test').Page, credList: object[]) {
  // LIFO: позже зарегистрированные маршруты выигрывают у mockAuthAs defaults

  // Projects list — замаскированный junior project
  await page.route(new RegExp(`${API}/projects(\\?.*)?$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([JUNIOR_PROJECT]),
    })
  })

  // Legend — 404 по умолчанию
  await page.route(new RegExp(`${API}/projects/${JUNIOR_PROJECT_ID}/legend$`), (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Not found' }),
      })
    }
    return r.fallback()
  })

  // HR contact
  await page.route(new RegExp(`${API}/projects/${JUNIOR_PROJECT_ID}/hr-contact$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ displayName: null, telegram: null, phone: null }),
    })
  })

  // Contract status — 404 (no contract)
  await page.route(new RegExp(`${API}/contracts/me/status$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Not found' }),
    })
  })

  // Salary meta — null (not configured)
  await page.route(new RegExp(`${API}/users/me/salary-meta$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ monthlySalary: null, salaryCurrency: null, changedAt: null }),
    })
  })

  // Credentials list — LIFO победитель (последний в очереди = первый срабатывает)
  await page.route(new RegExp(`${API}/projects/${JUNIOR_PROJECT_ID}/credentials$`), (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(credList),
      })
    }
    return r.fallback()
  })
}

/** Мок reveal-endpoint (добавлять ПОСЛЕ setupJuniorHub для LIFO-приоритета) */
async function mockReveal(
  page: import('@playwright/test').Page,
  projectId: string,
  credId: string,
  response: { status: number; body: object },
) {
  await page.route(
    new RegExp(`${API}/projects/${projectId}/credentials/${credId}/reveal$`),
    (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: JSON.stringify(response.body),
      })
    },
  )
}

// ---------------------------------------------------------------------------
// Helper: minimal mocks for admin project detail
// ---------------------------------------------------------------------------

async function setupAdminProjectDetail(page: import('@playwright/test').Page, credList: object[]) {
  // Credentials list
  await page.route(new RegExp(`${API}/projects/${ADMIN_PROJECT_ID}/credentials$`), (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(credList),
      })
    }
    if (r.request().method() === 'POST') {
      const newCred = {
        id: 'd0000000-0000-4000-8000-000000000099',
        projectId: ADMIN_PROJECT_ID,
        label: 'New Service',
        login: 'admin@service.com',
        url: null,
        notes: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      return r.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(newCred),
      })
    }
    return r.fallback()
  })

  // Credentials single CRUD (PATCH / DELETE)
  await page.route(new RegExp(`${API}/projects/${ADMIN_PROJECT_ID}/credentials/([^/?]+)$`), (r) => {
    if (r.request().method() === 'DELETE') return r.fulfill({ status: 204, body: '' })
    if (r.request().method() === 'PATCH') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(CREDENTIAL_ADMIN_1),
      })
    }
    return r.fallback()
  })

  // Reveal
  await page.route(
    new RegExp(`${API}/projects/${ADMIN_PROJECT_ID}/credentials/${CRED_ID_1}/reveal$`),
    (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ password: PLAINTEXT_PASSWORD }),
      })
    },
  )

  // Project detail GET — нужен для страницы /projects/$projectId
  await page.route(new RegExp(`${API}/projects/${ADMIN_PROJECT_ID}$`), (r) => {
    if (r.request().method() === 'GET') {
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ADMIN_PROJECT),
      })
    }
    return r.fallback()
  })
}

// ---------------------------------------------------------------------------
// JUNIOR hub: empty state
// ---------------------------------------------------------------------------

test.describe('JUNIOR hub — credentials-section empty state', () => {
  test('секция видна, empty-state показан, кнопка добавить ЕСТЬ (canAdd=true, round 3)', async ({
    asJunior: page,
  }) => {
    await setupJuniorHub(page, [])

    await page.goto('/project')

    const section = page.getByTestId('credentials-section')
    await expect(section).toBeVisible()

    // Empty state message
    await expect(section.getByText('Нет сохранённых паролей')).toBeVisible()

    // round 3: JUNIOR has canAdd=true (passed from hub) → add button IS present
    // (previously canEdit=false made it absent, but now canAdd is explicitly set)
    await expect(section.getByTestId('credentials-add-btn')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// JUNIOR hub: список credentials
// ---------------------------------------------------------------------------

test.describe('JUNIOR hub — список credentials', () => {
  test('список показывает label, login; пароль маской; edit/delete отсутствуют', async ({
    asJunior: page,
  }) => {
    await setupJuniorHub(page, [CREDENTIAL_JUNIOR_1, CREDENTIAL_JUNIOR_2])

    await page.goto('/project')

    const section = page.getByTestId('credentials-section')
    await expect(section).toBeVisible()

    const list = section.getByTestId('credentials-list')
    await expect(list).toBeVisible()

    // Первая запись
    const item1 = list.getByTestId(`credentials-item-${CRED_ID_1}`)
    await expect(item1).toBeVisible()
    await expect(item1.getByTestId(`credentials-label-${CRED_ID_1}`)).toContainText('GitHub')
    await expect(item1.getByText('john.doe@company.com')).toBeVisible()

    // Маска видна (не plaintext)
    await expect(item1.getByText('••••••••')).toBeVisible()

    // Вторая запись
    const item2 = list.getByTestId(`credentials-item-${CRED_ID_2}`)
    await expect(item2).toBeVisible()
    await expect(item2.getByTestId(`credentials-label-${CRED_ID_2}`)).toContainText('Jira')

    // JUNIOR — edit и delete кнопки отсутствуют
    await expect(section.getByTestId(`credentials-edit-btn-${CRED_ID_1}`)).toHaveCount(0)
    await expect(section.getByTestId(`credentials-delete-btn-${CRED_ID_1}`)).toHaveCount(0)

    // Reveal-кнопка присутствует
    await expect(section.getByTestId(`credentials-reveal-btn-${CRED_ID_1}`)).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// JUNIOR hub: reveal flow
// ---------------------------------------------------------------------------

test.describe('JUNIOR hub — reveal flow', () => {
  test('клик глаза → plaintext виден → повторный клик скрывает', async ({ asJunior: page }) => {
    await setupJuniorHub(page, [CREDENTIAL_JUNIOR_1])
    await mockReveal(page, JUNIOR_PROJECT_ID, CRED_ID_1, {
      status: 200,
      body: { password: PLAINTEXT_PASSWORD },
    })

    await page.goto('/project')

    const section = page.getByTestId('credentials-section')
    await expect(section).toBeVisible()

    const item = section.getByTestId(`credentials-item-${CRED_ID_1}`)
    await expect(item).toBeVisible()

    // Маска видна до reveal
    await expect(item.getByText('••••••••')).toBeVisible()

    const revealBtn = section.getByTestId(`credentials-reveal-btn-${CRED_ID_1}`)
    await expect(revealBtn).toBeVisible()

    // Клик reveal
    await revealBtn.click()

    // Plaintext появился
    const passwordDisplay = section.getByTestId(`credentials-password-display-${CRED_ID_1}`)
    await expect(passwordDisplay).toBeVisible()
    await expect(passwordDisplay).toContainText(PLAINTEXT_PASSWORD)

    // Маска исчезла
    await expect(item.getByText('••••••••')).toHaveCount(0)

    // aria-pressed = true
    await expect(revealBtn).toHaveAttribute('aria-pressed', 'true')

    // Повторный клик — скрывает
    await revealBtn.click()
    await expect(passwordDisplay).not.toBeVisible({ timeout: 3000 })

    // Маска снова видна
    await expect(item.getByText('••••••••')).toBeVisible()
  })

  test('после reveal кнопка copy появляется', async ({ asJunior: page }) => {
    await setupJuniorHub(page, [CREDENTIAL_JUNIOR_1])
    await mockReveal(page, JUNIOR_PROJECT_ID, CRED_ID_1, {
      status: 200,
      body: { password: PLAINTEXT_PASSWORD },
    })

    await page.goto('/project')
    const section = page.getByTestId('credentials-section')
    const item = section.getByTestId(`credentials-item-${CRED_ID_1}`)
    await expect(item).toBeVisible()

    // До reveal — copy-кнопки нет
    await expect(section.getByTestId(`credentials-copy-btn-${CRED_ID_1}`)).toHaveCount(0)

    // Reveal
    await section.getByTestId(`credentials-reveal-btn-${CRED_ID_1}`).click()
    await expect(section.getByTestId(`credentials-password-display-${CRED_ID_1}`)).toBeVisible()

    // Кнопка copy появилась
    await expect(section.getByTestId(`credentials-copy-btn-${CRED_ID_1}`)).toBeVisible()
  })

  test('reveal error 403 → inline error, plaintext не виден', async ({ asJunior: page }) => {
    await setupJuniorHub(page, [CREDENTIAL_JUNIOR_1])
    await mockReveal(page, JUNIOR_PROJECT_ID, CRED_ID_1, {
      status: 403,
      body: { message: 'Forbidden' },
    })

    await page.goto('/project')
    const section = page.getByTestId('credentials-section')
    const item = section.getByTestId(`credentials-item-${CRED_ID_1}`)
    await expect(item).toBeVisible()

    await section.getByTestId(`credentials-reveal-btn-${CRED_ID_1}`).click()

    // Inline error
    const errorEl = section.getByTestId(`credentials-error-${CRED_ID_1}`)
    await expect(errorEl).toBeVisible()
    await expect(errorEl).toContainText('Нет доступа к этому паролю')

    // Plaintext отсутствует
    await expect(section.getByTestId(`credentials-password-display-${CRED_ID_1}`)).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// JUNIOR hub: 403 на list → секция скрыта
// ---------------------------------------------------------------------------

test.describe('JUNIOR hub — 403 на credentials list', () => {
  test('403 от list → секция полностью скрыта, нет error-краша', async ({ asJunior: page }) => {
    await setupJuniorHub(page, [])

    // LIFO: перебиваем [] мок 403-ом (регистрируем после setupJuniorHub)
    await page.route(new RegExp(`${API}/projects/${JUNIOR_PROJECT_ID}/credentials$`), (r) => {
      if (r.request().method() === 'GET') {
        return r.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Forbidden' }),
        })
      }
      return r.fallback()
    })

    await page.goto('/project')

    // Хаб загрузился (не упал)
    await expect(page.getByTestId('junior-hub')).toBeVisible()

    // Секция credentials скрыта (компонент возвращает null при 403)
    await expect(page.getByTestId('credentials-section')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// ADMIN /projects/$projectId — overview tab
// ---------------------------------------------------------------------------

test.describe('ADMIN project detail — credentials section', () => {
  test('секция credentials видна на overview tab', async ({ asAdmin: page }) => {
    await setupAdminProjectDetail(page, [CREDENTIAL_ADMIN_1, CREDENTIAL_ADMIN_2])

    await page.goto(`/projects/${ADMIN_PROJECT_ID}`)

    const section = page.getByTestId('credentials-section')
    await expect(section).toBeVisible()

    await expect(section.getByTestId('credentials-list')).toBeVisible()
    await expect(section.getByTestId(`credentials-label-${CRED_ID_1}`)).toContainText('GitHub')
    await expect(section.getByTestId(`credentials-label-${CRED_ID_2}`)).toContainText('Jira')
  })

  test('ADMIN видит кнопки добавить/редактировать/удалить', async ({ asAdmin: page }) => {
    await setupAdminProjectDetail(page, [CREDENTIAL_ADMIN_1])

    await page.goto(`/projects/${ADMIN_PROJECT_ID}`)

    const section = page.getByTestId('credentials-section')
    await expect(section).toBeVisible()

    // Кнопка добавить
    await expect(section.getByTestId('credentials-add-btn')).toBeVisible()

    // Кнопки edit/delete
    await expect(section.getByTestId(`credentials-edit-btn-${CRED_ID_1}`)).toBeVisible()
    await expect(section.getByTestId(`credentials-delete-btn-${CRED_ID_1}`)).toBeVisible()
  })

  test('add-диалог открывается, форма содержит все поля', async ({ asAdmin: page }) => {
    await setupAdminProjectDetail(page, [])

    await page.goto(`/projects/${ADMIN_PROJECT_ID}`)

    const section = page.getByTestId('credentials-section')
    await expect(section).toBeVisible()
    await section.getByTestId('credentials-add-btn').click()

    const dialog = page.getByTestId('credentials-dialog')
    await expect(dialog).toBeVisible()

    // Поля формы
    await expect(dialog.getByTestId('credentials-input-label')).toBeVisible()
    await expect(dialog.getByTestId('credentials-input-login')).toBeVisible()
    await expect(dialog.getByTestId('credentials-input-password')).toBeVisible()
    await expect(dialog.getByTestId('credentials-input-url')).toBeVisible()
    await expect(dialog.getByTestId('credentials-input-notes')).toBeVisible()

    // Заголовок — создание
    await expect(dialog.getByText('Добавить аккаунт')).toBeVisible()
  })

  test('cancel в add-диалоге — диалог закрывается', async ({ asAdmin: page }) => {
    await setupAdminProjectDetail(page, [])

    await page.goto(`/projects/${ADMIN_PROJECT_ID}`)

    const section = page.getByTestId('credentials-section')
    await expect(section).toBeVisible()
    await section.getByTestId('credentials-add-btn').click()

    const dialog = page.getByTestId('credentials-dialog')
    await expect(dialog).toBeVisible()

    // Кнопка Отмена
    await dialog.getByRole('button', { name: 'Отмена' }).click()
    await expect(dialog).not.toBeVisible({ timeout: 3000 })
  })

  test('submit add-диалога → диалог закрывается, новая запись появляется', async ({
    asAdmin: page,
  }) => {
    const NEW_CRED_ID = 'd0000000-0000-4000-8000-000000000099'
    const newCred = {
      id: NEW_CRED_ID,
      projectId: ADMIN_PROJECT_ID,
      label: 'New Service',
      login: 'admin@service.com',
      url: null,
      notes: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    // POST → 201 + subsequent GET возвращает обновлённый список
    let callCount = 0
    await page.route(new RegExp(`${API}/projects/${ADMIN_PROJECT_ID}/credentials$`), (r) => {
      if (r.request().method() === 'POST') {
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(newCred),
        })
      }
      if (r.request().method() === 'GET') {
        callCount++
        // Первый GET — пустой список; последующие (после invalidate) — с новой записью
        const list = callCount === 1 ? [] : [newCred]
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(list),
        })
      }
      return r.fallback()
    })

    await page.goto(`/projects/${ADMIN_PROJECT_ID}`)

    // Ждём загрузки секции (пустой список)
    const section = page.getByTestId('credentials-section')
    await expect(section).toBeVisible()
    await expect(section.getByTestId('credentials-add-btn')).toBeVisible()

    await section.getByTestId('credentials-add-btn').click()
    const dialog = page.getByTestId('credentials-dialog')
    await expect(dialog).toBeVisible()

    // Заполняем форму
    await dialog.getByTestId('credentials-input-label').fill('New Service')
    await dialog.getByTestId('credentials-input-login').fill('admin@service.com')
    await dialog.getByTestId('credentials-input-password').fill('s3cr3tP@ss!')

    // Submit
    await dialog.getByTestId('credentials-dialog-submit').click()

    // Диалог закрывается
    await expect(dialog).not.toBeVisible({ timeout: 5000 })

    // Новая запись появилась в списке
    await expect(section.getByTestId(`credentials-item-${NEW_CRED_ID}`)).toBeVisible()
  })

  test('delete: confirm-диалог открывается, после подтверждения запись исчезает', async ({
    asAdmin: page,
  }) => {
    let callCount = 0
    // GET: сначала оба credential, после удаления — только второй
    await page.route(new RegExp(`${API}/projects/${ADMIN_PROJECT_ID}/credentials$`), (r) => {
      if (r.request().method() === 'GET') {
        callCount++
        const list =
          callCount === 1 ? [CREDENTIAL_ADMIN_1, CREDENTIAL_ADMIN_2] : [CREDENTIAL_ADMIN_2]
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(list),
        })
      }
      return r.fallback()
    })
    // DELETE
    await page.route(
      new RegExp(`${API}/projects/${ADMIN_PROJECT_ID}/credentials/${CRED_ID_1}$`),
      (r) => {
        if (r.request().method() === 'DELETE') return r.fulfill({ status: 204, body: '' })
        return r.fallback()
      },
    )

    await page.goto(`/projects/${ADMIN_PROJECT_ID}`)

    const section = page.getByTestId('credentials-section')
    await expect(section).toBeVisible()
    await expect(section.getByTestId(`credentials-item-${CRED_ID_1}`)).toBeVisible()

    // Клик delete
    await section.getByTestId(`credentials-delete-btn-${CRED_ID_1}`).click()

    // Confirm-диалог
    const confirmDialog = page.getByTestId('credentials-delete-confirm')
    await expect(confirmDialog).toBeVisible()
    await expect(confirmDialog.getByText('Удалить аккаунт?')).toBeVisible()
    // Описание содержит label удаляемой записи
    await expect(confirmDialog.getByText('GitHub', { exact: false })).toBeVisible()

    // Подтверждаем удаление
    await confirmDialog.getByRole('button', { name: 'Удалить' }).click()

    // Запись исчезла
    await expect(section.getByTestId(`credentials-item-${CRED_ID_1}`)).not.toBeVisible({
      timeout: 5000,
    })
  })

  test('ADMIN reveal — plaintext виден, повторный клик скрывает', async ({ asAdmin: page }) => {
    await setupAdminProjectDetail(page, [CREDENTIAL_ADMIN_1])

    await page.goto(`/projects/${ADMIN_PROJECT_ID}`)

    const section = page.getByTestId('credentials-section')
    await expect(section).toBeVisible()

    const item = section.getByTestId(`credentials-item-${CRED_ID_1}`)
    await expect(item).toBeVisible()

    const revealBtn = section.getByTestId(`credentials-reveal-btn-${CRED_ID_1}`)
    await expect(revealBtn).toBeVisible()

    await revealBtn.click()

    const passwordDisplay = section.getByTestId(`credentials-password-display-${CRED_ID_1}`)
    await expect(passwordDisplay).toBeVisible()
    await expect(passwordDisplay).toContainText(PLAINTEXT_PASSWORD)

    // Повторный клик скрывает
    await revealBtn.click()
    await expect(passwordDisplay).not.toBeVisible({ timeout: 3000 })
  })
})

// ---------------------------------------------------------------------------
// RBAC: SENIOR → секция скрыта (canManageCredentials=false на странице)
// ---------------------------------------------------------------------------

test.describe('RBAC — SENIOR не имеет доступа к credentials', () => {
  test('SENIOR на project detail → credentials-section отсутствует', async ({ asSenior: page }) => {
    // SENIOR: canManageCredentials = false → компонент не рендерится вообще
    // (страница /projects/$id проверяет role === ADMIN || HR перед рендером секции)
    await page.goto(`/projects/${ADMIN_PROJECT_ID}`)

    // Секция credentials не рендерится для SENIOR
    await expect(page.getByTestId('credentials-section')).toHaveCount(0)
  })
})

// ---------------------------------------------------------------------------
// Round 3 — форма паролей сбрасывается при повторном открытии (security fix)
// task-junior-ut-round3 §4: CredentialDialog unmounts on close → form reset
// ---------------------------------------------------------------------------

test.describe('Round 3 — credential dialog form reset on reopen', () => {
  test('add-dialog: поля пустые при повторном открытии (форма сбрасывается)', async ({
    asAdmin: page,
  }) => {
    await setupAdminProjectDetail(page, [])

    await page.goto(`/projects/${ADMIN_PROJECT_ID}`)

    const section = page.getByTestId('credentials-section')
    await expect(section).toBeVisible()

    // Первое открытие — заполняем форму
    await section.getByTestId('credentials-add-btn').click()
    const dialog = page.getByTestId('credentials-dialog')
    await expect(dialog).toBeVisible()

    await dialog.getByTestId('credentials-input-label').fill('OldValue')
    await dialog.getByTestId('credentials-input-login').fill('oldlogin@test.com')
    await dialog.getByTestId('credentials-input-password').fill('oldpassword123')

    // Закрываем через Отмена
    await dialog.getByRole('button', { name: 'Отмена' }).click()
    await expect(dialog).not.toBeVisible({ timeout: 3000 })

    // Второе открытие — поля должны быть ПУСТЫМИ (dialog unmounted → state reset)
    await section.getByTestId('credentials-add-btn').click()
    await expect(dialog).toBeVisible()

    // Security: старый пароль не должен быть в форме
    const labelInput = dialog.getByTestId('credentials-input-label')
    const loginInput = dialog.getByTestId('credentials-input-login')
    const passwordInput = dialog.getByTestId('credentials-input-password')

    await expect(labelInput).toHaveValue('')
    await expect(loginInput).toHaveValue('')
    await expect(passwordInput).toHaveValue('')
  })

  test('add-dialog: поля пустые после успешного сабмита и повторного открытия', async ({
    asAdmin: page,
  }) => {
    const NEW_CRED_ID = 'd0000000-0000-4000-8000-000000000099'
    let callCount = 0
    await page.route(new RegExp(`${API}/projects/${ADMIN_PROJECT_ID}/credentials$`), (r) => {
      if (r.request().method() === 'POST') {
        return r.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: NEW_CRED_ID,
            projectId: ADMIN_PROJECT_ID,
            label: 'Added',
            login: 'added@test.com',
            url: null,
            notes: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        })
      }
      if (r.request().method() === 'GET') {
        callCount++
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            callCount === 1
              ? []
              : [
                  {
                    id: NEW_CRED_ID,
                    projectId: ADMIN_PROJECT_ID,
                    label: 'Added',
                    login: 'added@test.com',
                    url: null,
                    notes: null,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  },
                ],
          ),
        })
      }
      return r.fallback()
    })

    await page.goto(`/projects/${ADMIN_PROJECT_ID}`)
    const section = page.getByTestId('credentials-section')
    await expect(section).toBeVisible()

    // Первый сабмит
    await section.getByTestId('credentials-add-btn').click()
    const dialog = page.getByTestId('credentials-dialog')
    await expect(dialog).toBeVisible()

    await dialog.getByTestId('credentials-input-label').fill('Added')
    await dialog.getByTestId('credentials-input-login').fill('added@test.com')
    await dialog.getByTestId('credentials-input-password').fill('s3cr3t!')
    await dialog.getByTestId('credentials-dialog-submit').click()
    await expect(dialog).not.toBeVisible({ timeout: 5000 })

    // Повторное открытие — форма сброшена
    await section.getByTestId('credentials-add-btn').click()
    await expect(dialog).toBeVisible()

    await expect(dialog.getByTestId('credentials-input-label')).toHaveValue('')
    await expect(dialog.getByTestId('credentials-input-password')).toHaveValue('')
  })
})
