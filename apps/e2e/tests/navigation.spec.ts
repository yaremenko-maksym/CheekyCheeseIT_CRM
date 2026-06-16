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

// Generic page h1 headings were removed (§1 detitle refactor).
// Navigation is now verified by URL + page-specific testid anchors where available.
// Routes without a unique testid rely on URL assertion in assertStayedInCrm.
const COMMON_ROUTES: { label: string; href: string; testid?: string }[] = [
  // Dashboard — role-specific component, verified by URL.
  { label: 'Дашборд', href: '/crm' },
  // Profile — h1 is user display name (identity, not nav-dup); verified by URL.
  { label: 'Профиль', href: '/crm/profile' },
  // Team list — h1 removed; verify by URL (SENIOR redirects to detail with team h1).
  { label: 'Команда', href: '/crm/team' },
  // Projects — h1 removed; verify by URL.
  { label: 'Проекты', href: '/crm/projects' },
  // Finance — h1 removed; data-testid="finance-page" added.
  { label: 'Финансы', href: '/crm/finance', testid: 'finance-page' },
  // Documents — h1 removed; data-testid="documents-page" added.
  { label: 'Документы', href: '/crm/documents', testid: 'documents-page' },
]

// ---------------------------------------------------------------------------
// Helper: assert we are NOT on login / landing after navigation
// ---------------------------------------------------------------------------
async function assertStayedInCrm(page: import('@playwright/test').Page, route: string) {
  const url = page.url()
  expect(url, `Navigating to ${route} should not redirect to landing`).not.toMatch(
    /^http:\/\/localhost:3000\/?$/,
  )
  expect(url, `Navigating to ${route} should not redirect to login`).not.toMatch(/\/crm\/login/)
  expect(url, `URL should contain the target path`).toContain(route.replace('/crm/', ''))
}

/**
 * Click a sidebar nav link by href, scoped to the desktop `<aside>` sidebar so it
 * never collides with the header logo link (which is also `<a href="/crm">` after
 * the dashboard→/crm consolidation). Strict-mode safe.
 */
function clickSidebarLink(page: import('@playwright/test').Page, href: string) {
  return page.locator(`aside a[href="${href}"]`).first().click()
}

// ---------------------------------------------------------------------------
// ADMIN sidebar navigation
// ---------------------------------------------------------------------------

test.describe('ADMIN sidebar navigation', () => {
  for (const route of COMMON_ROUTES) {
    test(`sidebar → ${route.label} stays in CRM`, async ({ asAdmin: page }) => {
      // Start from dashboard so we test SPA navigation, not direct URL load
      await page.goto('/crm')
      await page.waitForLoadState('networkidle')

      await clickSidebarLink(page, route.href)
      await page.waitForURL(`**${route.href}**`, { timeout: 8_000 })
      await page.waitForLoadState('networkidle')

      await assertStayedInCrm(page, route.href)
      // Generic h1 headings removed (§1 detitle); use testid where available, else URL is enough.
      if (route.testid) {
        await expect(page.getByTestId(route.testid).first()).toBeVisible({ timeout: 10_000 })
      }
    })
  }

  test('sidebar → Собеседования stays in CRM', async ({ asAdmin: page }) => {
    await page.goto('/crm')
    await page.waitForLoadState('networkidle')

    await clickSidebarLink(page, '/crm/interviews')
    await page.waitForURL('**/crm/interviews**', { timeout: 8_000 })
    await page.waitForLoadState('networkidle')

    await assertStayedInCrm(page, '/crm/interviews')
    await expect(page.getByTestId('interviews-page')).toBeVisible({ timeout: 10_000 })
  })

  // ADMIN round-trip: skip interviews since sidebar link requires auth context to load
  test('full round-trip through all sidebar links without logout', async ({ asAdmin: page }) => {
    const allRoutes = [
      '/crm',
      '/crm/team',
      '/crm/projects',
      '/crm/finance',
      '/crm/profile',
      '/crm/documents',
      '/crm/interviews',
    ]

    await page.goto('/crm')
    await page.waitForLoadState('networkidle')

    for (const href of allRoutes) {
      // Interviews link is only in sidebar for ADMIN/SENIOR/HR — wait for it
      await page.locator(`aside a[href="${href}"]`).first().waitFor({ timeout: 10_000 })
      await clickSidebarLink(page, href)
      await page.waitForURL(`**${href}**`, { timeout: 10_000 })
      // Wait for SPA to settle before checking next link exists
      await page.waitForLoadState('domcontentloaded')

      const url = page.url()
      expect(url, `${href}: should not redirect to landing`).not.toMatch(
        /^http:\/\/localhost:3000\/?$/,
      )
      expect(url, `${href}: should not redirect to login`).not.toMatch(/\/crm\/login/)
    }
  })
})

