# @crm/landing

Public marketing site (`cheekycheese.tech`) — plain Vite + React SPA with TanStack
Router. No SSR framework (not TanStack Start) — see `app/lib/use-document-head.ts`
module doc for why.

## Commands

```bash
pnpm --filter @crm/landing dev              # vite dev server, :3002
pnpm --filter @crm/landing build            # vite build only (client-only SPA output)
pnpm --filter @crm/landing build:prerender  # build + static prerender (see below)
pnpm --filter @crm/landing start            # vite preview of dist/
pnpm --filter @crm/landing test             # vitest
pnpm --filter @crm/landing typecheck | lint
```

## SEO / SSG prerender pipeline (`scripts/prerender.mjs`)

task-landing-seo-prerender.md. The landing needs (1) perfect indexation by
search engines and non-JS-executing AI crawlers (GPTBot, ClaudeBot,
PerplexityBot, ...) and (2) Lighthouse ≥90 on all 4 categories, mobile and
desktop. Since this is a client-only SPA (no server render), `build:prerender`
adds a **headless-browser snapshot** step after the normal Vite build:

```bash
pnpm --filter @crm/landing build:prerender
# = vite build && node scripts/prerender.mjs
```

What it does, in order:

1. Fetches `GET {PRERENDER_API_ORIGIN}/api/public/vacancies` (Node-side) to
   know which PUBLISHED vacancy slugs exist. **If the API is unreachable**,
   this logs a `::warning::` and continues — the build never fails; the
   `/careers/:slug` pages are simply skipped for this run (the live SPA still
   fetches vacancies client-side for real visitors — see `fetchVacancies()`'s
   graceful `[]` fallback in `app/lib/api.ts`).
2. Serves the already-built `dist/` via Vite's own `preview()` server (same
   static file serving + `/api` proxy as `pnpm start`), on a scratch port
   (`PRERENDER_PORT`, default `4173`).
3. Drives a real headless Chromium (Playwright — reuses the workspace's
   existing `apps/e2e` version, no new dependency) to every route
   (`/`, `/careers`, one `/careers/<slug>` per PUBLISHED vacancy, plus a
   404 marker), waiting for the SPA to mount, fetch, and fully render (same
   `<footer>`-visible readiness signal `apps/e2e/tests/landing/responsive.spec.ts`
   uses).
4. Captures the fully-settled DOM (`page.content()`) and writes it as that
   route's static HTML:
   - `dist/index.html` (overwritten with real content, not the empty SPA shell)
   - `dist/careers/index.html`
   - `dist/careers/<slug>/index.html` — **one directory per vacancy**, so the
     clean URL `/careers/<slug>` (no trailing slash) resolves to it. See
     **"nginx requirement" below — this is the #1 thing that will silently
     defeat the whole pipeline if misconfigured.**
   - `dist/404.html`
5. Writes `dist/robots.txt` (allow-all + explicit sections for GPTBot,
   ClaudeBot, Claude-Web, PerplexityBot, Google-Extended, CCBot, Bytespider +
   a `Sitemap:` line) and `dist/sitemap.xml` (`/`, `/careers`, every
   `/careers/<slug>` with its own `lastmod` = `publishedAt`).

### Env vars

| Var                    | Default                     | Purpose                                                                                                                                                                                                     |
| ---------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PRERENDER_API_ORIGIN` | `https://cheekycheese.tech` | Where to fetch the vacancy list from (Node-side) AND the target the preview server's `/api` proxy uses while rendering (feeds `VITE_PROXY_API_TARGET`). Point this at a scratch API for local verification. |
| `PRERENDER_PORT`       | `4173`                      | Scratch port for the internal `vite preview()` instance used only during the prerender run.                                                                                                                 |

### JSON-LD (structured data)

Rather than a second, separate generator, structured data is produced by the
**same React components** that already render the page — `app/lib/seo.ts`
has the pure builder functions (`buildOrganizationJsonLd`, `buildWebSiteJsonLd`,
`buildJobPostingJsonLd`), and `app/lib/use-document-head.ts`'s `useDocumentHead()`
hook injects the result as a single `<script type="application/ld+json">` tag
(upserted on route change, removed on pages that pass none). Because this runs
as a normal React effect, it's present in BOTH the live SPA and whatever the
headless prerender snapshot captures — one source of truth, no drift.
`scripts/prerender.mjs` still does a **belt-and-suspenders runtime check**
(`assertJsonLd`) on the captured HTML of every page that's supposed to have
structured data, so a regression fails the build loudly instead of shipping
silently-broken JSON-LD.

- `/` — `Organization` + `WebSite`.
- `/careers/:slug` — `JobPosting` (Google Jobs). `jobLocationType: 'TELECOMMUTE'`
  - `applicantLocationRequirements: { name: 'Worldwide' }` — Google flags a
    TELECOMMUTE listing as an error in Search Console if
    `applicantLocationRequirements` is missing; "Worldwide" matches the
    business's actual remote-first, no-country-restriction hiring model.
    **No salary field, ever** — by product design (see
    `packages/shared/src/schemas/vacancies.ts` module doc), not an omission.

