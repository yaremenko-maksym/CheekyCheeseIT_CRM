/**
 * drop-routing-hub.spec.ts — E2E coverage for Drop phase 2 surfaces.
 *
 * PR #189 adds two new DROP-only pages:
 *   1. /crm/routing  — «Дашборд» hub (DropRoutingHub)
 *   2. /crm/finance  — DropFinancePage (rendered when user.role === 'DROP')
 *
 * And changes DROP home from /crm/profile → /crm/routing.
 *
 * Coverage:
 *   A. Hub render: testids, cards, empty/loaded states, QuickActions.
 *   B. Hub with data: DropActionRequiredBlock income items, pay button navigation.
 *   C. Finance cabinet: DropFinancePage testid, heading, DropBalanceCard,
 *      DropIncomesTable, DropPaymentsHistory.
 *   D. Navigation: DROP sidebar 4 items, click Дашборд → hub, click Финансы → finance.
 *   E. RBAC: non-DROP cannot reach /crm/routing (redirected to own home).
 *
 * All tests are mock-based (LIFO route registration). Source of truth:
 *   apps/web/app/lib/route-access.ts + routing.tsx + DropFinancePage.tsx
 *   on feature branch (NOT live :3001).
 *
 * API mock URL note: in production build (vite preview) axios uses relative
 * baseURL=/api so browser requests go to the web-server origin (e.g. :3010).
 * Playwright intercepts BEFORE the vite proxy forwards to :3001, so mocks must
 * match the web-server origin derived from PLAYWRIGHT_BASE_URL. The `API_BASE`
 * constant below mirrors the same logic as `API` in fixtures.ts.
 */

import { test, expect } from './fixtures'

// Derive web origin to match how `API` constant is built in fixtures.ts.
const _webOrigin =
  (typeof process !== 'undefined' && process.env['PLAYWRIGHT_BASE_URL']) || 'http://localhost:3000'
const API_BASE = `${_webOrigin}/api`

// ── Fixture data for DROP-specific API endpoints ───────────────────────────────

/** DropSelfSummaryDto with non-zero values to verify rendering. */
const DROP_SUMMARY = {
  balance: 1250.5,
  dropSharePercent: 7,
  pendingIncomesCount: 3,
  debtToCompany: 430.0,
}

// ── UUID constants for fixture ids (Zod schemas require z.string().uuid()) ─────

/** income ids used across multiple fixture objects — keep in sync with testids below */
const INCOME_V1_ID = 'b1000000-0000-4000-8000-000000000001'
const INCOME_V2_ID = 'b1000000-0000-4000-8000-000000000002'
const INCOME_P1_ID = 'b1000000-0000-4000-8000-000000000003'
const INCOME_PAID1_ID = 'b1000000-0000-4000-8000-000000000004'
const PROJ1_ID = 'b2000000-0000-4000-8000-000000000001'
const PROJ2_ID = 'b2000000-0000-4000-8000-000000000002'
const PAYMENT1_ID = 'b3000000-0000-4000-8000-000000000001'

/** Two validated incomes for DropActionRequiredBlock. */
const DROP_VALIDATED_INCOMES = {
  items: [
    {
      id: INCOME_V1_ID,
      companyName: 'TechCorp AI',
      amount: 5000,
      currency: 'USDT',
      createdAt: '2026-05-10T10:00:00.000Z',
      status: 'validated' as const,
    },
    {
      id: INCOME_V2_ID,
      companyName: 'LearnFast Ltd',
      amount: 3000,
      currency: 'USDT',
      createdAt: '2026-05-15T12:00:00.000Z',
      status: 'validated' as const,
    },
  ],
  total: 2,
  page: 1,
  limit: 10,
}

/** Two DROP projects. */
const DROP_PROJECTS = [
  {
    id: PROJ1_ID,
    companyName: 'TechCorp AI',
    seniorDisplayName: 'Senior Dev',
    incomesCount: 5,
    status: 'active' as const,
  },
  {
    id: PROJ2_ID,
    companyName: 'LearnFast Ltd',
    seniorDisplayName: 'Senior Dev',
    incomesCount: 2,
    status: 'closed' as const,
  },
]

