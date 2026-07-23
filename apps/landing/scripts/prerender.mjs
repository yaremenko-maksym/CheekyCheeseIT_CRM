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
function extractJsonLd(html) {
  // Matched by `id="seo-json-ld"` (stable, see use-document-head.ts
  // JSON_LD_ELEMENT_ID) rather than by attribute order — the DOM serializer
  // emits attributes in `setAttribute()` call order (`id` before `type`),
  // which a naive `<script type="...">`-first regex would miss.
  const match = html.match(/<script id="seo-json-ld"[^>]*>([\s\S]*?)<\/script>/)
  if (!match) return null
  return JSON.parse(match[1])
}

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

function buildSitemapXml(vacancies, buildTime) {
  const urls = [
    { loc: `${SITE_ORIGIN}/`, lastmod: buildTime },
    { loc: `${SITE_ORIGIN}/careers`, lastmod: buildTime },
    ...(vacancies ?? []).map((v) => ({
      loc: `${SITE_ORIGIN}/careers/${v.slug}`,
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

  const server = await preview({
    root: ROOT,
    configFile: path.join(ROOT, 'vite.config.ts'),
    preview: { port: PORT, strictPort: true, host: '127.0.0.1' },
  })
  const baseUrl = `http://127.0.0.1:${PORT}`

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
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
    await browser.close()
    await new Promise((resolve, reject) => {
      const httpServer = server.httpServer
      if (!httpServer) return resolve(undefined)
      httpServer.close((err) => (err ? reject(err) : resolve(undefined)))
    })
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
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}

// Re-exported for app/__tests__/prerender-seo.spec.ts (plain Node module —
// Vitest can import .mjs directly, no build step needed).
export { buildRobotsTxt, buildSitemapXml, buildRoutes, extractJsonLd, assertJsonLd }
