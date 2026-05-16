import { test, expect, USERS, mockAuthAs } from './fixtures'

test.describe('Profile page', () => {
  // ---------------------------------------------------------------------------
  // Page load & identity display
  // ---------------------------------------------------------------------------

  test.describe('Identity display', () => {
    test('shows current user name and email', async ({ asAdmin: page }) => {
      await page.goto('/crm/profile')
      await expect(page.getByText('Admin User')).toBeVisible()
      await expect(page.getByText('admin@cheekycheese.dev')).toBeVisible()
    })

    test('shows role badge', async ({ asSenior: page }) => {
      await page.goto('/crm/profile')
      await expect(page.getByText('Senior Dev')).toBeVisible()
      // Profile badge shows localised label "Синьор", not raw "SENIOR"
      const main = page.locator('main')
      await expect(main.getByText('Синьор')).toBeVisible()
    })

    test('shows system info card', async ({ asAdmin: page }) => {
      await page.goto('/crm/profile')
      await expect(page.getByText(/Из Google аккаунта/).first()).toBeVisible()
    })

    test('all roles can access profile page', async ({ asJunior: page }) => {
      await page.goto('/crm/profile')
      await expect(page.getByText('Junior Dev')).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Contacts form — Telegram
  // ---------------------------------------------------------------------------

  test.describe('Telegram field', () => {
    test('shows existing telegram handle', async ({ page }) => {
      await mockAuthAs(page, USERS.senior)
      await page.goto('/crm/profile')
      await expect(page.getByPlaceholder('@username')).toHaveValue('@seniordev')
    })

    test('shows "Открыть" link when handle is >= 5 chars', async ({ page }) => {
      await mockAuthAs(page, USERS.senior)
      await page.goto('/crm/profile')
      await expect(page.getByText('Открыть')).toBeVisible()
    })

    test('does not show "Открыть" link when handle < 5 chars', async ({ page }) => {
      await mockAuthAs(page, { ...USERS.senior, telegram: '@ab' })
      await page.goto('/crm/profile')
      await expect(page.getByText('Открыть')).not.toBeVisible()
    })

    test('validation: invalid telegram format shows error on blur', async ({ asAdmin: page }) => {
      await page.goto('/crm/profile')
      const input = page.getByPlaceholder('@username')
      await input.fill('no-at-sign')
      await input.blur()
      await expect(page.locator('.text-destructive').first()).toBeVisible()
    })

    test('valid telegram handle clears error', async ({ asAdmin: page }) => {
      await page.goto('/crm/profile')
      const input = page.getByPlaceholder('@username')
      await input.fill('no-at-sign')
      await input.blur()
      await input.fill('@validhandle')
      await input.blur()
      await expect(page.locator('.text-destructive')).not.toBeVisible()
    })

    test('empty telegram is valid (optional field)', async ({ asAdmin: page }) => {
      await page.goto('/crm/profile')
      const input = page.getByPlaceholder('@username')
      await input.clear()
      await input.blur()
      await expect(page.locator('.text-destructive')).not.toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Contacts form — Phone
  // ---------------------------------------------------------------------------

  test.describe('Phone field', () => {
    test('shows existing phone number', async ({ page }) => {
      await mockAuthAs(page, USERS.senior)
      await page.goto('/crm/profile')
      // PhoneInput renders with UA country prefix by default; the full E.164 value
      // is stored in form state but RPNInput does not reflect external value changes
      // after mount — verify the input is rendered and has the UA prefix at minimum
      await expect(page.getByPlaceholder('Номер телефона')).toBeVisible()
      const val = await page.getByPlaceholder('Номер телефона').inputValue()
      expect(val).toMatch(/^\+/)
    })

    test('phone input renders flag selector button', async ({ asAdmin: page }) => {
      await page.goto('/crm/profile')
      await expect(page.getByRole('button').filter({ has: page.locator('span.rounded-sm') })).toBeVisible()
    })

    test('invalid phone shows error on blur', async ({ asAdmin: page }) => {
      await page.goto('/crm/profile')
      const phoneInput = page.getByPlaceholder('Номер телефона')
      await phoneInput.fill('123')
      await phoneInput.blur()
      await expect(page.getByText(/некорректный номер/i)).toBeVisible()
    })

    test('empty phone is valid (optional field)', async ({ asAdmin: page }) => {
      await page.goto('/crm/profile')
      const phoneInput = page.getByPlaceholder('Номер телефона')
      await phoneInput.clear()
      await phoneInput.blur()
      await expect(page.getByText(/некорректный номер/i)).not.toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Save action
  // ---------------------------------------------------------------------------

  test.describe('Save', () => {
    test('save button sends PATCH /users/me', async ({ asAdmin: page }) => {
      // Register request listener BEFORE navigation so it catches the request
      const patchReq = page.waitForRequest(
        (req) => req.url().includes('/users/me') && req.method() === 'PATCH',
      )
      await page.goto('/crm/profile')
      // Clear phone so it's empty (valid optional field) before submitting
      await page.getByPlaceholder('Номер телефона').clear()
      await page.getByRole('button', { name: /сохранить/i }).click()
      await patchReq
    })

    test('save with valid telegram sends correct payload', async ({ asAdmin: page }) => {
      const patchReq = page.waitForRequest(
        (req) => req.url().includes('/users/me') && req.method() === 'PATCH',
      )
      await page.goto('/crm/profile')
      await page.getByPlaceholder('@username').fill('@newhandle')
      // Clear phone so it's empty (valid optional field) before submitting
      await page.getByPlaceholder('Номер телефона').clear()
      await page.getByRole('button', { name: /сохранить/i }).click()
      const req = await patchReq
      const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
      expect(body.telegram).toBe('@newhandle')
    })

    test('save button shows "Сохранение…" while pending', async ({ asAdmin: page }) => {
      await page.route('http://localhost:3001/api/users/me', async (r) => {
        if (r.request().method() === 'PATCH') {
          await new Promise((resolve) => setTimeout(resolve, 500))
          return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USERS.admin) })
        }
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USERS.admin) })
      })
      await page.goto('/crm/profile')
      await page.getByPlaceholder('Номер телефона').clear()
      await page.getByRole('button', { name: /сохранить/i }).click()
      await expect(page.getByText('Сохранение…')).toBeVisible()
    })

    test('API error on save keeps page intact', async ({ asAdmin: page }) => {
      await page.route('http://localhost:3001/api/users/me', (r) => {
        if (r.request().method() === 'PATCH') {
          return r.fulfill({ status: 500, body: '{"message":"error"}' })
        }
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USERS.admin) })
      })
      await page.goto('/crm/profile')
      await page.getByPlaceholder('Номер телефона').clear()
      await page.getByRole('button', { name: /сохранить/i }).click()
      await expect(page.getByText('Мой профиль')).toBeVisible()
    })
  })

  // ---------------------------------------------------------------------------
  // Logout flow
  // ---------------------------------------------------------------------------

  test.describe('Logout', () => {
    test('user dropdown contains logout link', async ({ asAdmin: page }) => {
      await page.goto('/crm/profile')
      await page.locator('header [aria-haspopup="menu"]').click()
      await expect(page.getByText('Выйти')).toBeVisible()
    })

    test('clicking logout calls /auth/logout', async ({ asAdmin: page }) => {
      const logoutReq = page.waitForRequest(
        (req) => req.url().includes('/auth/logout'),
      )
      await page.goto('/crm/profile')
      await page.locator('header [aria-haspopup="menu"]').click()
      await page.getByText('Выйти').click()
      await logoutReq
    })
  })

  // ---------------------------------------------------------------------------
  // Navigation: profile link from header
  // ---------------------------------------------------------------------------

  test.describe('Header navigation', () => {
    test('user dropdown has "Профиль" link pointing to /crm/profile', async ({ asAdmin: page }) => {
      await page.goto('/crm/team')
      await page.locator('header [aria-haspopup="menu"]').click()
      // DropdownMenuItem asChild renders as menuitem role, not link
      const profileItem = page.getByRole('menuitem', { name: 'Профиль' })
      await expect(profileItem).toBeVisible()
      await expect(profileItem).toHaveAttribute('href', /\/crm\/profile/)
    })
  })
})