/** Mixed-status incomes for finance table. */
const DROP_ALL_INCOMES = {
  items: [
    {
      id: INCOME_P1_ID,
      companyName: 'TechCorp AI',
      amount: 5000,
      currency: 'USDT',
      createdAt: '2026-05-10T10:00:00.000Z',
      status: 'pending' as const,
    },
    {
      id: INCOME_V1_ID,
      companyName: 'LearnFast Ltd',
      amount: 3000,
      currency: 'USDT',
      createdAt: '2026-05-15T12:00:00.000Z',
      status: 'validated' as const,
    },
    {
      id: INCOME_PAID1_ID,
      companyName: 'OldClient Co',
      amount: 2000,
      currency: 'USD',
      createdAt: '2026-04-01T08:00:00.000Z',
      status: 'paid' as const,
    },
  ],
  total: 3,
  page: 1,
  limit: 20,
}

/** One confirmed outgoing payment for DropPaymentsHistory. */
const DROP_PAYMENTS = [
  {
    id: PAYMENT1_ID,
    amount: 4650.0,
    currency: 'USDT',
    txHash: '0xabc123def456',
    status: 'confirmed' as const,
    createdAt: '2026-05-20T14:00:00.000Z',
  },
]

// ── A. Hub render ──────────────────────────────────────────────────────────────

test.describe('A. DROP routing hub — /crm/routing render', () => {
  test('hub renders with drop-routing-hub testid and page heading', async ({ asDrop: page }) => {
    await page.goto('/crm/routing')
    await expect(page).toHaveURL(/\/crm\/routing/, { timeout: 8_000 })

    const main = page.getByTestId('drop-routing-hub')
    await expect(main).toBeVisible({ timeout: 8_000 })

    // Page heading — renamed to «Дашборд» in PR #198 (drop-phase3-frontend)
    await expect(main.getByRole('heading', { level: 1 })).toContainText('Дашборд')
  })

  test('hub renders DropBalanceCard with loading → loaded state', async ({ asDrop: page }) => {
    // Override default (balance=0) with data summary. Registered AFTER mockAuthAs (LIFO).
    await page.route(`${API_BASE}/finance/drop/me/summary`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_SUMMARY),
      }),
    )

    await page.goto('/crm/routing')
    await expect(page.getByTestId('drop-balance-card')).toBeVisible({ timeout: 8_000 })

    // Balance amount rendered
    await expect(page.getByTestId('drop-balance-amount')).toBeVisible()
    await expect(page.getByTestId('drop-balance-amount')).toContainText('$1,250.50')

    // Share percent
    await expect(page.getByTestId('drop-balance-share-percent')).toContainText('7%')

    // Pending count
    await expect(page.getByTestId('drop-balance-pending-count')).toContainText('3')
  })

  test('hub renders DropActionRequiredBlock — empty state (нет приходов)', async ({
    asDrop: page,
  }) => {
    // Default mockAuthAs already returns empty incomes.
    await page.goto('/crm/routing')

    const actionBlock = page.getByTestId('drop-action-block')
    await expect(actionBlock).toBeVisible({ timeout: 8_000 })

    // Empty state text
    await expect(actionBlock.getByText(/Нет приходов, требующих оплаты/)).toBeVisible()
  })

  test('hub renders DropProjectsList — empty state', async ({ asDrop: page }) => {
    await page.goto('/crm/routing')

    const projectsList = page.getByTestId('drop-projects-list')
    await expect(projectsList).toBeVisible({ timeout: 8_000 })

    await expect(projectsList.getByText(/Нет активных drop-проектов/)).toBeVisible()
  })

  test('hub renders DropQuickActions buttons', async ({ asDrop: page }) => {
    await page.goto('/crm/routing')

    // testid renamed drop-quick-register-btn → drop-register-income-btn in PR #198
    await expect(page.getByTestId('drop-register-income-btn')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTestId('drop-quick-pay-btn')).toBeVisible()
  })
})

