/**
 * No-Store Exclusion Tests — AC12
 *
 * Verifies the cacheWillUpdate plugin in vite.config.ts that returns null
 * for responses with Cache-Control: no-store, preventing Workbox from
 * caching sensitive PDF endpoints.
 *
 * Background (from vite.config.ts comment):
 *   "security-MED-1: уважаем Cache-Control: no-store от бэкенда.
 *   Workbox по умолчанию игнорирует no-store и кеширует ответ.
 *   Это критично для PDF-эндпоинтов (employee-contracts, signed-contracts,
 *   onboarding-contract) — приватные трудовые договоры не должны попадать
 *   в api-cache даже временно."
 *
 * Endpoints with Cache-Control: no-store, private:
 *   - GET /api/onboarding/contract/pdf
 *   - GET /api/employees/:id/contract/pdf
 *   - GET /api/signed-contracts/:id/pdf  (inferred from pattern)
 *
 * Test strategy:
 * We use page.route to simulate the PDF endpoint returning a no-store
 * response. The SW intercepts the real network request (via preview proxy),
 * calls cacheWillUpdate, receives null, and skips caching.
 *
 * We then verify the URL is NOT present in api-cache.
 *
 * Note: We cannot test against the real PDF endpoint in all environments
 * (requires onboarding to be completed, specific user state), so we use
 * page.evaluate to make a fetch() call and observe the SW behavior via
 * cache inspection.
 */
import { test, expect } from '@playwright/test'
import {
  clearSWAndCaches,
  navigateWithSWReady,
  isCached,
  getCacheEntries,
  loginViaApi,
  SEED_ADMIN_EMAIL,
  CACHE_NAMES,
} from './helpers'

