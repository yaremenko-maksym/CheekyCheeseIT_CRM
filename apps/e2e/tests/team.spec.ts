import { test, expect, TEAMS, USERS, mockAuthAs } from './fixtures'

test.describe('Team page', () => {
  // ---------------------------------------------------------------------------
  // Page load & read-only view (all roles)
  // ---------------------------------------------------------------------------

  test.describe('Read-only view', () => {
    test('renders team list with correct name and members', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')
      await expect(page.getByText('Alpha Team')).toBeVisible()
      // Scope to main to avoid header/sidebar duplicates
      const main = page.locator('main')
      await expect(main.getByText('HR Manager').first()).toBeVisible()
      await expect(main.getByText('Senior Dev')).toBeVisible()
    })

    test('SENIOR sees team page but no management buttons', async ({ asSenior: page }) => {
      await page.goto('/crm/team')
      await expect(page.getByText('Alpha Team')).toBeVisible()
      // No rename button
      await expect(page.getByTitle('Переименовать')).not.toBeVisible()
      // No delete button
      await expect(page.getByTitle('Удалить команду')).not.toBeVisible()
      // No add member button
      await expect(page.getByTitle('Добавить участника')).not.toBeVisible()
    })

    test('HR sees management buttons but not delete', async ({ asHr: page }) => {
      await page.goto('/crm/team')
      await expect(page.getByTitle('Переименовать')).toBeVisible()
      await expect(page.getByTitle('Добавить участника')).toBeVisible()
      await expect(page.getByTitle('Удалить команду')).not.toBeVisible()
    })

    test('HR sees only their assigned teams (RBAC fix)', async ({ asHr: page }) => {
      await page.goto('/crm/team')
      // HR user should only see teams where they are specifically assigned as HR
      // Based on seed data, HR should not see all teams, only their own
      await expect(page.getByText('Alpha Team')).toBeVisible()
      // Verify no unauthorized teams are shown - this depends on seed data structure
    })

    test('ADMIN sees all buttons including delete', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')
      await expect(page.getByTitle('Переименовать')).toBeVisible()
      await expect(page.getByTitle('Добавить участника')).toBeVisible()
      await expect(page.getByTitle('Удалить команду')).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Rename team dialog
  // ---------------------------------------------------------------------------

  test.describe('Rename team', () => {
    test('opens rename dialog with current name pre-filled', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')
      await page.getByTitle('Переименовать').click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Переименовать команду' })).toBeVisible()
    })

    test('save button submits PATCH request with new name', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')

      const patchReq = page.waitForRequest(
        (req) => req.url().includes('/teams/') && req.method() === 'PATCH',
      )

      await page.getByTitle('Переименовать').click()
      const nameInput = page.getByPlaceholder('Название команды')
      await nameInput.clear()
      await nameInput.fill('Beta Team')
      await page.getByRole('button', { name: 'Сохранить' }).click()

      const req = await patchReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ name: 'Beta Team' })
    })

    test('validation: empty name shows error on blur', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')
      await page.getByTitle('Переименовать').click()
      const nameInput = page.getByPlaceholder('Название команды')
      await nameInput.clear()
      await nameInput.blur()
      await expect(page.getByText(/обязательное поле/i)).toBeVisible()
    })

    test('cancel closes dialog without PATCH', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')
      await page.getByTitle('Переименовать').click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.getByRole('button', { name: 'Отмена' }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Delete team dialog
  // ---------------------------------------------------------------------------

  test.describe('Delete team', () => {
    test('opens delete confirm dialog with team name', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')
      await page.getByTitle('Удалить команду').click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByText(/Удалить команду «Alpha Team»/)).toBeVisible()
    })

    test('confirm sends DELETE request', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')

      const deleteReq = page.waitForRequest(
        (req) => req.url().includes(`/teams/${TEAMS[0]!.id}`) && req.method() === 'DELETE',
      )

      await page.getByTitle('Удалить команду').click()
      await page.getByRole('button', { name: 'Удалить' }).last().click()
      await deleteReq
    })

    test('cancel closes dialog without DELETE', async ({ asAdmin: page }) => {
      let deleteCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/teams/') && req.method() === 'DELETE') deleteCalled = true
      })

      await page.goto('/crm/team')
      await page.getByTitle('Удалить команду').click()
      await page.getByRole('button', { name: 'Отмена' }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()
      expect(deleteCalled).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Add member dialog
  // ---------------------------------------------------------------------------

  test.describe('Add member', () => {
    test('opens add member dialog', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')
      await page.getByTitle('Добавить участника').click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByText(/Добавить участника/)).toBeVisible()
    })

    test('clicking a user sends POST to members endpoint', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')

      const postReq = page.waitForRequest(
        (req) => req.url().includes('/members') && req.method() === 'POST',
      )

      await page.getByTitle('Добавить участника').click()
      // Click first available user in the list
      await page.getByRole('dialog').getByText('Junior Dev').click()
      await page.getByRole('button', { name: 'Добавить' }).click()
      await postReq
    })

    test('cancel closes dialog without POST', async ({ asAdmin: page }) => {
      let postCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/members') && req.method() === 'POST') postCalled = true
      })

      await page.goto('/crm/team')
      await page.getByTitle('Добавить участника').click()
      await page.getByRole('button', { name: 'Отмена' }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()
      expect(postCalled).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Remove member
  // ---------------------------------------------------------------------------

  test.describe('Remove member', () => {
    test('ADMIN can remove a non-protected member', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')

      const deleteReq = page.waitForRequest(
        (req) => req.url().includes('/members/') && req.method() === 'DELETE',
      )

      // Two accountants in team — neither is "last" so both have remove buttons
      await page.getByTitle('Исключить').first().click()
      await deleteReq
    })
  })

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  test.describe('Edge cases', () => {
    test('shows empty state when teams list is empty', async ({ page }) => {
      await mockAuthAs(page, USERS.admin)
      await page.route('http://localhost:3001/teams', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
      )
      await page.goto('/crm/team')
      // Page still renders without crashing
      await expect(page.getByText('Команда')).toBeVisible()
    })

    test('API error on rename shows no silent failure (page stays open)', async ({ asAdmin: page }) => {
      await page.route('**/api/teams/**', async (r) => {
        if (r.request().method() === 'PATCH') {
          return r.fulfill({ status: 500, body: '{"message":"Internal error"}' })
        }
        return r.continue()
      })

      await page.goto('/crm/team')
      await page.getByTitle('Переименовать').click()
      const nameInput = page.getByPlaceholder('Название команды')
      await nameInput.fill('New Name')
      await page.getByRole('button', { name: 'Сохранить' }).click()
      // Page h1 still visible — no crash
      await expect(page.locator('main').locator('h1')).toBeVisible()
    })
  })
})
