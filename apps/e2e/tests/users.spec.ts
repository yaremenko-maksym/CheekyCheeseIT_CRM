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
  const roleCombo = page.getByTestId('user-dialog-role-trigger')
  const hasRoleCombo = await roleCombo.count() > 0
  if (hasRoleCombo) {
    await roleCombo.click()
    await page.getByRole('option', { name: 'Синьор' }).click()
  }

  // Wait for the "Команда" team section to appear inside the dialog
  await expect(page.getByRole('dialog').getByText('Команда', { exact: true })).toBeVisible()

  await page.getByTestId('user-dialog-submit').click()

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
      await page.goto('/crm/users')
      await expect(page.getByText(/доступ только для администратора/i)).toBeVisible()
    })

    test('JUNIOR sees access denied', async ({ asJunior: page }) => {
      await page.goto('/crm/users')
      await expect(page.getByText(/доступ только для администратора/i)).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // List rendering
  // ---------------------------------------------------------------------------

  test.describe('List rendering', () => {
    test('shows all users in the list', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      for (const u of ALL_USERS) {
        await expect(page.getByTestId(`user-row-${u.id}`)).toBeVisible()
      }
    })

    test('shows email in row meta', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const seniorRow = page.getByTestId(`user-row-${USERS.senior.id}`)
      await expect(seniorRow.getByText('senior@cheekycheese.dev')).toBeVisible()
    })

    test('shows role badge in row', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const adminRow = page.getByTestId(`user-row-${USERS.admin.id}`)
      await expect(adminRow.getByText('Администратор')).toBeVisible()
      const seniorRow = page.getByTestId(`user-row-${USERS.senior.id}`)
      await expect(seniorRow.getByText('Синьор')).toBeVisible()
    })

    test('shows telegram handle inside row meta', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const seniorRow = page.getByTestId(`user-row-${USERS.senior.id}`)
      await expect(seniorRow.getByText('@seniordev')).toBeVisible()
    })

    test('marks current user with "Вы" label', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const adminRow = page.getByTestId(`user-row-${USERS.admin.id}`)
      await expect(adminRow.getByText('Вы', { exact: true })).toBeVisible()
    })

    test('shows "Добавить" button', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await expect(page.getByTestId('users-create-button')).toBeVisible()
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
    test('search by name filters list', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByPlaceholder(/поиск по имени/i).fill('Senior')
      await expect(page.getByTestId(`user-row-${USERS.senior.id}`)).toBeVisible()
      await expect(page.getByTestId(`user-row-${USERS.junior.id}`)).toHaveCount(0)
    })

    test('search by email filters list', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByPlaceholder(/поиск по имени/i).fill('junior@')
      await expect(page.getByTestId(`user-row-${USERS.junior.id}`)).toBeVisible()
      await expect(page.getByTestId(`user-row-${USERS.senior.id}`)).toHaveCount(0)
    })

    test('search by telegram filters list', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByPlaceholder(/поиск по имени/i).fill('seniordev')
      await expect(page.getByTestId(`user-row-${USERS.senior.id}`)).toBeVisible()
    })

    test('filter by role shows only matching users', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      // Filter combobox shows "Все роли"
      await page.getByRole('combobox').filter({ hasText: 'Все роли' }).click()
      await page.getByRole('option', { name: 'Джун' }).click()
      await expect(page.getByTestId(`user-row-${USERS.junior.id}`)).toBeVisible()
      await expect(page.getByTestId(`user-row-${USERS.senior.id}`)).toHaveCount(0)
    })

    test('clear search shows all users again', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const search = page.getByPlaceholder(/поиск по имени/i)
      await search.fill('Senior')
      await search.clear()
      await expect(page.getByTestId(`user-row-${USERS.junior.id}`)).toBeVisible()
      await expect(page.getByTestId(`user-row-${USERS.senior.id}`)).toBeVisible()
    })

    test('no results shows reduced count', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByPlaceholder(/поиск по имени/i).fill('zzznomatch')
      await expect(page.getByText(/0 из/)).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Create user dialog
  // ---------------------------------------------------------------------------

  test.describe('Create user', () => {
    test('opens create dialog with correct title', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      await expect(page.getByTestId('user-dialog')).toBeVisible()
      await expect(page.getByRole('heading', { name: /новый пользователь/i })).toBeVisible()
    })

    test('submits POST with all required fields', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')

      const postReq = page.waitForRequest(
        (req) => req.url().includes('/api/users') && req.method() === 'POST',
      )

      await page.getByTestId('users-create-button').click()
      await page.getByPlaceholder('user@cheekycheese.dev').fill('newuser@cheekycheese.dev')
      await page.getByPlaceholder('Иван Иванов').fill('New User')

      // Role is already default (JUNIOR)
      await page.getByTestId('user-dialog-submit').click()

      const req = await postReq
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      expect(body).toMatchObject({
        email: 'newuser@cheekycheese.dev',
        displayName: 'New User',
      })
    })

    test('validation: invalid email shows error on blur', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      const emailInput = page.getByPlaceholder('user@cheekycheese.dev')
      await emailInput.fill('not-an-email')
      await emailInput.blur()
      await expect(page.locator('.text-destructive').first()).toBeVisible()
    })

    test('validation: empty display name shows error on blur', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      const nameInput = page.getByPlaceholder('Иван Иванов')
      await nameInput.focus()
      await nameInput.blur()
      await expect(page.locator('.text-destructive').first()).toBeVisible()
    })

    test('validation: invalid telegram shows error on blur', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      await page.getByPlaceholder('@username').fill('notelegram')
      await page.getByPlaceholder('@username').blur()
      await expect(page.locator('p.text-destructive').first()).toBeVisible()
    })

    test('can select different role', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')

      const postReq = page.waitForRequest(
        (req) => req.url().includes('/api/users') && req.method() === 'POST',
      )

      await page.getByTestId('users-create-button').click()
      await page.getByPlaceholder('user@cheekycheese.dev').fill('senior2@cheekycheese.dev')
      await page.getByPlaceholder('Иван Иванов').fill('Another Senior')

      await page.getByTestId('user-dialog-role-trigger').click()
      await page.getByRole('option', { name: 'Синьор' }).click()

      await page.getByTestId('user-dialog-submit').click()

      const req = await postReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ role: 'SENIOR' })
    })

    test('cancel closes dialog without POST', async ({ asAdmin: page }) => {
      let postCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/api/users') && req.method() === 'POST') postCalled = true
      })

      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      await expect(page.getByTestId('user-dialog')).toBeVisible()
      await page.getByTestId('user-dialog').getByRole('button', { name: 'Отмена' }).click()
      await expect(page.getByTestId('user-dialog')).not.toBeVisible()
      expect(postCalled).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Edit user dialog
  // ---------------------------------------------------------------------------

  test.describe('Edit user', () => {
    test('opens edit dialog with user data pre-filled', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId(`user-row-edit-${USERS.senior.id}`).click()

      const dialog = page.getByTestId('user-dialog')
      await expect(dialog).toBeVisible()
      await expect(page.getByRole('heading', { name: /редактировать/i })).toBeVisible()
      // Name is pre-filled
      const nameInput = page.getByTestId('user-dialog-name')
      await expect(nameInput).toHaveValue('Senior Dev')
    })

    test('edit sends PATCH request with updated data', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId(`user-row-edit-${USERS.senior.id}`).click()

      const patchReq = page.waitForRequest(
        (req) => req.url().includes(`/api/users/${USERS.senior.id}`) && req.method() === 'PATCH',
      )

      const nameInput = page.getByTestId('user-dialog-name')
      await nameInput.clear()
      await nameInput.fill('Senior Developer Updated')
      await page.getByTestId('user-dialog-submit').click()

      const req = await patchReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ displayName: 'Senior Developer Updated' })
    })

    test('edit cancel closes dialog without PATCH', async ({ asAdmin: page }) => {
      let patchCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/api/users/') && req.method() === 'PATCH') patchCalled = true
      })

      await page.goto('/crm/users')
      await page.getByTestId(`user-row-edit-${USERS.senior.id}`).click()
      await page.getByTestId('user-dialog').getByRole('button', { name: 'Отмена' }).click()
      await expect(page.getByTestId('user-dialog')).not.toBeVisible()
      expect(patchCalled).toBe(false)
    })

    test('cannot archive self from list (archive button disabled for current user)', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const archiveBtn = page.getByTestId(`user-row-archive-${USERS.admin.id}`)
      await expect(archiveBtn).toBeVisible()
      await expect(archiveBtn).toBeDisabled()
    })
  })

  // ---------------------------------------------------------------------------
  // Archive user dialog (was Delete user)
  // ---------------------------------------------------------------------------

  test.describe('Archive user', () => {
    test('opens archive confirm dialog with user name', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId(`user-row-archive-${USERS.senior.id}`).click()

      const dialog = page.getByTestId('archive-confirm-dialog')
      await expect(dialog).toBeVisible()
      // SENIOR variant warning (pair-archive)
      await expect(dialog.getByTestId('archive-warning-senior')).toBeVisible()
      await expect(dialog.getByTestId('archive-confirm-user-name')).toHaveText('Senior Dev')
    })

    test('confirm sends DELETE request after name confirmation', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId(`user-row-archive-${USERS.senior.id}`).click()

      const deleteReq = page.waitForRequest(
        (req) => req.url().includes(`/api/users/${USERS.senior.id}`) && req.method() === 'DELETE',
      )
      await page.getByTestId('archive-confirm-name-input').fill('Senior Dev')
      await page.getByTestId('archive-confirm-submit').click()
      await deleteReq
    })

    test('cancel closes dialog without DELETE', async ({ asAdmin: page }) => {
      let deleteCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/api/users/') && req.method() === 'DELETE') deleteCalled = true
      })

      await page.goto('/crm/users')
      await page.getByTestId(`user-row-archive-${USERS.senior.id}`).click()
      await page.getByTestId('archive-confirm-dialog').getByRole('button', { name: 'Отмена' }).click()
      await expect(page.getByTestId('archive-confirm-dialog')).not.toBeVisible()
      expect(deleteCalled).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Column sorting (new SortHeader buttons)
  // ---------------------------------------------------------------------------

  test.describe('Sorting', () => {
    test('clicking "Пользователь" column header toggles sort', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const header = page.getByTestId('users-sort-displayName')
      await expect(header).toBeVisible()
      // Default active asc; click → desc
      await header.click()
      await expect(header).toHaveAttribute('data-dir', 'desc')
      await expect(page.getByTestId(`user-row-${USERS.admin.id}`)).toBeVisible()
    })

    test('clicking "Добавлен" column header sorts by date', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const header = page.getByTestId('users-sort-createdAt')
      await expect(header).toBeVisible()
      await header.click()
      await expect(header).toHaveAttribute('data-active', 'true')
      await expect(page.getByTestId(`user-row-${USERS.admin.id}`)).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  test.describe('Edge cases', () => {
    test('empty users list renders without crash', async ({ page }) => {
      await mockAuthAs(page, USERS.admin)
      await page.route(/\/api\/users(\?.*)?$/, (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
      )
      await page.goto('/crm/users')
      await expect(page.getByText(/пользователи/i).first()).toBeVisible()
    })

    test('API error on create shows no crash', async ({ asAdmin: page }) => {
      await page.route(/\/api\/users(\?.*)?$/, (r) => {
        if (r.request().method() === 'POST') {
          return r.fulfill({ status: 400, contentType: 'application/json', body: '{"message":"Email already exists"}' })
        }
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ALL_USERS) })
      })

      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      await page.getByPlaceholder('user@cheekycheese.dev').fill('existing@cheekycheese.dev')
      await page.getByPlaceholder('Иван Иванов').fill('Existing User')
      await page.getByTestId('user-dialog-submit').click()

      await expect(page.getByText(/пользователи/i).first()).toBeVisible()
    })

    test('telegram visible in row meta', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const seniorRow = page.getByTestId(`user-row-${USERS.senior.id}`)
      await expect(seniorRow.getByText('@seniordev')).toBeVisible()
    })

    test('email visible in row meta', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const seniorRow = page.getByTestId(`user-row-${USERS.senior.id}`)
      await expect(seniorRow.getByText('senior@cheekycheese.dev')).toBeVisible()
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
      expect(Array.isArray(body.hrIds)).toBe(true)
      expect((body.hrIds as string[]).length).toBeGreaterThan(0)
    })

    test('ADMIN: POST includes accountantId when accountant auto-selected', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      const body = await createSeniorViaDialog(page)
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

    test('ADMIN: Финансы and Команда sections visible for SENIOR role', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()

      await page.getByTestId('user-dialog-role-trigger').click()
      await page.getByRole('option', { name: 'Синьор' }).click()

      const dialog = page.getByTestId('user-dialog')
      await expect(dialog.getByText('Финансы', { exact: true })).toBeVisible()
      await expect(dialog.getByText('Команда', { exact: true })).toBeVisible()
      await expect(dialog.locator('label').filter({ hasText: 'HR' }).first()).toBeVisible()
      await expect(dialog.getByText('Бухгалтер')).toBeVisible()
    })

    test('ADMIN: HR checkbox pre-checked when only one HR exists', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      await page.getByTestId('user-dialog-role-trigger').click()
      await page.getByRole('option', { name: 'Синьор' }).click()

      const dialog = page.getByTestId('user-dialog')
      await expect(dialog.getByText('HR Manager')).toBeVisible()
      const checkbox = page.getByTestId(`user-dialog-hr-${USERS.hr.id}`)
      await expect(checkbox).toBeChecked()
    })

    test('ADMIN: validation error when no HR selected', async ({ asAdmin: page }) => {
      await page.goto('/crm/users')
      await page.getByTestId('users-create-button').click()
      await page.getByPlaceholder('user@cheekycheese.dev').fill('newsenior2@cheekycheese.dev')
      await page.getByPlaceholder('Иван Иванов').fill('Another Senior')
      await page.getByTestId('user-dialog-role-trigger').click()
      await page.getByRole('option', { name: 'Синьор' }).click()

      // Uncheck the auto-checked HR
      const checkbox = page.getByTestId(`user-dialog-hr-${USERS.hr.id}`)
      await checkbox.uncheck()

      await page.getByTestId('user-dialog-submit').click()
      await expect(page.getByText(/выберите хотя бы одного HR/i)).toBeVisible()
    })

    test('HR: sees access-denied notice on /crm/users (admin-only page)', async ({ asHr: page }) => {
      await page.goto('/crm/users')
      await expect(page.getByText(/доступ только для администратора/i)).toBeVisible()
      await expect(page.getByTestId('users-create-button')).toHaveCount(0)
    })
  })
})
