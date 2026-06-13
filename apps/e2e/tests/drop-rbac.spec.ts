/**
 * drop-rbac.spec.ts — Drop role RBAC visibility sweep.
 *
 * Phase 1 (AC8): sidebar items, /crm/dashboard redirect, /crm/users redirect,
 *   profile self-view tabs.
 *
 * Phase 2 update (PR #189): resolveRoleHome(DROP) changed to /crm/routing.
 *   All redirect expectations updated from /crm/profile to /crm/routing.
 *   Sidebar now has 4 items: Мой роутинг / Финансы / Команда / Профиль
 *   (data-testid="drop-nav" from nav-sidebar.tsx).
 *
 * Mock-based — `asDrop` fixture authenticates as `USERS.drop` and pumps
 * the standard `/api/users/me` mock that returns the self-view from
 * `buildSelfView(USERS.drop)`.
 */

import { test, expect } from './fixtures'

test.describe('Drop RBAC visibility — AC8 (phase 2 update)', () => {
  test('sidebar has exactly 4 items for DROP: Мой роутинг / Финансы / Команда / Профиль', async ({
    asDrop: page,
  }) => {
    // Navigate to DROP home first (routing hub).
    await page.goto('/crm/routing')
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })

    // Scope to the drop-nav testid (data-testid="drop-nav" in nav-sidebar.tsx).
    const nav = page.getByTestId('drop-nav')
    await expect(nav).toBeVisible()

    // Phase 2: 4 allowed entries.
    await expect(nav.locator('a[href="/crm/routing"]')).toBeVisible()
    await expect(nav.locator('a[href="/crm/finance"]')).toBeVisible()
    await expect(nav.locator('a[href="/crm/team"]')).toBeVisible()
    await expect(nav.locator('a[href="/crm/profile"]')).toBeVisible()

    // Exactly 4 nav links.
    await expect(nav.locator('a')).toHaveCount(4)

    // Forbidden entries — absent for DROP.
    await expect(nav.locator('a[href="/crm/projects"]')).toHaveCount(0)
    await expect(nav.locator('a[href="/crm/interviews"]')).toHaveCount(0)
    await expect(nav.locator('a[href="/crm/documents"]')).toHaveCount(0)
    await expect(nav.locator('a[href="/crm/dashboard"]')).toHaveCount(0)
    await expect(nav.locator('a[href="/crm/users"]')).toHaveCount(0)
    await expect(nav.locator('a[href="/crm/stats"]')).toHaveCount(0)
  })

  test('direct hit on /crm/dashboard redirects DROP to /crm/routing (phase 2)', async ({
    asDrop: page,
  }) => {
    await page.goto('/crm/dashboard')
    // DashboardPage useEffect: navigates DROP to resolveRoleHome('DROP') = /crm/routing.
    await expect(page).toHaveURL(/\/crm\/routing/, { timeout: 8_000 })
  })

  test('/crm/users denies DROP access — redirects to /crm/routing', async ({ asDrop: page }) => {
    // useRoleGuard fires navigate to resolveRoleHome('DROP') = /crm/routing.
    await page.goto('/crm/users')
    await expect(page).toHaveURL(/\/crm\/routing/, { timeout: 8_000 })
  })

  test('DROP self-profile renders with correct tabs (overview/projects/team/requisites/documents/finance)', async ({
    asDrop: page,
  }) => {
    await page.goto('/crm/profile')

    // Header h1 = displayName ('Drop User').
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Drop User', {
      timeout: 8_000,
    })

    // Allowed tabs per buildSelfView(USERS.drop) — mirrors backend isSelf branch:
    // overview / projects / team / requisites / documents / finance.
    // AnimatedTabs renders each entry as a plain <button> (not role=tab).
    // Scope to <main> to avoid matching the sidebar «Финансы» / «Документы» links.
    const main = page.locator('main')
    await expect(main.getByRole('button', { name: /Финансы/ }).first()).toBeVisible({
      timeout: 8_000,
    })

    // Forbidden tab — Собеседования must not surface inside main.
    await expect(main.getByRole('button', { name: /^Собеседования$/ })).toHaveCount(0)
  })

  test('DROP can open /crm/finance and stays on the finance page', async ({ asDrop: page }) => {
    // Spec §4: DROP sees Finance. `useRoleGuard` on /crm/finance now
    // includes DROP, so the page renders the standard finance shell with
    // the «Финансы» header and the transactions table (may be empty).
    await page.goto('/crm/finance')
    await expect(page).toHaveURL(/\/crm\/finance/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page).not.toHaveURL(/\/crm\/profile/)
    const main = page.locator('main')
    await expect(main.getByRole('heading', { level: 1, name: 'Финансы' })).toBeVisible({
      timeout: 8_000,
    })
  })

  test('DROP can open /crm/team and stays on the team page', async ({ asDrop: page }) => {
    // Spec §4: DROP sees Team. `useRoleGuard` on /crm/team now includes
    // DROP so the list renders (the backend filters teams to the DROP's
    // own one — the mock returns the senior fixture which is plenty for
    // the route-guard sanity check).
    await page.goto('/crm/team')
    await expect(page).toHaveURL(/\/crm\/team/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page).not.toHaveURL(/\/crm\/profile/)
    const main = page.locator('main')
    await expect(main.getByRole('heading', { level: 1, name: 'Команда' })).toBeVisible({
      timeout: 8_000,
    })
  })
})
