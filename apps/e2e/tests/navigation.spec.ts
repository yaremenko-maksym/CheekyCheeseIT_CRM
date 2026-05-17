/**
 * navigation.spec.ts
 *
 * Tests SPA navigation via the sidebar for every role.
 * Each test clicks a sidebar link and verifies the correct page renders
 * WITHOUT a full page reload, logout, or redirect to landing/login.
 *
 * This is the guard against the bug where navigating to /crm/interviews
 * via the sidebar triggered a logout + redirect to the landing page.
 */

import { test, expect } from './fixtures'

// ---------------------------------------------------------------------------
// Routes visible to ALL roles (except JUNIOR for interviews)
// ---------------------------------------------------------------------------

const COMMON_ROUTES: { label: string; href: string; heading: RegExp }[] = [
  { label: 'Дашборд',      href: '/crm/dashboard',   heading: /дашборд/i },
  { label: 'Профиль',      href: '/crm/profile',      heading: /профил/i },
  { label: 'Команда',      href: '/crm/team',         heading: /команд/i },
  { label: 'Проекты',      href: '/crm/projects',     heading: /проект/i },
  // Finance heading renders after API load — match the sidebar text instead
  { label: 'Финансы',      href: '/crm/finance',      heading: /финанс/i },
  { label: 'Документы',    href: '/crm/documents',    heading: /документ/i },
  { label: 'База знаний',  href: '/crm/knowledge',    heading: /база знаний/i },
]

// ---------------------------------------------------------------------------
// Helper: assert we are NOT on login / landing after navigation
// ---------------------------------------------------------------------------
async function assertStayedInCrm(page: import('@playwright/test').Page, route: string) {
  const url = page.url()
  expect(url, `Navigating to ${route} should not redirect to landing`).not.toMatch(/^http:\/\/localhost:3000\/?$/)
  expect(url, `Navigating to ${route} should not redirect to login`).not.toMatch(/\/crm\/login/)
  expect(url, `URL should contain the target path`).toContain(route.replace('/crm/', ''))
}

// ---------------------------------------------------------------------------
// ADMIN sidebar navigation
// ---------------------------------------------------------------------------

test.describe('ADMIN sidebar navigation', () => {
  for (const route of COMMON_ROUTES) {
    test(`sidebar → ${route.label} stays in CRM`, async ({ asAdmin: page }) => {
      // Start from dashboard so we test SPA navigation, not direct URL load
      await page.goto('/crm/dashboard')
      await page.waitForLoadState('networkidle')

      await page.click(`a[href="${route.href}"]`)
      await page.waitForURL(`**${route.href}**`, { timeout: 8_000 })
      await page.waitForLoadState('networkidle')

      await assertStayedInCrm(page, route.href)
      await expect(page.locator('h1').filter({ hasText: route.heading }).first()).toBeVisible({ timeout: 10_000 })
    })
  }

  test('sidebar → Собеседования stays in CRM', async ({ asAdmin: page }) => {
    await page.goto('/crm/dashboard')
    await page.waitForLoadState('networkidle')

    await page.click('a[href="/crm/interviews"]')
    await page.waitForURL('**/crm/interviews**', { timeout: 8_000 })
    await page.waitForLoadState('networkidle')

    await assertStayedInCrm(page, '/crm/interviews')
    await expect(page.getByRole('heading', { name: /собеседован/i })).toBeVisible()
  })

  // ADMIN round-trip: skip interviews since sidebar link requires auth context to load
  test('full round-trip through all sidebar links without logout', async ({ asAdmin: page }) => {
    const allRoutes = [
      '/crm/dashboard',
      '/crm/team',
      '/crm/projects',
      '/crm/finance',
      '/crm/profile',
      '/crm/documents',
      '/crm/knowledge',
      '/crm/interviews',
    ]

    await page.goto('/crm/dashboard')
    await page.waitForLoadState('networkidle')

    for (const href of allRoutes) {
      // Interviews link is only in sidebar for ADMIN/SENIOR/HR — wait for it
      await page.waitForSelector(`a[href="${href}"]`, { timeout: 10_000 })
      await page.click(`a[href="${href}"]`)
      await page.waitForURL(`**${href}**`, { timeout: 10_000 })
      // Wait for SPA to settle before checking next link exists
      await page.waitForLoadState('domcontentloaded')

      const url = page.url()
      expect(url, `${href}: should not redirect to landing`).not.toMatch(/^http:\/\/localhost:3000\/?$/)
      expect(url, `${href}: should not redirect to login`).not.toMatch(/\/crm\/login/)
    }
  })
})

