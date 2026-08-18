/**
 * drop-routing-hub.spec.ts — E2E coverage for Drop phase 2+3 surfaces.
 *
 * PR #189 adds two new DROP-only pages:
 *   1. /routing  — old URL, now permanently redirects to /crm (root).
 *   2. /finance  — DropFinancePage (rendered when user.role === 'DROP')
 *
 * Dashboard consolidation: the role-dispatch dashboard moved from /dashboard
 * (now DELETED) to the CRM root `/` (index.tsx).
 *   - resolveRoleHome('DROP') === '/'
 *   - /crm root renders DropDashboard for DROP (index.tsx role-branch)
 *   - /routing permanently redirects to /crm (beforeLoad throw redirect)
 *
 * Coverage:
 *   A. Hub render: testids, cards, empty/loaded states, QuickActions.
 *   B. Hub with data: DropActionRequiredBlock income items, pay button navigation.
 *   C. Finance cabinet: DropFinancePage testid, heading, DropBalanceCard,
 *      DropIncomesTable, DropPaymentsHistory.
 *   D. Navigation: DROP sidebar 4 items, click Дашборд → hub, click Финансы → finance.
 *   E. RBAC: non-DROP cannot reach /routing (redirected to own home).
 *   F. Redirect: /routing → /crm (permanent redirect).
 *
 * All tests are mock-based (LIFO route registration). Source of truth:
 *   apps/web/app/lib/route-access.ts + routing.tsx + DropFinancePage.tsx
 *   on feature branch (NOT live :3001).
 *
 * API mock URL note (task-e2e-origin-agnostic): route mocks match on the
 * `/api/...` PATH only, regardless of origin — see fixtures.ts's `API_GLOB`
 * (string routes) / `API_RE` (RegExp routes) comment for the rationale. This
 * file used to derive an absolute origin from `PLAYWRIGHT_BASE_URL` (falling
 * back to a hardcoded `http://localhost:3000`) — that only matched when the
 * browser's actual `/api/*` requests happened to go through the same-origin
 * proxy (local `vite preview`); it silently stopped matching in the CI mode
 * where `VITE_API_URL` is baked to an absolute `http://localhost:3001/api` at
 * build time, since then the request origin has nothing to do with
 * `PLAYWRIGHT_BASE_URL`.
 */

import { test, expect, API_GLOB, API_RE } from './fixtures'

// CRM root, anchored — matches `/` (and `/`) but NOT `/team` etc.
const CRM_ROOT = /\/?$/

// ── Fixture data for DROP-specific API endpoints ───────────────────────────────

/**
 * DropSelfSummaryDto with non-zero values to verify rendering.
 * task-drop-sees-own-obligations: pendingObligationAmount/Count are now
 * required fields — omitting them would fail the FE's Zod `.parse()` and
 * surface as a silent error state instead of the expected rendered data.
 */
