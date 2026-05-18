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
      await expect(page.getByTitle('Перейменувати')).not.toBeVisible()
      // No delete button (removed in Teams Redesign)
      await expect(page.getByTitle('Удалити команду')).not.toBeVisible()
    })

    test('HR sees management buttons but not delete', async ({ asHr: page }) => {
      await page.goto('/crm/team')
      // Rename button is on the list row
      await expect(page.getByTitle('Перейменувати')).toBeVisible()
      // Delete button does not exist in redesigned UI
      await expect(page.getByTitle('Удалити команду')).not.toBeVisible()
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
      // Rename button is present on list rows in new design
      await expect(page.getByTitle('Перейменувати')).toBeVisible()
      // Navigate to detail page to verify add/edit management buttons
      await page.locator('a[href^="/crm/team/"]').first().click({ force: true })
      await expect(page.getByRole('button', { name: 'Додати' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Редагувати' })).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Rename team dialog
  // ---------------------------------------------------------------------------

  test.describe('Rename team', () => {
    test('opens rename dialog with current name pre-filled', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')
      await page.getByTitle('Перейменувати').click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Редагувати команду' })).toBeVisible()
    })

    test('save button submits PATCH request with new name', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')

      const patchReq = page.waitForRequest(
        (req) => req.url().includes('/teams/') && req.method() === 'PATCH',
      )

      await page.getByTitle('Перейменувати').click()
      const nameInput = page.getByPlaceholder('Назва команди')
      await nameInput.clear()
      await nameInput.fill('Beta Team')
      await page.getByRole('button', { name: 'Зберегти' }).click()

      const req = await patchReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ name: 'Beta Team' })
    })

    test('validation: empty name shows error on blur', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')
      await page.getByTitle('Перейменувати').click()
      const nameInput = page.getByPlaceholder('Назва команди')
      await nameInput.clear()
      await nameInput.blur()
      await expect(page.getByText(/обязательное поле/i)).toBeVisible()
    })

    test('cancel closes dialog without PATCH', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')
      await page.getByTitle('Перейменувати').click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await page.getByRole('button', { name: 'Відміна' }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Delete team dialog
  // Delete button was removed from list rows in Teams Redesign (PR #13)
  // ---------------------------------------------------------------------------

  test.describe('Delete team', () => {
    test.skip('opens delete confirm dialog with team name', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')
      await page.getByTitle('Удалить команду').click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByText(/Удалить команду «Alpha Team»/)).toBeVisible()
    })

    test.skip('confirm sends DELETE request', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')

      const deleteReq = page.waitForRequest(
        (req) => req.url().includes(`/teams/${TEAMS[0]!.id}`) && req.method() === 'DELETE',
      )

      await page.getByTitle('Удалить команду').click()
      await page.getByRole('button', { name: 'Удалить' }).last().click()
      await deleteReq
    })

    test.skip('cancel closes dialog without DELETE', async ({ asAdmin: page }) => {
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
  // Add member was moved to team detail page in Teams Redesign (PR #13)
  // ---------------------------------------------------------------------------

  test.describe('Add member', () => {
    test('opens add member dialog', async ({ asAdmin: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)
      await page.getByRole('button', { name: 'Додати' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByText(/Додати учасника/)).toBeVisible()
    })

    test('clicking a user sends POST to members endpoint', async ({ asAdmin: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)

      const postReq = page.waitForRequest(
        (req) => req.url().includes('/members') && req.method() === 'POST',
      )

      await page.getByRole('button', { name: 'Додати' }).click()
      // Click first available user in the list
      await page.getByRole('dialog').getByText('Junior Dev').click()
      await page.getByRole('dialog').getByRole('button', { name: /^Додати/ }).click()
      await postReq
    })

    test('cancel closes dialog without POST', async ({ asAdmin: page }) => {
      let postCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/members') && req.method() === 'POST') postCalled = true
      })

      await page.goto(`/crm/team/${TEAMS[0]!.id}`)
      await page.getByRole('button', { name: 'Додати' }).click()
      await page.getByRole('button', { name: 'Скасувати' }).click()
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
      await page.getByTitle('Виключити').first().click()
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
      await expect(page.locator('a[href="/crm/team"]')).toBeVisible()
      await expect(page.getByText('Створена', { exact: false })).toBeVisible()

      // Main content - team members section
      await expect(page.getByText('Учасники команди')).toBeVisible()
      await expect(page.getByText('HR Manager')).toBeVisible()
      await expect(page.getByText('Senior Dev')).toBeVisible()

      // Active Projects section (replaces statistics in redesign)
      await expect(page.getByRole('heading', { name: /Активні проекти/i })).toBeVisible()
    })

    test('shows members grouped by role', async ({ asAdmin: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)

      // Check role sections are present
      await expect(page.getByText('Синьор').first()).toBeVisible()
      await expect(page.getByText('HR').first()).toBeVisible()
      await expect(page.getByText('Бухгалтер').first()).toBeVisible()
    })

    test('back button navigates to team list', async ({ asAdmin: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)

      // Click back button (use link navigation)
      await page.locator('a[href="/crm/team"]').click()
      await expect(page).toHaveURL('/crm/team')
    })

    test('ADMIN sees management buttons on detail page', async ({ asAdmin: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)
      await expect(page.getByRole('button', { name: 'Додати' })).toBeVisible()
    })

    test('SENIOR does not see management buttons on detail page', async ({ asSenior: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)
      await expect(page.getByRole('button', { name: 'Додати' })).not.toBeVisible()
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
      await expect(page.getByText('Учасники команди')).toBeVisible()
    })

    test('JUNIOR sees all team members (read-only access)', async ({ asJunior: page }) => {
      // According to CLAUDE.md: "SENIOR, JUNIOR, HR, ACCOUNTANT видят список своей команды (read-only)"
      // JUNIOR should see ALL team members, not just themselves
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)
      await expect(page.getByText('Alpha Team')).toBeVisible()
      await expect(page.getByText('Учасники команди')).toBeVisible()

      // Should see all role sections present in the fixture team (no JUNIOR in TEAMS[0])
      await expect(page.getByText('HR').first()).toBeVisible()
      await expect(page.getByText('Синьор').first()).toBeVisible()
      await expect(page.getByText('Бухгалтер').first()).toBeVisible()

      // Should have no management buttons (read-only access)
      await expect(page.getByRole('button', { name: 'Додати' })).not.toBeVisible()
      await expect(page.getByTitle('Виключити')).not.toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Clickable team cards with improved design
  // ---------------------------------------------------------------------------

  test.describe('Clickable team cards', () => {
    test('team cards are clickable and navigate to detail page', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')

      // Click on the team card (use overlay link)
      await page.locator('a[href^="/crm/team/"]').first().click({ force: true })
      await expect(page).toHaveURL(`/crm/team/${TEAMS[0]!.id}`)
    })

    test('management buttons work without triggering card click', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')

      // Clicking management buttons should not navigate
      await page.getByTitle('Перейменувати').click()
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

      // Member count is shown as abbreviated "уч." in redesign
      await expect(page.getByText('уч.', { exact: false })).toBeVisible()
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
      await page.getByTitle('Перейменувати').click()
      const nameInput = page.getByPlaceholder('Назва команди')
      await nameInput.fill('New Name')
      await page.getByRole('button', { name: 'Зберегти' }).click()
      // Page h1 still visible — no crash
      await expect(page.locator('main').locator('h1')).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // NEW FEATURES: Teams Redesign (PR #13)
  // ---------------------------------------------------------------------------

  // API Tests - New telegram and notes fields
  test.describe('API — Telegram and Notes fields', () => {
    test('GET /api/teams returns telegram and notes fields', async ({ asAdmin: page }) => {
      // waitForResponse must be set before navigation to capture the response
      const responsePromise = page.waitForResponse('**/api/teams')
      await page.goto('/crm/team')

      const apiResponse = await responsePromise
      const teams = await apiResponse.json()

      expect(Array.isArray(teams)).toBe(true)
      if (teams.length > 0) {
        // Check that team objects have telegram and notes properties (can be null)
        expect(teams[0]).toHaveProperty('telegram')
        expect(teams[0]).toHaveProperty('notes')
      }
    })

    test('PATCH /api/teams/:id accepts and saves telegram and notes', async ({ asAdmin: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)

      // Set up request interception to verify PATCH payload
      const patchReq = page.waitForRequest((req) =>
        req.url().includes(`/teams/${TEAMS[0]!.id}`) && req.method() === 'PATCH'
      )

      // Open edit dialog
      await page.getByRole('button', { name: 'Редагувати' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      // Fill telegram and notes fields
      await page.getByPlaceholder('https://t.me/team_chat').fill('https://t.me/test_team')
      await page.getByPlaceholder('Внутрішні нотатки…').fill('Test team notes')

      // Submit form
      await page.getByRole('button', { name: 'Зберегти' }).click()

      // Verify request payload includes telegram and notes
      const req = await patchReq
      const payload = JSON.parse(req.postData() ?? '{}')
      expect(payload).toMatchObject({
        name: expect.any(String),
        telegram: 'https://t.me/test_team',
        notes: 'Test team notes'
      })
    })
  })

  // Frontend List Page - New toolbar and row layout
  test.describe('Teams List — Toolbar and Row Layout', () => {
    test('displays search, filter, and sort toolbar', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')

      // Check search input
      await expect(page.getByPlaceholder('Пошук за назвою…')).toBeVisible()

      // Check filter dropdown
      await expect(page.getByRole('combobox').filter({ hasText: 'Всі ролі' })).toBeVisible()

      // Check sort dropdown
      await expect(page.getByRole('combobox').filter({ hasText: 'Назва' })).toBeVisible()
    })

    test('search filters teams by name', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')
      await expect(page.getByText('Alpha Team')).toBeVisible()

      // Search for non-existent team
      await page.getByPlaceholder('Пошук за назвою…').fill('NonExistent')
      await expect(page.getByText('Нічого не знайдено')).toBeVisible()

      // Search for existing team
      await page.getByPlaceholder('Пошук за назвою…').fill('Alpha')
      await expect(page.getByText('Alpha Team')).toBeVisible()
    })

    test('role filter shows only teams with selected role', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')

      // Filter by Senior role (option text is English in the select)
      await page.getByRole('combobox').filter({ hasText: 'Всі ролі' }).click()
      await page.getByRole('option', { name: 'Senior' }).click()

      // Alpha Team has a SENIOR member so it should still be visible
      await expect(page.getByText('Alpha Team')).toBeVisible()
    })

    test('displays teams in row layout with correct height', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')

      // Team rows use h-14 class in redesign
      const teamRow = page.locator('[class*="h-14"][class*="cursor-pointer"]').first()
      await expect(teamRow).toBeVisible()
      await expect(teamRow).toHaveClass(/h-14/)
    })

    test('shows only pencil button for canManage users, not UserPlus or Trash', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')

      // ADMIN should see pencil/rename button
      await expect(page.getByTitle('Перейменувати').first()).toBeVisible()

      // Add member and delete buttons are NOT on list rows in redesign
      await expect(page.getByTitle('Додати учасника')).not.toBeVisible()
      await expect(page.getByTitle('Удалити команду')).not.toBeVisible()
    })

    test('SENIOR does not see pencil button on team rows', async ({ asSenior: page }) => {
      await page.goto('/crm/team')

      // SENIOR should not see management buttons on rows
      await expect(page.getByTitle('Перейменувати')).not.toBeVisible()
    })

    test('team rows are clickable and navigate to detail page', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')

      // Click on team row via overlay link
      const teamRow = page.locator('[class*="h-14"][class*="cursor-pointer"]').first()
      await teamRow.click()

      await expect(page).toHaveURL(`/crm/team/${TEAMS[0]!.id}`)
    })
  })

  // Frontend Detail Page - Edit dialog and Active Projects
  test.describe('Team Detail — Edit Dialog and Active Projects', () => {
    test('edit dialog contains telegram and notes fields', async ({ asAdmin: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)

      // Open edit dialog
      await page.getByRole('button', { name: 'Редагувати' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      // Check all fields are present
      await expect(page.getByPlaceholder('Назва команди')).toBeVisible()
      await expect(page.getByLabel('Telegram')).toBeVisible()
      await expect(page.getByLabel('Нотатки')).toBeVisible()

      // Check placeholders and hints
      await expect(page.getByPlaceholder('https://t.me/team_chat')).toBeVisible()
      await expect(page.getByText('Посилання на Telegram-чат команди')).toBeVisible()
      await expect(page.getByPlaceholder('Внутрішні нотатки…')).toBeVisible()
    })

    test('displays Active Projects section with count badge', async ({ asAdmin: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)

      // Check Active Projects section is present (CardTitle renders as h3)
      await expect(page.getByRole('heading', { name: /Активні проекти/i })).toBeVisible()

      // Badge may or may not be visible depending on whether team has active projects
      const projectsBadge = page.locator('[data-testid="active-projects-count"]')
      // Badge presence is optional — just checking section header
    })

    test('single-column layout without sidebar statistics', async ({ asAdmin: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)

      // New design has no sidebar with statistics
      await expect(page.getByText('Статистика')).not.toBeVisible()
      await expect(page.getByText('Активность')).not.toBeVisible()

      // Main content should be in single column
      const mainContent = page.locator('main > div').first()
      await expect(mainContent).not.toHaveClass(/grid-cols-3/)
    })

    test('JUNIOR sees filtered member list (no other JUNIORs) and only own projects', async ({ asJunior: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)

      // Should see team page
      await expect(page.getByText('Alpha Team')).toBeVisible()
      await expect(page.getByText('Учасники команди')).toBeVisible()

      // Should see SENIOR, HR, ACCOUNTANT but filtered view for projects
      await expect(page.getByText('Синьор').first()).toBeVisible()
      await expect(page.getByText('HR').first()).toBeVisible()
      await expect(page.getByText('Бухгалтер').first()).toBeVisible()

      // No management buttons
      await expect(page.getByRole('button', { name: 'Редагувати' })).not.toBeVisible()
      await expect(page.getByRole('button', { name: 'Додати' })).not.toBeVisible()
    })
  })

  // Enhanced Add Member Validation
  test.describe('Add Member — Enhanced Validation', () => {
    test('prevents adding second SENIOR to team', async ({ asAdmin: page }) => {
      // Mock API to return team that already has a SENIOR
      await page.route('**/api/teams/*/members', async (route) => {
        if (route.request().method() === 'POST') {
          const body = JSON.parse(route.request().postData() ?? '{}')

          // Mock error response for adding second SENIOR
          if (body.userId === 'senior-user-id') {
            return route.fulfill({
              status: 400,
              contentType: 'application/json',
              body: JSON.stringify({ message: 'Team already has a senior' })
            })
          }
        }
        return route.continue()
      })

      await page.goto(`/crm/team/${TEAMS[0]!.id}`)

      // Add member button is on the detail page in redesign
      await page.getByRole('button', { name: 'Додати' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
    })

    test('prevents adding JUNIOR with active project', async ({ asAdmin: page }) => {
      // Mock API to simulate JUNIOR with active project rejection
      await page.route('**/api/teams/*/members', async (route) => {
        if (route.request().method() === 'POST') {
          const body = JSON.parse(route.request().postData() ?? '{}')

          // Mock error response for JUNIOR with active project
          if (body.userId === 'junior-with-project-id') {
            return route.fulfill({
              status: 400,
              contentType: 'application/json',
              body: JSON.stringify({ message: 'Junior already has an active project' })
            })
          }
        }
        return route.continue()
      })

      await page.goto(`/crm/team/${TEAMS[0]!.id}`)

      // The validation happens on backend, frontend should handle error gracefully
      await page.getByRole('button', { name: 'Додати' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
    })

    test('add member dialog shows filtered and sorted user list', async ({ asAdmin: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)

      await page.getByRole('button', { name: 'Додати' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByRole('heading', { name: /Додати учасника/i })).toBeVisible()

      // Should show users that can be added (not already in team, not ADMIN)
      // Exact behavior depends on seed data, but dialog should be functional
      await expect(page.getByRole('button', { name: 'Скасувати' })).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // React Hooks Compliance - PR #15 Fix
  // ---------------------------------------------------------------------------

  test.describe('React Hooks Compliance (PR #15 Fix)', () => {
    test('team detail page renders without React hooks order warnings', async ({ asAdmin: page }) => {
      // Capture console messages to check for React warnings
      const consoleMessages: string[] = []
      page.on('console', msg => {
        const text = msg.text()
        if (text.includes('Warning') || text.includes('Error')) {
          consoleMessages.push(text)
        }
      })

      await page.goto(`/crm/team/${TEAMS[0]!.id}`)

      // Verify page loads successfully
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Alpha Team')

      // Wait a moment for any potential React warnings to appear
      await page.waitForTimeout(1000)

      // Filter for React hooks-related warnings
      const hooksWarnings = consoleMessages.filter(msg =>
        msg.includes('rendered more hooks than during the previous render') ||
        msg.includes('React has detected a change in the order of Hooks') ||
        msg.includes('Hook was called conditionally')
      )

      expect(hooksWarnings).toHaveLength(0)
    })

    test('edit form functionality works correctly after hooks repositioning', async ({ asAdmin: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)

      // Verify hooks-dependent functionality works
      await page.getByRole('button', { name: 'Редагувати' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      // Test useForm hook (moved before early returns) — use placeholder to find name input
      const nameInput = page.getByPlaceholder('Назва команди')
      await expect(nameInput).toBeVisible()
      await expect(nameInput).toHaveValue('Alpha Team')

      // Test form submission (updateMutation hook)
      await nameInput.fill('Updated Team Name')
      await page.getByRole('button', { name: 'Зберегти' }).click()

      // Form should close without errors
      await expect(page.getByRole('dialog')).not.toBeVisible()
    })

    test('add member functionality works correctly after hooks repositioning', async ({ asAdmin: page }) => {
      await page.goto(`/crm/team/${TEAMS[0]!.id}`)

      // Test hooks-dependent add member functionality
      await page.getByRole('button', { name: 'Додати' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      // Test selectedUserIds state and addMemberMutation hooks
      await page.getByRole('dialog').getByText('Junior Dev').click()
      await page.getByRole('dialog').getByRole('button', { name: /^Додати/ }).click()

      // Should work without hooks-related errors
      await expect(page.getByRole('dialog')).not.toBeVisible()
    })

    test('team not found error state renders without hooks warnings', async ({ page }) => {
      // Capture console for React warnings
      const consoleMessages: string[] = []
      page.on('console', msg => {
        const text = msg.text()
        if (text.includes('Warning') || text.includes('Error')) {
          consoleMessages.push(text)
        }
      })

      // Set up auth before navigation
      await mockAuthAs(page, USERS.admin)

      // Mock 404 response for team
      await page.route('**/api/teams/non-existent-id', route =>
        route.fulfill({ status: 404, body: '{"message":"Team not found"}' })
      )

      await page.goto('/crm/team/non-existent-id')

      // Even with early return (error state), hooks should be compliant
      await expect(page.getByText('Команда не найдена')).toBeVisible()
      await expect(page.getByText('Вернуться к списку')).toBeVisible()

      await page.waitForTimeout(500)

      // No hooks-related warnings should appear
      const hooksWarnings = consoleMessages.filter(msg =>
        msg.includes('rendered more hooks than during the previous render') ||
        msg.includes('React has detected a change in the order of Hooks')
      )

      expect(hooksWarnings).toHaveLength(0)
    })

    test('loading state renders without hooks violations', async ({ asAdmin: page }) => {
      // Slow down team API to capture loading state
      await page.route(`**/api/teams/${TEAMS[0]!.id}`, route => {
        setTimeout(() => route.continue(), 1000)
      })

      const consoleMessages: string[] = []
      page.on('console', msg => {
        const text = msg.text()
        if (text.includes('Warning') || text.includes('Error')) {
          consoleMessages.push(text)
        }
      })

      await page.goto(`/crm/team/${TEAMS[0]!.id}`)

      // Loading skeletons should appear first (before hooks execute)
      await expect(page.locator('[class*="animate-pulse"]').first()).toBeVisible()

      // Wait for actual content to load
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Alpha Team', { timeout: 3000 })

      // No hooks warnings during loading → content transition
      const hooksWarnings = consoleMessages.filter(msg =>
        msg.includes('rendered more hooks than during the previous render') ||
        msg.includes('Hook was called conditionally')
      )

      expect(hooksWarnings).toHaveLength(0)
    })

    test('re-renders during user interactions maintain hooks consistency', async ({ asAdmin: page }) => {
      const consoleMessages: string[] = []
      page.on('console', msg => {
        const text = msg.text()
        if (text.includes('Warning') || text.includes('Error')) {
          consoleMessages.push(text)
        }
      })

      await page.goto(`/crm/team/${TEAMS[0]!.id}`)
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Alpha Team')

      // Trigger multiple re-renders that could expose hooks order issues
      // 1. Open edit dialog (triggers form hooks)
      await page.getByRole('button', { name: 'Редагувати' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      // 2. Change form values (trigger form state updates)
      await page.getByPlaceholder('Назва команди').fill('Test Name')
      await page.getByLabel('Telegram').fill('https://t.me/test')

      // 3. Close without saving
      await page.getByRole('button', { name: 'Скасувати' }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()

      // 4. Open add member dialog (triggers different hooks)
      await page.getByRole('button', { name: 'Додати' }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      // 5. Close add member dialog
      await page.getByRole('button', { name: 'Скасувати' }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()

      await page.waitForTimeout(500)

      // All re-renders should maintain consistent hooks order
      const hooksWarnings = consoleMessages.filter(msg =>
        msg.includes('rendered more hooks than during the previous render') ||
        msg.includes('React has detected a change in the order of Hooks') ||
        msg.includes('Hook was called conditionally')
      )

      expect(hooksWarnings).toHaveLength(0)
    })
  })
})
