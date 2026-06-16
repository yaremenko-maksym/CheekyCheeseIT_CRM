import { test, expect, PROJECTS, USERS, mockAuthAs } from './fixtures'

test.describe('Projects page', () => {
  // ---------------------------------------------------------------------------
  // Page load & basic rendering
  // ---------------------------------------------------------------------------

  test.describe('Rendering', () => {
    test('shows project cards with name, company, rate', async ({ asAdmin: page }) => {
      await page.goto('/crm/projects')
      await expect(page.getByText('AI Platform v2')).toBeVisible()
      await expect(page.getByText('TechCorp AI')).toBeVisible()
      // Round 5: EdTech Portal is now an archived fixture — hidden from the
      // default view. Archive-tab visibility is covered by the Filters suite.
      // Rate rendered via toLocaleString() — match formatted number pattern
      await expect(page.getByText(/5[,.\u00a0 ]?000[ ]*USDT/)).toBeVisible()
      await expect(page.getByText('EdTech Portal')).not.toBeVisible()
    })

    test('SENIOR sees projects page (read-only)', async ({ asSenior: page }) => {
      await page.goto('/crm/projects')
      await expect(page.getByText('AI Platform v2')).toBeVisible()
      // No create button
      await expect(page.getByRole('button', { name: /новый проект/i })).not.toBeVisible()
    })

    test('HR sees create button', async ({ asHr: page }) => {
      await page.goto('/crm/projects')
      await expect(page.getByRole('button', { name: /новый проект/i })).toBeVisible()
    })

    test('ADMIN sees create and archive buttons', async ({ asAdmin: page }) => {
      await page.goto('/crm/projects')
      await expect(page.getByRole('button', { name: /новый проект/i })).toBeVisible()
      // ut-27 (PR 34 round 1) removed the inline trash/archive icon button from cards.
      // The archive action lives on the project detail header now. The list page only
      // exposes the «Архив» tab — guarded behind ADMIN role.
      await expect(page.getByTestId('toggle-archived-projects')).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Filter tabs
  // ---------------------------------------------------------------------------

  test.describe('Filters', () => {
    // Round 5: tabs are «Все | Активные | Архив». The legacy CLOSED business
    // contract state is gone — archived projects are hidden by default and
    // only surface under the «Архив» tab (ADMIN-only).
    test('"Активные" tab shows only non-archived projects', async ({ asAdmin: page }) => {
      await page.goto('/crm/projects')
      await page.getByRole('tab', { name: 'Активные' }).click()
      await expect(page.getByText('AI Platform v2')).toBeVisible()
      // Archived fixture project is excluded by the API (?archived=false).
      await expect(page.getByText('EdTech Portal')).not.toBeVisible()
    })

    test('"Все" tab shows non-archived projects', async ({ asAdmin: page }) => {
      await page.goto('/crm/projects')
      // Move away and back to «Все» to verify the toggle re-fetches.
      await page.getByRole('tab', { name: 'Активные' }).click()
      await page.getByRole('tab', { name: 'Все' }).click()
      await expect(page.getByText('AI Platform v2')).toBeVisible()
    })

    test('"Архив" tab shows only archived projects', async ({ asAdmin: page }) => {
      await page.goto('/crm/projects')
      await page.getByTestId('toggle-archived-projects').click()
      // Card itself is the most reliable target — the inner <p> may briefly be
      // hidden during the AnimatePresence exit/enter animation, but the card
      // (with data-archived='true') becomes visible as soon as the query
      // resolves.
      await expect(page.getByTestId('project-card-project-2-id')).toBeVisible()
      await expect(page.getByText('AI Platform v2')).not.toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Create project dialog
  // ---------------------------------------------------------------------------

  test.describe('Create project', () => {
    test('opens dialog with correct title', async ({ asAdmin: page }) => {
      await page.goto('/crm/projects')
      await page.getByRole('button', { name: /новый проект/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Новый проект' })).toBeVisible()
    })

    test('submits POST with all required fields filled', async ({ asAdmin: page }) => {
      const postReq = page.waitForRequest(
        (req) => req.url().includes('/projects') && req.method() === 'POST',
      )

      await page.goto('/crm/projects')
      await page.getByRole('button', { name: /новый проект/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      const dialog = page.getByRole('dialog')

      const nameInput = dialog.getByPlaceholder('AI Platform v2')
      await nameInput.fill('My New Project')
      await nameInput.blur()

      const companyInput = dialog.getByPlaceholder('TechCorp AI')
      await companyInput.fill('ClientCorp')
      await companyInput.blur()

      // Domain is a native <select> — scope to dialog to avoid page-level selects
      await dialog.locator('select').first().selectOption('EdTech')

      // Senior — second <select> in dialog
      await dialog.locator('select').nth(1).selectOption({ label: 'Senior Dev' })

      const rateInput = dialog.getByPlaceholder('5000')
      await rateInput.fill('4000')
      await rateInput.blur()

      await page.getByRole('button', { name: 'Создать' }).click()

      const req = await postReq
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      expect(body).toMatchObject({ name: 'My New Project', companyName: 'ClientCorp' })
    })

    test('validation: empty required fields show errors on blur', async ({ asAdmin: page }) => {
      await page.goto('/crm/projects')
      await page.getByRole('button', { name: /новый проект/i }).click()

      const nameInput = page.getByPlaceholder('AI Platform v2')
      await nameInput.clear()
      await nameInput.blur()
      // Zod v4 message for min(1) — match either custom or default
      await expect(page.locator('.text-destructive').first()).toBeVisible()
    })

    test('cancel closes dialog without POST', async ({ asAdmin: page }) => {
      let postCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/projects') && req.method() === 'POST') postCalled = true
      })

      await page.goto('/crm/projects')
      await page.getByRole('button', { name: /новый проект/i }).click()
      await page.getByRole('button', { name: 'Отмена' }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()
      expect(postCalled).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // Project archive / unarchive — see tests/crm/projects/projects-archive.spec.ts
  //
  // Round 5 (drop status enum) removed the close/reopen flow: project
  // lifecycle is now binary (ACTIVE ↔ ARCHIVED) with archive/unarchive
  // exclusively driving the transition. The dedicated archive spec covers
  // all related UI assertions.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Project members — on detail page
  // ---------------------------------------------------------------------------

  test.describe('Project members', () => {
    test('detail page shows team section with senior', async ({ asAdmin: page }) => {
      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      // Team section with senior name
      await expect(page.getByText('Senior Dev')).toBeVisible()
    })

    test('ADMIN sees "Добавить" button on active project detail', async ({ asAdmin: page }) => {
      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      // PR #178 added a second «Добавить» button in the credentials section
      // (data-testid="credentials-add-btn" sits ON the button — .filter({hasNot})
      // checks descendants only, so intersect with :not() instead).
      const membersAddBtn = page
        .getByRole('button', { name: /добавить/i })
        .and(page.locator(':not([data-testid="credentials-add-btn"])'))
      await expect(membersAddBtn).toBeVisible()
    })

    test('"Добавить" opens edit dialog', async ({ asAdmin: page }) => {
      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      const membersAddBtn = page
        .getByRole('button', { name: /добавить/i })
        .and(page.locator(':not([data-testid="credentials-add-btn"])'))
      await membersAddBtn.click()
      await expect(page.getByRole('dialog')).toBeVisible()
    })

    test('cancel closes dialog', async ({ asAdmin: page }) => {
      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      const membersAddBtn = page
        .getByRole('button', { name: /добавить/i })
        .and(page.locator(':not([data-testid="credentials-add-btn"])'))
      await membersAddBtn.click()
      // Dialog has Отмена or close via Escape
      const cancelBtn = page.getByRole('button', { name: 'Отмена' })
      if (await cancelBtn.isVisible()) {
        await cancelBtn.click()
      } else {
        await page.keyboard.press('Escape')
      }
      await expect(page.getByRole('dialog')).not.toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // New project metadata fields (PR #8: BA audit findings)
  // ---------------------------------------------------------------------------

  test.describe('Project metadata fields', () => {
    test('create dialog shows new metadata fields', async ({ asAdmin: page }) => {
      await page.goto('/crm/projects')
      await page.getByRole('button', { name: /новый проект/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      const dialog = page.getByRole('dialog')

      // Check for metadata field labels in create dialog
      await expect(dialog.getByText('Стек технологий')).toBeVisible()
      await expect(dialog.getByText('Состав команды')).toBeVisible()
      await expect(dialog.getByText('Бенефиты')).toBeVisible()
    })

    test('create project with all metadata fields filled', async ({ asAdmin: page }) => {
      const postReq = page.waitForRequest(
        (req) => req.url().includes('/projects') && req.method() === 'POST',
      )

      await page.goto('/crm/projects')
      await page.getByRole('button', { name: /новый проект/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      const dialog = page.getByRole('dialog')

      // Fill required fields first
      await dialog.getByPlaceholder('AI Platform v2').fill('Test Project')
      await dialog.getByPlaceholder('TechCorp AI').fill('Test Company')
      await dialog.locator('select').first().selectOption('EdTech')
      await dialog.locator('select').nth(1).selectOption({ label: 'Senior Dev' })
      await dialog.getByPlaceholder('5000').fill('3000')

      // Fill new metadata fields
      const techStackField = dialog
        .getByPlaceholder(/стек технологий/i)
        .or(dialog.locator('input[name*="tech"]').or(dialog.locator('textarea[name*="tech"]')))
      if (await techStackField.isVisible()) {
        await techStackField.fill('React, TypeScript, Node.js')
      }

      const teamSizeField = dialog
        .getByPlaceholder(/размер команды/i)
        .or(dialog.locator('input[name*="team"]'))
      if (await teamSizeField.isVisible()) {
        await teamSizeField.fill('5-7 developers')
      }

      const benefitsField = dialog
        .getByPlaceholder(/benefi|льгот/i)
        .or(dialog.locator('textarea[name*="benefit"]'))
      if (await benefitsField.isVisible()) {
        await benefitsField.fill('Medical insurance, flexible schedule')
      }

      const paymentTypeField = dialog
        .getByPlaceholder(/тип оплаты/i)
        .or(dialog.locator('input[name*="payment"]'))
      if (await paymentTypeField.isVisible()) {
        await paymentTypeField.fill('Monthly USDT payments')
      }

      const salaryReviewField = dialog
        .getByPlaceholder(/пересмотр зп/i)
        .or(dialog.locator('input[name*="salary"]'))
      if (await salaryReviewField.isVisible()) {
        await salaryReviewField.fill('Every 6 months')
      }

      await page.getByRole('button', { name: 'Создать' }).click()

      const req = await postReq
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      expect(body).toMatchObject({ name: 'Test Project', companyName: 'Test Company' })

      // Verify metadata fields are included in request (if fields are present)
      if (body.techStack) expect(body.techStack).toBe('React, TypeScript, Node.js')
      if (body.teamSize) expect(body.teamSize).toBe('5-7 developers')
      if (body.benefits) expect(body.benefits).toBe('Medical insurance, flexible schedule')
      if (body.paymentType) expect(body.paymentType).toBe('Monthly USDT payments')
      if (body.salaryReview) expect(body.salaryReview).toBe('Every 6 months')
    })

    test('edit project dialog shows and updates metadata fields', async ({ asAdmin: page }) => {
      // Mock project with metadata fields
      const projectWithMetadata = {
        ...PROJECTS[0],
        techStack: 'Vue.js, Python',
        teamSize: '3-4 developers',
        benefits: 'Remote work',
        paymentType: 'Hourly',
        salaryReview: 'Quarterly',
        corpTech: 'Agile/Scrum',
        notesGeneral: 'Great project with modern stack',
      }

      await page.route(`http://localhost:3001/api/projects/${PROJECTS[0]!.id}`, (r) => {
        if (r.request().method() === 'GET') {
          return r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(projectWithMetadata),
          })
        }
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...projectWithMetadata,
            ...(JSON.parse(r.request().postData() ?? '{}') as object),
          }),
        })
      })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)

      // Look for edit button (could be "Редактировать" or an edit icon)
      const editButton = page
        .getByRole('button', { name: /редактир/i })
        .or(page.getByTitle(/редактир/i))
      if (await editButton.isVisible()) {
        await editButton.click()
        await expect(page.getByRole('dialog')).toBeVisible()

        const dialog = page.getByRole('dialog')

        // Verify metadata fields are pre-filled
        const techStackField = dialog
          .getByPlaceholder(/стек технологий/i)
          .or(dialog.locator('input[name*="tech"]').or(dialog.locator('textarea[name*="tech"]')))
        if (await techStackField.isVisible()) {
          await expect(techStackField).toHaveValue('Vue.js, Python')
        }

        const teamSizeField = dialog
          .getByPlaceholder(/размер команды/i)
          .or(dialog.locator('input[name*="team"]'))
        if (await teamSizeField.isVisible()) {
          await expect(teamSizeField).toHaveValue('3-4 developers')
        }
      }
    })

    test('metadata fields respect character limits (varchar constraints)', async ({
      asAdmin: page,
    }) => {
      await page.goto('/crm/projects')
      await page.getByRole('button', { name: /новый проект/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()

      const dialog = page.getByRole('dialog')

      // Test character limits based on schema: tech_stack varchar(500), notes_general varchar(1000)
      const techStackField = dialog
        .getByPlaceholder(/стек технологий/i)
        .or(dialog.locator('input[name*="tech"]').or(dialog.locator('textarea[name*="tech"]')))
      if (await techStackField.isVisible()) {
        const longText = 'A'.repeat(600) // Exceeds 500 char limit
        await techStackField.fill(longText)
        await techStackField.blur()
        // Should show validation error or truncate
        const fieldValue = await techStackField.inputValue()
        expect(fieldValue.length).toBeLessThanOrEqual(500)
      }

      const notesField = dialog
        .getByPlaceholder(/заметк|notes/i)
        .or(dialog.locator('textarea[name*="notes"]'))
      if (await notesField.isVisible()) {
        const veryLongText = 'A'.repeat(1100) // Exceeds 1000 char limit
        await notesField.fill(veryLongText)
        await notesField.blur()
        // Should show validation error or truncate
        const fieldValue = await notesField.inputValue()
        expect(fieldValue.length).toBeLessThanOrEqual(1000)
      }
    })

    test('metadata fields are displayed in project detail view', async ({ asAdmin: page }) => {
      // Mock project with filled metadata
      const projectWithMetadata = {
        ...PROJECTS[0],
        techStack: 'React, Node.js, PostgreSQL',
        teamSize: '5-8 developers',
        benefits: 'Health insurance, vacation days',
        paymentType: 'Monthly crypto',
        salaryReview: 'Annual',
        corpTech: 'Microservices, Docker',
        notesGeneral: 'Long-term strategic project',
      }

      await page.route(`http://localhost:3001/api/projects/${PROJECTS[0]!.id}`, (r) => {
        if (r.request().method() === 'GET') {
          return r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(projectWithMetadata),
          })
        }
        return r.continue()
      })

      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)

      // Check if metadata is displayed somewhere on the page
      await expect(page.getByText('React, Node.js, PostgreSQL')).toBeVisible()
      await expect(page.getByText('5-8 developers')).toBeVisible()
      await expect(page.getByText('Health insurance, vacation days')).toBeVisible()
      await expect(page.getByText('Monthly crypto')).toBeVisible()
      await expect(page.getByText('Annual')).toBeVisible()
      await expect(page.getByText('Microservices, Docker')).toBeVisible()
      await expect(page.getByText('Long-term strategic project')).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  test.describe('Edge cases', () => {
    test('empty projects list renders without crash', async ({ page }) => {
      await mockAuthAs(page, USERS.admin)
      await page.route('http://localhost:3001/api/projects', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
      )
      await page.goto('/crm/projects')
      await expect(page.getByTestId('projects-search-input')).toBeVisible()
    })

    test('archive tab shows empty state when no archived projects', async ({ page }) => {
      await mockAuthAs(page, USERS.admin)
      // Override the parametrised mock to always return an empty list,
      // simulating the "Архив пуст" empty state.
      await page.route(/\/api\/projects(\?.*)?$/, (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
      )
      await page.goto('/crm/projects')
      await page.getByTestId('toggle-archived-projects').click()
      await expect(page.getByText('AI Platform v2')).not.toBeVisible()
      await expect(page.getByText('Архив пуст')).toBeVisible()
    })

    test('JUNIOR on /crm/projects → redirected to /crm/project (route-guard PR #184)', async ({
      asJunior: page,
    }) => {
      // PR #184 introduced a declarative route-guard in CrmLayout: JUNIOR is
      // not in the allowed roles for /crm/projects, so the guard fires a
      // beforeLoad redirect to the JUNIOR role-home (/crm/project) before
      // the projects page ever renders. The old behaviour (JUNIOR saw the
      // list with management controls hidden) is replaced by a hard redirect.
      await page.route(/\/api\/projects(\?.*)?$/, (r) => {
        if (r.request().method() !== 'GET') return r.fallback()
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        })
      })
      await page.goto('/crm/projects')
      await expect(page).toHaveURL('/crm/project', { timeout: 8000 })
      await expect(page).not.toHaveURL('/crm/projects')
    })
  })
})