test.describe('No-Store exclusion from api-cache — AC12', () => {
  test.beforeEach(async ({ page }) => {
    await clearSWAndCaches(page)
  })

  test.afterEach(async ({ page }) => {
    await clearSWAndCaches(page)
  })

  // ── AC12: Primary test via fetch() + cache inspection ────────────────────
  test('AC12: PDF endpoint with no-store is NOT cached in api-cache', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    // Double goto: SW must be active controller to intercept the PDF fetch.
    await navigateWithSWReady(page, '/crm')

    // Verify api-cache is populated (proves SW is caching normal endpoints).
    await expect
      .poll(
        async () => {
          const entries = await getCacheEntries(page, CACHE_NAMES.api)
          return entries.length > 0
        },
        {
          message: 'Expected api-cache to be populated with regular endpoints first',
          timeout: 15_000,
          intervals: [500, 1000, 2000],
        },
      )
      .toBeTruthy()

    // Use page.evaluate + fetch() to issue a request to the onboarding PDF
    // endpoint. The SW intercepts this fetch() call (same as XHR) and applies
    // cacheWillUpdate. Since the response has Cache-Control: no-store,
    // cacheWillUpdate returns null → Workbox skips caching.
    //
    // The fetch will return 401/403/404 in most states (user may not have an
    // onboarding contract), but the response headers (no-store) are still
    // set before authorization checks in the NestJS controller. Actually,
    // authorization happens BEFORE the handler, so we may get a 403.
    // But the SW still intercepts the request and calls cacheWillUpdate.
    // If the response is 403 (not in cacheableResponse.statuses: [200]),
    // cacheableResponse plugin already blocks caching — but cacheWillUpdate
    // is an extra guard for 200 responses with no-store.
    //
    // To properly test this, we need a 200 response with no-store.
    // We intercept the PDF path with page.route to return a fake PDF with
    // Cache-Control: no-store, simulating the real backend behavior.
    const PDF_PATH = '/api/onboarding/contract/pdf'

    // Set up the fake PDF response with no-store header.
    // This intercepts via page.route AFTER the SW; the SW passes the response
    // back to the page. But wait — with serviceWorkers: 'allow', the SW
    // intercepts fetch events. page.route intercepts at the browser/network level.
    //
    // The order is: SW fetch event → (if SW falls through to network) →
    // page.route intercepts. For NetworkFirst, SW fetches from network first,
    // so page.route fulfills the "network" response. The SW then calls
    // cacheWillUpdate on this response.
    await page.route(`**${PDF_PATH}`, (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: Buffer.from('%PDF-1.4 test'), // minimal fake PDF
        headers: {
          'Cache-Control': 'no-store, private',
          'Content-Disposition': 'inline; filename="contract.pdf"',
        },
      })
    })

    // Issue the request via page.evaluate fetch() — this goes through the SW.
    await page.evaluate(async (path: string) => {
      try {
        await fetch(path, { credentials: 'include' })
      } catch {
        // Network errors are OK — we only care about cache state.
      }
    }, PDF_PATH)

    // Wait briefly to allow the SW to process the response
    // (cacheWillUpdate is called synchronously during the SW fetch event).
    // Use expect.poll to avoid waitForTimeout.
    let checkCount = 0
    await expect
      .poll(
        async () => {
          checkCount++
          // After a few checks, the SW has had time to process.
          return checkCount >= 3
        },
        { timeout: 3_000, intervals: [500, 500, 500] },
      )
      .toBeTruthy()

    // Verify the PDF URL is NOT in api-cache.
    const cached = await isCached(page, PDF_PATH, CACHE_NAMES.api)
    expect(
      cached,
      `AC12: PDF endpoint with no-store should NOT be in api-cache. ` +
        `Found in cache entries: ${JSON.stringify(await getCacheEntries(page, CACHE_NAMES.api))}`,
    ).toBe(false)

    // Also check that regular endpoints ARE in cache (control group — proves
    // the SW is active and caching works for normal responses).
    const hasRegularEntries = (await getCacheEntries(page, CACHE_NAMES.api)).some(
      (url) => !url.includes(PDF_PATH),
    )
    expect(
      hasRegularEntries,
      'Expected api-cache to contain non-PDF endpoints (control group)',
    ).toBe(true)
  })

  // ── AC12: Verify employee-contracts PDF path also excluded ───────────────
  test('AC12: employee contracts PDF (no-store) not cached in api-cache', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await navigateWithSWReady(page, '/crm')

    // Wait for api-cache to be populated with regular entries.
    await expect
      .poll(
        async () => {
          const entries = await getCacheEntries(page, CACHE_NAMES.api)
          return entries.length > 0
        },
        { timeout: 20_000, intervals: [500, 1000, 2000] },
      )
      .toBeTruthy()

    const EMPLOYEE_PDF_PATH = '/api/employees/some-id/contract/pdf'

    // Route intercept: simulate the real endpoint that returns no-store.
    await page.route(`**${EMPLOYEE_PDF_PATH}`, (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/pdf',
        body: Buffer.from('%PDF-1.4 employee-contract-test'),
        headers: {
          'Cache-Control': 'no-store, private',
          'Content-Disposition': 'inline; filename="employee-contract.pdf"',
        },
      })
    })

    // Issue the request through the SW.
    await page.evaluate(async (path: string) => {
      try {
        await fetch(path, { credentials: 'include' })
      } catch {
        // Ignore errors — only care about cache state.
      }
    }, EMPLOYEE_PDF_PATH)

    // Stable wait via polling.
    let checkCount = 0
    await expect
      .poll(
        async () => {
          checkCount++
          return checkCount >= 3
        },
        { timeout: 3_000, intervals: [500, 500, 500] },
      )
      .toBeTruthy()

    const cached = await isCached(page, EMPLOYEE_PDF_PATH, CACHE_NAMES.api)
    expect(cached, `AC12: Employee contract PDF with no-store should NOT be in api-cache.`).toBe(
      false,
    )
  })

  // ── AC12: Verify normal JSON endpoint IS cached (contrast test) ──────────
  test('AC12 contrast: normal /api/users IS cached (no-store guard only blocks no-store)', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await navigateWithSWReady(page, '/crm/team')

    // /api/users returns 200 without no-store — should be cached.
    await expect
      .poll(() => isCached(page, '/api/', CACHE_NAMES.api), {
        message:
          'Expected at least one /api/ endpoint in api-cache (contrast: cacheWillUpdate allows normal responses)',
        timeout: 20_000,
        intervals: [500, 1000, 2000],
      })
      .toBeTruthy()
  })
})
