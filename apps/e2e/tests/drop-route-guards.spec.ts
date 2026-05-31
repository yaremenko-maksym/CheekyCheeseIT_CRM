/**
 * drop-route-guards.spec.ts — task-e2e-fragile-points-audit.
 *
 * Extends `drop-rbac.spec.ts` (which only covers /crm/dashboard +
 * /crm/users) with a complete sweep of DROP-forbidden direct URLs.
 *
 * Round-1 user testing exposed that DROP could land on /crm/interviews,
 * /crm/documents, /crm/stats and /crm (root) via deep links and either
 * see an "access denied" panel or worse — a partially rendered page.
 *
 * The fix (PR #63) introduced `useRoleGuard` on each non-DROP route +
 * a useEffect redirect on /crm and /crm/dashboard that pushes DROP to
 * /crm/profile. This spec asserts the FULL contract: deep-link any
 * forbidden URL → DROP lands on /crm/profile (possibly via /crm/dashboard
 * intermediary, since useRoleGuard redirects to /dashboard which then
 * itself redirects DROP to /profile).
 *
 * Mock-based — uses the `asDrop` fixture from fixtures.ts.
 */

import { test, expect } from './fixtures'

test.describe('Drop frontend route-guards — direct URLs', () => {
  // Each test follows the same shape: navigate as DROP → assert final URL is
  // /crm/profile (via useEffect redirect). Some routes hop through
  // /crm/dashboard first (useRoleGuard's destination) before the
  // /crm/dashboard guard kicks the DROP onwards to /crm/profile. The final
  // resolved URL is /crm/profile in every case.

  test('/crm root for DROP → /crm/profile', async ({ asDrop: page }) => {
    await page.goto('/crm')
    await expect(page).toHaveURL(/\/crm\/profile/, { timeout: 8_000 })
  })

  test('/crm/dashboard for DROP → /crm/profile', async ({ asDrop: page }) => {
    await page.goto('/crm/dashboard')
    await expect(page).toHaveURL(/\/crm\/profile/, { timeout: 8_000 })
  })

  test('/crm/interviews for DROP → /crm/profile', async ({ asDrop: page }) => {
    // useRoleGuard(['ADMIN','SENIOR','JUNIOR','HR','ACCOUNTANT']) — DROP not
    // in the list → redirect to /crm/dashboard → that page redirects DROP
    // to /crm/profile.
    await page.goto('/crm/interviews')
    await expect(page).toHaveURL(/\/crm\/profile/, { timeout: 8_000 })
  })

  test('/crm/documents for DROP → /crm/profile', async ({ asDrop: page }) => {
    await page.goto('/crm/documents')
    await expect(page).toHaveURL(/\/crm\/profile/, { timeout: 8_000 })
  })

  test('/crm/stats for DROP → /crm/profile', async ({ asDrop: page }) => {
    // /crm/stats is ADMIN-only with its own useEffect redirect — non-ADMIN
    // bounces to /crm/dashboard, then DROP guard re-routes to /crm/profile.
    await page.goto('/crm/stats')
    await expect(page).toHaveURL(/\/crm\/profile/, { timeout: 8_000 })
  })

  test('/crm/users for DROP → /crm/profile (useRoleGuard redirect)', async ({
    asDrop: page,
  }) => {
    // /crm/users got a `useRoleGuard(['ADMIN','SENIOR','JUNIOR','HR','ACCOUNTANT'])`
    // in PR #63 phase 1 fix AC4 — DROP is NOT in the allowlist so the
    // guard redirects to /crm/dashboard, which then itself redirects DROP
    // to /crm/profile. Final URL is /crm/profile.
    // (The legacy mock-based drop-rbac.spec.ts still expects the
    // «Доступ только для администратора» panel because that mock skips
    // the auth roundtrip — kept there for the panel-render path.)
    await page.goto('/crm/users')
    await expect(page).toHaveURL(/\/crm\/profile/, { timeout: 8_000 })
  })

  // Sanity: allowed URLs do NOT redirect.
  test('/crm/profile for DROP stays on profile (no redirect loop)', async ({
    asDrop: page,
  }) => {
    await page.goto('/crm/profile')
    await expect(page).toHaveURL(/\/crm\/profile/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
    // Ensure we didn't bounce to /dashboard then back — final URL is
    // /crm/profile and the page rendered the heading.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({
      timeout: 8_000,
    })
  })

  test('/crm/team for DROP stays on team page', async ({ asDrop: page }) => {
    await page.goto('/crm/team')
    await expect(page).toHaveURL(/\/crm\/team/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/crm\/profile/)
  })

  test('/crm/finance for DROP stays on finance page', async ({ asDrop: page }) => {
    await page.goto('/crm/finance')
    await expect(page).toHaveURL(/\/crm\/finance/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/crm\/profile/)
  })
})
