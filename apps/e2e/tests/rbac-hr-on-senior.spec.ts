/**
 * rbac-hr-on-senior.spec.ts
 *
 * RBAC: HR viewing a SENIOR profile on /crm/users/:id.
 *
 * Permissions matrix (HR → SENIOR in own team):
 *   tabs:    overview, projects, team
 *   actions: [] (no admin actions)
 *
 * Tabs that must NOT appear: finance, requisites, audit (История)
 */

import { test, expect, USERS, mockAuthAs } from './fixtures'

const API = 'http://localhost:3001/api'

/** Override GET /users/:id to return HR-visible permissions for a senior */
async function mockHrViewingSenior(page: import('@playwright/test').Page) {
  await mockAuthAs(page, USERS.hr)
  await page.route(new RegExp(`${API}/users/([^/?]+)$`), (r) => {
    if (r.request().method() !== 'GET') return r.fulfill({ status: 204, body: '' })
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
        permissions: {
          tabs: ['overview', 'projects', 'team'],
          actions: [],
          fields: {},
        },
        data: {},
      }),
    })
  })
}

test.describe('RBAC — HR viewing SENIOR profile', () => {
  test('profile header shows senior name', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/crm/users/${USERS.senior.id}`)
    await expect(page.getByText('Senior Dev')).toBeVisible()
  })

  test('Обзор tab is visible', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/crm/users/${USERS.senior.id}`)
    await expect(page.getByText('Senior Dev')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Обзор' })).toBeVisible()
  })

  test('Проекты tab is visible', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/crm/users/${USERS.senior.id}`)
    await expect(page.getByText('Senior Dev')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Проекты' })).toBeVisible()
  })

  test('Команда tab is visible', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/crm/users/${USERS.senior.id}`)
    await expect(page.getByText('Senior Dev')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Команда' })).toBeVisible()
  })

  test('Финансы tab is NOT visible', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/crm/users/${USERS.senior.id}`)
    await expect(page.getByText('Senior Dev')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Финансы' })).toHaveCount(0)
  })

  test('Реквизиты tab is NOT visible', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/crm/users/${USERS.senior.id}`)
    await expect(page.getByText('Senior Dev')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Реквизиты' })).toHaveCount(0)
  })

  test('История tab is NOT visible', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/crm/users/${USERS.senior.id}`)
    await expect(page.getByText('Senior Dev')).toBeVisible()
    await expect(page.getByRole('tab', { name: 'История' })).toHaveCount(0)
  })

  test('no "Действия" button rendered', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/crm/users/${USERS.senior.id}`)
    await expect(page.getByText('Senior Dev')).toBeVisible()
    await expect(page.getByRole('button', { name: /Действия/ })).toHaveCount(0)
  })

  test('exactly 3 tabs total', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/crm/users/${USERS.senior.id}`)
    await expect(page.getByText('Senior Dev')).toBeVisible()
    // TabsList contains exactly 3 TabsTrigger elements
    await expect(page.getByRole('tab')).toHaveCount(3)
  })
})
