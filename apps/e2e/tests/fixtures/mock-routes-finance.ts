import type { Page } from '@playwright/test'
import { type MockUser } from './mock-data'
import { API_RE, jsonOk } from './route-helpers'

export async function mockFinanceRoutes(page: Page, user: MockUser) {
  // Finance — real API paths (no /finance/ prefix for transactions/payout-requests)
  await page.route(new RegExp(`${API_RE}/transactions/senior-income/([^/?]+)$`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-1), status: 'PENDING' }),
  )
  await page.route(new RegExp(`${API_RE}/transactions/([^/?]+)/(validate|pay|admin-edit)$`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-2), status: 'VALIDATED' }),
  )
  await page.route(new RegExp(`${API_RE}/transactions/([^/?]+)$`), (r) => {
    if (r.request().method() === 'DELETE') return jsonOk(r, { deleted: true })
    if (r.request().method() === 'POST') return jsonOk(r, { id: 'tx-new', status: 'PENDING' }, 201)
    return jsonOk(r, { id: r.request().url().split('/').at(-1), status: 'PENDING' })
  })
  await page.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'tx-new', status: 'PENDING' }, 201)
      : jsonOk(r, []),
  )
  await page.route(new RegExp(`${API_RE}/payout-requests/([^/?]+)/pay$`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-2), status: 'PAID' }),
  )
  // Phase 8 v2 (PR #253, AC3) — manual-confirm endpoint (ADMIN/ACCOUNTANT only).
  // Must be registered BEFORE the generic /payout-requests/:id$ route so PATCH
  // requests to /manual-confirm don't accidentally fall through to the generic
  // id-handler (LIFO: last-registered wins). Default: 200 success with method echo.
  await page.route(new RegExp(`${API_RE}/payout-requests/([^/?]+)/manual-confirm$`), (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    const body = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>
    const payoutId = r.request().url().split('/').slice(-2, -1)[0]
    return jsonOk(r, {
      id: payoutId,
      status: 'PAID',
      method: body.method ?? 'COMPANY_ACCOUNT',
      note: body.note ?? null,
      txHash: body.txHash ?? null,
    })
  })
  await page.route(new RegExp(`${API_RE}/payout-requests(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'payout-req-new', status: 'PENDING_PAYMENT' }, 201)
      : jsonOk(r, []),
  )

  // Finance — summary, transactions, expenses, payouts, junior-payments, invoices, exchange rates
  await page.route(new RegExp(`${API_RE}/finance/summary(\\?.*)?$`), (r) =>
    jsonOk(r, {
      totalIncome: '50000.00',
      totalExpenses: '12000.00',
      netProfit: '38000.00',
      totalIncomeUsd: '50000.00',
      totalExpensesUsd: '12000.00',
      netProfitUsd: '38000.00',
      partnerBalance: {
        maksymSpentUsd: '6000.00',
        kostyaSpentUsd: '6000.00',
        debtUsd: '0.00',
        debtDirection: 'SETTLED',
      },
    }),
  )
  // ACCOUNTANT Sprint 1 — accountant финансовый хаб KPI snapshot. Default
  // non-zero values so AccountantDashboard renders the loaded state. Tests that
  // need other figures register their own handler AFTER mockAuthAs (LIFO).
  await page.route(new RegExp(`${API_RE}/finance/accountant-summary(\\?.*)?$`), (r) =>
    jsonOk(r, {
      pendingValidation: { count: 4, amount: 15000 },
      validatedThisMonth: { count: 2, amount: 3500 },
      paidThisMonth: { amount: 12000 },
      recipientCount: 5,
    }),
  )
  // ADMIN dashboard «центр действий» — KPI snapshot + active-transactions feed
  // (GET /api/admin/summary, RBAC ADMIN-only). Без этого мока AdminDashboard's
  // `useAdminSummary` (retry: 2) бьёт по реальному backend'у → 401/hang →
  // дашборд застревает в loading/error и KPI-токены не рендерятся. Shape =
  // `adminSummarySchema`; default non-zero values так дашборд в loaded-состоянии.
  // Тесты, которым нужны иные данные, регистрируют свой handler ПОСЛЕ mockAuthAs.
  await page.route(new RegExp(`${API_RE}/admin/summary(\\?.*)?$`), (r) =>
    jsonOk(r, {
      kpis: {
        activeProjects: 8,
        employees: 21,
        projectsUnpaidThisMonth: 3,
        activeInterviews: 2,
      },
      activeTransactions: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          type: 'SENIOR_INCOME',
          status: 'PENDING',
          senderId: null,
          senderName: null,
          senderLabel: 'Acme Corp',
          receiverId: '33333333-3333-4333-8333-3333333330aa',
          receiverName: 'Mock Senior',
          receiverLabel: 'Mock Senior',
          projectId: '33333333-3333-4333-8333-3333333330bb',
          projectName: 'Mock Project A',
          amount: '4500.000000',
          currency: 'USDT',
          txDate: '2026-05-05T10:00:00.000Z',
          payoutRequestId: null,
          canPay: false,
        },
        {
          id: '44444444-4444-4444-8444-444444444444',
          type: 'PAYOUT',
          status: 'PENDING_PAYMENT',
          senderId: '44444444-4444-4444-8444-4444444440aa',
          senderName: 'Mock Senior',
          senderLabel: 'Mock Senior',
          receiverId: null,
          receiverName: null,
          receiverLabel: 'CheekyCheeseIT',
          projectId: '44444444-4444-4444-8444-4444444440bb',
          projectName: 'Mock Project B',
          amount: '600.000000',
          currency: 'USDT',
          txDate: '2026-05-01T10:00:00.000Z',
          payoutRequestId: null,
          canPay: true,
        },
      ],
    }),
  )
  // SENIOR dashboard (#234) — senior хаб KPI snapshot. STRICTLY self-scoped on
  // the backend (RBAC SENIOR+ADMIN → 200, everyone else → 403). Без этого мока
  // SeniorDashboard's `useSeniorSummary` (GET /api/finance/senior-summary,
  // retry: 2) бьёт по реальному backend'у → 401/hang → `networkidle` никогда не
  // достигается → таймаут навигационных тестов SENIOR (identical failure mode к
  // drop/me/summary комментарию ниже). Shape = `seniorSummarySchema`; default
  // non-zero значения, чтобы дашборд рендерил loaded-состояние. Тесты, которым
  // нужны иные цифры, регистрируют свой handler ПОСЛЕ mockAuthAs (LIFO).
  await page.route(new RegExp(`${API_RE}/finance/senior-summary(\\?.*)?$`), (r) =>
    jsonOk(r, {
      activeProjects: {
        count: 2,
        items: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Mock Project A',
            companyName: 'Acme Corp',
            sharePercent: 26,
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            name: 'Mock Project B',
            companyName: 'Globex',
            sharePercent: 30,
          },
        ],
      },
      seniorShareIncome: { total: 8400, thisMonth: 1200, currency: 'USD' },
      pendingPayouts: { count: 1, amount: 600 },
      // task-salary-month-gap-and-status (E-6, security-review MED-3):
      // `mySalaryStatus` stays the pre-E-6 shape (deprecated, kept for old-
      // client compat); `mySalaryState` is the new 4-state discriminated
      // union. The hook .parse()s this response, so BOTH must be present or
      // the SENIOR dashboard renders its error state.
      mySalaryStatus: { amount: 1200, currency: 'USD', status: 'PENDING' },
      mySalaryState: { state: 'EXISTS', amount: 1200, currency: 'USD', status: 'PENDING' },
      // task-senior-stats-block — «Статистика заработка» (required in DTO). The
      // hook .parse()s the response, so this MUST carry the new shape or the
      // SENIOR dashboard renders the error state. Values keep the dashboard in a
      // loaded state (non-empty sparkline + a partial X/N arrival progress).
      earningsStats: {
        lastMonthIncome: 4200,
        monthlyHistory: [
          { month: '2025-11', amount: 2200 },
          { month: '2025-12', amount: 3100 },
          { month: '2026-01', amount: 2800 },
          { month: '2026-02', amount: 3600 },
          { month: '2026-03', amount: 4100 },
          { month: '2026-04', amount: 3900 },
          { month: '2026-05', amount: 4200 },
          { month: '2026-06', amount: 1200 },
        ],
        companyIncomeProgress: { received: 1, total: 2 },
      },
    }),
  )
  await page.route(new RegExp(`${API_RE}/finance/transactions(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'tx-new', status: 'PENDING' }, 201)
      : jsonOk(r, []),
  )
  await page.route(new RegExp(`${API_RE}/finance/transactions/([^/?]+)`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-1), status: 'VALIDATED' }),
  )
  await page.route(new RegExp(`${API_RE}/finance/expenses(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'exp-new', expenseType: 'COMPANY_INCOME' }, 201)
      : jsonOk(r, []),
  )
  await page.route(new RegExp(`${API_RE}/finance/expenses/([^/?]+)`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-1) }),
  )
  await page.route(new RegExp(`${API_RE}/finance/junior-payments(\\?.*)?$`), (r) => jsonOk(r, []))
  // SR-795-M-1: the create-transaction dialog's existing-salary-parts panel
  // fetches this as soon as a SALARY receiver and month are set. Unstubbed it
  // was the ONE unmocked call in a fully-mocked dialog, so it reached the real
  // backend without a session, returned 401, and the axios interceptor
  // navigated the page to /login mid-test — `E2E (finance)` failed on an
  // `amount-currency-amount-input` fill whose dialog had been replaced by the
  // login screen. Identical failure mode to the senior-summary comment above.
  // Empty list = the common case (a month with no parts), and the panel renders
  // nothing, so no existing spec's layout moves.
  await page.route(new RegExp(`${API_RE}/finance/salary-parts(\\?.*)?$`), (r) =>
    jsonOk(r, {
      receiverId: '00000000-0000-4000-8000-000000000000',
      month: '2026-01',
      parts: [],
    }),
  )
  await page.route(new RegExp(`${API_RE}/finance/invoices(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'inv-new', status: 'DRAFT' }, 201)
      : jsonOk(r, []),
  )
  await page.route(new RegExp(`${API_RE}/finance/invoices/([^/?]+)`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-1), status: 'DRAFT' }),
  )
  await page.route(new RegExp(`${API_RE}/finance/payouts(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'payout-new', status: 'PENDING_PAYMENT' }, 201)
      : jsonOk(r, []),
  )
  await page.route(new RegExp(`${API_RE}/finance/payouts/([^/?]+)`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-1), status: 'PENDING_PAYMENT' }),
  )
  await page.route(new RegExp(`${API_RE}/finance/exchange-rate(\\?.*)?$`), (r) =>
    jsonOk(r, { usdUah: '41.50', usdtUah: '41.50', eurUah: '44.80', date: '2026-05-10' }),
  )
  await page.route(new RegExp(`${API_RE}/finance/chart(/.*)?$`), (r) => jsonOk(r, []))
  await page.route(new RegExp(`${API_RE}/finance/partner-balance(\\?.*)?$`), (r) =>
    jsonOk(r, {
      maksymSpentUsd: '6000.00',
      kostyaSpentUsd: '6000.00',
      debtUsd: '0.00',
      debtDirection: 'SETTLED',
    }),
  )
  await page.route(new RegExp(`${API_RE}/finance/my-salary(\\?.*)?$`), (r) => jsonOk(r, []))
  await page.route(new RegExp(`${API_RE}/finance/expenses/hints(\\?.*)?$`), (r) =>
    jsonOk(r, { projects: [], users: [] }),
  )

  // Phase 8 — Company USDT account. CompanyAccountCard mounts on /finance
  // for ADMIN/ACCOUNTANT and fires GET /api/company-account unconditionally
  // (no `enabled` guard). Without this mock the request hits the real backend →
  // 401 → axios interceptor → /login redirect, OR the pending network request
  // prevents `networkidle` / `waitForLoadState('domcontentloaded')` from settling →
  // downstream navigation tests (navigation.spec.ts:281) time out. Default: a
  // wallet-not-set, zero-balance stub. Tests that need non-zero balance register
  // their own handler AFTER mockAuthAs (LIFO).
  await page.route(new RegExp(`${API_RE}/company-account/dividends$`), (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    return jsonOk(r, { id: 'dividend-new', amount: 0, receiverId: user.id })
  })
  await page.route(new RegExp(`${API_RE}/company-account/wallet$`), (r) => {
    if (r.request().method() !== 'PATCH') return r.fallback()
    return jsonOk(r, {
      walletAddress: (JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>)[
        'walletAddress'
      ] as string,
      confirmationThreshold: 12,
      balance: 0,
      updatedAt: null,
    })
  })
  await page.route(new RegExp(`${API_RE}/company-account$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return jsonOk(r, {
      walletAddress: '0x' + '1'.repeat(40),
      confirmationThreshold: 12,
      balance: 0,
      updatedAt: null,
    })
  })
}