### Adding a new prerendered route

If a new static (non-data-driven) route is added (e.g. `/about`), add it to
the `routes` array in `buildRoutes()` in `scripts/prerender.mjs`
(`{ url: '/about', file: 'about/index.html', requireJsonLd: null }`) and give
the route's component a `canonical` (via `app/lib/seo.ts`'s `canonicalUrl()`)
through `useDocumentHead`. Data-driven routes (one page per row from an API,
like vacancies) follow the same pattern the vacancy loop already does.

## ⚠️ nginx requirement (DevOps — task-infra-seo-gates)

Prerendered pages are written as **`<route>/index.html`** (directory-index
convention), and the app's own canonical/internal URLs are the **clean form
without a trailing slash** (`/careers/senior-ml-engineer`, matching
TanStack Router's route paths exactly — see `app/lib/seo.ts` `canonicalUrl()`).

For a crawler (or Lighthouse, or a shared link) hitting that exact canonical
URL to actually receive the prerendered content instead of the empty SPA
shell, the web server MUST resolve extensionless paths to their directory's
`index.html` **before** falling back to the SPA shell, e.g.:

```nginx
location / {
  try_files $uri $uri/index.html $uri/ /index.html;
}
```

Verified locally against a server that does this correctly (see "Local
Lighthouse verification" below) — `vite preview`'s own built-in static server
does **NOT** do this (it SPA-falls-back on the very first extensionless-path
lookup, silently serving the homepage shell instead of the prerendered
vacancy page — this exact gap is what the trailing-slash / try_files ordering
above exists to close). Test any prod nginx config against this before
relying on it.

## Perf (task-landing-seo-prerender.md §3)

- **Inter + JetBrains Mono are self-hosted** (`public/fonts/*.woff2`,
  `@font-face` in `app/styles/globals.css`), not Google Fonts CDN — collapses
  "fetch CSS from googleapis.com, then fetch the font file from gstatic.com"
  into one same-origin fetch. Inter is `<link rel="preload">`ed in
  `index.html` (it's the hero H1's — the LCP element's — font); JetBrains
  Mono is not (terminal/eyebrow labels only, never the LCP element).
- **Route-level code splitting**: `TanStackRouterVite({ autoCodeSplitting: true })`
  in `vite.config.ts` — each route's component/loader is its own chunk, so
  e.g. `react-markdown`/`remark-gfm` (only used by `/careers/:slug`) never
  loads on `/`. Additional `build.rollupOptions.output.manualChunks` splits
  the shared vendor libs actually used on every route (react, react-dom,
  @tanstack/react-router) into their own cacheable chunks — deliberately NOT
  a catch-all `vendor-misc` bucket (that would defeat the per-route splitting
  above by pulling everything into one shared chunk again).
- **Cloudflare Turnstile is lazy** (`app/lib/use-turnstile.ts`): the widget
  script is injected by the hook itself, not a static `index.html` tag, and
  only once the apply-form container is within 200px of the viewport
  (`IntersectionObserver`) — it's only ever used on `/careers/:slug`, and
  usually below the fold there too.
- **Mobile nav disclosure uses a plain CSS `grid-template-rows` transition**,
  not framer-motion (`app/components/marketing/nav.tsx`) — `MarketingNav`
  renders on every route, so a top-level `framer-motion` import there put its
  ~40 KB gzip vendor chunk in the critical path of `/careers` and
  `/careers/:slug`, which otherwise have zero framer-motion usage at all (`/`
  keeps it — `routes/index.tsx`'s scroll-reveal effect needs it directly).
  Trade-off: the panel opens with a smooth transition but closes instantly
  (no exit animation) — see the file's module doc for why that's an
  acceptable trade for a mobile burger menu.
- **`scripts/prerender.mjs` prunes stale `<link rel="modulepreload">` hints**
  per route before capturing. Vite computes ONE `modulepreload` manifest for
  `dist/index.html` covering the client entry's full static graph (this
  includes `/`-only dependencies like the framer-motion vendor chunk); since
  every route is captured by navigating from that same base document, every
  prerendered page would otherwise inherit `/`'s full preload set regardless
  of what it actually uses. The prerender script strips those tags from each
  route's document response before capture, letting the browser's normal
  module loader (and Vite's own runtime `__vitePreload` for whatever a
  route's lazy chunk actually dynamically imports) populate `<head>` with
  only what that specific route needs.

### Local Lighthouse verification

`vite preview`'s SPA-fallback does not resolve extension-less clean URLs to
their directory `index.html` (see the nginx section above) and does not gzip
responses — running Lighthouse against it directly gives a misleadingly
pessimistic/incorrect score. Verify locally against a static server that (a)
tries `<path>/index.html` before SPA-falling-back and (b) gzips text assets,
e.g. nginx itself, or a small script emulating both — then:

```bash
npx lighthouse http://localhost:<port>/ \
  --output=json,html --output-path=./report \
  --chrome-flags="--headless=new" \
  --only-categories=performance,accessibility,best-practices,seo
# add --preset=desktop for the desktop profile
```
