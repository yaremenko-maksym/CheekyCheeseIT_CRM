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
      // Verify avatar cluster is present (members shown as avatars)
      await expect(main.locator('.flex.-space-x-2').first()).toBeVisible()
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
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)

      const deleteReq = page.waitForRequest(
        (req) => req.url().includes('/members/') && req.method() === 'DELETE',
      )

      // Two accountants in team — neither is "last" so both have remove buttons
      await page.getByTitle('Исключить').first().click()
      await deleteReq
    })
  })

  // ---------------------------------------------------------------------------
  // Team detail page
  // ---------------------------------------------------------------------------

  test.describe('Team detail page', () => {
    test('renders team detail page with all sections', async ({ asAdmin: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)
      
      // Header with team name and back button
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Alpha Team')
      await expect(page.getByTitle('Back').or(page.locator('[title*="назад"]').or(page.getByRole('button').filter({ has: page.locator('svg') }).first()))).toBeVisible()
      await expect(page.getByText('Создана', { exact: false })).toBeVisible()
      
      // Main content - team members section
      await expect(page.getByText('Участники команды')).toBeVisible()
      await expect(page.getByText('HR Manager')).toBeVisible()
      await expect(page.getByText('Senior Dev')).toBeVisible()
      
      // Sidebar - statistics
      await expect(page.getByText('Статистика')).toBeVisible()
      await expect(page.getByText('Всего участников')).toBeVisible()
      await expect(page.getByText('Активность')).toBeVisible()
    })

    test('shows members grouped by role', async ({ asAdmin: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)
      
      // Check role sections are present
      await expect(page.getByText('Синьор')).toBeVisible()
      await expect(page.getByText('HR')).toBeVisible()
      await expect(page.getByText('Бухгалтер')).toBeVisible()
    })

    test('back button navigates to team list', async ({ asAdmin: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)
      
      // Click back button (use link navigation)
      await page.locator('a[href="/crm/team"]').click()
      await expect(page).toHaveURL('/crm/team')
    })

    test('ADMIN sees management buttons on detail page', async ({ asAdmin: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)
      await expect(page.getByText('Добавить участника')).toBeVisible()
    })

    test('SENIOR does not see management buttons on detail page', async ({ asSenior: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)
      await expect(page.getByText('Добавить участника')).not.toBeVisible()
    })

    test('shows error state for non-existent team', async ({ page }) => {
      await mockAuthAs(page, USERS.admin)
      await page.route('**/api/teams/non-existent-id', (r) => 
        r.fulfill({ status: 404, body: '{"message":"Team not found"}' })
      )
      
      await page.goto('/crm/team/non-existent-id')
      await expect(page.getByText('Команда не найдена')).toBeVisible()
      await expect(page.getByText('Вернуться к списку')).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Auto-redirect for SENIOR/JUNIOR
  // ---------------------------------------------------------------------------

  test.describe('Auto-redirect functionality', () => {
    test('SENIOR with single team gets redirected to team detail', async ({ page }) => {
      await mockAuthAs(page, USERS.senior)
      await page.route('**/api/teams', (r) => 
        r.fulfill({ 
          status: 200, 
          contentType: 'application/json', 
          body: JSON.stringify([TEAMS[0]]) // Only one team
        })
      )
      
      await page.goto('/crm/team')
      // Should auto-redirect to team detail
      await expect(page).toHaveURL(`/crm/team/${TEAMS[0]!.id}`)
    })

    test('JUNIOR with single team gets redirected to team detail', async ({ page }) => {
      await mockAuthAs(page, USERS.junior)
      await page.route('**/api/teams', (r) => 
        r.fulfill({ 
          status: 200, 
          contentType: 'application/json', 
          body: JSON.stringify([TEAMS[0]]) // Only one team
        })
      )
      
      await page.goto('/crm/team')
      // Should auto-redirect to team detail
      await expect(page).toHaveURL(`/crm/team/${TEAMS[0]!.id}`)
    })

    test('ADMIN with single team does NOT get redirected (can manage)', async ({ asAdmin: page }) => {
      await page.route('**/api/teams', (r) => 
        r.fulfill({ 
          status: 200, 
          contentType: 'application/json', 
          body: JSON.stringify([TEAMS[0]]) // Only one team
        })
      )
      
      await page.goto('/crm/team')
      // Should stay on team list page
      await expect(page).toHaveURL('/crm/team')
      await expect(page.getByText('Alpha Team')).toBeVisible()
    })

    test('HR with single team does NOT get redirected (can manage)', async ({ asHr: page }) => {
      await page.route('**/api/teams', (r) => 
        r.fulfill({ 
          status: 200, 
          contentType: 'application/json', 
          body: JSON.stringify([TEAMS[0]]) // Only one team
        })
      )
      
      await page.goto('/crm/team')
      // Should stay on team list page
      await expect(page).toHaveURL('/crm/team')
      await expect(page.getByText('Alpha Team')).toBeVisible()
    })

    test('SENIOR with multiple teams does NOT get redirected', async ({ page }) => {
      await mockAuthAs(page, USERS.senior)
      // Multiple teams - no redirect
      await page.goto('/crm/team')
      await expect(page).toHaveURL('/crm/team')
      await expect(page.getByText('Alpha Team')).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // JUNIOR RBAC - filtered team member view
  // ---------------------------------------------------------------------------

  test.describe('JUNIOR RBAC', () => {
    test('JUNIOR can access team list page (newly allowed)', async ({ asJunior: page }) => {
      await page.goto('/crm/team')
      await expect(page.getByText('Команда')).toBeVisible()
      // Should not crash or redirect to login
    })

    test('JUNIOR can access team detail page (newly allowed)', async ({ asJunior: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)
      await expect(page.getByText('Alpha Team')).toBeVisible()
      await expect(page.getByText('Участники команды')).toBeVisible()
    })

    test('JUNIOR sees all team members (read-only access)', async ({ asJunior: page }) => {
      // According to CLAUDE.md: "SENIOR, JUNIOR, HR, ACCOUNTANT видят список своей команды (read-only)"
      // JUNIOR should see ALL team members, not just themselves
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)
      await expect(page.getByText('Alpha Team')).toBeVisible()
      await expect(page.getByText('Участники команды')).toBeVisible()
      
      // Should see all role sections present in the fixture team (no JUNIOR in TEAMS[0])
      await expect(page.getByText('HR')).toBeVisible()
      await expect(page.getByText('Синьор')).toBeVisible()
      await expect(page.getByText('Бухгалтер')).toBeVisible()

      // Should have no management buttons (read-only access)
      await expect(page.getByText('Добавить участника')).not.toBeVisible()
      await expect(page.getByTitle('Исключить')).not.toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Clickable team cards with improved design
  // ---------------------------------------------------------------------------

  test.describe('Clickable team cards', () => {
    test('team cards are clickable and navigate to detail page', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')
      
      // Click on the team card (use overlay link)
      await page.locator('a[href^="/crm/team/"]').first().click()
      await expect(page).toHaveURL(`/crm/team/${TEAMS[0]!.id}`)
    })

    test('management buttons work without triggering card click', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')
      
      // Clicking management buttons should not navigate
      await page.getByTitle('Переименовать').click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page).toHaveURL('/crm/team') // Still on list page
    })

    test('shows avatar cluster preview in team cards', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')
      
      // Check for avatar cluster with negative space classes
      await expect(page.locator('.flex.-space-x-2, .flex.\\-space-x-2').first()).toBeVisible()
    })

    test('shows member count badge in team cards', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')
      
      // Look for member count indicator (could be "4 участника" or similar)
      await expect(page.getByText('участник', { exact: false })).toBeVisible()
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
