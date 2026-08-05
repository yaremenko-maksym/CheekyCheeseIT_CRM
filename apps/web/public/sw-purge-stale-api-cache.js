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
// EXTENDED (task-scan-cache-leak, security-review PR #477 finding HIGH-1,
// pre-existing/out-of-diff at the time): `media-cache` had the SAME class of
// bug, just quieter — it cached document scans (SCAN/RESUME/CONTRACT/
// RECEIPT/INVOICE thumbnails) for up to 30 days
// (`maxAgeSeconds: 2592000`) despite the API honestly setting
// `Cache-Control: private, no-store` for those categories, because an
// `<img>` fetched WITHOUT `crossOrigin` returns an OPAQUE response (status
// forced to 0, no header readable) and the old `cacheableResponse.statuses`
// explicitly allowed status 0. Both are fixed at the source now (see
// app/components/documents/document-image.tsx and
// app/lib/pwa-runtime-caching.ts) — but exactly like `api-cache` above,
// fixing the RULE only stops NEW writes; scans already sitting in a
// device's `media-cache` from the last 30 days need the same explicit purge.
//
// `caches.delete('media-cache')` purges the WHOLE cache — not just entries
// under a sensitive-category S3 path — deliberately: parsing/whitelisting
// key structure inside this purge script would tie the cleanup to the same
// kind of deploy-topology assumption the MED-3 fix (see
// app/lib/pwa-runtime-caching.ts) just removed from the runtime rule. The
// one-time cost is a handful of AVATAR/LOGO thumbnails refetching on next
// view — cheap, non-sensitive, self-healing (CacheFirst repopulates them
// immediately on the next request).
//
// security MED-2 (same review): `caches.delete()` only removes the cached
// BYTES. Workbox's `expiration` plugin (used by `media-cache`, and formerly
// by `api-cache`) keeps its own bookkeeping in a SEPARATE IndexedDB database
// (`workbox-expiration`, object store `cache-entries` — see
// workbox-expiration's CacheTimestampsModel) — ONE store shared across every
// cache name, each entry keyed by `${cacheName}|${url}`. That store is
// itself a list of exactly what a user looked at (document URLs embed
// category + ownerId + docId, e.g.
// `https://…/documents/SCAN/<ownerId>/<docId>-name.jpg`) — deleting the
// cached bytes without deleting this metadata leaves "what was viewed"
// behind even after the file itself is gone.
// `indexedDB.deleteDatabase('workbox-expiration')` clears it outright
// (covering both `media-cache`'s entries AND any `api-cache` leftovers this
// same gap left behind since the original purge above never touched IDB
// either) rather than selectively pruning entries by cacheName — same
// simplicity reasoning as the whole-cache purge above: Workbox reopens the
// database and repopulates entries lazily on the next cached write, so there
// is nothing worth preserving.
//
// `caches.delete()` on an already-absent cache name resolves to `false`
// without throwing (MDN: CacheStorage.delete()), and
// `indexedDB.deleteDatabase()` fires `onsuccess` even when the database does
// not exist (MDN: IDBFactory.deleteDatabase()) — both are safe to run on
// every activation forever; once every device has purged once, this is just
// a cheap no-op lookup.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.delete('api-cache'),
      caches.delete('media-cache'),
      new Promise((resolve) => {
        var req = indexedDB.deleteDatabase('workbox-expiration')
        // Best-effort in every branch — a failed/blocked delete must never
        // hold up SW activation. `onblocked` fires when another tab still
        // has a connection open; we don't wait it out here, the next
        // activation (e.g. next deploy) retries.
        req.onsuccess = function () {
          resolve()
        }
        req.onerror = function () {
          resolve()
        }
        req.onblocked = function () {
          resolve()
        }
      }),
    ]),
  )
})