// ── B. Hub with data ───────────────────────────────────────────────────────────

test.describe('B. DROP routing hub — loaded with data', () => {
  test('DropActionRequiredBlock shows validated income items and pay button', async ({
    asDrop: page,
  }) => {
    // Override incomes: return 2 validated items. LIFO → wins over mockAuthAs default.
    const incomesPattern = new RegExp(
      `${API_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/finance/drop/me/incomes(\\?.*)?$`,
    )
    await page.route(incomesPattern, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_VALIDATED_INCOMES),
      }),
    )

    await page.goto('/crm/routing')

    const actionBlock = page.getByTestId('drop-action-block')
    await expect(actionBlock).toBeVisible({ timeout: 8_000 })

    // 2 income items rendered
    const items = actionBlock.getByTestId('drop-action-income-item')
    await expect(items).toHaveCount(2)

    // Pay all CTA visible
    await expect(page.getByTestId('drop-action-pay-all-btn')).toBeVisible()
  })

  test('DropProjectsList renders project items when data available', async ({ asDrop: page }) => {
    // Override projects. LIFO wins.
    await page.route(`${API_BASE}/projects/drop/me`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_PROJECTS),
      }),
    )

    await page.goto('/crm/routing')

    const projectsList = page.getByTestId('drop-projects-list')
    await expect(projectsList).toBeVisible({ timeout: 8_000 })

    // Two project items
    await expect(projectsList.getByTestId(`drop-project-item-${PROJ1_ID}`)).toBeVisible()
    await expect(projectsList.getByTestId(`drop-project-item-${PROJ2_ID}`)).toBeVisible()

    // Company names visible
    await expect(projectsList.getByText('TechCorp AI')).toBeVisible()
    await expect(projectsList.getByText('LearnFast Ltd')).toBeVisible()
  })

  test('pay action on income item navigates to /crm/payments/initiate/:id', async ({
    asDrop: page,
  }) => {
    const incomesPattern = new RegExp(
      `${API_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/finance/drop/me/incomes(\\?.*)?$`,
    )
    await page.route(incomesPattern, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_VALIDATED_INCOMES),
      }),
    )

    // Override /transactions/:id so the initiate-page access-guard can confirm
    // ownership (receiverId === USERS.drop.id). Without this, the guard fires
    // navigate('/crm/routing') and the URL bounces back immediately.
    const txPattern = new RegExp(
      `${API_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/transactions/([^/?]+)$`,
    )
    await page.route(txPattern, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: INCOME_V1_ID,
          type: 'DROP_INCOME',
          status: 'VALIDATED',
          amount: '5000',
          currency: 'USDT',
          receiverId: 'a0000000-0000-4000-8000-000000000007', // USERS.drop.id
          senderId: null,
          senderLabel: null,
          senderName: null,
          receiverLabel: null,
          receiverName: null,
          projectId: null,
          projectName: null,
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
          createdBy: 'a0000000-0000-4000-8000-000000000001',
          createdAt: '2026-05-10T10:00:00.000Z',
          updatedAt: '2026-05-10T10:00:00.000Z',
        }),
      }),
    )

    // Mock POST /payments/initiate-crypto so the CryptoChannelCard doesn't
    // hit the real backend → 401 bounce.
    const initCryptoPattern = new RegExp(
      `${API_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/payments/initiate-crypto$`,
    )
    await page.route(initCryptoPattern, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ recipients: [] }),
      }),
    )

    await page.goto('/crm/routing')

    // Click pay button for first income
    const payBtn = page.getByTestId(`drop-action-pay-btn-${INCOME_V1_ID}`)
    await expect(payBtn).toBeVisible({ timeout: 8_000 })
    await payBtn.click()

    // Should navigate to payments/initiate/<income-v1-uuid> and stay there.
    await expect(page).toHaveURL(new RegExp(`/crm/payments/initiate/${INCOME_V1_ID}`), {
      timeout: 8_000,
    })
  })
})

