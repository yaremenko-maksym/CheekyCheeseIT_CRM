/**
 * phase8-payout-company.spec.ts — Phase 8 v2/v3 E2E coverage (PR #253)
 *
 * AC coverage:
 *  AC2 — SENIOR sees payout dialog with company wallet address (copyable) + txHash input
 *  AC3 — Manual-confirm section (payout-detail-manual-section) visible ADMIN/ACCOUNTANT,
 *         hidden for SENIOR / DROP / JUNIOR / HR
 *  AC4 — DIVIDEND option in CreateTransactionDialog visible ADMIN-only,
 *         not present for SENIOR / ACCOUNTANT
 *  AC5 — Company balance KPI (stats-company-account-balance) visible on /crm/stats
 *         for ADMIN + ACCOUNTANT
 *
 * All tests use Playwright route mocks — no real backend required.
 * Route pattern: glob **\/api for string routes, \\\/api for RegExp routes.
 */

import { test, expect, USERS, mockAuthAs } from './fixtures'
import type { Page, Route } from '@playwright/test'

// ---------------------------------------------------------------------------
// Origin-agnostic route constants (Vite dev-proxy: browser→:3000, api→:3001)
// ---------------------------------------------------------------------------
const API_GLOB = '**/api'
const API_RE = '\\/api'

function jsonOk(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const COMPANY_WALLET = '0xDeAdBeEf1234567890AbCdEf1234567890AbCdEf'

const PAYOUT_ID = 'payout-p8-1'

function makePayoutRequest(overrides: object = {}) {
  return {
    id: PAYOUT_ID,
    seniorId: USERS.senior.id,
    seniorName: USERS.senior.displayName,
    incomeAmount: '5000.00',
    payableAmount: '3700.00',
    // Phase 8: contractAddress holds the COMPANY wallet (recipient)
    contractAddress: COMPANY_WALLET,
    status: 'PENDING',
    txHash: null,
    method: null,
    note: null,
    transactions: [],
    createdAt: '2026-05-02T12:00:00.000Z',
    updatedAt: '2026-05-02T12:00:00.000Z',
    ...overrides,
  }
}

/**
 * Register the minimum routes needed to open PayoutDetailDialog.
 * Call AFTER mockAuthAs() so LIFO ordering keeps these handlers on top.
 */
async function mockPayoutDetailRoutes(page: Page, payout = makePayoutRequest()) {
  // Most-specific sub-routes first (LIFO — registered last, fires first).
  // POST /pay — on-chain submit
  await page.route(new RegExp(`${API_RE}/payout-requests/([^/?]+)/pay$`), (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    return jsonOk(r, { ...payout, status: 'PAID', txHash: '0xdeadbeef123' })
  })
  // POST /manual-confirm — ADMIN/ACCOUNTANT only
  await page.route(new RegExp(`${API_RE}/payout-requests/([^/?]+)/manual-confirm$`), (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    return jsonOk(r, { ...payout, status: 'PAID', method: 'CASH' })
  })
  // Single payout GET — PayoutDetailDialog fetches by id on open
  await page.route(new RegExp(`${API_RE}/payout-requests/([^/?]+)$`), (r) => {
    if (r.request().method() === 'GET') return jsonOk(r, payout)
    return r.fallback()
  })
  // Payout list — one pending payout so the inline «Оплатить» pill renders
  await page.route(new RegExp(`${API_RE}/payout-requests(\\?.*)?$`), (r) => {
    if (r.request().method() === 'POST') return jsonOk(r, payout, 201)
    return jsonOk(r, [payout])
  })
  // Transactions list (finance page requires it)
  await page.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) => {
    if (r.request().method() === 'POST') return jsonOk(r, {}, 201)
    return jsonOk(r, [])
  })
}

/** Minimal finance page mocks for roles that only open CreateTransactionDialog. */
async function mockFinanceListRoutes(page: Page) {
  await page.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) => {
    if (r.request().method() === 'POST') return jsonOk(r, {}, 201)
    return jsonOk(r, [])
  })
  await page.route(new RegExp(`${API_RE}/payout-requests(\\?.*)?$`), (r) => jsonOk(r, []))
}

// ---------------------------------------------------------------------------
// AC2 — SENIOR sees company wallet address (copyable) + txHash input
// ---------------------------------------------------------------------------