const DROP_SUMMARY = {
  balance: 1250.5,
  dropSharePercent: 7,
  pendingIncomesCount: 3,
  debtToCompany: 430.0,
  pendingObligationAmount: 800.48,
  pendingObligationCount: 2,
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

/**
 * Two validated incomes for DropActionRequiredBlock.
 * task-drop-sees-own-obligations: `model` is now a required DropIncomeDto
 * field — both rows are the old self-declared model (never 'validated' for
 * an obligation row).
 */
const DROP_VALIDATED_INCOMES = {
  items: [
    {
      id: INCOME_V1_ID,
      companyName: 'TechCorp AI',
      amount: 5000,
      currency: 'USDT',
      createdAt: '2026-05-10T10:00:00.000Z',
      status: 'validated' as const,
      model: 'declared' as const,
    },
    {
      id: INCOME_V2_ID,
      companyName: 'LearnFast Ltd',
      amount: 3000,
      currency: 'USDT',
      createdAt: '2026-05-15T12:00:00.000Z',
      status: 'validated' as const,
      model: 'declared' as const,
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
      model: 'declared' as const,
    },
    {
      id: INCOME_V1_ID,
      companyName: 'LearnFast Ltd',
      amount: 3000,
      currency: 'USDT',
      createdAt: '2026-05-15T12:00:00.000Z',
      status: 'validated' as const,
      model: 'declared' as const,
    },
    {
      id: INCOME_PAID1_ID,
      companyName: 'OldClient Co',
      amount: 2000,
      currency: 'USD',
      createdAt: '2026-04-01T08:00:00.000Z',
      status: 'paid' as const,
      model: 'declared' as const,
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

test.describe('A. DROP routing hub — /crm root render', () => {
  test('hub renders with drop-routing-hub testid and page heading', async ({ asDrop: page }) => {
    // Dashboard consolidation: DROP home is the CRM root /crm.
    await page.goto('/')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })

    const main = page.getByTestId('drop-routing-hub')
    await expect(main).toBeVisible({ timeout: 8_000 })

    // Page heading — «Дашборд» (PR #198 drop-phase3-frontend)
    await expect(main.getByRole('heading', { level: 1 })).toContainText('Дашборд')
  })

  test('hub renders DropBalanceCard with loading → loaded state', async ({ asDrop: page }) => {
    // Override default (balance=0) with data summary. Registered AFTER mockAuthAs (LIFO).
    await page.route(`${API_GLOB}/finance/drop/me/summary`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_SUMMARY),
      }),
    )

    await page.goto('/')
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
    await page.goto('/')

    const actionBlock = page.getByTestId('drop-action-block')
    await expect(actionBlock).toBeVisible({ timeout: 8_000 })

    // Empty state text
    await expect(actionBlock.getByText(/Нет приходов, требующих оплаты/)).toBeVisible()
  })

  test('hub renders DropProjectsList — empty state', async ({ asDrop: page }) => {
    await page.goto('/')

    const projectsList = page.getByTestId('drop-projects-list')
    await expect(projectsList).toBeVisible({ timeout: 8_000 })

    await expect(projectsList.getByText(/Нет активных drop-проектов/)).toBeVisible()
  })

  test('hub renders DropQuickActions buttons', async ({ asDrop: page }) => {
    await page.goto('/')

    // testid renamed drop-quick-register-btn → drop-register-income-btn in PR #198
    await expect(page.getByTestId('drop-register-income-btn')).toBeVisible({ timeout: 8_000 })
  })
})

// ── B. Hub with data ───────────────────────────────────────────────────────────

test.describe('B. DROP routing hub — loaded with data', () => {
  test('DropActionRequiredBlock shows validated income items and pay button', async ({
    asDrop: page,
  }) => {
    // Override incomes: return 2 validated items. LIFO → wins over mockAuthAs default.
    const incomesPattern = new RegExp(`${API_RE}/finance/drop/me/incomes(\\?.*)?$`)
    await page.route(incomesPattern, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_VALIDATED_INCOMES),
      }),
    )

    await page.goto('/')

    const actionBlock = page.getByTestId('drop-action-block')
    await expect(actionBlock).toBeVisible({ timeout: 8_000 })

    // 2 income items rendered
    const items = actionBlock.getByTestId('drop-action-income-item')
    await expect(items).toHaveCount(2)
  })

  test('DropProjectsList renders project items when data available', async ({ asDrop: page }) => {
    // Override projects. LIFO wins.
    await page.route(`${API_GLOB}/projects/drop/me`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_PROJECTS),
      }),
    )

    await page.goto('/')

    const projectsList = page.getByTestId('drop-projects-list')
    await expect(projectsList).toBeVisible({ timeout: 8_000 })

    // Two project items
    await expect(projectsList.getByTestId(`drop-project-item-${PROJ1_ID}`)).toBeVisible()
    await expect(projectsList.getByTestId(`drop-project-item-${PROJ2_ID}`)).toBeVisible()

    // Company names visible
    await expect(projectsList.getByText('TechCorp AI')).toBeVisible()
    await expect(projectsList.getByText('LearnFast Ltd')).toBeVisible()
  })

  test('pay action on income item navigates to /payments/initiate/:id', async ({
    asDrop: page,
  }) => {
    const incomesPattern = new RegExp(`${API_RE}/finance/drop/me/incomes(\\?.*)?$`)
    await page.route(incomesPattern, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_VALIDATED_INCOMES),
      }),
    )

    // Override /transactions/:id so the initiate-page access-guard can confirm
    // ownership (receiverId === USERS.drop.id). Without this, the guard fires
    // navigate('/') and the URL bounces back immediately.
    const txPattern = new RegExp(`${API_RE}/transactions/([^/?]+)$`)
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
    const initCryptoPattern = new RegExp(`${API_RE}/payments/initiate-crypto$`)
    await page.route(initCryptoPattern, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ recipients: [] }),
      }),
    )

    await page.goto('/')

    // Click pay button for first income
    const payBtn = page.getByTestId(`drop-action-pay-btn-${INCOME_V1_ID}`)
    await expect(payBtn).toBeVisible({ timeout: 8_000 })
    await payBtn.click()

    // Should navigate to payments/initiate/<income-v1-uuid> and stay there.
    await expect(page).toHaveURL(new RegExp(`/payments/initiate/${INCOME_V1_ID}`), {
      timeout: 8_000,
    })
  })
})