// ---------------------------------------------------------------------------
// SENIOR sidebar navigation
// ---------------------------------------------------------------------------

test.describe('SENIOR sidebar navigation', () => {
  const seniorRoutes = COMMON_ROUTES.concat([
    { label: 'Собеседования', href: '/crm/interviews', heading: /собеседован/i },
  ])

  for (const route of seniorRoutes) {
    test(`sidebar → ${route.label} stays in CRM`, async ({ asSenior: page }) => {
      await page.goto('/crm/dashboard')
      await page.waitForLoadState('networkidle')

      await page.click(`a[href="${route.href}"]`)
      await page.waitForURL(`**${route.href}**`, { timeout: 8_000 })
      await page.waitForLoadState('networkidle')

      await assertStayedInCrm(page, route.href)
      await expect(page.locator('h1').filter({ hasText: route.heading }).first()).toBeVisible({ timeout: 10_000 })
    })
  }
})

// ---------------------------------------------------------------------------
// HR sidebar navigation
// ---------------------------------------------------------------------------

test.describe('HR sidebar navigation', () => {
  const hrRoutes = COMMON_ROUTES.concat([
    { label: 'Собеседования', href: '/crm/interviews', heading: /собеседован/i },
  ])

  for (const route of hrRoutes) {
    test(`sidebar → ${route.label} stays in CRM`, async ({ asHr: page }) => {
      await page.goto('/crm/dashboard')
      await page.waitForLoadState('networkidle')

      await page.click(`a[href="${route.href}"]`)
      await page.waitForURL(`**${route.href}**`, { timeout: 8_000 })
      await page.waitForLoadState('networkidle')

      await assertStayedInCrm(page, route.href)
      await expect(page.locator('h1').filter({ hasText: route.heading }).first()).toBeVisible({ timeout: 10_000 })
    })
  }
})

// ---------------------------------------------------------------------------
// JUNIOR sidebar navigation (no Interviews link)
// ---------------------------------------------------------------------------

