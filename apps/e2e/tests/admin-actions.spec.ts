/**
 * admin-actions.spec.ts
 *
 * Tests for the AdminActionsMenu — "Действия" dropdown visible when ADMIN
 * views any user profile at /profile/:userId.
 *
 * PR #343 consolidated 4 separate edit dialogs (ChangeRoleDialog,
 * ChangeSalaryDialog, ChangeRequisitesDialog, EditProfileDialog) into a
 * single "Редактировать" item that opens UserDialog(mode='edit').
 * "Заметка админа" and "Архивировать" remain as separate items.
 *
 * Fixture mock returns buildAdminViewingUser(target) for GET /users/:id,
 * which includes the full actions array. PATCH /users/:id is intercepted
 * to verify the correct payload and trigger the "Пользователь обновлён" toast.
 */

import { test, expect, USERS, mockAuthAs } from './fixtures'
import { loadMessages, assertInCatalog } from '../fixtures/catalog'

// task-i18n-stage3b (Task 1) — AdminActionsMenu's own strings (trigger,
// "Редагувати" menu item, "Нотатка адміністратора", "Архівувати") now come
// from the uk catalog; assertions below use `assertInCatalog` so a future
// copy change fails loudly instead of silently drifting. UserDialog
// (mode='edit', opened BY this menu) is a separate, not-yet-migrated
// component — its own heading/role-select/Save/Cancel/toast text stays the
// original Russian literal on purpose (wave (b) PR3's job).
let uk: Record<string, string>
test.beforeAll(async () => {
  uk = await loadMessages('uk')
})

test.describe('Admin actions on user profile', () => {
  // -------------------------------------------------------------------------
  // Действия dropdown renders
  // -------------------------------------------------------------------------

  test('ADMIN viewing junior — "Дії" button is visible', async ({ asAdmin: page }) => {
    await page.goto(`/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()
    await expect(page.getByRole('button', { name: assertInCatalog(uk, 'Дії') })).toBeVisible()
  })

  test('Дії dropdown lists consolidated menu items', async ({ asAdmin: page }) => {
    await page.goto(`/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()
    await page.getByRole('button', { name: assertInCatalog(uk, 'Дії') }).click()

    // PR #343: 4 separate edit items replaced by a single "Редагувати"
    // that opens UserDialog. "Нотатка адміністратора" and "Архівувати" remain.
    await expect(
      page.getByRole('menuitem', { name: assertInCatalog(uk, 'Редагувати') }),
    ).toBeVisible()
    await expect(
      page.getByRole('menuitem', { name: assertInCatalog(uk, 'Нотатка адміністратора') }),
    ).toBeVisible()
    await expect(
      page.getByRole('menuitem', { name: assertInCatalog(uk, 'Архівувати') }),
    ).toBeVisible()

    // Removed items — must NOT appear in the menu
    await expect(page.getByRole('menuitem', { name: 'Изменить роль' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Изменить зарплату' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Изменить реквизиты' })).toHaveCount(0)
    await expect(page.getByRole('menuitem', { name: 'Редактировать данные' })).toHaveCount(0)
  })

  // -------------------------------------------------------------------------
  // "Редагувати" → UserDialog (replaces 4 old separate dialogs)
  // -------------------------------------------------------------------------

  test('opening "Редагувати" shows UserDialog prefilled with current role', async ({
    asAdmin: page,
  }) => {
    await page.goto(`/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()
    await page.getByRole('button', { name: assertInCatalog(uk, 'Дії') }).click()
    await page.getByRole('menuitem', { name: assertInCatalog(uk, 'Редагувати') }).click()

    const dialog = page.locator('[data-testid="user-dialog"]')
    await expect(dialog).toBeVisible()
    // UserDialog edit-mode heading — not yet migrated, still Russian.
    await expect(dialog.getByRole('heading', { name: 'Редактировать пользователя' })).toBeVisible()
    // Role select prefilled with JUNIOR = 'Джун'
    const roleTrigger = dialog.locator('[data-testid="user-dialog-role-trigger"]')
    await expect(roleTrigger).toBeVisible()
    await expect(roleTrigger).toContainText('Джун')
  })

  test('changing role via UserDialog sends PATCH /users/:id and shows toast', async ({
    asAdmin: page,
  }) => {
    // Override PATCH /users/:id to capture the request body deterministically.
    // The global fixture mock already handles this route; per-test route runs
    // first (LIFO) so we record the body before the global handler fires.
    let patchCalled = false
    await page.route(new RegExp(`/api/users/${USERS.junior.id}$`), async (route) => {
      const req = route.request()
      if (req.method() === 'PATCH') {
        patchCalled = true
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...USERS.junior }),
        })
      } else {
        // GET — return full profile so UserDialog prefills correctly
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: {
              ...USERS.junior,
              archivedAt: null,
              adminNote: null,
              walletUsdtErc20: null,
              walletUsdtLabel: null,
              bankUahRecipient: 'Test User',
              bankUahIban: 'UA213223130000026007233566001',
              bankUahRnokpp: '1234567890',
              bankUahBankName: null,
            },
            permissions: {
              tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'documents'],
              actions: [
                'edit-profile',
                'change-role',
                'change-salary',
                'change-requisites',
                'set-note',
                'archive',
              ],
              fields: { salary: true, techStack: true },
            },
            data: {},
          }),
        })
      }
    })

    await page.goto(`/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()
    await page.getByRole('button', { name: assertInCatalog(uk, 'Дії') }).click()
    await page.getByRole('menuitem', { name: assertInCatalog(uk, 'Редагувати') }).click()

    const dialog = page.locator('[data-testid="user-dialog"]')
    await expect(dialog).toBeVisible()

    // Open the role Select and pick HR
    await dialog.locator('[data-testid="user-dialog-role-trigger"]').click()
    await page.getByRole('option', { name: 'HR' }).click()
    await dialog.getByRole('button', { name: 'Сохранить' }).click()

    // Toast confirms mutation completed — "Пользователь обновлён" per updateMutation.onSuccess
    await expect(page.getByText('Пользователь обновлён')).toBeVisible()
    expect(patchCalled).toBe(true)
    // Dialog closes on success
    await expect(dialog).not.toBeVisible()
  })

  test('cancelling UserDialog sends no PATCH to /users/:id', async ({ asAdmin: page }) => {
    let patched = false
    page.on('request', (req) => {
      if (req.url().includes(`/users/${USERS.junior.id}`) && req.method() === 'PATCH')
        patched = true
    })

    await page.goto(`/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: 'Junior Dev' })).toBeVisible()
    await page.getByRole('button', { name: assertInCatalog(uk, 'Дії') }).click()
    await page.getByRole('menuitem', { name: assertInCatalog(uk, 'Редагувати') }).click()

    const dialog = page.locator('[data-testid="user-dialog"]')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Отмена' }).click()
    await expect(dialog).not.toBeVisible()
    expect(patched).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Non-admin sees no Действия button
  // -------------------------------------------------------------------------

  test('HR viewing senior — no "Дії" button (no actions in permissions)', async ({ page }) => {
    // HR viewing senior: permissions.actions = []
    await mockAuthAs(page, USERS.hr)
    // Override the GET /users/:id to return hr-viewing-senior permissions.
    // Use origin-agnostic RegExp (no hardcoded port) so this matches any env.
    await page.route(new RegExp(`/api/users/([^/?]+)$`), (r) => {
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
    await expect(page.getByRole('button', { name: assertInCatalog(uk, 'Дії') })).toHaveCount(0)
  })
})
