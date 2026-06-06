/**
 * Media Cache Tests — AC4, AC5
 *
 * Verifies the CacheFirst strategy for cross-origin images (media-cache):
 * - AC4: Cross-origin image served fromServiceWorker on repeat visit
 * - AC5: Offline: image loaded from cache without network error
 *
 * Strategy:
 * We use page.route to intercept a synthetic cross-origin image request
 * that the SW will cache. We mock an external image domain so the test
 * doesn't depend on real S3/MinIO being available.
 *
 * The SW's media-cache urlPattern matches:
 *   request.destination === 'image' && url.origin !== self.location.origin
 *
 * We create a scenario where the page requests an image from an "external"
 * origin. However, since we're running in preview mode (localhost:3000),
 * a request to localhost:3001 (the API) counts as a different origin.
 *
 * Actually, the SW is in the browser, so `self.location.origin` = http://localhost:3000.
 * Any image from a different origin (including localhost:3001) will be cached.
 *
 * We use a user avatar endpoint that returns image data, or we rely on the
 * real profile pages that load cross-origin images.
 *
 * For reliable testing without MinIO, we test the SW caching behavior using
 * a synthetic approach: navigate, trigger cross-origin image load via a
 * test fixture embedded in the page, then verify cache + offline behavior.
 */
import { test, expect } from '@playwright/test'
import {
  clearSWAndCaches,
  waitForSWActive,
  getCacheEntries,
  goOffline,
  goOnline,
  loginViaApi,
  SEED_ADMIN_EMAIL,
  CACHE_NAMES,
} from './helpers'

// Synthetic cross-origin image URL — served by the test's own route interceptor.
// Must look like a cross-origin URL to the SW (different origin from localhost:3000).
// We use localhost:9999 which we intercept with page.route.
const SYNTHETIC_IMAGE_ORIGIN = 'http://localhost:9999'
const SYNTHETIC_IMAGE_PATH = '/test-media/avatar.png'
const SYNTHETIC_IMAGE_URL = `${SYNTHETIC_IMAGE_ORIGIN}${SYNTHETIC_IMAGE_PATH}`

// 1x1 transparent PNG (base64 decoded to buffer)
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * Inject a cross-origin image into the page and wait for it to load.
 * This triggers the SW's CacheFirst handler for media-cache.
 */
async function injectAndLoadCrossOriginImage(
  page: import('@playwright/test').Page,
): Promise<void> {
  await page.evaluate((url: string) => {
    return new Promise<void>((resolve, reject) => {
      const img = document.createElement('img')
      img.crossOrigin = 'anonymous'
      img.onload = () => resolve()
      img.onerror = () => {
        // Error is acceptable — SW may block non-200 anyway. Resolve to not hang.
        resolve()
      }
      img.src = url
      document.body.appendChild(img)
    })
  }, SYNTHETIC_IMAGE_URL)
}