// ── C. Finance cabinet ─────────────────────────────────────────────────────────

test.describe('C. DROP finance cabinet — /crm/finance', () => {
  test('finance page renders DropFinancePage testid and heading', async ({ asDrop: page }) => {
    await page.goto('/crm/finance')
    await expect(page).toHaveURL(/\/crm\/finance/, { timeout: 8_000 })

    const finPage = page.getByTestId('drop-finance-page')
    await expect(finPage).toBeVisible({ timeout: 8_000 })

    // Page heading scoped to main to avoid sidebar
    const main = page.locator('main')
    await expect(main.getByRole('heading', { level: 1 })).toContainText('Финансы')
  })

  test('finance cabinet renders DropBalanceCard (variant=full)', async ({ asDrop: page }) => {
    await page.route(`${API_BASE}/finance/drop/me/summary`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_SUMMARY),
      }),
    )

    await page.goto('/crm/finance')

    await expect(page.getByTestId('drop-balance-card')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTestId('drop-balance-amount')).toContainText('$1,250.50')
  })

  test('finance cabinet renders DropIncomesTable with rows', async ({ asDrop: page }) => {
    const incomesPattern = new RegExp(
      `${API_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/finance/drop/me/incomes(\\?.*)?$`,
    )
    await page.route(incomesPattern, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_ALL_INCOMES),
      }),
    )

    await page.goto('/crm/finance')

    const table = page.getByTestId('drop-incomes-table')
    await expect(table).toBeVisible({ timeout: 8_000 })

    // 3 income rows
    await expect(page.getByTestId(`drop-income-row-${INCOME_P1_ID}`)).toBeVisible()
    await expect(page.getByTestId(`drop-income-row-${INCOME_V1_ID}`)).toBeVisible()
    await expect(page.getByTestId(`drop-income-row-${INCOME_PAID1_ID}`)).toBeVisible()

    // Pay button only on validated row
    await expect(page.getByTestId(`drop-income-pay-btn-${INCOME_V1_ID}`)).toBeVisible()
    // Pending and paid rows do NOT have pay buttons
    await expect(page.getByTestId(`drop-income-pay-btn-${INCOME_P1_ID}`)).toHaveCount(0)
    await expect(page.getByTestId(`drop-income-pay-btn-${INCOME_PAID1_ID}`)).toHaveCount(0)
  })

  test('finance cabinet renders DropPaymentsHistory with confirmed payment', async ({
    asDrop: page,
  }) => {
    // Register BEFORE goto — LIFO wins over mockAuthAs default (returns []).
    // Use RegExp to match with or without trailing query params.
    const paymentsPattern = new RegExp(
      `${API_BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/finance/drop/me/payments(\\?.*)?$`,
    )
    await page.route(paymentsPattern, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_PAYMENTS),
      }),
    )

    await page.goto('/crm/finance')
    // Wait for finance page to fully render (payments section loads after incomes).
    await expect(page.getByTestId('drop-finance-page')).toBeVisible({ timeout: 8_000 })

    const history = page.getByTestId('drop-payments-history')
    await expect(history).toBeVisible({ timeout: 10_000 })

    await expect(page.getByTestId(`drop-payment-row-${PAYMENT1_ID}`)).toBeVisible()
    // Tx hash visible (truncated)
    await expect(history.getByText(/0xabc123def456/)).toBeVisible()
  })

  test('finance cabinet incomes table — empty state text', async ({ asDrop: page }) => {
    // Default mockAuthAs returns empty incomes — use default.
    await page.goto('/crm/finance')

    const table = page.getByTestId('drop-incomes-table')
    await expect(table).toBeVisible({ timeout: 8_000 })
    await expect(table.getByText(/Приходов пока нет/)).toBeVisible()
  })

  test('finance cabinet filter status select is rendered', async ({ asDrop: page }) => {
    await page.goto('/crm/finance')

    await expect(page.getByTestId('drop-filter-status')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTestId('drop-filter-period')).toBeVisible()
  })

  test('finance cabinet header has «Зарегистрировать приход» button (PR #198 unification)', async ({
    asDrop: page,
  }) => {
    // PR #198 (drop-phase3-frontend): «Зарегистрировать приход» action was added to
    // DropFinancePage header with the same testid drop-register-income-btn as in
    // DropQuickActions — canonical CTA available from both hub and finance page.
    await page.goto('/crm/finance')
    await expect(page.getByTestId('drop-finance-page')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTestId('drop-register-income-btn')).toBeVisible({ timeout: 8_000 })
  })
})

