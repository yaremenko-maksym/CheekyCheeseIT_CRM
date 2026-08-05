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

/**
 * Regression guard for security HIGH-1 (task-scan-cache-leak, security-review
 * PR #477, finding pre-existing/out-of-diff at the time it was raised).
 *
 * Mechanism: `document-image.tsx` used to render its `<img>` WITHOUT
 * `crossOrigin`, so the browser fetched it in `no-cors` mode. That produces
 * an OPAQUE `Response` — `status` forced to `0`, every header (including
 * `Cache-Control`) unreadable via `response.headers.get(...)`. The
 * `media-cache` rule's `cacheWillUpdate` plugin reads `Cache-Control` to
 * reject `no-store` responses — on an opaque response that check silently
 * never fires, because it always reads `''`. On top of that,
 * `cacheableResponse.statuses` used to explicitly list `0` alongside `200`,
 * i.e. it OPTED opaque responses IN instead of rejecting the one status
 * class that can never be inspected for `no-store`. Together this meant
 * document scans (SCAN/RESUME/CONTRACT/RECEIPT/INVOICE — `Cache-Control:
 * private, no-store` per `cacheControlForCategory`,
 * apps/api/src/documents/s3.service.ts) sat in `media-cache` for 30 days
 * despite the API doing the right thing.
 *
 * This test replicates workbox-cacheable-response's own cacheability check
 * (`CacheableResponse.isResponseCacheable` — `this._statuses.includes(
 * response.status)`, see workbox-cacheable-response/src/CacheableResponse.ts)
 * against the CURRENT `pwaRuntimeCaching` config, using a REAL opaque-status
 * Response (`Response.error()` — the only way to construct a `status: 0`
 * Response from application code; the `Response` constructor itself throws
 * a RangeError for `status: 0`, per the Fetch spec, so this is the closest a
 * unit test can get to an actual opaque network response without a browser).
 *
 * Proof this fails on `main` today: `main`'s `cacheableResponse.statuses` is
 * `[0, 200]` — `[0, 200].includes(0)` is `true`, so the "must NOT be
 * cacheable" assertion below fails against it (this file was written and run
 * against the pre-fix config to confirm the RED state before the fix landed;
 * see PR description for the exact command/output).
 */
describe('media-cache — opaque (status 0) responses must never be cacheable (security HIGH-1)', () => {
  const statuses = pwaRuntimeCaching[0]?.options.cacheableResponse?.statuses

  it('cacheableResponse.statuses does not opt opaque responses (status 0) in', () => {
    expect(statuses, 'Expected media-cache to declare cacheableResponse.statuses').toBeDefined()
    expect(
      statuses,
      'status 0 (opaque — no headers readable, incl. Cache-Control) must never be in ' +
        'cacheableResponse.statuses: an opaque response defeats the no-store check by ' +
        'construction, so allowing it here is what let document scans get cached for 30 days.',
    ).not.toContain(0)
  })

  it('an opaque (status 0) response is rejected by the configured statuses list', () => {
    // Response.error() is the one standards-compliant way to get a real
    // status-0 Response in application code (a "network error" response —
    // not literally `type: 'opaque'`, but `status` is what
    // CacheableResponse.isResponseCacheable actually branches on).
    const opaqueLike = Response.error()
    const isCacheable = (statuses ?? []).includes(opaqueLike.status)
    expect(
      isCacheable,
      'An opaque-status response must be rejected by cacheableResponse.statuses',
    ).toBe(false)
  })

  it('a real 200 response is still accepted (fix does not overcorrect)', () => {
    const realResponse = new Response(null, { status: 200 })
    const isCacheable = (statuses ?? []).includes(realResponse.status)
    expect(
      isCacheable,
      'AVATAR/LOGO (public, immutable) real 200 responses must stay cacheable',
    ).toBe(true)
  })
})

