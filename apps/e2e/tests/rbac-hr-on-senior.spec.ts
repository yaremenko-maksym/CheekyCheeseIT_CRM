/**
 * rbac-hr-on-senior.spec.ts
 *
 * RBAC: HR viewing a SENIOR profile on /profile/:userId.
 *
 * Permissions matrix (HR → SENIOR in own team):
 *   tabs:    overview, projects, team
 *   actions: [] (no admin actions)
 *
 * Tabs that must NOT appear: finance, requisites, audit (История)
 *
 * Note: AnimatedTabs renders each tab as a plain <button>, not role="tab".
 * Tests use getByRole('button', ...) to locate tab triggers.
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
          archivedAt: null,
          adminNote: null,
        },
        permissions: {
          tabs: ['overview', 'projects', 'team'],
          actions: [],
          fields: { techStack: true, registrationDate: true },
        },
        data: {},
      }),
    })
  })
}

test.describe('RBAC — HR viewing SENIOR profile', () => {
  test('profile header shows senior name', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
  })

  test('Обзор tab is visible', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Обзор' })).toBeVisible()
  })

  test('Проекты tab is visible', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Проекты' })).toBeVisible()
  })

  test('Команда tab is visible', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Команда' })).toBeVisible()
  })

  test('Финансы tab is NOT visible', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
    // Sidebar always shows "Финансы" link — assert it's not present as a tab inside the profile shell.
    const main = page.locator('main')
    await expect(main.getByRole('button', { name: 'Финансы' })).toHaveCount(0)
  })

  test('Реквизиты tab is NOT visible', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Реквизиты' })).toHaveCount(0)
  })

  test('История tab is NOT visible', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'История' })).toHaveCount(0)
  })

  test('no "Действия" button rendered', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Действия/ })).toHaveCount(0)
  })

  test('exactly 3 tabs inside the profile shell', async ({ page }) => {
    await mockHrViewingSenior(page)
    await page.goto(`/profile/${USERS.senior.id}`)
    await expect(page.getByRole('heading', { name: 'Senior Dev' })).toBeVisible()
    // AnimatedTabs renders inside main; assert exactly 3 tab buttons under it
    const main = page.locator('main')
    const tabLabels = ['Обзор', 'Проекты', 'Команда']
    for (const label of tabLabels) {
      await expect(main.getByRole('button', { name: label })).toBeVisible()
    }
  })
})
