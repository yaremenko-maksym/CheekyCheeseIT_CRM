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
 *   /crm/dashboard. DROP included in ROUTE_ACCESS for /crm/dashboard;
 *   /crm/routing permanently redirected to /crm/dashboard.
 *
 *   Dashboard consolidation: /crm/dashboard route DELETED — the role-dispatch
 *   dashboard now lives at the CRM root `/crm` (index.tsx). resolveRoleHome(DROP)
 *   === '/crm'. /crm/routing permanently redirects to /crm. All DROP home
 *   expectations updated /crm/dashboard → /crm (root).
 *
 * Source of truth: apps/web/app/lib/route-access.ts (feature branch).
 *   resolveRoleHome('DROP') === '/crm'
 *
 * Forbidden routes for DROP (not in ROUTE_ACCESS for DROP):
 *   /crm/projects, /crm/interviews,
 *   /crm/stats, /crm/users, /crm/legend, /crm/project (JUNIOR-only).
 *
 * Allowed routes for DROP:
 *   /crm (DROP home — role-dispatch renders DropDashboard), /crm/routing (→ /crm),
 *   /crm/finance, /crm/team, /crm/profile, /crm/payments,
 *   /crm/documents (Finding 1 fix — DROP sees own documents, PR #198)
 *
 * Mock-based — uses the `asDrop` fixture from fixtures.ts.
 */

import { test, expect } from './fixtures'

// CRM root, anchored — matches `/crm` (and `/crm/`) but NOT `/crm/team` etc.
const CRM_ROOT = /\/crm\/?$/

test.describe('Drop frontend route-guards — dashboard consolidated to /crm root', () => {
  // ── Forbidden routes: must redirect to DROP home (/crm root) ─────────────────

  test('/crm/interviews for DROP → /crm', async ({ asDrop: page }) => {
    // useRoleGuard(['ADMIN','SENIOR','HR']) — DROP not in list →
    // redirect to resolveRoleHome('DROP') = /crm.
    await page.goto('/crm/interviews')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('/crm/documents for DROP → stays on documents page (Finding 1 fix, PR #198)', async ({
    asDrop: page,
  }) => {
    // Finding 1 fix (PR #198): DROP added to ROUTE_ACCESS for /crm/documents.
    // DROP can now view their own documents — no longer redirected to dashboard.
    await page.goto('/crm/documents')
    await expect(page).toHaveURL(/\/crm\/documents/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
  })

  test('/crm/stats for DROP → /crm', async ({ asDrop: page }) => {
    // /crm/stats is ADMIN/ACCOUNTANT-only → DROP redirected to /crm.
    await page.goto('/crm/stats')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('/crm/users for DROP → /crm', async ({ asDrop: page }) => {
    // useRoleGuard(['ADMIN']) — DROP redirected to /crm.
    await page.goto('/crm/users')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('/crm/projects for DROP → /crm', async ({ asDrop: page }) => {
    // ROUTE_ACCESS for /crm/projects: ['ADMIN','SENIOR','HR','ACCOUNTANT']
    // DROP excluded → redirect to /crm.
    await page.goto('/crm/projects')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('/crm/legend for DROP → redirected away (forbidden)', async ({ asDrop: page }) => {
    // /crm/legend is JUNIOR-only → DROP is redirected away. The exact landing for
    // this route resolves to the DROP profile in the mock setup (legend's own
    // guard, pre-existing behaviour — unchanged by the dashboard consolidation);
    // the security guarantee is simply that DROP never stays on /crm/legend.
    await page.goto('/crm/legend')
    await expect(page).not.toHaveURL(/\/crm\/legend/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
  })

  test('/crm/project for DROP → /crm', async ({ asDrop: page }) => {
    // /crm/project is JUNIOR-only (JUNIOR hub) → DROP redirected to /crm.
    await page.goto('/crm/project')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  // ── Allowed routes: must NOT redirect ───────────────────────────────────────

  test('/crm for DROP stays on root and renders the drop hub (no redirect)', async ({
    asDrop: page,
  }) => {
    // Dashboard consolidation: /crm is DROP home; index.tsx renders DropDashboard
    // (role-branch) instead of redirecting.
    await page.goto('/crm')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
    // DropDashboard renders the hub testid — confirms full render, not just URL settle.
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })
  })

  test('/crm/routing for DROP → redirects to /crm (permanent redirect)', async ({
    asDrop: page,
  }) => {
    // routing.tsx beforeLoad throws redirect('/crm').
    // Old URL preserved for bookmarks; DROP ends up on /crm hub.
    await page.goto('/crm/routing')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })
  })

  test('/crm/profile for DROP stays on profile (no redirect to /crm root)', async ({
    asDrop: page,
  }) => {
    // Profile is ALL_ROLES → DROP can access it directly without redirect.
    await page.goto('/crm/profile')
    await expect(page).toHaveURL(/\/crm\/profile/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(CRM_ROOT)
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 8_000 })
  })

  test('/crm/team for DROP stays on team page', async ({ asDrop: page }) => {
    await page.goto('/crm/team')
    await expect(page).toHaveURL(/\/crm\/team/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(CRM_ROOT)
  })

  test('/crm/finance for DROP stays on finance page', async ({ asDrop: page }) => {
    await page.goto('/crm/finance')
    await expect(page).toHaveURL(/\/crm\/finance/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(CRM_ROOT)
  })

  // ── RBAC: non-DROP on /crm/routing → redirected to own home ─────────────────

  test('/crm/routing for ADMIN → redirected to /crm (not a DROP)', async ({ asAdmin: page }) => {
    // /crm/routing ROUTE_ACCESS=['DROP']. ADMIN not included → guard fires
    // → resolveRoleHome('ADMIN') = /crm.
    await page.goto('/crm/routing')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('/crm/routing for SENIOR → redirected to /crm', async ({ asSenior: page }) => {
    await page.goto('/crm/routing')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('/crm/routing for HR → redirected to /crm', async ({ asHr: page }) => {
    await page.goto('/crm/routing')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('/crm/routing for JUNIOR → redirected to /crm/project', async ({ asJunior: page }) => {
    // JUNIOR home = /crm/project
    await page.goto('/crm/routing')
    await expect(page).toHaveURL(/\/crm\/project/, { timeout: 8_000 })
  })
})
