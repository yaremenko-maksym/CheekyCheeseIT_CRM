/**
 * Workbox `runtimeCaching` rules for the generated Service Worker (see
 * vite.config.ts → VitePWA({ workbox: { runtimeCaching: pwaRuntimeCaching } })).
 *
 * Extracted out of vite.config.ts (instead of the previous inline array) so
 * the url-matching predicates below can be unit-tested directly — see
 * pwa-runtime-caching.spec.ts, which asserts NO rule here ever matches an
 * `/api/*` GET request. That test is the regression guard for the incident
 * this file exists to prevent (see next paragraph); it must fail against the
 * pre-fix `vite.config.ts` on `main`.
 *
 * IMPORTANT — why there is only ONE rule here now:
 * A previous `api-cache` NetworkFirst rule routed every `GET /api/*` request
 * through the Service Worker. On a real device that caused two problems (see
 * PR "fix(web): stop routing API requests through the service worker"):
 *   1. Perf: while the SW is `activating` (happens after every deploy), the
 *      browser queues intercepted fetches until activation resolves — live
 *      iOS Safari repro showed 5 concurrent API calls stalled 16.7s.
 *   2. Privacy: the rule cached ALL 200 responses (financials, team,
 *      transactions — no per-endpoint opt-out except three PDF endpoints
 *      that happened to set `Cache-Control: no-store`), writing PII/financial
 *      data to disk for up to a day. This silently bypassed the
 *      `PERSISTED_KEY_PREFIXES` PII exclusion that the TanStack Query persist
 *      layer enforces (see persisted-key-prefixes.test.ts) — two layers that
 *      didn't know about each other.
 * `/api/*` must never be matched by a runtimeCaching rule again.
 *
 * IMPORTANT — serialization constraint (applies to every rule below):
 * `generateSW` (workbox-build) stringifies each function here via
 * `Function.prototype.toString()` and embeds the source text verbatim into
 * the generated `sw.js`, which runs in the browser's ServiceWorkerGlobalScope
 * — NOT in this Node.js module. Every function below MUST be fully
 * self-contained: only its own parameters and true SW globals (e.g. `self`)
 * may be referenced. Closing over anything from this module's outer scope
 * (an import, a constant declared above) would embed a dangling reference
 * that throws `ReferenceError` at runtime in the Service Worker — Node never
 * catches this because it only stringifies, never executes, the function.
 */

// Minimal local shape for a Workbox runtime-caching rule — deliberately NOT
// importing `RuntimeCaching` from `workbox-build`: that package is only a
// transitive dependency (via vite-plugin-pwa) and isn't hoisted into
// apps/web's pnpm-isolated node_modules, so the import would fail to
// resolve. TypeScript checks this array structurally against the real
// `RuntimeCaching[]` type at the `VitePWA({ workbox: { runtimeCaching } })`
// call site in vite.config.ts — an explicit import here isn't needed.
interface PwaRuntimeCachingRule {
  urlPattern: (context: { url: URL; request: Request }) => boolean
  handler: 'CacheFirst' | 'NetworkFirst' | 'NetworkOnly' | 'CacheOnly' | 'StaleWhileRevalidate'
  options: {
    cacheName: string
    networkTimeoutSeconds?: number
    expiration?: { maxEntries?: number; maxAgeSeconds?: number }
    cacheableResponse?: { statuses: number[] }
    plugins?: Array<{
      cacheKeyWillBeUsed?: (context: { request: Request }) => Promise<string>
      cacheWillUpdate?: (context: { response: Response }) => Promise<Response | null>
    }>
  }
}

export const pwaRuntimeCaching: PwaRuntimeCachingRule[] = [
  {
    // S3-медиа (изображения + PDF): CacheFirst + нормализация ключа.
    // S3-объекты иммутабельны — presigned URL меняется при каждом запросе,
    // но контент по одному и тому же origin+pathname всегда одинаков.
    // Кешируем по origin+pathname, игнорируя presigned query-параметры (X-Amz-*, Expires…).
    //
    // PDF fetch (documents-pdf-preview task):
    //   Добавлен матч для кросс-origin GET-запросов с .pdf в pathname ИЛИ
    //   любого кросс-origin-запроса без /api/ в pathname (presigned S3 blob fetch).
    //   Контракты/инвойсы (same-origin /api/*) не матчатся — они больше не
    //   проходят ни через один runtimeCaching-rule (см. api-cache выше в шапке
    //   файла — /api/* никогда не кешируется, у него нет "куда убегать").
    //
    // Prod NOTE: AWS S3 bucket CORS должен разрешать GET с web-origin
    //   (AllowedOrigins: https://yourdomain.com, AllowedMethods: GET).
    //   В dev MinIO уже сконфигурирован (OPTIONS → Access-Control-Allow-Origin).
    urlPattern: ({ url, request }: { url: URL; request: Request }) => {
      // Кросс-origin (не наш frontend)
      if (url.origin === self.location.origin) return false
      // Исключаем /api/ пути (same-origin proxy — не попадут сюда, но на всякий)
      if (url.pathname.startsWith('/api/')) return false
      // Изображения (по destination)
      if (request.destination === 'image') return true
      // PDF fetch — по расширению или Content-Type (presigned S3 blob)
      if (url.pathname.toLowerCase().endsWith('.pdf')) return true
      // Любой кросс-origin GET без расширения — может быть presigned blob
      // (S3 keys не имеют расширения у PDF если загружен без него)
      if (request.method === 'GET' && request.destination === '') return true
      return false
    },
    handler: 'CacheFirst' as const,
    options: {
      cacheName: 'media-cache',
      plugins: [
        {
          cacheKeyWillBeUsed: async ({ request }: { request: Request }) => {
            const u = new URL(request.url)
            // Срезаем presigned query-параметры S3 (X-Amz-*, Expires, …)
            return u.origin + u.pathname
          },
          // security MED-1: privacy-инвариант держится на КОДЕ, не на топологии
          // деплоя. Catch-all ветка (destination === '') при будущем split-origin
          // API (api.domain.com) может поймать контракт/инвойс-blob с no-store.
          // Уважаем Cache-Control: no-store → не кешируем приватные документы.
          cacheWillUpdate: async ({ response }: { response: Response }) => {
            const cc = response.headers.get('cache-control') ?? ''
            return cc.includes('no-store') ? null : response
          },
        },
      ],
      expiration: { maxEntries: 200, maxAgeSeconds: 2592000 },
      cacheableResponse: { statuses: [0, 200] },
    },
  },
]