// ── C. Finance cabinet ─────────────────────────────────────────────────────────

test.describe('C. DROP finance cabinet — /finance', () => {
  test('finance page renders DropFinancePage testid and heading', async ({ asDrop: page }) => {
    await page.goto('/finance')
    await expect(page).toHaveURL(/\/finance/, { timeout: 8_000 })

    const finPage = page.getByTestId('drop-finance-page')
    await expect(finPage).toBeVisible({ timeout: 8_000 })

    // Page heading scoped to main to avoid sidebar
    const main = page.locator('main')
    await expect(main.getByRole('heading', { level: 1 })).toContainText('Финансы')
  })

  test('finance cabinet renders DropBalanceCard (variant=full)', async ({ asDrop: page }) => {
    await page.route(`${API_GLOB}/finance/drop/me/summary`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_SUMMARY),
      }),
    )

    await page.goto('/finance')

    await expect(page.getByTestId('drop-balance-card')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTestId('drop-balance-amount')).toContainText('$1,250.50')
  })

  test('finance cabinet renders DropIncomesTable with rows', async ({ asDrop: page }) => {
    const incomesPattern = new RegExp(`${API_RE}/finance/drop/me/incomes(\\?.*)?$`)
    await page.route(incomesPattern, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_ALL_INCOMES),
      }),
    )

    await page.goto('/finance')

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
    const paymentsPattern = new RegExp(`${API_RE}/finance/drop/me/payments(\\?.*)?$`)
    await page.route(paymentsPattern, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_PAYMENTS),
      }),
    )

    await page.goto('/finance')
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
    await page.goto('/finance')

    const table = page.getByTestId('drop-incomes-table')
    await expect(table).toBeVisible({ timeout: 8_000 })
    await expect(table.getByText(/Приходов пока нет/)).toBeVisible()
  })

  test('finance cabinet filter status select is rendered', async ({ asDrop: page }) => {
    await page.goto('/finance')

    await expect(page.getByTestId('drop-filter-status')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTestId('drop-filter-period')).toBeVisible()
  })

  test('finance cabinet header has «Зарегистрировать приход» button (PR #198 unification)', async ({
    asDrop: page,
  }) => {
    // PR #198 (drop-phase3-frontend): «Зарегистрировать приход» action was added to
    // DropFinancePage header with the same testid drop-register-income-btn as in
    // DropQuickActions — canonical CTA available from both hub and finance page.
    await page.goto('/finance')
    await expect(page.getByTestId('drop-finance-page')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTestId('drop-register-income-btn')).toBeVisible({ timeout: 8_000 })
  })
})

// ── D. Sidebar navigation ──────────────────────────────────────────────────────

