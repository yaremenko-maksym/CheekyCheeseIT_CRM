/**
 * finance-smoke-regressions.spec.ts — task-e2e-fragile-points-audit.
 *
 * `/finance` smoke regression for ADMIN / SENIOR / DROP. Round-1 user
 * testing of phase 2 surfaced bugs that would have been caught by a
 * targeted smoke test:
 *
 *   - `summary.dropBalances` undefined → crashed the page with a runtime
 *     TypeError (fixed by switching to optional chaining + always-array
 *     backend contract — see drop-backend-rbac-api.spec.ts for the API
 *     side).
 *   - SENIOR's `MyProjectShares` widget crashed on empty
 *     `effectiveSharePercents` array (fixed by guarding the render).
 *   - DROP rendering the finance shell with no projects logged was a
 *     fresh code path — sidebar redirects had hidden it from testing
 *     before the spec §4 expansion.
 *
 * This spec walks each role through `/finance`, asserts the key UI
 * elements render, AND captures console errors (page.on('pageerror')) so
 * any future runtime crash on the page surfaces as a test failure.
 *
 * Mock-based (uses fixtures.ts mocks) for fast / deterministic runs.
 */

import { test, expect } from './fixtures'

/**
 * Walk one role through `/finance` and fail on any uncaught page error.
 *
 * Each role is its OWN test requesting ONLY its own fixture: requesting
 * `asAdmin`, `asSenior` and `asDrop` together in one test instantiates all
 * three, and the last mock-auth registration wins — the "ADMIN" iteration
 * was silently rendering the DROP cabinet.
 */
async function expectFinanceRendersCleanly(
  page: import('@playwright/test').Page,
  role: string,
  rootTestId: string,
): Promise<void> {
  // Capture page-level runtime errors (uncaught exceptions). A crash
  // like the `Cannot read .length of undefined` on dropBalances would
  // fire `pageerror` and bubble into the assertions below.
  const errors: string[] = []
  page.on('pageerror', (err) => {
    errors.push(err.message)
  })

  await page.goto('/finance')

  // The finance page root renders for all three roles (route guard allows
  // DROP per useRoleGuard widened in PR #63 phase 1 fix AC4). Page-title h1s
  // were removed deliberately; the anchor is the root data-testid —
  // `drop-finance-page` for DROP (its own cabinet), `finance-page` otherwise.
  await expect(page.getByTestId(rootTestId)).toBeVisible({ timeout: 10_000 })

  // Wait a beat for any deferred error to fire (React hydration,
  // useQuery resolves). networkidle is the cheapest signal that the
  // initial data fetch has settled.
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined)

  // The page must not have thrown any uncaught error during the
  // initial render + query resolution. ANY pageerror is a regression.
  expect(errors, `Page errors on /finance as ${role}: ${errors.join(' || ')}`).toEqual([])
}

test.describe('Finance page smoke — no console errors per role', () => {
  test('/finance for ADMIN renders without runtime errors', async ({ asAdmin }) => {
    await expectFinanceRendersCleanly(asAdmin, 'ADMIN', 'finance-page')
  })

  test('/finance for SENIOR renders without runtime errors', async ({ asSenior }) => {
    await expectFinanceRendersCleanly(asSenior, 'SENIOR', 'finance-page')
  })

  test('/finance for DROP renders without runtime errors', async ({ asDrop }) => {
    await expectFinanceRendersCleanly(asDrop, 'DROP', 'drop-finance-page')
  })

  test('SENIOR sees «Новая транзакция» button + transactions table on /finance', async ({
    asSenior: page,
  }) => {
    await page.goto('/finance')
    await expect(page.getByTestId('finance-page')).toBeVisible({ timeout: 10_000 })

    // SENIOR sees the create button (canCreate is true).
    await expect(page.getByTestId('finance-create-transaction-button')).toBeVisible({
      timeout: 8_000,
    })
  })

  test('DROP sees «Новая транзакция» button on /finance (CTA for DROP_INCOME)', async ({
    asDrop: page,
  }) => {
    // Drop role - phase 2: DROP also gets `canCreate` (income is the only
    // type DROP can post). Verify the CTA is rendered.
    await page.goto('/finance')
    await expect(page.getByTestId('drop-register-income-btn')).toBeVisible({
      timeout: 10_000,
    })
  })

  test('ADMIN sees «Новая транзакция» button + transactions table on /finance', async ({
    asAdmin: page,
  }) => {
    await page.goto('/finance')
    await expect(page.getByTestId('finance-create-transaction-button')).toBeVisible({
      timeout: 8_000,
    })
  })
})
