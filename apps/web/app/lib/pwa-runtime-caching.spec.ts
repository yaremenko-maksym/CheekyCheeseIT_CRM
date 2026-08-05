import { describe, expect, it } from 'vitest'
import { pwaRuntimeCaching } from './pwa-runtime-caching'

/**
 * Regression guard for "fix(web): stop routing API requests through the
 * service worker".
 *
 * On `main` (before that fix) the inline `runtimeCaching` array in
 * vite.config.ts had an `api-cache` NetworkFirst rule whose `urlPattern` was
 * `({ url, request }) => url.pathname.startsWith('/api/') && request.method
 * === 'GET'` — i.e. it matched every `/api/*` GET. That caused every API
 * response to queue behind Service Worker activation (16.7s stalls, live
 * repro on iOS Safari) and cached financial/PII API responses to disk for up
 * to a day. This test asserts the CURRENT `pwaRuntimeCaching` config (the
 * same array vite.config.ts feeds into `VitePWA({ workbox: { runtimeCaching
 * } })`) never matches an `/api/*` request, for any HTTP method a browser
 * might issue. Re-running the equivalent check against `main`'s old inline
 * rule fails (proven manually — see PR description); it must keep failing if
 * anyone reintroduces an `/api/*`-matching rule here.
 */
describe('pwaRuntimeCaching — /api/* must never be intercepted by the Service Worker', () => {
  const apiPaths = [
    '/api/exchange-rate',
    '/api/status',
    '/api/notifications?limit=10',
    '/api/transactions',
    '/api/teams',
    '/api/auth/me',
    '/api/employees/some-id/contract/pdf',
    '/api/onboarding/contract/pdf',
  ]

  const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const

  // Same-origin AND cross-origin (dev: axios baseURL on :3001, SW on :3000).
  const origins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'https://app.cheekycheese.tech',
  ]

  for (const origin of origins) {
    for (const path of apiPaths) {
      for (const method of methods) {
        it(`no rule matches ${method} ${origin}${path}`, () => {
          const url = new URL(path, origin)
          const request = new Request(url, { method })

          const matched = pwaRuntimeCaching.some((rule) => rule.urlPattern({ url, request }))

          expect(
            matched,
            `Expected NO runtimeCaching rule to match ${method} ${url.href} — ` +
              `/api/* must bypass the Service Worker entirely (see file header of pwa-runtime-caching.ts).`,
          ).toBe(false)
        })
      }
    }
  }

  it('still has exactly one rule (media-cache) — sanity check that api-cache stays deleted', () => {
    expect(pwaRuntimeCaching).toHaveLength(1)
    expect(pwaRuntimeCaching[0]?.options.cacheName).toBe('media-cache')
  })
})
