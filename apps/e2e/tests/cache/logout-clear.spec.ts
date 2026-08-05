/**
 * Logout Cache Clear Tests — AC9, AC10, AC11
 *
 * Verifies that useLogout() in apps/web/app/lib/use-logout.ts correctly
 * cleans runtime SW caches on logout:
 *
 * - AC9: After logout, api-cache STILL does not exist (see "fix(web): stop
 *   routing API requests through the service worker" — it's never created
 *   in the first place now; use-logout.ts's `k.includes('api-cache')`
 *   filter is defensive dead code for any pre-fix build's leftovers, kept
 *   deliberately for defense-in-depth alongside the SW-side activate purge)
 * - AC10: After logout, media-cache is deleted from caches.keys()
 * - AC11: After logout, workbox-precache-* store SURVIVES (not deleted)
 *
 * Implementation reference (use-logout.ts):
 *   1. queryClient.clear()
 *   2. idbDel('crm-query-cache')
 *   3. caches.keys() → filter api-cache|media-cache → caches.delete(k)
 *   4. window.location.href = '/login'
 *
 * Note: We trigger logout via the UI (header dropdown → Выйти button)
 * using the real authenticated session so the actual useLogout code runs.
 * This is an integration test — it tests the real cleanup contract.
 */
import { test, expect } from '@playwright/test'
import {
  clearSWAndCaches,
  navigateWithSWReady,
  getAllCacheNames,
  loginViaApi,
  SEED_ADMIN_EMAIL,
  CACHE_NAMES,
  PRECACHE_PREFIX,
} from './helpers'

