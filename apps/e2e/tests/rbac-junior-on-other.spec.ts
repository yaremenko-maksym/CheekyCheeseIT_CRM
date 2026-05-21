/**
 * rbac-junior-on-other.spec.ts
 *
 * RBAC: JUNIOR viewing another user's profile on /crm/profile/:userId.
 *
 * Permissions matrix (JUNIOR → any other user outside their team):
 *   tabs:    [] (empty — no tabs rendered at all)
 *   actions: []
 *
 * The UserProfileShell renders the header unconditionally, but the Tabs
 * section is only rendered when permissions.tabs.length > 0. With an empty
 * tabs array the TabsList is absent entirely.
 *
 * Note: the "К списку" back button was removed in commit a209dca — header
 * no longer renders it (test for that button has been dropped).
 */

import { test, expect, USERS, mockAuthAs } from './fixtures'

const API = 'http://localhost:3001/api'

/** Mock GET /users/:id returning no-tabs, no-actions for a junior viewer */
async function mockJuniorViewingOther(
  page: import('@playwright/test').Page,
  targetUser: typeof USERS[keyof typeof USERS],
) {
  await mockAuthAs(page, USERS.junior)
  await page.route(new RegExp(`${API}/users/([^/?]+)$`), (r) => {
    if (r.request().method() !== 'GET') return r.fulfill({ status: 204, body: '' })
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        user: {
          ...targetUser,
          walletUsdtErc20: null,
          walletUsdtLabel: null,
          bankUahRecipient: null,
          bankUahIban: null,
          bankUahRnokpp: null,
          bankUahBankName: null,
          archivedAt: null,
          adminNote: null,
        },
        permissions: {
          tabs: [],
          actions: [],
          fields: {},
        },
        data: {},
      }),
    })
  })
}

test.describe('RBAC — JUNIOR viewing another user profile', () => {
  test('target user name appears in header', async ({ page }) => {
    await mockJuniorViewingOther(page, USERS.accountant)
    await page.goto(`/crm/profile/${USERS.accountant.id}`)
    await expect(page.getByRole('heading', { name: 'Accountant User' })).toBeVisible()
  })

  test('no profile tabs are rendered at all', async ({ page }) => {
    await mockJuniorViewingOther(page, USERS.accountant)
    await page.goto(`/crm/profile/${USERS.accountant.id}`)
    await expect(page.getByRole('heading', { name: 'Accountant User' })).toBeVisible()
    // The profile tabs are inside <main>; with permissions.tabs=[] there are none.
    const main = page.locator('main')
    for (const label of ['Обзор', 'Проекты', 'Команда', 'Реквизиты', 'История', 'Финансы']) {
      await expect(main.getByRole('button', { name: label })).toHaveCount(0)
    }
  })

  test('no "Действия" button rendered', async ({ page }) => {
    await mockJuniorViewingOther(page, USERS.accountant)
    await page.goto(`/crm/profile/${USERS.accountant.id}`)
    await expect(page.getByRole('heading', { name: 'Accountant User' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Действия/ })).toHaveCount(0)
  })

  test('Финансы tab not present inside profile shell', async ({ page }) => {
    await mockJuniorViewingOther(page, USERS.senior)
    await page.goto(`/crm/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
    const main = page.locator('main')
    await expect(main.getByRole('button', { name: 'Финансы' })).toHaveCount(0)
  })

  test('Реквизиты tab not present', async ({ page }) => {
    await mockJuniorViewingOther(page, USERS.senior)
    await page.goto(`/crm/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Реквизиты' })).toHaveCount(0)
  })

  test('История tab not present', async ({ page }) => {
    await mockJuniorViewingOther(page, USERS.senior)
    await page.goto(`/crm/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'История' })).toHaveCount(0)
  })

  test('Обзор tab not present inside profile shell (no tabs at all)', async ({ page }) => {
    await mockJuniorViewingOther(page, USERS.hr)
    await page.goto(`/crm/profile/${USERS.hr.id}`)
    await expect(page.getByRole('heading', { name: 'HR Manager' })).toBeVisible()
    const main = page.locator('main')
    await expect(main.getByRole('button', { name: 'Обзор' })).toHaveCount(0)
  })

  test('profile header renders even when no tabs are available', async ({ page }) => {
    // The "К списку" back button was removed in commit a209dca — header now only
    // renders avatar/name/contacts/actions. This regression test asserts the page
    // still shows the target user's identity even with empty permissions.
    await mockJuniorViewingOther(page, USERS.senior)
    await page.goto(`/crm/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
    // Avatar fallback initials are rendered (SD for "Senior Dev")
    await expect(page.getByText('SD').first()).toBeVisible()
  })
})
