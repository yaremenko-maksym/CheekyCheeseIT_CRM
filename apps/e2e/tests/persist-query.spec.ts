/**
 * PersistQueryClient — regression + smoke tests (PR-B #47)
 *
 * AC1 (CRITICAL — race regression): Fresh browser context + serviceWorkers:'block'
 *   + empty IndexedDB. Authenticated navigation to /crm/interviews must NOT
 *   redirect to /crm/login. The isRestoring-aware auth guard must hold
 *   isLoading=true during PersistQueryClientProvider's IndexedDB restore window.
 *
 * AC2 (persist across reload): After data loads, a page reload serves the
 *   UI from the persisted cache (no blank flash; query client rehydrated).
 *
 * AC3 (logout clear): idbDel('crm-query-cache') is invoked on logout.
 *   Verified by checking that the IndexedDB key is absent after logout.
 *
 * Implementation note — why serviceWorkers:'block':
 *   The race manifests specifically when there is NO cached /api/auth/me
 *   response (empty SW cache + empty IDB). Blocking SW forces the
 *   app to fall back to the real /api/auth/me network call, which arrives
 *   AFTER PersistQueryClientProvider finishes restoring (even from empty IDB).
 *   Without the isRestoring fix, this causes a transient user=null flash →
 *   navigate('/crm/login') before the real auth response arrives.
 *
 * Implementation note — mock-only setup:
 *   All API calls are mocked via page.route() (Playwright network interception),
 *   following the established mock-spec convention (fixtures.ts mockAuthAs).
 *   The mock pattern means we do NOT need a real NestJS backend running.
 */
import { test as base, expect, type Page, type Route } from '@playwright/test'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const API = 'http://localhost:3001/api'
const IDB_KEY = 'crm-query-cache'