test.describe('AC2 — PayoutDetailDialog: company wallet address for SENIOR', () => {
  test('SENIOR sees company wallet address and copy button in payout dialog', async ({
    asSenior,
  }) => {
    await mockPayoutDetailRoutes(asSenior)

    await asSenior.goto('/crm/finance')
    await asSenior.getByTestId(`row-pay-payout-${PAYOUT_ID}`).click()

    const dialog = asSenior.getByTestId('payout-detail-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-contract-address')).toContainText(COMPANY_WALLET)
    await expect(dialog.getByTestId('payout-detail-copy-address')).toBeVisible()
  })

  test('SENIOR sees payable amount in payout dialog', async ({ asSenior }) => {
    await mockPayoutDetailRoutes(asSenior)

    await asSenior.goto('/crm/finance')
    await asSenior.getByTestId(`row-pay-payout-${PAYOUT_ID}`).click()

    const dialog = asSenior.getByTestId('payout-detail-dialog')
    await expect(dialog).toBeVisible()
    // payableAmount = 3700 in various ru-RU locale formats
    await expect(dialog.getByTestId('payout-detail-payable')).toContainText(/3[\s,.]?700/)
  })

  test('SENIOR sees txHash input; submit disabled without hash', async ({ asSenior }) => {
    await mockPayoutDetailRoutes(asSenior)

    await asSenior.goto('/crm/finance')
    await asSenior.getByTestId(`row-pay-payout-${PAYOUT_ID}`).click()

    const dialog = asSenior.getByTestId('payout-detail-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-tx-hash-input')).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-submit')).toBeDisabled()
  })

  test('SENIOR enters txHash ≥10 chars — submit unlocks', async ({ asSenior }) => {
    await mockPayoutDetailRoutes(asSenior)

    await asSenior.goto('/crm/finance')
    await asSenior.getByTestId(`row-pay-payout-${PAYOUT_ID}`).click()

    const dialog = asSenior.getByTestId('payout-detail-dialog')
    await expect(dialog).toBeVisible()

    // CI runs a production build (`vite preview`) where `import.meta.env.DEV`
    // is false → dev-simulate block is tree-shaken out. Click only when mounted.
    const simulateRadio = dialog.getByTestId('payout-detail-dev-simulate-success')
    if (await simulateRadio.isVisible()) {
      await simulateRadio.click()
    }
    await dialog.getByTestId('payout-detail-tx-hash-input').fill('0xdeadbeef123456')
    await expect(dialog.getByTestId('payout-detail-submit')).not.toBeDisabled()
  })
})

// ---------------------------------------------------------------------------
// AC3 — Manual-confirm section RBAC: ADMIN and ACCOUNTANT see it
// ---------------------------------------------------------------------------

