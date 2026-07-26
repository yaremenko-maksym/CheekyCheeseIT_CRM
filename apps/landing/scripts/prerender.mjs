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
 * @typedef {{ slug: string, publishedAt: string, isFallback: boolean }} VacancyListItem
 * @typedef {Record<string, VacancyListItem[] | null>} PerLocaleVacancies - keyed by locale, mirrors `app/lib/api.ts` `fetchVacancyHreflangExcludes()`'s own per-locale-list source (`null` = that locale's list fetch failed).
 * @typedef {{ url: string, file: string, locale?: string, path: string, pageType: 'home' | 'careers' | 'vacancy', hreflangExcludes: string[], requireJsonLd: 'organization+website' | 'item-list' | 'job-posting-breadcrumb' | null }} PrerenderRoute
 */

/**
 * Mirrors `app/lib/api.ts` `fetchVacancyHreflangExcludes()` (plain-Node ESM
 * duplication, same rationale as SITE_ORIGIN/LOCALES above) — round-4
 * "дорезка": the public API only reports `isFallback` for the ONE `?locale=`
 * a request asked about (server-side resolution, no `translations` field is
 * ever exposed publicly), so this reads each NON-default locale's OWN
 * PUBLISHED list (`perLocaleVacancies`, fetched once per locale in `main()`
 * below — same 5-request shape the browser-side helper uses) for this
 * slug's `isFallback` flag. A locale whose list fetch failed, or that
 * doesn't (yet) list this slug at all, is conservatively excluded — same
 * "safe default" as the client helper.
 *
 * @param {string} slug
 * @param {PerLocaleVacancies} perLocaleVacancies
 * @returns {string[]}
 */
function vacancyHreflangExcludes(slug, perLocaleVacancies = {}) {
  return LOCALES.filter((locale) => {
    if (locale === DEFAULT_LOCALE) return false
    const entry = perLocaleVacancies[locale]?.find((v) => v.slug === slug)
    return entry?.isFallback !== false
  })
}

function warn(message) {
  // `::warning::` — native GHA annotation, matches the convention already
  // used elsewhere in this repo's CI-facing scripts.
  console.log(`::warning::prerender: ${message}`)
}