// ---------------------------------------------------------------------------
// SENIOR sidebar navigation
// ---------------------------------------------------------------------------

test.describe('SENIOR sidebar navigation', () => {
  const seniorRoutes = COMMON_ROUTES.concat([
    { label: 'Собеседования', href: '/crm/interviews', testid: 'interviews-page' },
  ])

  for (const route of seniorRoutes) {
    test(`sidebar → ${route.label} stays in CRM`, async ({ asSenior: page }) => {
      await page.goto('/crm')
      // Deterministic readiness instead of `networkidle`: the SENIOR `/crm`
      // дашборд (#234) keeps a self-scoped finance query in flight (retry: 2),
      // so the network never goes fully idle within the test budget — wait for
      // the sidebar to render instead (playwright-patterns: avoid networkidle).
      await page.locator(`aside a[href="${route.href}"]`).first().waitFor({ timeout: 10_000 })

      await clickSidebarLink(page, route.href)

      // Handle team redirect for SENIOR (single team → detail page).
      // team h1 = {team.name} (identity, NOT nav-dup) — still a valid anchor.
      if (route.href === '/crm/team') {
        await page.waitForURL('**/crm/team/**', { timeout: 8_000 })
        await assertStayedInCrm(page, route.href)
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 })
      } else {
        await page.waitForURL(`**${route.href}**`, { timeout: 8_000 })
        await assertStayedInCrm(page, route.href)
        // Generic h1 headings removed (§1 detitle); use testid where available.
        if (route.testid) {
          await expect(page.getByTestId(route.testid).first()).toBeVisible({ timeout: 10_000 })
        }
      }
    })
  }
})

// ---------------------------------------------------------------------------
// HR sidebar navigation
// ---------------------------------------------------------------------------

test.describe('HR sidebar navigation', () => {
  const hrRoutes = COMMON_ROUTES.concat([
    { label: 'Собеседования', href: '/crm/interviews', testid: 'interviews-page' },
  ])

  for (const route of hrRoutes) {
    test(`sidebar → ${route.label} stays in CRM`, async ({ asHr: page }) => {
      await page.goto('/crm')
      await page.waitForLoadState('networkidle')

      await clickSidebarLink(page, route.href)
      await page.waitForURL(`**${route.href}**`, { timeout: 8_000 })
      await page.waitForLoadState('networkidle')

      await assertStayedInCrm(page, route.href)
      // Generic h1 headings removed (§1 detitle); use testid where available.
      if (route.testid) {
        await expect(page.getByTestId(route.testid).first()).toBeVisible({ timeout: 10_000 })
      }
    })
  }
})

// ---------------------------------------------------------------------------
// JUNIOR sidebar navigation (phase 2 UX: exactly 5 items)
// Дашборд / Команда / Проекты / Собеседования are HIDDEN for JUNIOR.
// Visible: Мой проект · Легенда · Финансы · Документы · Профиль.
// ---------------------------------------------------------------------------

// Routes that JUNIOR actually sees in the sidebar (junior-nav testid).
// Generic h1 headings removed (§1 detitle); anchors: junior-hub, finance-page, documents-page.
const JUNIOR_ROUTES: { label: string; href: string; testid?: string }[] = [
  { label: 'Мой проект', href: '/crm/project', testid: 'junior-hub' },
  { label: 'Профиль', href: '/crm/profile' },
  { label: 'Финансы', href: '/crm/finance', testid: 'finance-page' },
  { label: 'Документы', href: '/crm/documents', testid: 'documents-page' },
]

