/**
 * API bypass tests — regression guard for
 * "fix(web): stop routing API requests through the service worker".
 *
 * Before that fix, `api-cache` (NetworkFirst) routed every `GET /api/*`
 * through the SW: real-device repro showed 5 concurrent API calls stalling
 * 16.7s while the SW was `activating`, and the same rule cached every 200
 * response (financials, team data, transactions — no PII opt-out) to disk
 * for up to a day, bypassing the `PERSISTED_KEY_PREFIXES` PII exclusion the
 * TanStack Query persist layer enforces elsewhere.
 *
 * This file now asserts the OPPOSITE of what it used to:
 *   - api-cache is never created, no matter how much real /api/* traffic
 *     the SW sees.
 *   - Online: /api/* responses are never `fromServiceWorker()` — they go
 *     straight to network, unintercepted.
 *   - Offline: /api/* requests FAIL outright — there is no cache to fall
 *     back to (this is the intended, safer behaviour: no stale financial
 *     data, no silent success on stale/wrong numbers while offline).
 *
 * These tests require a real NestJS backend at localhost:3001 (same
 * requirement as before — see helpers.ts).
 */
import { test, expect } from '@playwright/test'
import {
  clearSWAndCaches,
  navigateWithSWReady,
  loginViaApi,
  SEED_ADMIN_EMAIL,
  CACHE_NAMES,
  goOffline,
  goOnline,
} from './helpers'

test.describe('API requests bypass the Service Worker entirely', () => {
  test.beforeEach(async ({ page }) => {
    await clearSWAndCaches(page)
  })

  test.afterEach(async ({ page }) => {
    await goOnline(page)
    await clearSWAndCaches(page)
  })

  // ── api-cache must never exist ────────────────────────────────────────────
  test('api-cache is never created, even after real /api/* traffic on multiple pages', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)

    // Double-goto (navigateWithSWReady) + multiple page navigations: plenty
    // of real /api/* GET traffic (auth/me, exchange-rate, notifications,
    // teams, transactions, users, ...) for a regression to show up in.
    await navigateWithSWReady(page, '/')
    await page.goto('/team')
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    await page.goto('/finance')
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})

    const hasApiCache = await page.evaluate(() => caches.has('api-cache'))
    expect(
      hasApiCache,
      'api-cache must never be created — /api/* must bypass the Service Worker entirely (see pwa-runtime-caching.ts)',
    ).toBe(false)
  })

  // ── Online: responses never come from the SW ──────────────────────────────
  test('online — /api/* responses are never served fromServiceWorker (direct network)', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await navigateWithSWReady(page, '/')

    const apiResponses: { url: string; fromSW: boolean }[] = []
    page.on('response', (response) => {
      if (response.url().includes('/api/') && !response.url().includes('/api/auth/logout')) {
        apiResponses.push({ url: response.url(), fromSW: response.fromServiceWorker() })
      }
    })

    await page.goto('/team')
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})

    await expect
      .poll(() => apiResponses.length > 0, {
        message: 'Expected to capture at least one /api/* response event',
        timeout: 15_000,
        intervals: [300, 500, 1000],
      })
      .toBeTruthy()

    const anyFromSW = apiResponses.some((r) => r.fromSW)
    expect(
      anyFromSW,
      `Expected NO /api/* response to be fromServiceWorker. Got: ${JSON.stringify(apiResponses)}`,
    ).toBe(false)
  })

  // ── Offline: no stale fallback ────────────────────────────────────────────
  test('offline — /api/* requests fail outright (no stale cache fallback)', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)

    // Establish a real online session first (so this isn't just "never
    // loaded" — the SW had every opportunity to cache something if the
    // regression reappeared).
    await navigateWithSWReady(page, '/')
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})

    await goOffline(page)

    // Direct fetch to a real endpoint — offline, no SW cache to serve from.
    const result = await page.evaluate(async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' })
        return { ok: true, status: res.status }
      } catch {
        return { ok: false, status: null }
      }
    })

    expect(
      result.ok,
      `Expected the offline /api/auth/me fetch to fail (no cache fallback exists). Got: ${JSON.stringify(result)}`,
    ).toBe(false)

    // Belt-and-suspenders: api-cache must still not exist even after this
    // offline attempt (nothing should have created it as a side effect).
    const hasApiCache = await page.evaluate((name: string) => caches.has(name), CACHE_NAMES.api)
    expect(hasApiCache).toBe(false)
  })
})