test.describe('AC3 — Manual-confirm section: visible for ADMIN / ACCOUNTANT', () => {
  test('ADMIN sees manual-confirm section in payout dialog', async ({ asAdmin }) => {
    await mockPayoutDetailRoutes(asAdmin)

    await asAdmin.goto('/crm/finance')
    await asAdmin.getByTestId(`row-pay-payout-${PAYOUT_ID}`).click()

    const dialog = asAdmin.getByTestId('payout-detail-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-manual-section')).toBeVisible()
  })

  test('ADMIN sees all three manual methods: CASH, ADMIN_USDT, COMPANY_ACCOUNT', async ({
    asAdmin,
  }) => {
    await mockPayoutDetailRoutes(asAdmin)

    await asAdmin.goto('/crm/finance')
    await asAdmin.getByTestId(`row-pay-payout-${PAYOUT_ID}`).click()

    const dialog = asAdmin.getByTestId('payout-detail-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-manual-method-cash')).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-manual-method-admin_usdt')).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-manual-method-company_account')).toBeVisible()
  })

  test('ADMIN submits manual-confirm with CASH method — dialog closes', async ({ asAdmin }) => {
    await mockPayoutDetailRoutes(asAdmin)

    await asAdmin.goto('/crm/finance')
    await asAdmin.getByTestId(`row-pay-payout-${PAYOUT_ID}`).click()

    const dialog = asAdmin.getByTestId('payout-detail-dialog')
    await expect(dialog).toBeVisible()

    await dialog.getByTestId('payout-detail-manual-method-cash').click()
    await dialog.getByTestId('payout-detail-manual-note').fill('Оплачено наличными')
    await dialog.getByTestId('payout-detail-manual-submit').click()

    await expect(dialog).not.toBeVisible()
  })

  test('ACCOUNTANT sees manual-confirm section in payout dialog', async ({ asAccountant }) => {
    await mockPayoutDetailRoutes(asAccountant)

    await asAccountant.goto('/crm/finance')
    await asAccountant.getByTestId(`row-pay-payout-${PAYOUT_ID}`).click()

    const dialog = asAccountant.getByTestId('payout-detail-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-manual-section')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// AC3 — Manual-confirm section RBAC: hidden for SENIOR / DROP / JUNIOR / HR
// ---------------------------------------------------------------------------

test.describe('AC3 — Manual-confirm section: hidden for non-privileged roles', () => {
  async function assertManualSectionHidden(page: Page) {
    await mockPayoutDetailRoutes(page)
    await page.goto('/crm/finance')
    await page.getByTestId(`row-pay-payout-${PAYOUT_ID}`).click()
    const dialog = page.getByTestId('payout-detail-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-manual-section')).not.toBeVisible()
  }

  test('SENIOR does NOT see manual-confirm section', async ({ asSenior }) => {
    await assertManualSectionHidden(asSenior)
  })

  test('DROP does NOT see manual-confirm section', async ({ asDrop }) => {
    await assertManualSectionHidden(asDrop)
  })

  test('JUNIOR does NOT see manual-confirm section', async ({ asJunior }) => {
    await assertManualSectionHidden(asJunior)
  })

  test('HR does NOT see manual-confirm section', async ({ asHr }) => {
    await assertManualSectionHidden(asHr)
  })
})

// ---------------------------------------------------------------------------
// AC4 — DIVIDEND option in CreateTransactionDialog: ADMIN-only
// ---------------------------------------------------------------------------

test.describe('AC4 — DIVIDEND transaction type: ADMIN-only', () => {
  /** Extra routes needed for ADMIN's CreateTransactionDialog (users list + company balance). */
  async function mockAdminDividendRoutes(page: Page) {
    // company-account with non-zero balance to pass the dividend balance guard
    await page.route(new RegExp(`${API_RE}/company-account$`), (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return jsonOk(r, {
        walletAddress: COMPANY_WALLET,
        confirmationThreshold: 12,
        balance: 10000,
        updatedAt: null,
      })
    })
    // Admin users list for the dividend receiver dropdown
    await page.route(new RegExp(`${API_RE}/users(\\?.*)?$`), (r) =>
      jsonOk(r, [
        {
          id: USERS.admin.id,
          displayName: USERS.admin.displayName,
          role: 'ADMIN',
          email: USERS.admin.email,
        },
      ]),
    )
    await mockFinanceListRoutes(page)
  }

  test('ADMIN sees DIVIDEND option in CreateTransactionDialog', async ({ asAdmin }) => {
    await mockAdminDividendRoutes(asAdmin)

    await asAdmin.goto('/crm/finance')
    await asAdmin.getByTestId('finance-create-transaction-button').click()

    const dialog = asAdmin.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('create-transaction-type-dividend')).toBeVisible()
  })

  test('SENIOR does NOT see DIVIDEND option in CreateTransactionDialog', async ({ asSenior }) => {
    await mockFinanceListRoutes(asSenior)

    await asSenior.goto('/crm/finance')
    await asSenior.getByTestId('finance-create-transaction-button').click()

    const dialog = asSenior.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('create-transaction-type-dividend')).not.toBeVisible()
  })

  test('ACCOUNTANT does NOT see DIVIDEND option in CreateTransactionDialog', async ({
    asAccountant,
  }) => {
    await mockFinanceListRoutes(asAccountant)

    await asAccountant.goto('/crm/finance')
    await asAccountant.getByTestId('finance-create-transaction-button').click()

    const dialog = asAccountant.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('create-transaction-type-dividend')).not.toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// AC5 — Company balance KPI on /crm/stats
// ---------------------------------------------------------------------------

test.describe('AC5 — Company balance KPI on /crm/stats', () => {
  /** Override company-account with a recognisable balance for assertion. */
  async function mockStatsRoutes(page: Page, balance = 12345.67) {
    // LIFO — wins over the fixture's default zero-balance company-account mock
    await page.route(new RegExp(`${API_RE}/company-account$`), (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return jsonOk(r, {
        walletAddress: COMPANY_WALLET,
        confirmationThreshold: 12,
        balance,
        updatedAt: null,
      })
    })
    // Stats page renders transaction / payout-requests sections
    await page.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) => jsonOk(r, []))
    await page.route(new RegExp(`${API_RE}/payout-requests(\\?.*)?$`), (r) => jsonOk(r, []))
    await page.route(`${API_GLOB}/users`, (r) => jsonOk(r, []))
  }

  test('ADMIN sees company balance KPI on /crm/stats', async ({ asAdmin }) => {
    await mockStatsRoutes(asAdmin)

    await asAdmin.goto('/crm/stats')

    await expect(asAdmin.getByTestId('stats-company-account-balance')).toBeVisible()
    // Balance 12345.67 — any locale format (non-breaking space / comma / dot separators)
    await expect(asAdmin.getByTestId('stats-company-account-balance')).toContainText(/12[\s,.]?345/)
  })

  test('ACCOUNTANT sees company balance KPI on /crm/stats', async ({ asAccountant }) => {
    await mockStatsRoutes(asAccountant)

    await asAccountant.goto('/crm/stats')

    await expect(asAccountant.getByTestId('stats-company-account-balance')).toBeVisible()
    await expect(asAccountant.getByTestId('stats-company-account-balance')).toContainText(
      /12[\s,.]?345/,
    )
  })
})
