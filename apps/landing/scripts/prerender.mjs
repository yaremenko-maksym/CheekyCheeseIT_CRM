#!/usr/bin/env node
/**
 * apps/landing/scripts/prerender.mjs — task-landing-seo-prerender.md.
 *
 * Post-`vite build` static-prerender step for the landing SPA
 * (`build:prerender` = `vite build && node scripts/prerender.mjs`).
 *
 * WHY a headless-browser snapshot (not a Node-side SSR render): the landing
 * is a plain client-only Vite SPA (no TanStack Start / server entry point,
 * see `app/lib/use-document-head.ts` module doc), so there is no
 * `renderToString()` path. Instead this script:
 *
 *   1. Serves the already-built `dist/` via Vite's own `preview()` server
 *      (real static file serving + `/api` proxy, identical to `pnpm start`).
 *   2. Drives a real headless Chromium (Playwright) to each route, letting
 *      the SPA mount + fetch + render exactly as a user's browser would.
 *   3. Captures the fully-settled DOM (`page.content()`) and writes it as
 *      the route's static `index.html` — same `<script>`/`<link>` tags the
 *      browser already loaded, so the client `createRoot()` render on top of
 *      it is a same-markup re-render, not a hydration mismatch (task §1).
 *
 * AI/search crawlers that do not execute JS (GPTBot, ClaudeBot,
 * PerplexityBot, ...) get the exact same DOM a real visitor sees, because it
 * genuinely *was* that DOM at the moment of capture — not a re-derived
 * approximation.
 */
import { preview } from 'vite'
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DIST = path.join(ROOT, 'dist')

// Keep in sync with app/lib/seo.ts SITE_ORIGIN — see that file's module doc
// for why this one literal is duplicated instead of shared via import (this
// is a plain Node ESM script, not part of the Vite/TS build graph).
const SITE_ORIGIN = 'https://cheekycheese.tech'

const API_ORIGIN = process.env['PRERENDER_API_ORIGIN'] ?? SITE_ORIGIN
const PORT = Number(process.env['PRERENDER_PORT'] ?? 4173)

/**
 * @typedef {{ slug: string, publishedAt: string }} VacancyListItem
 * @typedef {{ url: string, file: string, requireJsonLd: 'organization+website' | 'job-posting' | null }} PrerenderRoute
 */

function warn(message) {
  // `::warning::` — native GHA annotation, matches the convention already
  // used elsewhere in this repo's CI-facing scripts.
  console.log(`::warning::prerender: ${message}`)
}

// ---------------------------------------------------------------------------
// 1. Fetch the PUBLISHED vacancy list (drives which /careers/:slug pages get
//    prerendered + sitemap entries). Failure here is non-fatal — the task
//    explicitly requires the build not to fail when the API is unreachable;
//    the live SPA still fetches this client-side for real visitors.
// ---------------------------------------------------------------------------
/** @returns {Promise<VacancyListItem[] | null>} `null` means the API was unreachable. */
async function fetchVacancies() {
  try {
    const res = await fetch(`${API_ORIGIN}/api/public/vacancies`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!Array.isArray(data)) throw new Error('response is not an array')
    return data
  } catch (err) {
    warn(
      `could not fetch vacancies from ${API_ORIGIN}/api/public/vacancies (${err.message}) — ` +
        'building without per-slug vacancy pages; the live SPA still fetches them client-side.',
    )
    return null
  }
}

/**
 * @param {VacancyListItem[] | null} vacancies
 * @returns {PrerenderRoute[]}
 */
function buildRoutes(vacancies) {
  const routes = [
    { url: '/', file: 'index.html', requireJsonLd: 'organization+website' },
    { url: '/careers', file: 'careers/index.html', requireJsonLd: null },
  ]
  for (const v of vacancies ?? []) {
    routes.push({
      url: `/careers/${v.slug}`,
      file: `careers/${v.slug}/index.html`,
      requireJsonLd: 'job-posting',
    })
  }
  return routes
}

