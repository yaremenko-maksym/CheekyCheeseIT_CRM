/**
 * SW Smoke Tests — AC1, AC2, AC3
 *
 * Verify the fundamental SW lifecycle: registration, activation, and that
 * (after "fix(web): stop routing API requests through the service worker")
 * api-cache is never created while the workbox precache still is.
 *
 * These tests run against vite preview (production build) because the SW is
 * disabled in dev mode (devOptions.enabled: false in vite.config.ts VitePWA).
 *
 * Prerequisites (local):
 *   pnpm --filter @crm/shared build
 *   pnpm --filter @crm/web build
 *   pnpm --filter @crm/web start   (vite preview on :3000)
 *   NestJS running on :3001 + dev seed applied
 */
import { test, expect } from '@playwright/test'
import {
  clearSWAndCaches,
  waitForSWActive,
  navigateWithSWReady,
  getAllCacheNames,
  loginViaApi,
  SEED_ADMIN_EMAIL,
  CACHE_NAMES,
  PRECACHE_PREFIX,
} from './helpers'

test.describe('SW Smoke — registration and cache creation', () => {
  test.beforeEach(async ({ page }) => {
    // Full isolation: clear any SW/caches left from a previous test or run.
    await clearSWAndCaches(page)
  })

  test.afterEach(async ({ page }) => {
    // Belt-and-suspenders cleanup — ensures no leak to the next test.
    await clearSWAndCaches(page)
  })

  // ── AC1 ─────────────────────────────────────────────────────────────────
  test('AC1: SW activates and controls the page after login', async ({ page }) => {
    // Authenticate via real API so the CRM layout mounts (not redirected to login).
    await loginViaApi(page, SEED_ADMIN_EMAIL)

    // Navigate to the CRM — this triggers SW registration.
    await page.goto('/')

    // Wait for SW to become the active controller.
    // waitForSWActive polls navigator.serviceWorker.controller !== null.
    await waitForSWActive(page)

    // Verify the SW is active and controlling.
    const swState = await page.evaluate(() => {
      const ctrl = navigator.serviceWorker.controller
      return ctrl ? ctrl.state : null
    })
    expect(swState).toBe('activated')
  })

  // ── AC2 ─────────────────────────────────────────────────────────────────
  // Regression guard for "fix(web): stop routing API requests through the
  // service worker" — api-cache must NEVER appear, no matter how much real
  // /api/* traffic the SW sees. See api-cache.spec.ts for the dedicated
  // suite; this smoke test keeps a minimal check alongside SW registration.
  test('AC2: api-cache is never created, even after real CRM navigation', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)

    // navigateWithSWReady: double goto ensures SW is active controller before
    // requests fire (see helpers.ts for full explanation).
    await navigateWithSWReady(page, '/')
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})

    const names = await getAllCacheNames(page)
    expect(
      names.some((n) => n.includes(CACHE_NAMES.api)),
      `Expected '${CACHE_NAMES.api}' to NEVER appear in caches.keys(). Got: ${JSON.stringify(names)}`,
    ).toBe(false)
  })

  // ── AC3 ─────────────────────────────────────────────────────────────────
  test('AC3: workbox precache is registered by the SW (proof the Workbox config loaded)', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    // Double goto for SW controller warm-up.
    await navigateWithSWReady(page, '/')

    // media-cache is created lazily — only when the SW intercepts a
    // cross-origin image request (request.destination === 'image' && external
    // origin). Navigate to a page that has user avatars or document thumbnails.
    await page.goto('/team')

    // Wait a moment for any image requests to be processed.
    await page.waitForLoadState('domcontentloaded')

    // The SW script is registered and active — verify the registration itself.
    const registrations = await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations()
      return regs.map((r) => ({
        scope: r.scope,
        activeState: r.active?.state ?? null,
      }))
    })

    // At minimum one SW registration should exist and be active.
    expect(registrations.length).toBeGreaterThan(0)
    const activeReg = registrations.find((r) => r.activeState === 'activated')
    expect(activeReg).toBeTruthy()

    // media-cache may not exist yet if no external images loaded — that's
    // acceptable for smoke (full media-cache test is in media-cache.spec.ts
    // with a synthetic cross-origin image). api-cache must NEVER exist (see
    // AC2 above). The one runtime artifact guaranteed to exist as soon as
    // the SW installs — regardless of what the page happened to fetch — is
    // the workbox precache store (created eagerly for static assets), so we
    // use that as proof the Workbox config actually loaded.
    const cacheNames = await getAllCacheNames(page)

    expect(
      cacheNames.some((n) => n.includes(CACHE_NAMES.api)),
      `api-cache must never exist. Got: ${JSON.stringify(cacheNames)}`,
    ).toBe(false)

    const hasPrecache = cacheNames.some((n) => n.includes(PRECACHE_PREFIX))
    expect(
      hasPrecache,
      `Expected workbox precache store to exist in ${JSON.stringify(cacheNames)}`,
    ).toBe(true)
  })

  // ── Structural: SW scope and script URL ─────────────────────────────────
  test('SW is registered with correct scope and script URL', async ({ page }) => {
    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/')
    await waitForSWActive(page)
    // Single goto is sufficient for this test (only checks registration, not cache).

    const swInfo = await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations()
      const active = regs.find((r) => r.active)
      if (!active) return null
      return {
        scope: active.scope,
        scriptURL: active.active?.scriptURL ?? null,
      }
    })

    expect(swInfo).not.toBeNull()
    // SW is scoped to the root (/) — covers all app routes.
    expect(swInfo!.scope).toContain('localhost:3000')
    // Script is the generated sw.js from vite-plugin-pwa.
    expect(swInfo!.scriptURL).toContain('sw.js')
  })
})
