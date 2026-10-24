/**
 * phase8-payout-company.spec.ts — Phase 8 v2/v3 E2E coverage (PR #253)
 *
 * AC coverage:
 *  AC2 — SENIOR sees payout dialog with company wallet address (copyable) + txHash input
 *  AC3 — Manual-confirm section (payout-detail-manual-section) visible ADMIN/ACCOUNTANT,
 *         hidden for SENIOR / DROP / JUNIOR / HR
 *  AC4 — DIVIDEND option in CreateTransactionDialog visible ADMIN-only,
 *         not present for SENIOR / ACCOUNTANT
 *  AC5 — Company balance KPI (stats-company-account-balance) visible on /stats
 *         for ADMIN + ACCOUNTANT
 *
 * All tests use Playwright route mocks — no real backend required.
 * Route pattern: glob **\/api for string routes, \\\/api for RegExp routes.
 */

import { test, expect, USERS, mockAuthAs, API_GLOB, API_RE } from './fixtures'
import type { Page, Route } from '@playwright/test'

function jsonOk(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

const COMPANY_WALLET = '0xDeAdBeEf1234567890AbCdEf1234567890AbCdEf'

const PAYOUT_ID = 'payout-p8-1'
const PAYOUT_TX_ID = 'payout-p8-tx-1'

/**
 * The PAYOUT transaction row (PENDING_PAYMENT) that points at PAYOUT_ID. The inline
 * «Оплатити» pill lives on THIS row (`row-pay-payout-<txId>`), not on the payout-request
 * list — the finance page no longer renders payout requests directly.
 */
function makePayoutTxRow(overrides: object = {}) {
  return {
    id: PAYOUT_TX_ID,
    type: 'PAYOUT',
    status: 'PENDING_PAYMENT',
    payoutRequestId: PAYOUT_ID,
    amount: '3700',
    currency: 'USDT',
    senderId: USERS.senior.id,
    senderName: USERS.senior.displayName,
    senderLabel: null,
    receiverId: null,
    receiverName: null,
    receiverLabel: 'CheekyCheeseIT',
    projectId: null,
    projectName: null,
    salaryMonth: null,
    txDate: null,
    txHash: null,
    rejectionReason: null,
    seniorSharePercent: null,
    seniorSharePercentSource: null,
    createdAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  }
}

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
  // Transactions list — one PAYOUT row in PENDING_PAYMENT carrying the payout-request id
  await page.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) => {
    if (r.request().method() === 'POST') return jsonOk(r, {}, 201)
    return jsonOk(r, [makePayoutTxRow()])
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

    await asSenior.goto('/finance')
    await asSenior.getByTestId(`row-pay-payout-${PAYOUT_TX_ID}`).click()

    const dialog = asSenior.getByTestId('payout-detail-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-contract-address')).toContainText(COMPANY_WALLET)
    await expect(dialog.getByTestId('payout-detail-copy-address')).toBeVisible()
  })

  test('SENIOR sees payable amount in payout dialog', async ({ asSenior }) => {
    await mockPayoutDetailRoutes(asSenior)

    await asSenior.goto('/finance')
    await asSenior.getByTestId(`row-pay-payout-${PAYOUT_TX_ID}`).click()

    const dialog = asSenior.getByTestId('payout-detail-dialog')
    await expect(dialog).toBeVisible()
    // payableAmount = 3700 in various ru-RU locale formats
    await expect(dialog.getByTestId('payout-detail-payable')).toContainText(/3[\s,.]?700/)
  })

  test('SENIOR sees txHash input; submit disabled without hash', async ({ asSenior }) => {
    await mockPayoutDetailRoutes(asSenior)

    await asSenior.goto('/finance')
    await asSenior.getByTestId(`row-pay-payout-${PAYOUT_TX_ID}`).click()

    const dialog = asSenior.getByTestId('payout-detail-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-tx-hash-input')).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-submit')).toBeDisabled()
  })

  test('SENIOR enters txHash ≥10 chars — submit unlocks', async ({ asSenior }) => {
    await mockPayoutDetailRoutes(asSenior)

    await asSenior.goto('/finance')
    await asSenior.getByTestId(`row-pay-payout-${PAYOUT_TX_ID}`).click()

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
// AC3 — Manual payout confirmation RBAC
// ---------------------------------------------------------------------------
//
// Manual confirmation (CASH / ADMIN_USDT / COMPANY_ACCOUNT) is reached by ADMIN /
// ACCOUNTANT through the «confirm payout» button on the PAYOUT row (ConfirmPayoutDialog,
// click-through covered below). The inline «Оплатити» pill that opens PayoutDetailDialog
// is SENIOR-only on /finance, so the dialog's own manual section is no longer reachable
// from the UI for ADMIN/ACCOUNTANT — that component-level behaviour is pinned by
// PayoutDetailDialog.test.tsx; here we assert the reachable RBAC surface.

test.describe('AC3 — Manual payout confirmation: ADMIN / ACCOUNTANT only', () => {
  test('ADMIN sees the confirm-payout button on a PENDING_PAYMENT PAYOUT row', async ({
    asAdmin,
  }) => {
    await mockPayoutDetailRoutes(asAdmin)

    await asAdmin.goto('/finance')
    await expect(asAdmin.getByTestId(`confirm-payout-button-${PAYOUT_TX_ID}`)).toBeVisible()
  })

  test('ACCOUNTANT sees the confirm-payout button on a PENDING_PAYMENT PAYOUT row', async ({
    asAccountant,
  }) => {
    await mockPayoutDetailRoutes(asAccountant)

    await asAccountant.goto('/finance')
    await expect(asAccountant.getByTestId(`confirm-payout-button-${PAYOUT_TX_ID}`)).toBeVisible()
  })

  test('SENIOR does NOT see the manual-confirm section in the payout dialog (own payout)', async ({
    asSenior,
  }) => {
    await mockPayoutDetailRoutes(asSenior)
    await asSenior.goto('/finance')
    await asSenior.getByTestId(`row-pay-payout-${PAYOUT_TX_ID}`).click()
    const dialog = asSenior.getByTestId('payout-detail-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-manual-section')).not.toBeVisible()
  })

  test('SENIOR does NOT see the confirm-payout button', async ({ asSenior }) => {
    await mockPayoutDetailRoutes(asSenior)
    await asSenior.goto('/finance')
    await expect(asSenior.getByTestId(`row-pay-payout-${PAYOUT_TX_ID}`)).toBeVisible()
    await expect(asSenior.getByTestId(`confirm-payout-button-${PAYOUT_TX_ID}`)).toHaveCount(0)
  })

  test('DROP does NOT see manual confirmation on the dashboard payout row', async ({ asDrop }) => {
    await mockPayoutDetailRoutes(asDrop)
    // The DROP pays from the dashboard «in progress» panel (self-scoped /transactions).
    await asDrop.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return jsonOk(r, [makePayoutTxRow({ senderId: USERS.drop.id, senderName: 'Drop User' })])
    })
    await asDrop.goto('/')
    await asDrop.getByTestId(`drop-pay-payout-${PAYOUT_TX_ID}`).click()
    const dialog = asDrop.getByTestId('payout-detail-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('payout-detail-manual-section')).not.toBeVisible()
    await expect(asDrop.getByTestId(`confirm-payout-button-${PAYOUT_TX_ID}`)).toHaveCount(0)
  })

  // One test per role, each requesting ONLY its own fixture. Requesting two role fixtures in a
  // single test instantiates both on the same `page` and the last `mockAuthAs` wins — a combined
  // JUNIOR/HR loop here ran as HR and asserted nothing about JUNIOR.
  async function expectNoConfirmPayoutButton(page: Page) {
    await mockPayoutDetailRoutes(page)
    await page.goto('/finance')
    await expect(page.getByTestId('finance-page')).toBeVisible()
    await expect(page.getByTestId(`confirm-payout-button-${PAYOUT_TX_ID}`)).toHaveCount(0)
  }

  test('JUNIOR does NOT see the confirm-payout button', async ({ asJunior }) => {
    await expectNoConfirmPayoutButton(asJunior)
  })

  test('HR does NOT see the confirm-payout button', async ({ asHr }) => {
    await expectNoConfirmPayoutButton(asHr)
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

    await asAdmin.goto('/finance')
    await asAdmin.getByTestId('finance-create-transaction-button').click()

    const dialog = asAdmin.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('create-transaction-type-dividend')).toBeVisible()
  })

  test('SENIOR does NOT see DIVIDEND option in CreateTransactionDialog', async ({ asSenior }) => {
    await mockFinanceListRoutes(asSenior)

    await asSenior.goto('/finance')
    await asSenior.getByTestId('finance-create-transaction-button').click()

    const dialog = asSenior.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('create-transaction-type-dividend')).not.toBeVisible()
  })

  test('ACCOUNTANT does NOT see DIVIDEND option in CreateTransactionDialog', async ({
    asAccountant,
  }) => {
    await mockFinanceListRoutes(asAccountant)

    await asAccountant.goto('/finance')
    await asAccountant.getByTestId('finance-create-transaction-button').click()

    const dialog = asAccountant.getByTestId('create-transaction-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('create-transaction-type-dividend')).not.toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// AC (deferred #3) — ConfirmPayoutDialog: click-through for COMPANY_ACCOUNT method
// ---------------------------------------------------------------------------
//
// Test-IDs in ConfirmPayoutDialog:
//   confirm-payout-dialog          — dialog root
//   confirm-payout-method-crypto   — CRYPTO radio button
//   confirm-payout-method-cash     — CASH radio button
//   confirm-payout-method-company_account — COMPANY_ACCOUNT radio button
//   confirm-payout-company-account-hint   — hint visible only when COMPANY_ACCOUNT
//   confirm-payout-admin-select    — recipient selector (hidden for COMPANY_ACCOUNT)
//   confirm-payout-submit          — submit button
//
// TransactionRow renders confirm-payout-button-${tx.id} when:
//   (isAdmin || isAccountant) && tx.type === 'PAYOUT' && tx.status === 'PENDING_PAYMENT'
//
// API routing (ConfirmPayoutDialog.tsx):
//   COMPANY_ACCOUNT → POST /api/payout-requests/:payoutRequestId/manual-confirm
//   CRYPTO / CASH   → POST /api/transactions/:txId/confirm-payout

const CONFIRM_TX_ID = 'confirm-tx-payout-1'
const CONFIRM_PR_ID = 'confirm-pr-1'

function makeConfirmPayoutTx(overrides: object = {}) {
  return {
    id: CONFIRM_TX_ID,
    type: 'PAYOUT',
    status: 'PENDING_PAYMENT',
    payoutRequestId: CONFIRM_PR_ID,
    amount: '100',
    currency: 'USDT',
    senderId: USERS.senior.id,
    senderName: USERS.senior.displayName,
    senderLabel: null,
    receiverId: null,
    receiverName: null,
    receiverLabel: 'CheekyCheeseIT',
    projectId: null,
    projectName: null,
    salaryMonth: null,
    txDate: null,
    txHash: null,
    rejectionReason: null,
    seniorSharePercent: null,
    seniorSharePercentSource: null,
    createdAt: '2026-06-01T10:00:00.000Z',
    ...overrides,
  }
}

/**
 * Register finance page routes with a single PAYOUT/PENDING_PAYMENT tx so
 * confirm-payout-button renders for ADMIN/ACCOUNTANT.
 * Must be called AFTER mockAuthAs() (LIFO ordering).
 */
async function mockConfirmPayoutPageRoutes(page: Page, tx = makeConfirmPayoutTx()) {
  // Transactions list — one PAYOUT row in PENDING_PAYMENT
  await page.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return jsonOk(r, [tx])
  })
  // Payout requests — empty list (finance page may fetch)
  await page.route(new RegExp(`${API_RE}/payout-requests(\\?.*)?$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return jsonOk(r, [])
  })
}

test.describe('Deferred #3 — ConfirmPayoutDialog: COMPANY_ACCOUNT click-through', () => {
  test('ADMIN: COMPANY_ACCOUNT method — admin-select hidden, hint visible, submits to manual-confirm', async ({
    asAdmin,
  }) => {
    // Intercept the manual-confirm call to verify correct endpoint + payload
    let manualConfirmCalled = false
    let capturedPayoutRequestId: string | null = null

    await asAdmin.route(new RegExp(`${API_RE}/payout-requests/([^/?]+)/manual-confirm$`), (r) => {
      if (r.request().method() !== 'POST') return r.fallback()
      // `?? null` keeps the declared `string | null` honest — `noUncheckedIndexedAccess`
      // types the indexed read as possibly-undefined. A missing segment is not
      // silently tolerated: line ~438 asserts this equals CONFIRM_PR_ID, so null
      // fails the test loudly. (task-lint-teeth)
      capturedPayoutRequestId = r.request().url().split('/').slice(-2, -1)[0] ?? null
      manualConfirmCalled = true
      return jsonOk(r, {
        id: capturedPayoutRequestId,
        status: 'PAID',
        method: 'COMPANY_ACCOUNT',
        txHash: null,
      })
    })

    await mockConfirmPayoutPageRoutes(asAdmin)
    await asAdmin.goto('/finance')
    await expect(asAdmin.getByTestId('finance-page')).toBeVisible()

    // Click «Подтвердить оплату» on the PAYOUT row
    await asAdmin.getByTestId(`confirm-payout-button-${CONFIRM_TX_ID}`).click()

    const dialog = asAdmin.getByTestId('confirm-payout-dialog')
    await expect(dialog).toBeVisible()

    // Select COMPANY_ACCOUNT method
    await dialog.getByTestId('confirm-payout-method-company_account').click()

    // Hint must be visible
    await expect(dialog.getByTestId('confirm-payout-company-account-hint')).toBeVisible()

    // Admin recipient selector must be HIDDEN (no individual admin credited)
    await expect(dialog.getByTestId('confirm-payout-admin-select')).not.toBeVisible()

    // Submit is enabled (payoutRequestId is set, no other required fields)
    await expect(dialog.getByTestId('confirm-payout-submit')).not.toBeDisabled()

    // Click submit
    await dialog.getByTestId('confirm-payout-submit').click()

    // Dialog closes on success
    await expect(dialog).not.toBeVisible()

    // Verify the correct endpoint was called with the correct payoutRequestId
    expect(manualConfirmCalled).toBe(true)
    expect(capturedPayoutRequestId).toBe(CONFIRM_PR_ID)
  })

  test('ACCOUNTANT: COMPANY_ACCOUNT method — same UX as ADMIN (hint visible, admin-select hidden)', async ({
    asAccountant,
  }) => {
    let manualConfirmCalled = false

    await asAccountant.route(
      new RegExp(`${API_RE}/payout-requests/([^/?]+)/manual-confirm$`),
      (r) => {
        if (r.request().method() !== 'POST') return r.fallback()
        manualConfirmCalled = true
        return jsonOk(r, {
          id: CONFIRM_PR_ID,
          status: 'PAID',
          method: 'COMPANY_ACCOUNT',
          txHash: null,
        })
      },
    )

    await mockConfirmPayoutPageRoutes(asAccountant)
    await asAccountant.goto('/finance')
    await expect(asAccountant.getByTestId('finance-page')).toBeVisible()

    await asAccountant.getByTestId(`confirm-payout-button-${CONFIRM_TX_ID}`).click()

    const dialog = asAccountant.getByTestId('confirm-payout-dialog')
    await expect(dialog).toBeVisible()

    await dialog.getByTestId('confirm-payout-method-company_account').click()
    await expect(dialog.getByTestId('confirm-payout-company-account-hint')).toBeVisible()
    await expect(dialog.getByTestId('confirm-payout-admin-select')).not.toBeVisible()
    await expect(dialog.getByTestId('confirm-payout-submit')).not.toBeDisabled()

    await dialog.getByTestId('confirm-payout-submit').click()
    await expect(dialog).not.toBeVisible()
    expect(manualConfirmCalled).toBe(true)
  })

  test('ADMIN: default CRYPTO method — admin-select IS visible, no company-account hint', async ({
    asAdmin,
  }) => {
    await mockConfirmPayoutPageRoutes(asAdmin)
    await asAdmin.goto('/finance')
    await expect(asAdmin.getByTestId('finance-page')).toBeVisible()

    await asAdmin.getByTestId(`confirm-payout-button-${CONFIRM_TX_ID}`).click()

    const dialog = asAdmin.getByTestId('confirm-payout-dialog')
    await expect(dialog).toBeVisible()

    // Default method is CRYPTO — admin-select must be shown
    await expect(dialog.getByTestId('confirm-payout-admin-select')).toBeVisible()
    // No company account hint in CRYPTO mode
    await expect(dialog.getByTestId('confirm-payout-company-account-hint')).not.toBeVisible()
  })

  test('ADMIN: CASH method — admin-select IS visible (admin required), no company-account hint', async ({
    asAdmin,
  }) => {
    await mockConfirmPayoutPageRoutes(asAdmin)
    await asAdmin.goto('/finance')
    await expect(asAdmin.getByTestId('finance-page')).toBeVisible()

    await asAdmin.getByTestId(`confirm-payout-button-${CONFIRM_TX_ID}`).click()

    const dialog = asAdmin.getByTestId('confirm-payout-dialog')
    await expect(dialog).toBeVisible()

    await dialog.getByTestId('confirm-payout-method-cash').click()

    // CASH: admin selector visible (someone received cash)
    await expect(dialog.getByTestId('confirm-payout-admin-select')).toBeVisible()
    // No company account hint in CASH mode
    await expect(dialog.getByTestId('confirm-payout-company-account-hint')).not.toBeVisible()
  })

  test('ADMIN: CRYPTO method submit — routes to /transactions/:id/confirm-payout (NOT manual-confirm)', async ({
    asAdmin,
  }) => {
    let legacyConfirmCalled = false
    let manualConfirmCalled = false

    // Legacy confirm-payout endpoint (CRYPTO/CASH)
    await asAdmin.route(new RegExp(`${API_RE}/transactions/([^/?]+)/confirm-payout$`), (r) => {
      if (r.request().method() !== 'POST') return r.fallback()
      legacyConfirmCalled = true
      return jsonOk(r, { id: CONFIRM_TX_ID, status: 'PAID' })
    })
    // manual-confirm must NOT be called for CRYPTO
    await asAdmin.route(new RegExp(`${API_RE}/payout-requests/([^/?]+)/manual-confirm$`), (r) => {
      if (r.request().method() !== 'POST') return r.fallback()
      manualConfirmCalled = true
      return jsonOk(r, { id: CONFIRM_PR_ID, status: 'PAID', method: 'CRYPTO', txHash: null })
    })

    await mockConfirmPayoutPageRoutes(asAdmin)
    await asAdmin.goto('/finance')
    await expect(asAdmin.getByTestId('finance-page')).toBeVisible()

    await asAdmin.getByTestId(`confirm-payout-button-${CONFIRM_TX_ID}`).click()
    const dialog = asAdmin.getByTestId('confirm-payout-dialog')
    await expect(dialog).toBeVisible()

    // CRYPTO is default — fill required fields: admin + txHash
    // Open admin selector
    await dialog.getByTestId('confirm-payout-admin-select').click()
    const listbox = asAdmin.locator('[role="listbox"]')
    await expect(listbox).toBeVisible()
    await listbox.locator('[role="option"]').first().click()

    // Fill txHash (≥10 chars required for CRYPTO)
    await dialog.getByTestId('confirm-payout-tx-hash').fill('0xdeadbeef1234567890')
    await expect(dialog.getByTestId('confirm-payout-submit')).not.toBeDisabled()

    await dialog.getByTestId('confirm-payout-submit').click()
    await expect(dialog).not.toBeVisible()

    // Verify correct API routing
    expect(legacyConfirmCalled).toBe(true)
    expect(manualConfirmCalled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC5 — Company balance KPI on /stats
// ---------------------------------------------------------------------------

test.describe('AC5 — Company balance KPI on /stats', () => {
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
    // «Контроль приходів» section of /stats (ADMIN + ACCOUNTANT): empty-but-valid overview.
    // Unmocked it falls through to the real API, 401s and bounces the page to /login.
    await page.route(new RegExp(`${API_RE}/finance/income-compliance(\\?.*)?$`), (r) =>
      jsonOk(r, {
        month: '2026-06',
        totals: {
          expectedProjects: 0,
          submittedProjects: 0,
          laggingReceivers: 0,
          completeReceivers: 0,
          pendingProjects: 0,
          accruedProjects: 0,
        },
        receivers: [],
      }),
    )
    // Full FinanceSummaryDto shape (the fixture default summary predates
    // `adminBalances`). Owner decision 2026-10-12: ADMIN and ACCOUNTANT both see
    // the partner (admin) balances next to the company balance.
    await page.route(new RegExp(`${API_RE}/finance/summary(\\?.*)?$`), (r) =>
      jsonOk(r, {
        totalIncome: 10000,
        totalExpenses: 2000,
        totalSalaries: 3000,
        netBalance: 5000,
        adminBalances: [
          { userId: 'admin-1', displayName: 'Admin One', balance: 4000 },
          { userId: 'admin-2', displayName: 'Admin Two', balance: 1000 },
        ],
        dropBalances: [],
        monthly: [{ month: '2026-06', income: 6000, expenses: 1200, salaries: 1800, profit: 3000 }],
      }),
    )
  }

  test('ADMIN sees company balance KPI on /stats', async ({ asAdmin }) => {
    await mockStatsRoutes(asAdmin)

    await asAdmin.goto('/stats')

    await expect(asAdmin.getByTestId('stats-company-account-balance')).toBeVisible()
    // Balance 12345.67 — any locale format (non-breaking space / comma / dot separators)
    await expect(asAdmin.getByTestId('stats-company-account-balance')).toContainText(/12[\s,.]?345/)
  })

  test('ACCOUNTANT sees company balance KPI on /stats', async ({ asAccountant }) => {
    await mockStatsRoutes(asAccountant)

    await asAccountant.goto('/stats')

    await expect(asAccountant.getByTestId('stats-company-account-balance')).toBeVisible()
    await expect(asAccountant.getByTestId('stats-company-account-balance')).toContainText(
      /12[\s,.]?345/,
    )
  })

  async function expectCompanyAndPartnerBalances(page: Page) {
    await mockStatsRoutes(page)

    await page.goto('/stats')

    const card = page.getByTestId('stats-company-partners-card')
    await expect(card).toBeVisible()
    await expect(card.getByTestId('stats-company-account-balance')).toContainText(/12[\s,.]?345/)
    const partners = card.getByTestId('stats-partner-balances')
    await expect(partners).toContainText('Admin One')
    await expect(partners).toContainText('Admin Two')
  }

  test('ADMIN sees company + partner balances card on /stats', async ({ asAdmin }) => {
    await expectCompanyAndPartnerBalances(asAdmin)
  })

  test('ACCOUNTANT sees company + partner balances card on /stats', async ({ asAccountant }) => {
    await expectCompanyAndPartnerBalances(asAccountant)
  })

  test('JUNIOR does NOT see the company + partner balances card', async ({ asJunior }) => {
    await mockStatsRoutes(asJunior)

    await asJunior.goto('/stats')

    await expect(asJunior.getByTestId('stats-company-partners-card')).toHaveCount(0)
    await expect(asJunior.getByTestId('stats-partner-balances')).toHaveCount(0)
  })
})