// ---------------------------------------------------------------------------
// 2. JSON-LD structural validation (task §2 "валидируй структуру против
//    schema.org") — a belt-and-suspenders runtime check on top of the unit
//    tests in app/__tests__/seo.spec.ts: parse the *actual* captured HTML's
//    <script type="application/ld+json"> and assert the required fields are
//    really there. Catches a real regression (e.g. useDocumentHead silently
//    broken) at build time instead of shipping bad structured data.
// ---------------------------------------------------------------------------
/**
 * @param {string} html
 * @returns {unknown}
 */
function extractJsonLd(html) {
  // Matched by `id="seo-json-ld"` (stable, see use-document-head.ts
  // JSON_LD_ELEMENT_ID) rather than by attribute order — the DOM serializer
  // emits attributes in `setAttribute()` call order (`id` before `type`),
  // which a naive `<script type="...">`-first regex would miss.
  const match = html.match(/<script id="seo-json-ld"[^>]*>([\s\S]*?)<\/script>/)
  if (!match) return null
  return JSON.parse(match[1])
}

/**
 * @param {string} html
 * @param {PrerenderRoute} route
 * @returns {void}
 */
function assertJsonLd(html, route) {
  if (route.requireJsonLd === null) return
  const data = extractJsonLd(html)
  if (route.requireJsonLd === 'organization+website') {
    if (!Array.isArray(data) || data.length !== 2) {
      throw new Error(`prerender: expected an Organization+WebSite JSON-LD array on ${route.url}`)
    }
    const types = data.map((entry) => entry['@type'])
    if (!types.includes('Organization') || !types.includes('WebSite')) {
      throw new Error(`prerender: JSON-LD on ${route.url} is missing Organization/WebSite`)
    }
  }
  if (route.requireJsonLd === 'job-posting') {
    if (!data || data['@type'] !== 'JobPosting') {
      throw new Error(`prerender: missing/invalid JobPosting JSON-LD on ${route.url}`)
    }
    if (data.jobLocationType !== 'TELECOMMUTE' || !data.applicantLocationRequirements) {
      throw new Error(
        `prerender: JobPosting on ${route.url} must set jobLocationType=TELECOMMUTE + ` +
          'applicantLocationRequirements (Google Jobs requirement for remote roles)',
      )
    }
    if (!data.title || !data.datePosted || !data.hiringOrganization?.name) {
      throw new Error(`prerender: JobPosting on ${route.url} is missing a required field`)
    }
  }
}

// ---------------------------------------------------------------------------
// 3. robots.txt + sitemap.xml (task §2) — plain static files, no React page
//    exists for these, so they are generated directly here.
// ---------------------------------------------------------------------------
const AI_CRAWLERS = [
  'GPTBot',
  'ClaudeBot',
  'Claude-Web',
  'PerplexityBot',
  'Google-Extended',
  'CCBot',
  'Bytespider',
]

