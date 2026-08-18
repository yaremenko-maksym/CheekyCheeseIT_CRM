/**
 * drop-balances-panel.spec.ts — E2E tests for the redesigned «Балансы дропов»
 * panel (feat/drop-balances-panel).
 *
 * AC coverage:
 *   1. ADMIN opens /finance → panel «Балансы дропов» is visible with
 *      the drop's displayName, share-% badge, pending badge, balance/«—»,
 *      and the «N дропов» counter in the header.
 *   2. Zero-balance state → amount shows «—» and «нет выплат» sub-label.
 *   3. Positive balance → green amount + USDT label.
 *   4. pendingCount > 0 → «N ожидают» amber badge visible.
 *   5. pendingCount = 0 → pending badge hidden.
 *   6. Empty dropBalances → panel hidden, no crash.
 *
 * Uses page.route() LIFO override on top of mockAuthAs so the finance/summary
 * response carries the new dropBalances fields (dropSharePercent, pendingCount).
 * Pattern mirrors finance-smoke-regressions.spec.ts + documents-pr3.spec.ts.
 */

import { test, expect, API_RE } from './fixtures'

const DROP_ID = 'a0000000-0000-4000-8000-000000000007'

/** Finance summary with one drop entry that has positive balance + pending */
const SUMMARY_WITH_DROP_POSITIVE = {
  totalIncome: 50000,
  totalExpenses: 12000,
  totalSalaries: 5000,
  netBalance: 33000,
  adminBalances: [],
  dropBalances: [
    {
      userId: DROP_ID,
      displayName: 'Drop User',
      balance: 1250.5,
      dropSharePercent: 7,
      pendingCount: 2,
    },
  ],
  monthly: [],
}

/** Finance summary with one drop entry that has zero balance (empty-state) */
const SUMMARY_WITH_DROP_ZERO = {
  ...SUMMARY_WITH_DROP_POSITIVE,
  dropBalances: [
    {
      userId: DROP_ID,
      displayName: 'Drop User',
      balance: 0,
      dropSharePercent: 5,
      pendingCount: 0,
    },
  ],
}

test.describe('Drop Balances Panel — redesigned', () => {
  test('ADMIN sees drop name, share-% badge, pending badge, balance, USDT label, counter', async ({
    asAdmin: page,
  }) => {
    // Override finance/summary with the new fields (LIFO — wins over fixture mock)
    await page.route(new RegExp(`${API_RE}/finance/summary(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SUMMARY_WITH_DROP_POSITIVE),
      }),
    )

    await page.goto('/finance')

    // Panel must be visible
    await expect(page.getByTestId('drop-balances-card')).toBeVisible({ timeout: 10_000 })

    // Drop name
    await expect(page.getByTestId(`drop-balance-name-${DROP_ID}`)).toHaveText('Drop User')

    // Share % badge: «7%»
    await expect(page.getByTestId(`drop-balance-share-${DROP_ID}`)).toHaveText('7%')

    // Pending badge: «2 ожидают»
    await expect(page.getByTestId(`drop-balance-pending-${DROP_ID}`)).toHaveText('2 ожидают')

    // Amount shows formatted balance (positive → not «—»)
    const amountEl = page.getByTestId(`drop-balance-amount-${DROP_ID}`)
    await expect(amountEl).not.toHaveText('—')

    // USDT label present for positive balance
    await expect(page.getByText('USDT')).toBeVisible()

    // Header counter contains «дроп» (singular for 1 drop)
    await expect(page.getByTestId('drop-balances-count')).toContainText('дроп')
  })

  test('zero-balance drop shows «—» and «нет выплат» sub-label', async ({ asAdmin: page }) => {
    await page.route(new RegExp(`${API_RE}/finance/summary(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SUMMARY_WITH_DROP_ZERO),
      }),
    )

    await page.goto('/finance')

    await expect(page.getByTestId('drop-balances-card')).toBeVisible({ timeout: 10_000 })

    // Amount must be «—»
    await expect(page.getByTestId(`drop-balance-amount-${DROP_ID}`)).toHaveText('—')

    // Sub-label «нет выплат»
    await expect(page.getByText('нет выплат')).toBeVisible()

    // USDT label must NOT be shown
    await expect(page.getByText('USDT')).not.toBeVisible()
  })

  test('pendingCount=0 hides the amber pending badge', async ({ asAdmin: page }) => {
    await page.route(new RegExp(`${API_RE}/finance/summary(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(SUMMARY_WITH_DROP_ZERO),
      }),
    )

    await page.goto('/finance')

    await expect(page.getByTestId('drop-balances-card')).toBeVisible({ timeout: 10_000 })

    // Pending badge must not be in DOM when pendingCount=0
    await expect(page.getByTestId(`drop-balance-pending-${DROP_ID}`)).not.toBeVisible()
  })

  test('panel is hidden when dropBalances is empty array — no crash', async ({ asAdmin: page }) => {
    await page.route(new RegExp(`${API_RE}/finance/summary(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totalIncome: 0,
          totalExpenses: 0,
          totalSalaries: 0,
          netBalance: 0,
          adminBalances: [],
          dropBalances: [],
          monthly: [],
        }),
      }),
    )

    // Capture runtime errors — any crash surfaces here
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto('/finance')

    // The main finance page heading must still render (no crash)
    await expect(
      page.locator('main').getByRole('heading', { level: 1, name: 'Финансы' }),
    ).toBeVisible({ timeout: 10_000 })

    // Panel must not be rendered
    await expect(page.getByTestId('drop-balances-card')).not.toBeVisible()

    // No runtime errors
    expect(errors, `Runtime errors on /finance: ${errors.join(' || ')}`).toEqual([])
  })

  test('header shows «N дропов» counter with correct count', async ({ asAdmin: page }) => {
    await page.route(new RegExp(`${API_RE}/finance/summary(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          totalIncome: 0,
          totalExpenses: 0,
          totalSalaries: 0,
          netBalance: 0,
          adminBalances: [],
          dropBalances: [
            {
              userId: DROP_ID,
              displayName: 'Drop User',
              balance: 0,
              dropSharePercent: 5,
              pendingCount: 0,
            },
            {
              userId: 'a0000000-0000-4000-8000-000000000099',
              displayName: 'Drop User 2',
              balance: 300,
              dropSharePercent: 10,
              pendingCount: 1,
            },
          ],
          monthly: [],
        }),
      }),
    )

    await page.goto('/finance')

    await expect(page.getByTestId('drop-balances-card')).toBeVisible({ timeout: 10_000 })

    // «2 дропов» for 2 entries
    await expect(page.getByTestId('drop-balances-count')).toHaveText('2 дропов')
  })
})
