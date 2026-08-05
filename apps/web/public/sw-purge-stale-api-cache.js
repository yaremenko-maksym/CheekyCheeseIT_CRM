// Injected into the generated Service Worker via workbox's `importScripts`
// option (see apps/web/vite.config.ts, VitePWA({ workbox: { importScripts } })).
// This file is NOT bundled/transformed by Vite — everything under
// apps/web/public/ is copied to the build output as-is, and workbox-build
// emits a plain `importScripts('/sw-purge-stale-api-cache.js')` call near the
// top of the generated sw.js. It runs in the browser's
// ServiceWorkerGlobalScope, same as the rest of the generated SW.
//
// WHY THIS EXISTS: builds before "fix(web): stop routing API requests
// through the service worker" wrote every `/api/*` GET response (financial
// data, team info, transactions — no PII opt-out) into a runtime cache named
// `api-cache` for up to a day (`maxAgeSeconds: 86400`). That `runtimeCaching`
// rule is now removed (see app/lib/pwa-runtime-caching.ts) — new visits stop
// writing to it. But removing the rule does NOT retroactively clear what
// ALREADY landed on a user's device: Workbox's own `cleanupOutdatedCaches`
// only sweeps stale *precache* caches (the ones with a build-revision suffix
// in their name); a runtime cache like `api-cache` keeps the same name across
// builds forever, so nothing deletes it automatically. Without this, the fix
// stops the leak going forward but leaves the already-leaked data sitting on
// disk — see PR description for the full writeup.
//
// `caches.delete()` on an already-absent cache name resolves to `false`
// without throwing (MDN: CacheStorage.delete()), so this is safe to run on
// every activation forever — once every device has purged it, this is just a
// no-op cache-name lookup.
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.delete('api-cache'))
})
