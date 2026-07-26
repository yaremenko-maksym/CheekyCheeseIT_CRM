import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { createRouter } from './router'
import { normalizeIndexHtmlUrl } from './lib/normalize-pathname'
import { recordPrerenderedRoot } from './lib/prerender-hint'

// MUST run before `createRouter()`'s first match reads `window.location` —
// see normalize-pathname.ts's module doc for the confirmed real-world
// mismatch this closes (Lighthouse CI addressing prerendered pages by their
// literal `/index.html` file path instead of the pretty URL nginx serves
// them at).
const normalizedUrl = normalizeIndexHtmlUrl(
  window.location.pathname,
  window.location.search,
  window.location.hash,
)
if (normalizedUrl) window.history.replaceState(null, '', normalizedUrl)

const rootEl = document.getElementById('root')!

// MUST run before `createRoot(rootEl).render()` below — that call's first
// commit is what clears any prerendered markup already inside `rootEl`
// (this is `createRoot`, not `hydrateRoot`: there is no server/prerender
// entry point to hydrate against, see prerender.mjs's module doc — this
// script re-renders a same-markup client tree ON TOP of static HTML, it
// does not reconcile against it). See prerender-hint.ts's module doc for
// why this matters (terminal.tsx's hero typewriter).
recordPrerenderedRoot(rootEl)

const router = createRouter()

// task-landing-remove-page-transitions.md AC2/AC3 root-cause fix — resolve
// the current URL's matches/loaders BEFORE the FIRST `createRoot().render()`
// commit, instead of mounting immediately and letting the router resolve
// asynchronously afterwards. Confirmed via a live `body.innerText` rAF
// sampler (script deleted after verification, see the task's PR body for the
// before/after numbers): mounting immediately reproduced a genuinely empty
// `#root` (`rootEl.children.length === 0`) for ~1 animation frame on ~8/12
// cold loads of a PRERENDERED page — nothing to do with page-transition
// motion (that code was already deleted when this was diagnosed). Root
// cause: `RouterProvider`'s FIRST render commits before `router.load()`'s
// internal `startTransition`-wrapped match resolution has resolved, so that
// first commit's `<Outlet/>` has nothing to render yet — `createRoot`
// clears the prerendered markup for THAT commit, and the real content only
// lands on a LATER commit once the router transition resolves, leaving a
// real (if brief) blank gap between them. Pre-resolving here means the
// FIRST (and, since nothing changes afterwards, only) commit already has
// the real matched content — confirmed 0/25 empty frames across repeated
// runs after this change, vs 8/12 before. While `router.load()` is
// in-flight, `rootEl` is untouched (React hasn't run yet) — a visitor keeps
// seeing the already-painted prerendered markup, not a blank page.
// `.catch(() => {})` — `router.load()` rejects on a thrown `redirect()`/
// `notFound()` from a route's `beforeLoad`/`loader` (normal TanStack
// control-flow, not just a failure); still mounting on that path lets
// `RouterProvider`'s own redirect/error/not-found handling take over exactly
// as it would if this pre-load didn't exist — this must never leave a
// visitor stuck on the stale prerendered shell forever.
router
  .load()
  .catch(() => {})
  .finally(() => {
    createRoot(rootEl).render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    )
  })
