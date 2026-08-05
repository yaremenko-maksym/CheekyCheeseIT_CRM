/**
 * No-Store PII endpoints — regression guard.
 *
 * Historically (before "fix(web): stop routing API requests through the
 * service worker") these PDF endpoints relied on a `cacheWillUpdate` guard
 * inside the now-deleted `api-cache` rule to stay out of the SW cache even
 * though they returned `Cache-Control: no-store`. That guard is gone
 * together with the whole `api-cache` rule — but the endpoints are now
 * PROTECTED MORE STRONGLY: nothing under `/api/*` is ever cached by the SW
 * at all, no-store or not, so there's no longer a per-endpoint guard to keep
 * in sync with the backend's headers.
 *
 * Endpoints that used to depend on this guard (privacy-critical — employment
 * contracts / signed documents):
 *   - GET /api/onboarding/contract/pdf
 *   - GET /api/employees/:id/contract/pdf
 *
 * This test keeps these two named endpoints as an explicit regression guard
 * (in case a future `runtimeCaching` rule reintroduces `/api/*` matching
 * without carrying over the no-store handling) — it directly checks NO cache
 * store at all (not just `api-cache`) ends up holding these responses.
 */
import { test, expect } from '@playwright/test'
import {
  clearSWAndCaches,
  navigateWithSWReady,
  getAllCacheNames,
  loginViaApi,
  SEED_ADMIN_EMAIL,
} from './helpers'

async function assertNeverCachedAnywhere(
  page: import('@playwright/test').Page,
  path: string,
): Promise<void> {
  await page.route(`**${path}`, (route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      body: Buffer.from('%PDF-1.4 test'),
      headers: {
        'Cache-Control': 'no-store, private',
        'Content-Disposition': 'inline; filename="contract.pdf"',
      },
    })
  })

  await page.evaluate(async (p: string) => {
    try {
      await fetch(p, { credentials: 'include' })
    } catch {
      // Network errors are fine — we only care about cache state below.
    }
  }, path)

  // Small settle window via polling (no waitForTimeout) so any async
  // cache.put() the SW might issue has a chance to land before we assert.
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

  const cacheNames = await getAllCacheNames(page)
  for (const name of cacheNames) {
    const isCachedHere = await page.evaluate(
      async ({ name, path }: { name: string; path: string }) => {
        const cache = await caches.open(name)
        const keys = await cache.keys()
        return keys.some((r) => r.url.includes(path))
      },
      { name, path },
    )
    expect(
      isCachedHere,
      `Expected ${path} to NOT be cached in '${name}'. Cache stores present: ${JSON.stringify(cacheNames)}`,
    ).toBe(false)
  }
}

test.describe('No-store PII PDF endpoints — never cached anywhere', () => {
  test.beforeEach(async ({ page }) => {
    await clearSWAndCaches(page)
  })

  test.afterEach(async ({ page }) => {
    await clearSWAndCaches(page)
  })

  test('onboarding contract PDF is never cached in any store', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await navigateWithSWReady(page, '/')
    await assertNeverCachedAnywhere(page, '/api/onboarding/contract/pdf')
  })

  test('employee contract PDF is never cached in any store', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await navigateWithSWReady(page, '/')
    await assertNeverCachedAnywhere(page, '/api/employees/some-id/contract/pdf')
  })
})
