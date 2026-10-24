/**
 * hr-dashboard.spec.ts — E2E for the HR рекрутинг хаб (HR dashboard).
 *
 * Coverage (AC3):
 *   A. dashboard.tsx dispatches HR → HRDashboard hub on the /crm root.
 *   B. Hub renders 3 KPI cards with the mocked values.
 *   (The old «Открыть канбан» CTA and «my salary» KPI no longer exist — the hub
 *   is the three read-only KPIs below; interviews are reached via the sidebar.)
 *   D. Non-HR roles do NOT see the HR hub on the /crm root.
 *
 * Mock-based (LIFO route registration via fixtures). Default
 * /interviews/hr-summary mock returns { 3, 1, {1500, PENDING} } (see fixtures.ts).
 */

import { test, expect } from './fixtures'
import { loadMessages, assertInCatalog } from '../fixtures/catalog'

// CRM root, anchored on the WHOLE url — matches `/` (and `/?x`) but NOT `/team` etc.
// (a bare `/\/?$/` matches EVERY url, so it asserted nothing).
const CRM_ROOT = /^https?:\/\/[^/]+\/?(\?.*)?$/

// ── A. Dispatch + hub render ─────────────────────────────────────────────────

test.describe('A. HR dashboard dispatch', () => {
  test('HR on /crm sees the HR hub (not general dashboard)', async ({ asHr: page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })

    // Page-title h1s were removed deliberately — the anchor is the hub's root testid.
    await expect(page.getByTestId('hr-dashboard-hub')).toBeVisible({ timeout: 8_000 })

    // Other role hubs must NOT appear for HR.
    await expect(page.getByTestId('accountant-dashboard-hub')).toHaveCount(0)
    await expect(page.getByTestId('drop-dashboard-hub')).toHaveCount(0)
  })
})

// ── B. KPI cards ─────────────────────────────────────────────────────────────

test.describe('B. HR hub — KPI cards', () => {
  test('renders all 3 KPI cards with mocked values', async ({ asHr: page }) => {
    await page.goto('/')
    await expect(page.getByTestId('hr-kpi-grid')).toBeVisible({ timeout: 8_000 })

    const uk = await loadMessages('uk')

    const open = page.getByTestId('kpi-open-interviews')
    await expect(open).toBeVisible()
    await expect(open).toContainText('3')
    await expect(open).toContainText(assertInCatalog(uk, 'Відкриті співбесіди'))

    const hired = page.getByTestId('kpi-hired-month')
    await expect(hired).toBeVisible()
    await expect(hired).toContainText('1')
    await expect(hired).toContainText(assertInCatalog(uk, 'Найнято за місяць'))

    const projects = page.getByTestId('kpi-active-projects')
    await expect(projects).toBeVisible()
    await expect(projects).toContainText('2')
    await expect(projects).toContainText(assertInCatalog(uk, 'Активні проєкти'))
  })
})

// ── D. RBAC — non-HR does not see the hub ────────────────────────────────────

test.describe('D. RBAC — HR hub is HR-only on /crm root', () => {
  test('ADMIN on /crm does NOT see the HR hub', async ({ asAdmin: page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
    await expect(page.getByTestId('hr-dashboard-hub')).toHaveCount(0)
  })

  test('SENIOR on /crm does NOT see the HR hub', async ({ asSenior: page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
    await expect(page.getByTestId('hr-dashboard-hub')).toHaveCount(0)
  })
})
