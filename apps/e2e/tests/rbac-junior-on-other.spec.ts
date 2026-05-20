/**
 * rbac-junior-on-other.spec.ts
 *
 * RBAC: JUNIOR viewing another user's profile on /crm/users/:id.
 *
 * Permissions matrix (JUNIOR → any other user outside their team):
 *   tabs:    [] (empty — no tabs rendered at all)
 *   actions: []
 *
 * The UserProfileShell renders the header unconditionally, but the Tabs
 * section is only rendered when permissions.tabs.length > 0. With an empty
 * tabs array the TabsList is absent entirely.
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
          seniorSharePercent: 26,
          monthlySalary: null,
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
    await page.goto(`/crm/users/${USERS.accountant.id}`)
    await expect(page.getByText('Accountant User')).toBeVisible()
  })

  test('no tabs are rendered at all', async ({ page }) => {
    await mockJuniorViewingOther(page, USERS.accountant)
    await page.goto(`/crm/users/${USERS.accountant.id}`)
    await expect(page.getByText('Accountant User')).toBeVisible()
    await expect(page.getByRole('tab')).toHaveCount(0)
  })

  test('no "Действия" button rendered', async ({ page }) => {
    await mockJuniorViewingOther(page, USERS.accountant)
    await page.goto(`/crm/users/${USERS.accountant.id}`)
    await expect(page.getByText('Accountant User')).toBeVisible()
    await expect(page.getByRole('button', { name: /Действия/ })).toHaveCount(0)
  })

  test('Финансы tab not present', async ({ page }) => {
    await mockJuniorViewingOther(page, USERS.senior)
    await page.goto(`/crm/users/${USERS.senior.id}`)
    await expect(page.getByText('Senior Dev')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Финансы' })).toHaveCount(0)
  })

  test('Реквизиты tab not present', async ({ page }) => {
    await mockJuniorViewingOther(page, USERS.senior)
    await page.goto(`/crm/users/${USERS.senior.id}`)
    await expect(page.getByText('Senior Dev')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Реквизиты' })).toHaveCount(0)
  })

  test('История tab not present', async ({ page }) => {
    await mockJuniorViewingOther(page, USERS.senior)
    await page.goto(`/crm/users/${USERS.senior.id}`)
    await expect(page.getByText('Senior Dev')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'История' })).toHaveCount(0)
  })

  test('Обзор tab not present (no tabs at all)', async ({ page }) => {
    await mockJuniorViewingOther(page, USERS.hr)
    await page.goto(`/crm/users/${USERS.hr.id}`)
    await expect(page.getByText('HR Manager')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Обзор' })).toHaveCount(0)
  })

  test('JUNIOR can still navigate back — "К списку" button present', async ({ page }) => {
    await mockJuniorViewingOther(page, USERS.senior)
    await page.goto(`/crm/users/${USERS.senior.id}`)
    await expect(page.getByText('Senior Dev')).toBeVisible()
    // UserProfileHeader renders "К списку" when onBack prop is provided (mode="view")
    await expect(page.getByRole('button', { name: 'К списку' })).toBeVisible()
  })
})
