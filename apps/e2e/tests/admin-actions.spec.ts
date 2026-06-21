/**
 * admin-actions.spec.ts
 *
 * Tests for the AdminActionsMenu — "Действия" dropdown visible when ADMIN
 * views any user profile at /profile/:userId.
 *
 * The fixture mock returns buildAdminViewingUser(target) for GET /users/:id,
 * which includes the full actions array. PATCH /users/:id/role is intercepted
 * to verify the correct payload and trigger the "Роль изменена" toast.
 * UI revisions (commits a209dca/01ac2e8): emoji prefixes in action menu items
 * removed in favour of lucide-react icons — selectors use plain labels.
 */

import { test, expect, USERS, mockAuthAs } from './fixtures'

const API = 'http://localhost:3001/api'

test.describe('Admin actions on user profile', () => {
  // -------------------------------------------------------------------------
  // Действия dropdown renders
  // -------------------------------------------------------------------------

  test('ADMIN viewing junior — "Действия" button is visible', async ({ asAdmin: page }) => {
    await page.goto(`/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Действия/ })).toBeVisible()
  })

  test('Действия dropdown lists all admin action items', async ({ asAdmin: page }) => {
    await page.goto(`/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()
    await page.getByRole('button', { name: /Действия/ }).click()

    // Emoji prefixes removed in commit a209dca — selectors use plain labels.
    await expect(page.getByRole('menuitem', { name: 'Редактировать данные' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Изменить роль' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Изменить зарплату' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Изменить реквизиты' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Заметка админа' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Архивировать' })).toBeVisible()
  })

  // -------------------------------------------------------------------------
  // Change-role dialog
  // -------------------------------------------------------------------------

  test('opening "Изменить роль" shows ChangeRoleDialog with current role selected', async ({
    asAdmin: page,
  }) => {
    await page.goto(`/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()
    await page.getByRole('button', { name: /Действия/ }).click()
    await page.getByRole('menuitem', { name: 'Изменить роль' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'Изменить роль' })).toBeVisible()
    // ChangeRoleDialog now uses the colored RoleSelect (commit 163b850).
    // The trigger shows the role's localized label via a Badge — ROLE_LABELS.JUNIOR = 'Джун'.
    const combobox = dialog.getByRole('combobox')
    await expect(combobox).toBeVisible()
    await expect(combobox).toContainText('Джун')
  })

  test('changing role sends PATCH /users/:id/role with new role and shows toast', async ({
    asAdmin: page,
  }) => {
    // Use route interception to capture the PATCH payload deterministically.
    // page.waitForRequest races under parallel load — the fixture already
    // registers a mock for this route; we override it here to also record the
    // request body before fulfilling.
    let capturedBody: Record<string, unknown> = {}
    await page.route(new RegExp(`/api/users/${USERS.junior.id}/role$`), async (route) => {
      const req = route.request()
      if (req.method() === 'PATCH') {
        capturedBody = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...USERS.junior, role: capturedBody['role'] }),
        })
      } else {
        await route.continue()
      }
    })

    await page.goto(`/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()
    await page.getByRole('button', { name: /Действия/ }).click()
    await page.getByRole('menuitem', { name: 'Изменить роль' }).click()

    const dialog = page.getByRole('dialog')
    // Open shadcn Select and pick HR
    await dialog.getByRole('combobox').click()
    await page.getByRole('option', { name: 'HR' }).click()
    await dialog.getByRole('button', { name: 'Сохранить' }).click()

    // Wait for toast — confirms the mutation completed and mock was called
    await expect(page.getByText('Роль изменена')).toBeVisible()
    expect(capturedBody['role']).toBe('HR')
  })

  test('cancelling ChangeRoleDialog sends no PATCH', async ({ asAdmin: page }) => {
    let patched = false
    page.on('request', (req) => {
      if (req.url().includes('/role') && req.method() === 'PATCH') patched = true
    })

    await page.goto(`/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()
    await page.getByRole('button', { name: /Действия/ }).click()
    await page.getByRole('menuitem', { name: 'Изменить роль' }).click()

    await page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
    expect(patched).toBe(false)
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

    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Действия/ })).toHaveCount(0)
  })
})
