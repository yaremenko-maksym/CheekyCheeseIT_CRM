/**
 * drop-route-guards.spec.ts — DROP role frontend route-guard sweep.
 *
 * History:
 *   PR #63 (phase 1): introduced useRoleGuard on forbidden routes; DROP home
 *   was /crm/profile at the time, so all guard-redirects resolved to /crm/profile.
 *
 *   PR #189 (phase 2): resolveRoleHome(DROP) changed from /crm/profile to
 *   /crm/routing. Every guard-redirect that previously resolved to /crm/profile
 *   now resolves to /crm/routing. This spec is the authoritative post-phase-2
 *   sweep — all old /crm/profile expectations updated accordingly.
 *
 * Source of truth: apps/web/app/lib/route-access.ts (feature branch).
 *   resolveRoleHome('DROP') === '/crm/routing'
 *
 * Forbidden routes for DROP (not in ROUTE_ACCESS for DROP):
 *   /crm/dashboard, /crm/projects, /crm/interviews, /crm/documents,
 *   /crm/stats, /crm/users, /crm/legend, /crm/project (JUNIOR-only),
 *   /crm root (no entry → resolves to role home via index redirect).
 *
 * Allowed routes for DROP:
 *   /crm/routing (DROP home), /crm/finance, /crm/team, /crm/profile, /crm/payments
 *
 * Mock-based — uses the `asDrop` fixture from fixtures.ts.
 */

import { test, expect } from './fixtures'

test.describe('Drop frontend route-guards — phase 2 (home = /crm/routing)', () => {
  // ── Forbidden routes: must redirect to DROP home (/crm/routing) ─────────────

  test('/crm root for DROP → /crm/routing', async ({ asDrop: page }) => {
    await page.goto('/crm')
    await expect(page).toHaveURL(/\/crm\/routing/, { timeout: 8_000 })
  })

  test('/crm/dashboard for DROP → /crm/routing', async ({ asDrop: page }) => {
    // DashboardPage useEffect guard: navigates DROP to resolveRoleHome('DROP')
    // which is now /crm/routing (phase 2 change).
    await page.goto('/crm/dashboard')
    await expect(page).toHaveURL(/\/crm\/routing/, { timeout: 8_000 })
  })

  test('/crm/interviews for DROP → /crm/routing', async ({ asDrop: page }) => {
    // useRoleGuard(['ADMIN','SENIOR','HR']) — DROP not in list →
    // redirect to resolveRoleHome('DROP') = /crm/routing.
    await page.goto('/crm/interviews')
    await expect(page).toHaveURL(/\/crm\/routing/, { timeout: 8_000 })
  })

  test('/crm/documents for DROP → /crm/routing', async ({ asDrop: page }) => {
    // ROUTE_ACCESS for /crm/documents: ['ADMIN','SENIOR','JUNIOR','HR','ACCOUNTANT']
    // DROP is excluded → redirect to /crm/routing.
    await page.goto('/crm/documents')
    await expect(page).toHaveURL(/\/crm\/routing/, { timeout: 8_000 })
  })

  test('/crm/stats for DROP → /crm/routing', async ({ asDrop: page }) => {
    // /crm/stats is ADMIN-only → DROP redirected to /crm/routing.
    await page.goto('/crm/stats')
    await expect(page).toHaveURL(/\/crm\/routing/, { timeout: 8_000 })
  })

  test('/crm/users for DROP → /crm/routing', async ({ asDrop: page }) => {
    // useRoleGuard(['ADMIN']) — DROP redirected to /crm/routing.
    await page.goto('/crm/users')
    await expect(page).toHaveURL(/\/crm\/routing/, { timeout: 8_000 })
  })

  test('/crm/projects for DROP → /crm/routing', async ({ asDrop: page }) => {
    // ROUTE_ACCESS for /crm/projects: ['ADMIN','SENIOR','HR','ACCOUNTANT']
    // DROP excluded → redirect to /crm/routing.
    await page.goto('/crm/projects')
    await expect(page).toHaveURL(/\/crm\/routing/, { timeout: 8_000 })
  })

  test('/crm/legend for DROP → /crm/routing', async ({ asDrop: page }) => {
    // /crm/legend is JUNIOR-only → DROP redirected to /crm/routing.
    await page.goto('/crm/legend')
    await expect(page).toHaveURL(/\/crm\/routing/, { timeout: 8_000 })
  })

  test('/crm/project for DROP → /crm/routing', async ({ asDrop: page }) => {
    // /crm/project is JUNIOR-only (JUNIOR hub) → DROP redirected to /crm/routing.
    await page.goto('/crm/project')
    await expect(page).toHaveURL(/\/crm\/routing/, { timeout: 8_000 })
  })

  // ── Allowed routes: must NOT redirect ───────────────────────────────────────

  test('/crm/routing for DROP stays on routing hub (no redirect loop)', async ({
    asDrop: page,
  }) => {
    await page.goto('/crm/routing')
    await expect(page).toHaveURL(/\/crm\/routing/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
    // Hub renders the main testid — confirms full render, not just URL settle.
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })
  })

  test('/crm/profile for DROP stays on profile (no redirect to /crm/routing)', async ({
    asDrop: page,
  }) => {
    // Profile is ALL_ROLES → DROP can access it directly without redirect.
    await page.goto('/crm/profile')
    await expect(page).toHaveURL(/\/crm\/profile/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/crm\/routing/)
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 8_000 })
  })

  test('/crm/team for DROP stays on team page', async ({ asDrop: page }) => {
    await page.goto('/crm/team')
    await expect(page).toHaveURL(/\/crm\/team/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/crm\/routing/)
  })

  test('/crm/finance for DROP stays on finance page', async ({ asDrop: page }) => {
    await page.goto('/crm/finance')
    await expect(page).toHaveURL(/\/crm\/finance/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/crm\/routing/)
  })

  // ── RBAC: non-DROP on /crm/routing → redirected to own home ─────────────────

  test('/crm/routing for ADMIN → redirected (not a DROP)', async ({ asAdmin: page }) => {
    // /crm/routing is DROP-only. ADMIN does NOT have access → guard fires
    // → resolveRoleHome('ADMIN') = /crm/dashboard.
    await page.goto('/crm/routing')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
  })

  test('/crm/routing for SENIOR → redirected to /crm/dashboard', async ({ asSenior: page }) => {
    await page.goto('/crm/routing')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
  })

  test('/crm/routing for HR → redirected to /crm/dashboard', async ({ asHr: page }) => {
    await page.goto('/crm/routing')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
  })

  test('/crm/routing for JUNIOR → redirected to /crm/project', async ({ asJunior: page }) => {
    // JUNIOR home = /crm/project
    await page.goto('/crm/routing')
    await expect(page).toHaveURL(/\/crm\/project/, { timeout: 8_000 })
  })
})