test.describe('Logout cache clear — AC9, AC10, AC11', () => {
  test.beforeEach(async ({ page }) => {
    await clearSWAndCaches(page)
  })

  test.afterEach(async ({ page }) => {
    await clearSWAndCaches(page)
  })

  /**
   * Helper: get the SW active + workbox precache created by navigating
   * through CRM pages with a real auth session. (api-cache is intentionally
   * NOT waited on here — it must never appear, see AC9 below.)
   */
  async function populateCaches(page: import('@playwright/test').Page): Promise<void> {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    // Double goto: SW must be active controller so requests are intercepted.
    await navigateWithSWReady(page, '/')

    // Wait until the workbox precache store exists — proof the SW's
    // Workbox config actually loaded (created eagerly on install,
    // regardless of what the page happened to fetch).
    await expect
      .poll(
        async () => {
          const names = await getAllCacheNames(page)
          return names.some((n) => n.includes(PRECACHE_PREFIX))
        },
        {
          message: 'Expected workbox precache store to exist before logout test',
          timeout: 25_000,
          intervals: [500, 1000, 2000, 3000],
        },
      )
      .toBeTruthy()
  }

  // ── AC9 + AC10 ───────────────────────────────────────────────────────────
  test('AC9+AC10: api-cache never exists; media-cache is deleted after logout', async ({
    page,
  }) => {
    await populateCaches(page)

    // Manually seed media-cache with a synthetic entry so AC10 is meaningful
    // even if no cross-origin images loaded during navigation.
    await page.evaluate(async () => {
      const cache = await caches.open('media-cache')
      await cache.put(
        new Request('http://localhost:9999/test-avatar.png'),
        new Response(new Uint8Array([0]).buffer, {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        }),
      )
    })

    // Verify caches before logout: media-cache populated, api-cache absent.
    const cachesBefore = await getAllCacheNames(page)
    expect(
      cachesBefore.some((n) => n.includes(CACHE_NAMES.api)),
      `AC9 precondition: api-cache must never exist, even before logout. Got: ${JSON.stringify(cachesBefore)}`,
    ).toBe(false)
    expect(
      cachesBefore.some((n) => n.includes(CACHE_NAMES.media)),
      `Expected media-cache in caches before logout. Got: ${JSON.stringify(cachesBefore)}`,
    ).toBe(true)

    // Trigger logout via the UI (header user menu → Выйти).
    // The header has data-testid="header-user-menu-trigger" on the avatar button.
    await page.locator('[data-testid="header-user-menu-trigger"]').click()

    // Click the Выйти button (data-testid="header-user-menu-logout").
    // After logout, useLogout() clears caches then redirects to /login.
    await page.locator('[data-testid="header-user-menu-logout"]').click()

    // Wait for redirect to /login (useLogout sets window.location.href = '/login').
    await page.waitForURL('**/login**', { timeout: 15_000 })

    // After the page has navigated to /login, check that api-cache and
    // media-cache are no longer in caches.keys().
    // Note: After redirect the page context changes, but caches are still
    // accessible in the new page context (same browser origin).
    await expect
      .poll(
        async () => {
          const names = await getAllCacheNames(page)
          const hasApiCache = names.some((n) => n.includes(CACHE_NAMES.api))
          const hasMediaCache = names.some((n) => n.includes(CACHE_NAMES.media))
          return !hasApiCache && !hasMediaCache
        },
        {
          message: 'Expected api-cache (still) and media-cache to be absent after logout',
          timeout: 10_000,
          intervals: [300, 500, 1000],
        },
      )
      .toBeTruthy()

    // Explicit assertions for clear test output.
    const cachesAfter = await getAllCacheNames(page)
    expect(
      cachesAfter.some((n) => n.includes(CACHE_NAMES.api)),
      `AC9: api-cache should remain absent after logout. Remaining: ${JSON.stringify(cachesAfter)}`,
    ).toBe(false)

    expect(
      cachesAfter.some((n) => n.includes(CACHE_NAMES.media)),
      `AC10: media-cache should be deleted after logout. Remaining: ${JSON.stringify(cachesAfter)}`,
    ).toBe(false)
  })

  // ── AC11 ─────────────────────────────────────────────────────────────────
  test('AC11: workbox-precache-* store survives logout', async ({ page }) => {
    await populateCaches(page)

    // Verify precache exists before logout (it should, since SW uses precacheAndRoute).
    await expect
      .poll(
        async () => {
          const names = await getAllCacheNames(page)
          return names.some((n) => n.includes(PRECACHE_PREFIX))
        },
        {
          message: 'Expected workbox-precache-* to exist after SW activation',
          timeout: 15_000,
          intervals: [500, 1000, 2000],
        },
      )
      .toBeTruthy()

    // Trigger logout.
    await page.locator('[data-testid="header-user-menu-trigger"]').click()
    await page.locator('[data-testid="header-user-menu-logout"]').click()
    await page.waitForURL('**/login**', { timeout: 15_000 })

    // After logout, workbox-precache-* must still exist (it's static assets,
    // not user data — no security reason to delete it).
    await expect
      .poll(
        async () => {
          const names = await getAllCacheNames(page)
          return names.some((n) => n.includes(PRECACHE_PREFIX))
        },
        {
          message: 'Expected workbox-precache-* to survive logout',
          timeout: 10_000,
          intervals: [300, 500, 1000],
        },
      )
      .toBeTruthy()

    const cachesAfter = await getAllCacheNames(page)
    expect(
      cachesAfter.some((n) => n.includes(PRECACHE_PREFIX)),
      `AC11: workbox-precache-* should survive logout. Got: ${JSON.stringify(cachesAfter)}`,
    ).toBe(true)
  })

  // ── Verify only runtime caches deleted (not all caches) ─────────────────
  test('Logout deletes only runtime caches, not all browser caches', async ({ page }) => {
    await populateCaches(page)

    // Plant a "third-party" cache that handleLogout should NOT touch.
    await page.evaluate(async () => {
      const cache = await caches.open('unrelated-app-cache')
      await cache.put(
        new Request('/some-app-data'),
        new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }),
      )
    })

    // Trigger logout.
    await page.locator('[data-testid="header-user-menu-trigger"]').click()
    await page.locator('[data-testid="header-user-menu-logout"]').click()
    await page.waitForURL('**/login**', { timeout: 15_000 })

    // handleLogout filters by `k.includes('api-cache') || k.includes('media-cache')`.
    // The 'unrelated-app-cache' should NOT be deleted.
    const cachesAfter = await getAllCacheNames(page)
    expect(
      cachesAfter.some((n) => n === 'unrelated-app-cache'),
      `Expected 'unrelated-app-cache' to survive logout (handleLogout only deletes runtime caches)`,
    ).toBe(true)
  })
})
