/**
 * PersistQueryClient — regression + smoke tests (PR-B #47)
 *
 * AC1 (CRITICAL — race regression): serviceWorkers:'block' (default project) +
 *   empty IndexedDB (fresh per-test context). Authenticated navigation to
 *   /crm/interviews must NOT redirect to /crm/login. The isRestoring-aware auth
 *   guard holds isLoading=true during PersistQueryClientProvider's restore window.
 *
 * AC2 (persist write): after a persisted (non-excluded) query resolves, the
 *   IndexedDB key 'crm-query-cache' is written by the persister.
 *
 * Logout-clear (AC3) is covered deterministically by:
 *   - apps/web/app/lib/use-logout.spec.ts (unit: idbDel('crm-query-cache') + clear)
 *   - apps/e2e/tests/cache/logout-clear.spec.ts (canonical E2E, cache project).
 *   It is intentionally NOT re-tested here: asserting IDB emptiness right after a
 *   hard-navigation logout is racy (the persister may benignly re-write an empty
 *   cache), which conflicts with the zero-flaky E2E policy.
 *
 * Mock-only: API is mocked via the shared mockAuthAs() helper (page.route) — the
 * same proven harness all other mock specs use, no real backend required.
 */
import { test, expect, type Page, mockAuthAs, USERS } from './fixtures'

const API = 'http://localhost:3001/api'
const IDB_KEY = 'crm-query-cache'

/** Full API mock for an authenticated ADMIN (auth/me, notifications, users,
 *  interviews, onboarding, …) via the shared, battle-tested helper. */
async function setupMocks(page: Page): Promise<void> {
  await mockAuthAs(page, USERS.admin)
}

/**
 * Check whether the IDB persist key exists in idb-keyval's store
 * (default db 'keyval-store' / object store 'keyval').
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
        const getReq = db.transaction('keyval', 'readonly').objectStore('keyval').get(k)
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

// ---------------------------------------------------------------------------
// AC1 — CRITICAL: isRestoring race regression
// ---------------------------------------------------------------------------

test.describe('PersistQueryClient — isRestoring race regression (AC1)', () => {
  test('authenticated navigation to /crm/interviews stays on target page (no redirect to /crm/login)', async ({
    page,
  }) => {
    await setupMocks(page)

    // Before the fix: PersistQueryClientProvider restores empty IDB →
    //   isRestoring=false → isPending=true, isFetching=false → isLoading=false →
    //   user=null → guard redirects to /crm/login.
    // After the fix: isRestoring=true during the restore window → isLoading=true
    //   → guard waits → auth/me resolves → user=ADMIN → stays on the route.
    await page.goto('/crm/interviews')
    await page.waitForLoadState('domcontentloaded')

    const url = page.url()
    expect(url, `Expected to stay on /crm/interviews (isRestoring fix). Got: ${url}`).not.toMatch(
      /\/crm\/login/,
    )

    // The CRM layout rendered (header user-menu is always present once authed) —
    // single locator avoids strict-mode ambiguity with the page heading.
    await expect(page.locator('[data-testid="header-user-menu-trigger"]')).toBeVisible({
      timeout: 10_000,
    })
  })

  test('unauthenticated request (auth/me → 401) still redirects to /crm/login', async ({
    page,
  }) => {
    await setupMocks(page)
    // Override auth/me to 401 — registered AFTER mockAuthAs so it wins (LIFO).
    await page.route(`${API}/auth/me`, (r) =>
      r.fulfill({ status: 401, body: '{"message":"Unauthorized"}' }),
    )

    await page.goto('/crm/interviews')
    await expect(page).toHaveURL(/\/crm\/login/, { timeout: 10_000 })
  })
})

// ---------------------------------------------------------------------------
// AC2 — persist cache written to IndexedDB
// ---------------------------------------------------------------------------

test.describe('PersistQueryClient — IDB persistence (AC2)', () => {
  test('cache key crm-query-cache is written to IndexedDB after a persisted query resolves', async ({
    page,
  }) => {
    await setupMocks(page)

    await page.goto('/crm/interviews')
    await page.waitForLoadState('domcontentloaded')

    // Layout rendered → auth resolved + persisted (non-excluded) queries settled.
    await expect(page.locator('[data-testid="header-user-menu-trigger"]')).toBeVisible({
      timeout: 10_000,
    })

    // Give the persister time to flush (throttleTime: 1000 ms in persister.ts).
    await page.waitForTimeout(1500)

    const keyExists = await idbKeyExists(page, IDB_KEY)
    expect(
      keyExists,
      `Expected IDB key '${IDB_KEY}' to be written by the persister after a persisted query resolves`,
    ).toBe(true)
  })
})