// ── D. Sidebar navigation ──────────────────────────────────────────────────────

test.describe('D. DROP sidebar navigation — 4 items', () => {
  test('DROP sidebar has 4 nav links (Дашборд / Финансы / Команда / Профиль)', async ({
    asDrop: page,
  }) => {
    await page.goto('/crm/routing')
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })

    const nav = page.getByTestId('drop-nav')
    await expect(nav).toBeVisible()
    await expect(nav.locator('a')).toHaveCount(4)

    // Each expected link present
    await expect(nav.locator('a[href="/crm/routing"]')).toBeVisible()
    await expect(nav.locator('a[href="/crm/finance"]')).toBeVisible()
    await expect(nav.locator('a[href="/crm/team"]')).toBeVisible()
    await expect(nav.locator('a[href="/crm/profile"]')).toBeVisible()
  })

  test('clicking Финансы in DROP nav navigates to /crm/finance and renders DropFinancePage', async ({
    asDrop: page,
  }) => {
    await page.goto('/crm/routing')
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })

    const nav = page.getByTestId('drop-nav')
    await nav.locator('a[href="/crm/finance"]').click()
    await expect(page).toHaveURL(/\/crm\/finance/, { timeout: 8_000 })

    // DropFinancePage rendered (not the standard FinancePage)
    await expect(page.getByTestId('drop-finance-page')).toBeVisible({ timeout: 8_000 })
  })

  test('clicking Профиль in DROP nav navigates to /crm/profile', async ({ asDrop: page }) => {
    await page.goto('/crm/routing')
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })

    const nav = page.getByTestId('drop-nav')
    await nav.locator('a[href="/crm/profile"]').click()
    await expect(page).toHaveURL(/\/crm\/profile/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
  })

  test('QuickActions "Платить компании" navigates to /crm/finance', async ({ asDrop: page }) => {
    await page.goto('/crm/routing')
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })

    await page.getByTestId('drop-quick-pay-btn').click()
    await expect(page).toHaveURL(/\/crm\/finance/, { timeout: 8_000 })
  })
})

// ── E. RBAC: non-DROP cannot reach /crm/routing ────────────────────────────────

test.describe('E. RBAC — /crm/routing is DROP-only', () => {
  test('ADMIN on /crm/routing → redirected to /crm/dashboard', async ({ asAdmin: page }) => {
    await page.goto('/crm/routing')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
  })

  test('SENIOR on /crm/routing → redirected to /crm/dashboard', async ({ asSenior: page }) => {
    await page.goto('/crm/routing')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
  })

  test('HR on /crm/routing → redirected to /crm/dashboard', async ({ asHr: page }) => {
    await page.goto('/crm/routing')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
  })

  test('JUNIOR on /crm/routing → redirected to /crm/project', async ({ asJunior: page }) => {
    await page.goto('/crm/routing')
    await expect(page).toHaveURL(/\/crm\/project/, { timeout: 8_000 })
  })

  test('non-DROP does NOT see «Дашборд» (DROP nav) in sidebar', async ({ asAdmin: page }) => {
    await page.goto('/crm/dashboard')
    await expect(page).toHaveURL(/\/crm\/dashboard/, { timeout: 8_000 })
    // No drop-nav testid for ADMIN (only rendered for DROP)
    await expect(page.getByTestId('drop-nav')).toHaveCount(0)
    // No routing link in the regular nav
    const sidebar = page.locator('nav').first()
    await expect(sidebar.locator('a[href="/crm/routing"]')).toHaveCount(0)
  })
})