test.describe('Media Cache (CacheFirst) — AC4, AC5', () => {
  test.beforeEach(async ({ page }) => {
    await clearSWAndCaches(page)
  })

  test.afterEach(async ({ page }) => {
    await goOnline(page) // Always restore online state
    await clearSWAndCaches(page)
  })

  // ── AC4 ─────────────────────────────────────────────────────────────────
  test('AC4: cross-origin image is cached in media-cache after first load', async ({ page }) => {
    // Set up route interception for the synthetic cross-origin image.
    // page.route intercepts at the browser level (before the network),
    // but the SW intercepts at the fetch event level (after the browser
    // issues the request). With serviceWorkers: 'allow', the SW handles
    // the request first; page.route catches what the SW passes through.
    //
    // For the SW to cache the response, the request must go through the
    // network (SW's CacheFirst: check cache first, if miss → network).
    // We use page.route as a "fake server" that fulfills the request so
    // the SW can cache the 200 response.
    await page.route(SYNTHETIC_IMAGE_URL, (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: PNG_1x1,
        headers: {
          'Cache-Control': 'public, max-age=31536000',
          'Access-Control-Allow-Origin': '*',
        },
      })
    })

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/crm/dashboard')
    await waitForSWActive(page)

    // Load the cross-origin image — first load goes through network (SW cache miss).
    await injectAndLoadCrossOriginImage(page)

    // Poll until media-cache has the image URL.
    // The SW writes to cache asynchronously after the response is received.
    await expect
      .poll(
        async () => {
          const entries = await getCacheEntries(page, CACHE_NAMES.media)
          // SW normalizes the key to origin+pathname (strips query params).
          return entries.some(
            (url) =>
              url.includes(SYNTHETIC_IMAGE_PATH) ||
              url.includes('localhost:9999'),
          )
        },
        {
          message: 'Expected cross-origin image URL to be cached in media-cache',
          timeout: 15_000,
          intervals: [500, 500, 1000, 1000, 2000],
        },
      )
      .toBeTruthy()
  })

  // ── AC4 (fromServiceWorker) ──────────────────────────────────────────────
  test('AC4: repeat visit serves cross-origin image fromServiceWorker', async ({ page }) => {
    // First load: populate the cache.
    await page.route(SYNTHETIC_IMAGE_URL, (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: PNG_1x1,
        headers: {
          'Cache-Control': 'public, max-age=31536000',
          'Access-Control-Allow-Origin': '*',
        },
      })
    })

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/crm/dashboard')
    await waitForSWActive(page)

    // First load — cache miss, image fetched from "network" (page.route).
    await injectAndLoadCrossOriginImage(page)

    // Wait for cache to be populated.
    await expect
      .poll(
        async () => {
          const entries = await getCacheEntries(page, CACHE_NAMES.media)
          return entries.some((url) => url.includes('localhost:9999'))
        },
        { timeout: 15_000, intervals: [500, 1000, 2000] },
      )
      .toBeTruthy()

    // Second load — listen for the response and check fromServiceWorker().
    let servedFromSW = false
    page.on('response', (response) => {
      if (response.url().includes('localhost:9999')) {
        if (response.fromServiceWorker()) {
          servedFromSW = true
        }
      }
    })

    await injectAndLoadCrossOriginImage(page)

    // Give time for the response event to fire.
    await expect
      .poll(
        () => servedFromSW,
        {
          message: 'Expected second image load to be served fromServiceWorker',
          timeout: 10_000,
          intervals: [300, 500, 1000],
        },
      )
      .toBeTruthy()
  })

  // ── AC5 ─────────────────────────────────────────────────────────────────
  test('AC5: offline — cached image loads without network error', async ({ page }) => {
    // Populate the cache first.
    await page.route(SYNTHETIC_IMAGE_URL, (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: PNG_1x1,
        headers: {
          'Cache-Control': 'public, max-age=31536000',
          'Access-Control-Allow-Origin': '*',
        },
      })
    })

    await loginViaApi(page, SEED_ADMIN_EMAIL)
    await page.goto('/crm/dashboard')
    await waitForSWActive(page)

    // First load: populate media-cache.
    await injectAndLoadCrossOriginImage(page)

    await expect
      .poll(
        async () => {
          const entries = await getCacheEntries(page, CACHE_NAMES.media)
          return entries.some((url) => url.includes('localhost:9999'))
        },
        { timeout: 15_000, intervals: [500, 1000, 2000] },
      )
      .toBeTruthy()

    // Go offline.
    await goOffline(page)

    // The image should still load from the SW cache even with no network.
    // We verify by checking that the evaluate succeeds (image.complete = true)
    // and no network error is thrown.
    const loadedOffline = await page.evaluate((url: string) => {
      return new Promise<boolean>((resolve) => {
        const img = document.createElement('img')
        img.crossOrigin = 'anonymous'
        img.onload = () => resolve(true)
        img.onerror = () => resolve(false)
        img.src = url + '?t=' + Date.now() // force new request, not browser cache
        document.body.appendChild(img)
        // Timeout safety — if SW never responds
        setTimeout(() => resolve(false), 8_000)
      })
    }, SYNTHETIC_IMAGE_URL)

    expect(
      loadedOffline,
      'Expected image to load from SW cache while offline',
    ).toBe(true)
  })
})
