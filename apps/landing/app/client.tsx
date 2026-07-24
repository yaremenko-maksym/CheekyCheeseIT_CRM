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

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
