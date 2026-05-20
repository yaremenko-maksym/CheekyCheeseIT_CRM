/**
 * admin-actions.spec.ts
 *
 * Tests for the AdminActionsMenu — "Действия" dropdown visible when ADMIN
 * views any user profile at /crm/users/:id.
 *
 * The fixture mock returns buildAdminViewingUser(target) for GET /users/:id,
 * which includes the full actions array. PATCH /users/:id/role is intercepted
 * to verify the correct payload and trigger the "Роль изменена" toast.
 * PATCH /users/:id/audit-log stub returns one role_change entry so the
 * audit tab can show "Роль изменена".
 */

import { test, expect, USERS, mockAuthAs, buildAdminViewingUser } from './fixtures'

const API = 'http://localhost:3001/api'

test.describe('Admin actions on user profile', () => {
  // -------------------------------------------------------------------------
  // Действия dropdown renders
  // -------------------------------------------------------------------------

  test('ADMIN viewing junior — "Действия" button is visible', async ({ asAdmin: page }) => {
    await page.goto(`/crm/users/${USERS.junior.id}`)
    await expect(page.getByText('Junior Dev')).toBeVisible()
    await expect(page.getByRole('button', { name: /Действия/ })).toBeVisible()
  })

  test('Действия dropdown lists all admin action items', async ({ asAdmin: page }) => {
    await page.goto(`/crm/users/${USERS.junior.id}`)
    await expect(page.getByText('Junior Dev')).toBeVisible()
    await page.getByRole('button', { name: /Действия/ }).click()

    await expect(page.getByText('✏️ Редактировать данные')).toBeVisible()
    await expect(page.getByText('🎭 Изменить роль')).toBeVisible()
    await expect(page.getByText('💰 Изменить зарплату')).toBeVisible()
    await expect(page.getByText('🏦 Изменить реквизиты')).toBeVisible()
    await expect(page.getByText('📝 Заметка админа')).toBeVisible()
    await expect(page.getByText('🗑️ Архивировать')).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Change-role dialog
  // -------------------------------------------------------------------------

  test('opening "Изменить роль" shows ChangeRoleDialog with current role selected', async ({ asAdmin: page }) => {
    await page.goto(`/crm/users/${USERS.junior.id}`)
    await expect(page.getByText('Junior Dev')).toBeVisible()
    await page.getByRole('button', { name: /Действия/ }).click()
    await page.getByText('🎭 Изменить роль').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'Изменить роль' })).toBeVisible()
    // select element should be present with Junior pre-selected
    const select = dialog.locator('select')
    await expect(select).toBeVisible()
    await expect(select).toHaveValue('JUNIOR')
  })

  test('changing role sends PATCH /users/:id/role with new role and shows toast', async ({ asAdmin: page }) => {
    // Override role PATCH to confirm call was made
    const rolePatched = page.waitForRequest(
      (req) =>
        req.url().includes(`/users/${USERS.junior.id}/role`) && req.method() === 'PATCH',
      { timeout: 5000 },
    )

    await page.goto(`/crm/users/${USERS.junior.id}`)
    await expect(page.getByText('Junior Dev')).toBeVisible()
    await page.getByRole('button', { name: /Действия/ }).click()
    await page.getByText('🎭 Изменить роль').click()

    const dialog = page.getByRole('dialog')
    await dialog.locator('select').selectOption('HR')
    await dialog.getByRole('button', { name: 'Сохранить' }).click()

    const req = await rolePatched
    const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
    expect(body.role).toBe('HR')

    await expect(page.getByText('Роль изменена')).toBeVisible()
  })

  test('cancelling ChangeRoleDialog sends no PATCH', async ({ asAdmin: page }) => {
    let patched = false
    page.on('request', (req) => {
      if (req.url().includes('/role') && req.method() === 'PATCH') patched = true
    })

    await page.goto(`/crm/users/${USERS.junior.id}`)
    await expect(page.getByText('Junior Dev')).toBeVisible()
    await page.getByRole('button', { name: /Действия/ }).click()
    await page.getByText('🎭 Изменить роль').click()

    await page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
    expect(patched).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Audit log tab — visible for ADMIN
  // -------------------------------------------------------------------------

  test('audit tab (История) is visible for ADMIN on any user profile', async ({ asAdmin: page }) => {
    await page.goto(`/crm/users/${USERS.junior.id}`)
    await expect(page.getByText('Junior Dev')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'История' })).toBeVisible()
  })

  test('audit tab renders role_change entry after navigating to ?tab=audit', async ({ asAdmin: page }) => {
    await page.goto(`/crm/users/${USERS.junior.id}?tab=audit`)
    await expect(page.getByText('Junior Dev')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'История' })).toHaveAttribute('data-state', 'active')
    // The stub audit-log returns one entry with action role_change → label "Роль изменена"
    await expect(page.getByText('Роль изменена')).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Non-admin sees no Действия button
  // -------------------------------------------------------------------------

  test('HR viewing senior — no "Действия" button (no actions in permissions)', async ({ page }) => {
    // HR viewing senior: permissions.actions = []
    await mockAuthAs(page, USERS.hr)
    // Override the GET /users/:id to return hr-viewing-senior permissions
    await page.route(new RegExp(`${API}/users/([^/?]+)$`), (r) => {
      if (r.request().method() === 'GET') {
        return r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: {
              ...USERS.senior,
              walletUsdtErc20: null,
              walletUsdtLabel: null,
              bankUahRecipient: null,
              bankUahIban: null,
              bankUahRnokpp: null,
              bankUahBankName: null,
              seniorSharePercent: 26,
              monthlySalary: null,
              archivedAt: null,
              adminNote: null,
            },
            permissions: { tabs: ['overview', 'projects', 'team'], actions: [], fields: {} },
            data: {},
          }),
        })
      }
      return r.fulfill({ status: 204, body: '' })
    })

    await page.goto(`/crm/users/${USERS.senior.id}`)
    await expect(page.getByText('Senior Dev')).toBeVisible()
    await expect(page.getByRole('button', { name: /Действия/ })).toHaveCount(0)
  })
})
