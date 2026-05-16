import { test, expect, PROJECTS, USERS, mockAuthAs } from './fixtures'

test.describe('Projects page', () => {
  // ---------------------------------------------------------------------------
  // Page load & basic rendering
  // ---------------------------------------------------------------------------

  test.describe('Rendering', () => {
    test('shows project cards with name, company, rate and status', async ({ asAdmin: page }) => {
      await page.goto('/crm/projects')
      await expect(page.getByText('AI Platform v2')).toBeVisible()
      await expect(page.getByText('TechCorp AI')).toBeVisible()
      // Rate rendered via toLocaleString() — match formatted number pattern
      await expect(page.getByText(/5[,.\u00a0 ]?000[ ]*USDT/)).toBeVisible()
      await expect(page.getByText('EdTech Portal')).toBeVisible()
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

    test('ADMIN sees create and delete buttons', async ({ asAdmin: page }) => {
      await page.goto('/crm/projects')
      await expect(page.getByRole('button', { name: /новый проект/i })).toBeVisible()
      await expect(page.getByTitle('Удалить проект').first()).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Filter tabs
  // ---------------------------------------------------------------------------

  test.describe('Filters', () => {
    test('"Активные" tab hides closed projects', async ({ asAdmin: page }) => {
      await page.goto('/crm/projects')
      await page.getByRole('button', { name: 'Активные' }).click()
      await expect(page.getByText('AI Platform v2')).toBeVisible()
      await expect(page.getByText('EdTech Portal')).not.toBeVisible()
    })

    test('"Завершённые" tab hides active projects', async ({ asAdmin: page }) => {
      await page.goto('/crm/projects')
      await page.getByRole('button', { name: 'Завершённые' }).click()
      await expect(page.getByText('EdTech Portal')).toBeVisible()
      await expect(page.getByText('AI Platform v2')).not.toBeVisible()
    })

    test('"Все" tab shows all projects', async ({ asAdmin: page }) => {
      await page.goto('/crm/projects')
      await page.getByRole('button', { name: 'Завершённые' }).click()
      await page.getByRole('button', { name: 'Все' }).click()
      await expect(page.getByText('AI Platform v2')).toBeVisible()
      await expect(page.getByText('EdTech Portal')).toBeVisible()
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
  // Project actions: close / reopen — on detail page
  // ---------------------------------------------------------------------------

  test.describe('Close and reopen project', () => {
    test('ADMIN can close an active project', async ({ asAdmin: page }) => {
      // Navigate to active project detail page
      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)

      const patchReq = page.waitForRequest(
        (req) => req.url().includes(`/projects/${PROJECTS[0]!.id}`) && req.method() === 'PATCH',
      )

      await page.getByRole('button', { name: 'Завершить проект' }).click()
      // Confirm in dialog
      await page.getByRole('button', { name: 'Завершить' }).last().click()
      const req = await patchReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ status: 'CLOSED' })
    })

    test('ADMIN can reopen a closed project', async ({ asAdmin: page }) => {
      // Override mock to return CLOSED project for this specific id
      await page.route(`http://localhost:3001/api/projects/${PROJECTS[1]!.id}`, (r) => {
        if (r.request().method() === 'GET') {
          return r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(PROJECTS[1]),
          })
        }
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...PROJECTS[1], ...(JSON.parse(r.request().postData() ?? '{}') as object) }),
        })
      })

      await page.goto(`/crm/projects/${PROJECTS[1]!.id}`)

      const patchReq = page.waitForRequest(
        (req) => req.url().includes(`/projects/${PROJECTS[1]!.id}`) && req.method() === 'PATCH',
      )

      await page.getByRole('button', { name: 'Переоткрыть' }).click()
      const req = await patchReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ status: 'ACTIVE' })
    })
  })

  // ---------------------------------------------------------------------------
  // Delete project dialog — on list page via title button
  // ---------------------------------------------------------------------------

  test.describe('Delete project', () => {
    test('opens delete confirm dialog with project name', async ({ asAdmin: page }) => {
      await page.goto('/crm/projects')
      await page.getByTitle('Удалить проект').first().click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByText(/Удалить проект «AI Platform v2»/)).toBeVisible()
    })

    test('confirm sends DELETE request', async ({ asAdmin: page }) => {
      await page.goto('/crm/projects')

      const deleteReq = page.waitForRequest(
        (req) => req.url().includes(`/projects/${PROJECTS[0]!.id}`) && req.method() === 'DELETE',
      )

      await page.getByTitle('Удалить проект').first().click()
      await page.getByRole('button', { name: 'Удалить' }).last().click()
      await deleteReq
    })

    test('cancel closes dialog without DELETE', async ({ asAdmin: page }) => {
      let deleteCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/projects/') && req.method() === 'DELETE') deleteCalled = true
      })

      await page.goto('/crm/projects')
      await page.getByTitle('Удалить проект').first().click()
      await page.getByRole('button', { name: 'Отмена' }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()
      expect(deleteCalled).toBe(false)
    })
  })

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
      await expect(page.getByRole('button', { name: /добавить/i })).toBeVisible()
    })

    test('"Добавить" opens edit dialog', async ({ asAdmin: page }) => {
      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      await page.getByRole('button', { name: /добавить/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
    })

    test('cancel closes dialog', async ({ asAdmin: page }) => {
      await page.goto(`/crm/projects/${PROJECTS[0]!.id}`)
      await page.getByRole('button', { name: /добавить/i }).click()
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
  // Edge cases
  // ---------------------------------------------------------------------------

  test.describe('Edge cases', () => {
    test('empty projects list renders without crash', async ({ page }) => {
      await mockAuthAs(page, USERS.admin)
      await page.route('http://localhost:3001/api/projects', (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
      )
      await page.goto('/crm/projects')
      await expect(page.getByRole('heading', { name: 'Проекты' })).toBeVisible()
    })

    test('filter shows empty state when no projects match', async ({ page }) => {
      await mockAuthAs(page, USERS.admin)
      await page.route('http://localhost:3001/api/projects', (r) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ ...PROJECTS[0]!, status: 'ACTIVE' }]),
        }),
      )
      await page.goto('/crm/projects')
      await page.getByRole('button', { name: 'Завершённые' }).click()
      await expect(page.getByText('AI Platform v2')).not.toBeVisible()
    })

    test('JUNIOR sees projects but no management controls', async ({ asJunior: page }) => {
      await page.goto('/crm/projects')
      await expect(page.getByText('AI Platform v2')).toBeVisible()
      await expect(page.getByRole('button', { name: /новый проект/i })).not.toBeVisible()
      await expect(page.getByTitle('Удалить проект')).not.toBeVisible()
    })
  })
})
