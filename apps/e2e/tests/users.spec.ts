import type { Page } from '@playwright/test'
import { test, expect, ALL_USERS, USERS, mockAuthAs } from './fixtures'

// ---------------------------------------------------------------------------
// Helper: fill and submit the Create SENIOR form, capturing the POST body
// ---------------------------------------------------------------------------
async function createSeniorViaDialog(page: Page): Promise<Record<string, unknown>> {
  const postReq = page.waitForRequest(
    (req) => req.url().includes('/api/users') && req.method() === 'POST',
  )

  await page.getByRole('button', { name: /добавить/i }).click()
  await page.getByPlaceholder('user@cheekycheese.dev').fill('newsenior@cheekycheese.dev')
  await page.getByPlaceholder('Иван Иванов').fill('New Senior Dev')

  // For ADMIN: change role selector to SENIOR. For HR: role is locked (no combobox, just a div).
  const roleCombo = page.getByRole('dialog').getByRole('combobox').filter({ hasText: /Джун|Синьор|HR|Бухгалтер|Адмін/i })
  const hasRoleCombo = await roleCombo.count() > 0
  if (hasRoleCombo) {
    await roleCombo.click()
    await page.getByRole('option', { name: 'Синьор' }).click()
  }

  // Wait for the "Команда" team section to appear inside the dialog
  await expect(page.getByRole('dialog').getByText('Команда', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Создать' }).click()

  const req = await postReq
  return JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
}

test.describe('Users management page', () => {
  // ---------------------------------------------------------------------------
  // RBAC: access control
  // ---------------------------------------------------------------------------

  test.describe('Access control', () => {
    test('ADMIN can access users page', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await expect(page.getByText(/пользователи/i).first()).toBeVisible()
      await expect(page.getByText(/доступ только для администратора/i)).not.toBeVisible()
    })

    test('SENIOR sees "Доступ только для администратора"', async ({ asSenior: page }) => {
      await page.goto('/crm/users')
      await expect(page.getByText(/доступ только для администратора/i)).toBeVisible()
    })

    test('HR cannot access users page (admin-only)', async ({ asHr: page }) => {
      // /crm/users is admin-only — HR sees the access-denied notice.
      await page.goto('/crm/users')
      await expect(page.getByText(/доступ только для администратора/i)).toBeVisible()
    })

    test('JUNIOR sees access denied', async ({ asJunior: page }) => {
      await page.goto('/crm/users')
      await expect(page.getByText(/доступ только для администратора/i)).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Table rendering
  // ---------------------------------------------------------------------------

  test.describe('Table rendering', () => {
    test('shows all users in the table', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await expect(page.getByText('Admin User')).toBeVisible()
      await expect(page.getByText('Senior Dev')).toBeVisible()
      await expect(page.getByText('Junior Dev')).toBeVisible()
      await expect(page.getByText('HR Manager')).toBeVisible()
      await expect(page.getByText('Accountant User')).toBeVisible()
    })

    test('shows email column', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await expect(page.getByText('admin@cheekycheese.dev')).toBeVisible()
      await expect(page.getByText('senior@cheekycheese.dev')).toBeVisible()
    })

    test('shows role badges', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      // Badges show role labels, not raw role keys
      await expect(page.getByText('Администратор')).toBeVisible()
      await expect(page.getByText('Синьор')).toBeVisible()
    })

    test('shows telegram handle for senior user', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await expect(page.getByText('@seniordev')).toBeVisible()
    })

    test('marks current user with "Вы" label', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await expect(page.getByText('Вы')).toBeVisible()
    })

    test('shows "Добавить" button', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await expect(page.getByRole('button', { name: /добавить/i })).toBeVisible()
    })

    test(`shows total count "${ALL_USERS.length} из ${ALL_USERS.length}" in header`, async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await expect(page.getByText(new RegExp(`из ${ALL_USERS.length}`))).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Search and filter
  // ---------------------------------------------------------------------------

  test.describe('Search and filter', () => {
    test('search by name filters table', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByPlaceholder(/поиск по имени/i).fill('Senior')
      await expect(page.getByText('Senior Dev')).toBeVisible()
      await expect(page.getByText('Junior Dev')).not.toBeVisible()
    })

    test('search by email filters table', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByPlaceholder(/поиск по имени/i).fill('junior@')
      await expect(page.getByText('Junior Dev')).toBeVisible()
      await expect(page.getByText('Senior Dev')).not.toBeVisible()
    })

    test('search by telegram filters table', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByPlaceholder(/поиск по имени/i).fill('seniordev')
      await expect(page.getByText('Senior Dev')).toBeVisible()
    })

    test('filter by role shows only matching users', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      // The role filter combobox is outside the dialog — select it by its current value "Все роли"
      await page.getByRole('combobox').filter({ hasText: 'Все роли' }).click()
      await page.getByRole('option', { name: 'Джун' }).click()
      await expect(page.getByText('Junior Dev')).toBeVisible()
      await expect(page.getByText('Senior Dev')).not.toBeVisible()
    })

    test('clear search shows all users again', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const search = page.getByPlaceholder(/поиск по имени/i)
      await search.fill('Senior')
      await search.clear()
      await expect(page.getByText('Junior Dev')).toBeVisible()
      await expect(page.getByText('Senior Dev')).toBeVisible()
    })

    test('no results shows reduced count', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByPlaceholder(/поиск по имени/i).fill('zzznomatch')
      // 0 of 5
      await expect(page.getByText(/0 из/)).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Create user dialog
  // ---------------------------------------------------------------------------

  test.describe('Create user', () => {
    test('opens create dialog with correct title', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByRole('button', { name: /добавить/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByRole('heading', { name: /новый пользователь/i })).toBeVisible()
    })

    test('submits POST with all required fields', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')

      const postReq = page.waitForRequest(
        (req) => req.url().includes('/api/users') && req.method() === 'POST',
      )

      await page.getByRole('button', { name: /добавить/i }).click()
      await page.getByPlaceholder('user@cheekycheese.dev').fill('newuser@cheekycheese.dev')
      await page.getByPlaceholder('Иван Иванов').fill('New User')

      // Role is already default (JUNIOR)

      await page.getByRole('button', { name: 'Создать' }).click()

      const req = await postReq
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      expect(body).toMatchObject({
        email: 'newuser@cheekycheese.dev',
        displayName: 'New User',
      })
    })

    test('validation: invalid email shows error on blur', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByRole('button', { name: /добавить/i }).click()
      const emailInput = page.getByPlaceholder('user@cheekycheese.dev')
      await emailInput.fill('not-an-email')
      await emailInput.blur()
      await expect(page.locator('.text-destructive').first()).toBeVisible()
    })

    test('validation: empty display name shows error on blur', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByRole('button', { name: /добавить/i }).click()
      const nameInput = page.getByPlaceholder('Иван Иванов')
      await nameInput.focus()
      await nameInput.blur()
      await expect(page.locator('.text-destructive').first()).toBeVisible()
    })

    test('validation: invalid telegram shows error on blur', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByRole('button', { name: /добавить/i }).click()
      await page.getByPlaceholder('@username').fill('notelegram')
      await page.getByPlaceholder('@username').blur()
      // The error message paragraph (not label asterisk) should be visible
      await expect(page.locator('p.text-destructive').first()).toBeVisible()
    })

    test('can select different role', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')

      const postReq = page.waitForRequest(
        (req) => req.url().includes('/api/users') && req.method() === 'POST',
      )

      await page.getByRole('button', { name: /добавить/i }).click()
      await page.getByPlaceholder('user@cheekycheese.dev').fill('senior2@cheekycheese.dev')
      await page.getByPlaceholder('Иван Иванов').fill('Another Senior')

      // Change role to SENIOR — target the role Select specifically (shows current role label)
      await page.getByRole('dialog').getByRole('combobox').filter({ hasText: /Джун|Синьор|HR|Бухгалтер|Админ/i }).click()
      await page.getByRole('option', { name: 'Синьор' }).click()

      await page.getByRole('button', { name: 'Создать' }).click()

      const req = await postReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ role: 'SENIOR' })
    })

    test('cancel closes dialog without POST', async ({ asAdmin: page }) => {
      let postCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/api/users') && req.method() === 'POST') postCalled = true
      })

      await page.goto('/crm/users')
      await page.getByRole('button', { name: /добавить/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()
      expect(postCalled).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Edit user dialog
  // ---------------------------------------------------------------------------

  test.describe('Edit user', () => {
    test('opens edit dialog with user data pre-filled', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const seniorRow = page.getByRole('row', { name: /Senior Dev/ })
      await seniorRow.getByTitle('Редактировать').click()

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await expect(page.getByRole('heading', { name: /редактировать/i })).toBeVisible()
      // Edit dialog name input has no placeholder — it's the first <input> in the form fields
      const nameInput = dialog.locator('input').first()
      await expect(nameInput).toHaveValue('Senior Dev')
    })

    test('edit sends PATCH request with updated data', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const seniorRow = page.getByRole('row', { name: /Senior Dev/ })
      await seniorRow.getByTitle('Редактировать').click()

      const patchReq = page.waitForRequest(
        (req) => req.url().includes(`/api/users/${USERS.senior.id}`) && req.method() === 'PATCH',
      )

      const nameInput = page.getByRole('dialog').locator('input').first()
      await nameInput.clear()
      await nameInput.fill('Senior Developer Updated')
      await page.getByRole('button', { name: 'Сохранить' }).click()

      const req = await patchReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ displayName: 'Senior Developer Updated' })
    })

    test('edit cancel closes dialog without PATCH', async ({ asAdmin: page }) => {
      let patchCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/api/users/') && req.method() === 'PATCH') patchCalled = true
      })

      await page.goto('/crm/users')
      const seniorRow = page.getByRole('row', { name: /Senior Dev/ })
      await seniorRow.getByTitle('Редактировать').click()
      await page.getByRole('button', { name: 'Отмена' }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()
      expect(patchCalled).toBe(false)
    })

    test('cannot delete self from table (delete button disabled for current user)', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      // The self-row delete button has title "Нельзя удалить себя" and is disabled
      const adminRow = page.getByRole('row', { name: /Admin User/ })
      await expect(adminRow.getByTitle('Нельзя удалить себя')).toBeVisible()
      await expect(adminRow.getByTitle('Нельзя удалить себя')).toBeDisabled()
    })
  })

  // ---------------------------------------------------------------------------
  // Delete user dialog
  // ---------------------------------------------------------------------------

  test.describe('Delete user', () => {
    test('opens delete confirm dialog with user name', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      // Target the Senior Dev row's delete button specifically
      const seniorRow = page.getByRole('row', { name: /Senior Dev/ })
      await seniorRow.getByTitle('Удалить').click()

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog.getByText(/Senior Dev/)).toBeVisible()
      // For SENIOR role: shows team/project warning instead of generic irreversible message
      await expect(dialog.getByText(/удалены|необратимо/i)).toBeVisible()
    })

    test('confirm sends DELETE request', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')

      const deleteReq = page.waitForRequest(
        (req) => req.url().includes(`/api/users/${USERS.senior.id}`) && req.method() === 'DELETE',
      )

      const seniorRow = page.getByRole('row', { name: /Senior Dev/ })
      await seniorRow.getByTitle('Удалить').click()
      await page.getByRole('button', { name: 'Удалить' }).last().click()
      await deleteReq
    })

    test('cancel closes dialog without DELETE', async ({ asAdmin: page }) => {
      let deleteCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/api/users/') && req.method() === 'DELETE') deleteCalled = true
      })

      await page.goto('/crm/users')
      const seniorRow = page.getByRole('row', { name: /Senior Dev/ })
      await seniorRow.getByTitle('Удалить').click()
      await page.getByRole('button', { name: 'Отмена' }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()
      expect(deleteCalled).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Column sorting
  // ---------------------------------------------------------------------------

  test.describe('Sorting', () => {
    test('clicking "Пользователь" column header toggles sort', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const header = page.getByRole('columnheader', { name: /пользователь/i })
      await expect(header).toBeVisible()
      await header.click()
      // After sort, table still renders
      await expect(page.getByText('Admin User')).toBeVisible()
    })

    test('clicking "Добавлен" column header sorts by date', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const header = page.getByRole('columnheader', { name: /добавлен/i })
      await expect(header).toBeVisible()
      await header.click()
      await expect(page.getByText('Admin User')).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  test.describe('Edge cases', () => {
    test('empty users list renders without crash', async ({ page }) => {
      await mockAuthAs(page, USERS.admin)
      await page.route('http://localhost:3001/api/users', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
      )
      await page.goto('/crm/users')
      await expect(page.getByText(/пользователи/i).first()).toBeVisible()
    })

    test('API error on create shows no crash', async ({ asAdmin: page }) => {
      await page.route('http://localhost:3001/api/users', (r) => {
        if (r.request().method() === 'POST') {
          return r.fulfill({ status: 400, contentType: 'application/json', body: '{"message":"Email already exists"}' })
        }
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ALL_USERS) })
      })

      await page.goto('/crm/users')
      await page.getByRole('button', { name: /добавить/i }).click()
      await page.getByPlaceholder('user@cheekycheese.dev').fill('existing@cheekycheese.dev')
      await page.getByPlaceholder('Иван Иванов').fill('Existing User')
      await page.getByRole('button', { name: 'Создать' }).click()

      // Page still intact
      await expect(page.getByText(/пользователи/i).first()).toBeVisible()
    })

    test('telegram link opens t.me URL', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const telegramLink = page.getByRole('link', { name: '@seniordev' })
      await expect(telegramLink).toHaveAttribute('href', 'https://t.me/seniordev')
    })

    test('email shown as mailto link', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const emailLink = page.getByRole('link', { name: 'senior@cheekycheese.dev' })
      await expect(emailLink).toHaveAttribute('href', 'mailto:senior@cheekycheese.dev')
    })
  })

  // ---------------------------------------------------------------------------
  // SENIOR creation flow — team assignment (hrIds + accountantId)
  // ---------------------------------------------------------------------------

  test.describe('Create SENIOR — team assignment', () => {
    test('ADMIN: POST includes hrIds array when HR is checked', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const body = await createSeniorViaDialog(page)
      expect(body.role).toBe('SENIOR')
      // hrIds must be an array (auto-selected when only one HR exists)
      expect(Array.isArray(body.hrIds)).toBe(true)
      expect((body.hrIds as string[]).length).toBeGreaterThan(0)
    })

    test('ADMIN: POST includes accountantId when accountant auto-selected', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const body = await createSeniorViaDialog(page)
      // accountantId is auto-set when exactly one accountant exists
      expect(body.accountantId).toBeTruthy()
      expect(typeof body.accountantId).toBe('string')
    })

    test('ADMIN: POST contains correct hrId from fixtures', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const body = await createSeniorViaDialog(page)
      expect((body.hrIds as string[])).toContain(USERS.hr.id)
    })

    test('ADMIN: POST contains correct accountantId from fixtures', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const body = await createSeniorViaDialog(page)
      expect(body.accountantId).toBe(USERS.accountant.id)
    })

    test('ADMIN: Финансы и команда section visible for SENIOR role', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByRole('button', { name: /добавить/i }).click()

      // Switch to SENIOR via the role combobox (shows current role label)
      await page.getByRole('dialog').getByRole('combobox').filter({ hasText: /Джун|Синьор|HR|Бухгалтер/i }).click()
      await page.getByRole('option', { name: 'Синьор' }).click()

      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('Финансы и команда')).toBeVisible()
      await expect(dialog.getByText('Команда', { exact: true })).toBeVisible()
      // HR field: the Field wrapper paragraph text is "HR" (label text, may have * child)
      await expect(dialog.locator('label').filter({ hasText: 'HR' }).first()).toBeVisible()
      await expect(dialog.getByText('Бухгалтер')).toBeVisible()
    })

    test('ADMIN: HR checkbox pre-checked when only one HR exists', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByRole('button', { name: /добавить/i }).click()
      await page.getByRole('dialog').getByRole('combobox').filter({ hasText: /Джун|Синьор|HR|Бухгалтер/i }).click()
      await page.getByRole('option', { name: 'Синьор' }).click()

      // HR Manager checkbox should be visible and checked
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByText('HR Manager')).toBeVisible()
      const checkbox = dialog.locator('input[type="checkbox"]').first()
      await expect(checkbox).toBeChecked()
    })

    test('ADMIN: validation error when no HR selected', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByRole('button', { name: /добавить/i }).click()
      await page.getByPlaceholder('user@cheekycheese.dev').fill('newsenior2@cheekycheese.dev')
      await page.getByPlaceholder('Иван Иванов').fill('Another Senior')
      await page.getByRole('dialog').getByRole('combobox').filter({ hasText: /Джун|Синьор|HR|Бухгалтер/i }).click()
      await page.getByRole('option', { name: 'Синьор' }).click()

      // Uncheck the auto-checked HR
      const checkbox = page.getByRole('dialog').locator('input[type="checkbox"]').first()
      await checkbox.uncheck()

      await page.getByRole('button', { name: 'Создать' }).click()
      // Toast error appears, no POST is sent
      await expect(page.getByText(/выберите хотя бы одного HR/i)).toBeVisible()
    })

    // /crm/users became admin-only in the latest refactor — the HR senior-creation
    // path now lives elsewhere. These tests assert HR sees the access-denied screen.
    test('HR: sees access-denied notice on /crm/users (admin-only page)', async ({ asHr: page }) => {
      await page.goto('/crm/users')
      await expect(page.getByText(/доступ только для администратора/i)).toBeVisible()
      // Add/edit/delete affordances are not rendered when access is denied.
      await expect(page.getByRole('button', { name: /добавить/i })).toHaveCount(0)
      await expect(page.getByTitle('Редактировать')).toHaveCount(0)
      await expect(page.getByTitle('Удалить')).toHaveCount(0)
    })
  })
})
