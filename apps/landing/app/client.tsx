import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { createRouter } from './router'
import { normalizeIndexHtmlUrl } from './lib/normalize-pathname'

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

const router = createRouter()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
