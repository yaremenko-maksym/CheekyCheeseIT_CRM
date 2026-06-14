/**
 * drop-route-guards.spec.ts — DROP role frontend route-guard sweep.
 *
 * History:
 *   PR #63 (phase 1): introduced useRoleGuard on forbidden routes; DROP home
 *   was /crm/profile at the time, so all guard-redirects resolved to /crm/profile.
 *
 *   PR #189 (phase 2): resolveRoleHome(DROP) changed from /crm/profile to
 *   /crm/routing. Every guard-redirect that previously resolved to /crm/profile
 *   now resolves to /crm/routing.
 *
 *   PR #198 (phase 3): resolveRoleHome(DROP) changed from /crm/routing to
 *   /crm/dashboard. DROP is now included in ROUTE_ACCESS for /crm/dashboard.
 *   /crm/routing permanently redirects to /crm/dashboard (beforeLoad throw redirect).
 *   This spec is the authoritative post-phase-3 sweep — all /crm/routing DROP
 *   home expectations updated to /crm/dashboard.
 *
 * Source of truth: apps/web/app/lib/route-access.ts (feature branch).
 *   resolveRoleHome('DROP') === '/crm/dashboard'
 *
 * Forbidden routes for DROP (not in ROUTE_ACCESS for DROP):
 *   /crm/projects, /crm/interviews,
 *   /crm/stats, /crm/users, /crm/legend, /crm/project (JUNIOR-only),
 *   /crm root (no entry → resolves to role home via index redirect).
 *
 * Allowed routes for DROP:
 *   /crm/dashboard (DROP home — DropDashboard component), /crm/routing (→ redirects to /crm/dashboard),
 *   /crm/finance, /crm/team, /crm/profile, /crm/payments,
 *   /crm/documents (Finding 1 fix — DROP sees own documents, PR #198)
 *
 * Mock-based — uses the `asDrop` fixture from fixtures.ts.
 */

import { test, expect } from './fixtures'

test.describe('Drop frontend route-guards — phase 3 (home = /crm/dashboard)', () => {
  // ── Forbidden routes: must redirect to DROP home (/crm/dashboard) ───────────

  test('/crm root for DROP → /crm/dashboard', async ({ asDrop: page }) => {
    // /crm index → resolveRoleHome('DROP') = /crm/dashboard (PR #198).
    await page.goto('/crm')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
  })

  test('/crm/interviews for DROP → /crm/dashboard', async ({ asDrop: page }) => {
    // useRoleGuard(['ADMIN','SENIOR','HR']) — DROP not in list →
    // redirect to resolveRoleHome('DROP') = /crm/dashboard.
    await page.goto('/crm/interviews')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
  })

  test('/crm/documents for DROP → stays on documents page (Finding 1 fix, PR #198)', async ({
    asDrop: page,
  }) => {
    // Finding 1 fix (PR #198): DROP added to ROUTE_ACCESS for /crm/documents.
    // DROP can now view their own documents — no longer redirected to dashboard.
    await page.goto('/crm/documents')
    await expect(page).toHaveURL(/\/crm\/documents/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/crm\/dashboard/)
    await expect(page).not.toHaveURL(/\/login/)
  })

  test('/crm/stats for DROP → /crm/dashboard', async ({ asDrop: page }) => {
    // /crm/stats is ADMIN-only → DROP redirected to /crm/dashboard.
    await page.goto('/crm/stats')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
  })

  test('/crm/users for DROP → /crm/dashboard', async ({ asDrop: page }) => {
    // useRoleGuard(['ADMIN']) — DROP redirected to /crm/dashboard.
    await page.goto('/crm/users')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
  })

  test('/crm/projects for DROP → /crm/dashboard', async ({ asDrop: page }) => {
    // ROUTE_ACCESS for /crm/projects: ['ADMIN','SENIOR','HR','ACCOUNTANT']
    // DROP excluded → redirect to /crm/dashboard.
    await page.goto('/crm/projects')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
  })

  test('/crm/legend for DROP → /crm/dashboard', async ({ asDrop: page }) => {
    // /crm/legend is JUNIOR-only → DROP redirected to /crm/dashboard.
    await page.goto('/crm/legend')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
  })

  test('/crm/project for DROP → /crm/dashboard', async ({ asDrop: page }) => {
    // /crm/project is JUNIOR-only (JUNIOR hub) → DROP redirected to /crm/dashboard.
    await page.goto('/crm/project')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
  })

  // ── Allowed routes: must NOT redirect ───────────────────────────────────────

  test('/crm/dashboard for DROP stays on dashboard hub (no redirect, PR #198)', async ({
    asDrop: page,
  }) => {
    // PR #198: DROP is now in ROUTE_ACCESS for /crm/dashboard.
    // dashboard.tsx renders DropDashboard (role-branch) instead of redirecting.
    await page.goto('/crm/dashboard')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
    // DropDashboard renders the hub testid — confirms full render, not just URL settle.
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })
  })

  test('/crm/routing for DROP → redirects to /crm/dashboard (permanent redirect)', async ({
    asDrop: page,
  }) => {
    // PR #198: routing.tsx beforeLoad throws redirect('/crm/dashboard').
    // Old URL preserved for bookmarks; DROP ends up on /crm/dashboard hub.
    await page.goto('/crm/routing')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })
  })

  test('/crm/profile for DROP stays on profile (no redirect to /crm/dashboard)', async ({
    asDrop: page,
  }) => {
    // Profile is ALL_ROLES → DROP can access it directly without redirect.
    await page.goto('/crm/profile')
    await expect(page).toHaveURL(/\/crm\/profile/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/crm\/dashboard/)
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 8_000 })
  })

  test('/crm/team for DROP stays on team page', async ({ asDrop: page }) => {
    await page.goto('/crm/team')
    await expect(page).toHaveURL(/\/crm\/team/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/crm\/dashboard/)
  })

  test('/crm/finance for DROP stays on finance page', async ({ asDrop: page }) => {
    await page.goto('/crm/finance')
    await expect(page).toHaveURL(/\/crm\/finance/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/crm\/dashboard/)
  })

  // ── RBAC: non-DROP on /crm/routing → redirected to own home ─────────────────

  test('/crm/routing for ADMIN → redirected (not a DROP)', async ({ asAdmin: page }) => {
    // /crm/routing ROUTE_ACCESS=['DROP']. ADMIN not included → guard fires
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
