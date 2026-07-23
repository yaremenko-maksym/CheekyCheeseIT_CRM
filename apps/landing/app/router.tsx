import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { routeTree } from './routeTree.gen'

export function createRouter() {
  return createTanStackRouter({
    routeTree,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    // Cross-route nav links (e.g. Careers -> "/" hash="contact") rely on this
    // to scroll to the target section once the route has rendered.
    scrollRestoration: true,
    // task-landing-seo-prerender.md §1/§2 — `scripts/prerender.mjs` writes
    // one `<route>/index.html` PER directory (the standard SSG convention:
    // `/careers/<slug>` -> `dist/careers/<slug>/index.html`), and prod nginx
    // (`nginx/conf.d/landing.conf`, `try_files $uri $uri/ /index.html`) DOES
    // resolve that correctly — but only by first issuing an HTTP 301 to the
    // trailing-slash form when a *directory* is requested without one
    // (verified empirically against the real dist/ output + landing.conf
    // via a local nginx:alpine container — plain `vite preview`, used
    // elsewhere for local iteration, does NOT reproduce this 301 hop, which
    // is exactly why it doesn't reveal this on its own). Without this
    // option every internal `<Link>` generates the no-slash form, so EVERY
    // cold visit/crawl of a nested route — not just direct URL entry — would
    // pay that redirect. `trailingSlash: 'always'` makes the app itself only
    // ever produce/expect the trailing-slash form (mirrored in
    // `lib/seo.ts` `canonicalUrl()` and the sitemap), so the 301 is never
    // actually hit in practice.
    trailingSlash: 'always',
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>
  }
}
