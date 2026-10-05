# PWA Static Asset Caching — Design Spec

**Date:** 2026-06-06
**Author:** Coder agent
**Status:** Implemented (feat/pwa-static-caching)

---

## Goal

Add Service Worker caching of the frontend's static assets so that:

- Repeat loads are faster (static from cache — 0ms latency)
- Provide basic offline resilience for the application shell
- Do not break the existing auth/data/media flow

---

## Audit findings (pre-implementation)

### What is already cached — do NOT touch

- **Media (avatars/receipts/documents):** S3 immutable + presigned URLs + TanStack Query `staleTime: 4h`. An SW over presigned-URL media is useless (the URL changes every request) and unsafe for private receipts.
- **Generated PDFs (contracts/invoices):** `Cache-Control: no-store, private` — deliberately not cached, the SW must not touch them.

### What is not cached — our target

The prod frontend is served by `vite preview`. Static assets are hashed (`assets/index-[hash].js`) — ready for immutable caching. There is no Service Worker.

---

## Chosen approach

**`vite-plugin-pwa@1.3.0` with the `generateSW` strategy (Workbox)**

### Decisions

| Decision | Choice | Rationale |
| -------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------- | --- | --- | --- | --- | --- | ---- |
| Plugin | `vite-plugin-pwa` | Zero-config, Vite 6 compatible (`^3.1                                                                          |     | ^4  |     | ^5  |     | ^6`) |
| SW strategy | `generateSW` | No custom SW code, Workbox generates it automatically |
| SW registration | `injectRegister: 'inline'` | Avoids `virtual:pwa-register` in the Rollup module graph (pnpm workspace: `zod` not hoisted into root `node_modules`) |
| `registerType` | `autoUpdate` | The SW updates automatically in the background without a user prompt |
| dev mode | `devOptions.enabled: false` | An SW in dev = stale cache, breaks hot-reload |
| Manifest | `manifest: false` | The existing `public/site.webmanifest` is self-sufficient |

### What gets precached

```
**/*.{js,css,html,ico,png,svg,woff2,webmanifest}
```

Hashed JS/CSS bundles (`revision: null` — immutable, cache-forever) + static from `public/` with a revision hash.

### SPA routing

`navigateFallback: '/index.html'` — all navigation requests get the application shell. TanStack Router resolves routes on the client.

---

## Exclusions (what the SW does NOT touch)

| Type                   | Why excluded                                                               |
| ---------------------- | -------------------------------------------------------------------------- |
| `/api/*`               | Auth/data — caching is dangerous. `navigateFallbackDenylist: [/^\/api\//]` |
| S3 presigned URL       | The URL changes every request — caching is useless; media is private       |
| PDF invoices/contracts | `Cache-Control: no-store, private` — deliberately not cached               |
| runtimeCaching         | Not added — only static precache                                           |

---

## SW update strategy

- `skipWaiting: true` — the new SW activates immediately without waiting for tabs to close
- `clientsClaim: true` — the SW takes control of all open clients
- `cleanupOutdatedCaches: true` — outdated caches are removed on update
- `registerType: 'autoUpdate'` — the plugin automatically injects the update logic

Effect: on a new bundle deploy the SW updates in the background, the page reloads automatically.

---

## Risks and mitigations

| Risk                       | Mitigation                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------- |
| Stale SW in production     | `autoUpdate` + `skipWaiting` + `cleanupOutdatedCaches`                              |
| Stale cache in dev         | `devOptions.enabled: false` — the SW is not active in dev                           |
| `/api` in precache         | `navigateFallbackDenylist` excludes it, `runtimeCaching` is absent                  |
| Private media in the cache | The S3 URL is not in globPatterns; runtimeCaching is not added                      |
| pnpm workspace zod resolve | `injectRegister: 'inline'` instead of `virtual:pwa-register` — bypasses the problem |

---

## Out-of-scope (follow-up)

- **Deep media cache via stable URLs** — permanent URLs (not presigned) are needed for public S3 assets. A separate Phase 7+ task.
- **Offline-first data** — a full offline mode with background sync. Not needed for the CRM.
- **Push notifications** — a separate task for the notifications module.

---

## Implementation artifacts

- `apps/web/vite.config.ts` — the `VitePWA({...})` plugin
- `apps/web/app/client.tsx` — a comment (registerSW via an inline script)
- `apps/web/package.json` — `vite-plugin-pwa: ^1.3.0` devDependency
- `dist/sw.js` — generated on every `vite build`
- `dist/workbox-*.js` — Workbox runtime (precache/routing)
- `dist/index.html` — contains `<script id="vite-plugin-pwa:inline-sw">` to register the SW
