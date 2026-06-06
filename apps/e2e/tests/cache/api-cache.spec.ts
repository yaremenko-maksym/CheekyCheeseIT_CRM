/**
 * API Cache Tests — AC6, AC7, AC8
 *
 * Verifies the NetworkFirst strategy for GET /api/* requests (api-cache):
 * - AC6: GET /api/* responses are added to api-cache
 * - AC7: Online: fresh response served (NetworkFirst — network wins over cache)
 * - AC8: Offline: stale data served from api-cache when network unavailable
 *
 * These tests require a real NestJS backend at localhost:3001 because:
 * 1. The SW only intercepts real network requests, not page.route mocks
 * 2. Workbox NetworkFirst only caches real HTTP 200 responses
 * 3. The proxy (vite preview → localhost:3001) must be operational
 *
 * URL path in preview mode: browser → localhost:3000/api/* → proxy → localhost:3001/api/*
 * SW sees: url.pathname.startsWith('/api/') — matches the proxied path at :3000.
 */
import { test, expect } from '@playwright/test'
import {
  clearSWAndCaches,
  waitForSWActive,
  getCacheEntries,
  isCached,
  goOffline,
  goOnline,
  loginViaApi,
  SEED_ADMIN_EMAIL,
  CACHE_NAMES,
} from './helpers'

test.describe('API Cache (NetworkFirst) — AC6, AC7, AC8', () => {
  test.beforeEach(async ({ page }) => {
    await clearSWAndCaches(page)
  })

  test.afterEach(async ({ page }) => {
    await goOnline(page)
    await clearSWAndCaches(page)
  })

  // ── AC6 ─────────────────────────────────────────────────────────────────
  test('AC6: GET /api/users is added to api-cache after page navigation', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)

    // Navigate to a CRM page that triggers GET /api/users.
    await page.goto('/crm/team')
    await waitForSWActive(page)

    // Wait for the page to finish loading API data.
    await page.waitForLoadState('domcontentloaded')

    // Poll until /api/users (or any /api/* endpoint) appears in api-cache.
    // The SW intercepts the proxied request at localhost:3000/api/* and caches
    // the response asynchronously after the network response is received.
    await expect
      .poll(
        async () => {
          const entries = await getCacheEntries(page, CACHE_NAMES.api)
          return entries.length > 0
        },
        {
          message: 'Expected at least one /api/* URL to be cached in api-cache',
          timeout: 20_000,
          intervals: [500, 500, 1000, 2000, 3000],
        },
      )
      .toBeTruthy()

    // Specifically verify /api/users is in the cache (team page fetches it).
    const cachedUrls = await getCacheEntries(page, CACHE_NAMES.api)
    const hasUsersOrTeams = cachedUrls.some(
      (url) => url.includes('/api/users') || url.includes('/api/teams'),
    )
    expect(
      hasUsersOrTeams,
      `Expected /api/users or /api/teams in api-cache. Got: ${JSON.stringify(cachedUrls)}`,
    ).toBe(true)
  })

  // ── AC6 extended: auth/me is cached ─────────────────────────────────────
  test('AC6: GET /api/auth/me is cached in api-cache', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/crm/dashboard')
    await waitForSWActive(page)
    await page.waitForLoadState('domcontentloaded')

    await expect
      .poll(
        () => isCached(page, '/api/auth/me', CACHE_NAMES.api),
        {
          message: 'Expected /api/auth/me to be cached in api-cache',
          timeout: 20_000,
          intervals: [500, 500, 1000, 2000],
        },
      )
      .toBeTruthy()
  })

  // ── AC7 ─────────────────────────────────────────────────────────────────
  test('AC7: online — NetworkFirst serves fresh data (not stale cache)', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/crm/dashboard')
    await waitForSWActive(page)
    await page.waitForLoadState('domcontentloaded')

    // Wait for cache to be populated.
    await expect
      .poll(
        async () => {
          const entries = await getCacheEntries(page, CACHE_NAMES.api)
          return entries.length > 0
        },
        { timeout: 20_000, intervals: [500, 1000, 2000] },
      )
      .toBeTruthy()

    // With NetworkFirst: online requests go to the network first (not cache).
    // Verify by checking response headers: a cached response would have
    // SW-specific characteristics. We check that the auth/me response is NOT
    // fromServiceWorker on the first fresh fetch (it may be in cache, but
    // NetworkFirst tries network first, so it goes to network).
    //
    // We listen for the response event and check fromServiceWorker.
    let authMeFromSW: boolean | null = null
    page.on('response', (response) => {
      if (response.url().includes('/api/auth/me') && authMeFromSW === null) {
        authMeFromSW = response.fromServiceWorker()
      }
    })

    // Trigger a fresh navigation to force new API calls.
    await page.goto('/crm/team')
    await waitForSWActive(page)
    await page.waitForLoadState('domcontentloaded')

    // Wait for the response event to be captured.
    await expect
      .poll(
        () => authMeFromSW !== null,
        {
          message: 'Expected to capture /api/auth/me response event',
          timeout: 10_000,
          intervals: [300, 500, 1000],
        },
      )
      .toBeTruthy()

    // NetworkFirst: online response comes from network (not SW cache).
    // fromServiceWorker() returns true only for cache-served responses.
    expect(
      authMeFromSW,
      'NetworkFirst: online response should come from network, not SW cache',
    ).toBe(false)
  })

  // ── AC8 ─────────────────────────────────────────────────────────────────
  test('AC8: offline — stale API data served from api-cache', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)

    // First: populate the cache while online.
    await page.goto('/crm/dashboard')
    await waitForSWActive(page)
    await page.waitForLoadState('domcontentloaded')

    // Wait for api-cache to be populated.
    await expect
      .poll(
        async () => {
          const entries = await getCacheEntries(page, CACHE_NAMES.api)
          return entries.some((url) => url.includes('/api/auth/me'))
        },
        {
          message: 'Expected /api/auth/me in api-cache before going offline',
          timeout: 20_000,
          intervals: [500, 1000, 2000],
        },
      )
      .toBeTruthy()

    // Go offline — this blocks all real network requests.
    await goOffline(page)

    // Track which responses are served from the SW (cache).
    let cacheHit = false
    page.on('response', (response) => {
      if (response.url().includes('/api/') && response.fromServiceWorker()) {
        cacheHit = true
      }
    })

    // Navigate to a page while offline — the SW should serve cached /api/* responses.
    // The page itself (index.html) is served from precache (SPA fallback).
    // API calls are served from api-cache via NetworkFirst fallback.
    await page.goto('/crm/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => {
      // Navigation may time out if the precache fallback isn't working —
      // this is acceptable; we only need the response event.
    })

    // Wait for at least one SW-served API response.
    await expect
      .poll(
        () => cacheHit,
        {
          message: 'Expected at least one /api/* response to be served from SW cache offline',
          timeout: 15_000,
          intervals: [500, 1000, 2000],
        },
      )
      .toBeTruthy()
  })
})
