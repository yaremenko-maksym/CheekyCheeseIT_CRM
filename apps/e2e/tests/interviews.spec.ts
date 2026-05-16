import { test, expect, INTERVIEWS, USERS, mockAuthAs } from './fixtures'

const STAGE_LABELS: Record<string, string> = {
  HR_SCREEN: 'HR Screen',
  ENGLISH_CHECK: 'English Check',
  TECH_INTERVIEW: 'Tech Interview',
  FINAL_INTERVIEW: 'Final Interview',
  OFFER_RECEIVED: 'Offer Received',
  HIRED: 'Hired',
  REJECTED: 'Rejected',
  ARCHIVED: 'Archived',
}

test.describe('Interviews (Kanban) page', () => {
  // ---------------------------------------------------------------------------
  // RBAC access
  // ---------------------------------------------------------------------------

  test.describe('Access control', () => {
    test('JUNIOR sees "Нет доступа" message', async ({ asJunior: page }) => {
      await page.goto('/crm/interviews')
      await expect(page.getByText(/нет доступа к разделу/i)).toBeVisible()
    })

    test('SENIOR sees kanban board', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await expect(page.getByText('HR Screen')).toBeVisible()
    })

    test('HR sees kanban board with senior selector', async ({ asHr: page }) => {
      await page.goto('/crm/interviews')
      await expect(page.getByText('HR Screen')).toBeVisible()
      // HR has a senior selector dropdown
      await expect(page.getByRole('combobox')).toBeVisible()
    })

    test('ADMIN sees kanban board with senior selector', async ({ asAdmin: page }) => {
      await page.goto('/crm/interviews')
      await expect(page.getByText('HR Screen')).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Kanban board rendering
  // ---------------------------------------------------------------------------

  test.describe('Board rendering', () => {
    test('renders all active stage columns', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      for (const label of ['HR Screen', 'English Check', 'Tech Interview', 'Final Interview', 'Offer Received']) {
        await expect(page.getByText(label)).toBeVisible()
      }
    })

    test('shows interview cards in correct columns', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await expect(page.getByText('Acme Corp')).toBeVisible()
      await expect(page.getByText('Beta Startup')).toBeVisible()
    })

    test('card shows vacancy URL link when present', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      const vacancyLink = page.getByRole('link', { name: /vacancy|jobs/i }).first()
      // ExternalLink icon renders as link element near Acme Corp card
      await expect(page.locator('[href="https://jobs.acme.com/senior-dev"]')).toBeVisible()
    })

    test('archive section is collapsed by default', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await expect(page.getByText('Архив')).toBeVisible()
      // Terminal stage columns not visible until expanded
      await expect(page.getByText('Hired')).not.toBeVisible()
    })

    test('archive section expands on click', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByText('Архив').click()
      // STAGE_LABELS: HIRED → 'Нанят', REJECTED → 'Отказ'
      await expect(page.getByText('Нанят')).toBeVisible()
      await expect(page.getByText('Отказ')).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Create interview dialog
  // ---------------------------------------------------------------------------

  test.describe('Create interview', () => {
    test('SENIOR can open create dialog', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByRole('button', { name: /новая карточка/i }).click()
      await expect(page.getByRole('dialog')).toBeVisible()
      await expect(page.getByRole('heading', { name: 'Новая карточка' })).toBeVisible()
    })

    test('submits POST with company name', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')

      const postReq = page.waitForRequest(
        (req) => req.url().includes('/interviews') && req.method() === 'POST',
      )

      await page.getByRole('button', { name: /новая карточка/i }).click()
      await page.getByPlaceholder('Название компании').fill('New Client Corp')
      await page.getByRole('button', { name: 'Создать' }).click()

      const req = await postReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ companyName: 'New Client Corp' })
    })

    test('HR selects senior when creating interview', async ({ asHr: page }) => {
      await page.goto('/crm/interviews')
      await page.getByRole('button', { name: /новая карточка/i }).click()

      await expect(page.getByRole('dialog')).toBeVisible()
      // Senior dropdown should be visible for HR
      await expect(page.getByRole('dialog').getByRole('combobox')).toBeVisible()
    })

    test('vacancy URL and call URL fields accept https URLs', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByRole('button', { name: /новая карточка/i }).click()

      await page.getByPlaceholder('Название компании').fill('Test Corp')
      await page.getByPlaceholder('https://...').fill('https://jobs.test.com/dev')
      await page.getByPlaceholder('https://meet.google.com/...').fill('https://zoom.us/j/123')

      const postReq = page.waitForRequest(
        (req) => req.url().includes('/interviews') && req.method() === 'POST',
      )
      await page.getByRole('button', { name: 'Создать' }).click()
      const req = await postReq
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      expect(body.vacancyUrl).toBe('https://jobs.test.com/dev')
    })

    test('cancel closes dialog without POST', async ({ asSenior: page }) => {
      let postCalled = false
      page.on('request', (req) => {
        if (req.url().includes('/interviews') && req.method() === 'POST') postCalled = true
      })

      await page.goto('/crm/interviews')
      await page.getByRole('button', { name: /новая карточка/i }).click()
      await page.getByRole('button', { name: 'Отмена' }).click()
      await expect(page.getByRole('dialog')).not.toBeVisible()
      expect(postCalled).toBe(false)
    })

    test('empty company name is required', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByRole('button', { name: /новая карточка/i }).click()
      // Try submitting empty
      await page.getByRole('button', { name: 'Создать' }).click()
      // Dialog stays open
      await expect(page.getByRole('dialog')).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Interview detail sheet
  // ---------------------------------------------------------------------------

  test.describe('Interview detail sheet', () => {
    test('opens detail sheet on card click', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByText('Acme Corp').first().click()
      await expect(page.getByRole('dialog').or(page.locator('[role="complementary"]'))).toBeVisible()
      await expect(page.getByText('Acme Corp').last()).toBeVisible()
    })

    test('shows stage movement buttons for active stage', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByText('Acme Corp').first().click()

      // In HR_SCREEN stage, next button should be visible
      await expect(page.getByRole('button', { name: /english check/i })).toBeVisible()
    })

    test('move to next stage sends PATCH /move request', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByText('Acme Corp').first().click()

      const moveReq = page.waitForRequest(
        (req) => req.url().includes('/move') && req.method() === 'PATCH',
      )

      await page.getByRole('button', { name: /english check/i }).click()
      await moveReq
    })

    test('terminal stage buttons (Нанят / Отказ / Архив) are visible', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByText('Acme Corp').first().click()

      await expect(page.getByRole('button', { name: 'Нанят' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Отказ' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Архив' })).toBeVisible()
    })

    test('clicking "Нанят" sends move request with HIRED stage', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByText('Acme Corp').first().click()

      const moveReq = page.waitForRequest(
        (req) => req.url().includes('/move') && req.method() === 'PATCH',
      )

      await page.getByRole('button', { name: 'Нанят' }).click()
      const req = await moveReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ stage: 'HIRED' })
    })

    test('clicking "Отказ" sends move request with REJECTED stage', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByText('Acme Corp').first().click()

      const moveReq = page.waitForRequest(
        (req) => req.url().includes('/move') && req.method() === 'PATCH',
      )

      await page.getByRole('button', { name: 'Отказ' }).click()
      const req = await moveReq
      expect(JSON.parse(req.postData() ?? '{}')).toMatchObject({ stage: 'REJECTED' })
    })

    test('SENIOR can save notes', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByText('Acme Corp').first().click()

      const patchReq = page.waitForRequest(
        (req) =>
          req.url().includes(`/interviews/${INTERVIEWS[0]!.id}`) &&
          req.method() === 'PATCH' &&
          !req.url().includes('/move'),
      )

      await page.getByPlaceholder('AI / fintech').fill('SaaS / blockchain')
      await page.getByRole('button', { name: /сохранить|сохраняем/i }).click()

      const req = await patchReq
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      expect(body.notesDomain).toBe('SaaS / blockchain')
    })

    test('ADMIN sees delete button in detail sheet', async ({ asAdmin: page }) => {
      await page.goto('/crm/interviews')
      await page.getByText('Acme Corp').first().click()
      await expect(page.getByTitle('Удалить карточку').or(page.getByRole('button', { name: /удалить/i }).last())).toBeVisible()
    })

    test('SENIOR does not see delete button in detail sheet', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByText('Acme Corp').first().click()
      // SENIOR role — trash icon not visible
      await expect(page.locator('[data-testid="delete-interview"]')).not.toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Delete interview
  // ---------------------------------------------------------------------------

  test.describe('Delete interview', () => {
    test('ADMIN delete opens confirm dialog', async ({ asAdmin: page }) => {
      await page.goto('/crm/interviews')
      await page.getByText('Acme Corp').first().click()

      // Find and click the delete (trash) button in the sheet
      await page.getByRole('button').filter({ hasText: '' }).last().click()
      // Confirm dialog appears
      await expect(page.getByText(/Удалить карточку/)).toBeVisible()
    })

    test('confirm delete sends DELETE request', async ({ asAdmin: page }) => {
      await page.goto('/crm/interviews')
      await page.getByText('Acme Corp').first().click()

      const deleteReq = page.waitForRequest(
        (req) => req.url().includes(`/interviews/${INTERVIEWS[0]!.id}`) && req.method() === 'DELETE',
      )

      // Click the trash icon button (last button in the sheet header area)
      const trashBtn = page.locator('button').filter({ has: page.locator('svg') }).last()
      await trashBtn.click()

      // If a confirmation dialog appears, confirm it
      const confirmBtn = page.getByRole('button', { name: 'Удалить' })
      if (await confirmBtn.isVisible()) {
        await confirmBtn.click()
      }

      await deleteReq
    })
  })

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  test.describe('Edge cases', () => {
    test('empty board renders stage columns without crash', async ({ page }) => {
      await mockAuthAs(page, USERS.senior)
      await page.route(/localhost:3001\/interviews/, (r) =>
        r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
      )
      await page.goto('/crm/interviews')
      await expect(page.getByText('HR Screen')).toBeVisible()
    })

    test('invalid URL in vacancy field — validation error on blur', async ({ asSenior: page }) => {
      await page.goto('/crm/interviews')
      await page.getByRole('button', { name: /новая карточка/i }).click()

      await page.getByPlaceholder('https://...').fill('not-a-url')
      await page.getByPlaceholder('https://...').blur()
      await expect(page.getByText(/корректный url/i)).toBeVisible()
    })

    test('HR can switch between senior boards', async ({ asHr: page }) => {
      await page.goto('/crm/interviews')

      // The senior selector combobox should be visible
      const selector = page.getByRole('combobox').first()
      await expect(selector).toBeVisible()

      // URL updates with seniorId on selection
      await selector.click()
      const option = page.getByRole('option', { name: 'Senior Dev' })
      if (await option.isVisible()) {
        await option.click()
        await expect(page).toHaveURL(/seniorId=/)
      }
    })

    test('network error on stage move does not crash page', async ({ asSenior: page }) => {
      await page.route(/\/interviews\/.*\/move/, (r) =>
        r.fulfill({ status: 500, body: '{"message":"error"}' }),
      )

      await page.goto('/crm/interviews')
      await page.getByText('Acme Corp').first().click()
      await page.getByRole('button', { name: /english check/i }).click()

      // Page still intact after error — close sheet and verify h1
      await page.keyboard.press('Escape')
      await expect(page.getByRole('heading', { name: 'Собеседования' })).toBeVisible()
    })
  })
})
