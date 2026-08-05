// Injected into the generated Service Worker via workbox's `importScripts`
// option (see apps/web/vite.config.ts, VitePWA({ workbox: { importScripts } })).
// This file is NOT bundled/transformed by Vite — everything under
// apps/web/public/ is copied to the build output as-is, and workbox-build
// emits a plain `importScripts('/sw-purge-v2.js')` call near the top of the
// generated sw.js. It runs in the browser's ServiceWorkerGlobalScope, same as
// the rest of the generated SW.
//
// ============================================================================
// NAMING CONVENTION — READ BEFORE EDITING THIS FILE (security HIGH-1,
// task-scan-cache-leak round 2, security-review PR #479 review `4864575278`):
//
// This file's PATH is caught by nginx's blanket static-asset rule
// (`location ~* \.(js|css|...)$ { expires 1y; add_header Cache-Control
// "public, immutable"; }` — only `/sw.js`, `/registerSW.js`, `/index.html`
// are `=`-location-excepted from it). The generated `sw.js` itself is
// registered WITHOUT `updateViaCache` (defaults to `'imports'`), which means
// per the Service Worker spec: the top-level script (`sw.js`) always
// revalidates over the network, but `importScripts()`-imported files (this
// one) are fetched through the ordinary HTTP cache — i.e. they honor that
// immutable/1y header exactly like any other static asset, browser-side AND
// on the CDN edge.
//
// CONCRETE FAILURE THIS CAUSED: `sw-purge-stale-api-cache.js` (this file's
// PREVIOUS name, before this rename) shipped a media-cache/IndexedDB purge
// fix, but because the URL was stable (no version, no hash), devices that
// had already cached the prior body under that exact URL NEVER re-fetched it
// — `registerType: 'autoUpdate'` keeps resetting the SW's "last update check"
// clock on every page load, so the spec's built-in ">24h since last check
// ⇒ bypass the HTTP cache for imports too" escape hatch never triggered for
// daily-active users. The fix that mattered most (the purge) reached
// LITERALLY ZERO devices. Verified live against prod (`cf-cache-status: HIT`,
// `cache-control: public, max-age=31536000, immutable`, body still the
// pre-fix version hours after deploy).
//
// THE RULE, GOING FORWARD: any time you change the BEHAVIOR of this file
// (not comments/formatting — actual logic), you MUST rename it to the next
// version (`sw-purge-v3.js`, `sw-purge-v4.js`, …) AND update the
// `importScripts` entry in `apps/web/vite.config.ts` to match, in the SAME
// commit. A same-named edit is invisible to any device that already cached
// the old body — silently, with no error, no failed request, nothing to
// notice. Renaming forces a brand-new URL, which is a guaranteed cache MISS
// on both the browser's HTTP cache and Cloudflare's edge cache (a genuinely
// new URL was never resolvable to a cached entry in the first place — there
// is nothing to invalidate).
//
// (Systemic fix — excluding this file's path from nginx's immutable rule the
// same way `/sw.js`/`/registerSW.js` already are, so this renaming ritual
// stops being necessary at all — is tracked separately as DevOps work, not
// done in this file.)
// ============================================================================
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
// security MED-2 (PR #477 review): `caches.delete()` only removes the cached
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
