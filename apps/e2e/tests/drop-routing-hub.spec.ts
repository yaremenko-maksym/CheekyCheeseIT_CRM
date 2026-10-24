/**
 * drop-dashboard-hub.spec.ts — E2E coverage for Drop phase 2+3 surfaces.
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
 *   A. Hub render: `drop-dashboard-hub` root, four KPI cards, summary values, error card.
 *   B. Hub with data: «in progress» panel — empty state, create-payout / pay CTAs.
 *   C. Finance cabinet: DropFinancePage root testid, balance summary,
 *      incomes table, payments history.
 *   D. Navigation: DROP sidebar 6 items, click Финансы → finance, click Профиль → profile.
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
import { loadMessages, assertInCatalog } from '../fixtures/catalog'

// CRM root, anchored on the WHOLE url — matches `/` (and `/?x`) but NOT `/team` etc.
// (a bare `/\/?$/` matches EVERY url, so it asserted nothing).
const CRM_ROOT = /^https?:\/\/[^/]+\/?(\?.*)?$/

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
const INCOME_P1_ID = 'b1000000-0000-4000-8000-000000000003'
const INCOME_PAID1_ID = 'b1000000-0000-4000-8000-000000000004'
const PROJ1_ID = 'b2000000-0000-4000-8000-000000000001'
const PROJ2_ID = 'b2000000-0000-4000-8000-000000000002'
const PAYMENT1_ID = 'b3000000-0000-4000-8000-000000000001'

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
      txDate: null,
      status: 'pending' as const,
      model: 'declared' as const,
    },
    {
      id: INCOME_V1_ID,
      companyName: 'LearnFast Ltd',
      amount: 3000,
      currency: 'USDT',
      createdAt: '2026-05-15T12:00:00.000Z',
      txDate: null,
      status: 'validated' as const,
      model: 'declared' as const,
    },
    {
      id: INCOME_PAID1_ID,
      companyName: 'OldClient Co',
      amount: 2000,
      currency: 'USD',
      createdAt: '2026-04-01T08:00:00.000Z',
      txDate: null,
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
    txDate: null,
  },
]

// ── A. Hub render ──────────────────────────────────────────────────────────────

/**
 * A self-scoped DROP_INCOME / PAYOUT transaction row for the «in progress»
 * panel on the hub (GET /transactions is self-scoped for DROP server-side).
 */
function makeTx(overrides: Record<string, unknown> = {}) {
  return {
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
    projectId: PROJ1_ID,
    projectName: 'TechCorp AI',
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
    ...overrides,
  }
}

test.describe('A. DROP hub — / root render', () => {
  test('hub renders with the drop-dashboard-hub root and four KPI cards', async ({
    asDrop: page,
  }) => {
    // Dashboard consolidation: DROP home is the CRM root `/`. Page-title h1s
    // were removed deliberately — the anchor is the root data-testid.
    await page.goto('/')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })

    const hub = page.getByTestId('drop-dashboard-hub')
    await expect(hub).toBeVisible({ timeout: 8_000 })

    await expect(hub.getByTestId('drop-kpi-grid')).toBeVisible()
    await expect(hub.getByTestId('drop-kpi-active-projects')).toBeVisible()
    await expect(hub.getByTestId('drop-kpi-balance')).toBeVisible()
    await expect(hub.getByTestId('drop-kpi-pending-obligation')).toBeVisible()
    await expect(hub.getByTestId('drop-kpi-pending')).toBeVisible()
  })

  test('KPI cards show the self-summary values and the project count', async ({ asDrop: page }) => {
    // Override defaults (balance=0). Registered AFTER mockAuthAs (LIFO wins).
    await page.route(`${API_GLOB}/finance/drop/me/summary`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_SUMMARY),
      }),
    )
    await page.route(`${API_GLOB}/projects/drop/me`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_PROJECTS),
      }),
    )

    await page.goto('/')

    // Balance — locale-formatted money (uk: «1 250,50 USD»; the thousands
    // separator is a non-breaking space, \s matches it).
    const balance = page.getByTestId('drop-kpi-balance')
    await expect(balance).toContainText(/1\s250,50/, { timeout: 8_000 })
    await expect(balance).toContainText('7%')

    // Pending obligation amount (800.48) + «2 obligations» sub-label.
    await expect(page.getByTestId('drop-kpi-pending-obligation')).toContainText(/800,48/)

    // Incomes in progress = pendingIncomesCount (3).
    await expect(page.getByTestId('drop-kpi-pending')).toContainText('3')

    // Active projects = number of drop projects (2).
    await expect(page.getByTestId('drop-kpi-active-projects')).toContainText('2')
  })

  test('a failed summary request renders the error card, not a crash', async ({ asDrop: page }) => {
    await page.route(`${API_GLOB}/finance/drop/me/summary`, (r) =>
      r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' }),
    )

    await page.goto('/')

    await expect(page.getByTestId('drop-dashboard-hub')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTestId('drop-kpi-error')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('drop-kpi-grid')).toHaveCount(0)
  })
})

// ── B. Hub with data ───────────────────────────────────────────────────────────