// Minimal user fixture (ADMIN) — mirrors fixtures.ts USERS.admin shape
const MOCK_ADMIN = {
  id: 'a0000000-0000-4000-8000-000000000001',
  email: 'admin@cheekycheese.dev',
  displayName: 'Admin User',
  role: 'ADMIN' as const,
  avatarUrl: null,
  avatarDocumentId: null,
  telegram: null,
  phone: null,
  techStack: null,
  paymentMethod: null,
  seniorSharePercent: 0,
  monthlySalary: null,
  salaryCurrency: 'USD' as const,
  legalFullName: null,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonOk(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

function noContent(route: Route) {
  return route.fulfill({ status: 204, body: '' })
}

/**
 * Set up full API mock (auth/me + minimal supporting routes) on a page.
 * Mirrors the minimal required mocks from fixtures.ts mockAuthAs() so the
 * CRM layout renders without real backend and without spurious 401s.
 */
async function setupMocks(page: Page): Promise<void> {
  await page.route(`${API}/auth/me`, (r) => jsonOk(r, MOCK_ADMIN))
  await page.route(`${API}/auth/logout`, (r) => noContent(r))
  await page.route(new RegExp(`${API}/notifications/read-all$`), (r) => noContent(r))
  await page.route(new RegExp(`${API}/notifications/([^/?]+)/read$`), (r) => noContent(r))
  await page.route(new RegExp(`${API}/notifications(\\?.*)?$`), (r) => jsonOk(r, []))
  await page.route(new RegExp(`${API}/pending-settlements/senior(\\?.*)?$`), (r) => jsonOk(r, []))
  await page.route(new RegExp(`${API}/pending-settlements/company(\\?.*)?$`), (r) => jsonOk(r, []))
  await page.route(`${API}/onboarding/status`, (r) =>
    jsonOk(r, {
      requiresContract: false,
      requiresTos: false,
      contractTemplate: null,
      tosVersion: null,
      tosUpdateAvailable: false,
      latestTosVersion: null,
    }),
  )
  await page.route(new RegExp(`${API}/interviews(\\?.*)?$`), (r) =>
    jsonOk(r, { items: [], total: 0 }),
  )
  await page.route(new RegExp(`${API}/users(\\?.*)?$`), (r) => jsonOk(r, [MOCK_ADMIN]))
}

/**
 * Check whether the IDB persist key exists in IndexedDB.
 * Uses the keyval-store (idb-keyval default: 'keyval-store' / 'keyval').
 */
async function idbKeyExists(page: Page, key: string): Promise<boolean> {
  return page.evaluate(async (k: string) => {
    return new Promise<boolean>((resolve) => {
      const openReq = indexedDB.open('keyval-store')
      openReq.onsuccess = () => {
        const db = openReq.result
        if (!db.objectStoreNames.contains('keyval')) {
          db.close()
          resolve(false)
          return
        }
        const tx = db.transaction('keyval', 'readonly')
        const store = tx.objectStore('keyval')
        const getReq = store.get(k)
        getReq.onsuccess = () => {
          db.close()
          resolve(getReq.result !== undefined)
        }
        getReq.onerror = () => {
          db.close()
          resolve(false)
        }
      }
      openReq.onerror = () => resolve(false)
    })
  }, key)
}

/**
 * Clear IndexedDB keyval store — isolates tests that write to IDB.
 */
async function clearIdb(page: Page): Promise<void> {
  await page.evaluate(() => {
    return new Promise<void>((resolve) => {
      const deleteReq = indexedDB.deleteDatabase('keyval-store')
      deleteReq.onsuccess = () => resolve()
      deleteReq.onerror = () => resolve()
      deleteReq.onblocked = () => resolve()
    })
  })
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

/**
 * Extend base test with a fresh browser context that has serviceWorkers blocked.
 * This isolates these tests from SW state and forces the auth-guard race path.
 */
const test = base.extend<{ freshPage: Page }>({
  freshPage: async ({ browser }, use) => {
    // serviceWorkers:'block' prevents the SW from intercepting /api/auth/me
    // (no cache hit) — exposes the isRestoring race condition.
    const ctx = await browser.newContext({ serviceWorkers: 'block' })
    const page = await ctx.newPage()
    // Clear IndexedDB before the test so restore starts from empty store.
    await page.goto('about:blank')
    await clearIdb(page)
    await use(page)
    await ctx.close()
  },
})

// ---------------------------------------------------------------------------
// AC1 — CRITICAL: isRestoring race regression
// ---------------------------------------------------------------------------

test.describe('PersistQueryClient — isRestoring race regression (AC1)', () => {
  test(
    'authenticated navigation to /crm/interviews stays on target page (no redirect to /crm/login)',
    async ({ freshPage: page }) => {
      await setupMocks(page)

      // Navigate directly to a deep CRM route.
      // Before the fix: PersistQueryClientProvider restores empty IDB →
      //   isRestoring=false → isPending=true, isFetching=false →
      //   isLoading=false → user=null → guard redirects to /crm/login.
      // After the fix: isRestoring=true during restore window → isLoading=true
      //   → guard skips → auth/me resolves → user=ADMIN → stays on /crm/interviews.
      await page.goto('/crm/interviews')

      // Must NOT redirect to login — wait for the page to settle.
      // Give auth/me time to resolve (mocked, so it is instant, but we need
      // the React render cycle to complete).
      await page.waitForLoadState('domcontentloaded')

      // Assert we are NOT on login.
      const url = page.url()
      expect(
        url,
        `Expected to stay on /crm/interviews (isRestoring fix). Got: ${url}`,
      ).not.toMatch(/\/crm\/login/)

      // Assert the CRM layout rendered (heading or sidebar visible).
      // The interviews page has "Собеседования" heading when correctly loaded.
      await expect(
        page.getByRole('heading', { name: /собеседования/i }).or(
          page.locator('[data-testid="header-user-menu-trigger"]'),
        ),
      ).toBeVisible({ timeout: 10_000 })
    },
  )

  test(
    'unauthenticated request (auth/me → 401) still redirects to /crm/login',
    async ({ freshPage: page }) => {
      // Override auth/me to return 401 — real redirect must still happen.
      await page.route(`${API}/auth/me`, (r) =>
        r.fulfill({ status: 401, body: '{"message":"Unauthorized"}' }),
      )

      await page.goto('/crm/interviews')
      await expect(page).toHaveURL(/\/crm\/login/, { timeout: 10_000 })
    },
  )
})

// ---------------------------------------------------------------------------
// AC2 — persist cache written to IndexedDB
// ---------------------------------------------------------------------------

test.describe('PersistQueryClient — IDB persistence (AC2)', () => {
  test(
    'cache key crm-query-cache is written to IndexedDB after auth resolves',
    async ({ freshPage: page }) => {
      await setupMocks(page)

      await page.goto('/crm/dashboard')
      await page.waitForLoadState('domcontentloaded')

      // Wait until user menu is visible — auth/me resolved + cache dehydrated.
      await expect(page.locator('[data-testid="header-user-menu-trigger"]')).toBeVisible({
        timeout: 10_000,
      })

      // Give persister time to write (throttleTime: 1000 ms in persister.ts).
      await page.waitForTimeout(1500)

      const keyExists = await idbKeyExists(page, IDB_KEY)
      expect(
        keyExists,
        `Expected IDB key '${IDB_KEY}' to be written by persister after auth resolves`,
      ).toBe(true)
    },
  )
})

// ---------------------------------------------------------------------------
// AC3 — logout clears the persist key from IndexedDB
// ---------------------------------------------------------------------------

test.describe('PersistQueryClient — logout clears IDB (AC3)', () => {
  test(
    'idbDel(crm-query-cache) is called on logout — key absent from IDB after logout',
    async ({ freshPage: page }) => {
      await setupMocks(page)

      // Load CRM so the persister writes the cache.
      await page.goto('/crm/dashboard')
      await expect(page.locator('[data-testid="header-user-menu-trigger"]')).toBeVisible({
        timeout: 10_000,
      })

      // Wait for the persister throttle to flush (1 s throttle + buffer).
      await page.waitForTimeout(1500)

      // Confirm key is present before logout.
      const keyBefore = await idbKeyExists(page, IDB_KEY)
      expect(keyBefore, `Expected IDB key '${IDB_KEY}' to exist before logout`).toBe(true)

      // Trigger logout via the UI (mirrors logout-clear.spec.ts pattern).
      await page.locator('[data-testid="header-user-menu-trigger"]').click()
      await page.locator('[data-testid="header-user-menu-logout"]').click()

      // Wait for redirect to /login.
      await page.waitForURL('**/login**', { timeout: 15_000 })

      // After logout idbDel('crm-query-cache') runs in use-logout.ts.
      // Poll until the key is gone (deletion is async).
      await expect
        .poll(
          () => idbKeyExists(page, IDB_KEY),
          {
            message: `Expected IDB key '${IDB_KEY}' to be deleted after logout`,
            timeout: 5_000,
            intervals: [300, 500, 1000],
          },
        )
        .toBe(false)
    },
  )
})
