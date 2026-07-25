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

// Keep in sync with app/i18n/locale.ts LOCALES/DEFAULT_LOCALE — same
// duplication rationale as SITE_ORIGIN above (plain Node ESM script, cannot
// import a `.ts` module with `as const`/type syntax without a build step).
// task-landing-i18n.md — owner scope-change 2026-07-25: 5 locales.
const LOCALES = ['en', 'uk', 'ru', 'es', 'pt']
const DEFAULT_LOCALE = 'en'

/** @param {string} locale @returns {string} `''` for `en`, `/uk` etc otherwise. */
function localePrefix(locale) {
  return locale === DEFAULT_LOCALE ? '' : `/${locale}`
}

/**
 * @typedef {{ slug: string, publishedAt: string, translations?: Record<string, { title: string, description: string }> | null }} VacancyListItem
 * @typedef {{ url: string, file: string, locale?: string, requireJsonLd: 'organization+website' | 'item-list' | 'job-posting-breadcrumb' | null }} PrerenderRoute
 */

/**
 * Mirrors `app/lib/vacancy-i18n.ts` `vacancyHreflangExcludes` (plain-Node
 * ESM duplication, same rationale as SITE_ORIGIN/LOCALES above) — locales
 * with no real translation for this vacancy (plan §3/A10). Pre-Block-C
 * (no `translations` field in the API response yet), this safely excludes
 * EVERY non-default locale, matching the client-side fallback behavior.
 *
 * @param {VacancyListItem} vacancy
 * @returns {string[]}
 */
function vacancyHreflangExcludes(vacancy) {
  return LOCALES.filter((locale) => locale !== DEFAULT_LOCALE && !vacancy.translations?.[locale])
}

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
 * task-landing-i18n.md (plan §1/§4 A1/A8) — one home + careers-list + one
 * per-vacancy detail route PER LOCALE. Matches the 5 parallel route files
 * (`app/routes/index.tsx` (en) + `uk.tsx`/`ru.tsx`/`es.tsx`/`pt.tsx` and
 * their `.careers`/`.careers_.$slug` siblings) — `en` is unprefixed
 * (`/`, `careers/index.html`), every other locale is `/<locale>/...`
 * (`<locale>/index.html`, `<locale>/careers/index.html`, ...).
 *
 * @param {VacancyListItem[] | null} vacancies
 * @returns {PrerenderRoute[]}
 */
