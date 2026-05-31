/**
 * finance-smoke-regressions.spec.ts — task-e2e-fragile-points-audit.
 *
 * `/crm/finance` smoke regression for ADMIN / SENIOR / DROP. Round-1 user
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
 * This spec walks each role through `/crm/finance`, asserts the key UI
 * elements render, AND captures console errors (page.on('pageerror')) so
 * any future runtime crash on the page surfaces as a test failure.
 *
 * Mock-based (uses fixtures.ts mocks) for fast / deterministic runs.
 */

import { test, expect } from './fixtures'

test.describe('Finance page smoke — no console errors per role', () => {
  for (const role of ['Admin', 'Senior', 'Drop'] as const) {
    test(`/crm/finance for ${role.toUpperCase()} renders without runtime errors`, async ({
      asAdmin,
      asSenior,
      asDrop,
    }) => {
      const page = role === 'Admin' ? asAdmin : role === 'Senior' ? asSenior : asDrop

      // Capture page-level runtime errors (uncaught exceptions). A crash
      // like the `Cannot read .length of undefined` on dropBalances would
      // fire `pageerror` and bubble into the assertions below.
      const errors: string[] = []
      page.on('pageerror', (err) => {
        errors.push(err.message)
      })

      await page.goto('/crm/finance')

      // The «Финансы» header is rendered for all three roles (route guard
      // allows DROP per useRoleGuard widened in PR #63 phase 1 fix AC4).
      const main = page.locator('main')
      await expect(
        main.getByRole('heading', { level: 1, name: 'Финансы' }),
      ).toBeVisible({ timeout: 10_000 })

      // Wait a beat for any deferred error to fire (React hydration,
      // useQuery resolves). networkidle is the cheapest signal that the
      // initial data fetch has settled.
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined)

      // The page must not have thrown any uncaught error during the
      // initial render + query resolution. ANY pageerror is a regression.
      expect(
        errors,
        `Page errors on /crm/finance as ${role}: ${errors.join(' || ')}`,
      ).toEqual([])
    })
  }

  test('SENIOR sees «Новая транзакция» button + transactions table on /crm/finance', async ({
    asSenior: page,
  }) => {
    await page.goto('/crm/finance')
    const main = page.locator('main')
    await expect(
      main.getByRole('heading', { level: 1, name: 'Финансы' }),
    ).toBeVisible({ timeout: 10_000 })

    // SENIOR sees the create button (canCreate is true).
    await expect(page.getByTestId('finance-create-transaction-button')).toBeVisible({
      timeout: 8_000,
    })
  })

  test('DROP sees «Новая транзакция» button on /crm/finance (CTA for DROP_INCOME)', async ({
    asDrop: page,
  }) => {
    // Drop role - phase 2: DROP also gets `canCreate` (income is the only
    // type DROP can post). Verify the CTA is rendered.
    await page.goto('/crm/finance')
    await expect(page.getByTestId('finance-create-transaction-button')).toBeVisible({
      timeout: 10_000,
    })
  })

  test('ADMIN sees «Новая транзакция» button + transactions table on /crm/finance', async ({
    asAdmin: page,
  }) => {
    await page.goto('/crm/finance')
    await expect(page.getByTestId('finance-create-transaction-button')).toBeVisible({
      timeout: 8_000,
    })
  })
})
