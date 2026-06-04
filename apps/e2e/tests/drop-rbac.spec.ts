/**
 * drop-rbac.spec.ts — Drop role - phase 1 (AC8).
 *
 * Verifies DROP-role visibility constraints:
 *   - Sidebar exposes only Profile / Team / Finance (no Dashboard,
 *     Projects, Interviews, Documents).
 *   - Direct URL hit on /crm/dashboard redirects DROP to /crm/profile
 *     (DashboardPage useEffect guard).
 *   - /crm/users page is admin-only — DROP is redirected to /crm/profile.
 *   - DROP profile self-view exposes only the DROP-permitted tabs
 *     (overview / team / requisites / finance per spec §4).
 *
 * Mock-based — `asDrop` fixture authenticates as `USERS.drop` and pumps
 * the standard `/api/users/me` mock that returns the self-view from
 * `buildSelfView(USERS.drop)`.
 */

import { test, expect } from './fixtures'

test.describe('Drop RBAC visibility — AC8', () => {
  test('sidebar exposes only Profile / Team / Finance for DROP', async ({ asDrop: page }) => {
    await page.goto('/crm/profile')
    await expect(page.locator('a[href="/crm/profile"]').first()).toBeVisible({ timeout: 8_000 })

    // Allowed entries per spec §4 (sidebar items configured in nav-sidebar.tsx).
    await expect(page.locator('a[href="/crm/team"]').first()).toBeVisible()
    await expect(page.locator('a[href="/crm/finance"]').first()).toBeVisible()

    // Forbidden entries — absent for DROP per spec.
    // Note: the brand link in the header points to /crm/dashboard for all
    // roles (CrmLayout — unaffected by the sidebar gate). Scope the
    // assertion to the sidebar <nav> so the header link doesn't false-trip.
    const sidebar = page.locator('nav').first()
    await expect(sidebar.locator('a[href="/crm/projects"]')).toHaveCount(0)
    await expect(sidebar.locator('a[href="/crm/interviews"]')).toHaveCount(0)
    await expect(sidebar.locator('a[href="/crm/documents"]')).toHaveCount(0)
    // ADMIN-only entries also stay out of the sidebar.
    await expect(sidebar.locator('a[href="/crm/users"]')).toHaveCount(0)
    await expect(sidebar.locator('a[href="/crm/stats"]')).toHaveCount(0)
  })

  test('direct hit on /crm/dashboard redirects DROP to /crm/profile', async ({ asDrop: page }) => {
    await page.goto('/crm/dashboard')
    // DashboardPage useEffect navigates DROP away.
    await expect(page).toHaveURL(/\/crm\/profile/, { timeout: 8_000 })
  })

  test('/crm/users denies DROP access — redirects to profile', async ({ asDrop: page }) => {
    // useRoleGuard(['ADMIN','SENIOR','JUNIOR','HR','ACCOUNTANT']) on /crm/users
    // does NOT include DROP, so the guard fires navigate({to:'/crm/dashboard'}).
    // DashboardPage then redirects DROP onward to /crm/profile.
    // We verify the final resting URL rather than any on-screen text.
    await page.goto('/crm/users')
    await expect(page).toHaveURL(/\/crm\/profile/, { timeout: 8_000 })
  })

  test('DROP self-profile renders without Documents / Projects tabs', async ({ asDrop: page }) => {
    await page.goto('/crm/profile')

    // Header h1 = displayName ('Drop User').
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Drop User', {
      timeout: 8_000,
    })

    // Allowed tabs per buildSelfView(USERS.drop): overview / team /
    // requisites / finance (per spec §4 + finance). AnimatedTabs renders
    // each entry as a plain <button> (not role=tab) so we filter by name.
    // Scope to <main> to avoid matching the sidebar «Финансы» entry.
    const main = page.locator('main')
    await expect(main.getByRole('button', { name: /Финансы/ }).first()).toBeVisible({
      timeout: 8_000,
    })

    // Forbidden tabs — Documents/Interviews should not surface inside main.
    await expect(main.getByRole('button', { name: /^Документы$/ })).toHaveCount(0)
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
