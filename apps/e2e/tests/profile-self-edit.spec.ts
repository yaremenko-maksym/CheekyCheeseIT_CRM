/**
 * profile-self-edit.spec.ts
 *
 * Tests for /crm/profile — self-editing via ProfileEditFields debounced autosave.
 *
 * Pattern: mock-based (no live server needed). The profile shell calls
 * GET /users/me → UserWithPermissionsResponse. PATCH /users/me fires after
 * 800 ms debounce and triggers the "Сохранено" toast on success.
 *
 * Note: ProfileEditFields lives inside OverviewTab (mode === 'self'). The
 * Telegram / Имя / Phone / Технологии inputs are direct children of the
 * "Личные данные" card.
 */

import { test, expect, USERS, mockAuthAs, buildSelfView } from './fixtures'

const API = 'http://localhost:3001/api'

// ---------------------------------------------------------------------------
// Debounced autosave — telegram field
// ---------------------------------------------------------------------------

test.describe('Profile self-edit — debounced autosave', () => {
  test('editing Telegram fires PATCH /users/me after debounce and shows "Сохранено" toast', async ({ page }) => {
    await mockAuthAs(page, USERS.junior)
    await page.goto('/crm/profile')

    // Wait for profile shell to render (heading from UserProfileHeader)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()

    // Intercept the PATCH — register before typing
    const patchReq = page.waitForRequest(
      (req) => req.url().includes('/users/me') && req.method() === 'PATCH',
      { timeout: 8000 },
    )

    const telegramInput = page.getByLabel('Telegram')
    await telegramInput.fill('@e2e_test_handle')

    // Debounce is 800 ms — wait for the request
    const req = await patchReq
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
    expect(body.telegram).toBe('@e2e_test_handle')

    // Toast appears after successful PATCH (mock returns 200)
    await expect(page.getByText('Сохранено')).toBeVisible()
  })

  test('clearing Telegram sends null in PATCH payload', async ({ page }) => {
    await mockAuthAs(page, USERS.senior)
    await page.goto('/crm/profile')
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()

    const patchReq = page.waitForRequest(
      (req) => req.url().includes('/users/me') && req.method() === 'PATCH',
      { timeout: 8000 },
    )

    await page.getByLabel('Telegram').clear()

    const req = await patchReq
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
    // clearing sends null (optional field)
    expect(body.telegram === null || body.telegram === '').toBe(true)
  })

  test('editing display name fires PATCH with correct displayName', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    await page.goto('/crm/profile')
    await expect(page.getByRole('heading', { name: 'Admin User' })).toBeVisible()

    const patchReq = page.waitForRequest(
      (req) => req.url().includes('/users/me') && req.method() === 'PATCH',
      { timeout: 8000 },
    )

    const nameInput = page.getByLabel('Имя')
    await nameInput.fill('Admin Updated')

    const req = await patchReq
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
    expect(body.displayName).toBe('Admin Updated')
  })

  test('API error during autosave keeps page intact and does not crash', async ({ page }) => {
    await mockAuthAs(page, USERS.admin)
    // Override the PATCH to return 500 after initial GET
    await page.route(`${API}/users/me`, (r) => {
      if (r.request().method() === 'PATCH') {
        return r.fulfill({ status: 500, body: '{"message":"internal error"}' })
      }
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildSelfView(USERS.admin)),
      })
    })

    await page.goto('/crm/profile')
    await expect(page.getByRole('heading', { name: 'Admin User' })).toBeVisible()

    // Type something to trigger autosave — PhoneInput's input has placeholder
    // "Номер телефона" but no <label htmlFor="phone">, so use getByPlaceholder.
    const phoneInput = page.getByPlaceholder('Номер телефона')
    await phoneInput.fill('+380661111111')

    // Wait long enough for debounce to fire
    await page.waitForTimeout(1200)

    // Page is still showing the profile — no crash
    await expect(page.getByRole('heading', { name: 'Admin User' })).toBeVisible()
  })

  test('overview tab is visible by default on /crm/profile', async ({ asJunior: page }) => {
    await page.goto('/crm/profile')
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()
    // AnimatedTabs renders tabs as plain <button>. The overview tab content
    // ("Технологии" card or "Личные данные" card) is what's visible by default.
    await expect(page.getByRole('button', { name: 'Обзор' })).toBeVisible()
    // Personal-data form section is visible (mode === 'self' renders ProfileEditFields)
    await expect(page.getByText('Личные данные')).toBeVisible()
  })

  test('requisites tab activates via ?tab=requisites search param', async ({ page }) => {
    await mockAuthAs(page, USERS.junior)
    await page.goto('/crm/profile?tab=requisites')
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()
    // Requisites tab content is rendered — RequisitesEditForm shows the card title.
    await expect(page.getByText('Реквизиты для выплат')).toBeVisible()
    // Tab trigger is also visible — use exact match to avoid colliding with the
    // "Сохранить реквизиты" submit button.
    await expect(page.getByRole('button', { name: 'Реквизиты', exact: true })).toBeVisible()
  })
})
