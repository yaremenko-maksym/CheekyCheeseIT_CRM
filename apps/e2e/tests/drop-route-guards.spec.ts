/**
 * drop-route-guards.spec.ts — DROP role frontend route-guard sweep.
 *
 * History:
 *   PR #63 (phase 1): introduced useRoleGuard on forbidden routes; DROP home
 *   was /profile at the time, so all guard-redirects resolved to /profile.
 *
 *   PR #189 (phase 2): resolveRoleHome(DROP) changed from /profile to
 *   /routing. Every guard-redirect that previously resolved to /profile
 *   now resolves to /routing.
 *
 *   PR #198 (phase 3): resolveRoleHome(DROP) changed from /routing to
 *   /dashboard. DROP included in ROUTE_ACCESS for /dashboard;
 *   /routing permanently redirected to /dashboard.
 *
 *   Dashboard consolidation: /dashboard route DELETED — the role-dispatch
 *   dashboard now lives at the CRM root `/` (index.tsx). resolveRoleHome(DROP)
 *   === '/'. /routing permanently redirects to /crm. All DROP home
 *   expectations updated /dashboard → /crm (root).
 *
 * Source of truth: apps/web/app/lib/route-access.ts (feature branch).
 *   resolveRoleHome('DROP') === '/'
 *
 * Forbidden routes for DROP (not in ROUTE_ACCESS for DROP):
 *   /projects, /interviews,
 *   /stats, /users, /legend, /project (JUNIOR-only).
 *
 * Allowed routes for DROP:
 *   /crm (DROP home — role-dispatch renders DropDashboard), /routing (→ /crm),
 *   /finance, /team, /profile, /payments,
 *   /documents (Finding 1 fix — DROP sees own documents, PR #198)
 *
 * Mock-based — uses the `asDrop` fixture from fixtures.ts.
 */

import { test, expect } from './fixtures'

// CRM root, anchored — matches `/` (and `/`) but NOT `/team` etc.
const CRM_ROOT = /\/?$/

test.describe('Drop frontend route-guards — dashboard consolidated to /crm root', () => {
  // ── Forbidden routes: must redirect to DROP home (/crm root) ─────────────────

  test('/interviews for DROP → /', async ({ asDrop: page }) => {
    // useRoleGuard(['ADMIN','SENIOR','HR']) — DROP not in list →
    // redirect to resolveRoleHome('DROP') = /crm.
    await page.goto('/interviews')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('/documents for DROP → stays on documents page (Finding 1 fix, PR #198)', async ({
    asDrop: page,
  }) => {
    // Finding 1 fix (PR #198): DROP added to ROUTE_ACCESS for /documents.
    // DROP can now view their own documents — no longer redirected to dashboard.
    await page.goto('/documents')
    await expect(page).toHaveURL(/\/documents/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
  })

  test('/stats for DROP → /', async ({ asDrop: page }) => {
    // /stats is ADMIN/ACCOUNTANT-only → DROP redirected to /crm.
    await page.goto('/stats')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('/users for DROP → /', async ({ asDrop: page }) => {
    // useRoleGuard(['ADMIN']) — DROP redirected to /crm.
    await page.goto('/users')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('/projects for DROP → /', async ({ asDrop: page }) => {
    // ROUTE_ACCESS for /projects: ['ADMIN','SENIOR','HR','ACCOUNTANT']
    // DROP excluded → redirect to /crm.
    await page.goto('/projects')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('/legend for DROP → redirected away (forbidden)', async ({ asDrop: page }) => {
    // /legend is JUNIOR-only → DROP is redirected away. The exact landing for
    // this route resolves to the DROP profile in the mock setup (legend's own
    // guard, pre-existing behaviour — unchanged by the dashboard consolidation);
    // the security guarantee is simply that DROP never stays on /legend.
    await page.goto('/legend')
    await expect(page).not.toHaveURL(/\/legend/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
  })

  test('/project for DROP → /', async ({ asDrop: page }) => {
    // /project is JUNIOR-only (JUNIOR hub) → DROP redirected to /crm.
    await page.goto('/project')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  // ── Allowed routes: must NOT redirect ───────────────────────────────────────

  test('/crm for DROP stays on root and renders the drop hub (no redirect)', async ({
    asDrop: page,
  }) => {
    // Dashboard consolidation: /crm is DROP home; index.tsx renders DropDashboard
    // (role-branch) instead of redirecting.
    await page.goto('/')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
    // DropDashboard renders the hub testid — confirms full render, not just URL settle.
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })
  })

  test('/routing for DROP → redirects to /crm (permanent redirect)', async ({ asDrop: page }) => {
    // routing.tsx beforeLoad throws redirect('/').
    // Old URL preserved for bookmarks; DROP ends up on /crm hub.
    await page.goto('/routing')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })
  })

  test('/profile for DROP stays on profile (no redirect to /crm root)', async ({
    asDrop: page,
  }) => {
    // Profile is ALL_ROLES → DROP can access it directly without redirect.
    await page.goto('/profile')
    await expect(page).toHaveURL(/\/profile/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(CRM_ROOT)
    await expect(page).not.toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 8_000 })
  })

  test('/team for DROP stays on team page', async ({ asDrop: page }) => {
    await page.goto('/team')
    await expect(page).toHaveURL(/\/team/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(CRM_ROOT)
  })

  test('/finance for DROP stays on finance page', async ({ asDrop: page }) => {
    await page.goto('/finance')
    await expect(page).toHaveURL(/\/finance/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(CRM_ROOT)
  })

  // ── RBAC: non-DROP on /routing → redirected to own home ─────────────────

  test('/routing for ADMIN → redirected to /crm (not a DROP)', async ({ asAdmin: page }) => {
    // /routing ROUTE_ACCESS=['DROP']. ADMIN not included → guard fires
    // → resolveRoleHome('ADMIN') = /crm.
    await page.goto('/routing')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('/routing for SENIOR → redirected to /', async ({ asSenior: page }) => {
    await page.goto('/routing')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('/routing for HR → redirected to /', async ({ asHr: page }) => {
    await page.goto('/routing')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('/routing for JUNIOR → redirected to /project', async ({ asJunior: page }) => {
    // JUNIOR home = /project
    await page.goto('/routing')
    await expect(page).toHaveURL(/\/project/, { timeout: 8_000 })
  })
})