function buildRoutes(vacancies) {
  // Matches app/routes/careers.tsx's own `vacancies.length > 0 ? buildItemListJsonLd(...) : undefined`
  // — an ItemList with zero items has nothing useful to tell a crawler.
  const hasVacancies = (vacancies?.length ?? 0) > 0
  /** @type {PrerenderRoute[]} */
  const routes = []
  for (const locale of LOCALES) {
    const prefix = localePrefix(locale)
    const filePrefix = locale === DEFAULT_LOCALE ? '' : `${locale}/`
    routes.push({
      url: prefix === '' ? '/' : prefix,
      file: `${filePrefix}index.html`,
      locale,
      requireJsonLd: 'organization+website',
    })
    routes.push({
      url: `${prefix}/careers`,
      file: `${filePrefix}careers/index.html`,
      locale,
      requireJsonLd: hasVacancies ? 'item-list' : null,
    })
    for (const v of vacancies ?? []) {
      routes.push({
        url: `${prefix}/careers/${v.slug}`,
        file: `${filePrefix}careers/${v.slug}/index.html`,
        locale,
        requireJsonLd: 'job-posting-breadcrumb',
      })
    }
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
 * `waitForSelector('footer', {state:'visible'})` alone is NOT a sufficient
 * readiness signal: every route renders a `<footer>`, including BOTH
 * not-found states (root `notFoundComponent` and the vacancy-slug
 * `NotFoundState`) — the DOM committing (footer visible) and React's
 * PASSIVE effects for that same render actually finishing (title/canonical/
 * robots/JSON-LD — all set inside `useDocumentHead`'s `useEffect`) are two
 * separate moments. A real CI run captured this exact race: `/` (which
 * requires index,follow + Organization/WebSite JSON-LD) was written to
 * `dist/index.html` with valid JSON-LD from a real render (so
 * `assertJsonLd` below did NOT catch it) alongside `notFoundComponent`'s
 * "Page not found" body text and a `noindex, nofollow` robots meta — i.e.
 * `page.content()` was called in the gap between two renders' committed DOM
 * and settled effects. This gate alone turned out to be insufficient on its
 * own (the identical symptom recurred on the very next CI run after adding
 * it) — kept as a first-line wait, but `captureRoute()` below now also
 * validates the ALREADY-CAPTURED html string and retries with a brand-new
 * page if it does not match, instead of trusting this wait alone.
 *
 * @param {import('playwright').Page} page
 * @param {boolean} expectNoindex
 * @returns {Promise<void>}
 */
async function waitForDocumentHeadSettled(page, expectNoindex) {
  await page.waitForSelector('footer', { state: 'visible' })
  await page.waitForFunction(
    (expected) => {
      const meta = document.querySelector('meta[name="robots"]')
      if (!meta) return false
      const isNoindex = (meta.getAttribute('content') ?? '').includes('noindex')
      return isNoindex === expected
    },
    expectNoindex,
    { timeout: 10_000 },
  )
}

/**
 * Belt-and-suspenders check on the ALREADY-SERIALIZED html string (the
 * exact bytes about to be written to disk / handed to Lighthouse) — not the
 * live DOM `waitForDocumentHeadSettled` polled a moment earlier. See that
 * function's doc for why a pre-capture wait alone was not enough.
 *
 * @param {string} html
 * @param {boolean} expectNoindex
 * @param {string} label
 * @returns {void}
 */
function assertRobotsMeta(html, expectNoindex, label) {
  const match = html.match(/<meta name="robots" content="([^"]*)"/)
  const isNoindex = (match?.[1] ?? '').includes('noindex')
  if (isNoindex !== expectNoindex) {
    throw new Error(
      `prerender: captured robots meta for ${label} does not match expected noindex=${expectNoindex} ` +
        `(got ${match ? `"${match[1]}"` : 'no <meta name="robots"> tag at all'})`,
    )
  }
}

/**
 * task-landing-i18n.md (plan §4 A5) — `<html lang>` must match the route's
 * locale in the CAPTURED static file, same belt-and-suspenders pattern as
 * `assertRobotsMeta` (checks the already-serialized HTML string, not the
 * live DOM `useDocumentHead`'s effect wrote a moment earlier).
 *
 * @param {string} html
 * @param {string} expectedLang
 * @param {string} label
 * @returns {void}
 */
function assertHtmlLang(html, expectedLang, label) {
  const match = html.match(/<html[^>]*\blang="([^"]*)"/)
  if (match?.[1] !== expectedLang) {
    throw new Error(
      `prerender: captured <html lang> for ${label} is "${match?.[1] ?? '(missing)'}", expected "${expectedLang}"`,
    )
  }
}

/**
 * Same document-request interceptor + reduced-motion emulation every
 * captured page needs (see the inline comments at the two call sites this
 * replaces for the full rationale) — factored out so `captureRoute()` can
 * apply it fresh to EVERY retry's brand-new `page`, not just once.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<void>}
 */
async function preparePage(page) {
  // `dist/index.html` (the SPA's one build-time HTML template) carries a
  // FIXED `<link rel="modulepreload">` list computed from Vite's static
  // analysis of the client entry graph — it includes `/`'s own dependencies
  // (e.g. vendor-motion for the home-only Reveal effect) regardless of
  // which route actually gets served through it. Stripping the stale hints
  // here lets the browser's normal module loader — and Vite's own runtime
  // `__vitePreload` helper for whatever a route's `Route.lazy()` chunk
  // *actually* dynamically imports — populate `<head>` with only what that
  // specific route needs (confirmed via Lighthouse: vendor-motion showing
  // up on `/careers/:slug` network waterfalls despite no framer-motion
  // import left on that route otherwise).
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
  // "Пререндер-гард"). Same technique
  // apps/e2e/tests/landing/responsive.spec.ts uses for the identical class
  // of problem.
  await page.emulateMedia({ reducedMotion: 'reduce' })
}

const MAX_CAPTURE_ATTEMPTS = 3

/**
 * Renders one route to its final static HTML, on a FRESH `browser.newPage()`
 * every attempt — never a page reused across routes or retries, so no
 * capture can possibly inherit ANY state (DOM, in-flight navigation,
 * pending effect) left over by a previous one. Validates the result
 * (`assertRobotsMeta` + `assertJsonLd`) before trusting it; on failure,
 * closes that page outright and tries again on a brand-new one, up to
 * `MAX_CAPTURE_ATTEMPTS` times, only throwing once every attempt has failed
 * (see `waitForDocumentHeadSettled`'s doc for the CI-only symptom this
 * defends against).
 *
 * @param {import('playwright').Browser} browser
 * @param {string} baseUrl
 * @param {string} url - path to navigate to, e.g. `/careers` or the 404 marker
 * @param {boolean} expectNoindex
 * @param {PrerenderRoute | null} route - null for the 404 marker capture (no JSON-LD requirement)
 * @returns {Promise<string>}
 */
async function captureRoute(browser, baseUrl, url, expectNoindex, route) {
  const label = route?.url ?? url
  // route.locale is undefined for the 404-marker capture (route === null) —
  // `useDocumentHead`'s own `htmlLang` default is `en` (DEFAULT_LOCALE), so
  // that's the correct expectation there too (task-landing-i18n.md, A5).
  const expectedLang = route?.locale ?? DEFAULT_LOCALE
  /** @type {unknown} */
  let lastError
  for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt++) {
    const page = await browser.newPage()
    try {
      await preparePage(page)
      await page.goto(`${baseUrl}${url}`)
      await waitForDocumentHeadSettled(page, expectNoindex)
      const html = await page.content()
      assertRobotsMeta(html, expectNoindex, label)
      assertHtmlLang(html, expectedLang, label)
      if (route) assertJsonLd(html, route)
      return html
    } catch (err) {
      lastError = err
      warn(
        `capture attempt ${attempt}/${MAX_CAPTURE_ATTEMPTS} for ${label} failed ` +
          `(${err instanceof Error ? err.message : String(err)}) — retrying with a fresh page`,
      )
    } finally {
      await page.close()
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(
    `prerender: could not capture a valid ${label} after ${MAX_CAPTURE_ATTEMPTS} attempts: ${reason}`,
  )
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
    return
  }

  if (route.requireJsonLd === 'item-list') {
    if (
      !data ||
      data['@type'] !== 'ItemList' ||
      !Array.isArray(data.itemListElement) ||
      data.itemListElement.length === 0
    ) {
      throw new Error(`prerender: expected a non-empty ItemList JSON-LD on ${route.url}`)
    }
    return
  }

  if (route.requireJsonLd === 'job-posting-breadcrumb') {
    if (!Array.isArray(data) || data.length !== 2) {
      throw new Error(
        `prerender: expected a JobPosting+BreadcrumbList JSON-LD array on ${route.url}`,
      )
    }
    const jobPosting = data.find((entry) => entry['@type'] === 'JobPosting')
    const breadcrumb = data.find((entry) => entry['@type'] === 'BreadcrumbList')
    if (!jobPosting) throw new Error(`prerender: missing JobPosting JSON-LD on ${route.url}`)
    if (!breadcrumb) throw new Error(`prerender: missing BreadcrumbList JSON-LD on ${route.url}`)

    // jobLocationType is OPTIONAL now (only set for remote roles, see
    // app/lib/seo.ts parseRemoteLocation) — but Google flags TELECOMMUTE
    // without applicantLocationRequirements as a Search Console error, so
    // when it IS present the pairing is still mandatory.
    if (jobPosting.jobLocationType !== undefined) {
      if (
        jobPosting.jobLocationType !== 'TELECOMMUTE' ||
        !jobPosting.applicantLocationRequirements
      ) {
        throw new Error(
          `prerender: JobPosting on ${route.url} must pair jobLocationType=TELECOMMUTE with ` +
            'applicantLocationRequirements (Google Jobs requirement for remote roles)',
        )
      }
    }
    if (!jobPosting.title || !jobPosting.datePosted || !jobPosting.hiringOrganization?.name) {
      throw new Error(`prerender: JobPosting on ${route.url} is missing a required field`)
    }
    if (!jobPosting.validThrough) {
      throw new Error(`prerender: JobPosting on ${route.url} is missing validThrough`)
    }
    if (jobPosting.directApply !== true) {
      throw new Error(`prerender: JobPosting on ${route.url} must set directApply: true`)
    }
    // Full HTML description, not a truncated snippet (owner decision
    // 2026-07-24) — 20 chars is a low floor just to catch "empty/missing",
    // not a real length policy.
    if (!jobPosting.description || jobPosting.description.length < 20) {
      throw new Error(`prerender: JobPosting on ${route.url} description looks too short/missing`)
    }

    if (!Array.isArray(breadcrumb.itemListElement) || breadcrumb.itemListElement.length !== 3) {
      throw new Error(
        `prerender: BreadcrumbList on ${route.url} must have exactly 3 items (Home -> Careers -> title)`,
      )
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

/** @param {string} locale @param {string} path - root-relative, e.g. `/careers/foo` (no trailing slash) @returns {string} absolute, trailing-slash-terminated URL. */
function localizedUrl(locale, path) {
  const prefix = localePrefix(locale)
  if (path === '/') return `${SITE_ORIGIN}${prefix === '' ? '/' : `${prefix}/`}`
  return `${SITE_ORIGIN}${prefix}${path}/`
}

/**
 * task-landing-i18n.md (plan §4 A7) — every `<url>` carries an
 * `<xhtml:link rel="alternate">` per locale (excluding `excludeLocales`,
 * plan §3/A10) plus `x-default` -> the `en` URL, same reciprocal cluster
 * `app/lib/seo.ts` `buildHreflangAlternates()` builds for the live
 * `<head>` tags — kept in sync by construction (both iterate `LOCALES`).
 *
 * @param {string} path
 * @param {string[]} excludeLocales
 * @returns {string}
 */
function buildXhtmlAlternates(path, excludeLocales) {
  const links = LOCALES.filter((l) => !excludeLocales.includes(l)).map(
    (l) =>
      `    <xhtml:link rel="alternate" hreflang="${l}" href="${xmlEscape(localizedUrl(l, path))}" />`,
  )
  links.push(
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${xmlEscape(localizedUrl(DEFAULT_LOCALE, path))}" />`,
  )
  return links.join('\n')
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
  /** @type {{ loc: string, lastmod: string, alternates: string }[]} */
  const urls = []
  for (const locale of LOCALES) {
    urls.push({
      loc: localizedUrl(locale, '/'),
      lastmod: buildTime,
      alternates: buildXhtmlAlternates('/', []),
    })
    urls.push({
      loc: localizedUrl(locale, '/careers'),
      lastmod: buildTime,
      alternates: buildXhtmlAlternates('/careers', []),
    })
    for (const v of vacancies ?? []) {
      urls.push({
        loc: localizedUrl(locale, `/careers/${v.slug}`),
        lastmod: v.publishedAt,
        alternates: buildXhtmlAlternates(`/careers/${v.slug}`, vacancyHreflangExcludes(v)),
      })
    }
  }
  const body = urls
    .map(
      (u) =>
        `  <url>\n    <loc>${xmlEscape(u.loc)}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n${u.alternates}\n  </url>`,
    )
    .join('\n')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
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

    // NOTE: deliberately NOT `waitUntil: 'networkidle'` — the vacancy detail
    // page embeds the live Cloudflare Turnstile widget (VacancyApplyForm),
    // which keeps its own background connections going and can make
    // "no network activity for 500ms" never true, timing out the snapshot.
    // `waitForDocumentHeadSettled` (not just `<footer>` — see its own doc)
    // is the real readiness gate here, not the network. Each route gets its
    // own fresh `page` via `captureRoute()` — see that function's doc for
    // why (a CI-only capture-race this defends against).
    for (const route of routes) {
      const html = await captureRoute(browser, baseUrl, route.url, false, route)

      const outPath = path.join(DIST, route.file)
      await mkdir(path.dirname(outPath), { recursive: true })
      await writeFile(outPath, html, 'utf8')
      console.log(`prerender: wrote ${path.relative(DIST, outPath)}`)
    }

    // 404.html — a path guaranteed to match no route triggers the root
    // `notFoundComponent` (see routes/__root.tsx), which sets `noindex`.
    const notFoundHtml = await captureRoute(
      browser,
      baseUrl,
      '/__prerender-404-marker__',
      true,
      null,
    )
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
  // `routes.length` = (2 + N vacancies) * LOCALES.length (task-landing-i18n.md).
  const vacancyPageCount = (vacancies?.length ?? 0) * LOCALES.length
  console.log(
    `prerender: done — ${routes.length} route(s) across ${LOCALES.length} locales, ${vacancyPageCount} vacancy page(s) prerendered (API ${vacancies === null ? 'unreachable' : 'reachable, ' + vacancies.length + ' PUBLISHED'}).`,
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
export {
  buildRobotsTxt,
  buildSitemapXml,
  buildRoutes,
  extractJsonLd,
  assertJsonLd,
  assertHtmlLang,
  vacancyHreflangExcludes,
  LOCALES,
}
