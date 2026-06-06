# Cache E2E — Implementation Plan

**Date:** 2026-06-06  
**Branch:** `test/cache-e2e`  
**Spec:** `docs/superpowers/specs/2026-06-06-cache-e2e-strategy.md`

---

## Commit order (incremental — resilient to interruption)

| Commit | Files | Content |
|---|---|---|
| C1 (infra) | `playwright.config.ts` | Add `cache` project: `serviceWorkers: 'allow'`, `testMatch: tests/cache/**`, `webServer` |
| C2 (helpers) | `tests/cache/helpers.ts` | `waitForSWActive`, `getCacheEntries`, `isCached`, `isFromServiceWorker`, `clearSWAndCaches` |
| C3 (smoke) | `tests/cache/sw-smoke.spec.ts` | SW activates + cache stores exist |
| C4 (media) | `tests/cache/media-cache.spec.ts` | CacheFirst, fromServiceWorker, offline |
| C5 (api) | `tests/cache/api-cache.spec.ts` | NetworkFirst: populates cache, online fresh, offline stale |
| C6 (logout) | `tests/cache/logout-clear.spec.ts` | api+media deleted, precache survives |
| C7 (no-store) | `tests/cache/no-store.spec.ts` | PDF URL not in api-cache |
| C8 (docs) | `docs/superpowers/**` | Spec + plan (this file) |

---

## Infrastructure details

### Playwright `cache` project

```typescript
{
  name: 'cache',
  testMatch: 'tests/cache/**/*.spec.ts',
  use: {
    ...devices['Desktop Chrome'],
    serviceWorkers: 'allow',     // Override global 'block'
    baseURL: 'http://localhost:3000',
  },
  webServer: {
    command: 'pnpm --filter @crm/web start',  // vite preview on :3000
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
}
```

Note: SW only works in production build. For CI: build must happen before `pnpm test --project=cache`.

### Helpers (`tests/cache/helpers.ts`)

#### `waitForSWActive(page)`

```typescript
// Wait until SW is controlling the page
await page.waitForFunction(
  () => navigator.serviceWorker?.controller !== null,
  { timeout: 15_000 }
)
```

#### `getCacheEntries(page, cacheName)`

```typescript
const entries = await page.evaluate(async (name: string) => {
  const cache = await caches.open(name)
  const keys = await cache.keys()
  return keys.map(r => r.url)
}, cacheName)
```

#### `isCached(page, urlSubstring, cacheName?)`

```typescript
// Checks if any cache entry URL contains the substring
const keys = await getCacheEntries(page, cacheName ?? 'api-cache')
return keys.some(url => url.includes(urlSubstring))
```

#### `clearSWAndCaches(page)`

```typescript
await page.evaluate(async () => {
  // Unregister all SW
  const regs = await navigator.serviceWorker.getRegistrations()
  await Promise.all(regs.map(r => r.unregister()))
  // Delete all runtime caches
  const keys = await caches.keys()
  await Promise.all(keys.map(k => caches.delete(k)))
})
```

---

## Test list

### `sw-smoke.spec.ts` (AC1, AC2, AC3)

| Test | AC |
|---|---|
| SW activates after navigating to /crm | AC1 |
| `api-cache` exists after CRM navigation | AC2 |
| `media-cache` is registered by SW | AC3 |

### `media-cache.spec.ts` (AC3, AC4, AC5)

| Test | AC |
|---|---|
| Cross-origin image added to media-cache | AC3 |
| Repeat visit serves image fromServiceWorker | AC4 |
| Offline: image loaded from media-cache (no network error) | AC5 |

Note: Media cache tests use a stub cross-origin image served by the test (via `page.route` or real S3 presigned URL from seed). Since real S3 may not be available in all environments, the test intercepts a synthetic cross-origin request.

### `api-cache.spec.ts` (AC6, AC7, AC8)

| Test | AC |
|---|---|
| GET /api/users is added to api-cache | AC6 |
| Online: fresh response (not from SW cache) | AC7 |
| Offline: stale data served from api-cache | AC8 |

### `logout-clear.spec.ts` (AC9, AC10, AC11)

| Test | AC |
|---|---|
| After logout: api-cache removed from caches.keys() | AC9 |
| After logout: media-cache removed from caches.keys() | AC10 |
| After logout: workbox-precache-* survives | AC11 |

### `no-store.spec.ts` (AC12)

| Test | AC |
|---|---|
| PDF endpoint URL (no-store) not in api-cache | AC12 |

---

## Anti-flaky strategy

1. **SW activation gate:** All tests run `waitForSWActive(page)` before any cache assertion.
2. **`expect.poll()` for cache state:** Instead of asserting immediately after navigation, poll until the cache store is populated (async Workbox write).
3. **Full isolation:** `clearSWAndCaches(page)` in `beforeEach` AND `afterEach`. This prevents cache state from leaking between tests.
4. **Real backend for anti-stale:** `loginViaApi` + real NestJS at `:3001` + seed data. No mocked routes.
5. **Production build only:** Tests run against `vite preview` (SW registered). `webServer` config ensures preview is up.
6. **No `waitForTimeout`:** Zero usage. All waits are `expect(locator).toBeVisible()` or `page.waitForFunction()`.
7. **No `test.skip`:** All tests must pass or fail explicitly.

---

## Local validation procedure

```bash
# 1. Build API + seed
pnpm --filter @crm/api build
NODE_ENV=production node apps/api/dist/main &

# 2. Build + preview web
pnpm --filter @crm/shared build
pnpm --filter @crm/web build
pnpm --filter @crm/web start &

# 3. Run cache project (multiple times for stability check)
pnpm --filter @crm/e2e test --project=cache
pnpm --filter @crm/e2e test --project=cache  # repeat = zero-flaky proof

# 4. Verify existing mock specs not broken
pnpm --filter @crm/e2e test --project=chromium tests/auth.spec.ts tests/navigation.spec.ts
```

---

## CI follow-up (DevOps scope)

The `cache` Playwright project is picked up automatically by `e2e.yml` full-suite run (all projects). A dedicated CI shard `cache` with pre-built `vite preview` requires DevOps changes to `ci.yml` — this is out of AutoTest's zone-of-write.

**Recommendation for DevOps:** Add a `cache-e2e` job in `ci.yml` that:

1. Runs `pnpm --filter @crm/web build` (reuse build artifact from deploy step)
2. Starts `pnpm --filter @crm/web start` (preview)
3. Runs `pnpm --filter @crm/e2e test --project=cache`
