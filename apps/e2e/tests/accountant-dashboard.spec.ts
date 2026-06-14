/**
 * accountant-dashboard.spec.ts — E2E for the ACCOUNTANT финансовый хаб
 * (ACCOUNTANT Sprint 1).
 *
 * Coverage (AC3 / AC4 / AC5 / AC6):
 *   A. dashboard.tsx dispatches ACCOUNTANT → AccountantDashboard hub on /crm/dashboard.
 *   B. Hub renders 4 KPI cards with the mocked values.
 *   C. CTA «Валидировать ожидающие (N)» navigates to /crm/finance?status=PENDING.
 *   D. Finance page deep-link (?status=PENDING) is honoured (status select shows
 *      «Ожидают валидации»).
 *   E. Non-ACCOUNTANT roles do NOT see the accountant hub on /crm/dashboard.
 *
 * Mock-based (LIFO route registration via fixtures). Default
 * /finance/accountant-summary mock returns {4, 2, 12000, 5} (see fixtures.ts).
 */

import { test, expect } from './fixtures'

const _webOrigin =
  (typeof process !== 'undefined' && process.env['PLAYWRIGHT_BASE_URL']) || 'http://localhost:3000'
const API_BASE = `${_webOrigin}/api`

// ── A. Dispatch + hub render ─────────────────────────────────────────────────

test.describe('A. ACCOUNTANT dashboard dispatch', () => {
  test('ACCOUNTANT on /crm/dashboard sees the accountant hub (not general dashboard)', async ({
    asAccountant: page,
  }) => {
    await page.goto('/crm/dashboard')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })

    const hub = page.getByTestId('accountant-dashboard-hub')
    await expect(hub).toBeVisible({ timeout: 8_000 })
    await expect(hub.getByRole('heading', { level: 1 })).toContainText('Дашборд')

    // DROP hub testid must NOT appear for ACCOUNTANT.
    await expect(page.getByTestId('drop-routing-hub')).toHaveCount(0)
  })
})

// ── B. KPI cards ─────────────────────────────────────────────────────────────

test.describe('B. ACCOUNTANT hub — KPI cards', () => {
  test('renders all 4 KPI cards with mocked values', async ({ asAccountant: page }) => {
    await page.goto('/crm/dashboard')
    await expect(page.getByTestId('accountant-kpi-grid')).toBeVisible({ timeout: 8_000 })

    const pending = page.getByTestId('kpi-pending-validation')
    await expect(pending).toBeVisible()
    await expect(pending).toContainText('4')
    await expect(pending).toContainText('$15,000.00')

    const validated = page.getByTestId('kpi-validated-month')
    await expect(validated).toBeVisible()
    await expect(validated).toContainText('2')
    await expect(validated).toContainText('$3,500.00')

    const paid = page.getByTestId('kpi-paid-month')
    await expect(paid).toBeVisible()
    await expect(paid).toContainText('$12,000.00')

    const recipients = page.getByTestId('kpi-recipient-count')
    await expect(recipients).toBeVisible()
    await expect(recipients).toContainText('5')
  })
})

// ── C. CTA navigation ────────────────────────────────────────────────────────

test.describe('C. ACCOUNTANT hub — validate CTA', () => {
  test('CTA shows the pending count and navigates to /crm/finance?status=PENDING', async ({
    asAccountant: page,
  }) => {
    await page.goto('/crm/dashboard')

    const cta = page.getByTestId('accountant-validate-cta')
    await expect(cta).toBeVisible({ timeout: 8_000 })
    await expect(cta).toContainText('Валидировать ожидающие (4)')

    await cta.click()

    // Lands on finance with the PENDING deep-link applied.
    await expect(page).toHaveURL(/\/crm\/finance\?status=PENDING/, { timeout: 8_000 })
  })
})

// ── D. Finance deep-link applies the PENDING filter ──────────────────────────

test.describe('D. Finance status deep-link', () => {
  test('/crm/finance?status=PENDING seeds the status filter to «Ожидают валидации»', async ({
    asAccountant: page,
  }) => {
    // Seed a couple of transactions so the table + filter render.
    await page.route(
      new RegExp(`${API_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/transactions(\\?.*)?$`),
      (r) =>
        r.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 'c0000000-0000-4000-8000-000000000001',
              type: 'SENIOR_INCOME',
              status: 'PENDING',
              amount: '1000',
              currency: 'USDT',
              senderId: null,
              senderLabel: 'Senior A',
              senderName: 'Senior A',
              receiverId: null,
              receiverLabel: null,
              receiverName: null,
              projectId: null,
              projectName: 'Proj A',
              payoutRequestId: null,
              seniorSharePercent: null,
              receiptDocumentId: null,
              receiptExternalUrl: null,
              txHash: null,
              validatedBy: null,
              validatedAt: null,
              rejectionReason: null,
              notes: null,
              salaryMonth: null,
              txDate: null,
              recipientId: null,
              createdBy: 'c0000000-0000-4000-8000-0000000000aa',
              createdAt: '2026-06-10T10:00:00.000Z',
              updatedAt: '2026-06-10T10:00:00.000Z',
            },
          ]),
        }),
    )

    await page.goto('/crm/finance?status=PENDING')
    await expect(page).toHaveURL(/\/crm\/finance\?status=PENDING/, { timeout: 8_000 })

    // The status FilterSelect trigger (Radix combobox) should show the seeded
    // PENDING label «Ожидает» (STATUS_LABELS['PENDING']) as its value — proving
    // the ?status= deep-link initialised the filter (default would be «Все
    // статусы»). This is the load-bearing assertion for AC6.
    const statusTrigger = page.getByRole('combobox').filter({ hasText: 'Ожидает' })
    await expect(statusTrigger).toBeVisible({ timeout: 8_000 })
    // The default «Все статусы» placeholder must NOT be the active value.
    await expect(page.getByRole('combobox').filter({ hasText: 'Все статусы' })).toHaveCount(0)
  })
})

// ── E. RBAC — non-ACCOUNTANT does not see the hub ────────────────────────────

test.describe('E. RBAC — accountant hub is ACCOUNTANT-only on /crm/dashboard', () => {
  test('ADMIN on /crm/dashboard does NOT see the accountant hub', async ({ asAdmin: page }) => {
    await page.goto('/crm/dashboard')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
    // ADMIN sees the general dashboard, not the accountant hub.
    await expect(page.getByTestId('accountant-dashboard-hub')).toHaveCount(0)
  })

  test('SENIOR on /crm/dashboard does NOT see the accountant hub', async ({ asSenior: page }) => {
    await page.goto('/crm/dashboard')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
    await expect(page.getByTestId('accountant-dashboard-hub')).toHaveCount(0)
  })
})