test.describe('D. DROP sidebar navigation — 5 items', () => {
  test('DROP sidebar has 5 nav links (Дашборд / Финансы / Команда / Документы / Профиль)', async ({
    asDrop: page,
  }) => {
    // Dashboard consolidation: DROP home is /crm; nav «Дашборд» link also points there.
    // Finding 1 (PR #198): «Документы» link added to drop-nav → 5 items total
    // (kept in sync with drop-rbac.spec, the authoritative nav-count test).
    await page.goto('/')
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })

    const nav = page.getByTestId('drop-nav')
    await expect(nav).toBeVisible()
    await expect(nav.locator('a')).toHaveCount(5)

    // Each expected link present (Дашборд href → /crm root)
    await expect(nav.locator('a[href="/"]')).toBeVisible()
    await expect(nav.locator('a[href="/finance"]')).toBeVisible()
    await expect(nav.locator('a[href="/team"]')).toBeVisible()
    await expect(nav.locator('a[href="/documents"]')).toBeVisible()
    await expect(nav.locator('a[href="/profile"]')).toBeVisible()
  })

  test('clicking Финансы in DROP nav navigates to /finance and renders DropFinancePage', async ({
    asDrop: page,
  }) => {
    await page.goto('/')
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })

    const nav = page.getByTestId('drop-nav')
    await nav.locator('a[href="/finance"]').click()
    await expect(page).toHaveURL(/\/finance/, { timeout: 8_000 })

    // DropFinancePage rendered (not the standard FinancePage)
    await expect(page.getByTestId('drop-finance-page')).toBeVisible({ timeout: 8_000 })
  })

  test('clicking Профиль in DROP nav navigates to /profile', async ({ asDrop: page }) => {
    await page.goto('/')
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })

    const nav = page.getByTestId('drop-nav')
    await nav.locator('a[href="/profile"]').click()
    await expect(page).toHaveURL(/\/profile/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/login/)
  })
})

// ── E. RBAC — /routing is DROP-only (redirects non-DROP) ──────────────────

test.describe('E. RBAC — /routing is DROP-only', () => {
  test('ADMIN on /routing → redirected to /', async ({ asAdmin: page }) => {
    // /routing ROUTE_ACCESS=['DROP']; ADMIN guard fires → resolveRoleHome='/'
    await page.goto('/routing')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('SENIOR on /routing → redirected to /', async ({ asSenior: page }) => {
    await page.goto('/routing')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('HR on /routing → redirected to /', async ({ asHr: page }) => {
    await page.goto('/routing')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
  })

  test('JUNIOR on /routing → redirected to /project', async ({ asJunior: page }) => {
    await page.goto('/routing')
    await expect(page).toHaveURL(/\/project/, { timeout: 8_000 })
  })

  test('non-DROP does NOT see «Дашборд» (DROP nav) in sidebar', async ({ asAdmin: page }) => {
    await page.goto('/')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
    // No drop-nav testid for ADMIN (only rendered for DROP)
    await expect(page.getByTestId('drop-nav')).toHaveCount(0)
    // No /routing link in the regular nav (old DROP-only URL)
    const sidebar = page.locator('nav').first()
    await expect(sidebar.locator('a[href="/routing"]')).toHaveCount(0)
  })
})

// ── F. Redirect: /routing → /crm (root) ──────────────────────────────────

test.describe('F. /routing redirect — permanent redirect to /', () => {
  test('DROP on /routing → URL becomes /crm (redirect works)', async ({ asDrop: page }) => {
    // routing.tsx beforeLoad throws redirect('/').
    // DROP then lands on /crm and sees the drop hub.
    await page.goto('/routing')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
    // Drop hub renders (not a blank redirect loop)
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })
  })

  test('DROP on /crm sees drop hub (not general dashboard)', async ({ asDrop: page }) => {
    // /crm now renders DropDashboard (branch on role=DROP).
    // Non-DROP roles still see the general dashboard.
    await page.goto('/')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
    // drop-routing-hub testid is rendered by DropDashboard inside dashboard.tsx
    await expect(page.getByTestId('drop-routing-hub')).toBeVisible({ timeout: 8_000 })
    // General dashboard testid must NOT appear for DROP
    await expect(page.getByTestId('dashboard-page')).toHaveCount(0)
  })

  test('JUNIOR on /crm → redirected to /project (JUNIOR has own hub)', async ({
    asJunior: page,
  }) => {
    // index.tsx redirects JUNIOR from /crm to their hub /project.
    await page.goto('/')
    await expect(page).toHaveURL(/\/project/, { timeout: 8_000 })
  })
})
