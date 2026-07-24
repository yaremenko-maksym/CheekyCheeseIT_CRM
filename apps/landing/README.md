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

## URLs are trailing-slash-terminated on purpose

Prerendered pages are written as **`<route>/index.html`** (directory-index
convention — `/careers/<slug>` → `dist/careers/<slug>/index.html`). Prod
nginx (`nginx/conf.d/landing.conf`, `try_files $uri $uri/ /index.html;`)
resolves a **trailing-slash** directory request straight to that file with a
200 — but a request WITHOUT the trailing slash first gets an HTTP 301 to the
slash form (verified empirically: `nginx:alpine` in Docker against this
repo's actual `dist/` output + `try_files $uri $uri/ /index.html;` returns
`301` for `/careers/<slug>` and `200` with full content for
`/careers/<slug>/`— this is standard nginx directory-index behavior, not a
bug in `landing.conf`).

To make sure NO real visit — internal `<Link>` navigation, a crawler request,
or Lighthouse — ever pays that redirect hop, the app is configured to only
ever produce/expect the trailing-slash form in the first place:

- `app/router.tsx` sets `trailingSlash: 'always'` on the TanStack Router
  instance (this is also enforced at the type level — `<Link to="/careers">`
  without the slash is a **type error**, not just a lint nit).
- `app/lib/seo.ts` `canonicalUrl()` always appends a trailing slash.
- `scripts/prerender.mjs`'s `sitemap.xml` URLs match.

So the canonical URL declared on every page is exactly the URL nginx serves
as a 200 — never one that redirects.

## Local Lighthouse / clean-URL verification vs `vite preview`

`vite preview`'s own built-in static server does **NOT** reproduce either of
the above (no directory→trailing-slash redirect, no gzip) — running
Lighthouse or a clean-URL curl check against it directly gives a misleadingly
low/incorrect score (confirmed while building this pipeline: the exact same
`dist/` scored Performance 65-70 through `vite preview`'s fallback vs 93+
through a server that actually gzips and gives every route its own
`modulepreload` set). Verify locally against something closer to prod, e.g.
a throwaway nginx container mounting `dist/` + a trimmed copy of
`landing.conf`'s `location /` block, or `docker build --target
landing-builder` end to end.

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

### Running Lighthouse locally

See "Local Lighthouse / clean-URL verification vs `vite preview`" above for
why the server matters, then:

```bash
npx lighthouse http://localhost:<port>/careers/senior-ml-engineer/ \
  --output=json,html --output-path=./report \
  --chrome-flags="--headless=new" \
  --only-categories=performance,accessibility,best-practices,seo
# add --preset=desktop for the desktop profile
```