// ---------------------------------------------------------------------------
// 1. Fetch the PUBLISHED vacancy list, once per locale (drives which
//    /careers/:slug pages get prerendered + sitemap entries + hreflang
//    exclusions — round-4 "дорезка", see `vacancyHreflangExcludes()` above
//    for why one request per locale, not one total). Failure on any single
//    locale is non-fatal — the task explicitly requires the build not to
//    fail when the API is unreachable; the live SPA still fetches this
//    client-side for real visitors.
// ---------------------------------------------------------------------------
/** @param {string} locale @returns {Promise<VacancyListItem[] | null>} `null` means that locale's list fetch failed. */
async function fetchVacanciesForLocale(locale) {
  const localeQuery = locale === DEFAULT_LOCALE ? '' : `?locale=${locale}`
  try {
    const res = await fetch(`${API_ORIGIN}/api/public/vacancies${localeQuery}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!Array.isArray(data)) throw new Error('response is not an array')
    return data
  } catch (err) {
    warn(
      `could not fetch vacancies (locale=${locale}) from ${API_ORIGIN}/api/public/vacancies (${err.message}) — ` +
        'building without per-slug vacancy pages for this locale; the live SPA still fetches them client-side.',
    )
    return null
  }
}

/**
 * Fetches all 5 locales' PUBLISHED lists in parallel — the `en` list drives
 * WHICH vacancies exist (canonical slug set, same status filter regardless
 * of locale); every locale's own list feeds `vacancyHreflangExcludes()`.
 *
 * @returns {Promise<PerLocaleVacancies>}
 */
async function fetchAllLocaleVacancies() {
  const entries = await Promise.all(
    LOCALES.map(
      async (locale) =>
        /** @type {[string, VacancyListItem[] | null]} */ ([
          locale,
          await fetchVacanciesForLocale(locale),
        ]),
    ),
  )
  return Object.fromEntries(entries)
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
 * @param {PerLocaleVacancies} perLocaleVacancies
 * @returns {PrerenderRoute[]}
 */
function buildRoutes(vacancies, perLocaleVacancies = {}) {
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
      // `path` — locale-agnostic, root-relative (task-landing-i18n.md
      // orchestrator finding #2): the SAME value every locale's own
      // `*-page-content.tsx` passes to `buildHreflangAlternates()` — lets
      // `assertCanonicalSelf`/`assertAlternatesMatch` below compute the
      // EXPECTED canonical/alternate set independently of what the capture
      // actually rendered, so a page-identity mix-up (careers rendering as
      // home, or vice versa) is caught by comparing against ground truth,
      // not by re-deriving expectations from the same (possibly wrong) HTML.
      path: '/',
      pageType: 'home',
      hreflangExcludes: [],
      requireJsonLd: 'organization+website',
    })
    routes.push({
      url: `${prefix}/careers`,
      file: `${filePrefix}careers/index.html`,
      locale,
      path: '/careers',
      pageType: 'careers',
      hreflangExcludes: [],
      requireJsonLd: hasVacancies ? 'item-list' : null,
    })
    for (const v of vacancies ?? []) {
      routes.push({
        url: `${prefix}/careers/${v.slug}`,
        file: `${filePrefix}careers/${v.slug}/index.html`,
        locale,
        path: `/careers/${v.slug}`,
        pageType: 'vacancy',
        hreflangExcludes: vacancyHreflangExcludes(v.slug, perLocaleVacancies),
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
 * **`expectedCanonical` param — task-landing-remove-page-transitions.md
 * fix-round-1 (code-review BLOCK) — closes a STALE-DOM race, a DIFFERENT
 * failure mode than the settled-vs-committed one above.** `captureRoute()`
 * writes each route's captured HTML straight to `dist/<route>/index.html`
 * as soon as it's captured, and this SAME `vite preview` server serves
 * `dist/` as static files with an SPA fallback for any path that doesn't
 * (yet) have its own file on disk — so a LATER route's very first
 * navigation can be served an EARLIER route's already-written, fully-
 * rendered HTML as its initial document (`/` is captured first and written
 * to `dist/index.html`; `/careers`'s `page.goto()` a moment later, before
 * `dist/careers/index.html` exists, gets that same now-stale
 * `dist/index.html` — Home's markup — as its SPA fallback). Whichever page
 * actually committed first already has a REAL `<footer>` and a REAL (if
 * WRONG for this capture) robots meta that can satisfy the two waits above
 * without ever being the route under capture at all. This is exactly what
 * broke when `app/client.tsx` stopped mounting `<Outlet/>` synchronously
 * (mount is now deferred to AFTER `router.load()` resolves, to fix a
 * separate empty-frame bug — see that file's module doc): the stale Home
 * markup sat in `#root` untouched long enough for THIS gate to pass
 * against IT, before the real `/careers` render ever committed —
 * `page.content()` captured Home while `captureRoute()` thought it was
 * capturing `/careers`, and `assertCanonicalSelf` (the post-capture check)
 * caught the mismatch. Checking `<link rel="canonical">` against the EXACT
 * URL this capture is FOR (same ground-truth `localizedUrl()` computation
 * `assertCanonicalSelf` uses, passed in by the caller) closes this race at
 * the READINESS-GATE level, generically — "some page rendered" is no
 * longer enough to satisfy this wait; it has to be genuinely THIS page,
 * regardless of what timing changes land in `client.tsx`/`__root.tsx` in
 * the future.
 *
 * @param {import('playwright').Page} page
 * @param {boolean} expectNoindex
 * @param {string} expectedCanonical - the exact `<link rel="canonical" href>` this capture must observe before it is considered settled (see doc above).
 * @returns {Promise<void>}
 */
async function waitForDocumentHeadSettled(page, expectNoindex, expectedCanonical) {
  await page.waitForSelector('footer', { state: 'visible' })
  await page.waitForFunction(
    ({ expectNoindex, expectedCanonical }) => {
      const meta = document.querySelector('meta[name="robots"]')
      if (!meta) return false
      const isNoindex = (meta.getAttribute('content') ?? '').includes('noindex')
      if (isNoindex !== expectNoindex) return false
      const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute('href')
      return canonical === expectedCanonical
    },
    { expectNoindex, expectedCanonical },
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
  // Ground truth for `waitForDocumentHeadSettled`'s stale-DOM identity check
  // (see that function's doc) — the SAME `localizedUrl()` computation
  // `assertCanonicalSelf` uses post-capture below, so both checks can never
  // disagree with each other. The 404 marker (`route === null`) has no
  // `PrerenderRoute` to derive this from — `routes/__root.tsx`'s
  // `NotFoundPage` hardcodes `canonicalUrl('/404')`, mirrored literally here
  // (plain Node ESM, same duplication rationale as `SITE_ORIGIN` above).
  const expectedCanonical = route
    ? localizedUrl(route.locale ?? DEFAULT_LOCALE, route.path)
    : `${SITE_ORIGIN}/404/`
  /** @type {unknown} */
  let lastError
  for (let attempt = 1; attempt <= MAX_CAPTURE_ATTEMPTS; attempt++) {
    const page = await browser.newPage()
    try {
      await preparePage(page)
      await page.goto(`${baseUrl}${url}`)
      await waitForDocumentHeadSettled(page, expectNoindex, expectedCanonical)
      const html = await page.content()
      assertRobotsMeta(html, expectNoindex, label)
      assertHtmlLang(html, expectedLang, label)
      if (route) {
        assertJsonLd(html, route)
        assertCanonicalSelf(html, route)
        assertAlternatesMatch(html, route)
        assertNoHomeJsonLdLeak(html, route)
      }
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
    // 3, not 2 — task-vacancy-i18n-jobposting C6 / round-4 "дорезка" added a
    // THIRD entry (FAQPage) to VacancyDetailContent's `useDocumentHead`
    // `jsonLd` array (see components/marketing/pages/vacancy-detail-page-
    // content.tsx). This assertion originally shipped BEFORE that change and
    // was never updated — with a real seeded vacancy (any non-zero-vacancy
    // build) it failed 100% of the time, which CI's Lighthouse job never
    // exercised because it always built against 0 PUBLISHED vacancies. Found
    // by locally seeding a scratch DB with real published vacancies and
    // running `build:prerender` end-to-end (round-4, hreflang-exclusion
    // verification pass).
    if (!Array.isArray(data) || data.length !== 3) {
      throw new Error(
        `prerender: expected a JobPosting+BreadcrumbList+FAQPage JSON-LD array on ${route.url}`,
      )
    }
    const jobPosting = data.find((entry) => entry['@type'] === 'JobPosting')
    const breadcrumb = data.find((entry) => entry['@type'] === 'BreadcrumbList')
    const faq = data.find((entry) => entry['@type'] === 'FAQPage')
    if (!jobPosting) throw new Error(`prerender: missing JobPosting JSON-LD on ${route.url}`)
    if (!breadcrumb) throw new Error(`prerender: missing BreadcrumbList JSON-LD on ${route.url}`)
    if (!faq) throw new Error(`prerender: missing FAQPage JSON-LD on ${route.url}`)
    if (!Array.isArray(faq.mainEntity) || faq.mainEntity.length < 3) {
      throw new Error(
        `prerender: FAQPage on ${route.url} must have at least 3 questions (plan §4 C6 "3-5 вопросов")`,
      )
    }
    for (const entry of faq.mainEntity) {
      if (entry['@type'] !== 'Question' || !entry.name || !entry.acceptedAnswer?.text) {
        throw new Error(`prerender: FAQPage on ${route.url} has a malformed Question entry`)
      }
    }

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
// 2b. Page-identity verification (task-landing-i18n.md orchestrator finding,
//     PR #421 issuecomment-5080204989) — a TanStack Router file-nesting bug
//     (`ru.tsx` swallowing `ru.careers.tsx` as a child route) made
//     `/ru/careers/` etc. render the LOCALE HOME page while still returning
//     200 with a plausible `lang="ru"` and, when 0 vacancies were seeded,
//     NO JSON-LD requirement at all (`requireJsonLd: null`) — every existing
//     assertion above (`assertRobotsMeta`/`assertHtmlLang`/`assertJsonLd`)
//     only checks that a correct-SHAPED tag is present, never that the
//     rendered CONTENT actually belongs to the URL under test, so all three
//     passed on the broken build. This is documented as the THIRD
//     recurrence of this exact bug class in the project (presence-check !=
//     identity-check). The two functions below close that gap by computing
//     the EXPECTED canonical/alternate URLs independently from `route.path`/
//     `route.locale`/`route.hreflangExcludes` (ground truth, set once in
//     `buildRoutes()`) and comparing them against what the capture actually
//     produced — a page-identity mix-up fails immediately regardless of
//     locale, vacancy-seeding state, or copy differences between page types.
// ---------------------------------------------------------------------------

/**
 * @param {string} html
 * @param {PrerenderRoute} route
 * @returns {void}
 */
function assertCanonicalSelf(html, route) {
  const expected = localizedUrl(route.locale ?? DEFAULT_LOCALE, route.path)
  const match = html.match(/<link rel="canonical" href="([^"]*)"/)
  const actual = match?.[1]
  if (actual !== expected) {
    throw new Error(
      `prerender: canonical for ${route.url} is "${actual ?? '(missing)'}", expected "${expected}" ` +
        '— page-identity check failed (the WRONG route almost certainly rendered here; ' +
        'see task-landing-i18n.md orchestrator finding).',
    )
  }
}

/**
 * @param {string} html
 * @param {PrerenderRoute} route
 * @returns {void}
 */
function assertAlternatesMatch(html, route) {
  const expected = new Set(computeAlternateHrefs(route.path, route.hreflangExcludes))
  const actual = new Set(
    [...html.matchAll(/<link rel="alternate" hreflang="[^"]*" href="([^"]*)"/g)].map((m) => m[1]),
  )
  const missing = [...expected].filter((href) => !actual.has(href))
  const extra = [...actual].filter((href) => !expected.has(href))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `prerender: alternate hrefs for ${route.url} do not match the expected set — ` +
        `missing: [${missing.join(', ')}], unexpected: [${extra.join(', ')}] ` +
        '(alternates must point at the SAME page type on every other locale, never at a locale root; ' +
        'see task-landing-i18n.md orchestrator finding).',
    )
  }
}

/**
 * Second, independent page-identity signal (belt-and-suspenders alongside
 * `assertCanonicalSelf`, and — unlike `assertJsonLd` above — one that does
 * NOT no-op when `route.requireJsonLd === null`): Organization/WebSite
 * JSON-LD is emitted EXCLUSIVELY by `home-page-content.tsx` (see
 * `assertJsonLd`'s `'organization+website'` branch above, the only route
 * type it applies to). Its presence on a captured non-home route is
 * unambiguous proof the home component rendered there instead — this is
 * precisely the check that would have caught the original bug even on a
 * zero-vacancy build (`requireJsonLd: null` for `/ru/careers/` there, so
 * `assertJsonLd` alone skipped validation entirely).
 *
 * @param {string} html
 * @param {PrerenderRoute} route
 * @returns {void}
 */
function assertNoHomeJsonLdLeak(html, route) {
  if (route.pageType === 'home') return
  const data = extractJsonLd(html)
  if (data === null) return
  const types = Array.isArray(data) ? data.map((entry) => entry?.['@type']) : [data?.['@type']]
  if (types.includes('Organization') || types.includes('WebSite')) {
    throw new Error(
      `prerender: ${route.url} (pageType=${route.pageType}) carries Organization/WebSite JSON-LD, ` +
        'which only ever belongs on the home page — the wrong route rendered here ' +
        '(see task-landing-i18n.md orchestrator finding).',
    )
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
 * Ground-truth expected alternate hrefs for `path` (locale-agnostic,
 * root-relative) — one per locale not in `excludeLocales`, in `LOCALES`
 * order, PLUS `x-default` (the `en` URL) last. Shared by
 * `buildXhtmlAlternates()` below (sitemap) and `assertAlternatesMatch()`
 * above (page-identity verification) so both compute the exact same
 * expected set from the exact same inputs — see that function's doc.
 *
 * @param {string} path
 * @param {string[]} excludeLocales
 * @returns {string[]}
 */
function computeAlternateHrefs(path, excludeLocales) {
  const hrefs = LOCALES.filter((l) => !excludeLocales.includes(l)).map((l) => localizedUrl(l, path))
  hrefs.push(localizedUrl(DEFAULT_LOCALE, path))
  return hrefs
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
 * @param {PerLocaleVacancies} perLocaleVacancies
 * @returns {string}
 */
function buildSitemapXml(vacancies, buildTime, perLocaleVacancies = {}) {
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
        alternates: buildXhtmlAlternates(
          `/careers/${v.slug}`,
          vacancyHreflangExcludes(v.slug, perLocaleVacancies),
        ),
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

  // task-landing-i18n.md round-4 "дорезка" — one PUBLISHED-list fetch per
  // locale (5 total), not 1: the public API only reports `isFallback` for
  // the ONE `?locale=` a request asked about, so building an accurate
  // hreflang-exclusion map (`vacancyHreflangExcludes()`) needs every
  // locale's own list. `en`'s list drives WHICH vacancies exist (same
  // PUBLISHED-status filter regardless of locale).
  const perLocaleVacancies = await fetchAllLocaleVacancies()
  const vacancies = perLocaleVacancies[DEFAULT_LOCALE]
  const routes = buildRoutes(vacancies, perLocaleVacancies)

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
  await writeFile(
    path.join(DIST, 'sitemap.xml'),
    buildSitemapXml(vacancies, buildTime, perLocaleVacancies),
    'utf8',
  )
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
  assertCanonicalSelf,
  assertAlternatesMatch,
  assertNoHomeJsonLdLeak,
  computeAlternateHrefs,
  vacancyHreflangExcludes,
  LOCALES,
}
