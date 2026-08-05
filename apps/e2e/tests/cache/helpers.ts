/**
 * Cache E2E helpers — anti-flaky core.
 *
 * Design principles:
 * - NEVER waitForTimeout. All waits use waitForFunction / expect.poll / assertions.
 * - Full isolation: clearSWAndCaches must be called in beforeEach + afterEach.
 * - SW activation must be confirmed with waitForSWActive before cache assertions.
 * - Real API (loginViaApi) required for anti-stale and NetworkFirst tests.
 */
import type { Page, Response } from '@playwright/test'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Names of runtime caches created by the Workbox SW (from
 * apps/web/app/lib/pwa-runtime-caching.ts).
 *
 * `api` ('api-cache') is kept here as a NEGATIVE reference only — since
 * "fix(web): stop routing API requests through the service worker" that
 * cache name must NEVER appear in `caches.keys()`. See api-cache.spec.ts.
 */
export const CACHE_NAMES = {
  api: 'api-cache',
  media: 'media-cache',
} as const

/** Prefix used by Workbox precache — must NOT be deleted on logout. */
export const PRECACHE_PREFIX = 'workbox-precache'

/** Backend URL used by loginViaApi. */
export const REAL_API_BASE = 'http://localhost:3001'

/** Dev seed admin email (mirrors apps/api/src/database/seed.ts). */
export const SEED_ADMIN_EMAIL = 'yaremenkomaksym99@gmail.com'

/** Dev seed senior email used for cache tests that require a non-admin role. */
export const SEED_SENIOR_EMAIL = 'oleksiy.kovalenko@cheekycheese.dev'

// ---------------------------------------------------------------------------
// SW activation
// ---------------------------------------------------------------------------

/**
 * Wait until the Service Worker is fully activated and controlling the page.
 *
 * The SW lifecycle: install → waiting → activate → controlling. We need the
 * `controlling` state before asserting cache contents, because Workbox only
 * writes to runtime caches AFTER the SW intercepts the request (which only
 * happens when `navigator.serviceWorker.controller !== null`).
 *
 * Timeout: 20s — activation requires fetching the SW script, running install,
 * and potentially waiting for skipWaiting + clientsClaim. In CI this can be
 * slow on cold starts.
 */
export async function waitForSWActive(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const sw = navigator.serviceWorker
      if (!sw) return false
      // controller is set when the SW is both activated and controlling.
      return sw.controller !== null && sw.controller.state === 'activated'
    },
    { timeout: 20_000, polling: 200 },
  )
}

// ---------------------------------------------------------------------------
// Cache inspection
// ---------------------------------------------------------------------------

/**
 * Get all URL strings from a named cache store.
 *
 * Returns [] if the cache doesn't exist (not yet created by the SW).
 */
export async function getCacheEntries(page: Page, cacheName: string): Promise<string[]> {
  return page.evaluate(async (name: string) => {
    const hasCache = await caches.has(name)
    if (!hasCache) return []
    const cache = await caches.open(name)
    const keys = await cache.keys()
    return keys.map((r) => r.url)
  }, cacheName)
}

/**
 * Check if a given URL substring is present in a cache store.
 *
 * Uses `expect.poll` pattern — caller should wrap in `expect.poll` for
 * async assertions. This function itself is synchronous in return but
 * page.evaluate is always async.
 */
export async function isCached(
  page: Page,
  urlSubstring: string,
  cacheName: string = CACHE_NAMES.api,
): Promise<boolean> {
  const entries = await getCacheEntries(page, cacheName)
  return entries.some((url) => url.includes(urlSubstring))
}

/**
 * Get all cache store names currently present in the browser.
 */
export async function getAllCacheNames(page: Page): Promise<string[]> {
  return page.evaluate(() => caches.keys())
}

// ---------------------------------------------------------------------------
// Response helper
// ---------------------------------------------------------------------------

/**
 * Check whether a Playwright Response was served by the Service Worker.
 *
 * Wraps `response.fromServiceWorker()` for readability.
 */
export function isFromServiceWorker(response: Response): boolean {
  return response.fromServiceWorker()
}

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

/**
 * Fully clear SW registrations and all cache stores.
 *
 * MUST be called in beforeEach AND afterEach for all cache tests. SW
 * registrations and Cache API entries persist across test navigations within
 * the same browser context — without this cleanup, caches from test N bleed
 * into test N+1, causing flaky assertions.
 *
 * Note: This does NOT clear IndexedDB. If a future test needs IDB cleanup,
 * add indexedDB.deleteDatabase() calls here.
 */
export async function clearSWAndCaches(page: Page): Promise<void> {
  await page.evaluate(async () => {
    // 1. Unregister all service worker registrations
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((r) => r.unregister()))
    }

    // 2. Delete all cache stores (api-cache, media-cache, workbox-precache-*, etc.)
    if ('caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  })
}

// ---------------------------------------------------------------------------
// Real-API auth (mirrors loginViaApi from fixtures.ts)
// ---------------------------------------------------------------------------

/**
 * Plant a real JWT cookie for the given email via /api/auth/dev-login.
 *
 * Required for tests that hit the real backend (anti-stale, NetworkFirst).
 * The dev-login endpoint is only available in NODE_ENV !== 'production'.
 * In preview mode the API runs in development mode (or test mode) so
 * dev-login is available.
 */
export async function loginViaApi(page: Page, email: string): Promise<void> {
  const res = await page.request.post(`${REAL_API_BASE}/api/auth/dev-login`, {
    data: { email },
  })
  if (res.status() !== 200 && res.status() !== 201) {
    throw new Error(
      `cache/helpers loginViaApi failed for ${email}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
}

// ---------------------------------------------------------------------------
// SW warm-up helper
// ---------------------------------------------------------------------------

/**
 * Navigate to a CRM page and ensure the SW is actively controlling before
 * making assertions about cache state.
 *
 * Problem: after clearSWAndCaches(), the SW is unregistered. On the FIRST
 * page.goto(), the SW registers and starts the install → activate lifecycle.
 * However, the initial API requests fire before the SW becomes the active
 * controller, so they are NOT intercepted and NOT cached.
 *
 * Solution: double goto. The first goto registers the SW; waitForSWActive
 * waits until clientsClaim completes (controller !== null). The second goto
 * fires all requests while the SW is already controlling → requests are
 * intercepted and Workbox caches them.
 *
 * This is the standard Workbox integration test pattern when starting from
 * a clean (no SW) state.
 */
export async function navigateWithSWReady(page: Page, url: string): Promise<void> {
  // First navigation: register and activate the SW.
  await page.goto(url)
  await waitForSWActive(page)

  // Second navigation: requests are now intercepted by the active controller.
  await page.goto(url)
  await waitForSWActive(page)
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Network offline toggle
// ---------------------------------------------------------------------------

/**
 * Set the browser context to offline mode.
 *
 * Playwright's `page.context().setOffline(true)` blocks all network requests
 * at the browser level. The SW cache is still accessible — responses served
 * from cache do not require network.
 */
export async function goOffline(page: Page): Promise<void> {
  await page.context().setOffline(true)
}

/**
 * Restore the browser context to online mode.
 */
export async function goOnline(page: Page): Promise<void> {
  await page.context().setOffline(false)
}