test.describe('B. DROP hub — in-progress panel with data', () => {
  test('in-progress panel is empty when the drop has no transactions', async ({ asDrop: page }) => {
    // Default mockAuthAs returns an empty transactions list.
    await page.goto('/')
    await expect(page.getByTestId('drop-in-progress-panel')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTestId('drop-in-progress-empty')).toBeVisible()
  })

  test('a VALIDATED income row offers «create payout»; a PENDING_PAYMENT payout offers «pay»', async ({
    asDrop: page,
  }) => {
    const PAYOUT_TX_ID = 'b4000000-0000-4000-8000-000000000001'
    const PAYOUT_REQUEST_ID = 'b5000000-0000-4000-8000-000000000001'
    await page.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          makeTx(),
          makeTx({
            id: PAYOUT_TX_ID,
            type: 'PAYOUT',
            status: 'PENDING_PAYMENT',
            payoutRequestId: PAYOUT_REQUEST_ID,
            projectId: null,
            projectName: null,
          }),
        ]),
      })
    })

    await page.goto('/')

    const list = page.getByTestId('drop-in-progress-list')
    await expect(list).toBeVisible({ timeout: 8_000 })

    // VALIDATED income, not yet batched → «create payout» CTA, no «pay».
    await expect(list.getByTestId(`drop-in-progress-row-${INCOME_V1_ID}`)).toBeVisible()
    await expect(list.getByTestId(`drop-in-progress-payout-${INCOME_V1_ID}`)).toBeVisible()
    await expect(list.getByTestId(`drop-pay-payout-${INCOME_V1_ID}`)).toHaveCount(0)

    // PAYOUT awaiting payment → «pay» CTA, no «create payout».
    await expect(list.getByTestId(`drop-pay-payout-${PAYOUT_TX_ID}`)).toBeVisible()
    await expect(list.getByTestId(`drop-in-progress-payout-${PAYOUT_TX_ID}`)).toHaveCount(0)
  })
})

// ── C. Finance cabinet ─────────────────────────────────────────────────────────

test.describe('C. DROP finance cabinet — /finance', () => {
  test('finance page renders the DropFinancePage root testid', async ({ asDrop: page }) => {
    await page.goto('/finance')
    await expect(page).toHaveURL(/\/finance/, { timeout: 8_000 })

    // Page-title h1s were removed deliberately — the anchor is the root testid.
    await expect(page.getByTestId('drop-finance-page')).toBeVisible({ timeout: 8_000 })
  })

  test('finance cabinet shows the balance summary (balance + share %)', async ({
    asDrop: page,
  }) => {
    await page.route(`${API_GLOB}/finance/drop/me/summary`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DROP_SUMMARY),
      }),
    )

    await page.goto('/finance')

    const cabinet = page.getByTestId('drop-finance-page')
    await expect(cabinet).toBeVisible({ timeout: 8_000 })
    // locale-formatted money («1 250,50 USD», NBSP thousands separator) + share
    await expect(cabinet).toContainText(/1\s250,50/, { timeout: 8_000 })
    await expect(cabinet).toContainText('7%')
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
  })

  test('finance cabinet renders payments history with a confirmed payment', async ({
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
    const uk = await loadMessages('uk')
    await expect(table.getByText(assertInCatalog(uk, 'Доходів ще немає'))).toBeVisible()
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

test.describe('D. DROP sidebar navigation — 6 items', () => {
  test('DROP sidebar has 6 nav links (Дашборд / Чекають рішення / Команда / Финансы / Документы / Профиль)', async ({
    asDrop: page,
  }) => {
    // Dashboard consolidation: DROP home is /crm; nav «Дашборд» link also points there.
    // Finding 1 (PR #198): «Документы» link added to drop-nav; the pending-decisions
    // screen added «Чекають рішення» (/pending, all roles) → 6 items total
    // (kept in sync with drop-rbac.spec, the authoritative nav-count test).
    await page.goto('/')
    await expect(page.getByTestId('drop-dashboard-hub')).toBeVisible({ timeout: 8_000 })

    const nav = page.getByTestId('drop-nav')
    await expect(nav).toBeVisible()
    await expect(nav.locator('a')).toHaveCount(6)

    // Each expected link present (Дашборд href → /crm root)
    await expect(nav.locator('a[href="/"]')).toBeVisible()
    await expect(nav.locator('a[href="/pending"]')).toBeVisible()
    await expect(nav.locator('a[href="/finance"]')).toBeVisible()
    await expect(nav.locator('a[href="/team"]')).toBeVisible()
    await expect(nav.locator('a[href="/documents"]')).toBeVisible()
    await expect(nav.locator('a[href="/profile"]')).toBeVisible()
  })

  test('clicking Финансы in DROP nav navigates to /finance and renders DropFinancePage', async ({
    asDrop: page,
  }) => {
    await page.goto('/')
    await expect(page.getByTestId('drop-dashboard-hub')).toBeVisible({ timeout: 8_000 })

    const nav = page.getByTestId('drop-nav')
    await nav.locator('a[href="/finance"]').click()
    await expect(page).toHaveURL(/\/finance/, { timeout: 8_000 })

    // DropFinancePage rendered (not the standard FinancePage)
    await expect(page.getByTestId('drop-finance-page')).toBeVisible({ timeout: 8_000 })
  })

  test('clicking Профиль in DROP nav navigates to /profile', async ({ asDrop: page }) => {
    await page.goto('/')
    await expect(page.getByTestId('drop-dashboard-hub')).toBeVisible({ timeout: 8_000 })

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
    await expect(page.getByTestId('drop-dashboard-hub')).toBeVisible({ timeout: 8_000 })
  })

  test('DROP on /crm sees drop hub (not general dashboard)', async ({ asDrop: page }) => {
    // /crm now renders DropDashboard (branch on role=DROP).
    // Non-DROP roles still see the general dashboard.
    await page.goto('/')
    await expect(page).toHaveURL(CRM_ROOT, { timeout: 8_000 })
    // drop-dashboard-hub testid is rendered by DropDashboard inside dashboard.tsx
    await expect(page.getByTestId('drop-dashboard-hub')).toBeVisible({ timeout: 8_000 })
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
