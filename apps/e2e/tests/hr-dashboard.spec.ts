/**
 * hr-dashboard.spec.ts — E2E for the HR рекрутинг хаб (HR dashboard).
 *
 * Coverage (AC3):
 *   A. dashboard.tsx dispatches HR → HRDashboard hub on the /crm root.
 *   B. Hub renders 3 KPI cards with the mocked values.
 *   C. CTA «Открыть канбан» navigates to /interviews.
 *   D. Non-HR roles do NOT see the HR hub on the /crm root.
 *
 * Mock-based (LIFO route registration via fixtures). Default
 * /interviews/hr-summary mock returns { 3, 1, {1500, PENDING} } (see fixtures.ts).
 */

import { test, expect } from './fixtures'

// CRM root, anchored — matches `/` (and `/`) but NOT `/team` etc.
const CRM_ROOT = /\/?$/

// ── A. Dispatch + hub render ─────────────────────────────────────────────────

test.describe('A. HR dashboard dispatch', () => {
  test('HR on /crm sees the HR hub (not general dashboard)', async ({ asHr: page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })

    const hub = page.getByTestId('hr-dashboard-hub')
    await expect(hub).toBeVisible({ timeout: 8_000 })
    await expect(hub.getByRole('heading', { level: 1 })).toContainText('Дашборд')
    await expect(hub).toContainText('Рекрутинг хаб HR-менеджера')

    // Other role hubs must NOT appear for HR.
    await expect(page.getByTestId('accountant-dashboard-hub')).toHaveCount(0)
    await expect(page.getByTestId('drop-routing-hub')).toHaveCount(0)
  })
})

// ── B. KPI cards ─────────────────────────────────────────────────────────────

test.describe('B. HR hub — KPI cards', () => {
  test('renders all 3 KPI cards with mocked values', async ({ asHr: page }) => {
    await page.goto('/')
    await expect(page.getByTestId('hr-kpi-grid')).toBeVisible({ timeout: 8_000 })

    const open = page.getByTestId('kpi-open-interviews')
    await expect(open).toBeVisible()
    await expect(open).toContainText('3')
    await expect(open).toContainText('Открытые собеседования')

    const hired = page.getByTestId('kpi-hired-month')
    await expect(hired).toBeVisible()
    await expect(hired).toContainText('1')
    await expect(hired).toContainText('Нанято за месяц')

    const salary = page.getByTestId('kpi-my-salary')
    await expect(salary).toBeVisible()
    await expect(salary).toContainText('$1,500.00')
    await expect(salary).toContainText('Ожидает выплаты')
  })
})

// ── C. CTA navigation ────────────────────────────────────────────────────────

test.describe('C. HR hub — interviews CTA', () => {
  test('CTA «Открыть канбан» navigates to /interviews', async ({ asHr: page }) => {
    await page.goto('/')

    const cta = page.getByTestId('hr-interviews-cta')
    await expect(cta).toBeVisible({ timeout: 8_000 })
    await expect(cta).toContainText('Открыть канбан')

    await cta.click()

    await expect(page).toHaveURL(/\/interviews/, { timeout: 8_000 })
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