/** @returns {string} */
function buildRobotsTxt() {
  const lines = ['User-agent: *', 'Allow: /', '']
  for (const bot of AI_CRAWLERS) {
    lines.push(`User-agent: ${bot}`, 'Allow: /', '')
  }
  lines.push(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`)
  return lines.join('\n') + '\n'
}

function xmlEscape(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * @param {VacancyListItem[] | null} vacancies
 * @param {string} buildTime
 * @returns {string}
 */
function buildSitemapXml(vacancies, buildTime) {
  // Trailing-slash-terminated — matches app/lib/seo.ts canonicalUrl() /
  // router.tsx trailingSlash: 'always' (see that file's comment for why):
  // sitemap URLs should be the exact canonical/200 form, not one that 301s.
  const urls = [
    { loc: `${SITE_ORIGIN}/`, lastmod: buildTime },
    { loc: `${SITE_ORIGIN}/careers/`, lastmod: buildTime },
    ...(vacancies ?? []).map((v) => ({
      loc: `${SITE_ORIGIN}/careers/${v.slug}/`,
      lastmod: v.publishedAt,
    })),
  ]
  const body = urls
    .map(
      (u) =>
        `  <url>\n    <loc>${xmlEscape(u.loc)}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n  </url>`,
    )
    .join('\n')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `${body}\n` +
    '</urlset>\n'
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`prerender: ${DIST}/index.html not found — run "vite build" first`)
  }

  const vacancies = await fetchVacancies()
  const routes = buildRoutes(vacancies)

  // Feeds vite.config.ts's `preview.proxy['/api'].target` (same
  // VITE_PROXY_API_TARGET override pattern as apps/web) so the SPA's
  // client-side loaders resolve real vacancy data while every route is
  // rendered headlessly, not just the Node-side fetch above.
  process.env['VITE_PROXY_API_TARGET'] = API_ORIGIN

  // `browser`/`server` are declared here (not `const` inside the try) and
  // guarded with `?.` in `finally` — PR #398 review HIGH: the previous
  // version awaited `preview()` and `chromium.launch()` OUTSIDE any
  // try/finally, so a failure in either (e.g. `chromium.launch()` throwing
  // because CI never installed browser binaries) skipped the `finally` that
  // closes the already-listening preview server. That open HTTP handle kept
  // the event loop alive — `process.exitCode = 1` in the top-level `.catch()`
  // below is only a *hint*, not a `process.exit()`, so the process never
  // actually terminated; it hung until the CI job's own 10-minute timeout
  // force-killed it (~9m40s of pure hang after the error). Browser is
  // launched FIRST, deliberately: if a browser-binary problem is the failure
  // (the actual CI root cause), the preview server never even starts, so
  // there is nothing to clean up.
  let browser
  let server
  try {
    browser = await chromium.launch()
    server = await preview({
      root: ROOT,
      configFile: path.join(ROOT, 'vite.config.ts'),
      preview: { port: PORT, strictPort: true, host: '127.0.0.1' },
    })
    const baseUrl = `http://127.0.0.1:${PORT}`

    const page = await browser.newPage()

    // `dist/index.html` (the SPA's one build-time HTML template) carries a
    // FIXED `<link rel="modulepreload">` list computed from Vite's static
    // analysis of the client entry graph — it includes `/`'s own
    // dependencies (e.g. vendor-motion for the home-only Reveal effect)
    // regardless of which route actually gets served through it. Every
    // route we snapshot starts from THIS SAME document (there's no
    // prerendered file at that path yet — that's what we're creating), so
    // without this, every static page we write would inherit home's full
    // preload set and force-fetch chunks it never uses (confirmed via
    // Lighthouse: vendor-motion showing up on `/careers/:slug` network
    // waterfalls despite no framer-motion import left on that route).
    // Stripping the stale hints here lets the browser's normal module
    // loader — and Vite's own runtime `__vitePreload` helper for whatever a
    // route's `Route.lazy()` chunk *actually* dynamically imports — populate
    // `<head>` with only what that specific route needs, which is exactly
    // what `page.content()` below then captures.
    await page.route('**/*', async (route) => {
      if (route.request().resourceType() !== 'document') return route.continue()
      const response = await route.fetch()
      const body = (await response.text()).replace(/<link rel="modulepreload"[^>]*>\s*/g, '')
      return route.fulfill({ response, body })
    })

    // Freezes the terminal typewriter + Reveal scroll-in animations in their
    // final, fully-visible state (both already gate on framer-motion's
    // useReducedMotion() — see terminal.tsx / routes/index.tsx) so the
    // snapshot never lands on a half-typed / opacity:0 frame (task §1
    // "Пререндер-гард"). Same technique apps/e2e/tests/landing/responsive.spec.ts
    // uses for the identical class of problem.
    await page.emulateMedia({ reducedMotion: 'reduce' })

    // NOTE: deliberately NOT `waitUntil: 'networkidle'` — the vacancy detail
    // page embeds the live Cloudflare Turnstile widget (VacancyApplyForm),
    // which keeps its own background connections going and can make
    // "no network activity for 500ms" never true, timing out the snapshot.
    // Waiting for `<footer>` (the last element every route mounts, once its
    // loader data has resolved and rendered — same signal
    // apps/e2e/tests/landing/responsive.spec.ts's `gotoStable()` uses) is the
    // real readiness gate here, not the network.
    for (const route of routes) {
      await page.goto(`${baseUrl}${route.url}`)
      await page.waitForSelector('footer', { state: 'visible' })
      const html = await page.content()
      assertJsonLd(html, route)

      const outPath = path.join(DIST, route.file)
      await mkdir(path.dirname(outPath), { recursive: true })
      await writeFile(outPath, html, 'utf8')
      console.log(`prerender: wrote ${path.relative(DIST, outPath)}`)
    }

    // 404.html — a path guaranteed to match no route triggers the root
    // `notFoundComponent` (see routes/__root.tsx).
    await page.goto(`${baseUrl}/__prerender-404-marker__`)
    await page.waitForSelector('footer', { state: 'visible' })
    const notFoundHtml = await page.content()
    await writeFile(path.join(DIST, '404.html'), notFoundHtml, 'utf8')
    console.log('prerender: wrote 404.html')
  } finally {
    // Guarded with `?.`/truthiness checks on purpose — this must run (and
    // succeed) no matter which of `chromium.launch()` / `preview()` / the
    // render loop threw, including the case where `browser` was never
    // assigned at all (launch itself failed).
    await browser?.close()
    const httpServer = server?.httpServer
    if (httpServer) {
      await new Promise((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve(undefined)))
      })
    }
  }

  const buildTime = new Date().toISOString()
  await writeFile(path.join(DIST, 'robots.txt'), buildRobotsTxt(), 'utf8')
  await writeFile(path.join(DIST, 'sitemap.xml'), buildSitemapXml(vacancies, buildTime), 'utf8')
  console.log('prerender: wrote robots.txt, sitemap.xml')

  // Sanity echo — lets a CI log reader see at a glance whether vacancy pages
  // were actually produced this run (0 is a valid, non-failing outcome).
  console.log(
    `prerender: done — ${routes.length - 2} vacancy page(s) prerendered (API ${vacancies === null ? 'unreachable' : 'reachable, ' + vacancies.length + ' PUBLISHED'}).`,
  )
}

// Only run the full build pipeline when executed directly (`node
// scripts/prerender.mjs`) — NOT when imported, so
// app/__tests__/prerender-seo.spec.ts can import the pure helpers below
// (buildRobotsTxt/buildSitemapXml/...) without booting a browser + preview
// server as a side effect of the import itself.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((err) => {
      console.error(err)
      process.exitCode = 1
    })
    .finally(() => {
      // Defense-in-depth (PR #398 review HIGH): `main()`'s own try/finally
      // now always closes the browser + preview server on every failure
      // path, so this should be a no-op in practice — but `process.exitCode`
      // alone only *hints* an exit code once the event loop naturally
      // drains; it does not force termination. If some future change (or an
      // untested Playwright/Vite edge case) leaves ANY handle open, this
      // guarantees the process still exits instead of hanging until a CI
      // job's timeout-minutes kills it (the actual failure mode that caused
      // the ~10-minute hang this fixes).
      process.exit(process.exitCode ?? 0)
    })
}

// Re-exported for app/__tests__/prerender-seo.spec.ts (plain Node module —
// Vitest can import .mjs directly, no build step needed).
export { buildRobotsTxt, buildSitemapXml, buildRoutes, extractJsonLd, assertJsonLd }
