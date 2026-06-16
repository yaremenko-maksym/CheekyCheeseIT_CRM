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
  test('editing Telegram fires PATCH /users/me after debounce and shows "Сохранено" toast', async ({
    page,
  }) => {
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
    // Requisites tab content is rendered — RequisitesTab self-mode shows a Card
    // with CardTitle "Реквизиты для выплат" and a CardDescription containing
    // the same phrase ("Выберите метод и заполните реквизиты для выплат").
    // Target the heading specifically to avoid strict-mode violations.
    await expect(page.getByRole('heading', { name: 'Реквизиты для выплат' })).toBeVisible()
    // Tab trigger is also visible — use exact match to avoid colliding with the
    // "Сохранить реквизиты" submit button.
    await expect(page.getByRole('button', { name: 'Реквизиты', exact: true })).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Data-privacy allowlist: JUNIOR self-view MUST expose EXACTLY overview +
  // requisites. All other profile tabs (documents / finance / projects / team /
  // contract) must be absent.
  //
  // Regression guard for fixture drift (mocked-E2E guards lesson, PR #188 §6a):
  // buildSelfView(USERS.junior) mirrors users-access.service.ts:84 exactly:
  //   tabs.push('overview', 'requisites')
  // 'documents' was removed in round-3 §6a — JUNIOR profile shell does NOT
  // have a Documents tab (junior accesses /crm/documents via sidebar nav, not
  // via a profile tab).
  // -------------------------------------------------------------------------

  test('JUNIOR self-view: ONLY overview + requisites tabs visible', async ({ asJunior: page }) => {
    // LIFO override: mockAuthAs registers /users/([^/?]+)$ AFTER /users/me —
    // the generic :id handler wins and returns buildAdminViewingUser instead of
    // buildSelfView. Re-register /users/me last so it takes LIFO priority.
    // See: fixtures.ts mockAuthAs registration order (lines 628 vs 698).
    const API = 'http://localhost:3001/api'
    await page.route(`${API}/users/me`, (r) =>
      r.request().method() === 'PATCH'
        ? r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(USERS.junior),
          })
        : r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(buildSelfView(USERS.junior)),
          }),
    )

    await page.goto('/crm/profile')
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()

    // Allowed tabs — must be present (EXACTLY these two, per service.ts:84)
    await expect(page.getByRole('button', { name: 'Обзор', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Реквизиты', exact: true })).toBeVisible()

    // Forbidden tabs — must be completely absent from DOM (data-privacy allowlist).
    // Each covers a distinct privacy risk for the junior role:
    //   Документы → profile tab absent (junior accesses docs via /crm/documents nav)
    //   Финансы   → surfaces payment history — privacy boundary for junior
    //   Проект    → surfaces project internals (rate, client, senior identity)
    //   Команда   → surfaces team membership and senior/drop identity
    //   Контракт  → only ADMIN-viewing-non-ADMIN gets it
    // Source: users-access.service.ts isSelf JUNIOR branch (line 84).
    await expect(page.getByRole('button', { name: 'Документы', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Финансы', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Проект', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Команда', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Контракт', exact: true })).toHaveCount(0)
  })

  // §2c regression guard: ADMIN self-view must show ONLY overview + requisites.
  // Backend returns overview/projects/team/requisites/documents for ADMIN, but
  // the frontend filter (UserProfileShell §2c) reduces to overview+requisites.
  test('ADMIN self-view: ONLY overview + requisites tabs visible', async ({ asAdmin: page }) => {
    const API = 'http://localhost:3001/api'
    await page.route(`${API}/users/me`, (r) =>
      r.request().method() === 'PATCH'
        ? r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(USERS.admin),
          })
        : r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(buildSelfView(USERS.admin)),
          }),
    )

    await page.goto('/crm/profile')
    await expect(page.getByRole('heading', { name: 'Admin User' })).toBeVisible()

    // Allowed tabs
    await expect(page.getByRole('button', { name: 'Обзор', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Реквизиты', exact: true })).toBeVisible()

    // Hidden by §2c frontend filter
    await expect(page.getByRole('button', { name: 'Проекты', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Команда', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Документы', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Финансы', exact: true })).toHaveCount(0)
  })

  // §2c regression guard: SENIOR self-view must show ONLY overview + requisites.
  // Backend returns overview/projects/team/requisites/documents/finance for SENIOR,
  // but the frontend filter reduces to overview+requisites.
  test('SENIOR self-view: ONLY overview + requisites tabs visible', async ({ asSenior: page }) => {
    const API = 'http://localhost:3001/api'
    await page.route(`${API}/users/me`, (r) =>
      r.request().method() === 'PATCH'
        ? r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(USERS.senior),
          })
        : r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(buildSelfView(USERS.senior)),
          }),
    )

    await page.goto('/crm/profile')
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()

    // Allowed tabs
    await expect(page.getByRole('button', { name: 'Обзор', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Реквизиты', exact: true })).toBeVisible()

    // Hidden by §2c frontend filter
    await expect(page.getByRole('button', { name: 'Проекты', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Команда', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Документы', exact: true })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Финансы', exact: true })).toHaveCount(0)
  })
})