test.describe('JUNIOR sidebar navigation', () => {
  for (const route of JUNIOR_ROUTES) {
    test(`sidebar → ${route.label} stays in CRM`, async ({ asJunior: page }) => {
      await page.goto('/crm/project')
      await page.waitForLoadState('networkidle')

      await clickSidebarLink(page, route.href)
      await page.waitForURL(`**${route.href}**`, { timeout: 8_000 })
      await page.waitForLoadState('networkidle')

      await assertStayedInCrm(page, route.href)
      if (route.testid) {
        await expect(page.getByTestId(route.testid).first()).toBeVisible({ timeout: 10_000 })
      }
    })
  }

  test('JUNIOR does not see Команда, Проекты, Дашборд, Собеседования in sidebar', async ({
    asJunior: page,
  }) => {
    await page.goto('/crm/project')
    const nav = page.getByTestId('junior-nav')
    await expect(nav).toBeVisible()
    await expect(nav.getByText('Команда')).not.toBeVisible()
    await expect(nav.getByText('Проекты')).not.toBeVisible()
    await expect(nav.getByText('Дашборд')).not.toBeVisible()
    await expect(nav.getByText('Собеседования')).not.toBeVisible()
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
    await expect(page.getByTestId('interviews-page')).toBeVisible({ timeout: 10_000 })
  })

  test('SENIOR: direct URL /crm/interviews loads correctly', async ({ asSenior: page }) => {
    await page.goto('/crm/interviews')
    await expect(page).toHaveURL(/\/crm\/interviews/)
    await expect(page.getByTestId('interviews-page')).toBeVisible({ timeout: 10_000 })
  })

  test('HR: direct URL /crm/interviews loads correctly', async ({ asHr: page }) => {
    await page.goto('/crm/interviews')
    await expect(page).toHaveURL(/\/crm\/interviews/)
    await expect(page.getByTestId('interviews-page')).toBeVisible({ timeout: 10_000 })
  })

  test('ADMIN: /crm/interviews with ?seniorId param loads correctly', async ({ asAdmin: page }) => {
    await page.goto('/crm/interviews?seniorId=a0000000-0000-4000-8000-000000000002')
    await expect(page).toHaveURL(/\/crm\/interviews/)
    await expect(page.getByTestId('interviews-page')).toBeVisible({ timeout: 10_000 })
  })

  test('no console errors on interviews page load', async ({ asAdmin: page }) => {
    const errors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      // Ignore favicon 404 — not an app error
      if (msg.text().includes('favicon')) return
      errors.push(msg.text())
    })

    await page.goto('/crm')
    await clickSidebarLink(page, '/crm/interviews')
    await page.waitForURL('**/crm/interviews**', { timeout: 8_000 })
    await page.waitForLoadState('networkidle')

    expect(errors, `Console errors on interviews page: ${errors.join('\n')}`).toHaveLength(0)
  })

  test('navigating interviews → finance → interviews does not crash', async ({ asAdmin: page }) => {
    await page.goto('/crm/interviews')
    await page.waitForLoadState('domcontentloaded')

    await page.waitForSelector('a[href="/crm/finance"]', { timeout: 10_000 })
    await clickSidebarLink(page, '/crm/finance')
    await page.waitForURL('**/crm/finance**', { timeout: 10_000 })
    await page.waitForLoadState('domcontentloaded')

    await page.waitForSelector('a[href="/crm/interviews"]', { timeout: 10_000 })
    await clickSidebarLink(page, '/crm/interviews')
    await page.waitForURL('**/crm/interviews**', { timeout: 10_000 })

    await expect(page).toHaveURL(/\/crm\/interviews/)
    await expect(page.getByTestId('interviews-page')).toBeVisible({ timeout: 10_000 })
  })
})

// ---------------------------------------------------------------------------
// Unauthenticated: all CRM routes redirect to /crm/login (not landing)
// ---------------------------------------------------------------------------

test.describe('Unauthenticated redirect', () => {
  const ALL_CRM_ROUTES = [
    '/crm',
    '/crm/team',
    '/crm/projects',
    '/crm/finance',
    '/crm/interviews',
    '/crm/profile',
    '/crm/documents',
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