/**
 * Regression guard for security MED-3 (task-scan-cache-leak, same review as
 * HIGH-1 above).
 *
 * Mechanism: the media-cache urlPattern's catch-all branch (any cross-origin
 * GET with `request.destination === ''`) used to match unconditionally,
 * relying on the API living on the SAME origin as the frontend — same-origin
 * API traffic is filtered out earlier by the `url.pathname.startsWith('/api/')`
 * check. That's a topology assumption, not a content check: at a future
 * split-origin deploy (API on `api.example.com`, no `/api/` prefix
 * requirement) an ordinary `fetch(jsonUrl, { mode: 'cors' })` call — same
 * `destination === ''` shape as the legitimate presigned-S3-blob fetch this
 * branch exists for (`use-document-blob.ts`) — would match and get cached
 * for 30 days, financial/PII payload and all.
 *
 * The fix requires the AWS SigV4 presigned-URL marker `X-Amz-Signature`
 * (always present on URLs from `getSignedUrl()`,
 * apps/api/src/documents/s3.service.ts; never present on a plain JSON API
 * response) — a check on the REQUEST'S NATURE, not on where the API happens
 * to be deployed.
 */
describe('media-cache — presigned-URL catch-all must not depend on API deploy topology (security MED-3)', () => {
  const rule = pwaRuntimeCaching[0]!

  /**
   * A GET request shaped like a programmatic `fetch()` call — i.e.
   * `destination: ''` (real browsers set this for `fetch()`, as opposed to
   * `'image'`/`'document'`/etc for `<img>`/`<iframe>`/navigations). Built as
   * a plain fixture object (not `new Request()`) because happy-dom's `Request`
   * polyfill leaves `.destination` as `undefined` rather than the spec's `''`
   * default — `urlPattern` only ever reads `.method`/`.destination` off its
   * `request` param (see the serialization-constraint note in the file
   * header: it's stringified into the real SW, which runs against a REAL
   * `Request` where `.destination` behaves per spec), so a minimal fixture
   * is the accurate way to exercise it here.
   */
  function fetchLikeRequest(): Request {
    return { method: 'GET', destination: '' } as unknown as Request
  }

  it('rejects a split-origin JSON API GET with no /api/ prefix and no presigned marker', () => {
    // Simulates a future split-origin API that does NOT use an `/api/`
    // pathname convention — the ONLY thing that used to exclude this
    // request was `url.origin === self.location.origin`, which is false
    // here by construction.
    const url = new URL('https://api.example.com/invoices?id=42')
    const request = fetchLikeRequest()

    expect(
      rule.urlPattern({ url, request }),
      'A cross-origin JSON GET without an X-Amz-Signature marker must NOT match media-cache, ' +
        'regardless of pathname or API deploy origin.',
    ).toBe(false)
  })

  it('still matches a real presigned S3/R2 GET (regression guard — legit PDF blob fetch)', () => {
    const url = new URL(
      'https://s3.example.com/bucket/documents/SCAN/owner-1/doc-1-scan.jpg' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA...' +
        '&X-Amz-Date=20260805T000000Z&X-Amz-Expires=1800' +
        '&X-Amz-SignedHeaders=host&X-Amz-Signature=deadbeef',
    )
    const request = fetchLikeRequest()

    expect(
      rule.urlPattern({ url, request }),
      'A genuine presigned S3/R2 GET (carrying X-Amz-Signature) must still match — this is ' +
        'the legitimate use-document-blob.ts PDF-preview fetch path.',
    ).toBe(true)
  })

  it('same-origin requests are still excluded even when they carry an X-Amz-Signature-shaped param', () => {
    // Built off self.location.origin (not a hardcoded prod domain) so this
    // holds regardless of what origin the test environment reports.
    const url = new URL('/some-path?X-Amz-Signature=deadbeef', self.location.origin)
    const request = fetchLikeRequest()

    expect(rule.urlPattern({ url, request })).toBe(false)
  })
})