test.describe('JUNIOR sidebar navigation', () => {
  for (const route of COMMON_ROUTES) {
    test(`sidebar → ${route.label} stays in CRM`, async ({ asJunior: page }) => {
      await page.goto('/crm/dashboard')
      await page.waitForLoadState('networkidle')

      await page.click(`a[href="${route.href}"]`)
      
      // Handle team redirect for JUNIOR users
      if (route.href === '/crm/team') {
        // JUNIOR gets redirected to /crm/team/:id, so wait for that
        await page.waitForURL('**/crm/team/**', { timeout: 8_000 })
        await page.waitForLoadState('networkidle')
        await assertStayedInCrm(page, route.href)
        // Heading will be the team name, just ensure we're still in team area and not logged out
        await expect(page.getByRole('heading')).toBeVisible({ timeout: 10_000 })
      } else {
        await page.waitForURL(`**${route.href}**`, { timeout: 8_000 })
        await page.waitForLoadState('networkidle')
        await assertStayedInCrm(page, route.href)
        await expect(page.locator('h1').filter({ hasText: route.heading }).first()).toBeVisible({ timeout: 10_000 })
      }
    })
  }

  test('JUNIOR does not see Собеседования in sidebar', async ({ asJunior: page }) => {
    await page.goto('/crm/dashboard')
    await expect(page.locator('a[href="/crm/interviews"]')).not.toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Regression: /crm/interviews does NOT cause logout or landing redirect
// (This is the specific bug that was reported)
// ---------------------------------------------------------------------------

test.describe('Regression: interviews navigation bug', () => {
  test('ADMIN: direct URL /crm/interviews loads correctly', async ({ asAdmin: page }) => {
    await page.goto('/crm/interviews')
    await expect(page).toHaveURL(/\/crm\/interviews/)
    await expect(page.getByRole('heading', { name: /собеседован/i })).toBeVisible()
  })

  test('SENIOR: direct URL /crm/interviews loads correctly', async ({ asSenior: page }) => {
    await page.goto('/crm/interviews')
    await expect(page).toHaveURL(/\/crm\/interviews/)
    await expect(page.getByRole('heading', { name: /собеседован/i })).toBeVisible()
  })

  test('HR: direct URL /crm/interviews loads correctly', async ({ asHr: page }) => {
    await page.goto('/crm/interviews')
    await expect(page).toHaveURL(/\/crm\/interviews/)
    await expect(page.getByRole('heading', { name: /собеседован/i })).toBeVisible()
  })

  test('ADMIN: /crm/interviews with ?seniorId param loads correctly', async ({ asAdmin: page }) => {
    await page.goto('/crm/interviews?seniorId=a0000000-0000-4000-8000-000000000002')
    await expect(page).toHaveURL(/\/crm\/interviews/)
    await expect(page.getByRole('heading', { name: /собеседован/i })).toBeVisible()
  })

  test('no console errors on interviews page load', async ({ asAdmin: page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      // Ignore favicon 404 — not an app error
      if (msg.text().includes('favicon')) return
      errors.push(msg.text())
    })

    await page.goto('/crm/dashboard')
    await page.click('a[href="/crm/interviews"]')
    await page.waitForURL('**/crm/interviews**', { timeout: 8_000 })
    await page.waitForLoadState('networkidle')

    expect(errors, `Console errors on interviews page: ${errors.join('\n')}`).toHaveLength(0)
  })

  test('navigating interviews → finance → interviews does not crash', async ({ asAdmin: page }) => {
    await page.goto('/crm/interviews')
    await page.waitForLoadState('domcontentloaded')

    await page.waitForSelector('a[href="/crm/finance"]', { timeout: 10_000 })
    await page.click('a[href="/crm/finance"]')
    await page.waitForURL('**/crm/finance**', { timeout: 10_000 })
    await page.waitForLoadState('domcontentloaded')

    await page.waitForSelector('a[href="/crm/interviews"]', { timeout: 10_000 })
    await page.click('a[href="/crm/interviews"]')
    await page.waitForURL('**/crm/interviews**', { timeout: 10_000 })

    await expect(page).toHaveURL(/\/crm\/interviews/)
    await expect(page.locator('h1').filter({ hasText: /собеседован/i })).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Unauthenticated: all CRM routes redirect to /crm/login (not landing)
// ---------------------------------------------------------------------------

test.describe('Unauthenticated redirect', () => {
  const ALL_CRM_ROUTES = [
    '/crm/dashboard',
    '/crm/team',
    '/crm/projects',
    '/crm/finance',
    '/crm/interviews',
    '/crm/profile',
    '/crm/documents',
    '/crm/knowledge',
  ]

  for (const route of ALL_CRM_ROUTES) {
    test(`${route} → /crm/login when not authenticated`, async ({ page }) => {
      await page.route('http://localhost:3001/api/auth/me', (r) =>
        r.fulfill({ status: 401, body: '{"message":"Unauthorized"}' }),
      )
      await page.goto(route)
      await expect(page).toHaveURL(/\/crm\/login/, { timeout: 8_000 })
    })
  }
})
