# Cache E2E Strategy — Formal Specification

**Date:** 2026-06-06  
**Status:** Approved  
**Author:** AutoTest agent  
**PR context:** #134 (feat/pwa-api-media-caching — merged into main as `779f279`)

---

## 1. Scope

Service Worker (SW) runtime caching implemented in `apps/web/vite.config.ts` via `vite-plugin-pwa` + Workbox.

**In scope:**

- `media-cache` (CacheFirst, cross-origin images, key normalized to `origin+pathname`)
- `api-cache` (NetworkFirst, GET `/api/*`, `networkTimeoutSeconds: 4`, `cacheWillUpdate` null on `no-store`)
- Logout cache clear (`api-cache` + `media-cache` deleted, precache untouched)
- Anti-stale via `invalidateQueries` (finance/projects/documents mutations)
- SW registration and activation lifecycle

**Out of scope:**

- `persistQueryClient` / IndexedDB — removed in follow-up commit (not covered here)
- Ethereum / smart-contract caching
- Push notifications

---

## 2. Architecture constraints

### 2.1 SW only in production build

`devOptions: { enabled: false }` in VitePWA config. The SW is only registered when the app is served from a prod bundle (`vite preview` or static hosting).

**Implication:** Cache E2E tests MUST run against `vite build + vite preview`, not `vite dev`. The `cache` Playwright project configures its own `webServer` pointing at `preview`.

### 2.2 SW activation requires real browser lifecycle

The Playwright `serviceWorkers: 'block'` setting (default for existing specs) prevents SW registration entirely. The `cache` project must override this to `'allow'`.

### 2.3 Cache names

| Cache                          | Name                    | Strategy                            |
| ------------------------------ | ----------------------- | ----------------------------------- |
| API GET responses              | `api-cache`             | NetworkFirst, timeout 4s            |
| Cross-origin images (S3 media) | `media-cache`           | CacheFirst, key = `origin+pathname` |
| Static assets (precache)       | `workbox-precache-v2-*` | InstallAndRoute                     |

### 2.4 no-store exclusion

`cacheWillUpdate` plugin returns `null` for responses with `Cache-Control: no-store`. This excludes PDF endpoints (`/api/onboarding/preview-pdf`, `/api/invoices/:id/pdf`, employee-contracts).

### 2.5 Logout clear contract

`handleLogout` in `apps/web/app/routes/crm/route.tsx`:

1. `queryClient.clear()`
2. `idbDel('crm-query-cache')`
3. `caches.keys()` → filter `api-cache | media-cache` → `caches.delete(k)`
4. `window.location.href = '/login'`

Precache stores (`workbox-precache-*`) are intentionally NOT deleted.

---

## 3. Test isolation requirements

SW and Cache API state leaks between tests because:

- SW registration persists across page navigations within a browser context
- `caches.keys()` is shared across all pages in a browser context
- IndexedDB is also shared (though not tested here)

**Mandatory isolation:** `clearSWAndCaches(page)` called in `beforeEach` and `afterEach` for all cache tests.

---

## 4. Real-API requirement for anti-stale tests

Anti-stale scenarios (mutation → UI refresh) require real API responses because:

1. Mocked routes (`route.fulfill()`) bypass the SW entirely — the SW only intercepts real network requests
2. The SW `NetworkFirst` for `/api/*` only caches real HTTP 200 responses
3. `invalidateQueries` behavior cannot be verified without real TanStack Query + real backend responses

**Infrastructure:** `loginViaApi(page, SEED_EMAILS.admin)` from existing `fixtures.ts` + real NestJS backend at `:3001`.

---

## 5. Flaky risk matrix

| Risk                                             | Mitigation                                                                                       |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| SW not yet `activated` when cache assert runs    | `waitForSWActive(page)` using `controllerchange` or polling `navigator.serviceWorker.controller` |
| `networkidle` doesn't imply SW fully controlling | Use `expect.poll()` on cache state instead                                                       |
| Cache entries not yet written (async Workbox)    | `expect.poll(() => isCached(...)).toBeTruthy()` with retry                                       |
| Cross-test cache pollution                       | `clearSWAndCaches` in `beforeEach` + `afterEach`                                                 |
| Preview server not started                       | `webServer.reuseExistingServer: !process.env.CI`                                                 |

---

## 6. Acceptance criteria

| #    | Criterion                                                                       |
| ---- | ------------------------------------------------------------------------------- |
| AC1  | SW activates on page load (`navigator.serviceWorker.controller !== null`)       |
| AC2  | `api-cache` cache store exists after navigating to a CRM page                   |
| AC3  | `media-cache` cache store exists after loading a page with cross-origin images  |
| AC4  | Cross-origin images are served `fromServiceWorker()` on repeat visit            |
| AC5  | Cross-origin images are available offline (served from `media-cache`)           |
| AC6  | GET `/api/*` responses are added to `api-cache`                                 |
| AC7  | Online GET `/api/*` returns fresh data (not from cache) — NetworkFirst behavior |
| AC8  | Offline GET `/api/*` returns stale data from `api-cache`                        |
| AC9  | After logout, `api-cache` is deleted from `caches.keys()`                       |
| AC10 | After logout, `media-cache` is deleted from `caches.keys()`                     |
| AC11 | Precache store (`workbox-precache*`) survives logout                            |
| AC12 | PDF endpoint URL (no-store) is NOT stored in `api-cache`                        |
| AC13 | Offline: app shell (HTML) loads without browser network error (SPA fallback)    |
