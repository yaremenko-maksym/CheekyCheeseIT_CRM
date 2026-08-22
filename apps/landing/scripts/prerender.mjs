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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
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
//
// NOT JUST a route list any more (2026-07-31 rate-limit fix) —
// `estimateRequestWeight()` below derives a vacancy route's expected request
// count from `LOCALES.length` (mirroring NON_DEFAULT_LOCALES.length in
// app/lib/api.ts's fetchVacancyHreflangExcludes()). A 6th locale added here
// without a matching change on the app side would UNDER-count that weight,
// silently thinning the rate-limit pacing's safety margin — currently ~40
// requests of slack (RATE_LIMIT_BUDGET 60 vs a real 6-per-vacancy-route
// count), so one added locale does not bite today, but keep this in sync.
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
// 0. Rate-limit awareness — 2026-07-31 prod outage RCA: apps/api's global
//    ThrottlerModule (apps/api/src/app.module.ts, THROTTLER_TTL_MS/
//    THROTTLER_LIMIT, default 100 req / 60_000 ms) caps EVERY `/api/...`
//    request, including this script's own Node-side fetches below AND every
//    captured route's client-side loader fetches — PublicVacanciesController
//    carries no per-route @Throttle() override, so it sits entirely under
//    that global bucket (deliberately — see task instructions: the FIX is
//    the consumer, never THROTTLER_LIMIT or a @SkipThrottle()).
//
//    A single `/careers/:slug` capture alone fires SIX requests client-side
//    (app/lib/api.ts: fetchVacancy + fetchVacancies + one fetchVacancies per
//    NON_DEFAULT_LOCALES entry inside fetchVacancyHreflangExcludes — see that
//    file's module doc) — with LOCALES.length (5) locales × N vacancies, the
//    real request count is `5*2 + 5*6*N` (home+careers, then N vacancy pages
//    per locale) PLUS the 5 Node-side fetchAllLocaleVacancies() calls below,
//    all normally issued within the same ~17s unthrottled run — i.e. the same
//    60s window. At just 3 PUBLISHED vacancies (15 vacancy routes) that is
//    105 requests, comfortably over the limit — this is exactly what broke
//    prod on 2026-07-31 (confirmed via 6× "429" in the failed build's log).
//
//    Two defenses, both keyed off REAL observed request timestamps (not a
//    fixed guess that would silently stop being enough as vacancies grow):
//
//      1. `apiRateLimiter` — a sliding-window token-bucket that PACES route
//         captures: before navigating to a route, wait until issuing its
//         estimated request count would stay within RATE_LIMIT_BUDGET for
//         the current window. Self-adjusting to any number of vacancies —
//         more routes just means more waiting, never a 429 (AC3).
//      2. Explicit 429 DETECTION + BACKOFF in captureRoute() — belt-and-
//         suspenders in case the pacing margin is ever exceeded (clock
//         drift, a future extra fetch call, RATE_LIMIT_BUDGET misconfigured
//         too high, ...): a `page.on('response')` listener tags any capture
//         attempt that actually observed a 429, and the retry loop reports
//         that explicitly (AC1 — instead of the misleading downstream "empty
//         ItemList" this script used to surface, which is what actually cost
//         the build-log investigation time on 2026-07-31) and waits out a
//         FULL throttler window before retrying (AC2), instead of retrying
//         inside the very same window it just got throttled in.
// ---------------------------------------------------------------------------

/** Sliding-window length — mirrors THROTTLER_TTL_MS's prod default (apps/api/src/config/env.ts). Override when reproducing a 429 against a deliberately-shrunk local THROTTLER_TTL_MS (see the "0. Rate-limit awareness" doc above). */
const RATE_LIMIT_WINDOW_MS = Number(process.env['PRERENDER_RATE_LIMIT_WINDOW_MS'] ?? 60_000)
/** Requests this script will allow itself per RATE_LIMIT_WINDOW_MS — deliberately under THROTTLER_LIMIT's prod default (100) so normal build-time variance never brushes the real ceiling. */
const RATE_LIMIT_BUDGET = Number(process.env['PRERENDER_RATE_LIMIT_BUDGET'] ?? 60)
/** How long to wait after an ACTUALLY OBSERVED 429 before retrying — long enough to guarantee the throttler's window has rolled over (mirrors THROTTLER_TTL_MS's prod default), not a same-window instant retry. Configurable so a local repro against a deliberately-shrunk THROTTLER_TTL_MS doesn't have to wait a real 60s per retry. */
const RATE_LIMIT_BACKOFF_MS = Number(process.env['PRERENDER_RATE_LIMIT_BACKOFF_MS'] ?? 61_000)

/** @returns {Promise<void>} */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A real-request-timestamp-backed sliding-window rate limiter — `record()`
 * is called by every ACTUAL request this run sends to the API (Node-side
 * fetches below + every captured page's client-side fetches, wired up in
 * `preparePage()`); `waitForBudget(weight)` blocks the caller until issuing
 * `weight` more requests would stay within `budget` for the window ending
 * now. Deliberately a factory (not module-level mutable state used directly)
 * so unit tests can inject a fake clock/sleep instead of waiting on real
 * timers — see app/__tests__/prerender-rate-limit.spec.ts.
 *
 * @param {{ windowMs: number, budget: number, sleepFn?: (ms: number) => Promise<void>, warnFn?: (message: string) => void, nowFn?: () => number }} opts
 */
function createRateLimiter({ windowMs, budget, sleepFn = sleep, warnFn = warn, nowFn = Date.now }) {
  /** @type {number[]} epoch-ms timestamps of every request recorded so far, oldest first. */
  const timestamps = []

  /** @param {number} now */
  function pruneOlderThanWindow(now) {
    // `<=` (not `<`): a request exactly `windowMs` old has fully aged out of
    // a sliding window — excluding it here (rather than on its NEXT check,
    // one extra 250ms-floor wait later) matches `waitMs`'s own
    // `oldest + windowMs - now` computation, which already targets exactly
    // this boundary as "free again".
    const cutoff = now - windowMs
    while (timestamps.length > 0 && timestamps[0] <= cutoff) timestamps.shift()
  }

  return {
    /** Call once per REAL request actually sent to the API. */
    record() {
      timestamps.push(nowFn())
    },
    /**
     * Blocks (looping on real waits) until sending `weight` more requests
     * keeps the window's total at or under `budget`.
     *
     * @param {number} weight
     * @returns {Promise<void>}
     */
    async waitForBudget(weight) {
      for (;;) {
        const now = nowFn()
        pruneOlderThanWindow(now)
        if (timestamps.length + weight <= budget) return
        const oldest = /** @type {number} */ (timestamps[0])
        const waitMs = Math.max(oldest + windowMs - now, 250)
        warnFn(
          `pacing: ${timestamps.length} request(s) already sent in the last ${windowMs}ms ` +
            `(budget ${budget}) — waiting ${Math.ceil(waitMs / 1000)}s before the next route, ` +
            'to stay clear of the API global rate limit',
        )
        await sleepFn(waitMs)
      }
    },
  }
}

const apiRateLimiter = createRateLimiter({
  windowMs: RATE_LIMIT_WINDOW_MS,
  budget: RATE_LIMIT_BUDGET,
})

/**
 * Estimated request count a route's client-side loaders will fire — mirrors
 * app/lib/api.ts's actual call shape per `pageType` (see that file's module
 * doc): `vacancy` routes fire fetchVacancy + fetchVacancies + one
 * fetchVacancies per NON_DEFAULT_LOCALES entry (fetchVacancyHreflangExcludes);
 * `home`/`careers` fire one fetchVacancies each; the 404 marker (`route ===
 * null`) fetches nothing. Only used to decide whether there is headroom
 * BEFORE navigating (`apiRateLimiter.waitForBudget`) — the REAL count is
 * whatever `preparePage()`'s request listener actually observes, so any
 * drift between this estimate and reality self-corrects on the very next
 * route rather than compounding.
 *
 * @param {PrerenderRoute | null} route
 * @returns {number}
 */
function estimateRequestWeight(route) {
  if (!route) return 0
  if (route.pageType === 'vacancy') return 2 + (LOCALES.length - 1)
  return 1
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
    apiRateLimiter.record()
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
  const perLocale = Object.fromEntries(entries)

  // ── Инцидент 2026-07-31: молчаливая потеря SEO ─────────────────────────
  //
  // Терпимость к сбою фетча — намеренная (см. комментарий у
  // `fetchVacanciesForLocale`): сбой ОДНОЙ локали не должен ронять сборку.
  // Но когда падают ВСЕ локали, это не «вакансий нет» — это «API лежит», и
  // разница принципиальная:
  //
  //   `[]`   → вакансий не опубликовано. Штатная ситуация: careers-страница
  //            пустая, `requireJsonLd` = null, ассерт не нужен.
  //   `null` → фетч не удался. Раньше это шло по ТОЙ ЖЕ ветке, что и `[]`:
  //            `hasVacancies` = false → ассерт `item-list` не включался →
  //            сборка зелёная → в прод уезжал лендинг БЕЗ JobPosting/ItemList
  //            и без единой страницы вакансии. Молча.
  //
  // Ровно это и произошло: деплой собрался во время прод-инцидента, когда
  // `/api/public/vacancies` отдавал 500, и выложил careers-страницы без
  // разметки. Сборка при этом была зелёной, поэтому никто бы не заметил.
  //
  // Теперь «все локали не ответили» — жёсткая ошибка. Escape hatch оставлен
  // осознанно: если API лежит И нужно срочно выкатить фикс, блокировать
  // деплой лендингом нельзя (иначе получаем «чтобы починить API, сначала
  // почини API»). В этом случае — `PRERENDER_ALLOW_NO_API=1`, и деградация
  // становится явным решением человека, а не тихим побочным эффектом.
  const verdict = apiReachabilityVerdict(perLocale, {
    locales: LOCALES,
    allowNoApi: process.env['PRERENDER_ALLOW_NO_API'] === '1',
    apiOrigin: API_ORIGIN,
  })
  if (verdict.fatal) throw new Error(verdict.message)
  if (verdict.message) warn(verdict.message)

  return perLocale
}

/**
 * Чистое решение «продолжать или падать», вынесенное из
 * `fetchAllLocaleVacancies` ради тестируемости (сама она делает сетевой I/O).
 *
 * @param {PerLocaleVacancies} perLocale
 * @param {{ locales: readonly string[], allowNoApi: boolean, apiOrigin: string }} opts
 * @returns {{ fatal: boolean, message: string | null }}
 */
function apiReachabilityVerdict(perLocale, { locales, allowNoApi, apiOrigin }) {
  const failed = locales.filter((l) => perLocale[l] === null)
  if (failed.length !== locales.length) return { fatal: false, message: null }

  const detail =
    `не удалось получить вакансии НИ ДЛЯ ОДНОЙ из ${locales.length} локалей ` +
    `(${apiOrigin}/api/public/vacancies) — признак недоступного API, а не отсутствия вакансий`

  if (allowNoApi) {
    return {
      fatal: false,
      message: `${detail}; PRERENDER_ALLOW_NO_API=1 — продолжаю БЕЗ SEO-разметки careers, это осознанный выбор.`,
    }
  }
  return {
    fatal: true,
    message:
      `prerender: ${detail}. Лендинг уехал бы в прод БЕЗ SEO-разметки careers и без ` +
      `страниц вакансий. Почини API и пересобери. Если деплой нужен именно сейчас ` +
      `(например, он и содержит фикс API) — PRERENDER_ALLOW_NO_API=1, тогда ` +
      `деградация станет осознанным решением, а не тихим побочным эффектом.`,
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
  // Ground truth for `apiRateLimiter` — records EVERY real request this page
  // sends to the (proxied, same-origin) `/api/...` path, so pacing decisions
  // (`estimateRequestWeight`) are checked against what actually happened, not
  // just the estimate. Deliberately a `request` (not `response`) listener —
  // the limiter must react to requests being ISSUED, not to how they resolve
  // (a request that gets a 429 still consumed a slot in the server's window).
  page.on('request', (request) => {
    if (request.url().includes('/api/')) apiRateLimiter.record()
  })
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
    // PACING (AC3) — waits, if needed, until this route's estimated request
    // count fits the current sliding window's budget. Checked on every
    // attempt (not just the first) so a retry after a real backoff sleep
    // re-validates the window instead of assuming it's still clear.
    await apiRateLimiter.waitForBudget(estimateRequestWeight(route))
    const page = await browser.newPage()
    // URLs that returned HTTP 429 during THIS attempt, RESTRICTED to `/api/`
    // — belt-and-suspenders 429 DETECTION (AC1): the actual thrown error
    // below is almost always a downstream symptom (e.g. "expected a
    // non-empty ItemList JSON-LD", since app/lib/api.ts's fetchVacancies()
    // swallows non-2xx into `[]` rather than throwing) — this listener is
    // what lets the catch block report the REAL cause instead of that
    // misleading symptom. The `/api/` filter matters: this page also loads
    // fonts/analytics/the Cloudflare Turnstile widget, none of which are
    // apps/api's ThrottlerModule — a 429 on one of THOSE is unrelated to
    // rate limiting, a full-window backoff wouldn't fix it, and reporting it
    // as "throttled by apps/api's global ThrottlerModule" would itself be
    // the exact misleading-diagnosis failure mode this PR exists to remove.
    // Same filter `preparePage()`'s own request-tracking listener uses.
    /** @type {string[]} */
    const rateLimitedUrls = []
    page.on('response', (response) => {
      if (response.status() === 429 && response.url().includes('/api/')) {
        rateLimitedUrls.push(response.url())
      }
    })
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
      if (rateLimitedUrls.length > 0) {
        // Every assertion above passed, but at least one `/api/` request
        // during THIS SAME page load was still rate-limited — the
        // assertions do not cover every field a 429 can silently degrade.
        // Concretely: `home`'s `requireJsonLd` is 'organization+website',
        // which says nothing about vacancy content, so a 429'd
        // `fetchVacancies('en')` there would otherwise ship a "green"
        // capture with an empty/stale Careers-teaser section — the exact
        // silent-regression shape this PR exists to close, just on the one
        // route whose own assertions happen not to catch it (`careers` and
        // `vacancy` routes already fail loud here via `assertJsonLd`/
        // `assertAlternatesMatch` — see their own doc comments). Rather
        // than special-case just `home`, treat ANY capture that observed a
        // 429 as untrustworthy uniformly (thrown here, caught by the SAME
        // branch below as a genuine failure) — simpler than guessing which
        // future page types' assertions do or don't fully cover their data,
        // and the cost is bounded (MAX_CAPTURE_ATTEMPTS, real backoff).
        throw new Error(
          `prerender: capture for ${label} passed all assertions but observed HTTP 429 on ` +
            `${rateLimitedUrls.length} request(s) during the same page load (e.g. ` +
            `${rateLimitedUrls[0]}) — discarding it rather than risking silently rate-limit-degraded data.`,
        )
      }
      return html
    } catch (err) {
      if (rateLimitedUrls.length > 0) {
        // BACKOFF (AC2) — a same-window instant retry (the `else` branch
        // below) is guaranteed to hit the SAME throttler window again; only
        // waiting out a full window actually gives the next attempt a
        // realistic chance to succeed.
        lastError = rateLimitError(label, rateLimitedUrls, err)
        warn(
          `capture attempt ${attempt}/${MAX_CAPTURE_ATTEMPTS} for ${label} hit HTTP 429 rate ` +
            `limiting on ${rateLimitedUrls.length} request(s) (e.g. ${rateLimitedUrls[0]}) — waiting ` +
            `${Math.ceil(RATE_LIMIT_BACKOFF_MS / 1000)}s (a full throttler window) before retrying`,
        )
        await sleep(RATE_LIMIT_BACKOFF_MS)
      } else {
        lastError = err
        warn(
          `capture attempt ${attempt}/${MAX_CAPTURE_ATTEMPTS} for ${label} failed ` +
            `(${err instanceof Error ? err.message : String(err)}) — retrying with a fresh page`,
        )
      }
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
 * Builds the explicit, headline "you got rate limited" error AC1 requires —
 * replaces the misleading downstream symptom (e.g. "expected a non-empty
 * ItemList JSON-LD") a 429'd request would otherwise surface as, while still
 * keeping that symptom visible for context.
 *
 * @param {string} label
 * @param {string[]} rateLimitedUrls
 * @param {unknown} downstreamErr
 * @returns {Error}
 */
function rateLimitError(label, rateLimitedUrls, downstreamErr) {
  const downstreamMessage =
    downstreamErr instanceof Error ? downstreamErr.message : String(downstreamErr)
  return new Error(
    `prerender: rate limited (HTTP 429) while capturing ${label} — ${rateLimitedUrls.length} ` +
      `request(s) were throttled by apps/api's global ThrottlerModule (e.g. ${rateLimitedUrls[0]}). ` +
      `This is NOT a real failure of this route — downstream symptom was: ${downstreamMessage}`,
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
// 2c. task-soft-404-and-noindex.md — build-time regression gate for the
//     "soft 404" defect (Google Search Console, 2026-08-16: "Indexing
//     forbidden by noindex tag"). The bug was never in the `noindex` tag
//     itself — it was that the STATIC (pre-hydration) response for a
//     nonexistent address answered `200` with the HOME page's own markup,
//     which only turned into the honest `noindex` 404 AFTER the SPA
//     hydrated. `curl` (no JS) only ever saw the first, misleading half —
//     which is why the first pass at this investigation found nothing (see
//     this task's own PM brief). The real fix is the HTTP status code
//     (nginx/conf.d/landing.conf, `@locale_fallback`'s `try_files ... =404`
//     + `error_page 404 /404.html`) — these two functions are the two
//     independent, build-time-checkable HALVES of that contract (AC4:
//     "проверять обе половины по отдельности"), re-derived from the
//     ACTUALLY WRITTEN dist/ output (not from `buildRoutes()`'s in-memory
//     route list) so a future change that lets generation drift from the
//     written artifacts still gets caught.
// ---------------------------------------------------------------------------

/**
 * AC1 half — the static 404 document must not present itself as the home
 * page: distinct `<title>` AND a canonical that is neither missing nor
 * equal to home's own. Complements the nginx-level routing fix (which
 * stops home's OWN static file from ever being served AT a nonexistent
 * URL) by pinning that the FALLBACK document itself — `dist/404.html`,
 * served for exactly that case — could never masquerade as home even if
 * some future refactor of `routes/__root.tsx`'s `notFoundComponent`
 * accidentally reused home's copy.
 *
 * Two checks, not three (review round 1: a third "notFoundCanonical !==
 * homeHtml's canonical" check used to sit after this one — dead code,
 * unreachable in practice and uncovered, because the canonical check
 * below already pins `notFoundCanonical` to the EXACT literal string
 * `${SITE_ORIGIN}/404/`; a real home page's canonical is never that
 * string, so "not equal to home's canonical" was already a guaranteed
 * consequence of the exact-match check, never an independent condition —
 * removed rather than given a contrived test for a branch that could only
 * ever fire if home's OWN canonical generation broke in a way this
 * function has no business detecting).
 *
 * @param {string} notFoundHtml
 * @param {string} homeHtml
 * @returns {void}
 */
function assertNotFoundDoesNotImpersonateHome(notFoundHtml, homeHtml) {
  const titleOf = (html) => html.match(/<title>([^<]*)<\/title>/)?.[1]
  const canonicalOf = (html) => html.match(/<link rel="canonical" href="([^"]*)"/)?.[1]
  const notFoundTitle = titleOf(notFoundHtml)
  const homeTitle = titleOf(homeHtml)
  if (!notFoundTitle || notFoundTitle === homeTitle) {
    throw new Error(
      `prerender: 404.html's <title> ("${notFoundTitle ?? '(missing)'}") must be present and must ` +
        `not equal the home page's ("${homeTitle ?? '(missing)'}") — a nonexistent address must never ` +
        'present itself as the home page (task-soft-404-and-noindex.md AC1).',
    )
  }
  const expectedNotFoundCanonical = `${SITE_ORIGIN}/404/`
  const notFoundCanonical = canonicalOf(notFoundHtml)
  if (notFoundCanonical !== expectedNotFoundCanonical) {
    throw new Error(
      `prerender: 404.html canonical is "${notFoundCanonical ?? '(missing)'}", expected ` +
        `"${expectedNotFoundCanonical}" (task-soft-404-and-noindex.md AC1).`,
    )
  }
}

/**
 * AC3/AC4 half — every URL sitemap.xml advertises must (a) have a REAL
 * backing file under `dist/` (a `<loc>` with no file behind it is exactly
 * the "мёртвый адрес в карте" AC4 tests for — a crawler following it would
 * 404, same as the "запрещено тегом noindex" mechanism this task fixes,
 * just discovered via the sitemap instead of a stray external link), and
 * (b) that file's ALREADY-CAPTURED (fully hydrated, see this script's
 * module doc) content is indexable (`assertRobotsMeta`, `expectNoindex:
 * false`) and self-canonical. Runs over the WHOLE sitemap (AC3: "по всей
 * карте, а не по образцу") because it iterates every `<loc>` the just-
 * written sitemap.xml string actually contains, not a hardcoded sample.
 *
 * Deliberately independent of `buildRoutes()`/`captureRoute()`'s OWN
 * per-route assertions (which already run during generation, against the
 * in-memory `routes` array): this function re-derives its expectations
 * from the WRITTEN sitemap.xml and reads the WRITTEN dist files via
 * `readFileFn` — a future change that lets sitemap generation and route
 * capture drift apart (a hand-added `<url>`, a write that silently failed,
 * ...) is still caught here even though it would not be caught by
 * `captureRoute()`'s in-flight checks alone.
 *
 * @param {string} sitemapXml
 * @param {(relPath: string) => string | null} readFileFn - returns a dist-
 *   relative file's content, or `null` if it does not exist. Injectable so
 *   unit tests (prerender-seo.spec.ts) can run this against an in-memory
 *   fixture instead of the real filesystem — see that spec for both
 *   mutation directions AC4 asks for (noindex introduced/removed; a dead
 *   sitemap entry added/removed).
 * @returns {void}
 */
function assertSitemapMatchesDist(sitemapXml, readFileFn) {
  const locs = [...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
  if (locs.length === 0) {
    throw new Error(
      'prerender: sitemap.xml has zero <loc> entries — nothing for this gate to verify ' +
        '(task-soft-404-and-noindex.md AC3/AC4).',
    )
  }
  for (const loc of locs) {
    if (!loc.startsWith(SITE_ORIGIN)) {
      throw new Error(`prerender: sitemap <loc>${loc}</loc> is not under ${SITE_ORIGIN}.`)
    }
    const urlPath = loc.slice(SITE_ORIGIN.length) // '/', '/careers/', '/uk/careers/foo/', ...
    const trimmed = urlPath.replace(/^\/+|\/+$/g, '')
    const file = trimmed === '' ? 'index.html' : `${trimmed}/index.html`
    const html = readFileFn(file)
    if (html === null) {
      throw new Error(
        `prerender: sitemap.xml advertises ${loc} but dist/${file} does not exist — a dead ` +
          'sitemap entry a crawler would 404 on (task-soft-404-and-noindex.md AC4, "мёртвый адрес ' +
          'в карте").',
      )
    }
    assertRobotsMeta(html, false, loc)
    const canonical = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1]
    if (canonical !== loc) {
      throw new Error(
        `prerender: dist/${file} (sitemap URL ${loc}) has canonical "${canonical ?? '(missing)'}", ` +
          `expected "${loc}" — a sitemap entry must carry its own canonical ` +
          '(task-soft-404-and-noindex.md AC3).',
      )
    }
  }
}

/**
 * task-sitemap-missing-vacancy-locales.md (backlog #177) AC4 "first half" —
 * the INVERSE of `assertSitemapMatchesDist` above. That function only ever
 * checked sitemap → dist ("every advertised `<loc>` has a real, indexable
 * file behind it") — it has nothing to say about a `<loc>` that should
 * exist but is simply ABSENT, because an absent entry has, by definition,
 * nothing in `sitemapXml` to iterate over. That is exactly the shape of
 * backlog #177: `buildSitemapXml` silently dropped 6 live, indexable,
 * self-canonical, internally-linked vacancy pages, and nothing caught it —
 * `assertSitemapMatchesDist` had nothing to complain about (the 14
 * addresses it DID see were all individually fine), and
 * `assertSitemapHreflangClusters` only inspects clusters that already made
 * it into the XML.
 *
 * This walks the OTHER direction: every route this build actually
 * captured to `dist/` with `expectNoindex: false` (every entry in
 * `routes` — see `main()`'s `captureRoute(browser, baseUrl, route.url,
 * false, route)` call; no route in this array is ever noindex) must have
 * a matching `<loc>` in the just-written sitemap.xml.
 *
 * @param {PrerenderRoute[]} routes
 * @param {string} sitemapXml
 * @returns {void}
 */
function assertEveryIndexableRouteInSitemap(routes, sitemapXml) {
  const locs = new Set([...sitemapXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]))
  const missing = routes
    .map((route) => localizedUrl(route.locale ?? DEFAULT_LOCALE, route.path))
    .filter((expected) => !locs.has(expected))
  if (missing.length > 0) {
    throw new Error(
      `prerender: ${missing.length} indexable route(s) were captured to dist/ (index, follow, ` +
        `self-canonical) but ${missing.length === 1 ? 'is' : 'are'} missing from sitemap.xml: ` +
        `${missing.join(', ')} — a page every OTHER signal says "please index this" must also be ` +
        'advertised in the sitemap (task-sitemap-missing-vacancy-locales.md AC4).',
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
 * task-sitemap-missing-vacancy-locales.md (backlog #177) AC1/AC3/AC5 — the
 * hreflang cluster for a vacancy `<url>` whose OWN locale is a fallback
 * (untranslated duplicate of `en`, see `buildSitemapXml`'s call site doc).
 * Deliberately NOT `buildXhtmlAlternates(path, LOCALES.filter(l => l !==
 * locale))`: that would still splice in an `en`/`uk` cross-reference this
 * locale cannot reciprocate (their own clusters correctly do NOT list a
 * fallback locale — backlog #39), which `assertSitemapHreflangClusters`
 * below would then rightfully reject as non-reciprocal. A single
 * self-referencing tag is the SEO-neutral floor: per Google's hreflang
 * docs a page that only lists itself is equivalent to carrying no hreflang
 * annotation at all — it claims no cross-language relationship, so it
 * cannot misrepresent duplicate content as a translation, while still
 * satisfying `assertSitemapHreflangClusters`' "every address must appear
 * in its own cluster" rule (that rule exists to catch a DIFFERENT bug —
 * an address with literally nothing describing it at all, see that
 * function's "mutation B" test — not to forbid a deliberately minimal one).
 *
 * @param {string} locale
 * @param {string} path
 * @returns {string}
 */
function buildSelfOnlyXhtmlAlternate(locale, path) {
  return `    <xhtml:link rel="alternate" hreflang="${locale}" href="${xmlEscape(localizedUrl(locale, path))}" />`
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
      const excludeLocales = vacancyHreflangExcludes(v.slug, perLocaleVacancies)
      const path = `/careers/${v.slug}`
      // task-sitemap-missing-vacancy-locales.md (backlog #177, Search
      // Console report 2026-08-22) AC1/AC2 — this used to `continue` (skip
      // the <url> entry) whenever THIS locale itself was in its own
      // `excludeLocales` (i.e. THIS locale's copy of the vacancy is a
      // fallback/untranslated duplicate of `en`). That conflated two
      // DIFFERENT signals that `vacancyHreflangExcludes` was only ever
      // meant to answer once each:
      //   1. "should locale L be ADVERTISED AS AN ALTERNATE inside some
      //      OTHER locale's cluster" — yes, keep excluding L there (a
      //      fallback page is not a genuine translation; claiming it is
      //      would misrepresent duplicate content as a real language
      //      variant — task-sitemap-hreflang-clusters.md AC2/AC5, backlog
      //      #39, still enforced below).
      //   2. "should locale L's OWN page even be IN the sitemap at all" —
      //      this is what the `continue` actually did, and it was wrong:
      //      the live page is `index, follow`, self-canonical, and linked
      //      from its own `/careers` list regardless of translation status
      //      (`captureRoute`'s `expectNoindex: false` for every route,
      //      `careers-page-content.tsx` → `CareersList` → `VacancyCard`
      //      has no fallback filter). Every OTHER signal the app emits for
      //      this exact URL says "please index this" — only the sitemap
      //      disagreed. That is precisely the contradiction Search Console
      //      flagged (backlog #177): a page can promise itself as
      //      indexable without being a sitemap orphan.
      //
      // Fix: ALWAYS emit the <url> entry (matches AC3 — "карта включает
      // все живые индексируемые страницы"). What changes is the ALTERNATES
      // cluster attached to THIS locale's own block:
      //   - locale is NOT its own fallback (a real translation, or `en`
      //     itself) → unchanged: the full reciprocal cluster minus
      //     whichever OTHER locales are fallback for this vacancy.
      //   - locale IS its own fallback → a SELF-ONLY cluster (one
      //     `<xhtml:link>` pointing at itself, hreflang = its own locale).
      //     This still does not claim to be a translation of `en`/`uk` —
      //     preserving backlog #39's guard, `assertSitemapHreflangClusters`
      //     below accepts this shape explicitly — while no longer being
      //     erased from the map of every URL Google is told to crawl.
      const ownLocaleIsFallback = excludeLocales.includes(locale)
      urls.push({
        loc: localizedUrl(locale, path),
        lastmod: v.publishedAt,
        alternates: ownLocaleIsFallback
          ? buildSelfOnlyXhtmlAlternate(locale, path)
          : buildXhtmlAlternates(path, excludeLocales),
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
// 4. task-sitemap-hreflang-clusters.md (backlog #39, Search Console
//    "обнаружена — не проиндексирована", 2026-08-08) — every address
//    sitemap.xml advertises must belong to a REAL, reciprocal hreflang
//    cluster: it must declare itself, every locale it points at as an
//    alternate must itself be a <loc> IN this sitemap whose OWN cluster
//    points straight back, and x-default must resolve to the same address
//    (the `en` member) everywhere in the cluster. `assertSitemapMatchesDist`
//    above (task-soft-404-and-noindex.md AC3/AC4, "INDEX-4") checks a
//    DIFFERENT thing — that every ADVERTISED address is reachable/indexable
//    — never that the hreflang graph it advertises is internally
//    consistent; a dangling or one-directional hreflang link passes INDEX-4
//    outright (see this task's own instructions: "по устройству не
//    поймает"). This is the gate that closes that gap.
// ---------------------------------------------------------------------------

/**
 * @typedef {{ hreflang: string, href: string }} SitemapAlternate
 */

/**
 * @param {string} sitemapXml
 * @returns {Map<string, SitemapAlternate[]>} `<loc>` -> its own `<xhtml:link
 *   rel="alternate">` entries, in document order.
 */
function parseSitemapClusters(sitemapXml) {
  const byLoc = new Map()
  for (const match of sitemapXml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const block = match[1]
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1]
    if (!loc) continue
    const alternates = [...block.matchAll(/hreflang="([^"]+)"\s+href="([^"]+)"/g)].map(
      ([, hreflang, href]) => ({ hreflang, href }),
    )
    byLoc.set(loc, alternates)
  }
  return byLoc
}

/**
 * Every `<url>` block's hreflang cluster must (AC2):
 *   1. Declare ITSELF — a self-referencing alternate whose `href` equals
 *      this block's own `<loc>` (otherwise nothing in the sitemap can ever
 *      reciprocate it — see the AC1 root-cause comment on `buildSitemapXml`
 *      above).
 *   2. Carry an `x-default` entry pointing at the SAME address as the
 *      cluster's own `en` entry (every cluster's default is always `en` —
 *      `DEFAULT_LOCALE`) — UNLESS the cluster is a deliberate SINGLETON (its
 *      only member is itself, see `buildSelfOnlyXhtmlAlternate` — task-
 *      sitemap-missing-vacancy-locales.md backlog #177): such a cluster
 *      claims no relationship to any other locale at all (SEO-equivalent to
 *      carrying no hreflang annotation), so there is no `en` to compare
 *      against — checking `alternates.length > 1` distinguishes this
 *      legitimate shape from the "orphan with a broken/missing en" case
 *      (still caught below whenever the cluster claims 2+ members).
 *   3. Be RECIPROCAL — every alternate href it declares must itself be a
 *      `<loc>` present in this same sitemap, and THAT `<loc>`'s own cluster
 *      must declare an alternate pointing straight back at this block's
 *      `<loc>` (A ссылается на B ⇒ B ссылается на A, plan §1). Trivially
 *      true for a singleton (its one alternate IS itself).
 *
 * @param {string} sitemapXml
 * @returns {void}
 */
function assertSitemapHreflangClusters(sitemapXml) {
  const byLoc = parseSitemapClusters(sitemapXml)
  if (byLoc.size === 0) {
    throw new Error(
      'prerender: sitemap.xml has zero <url> entries — nothing for the hreflang-cluster gate ' +
        'to verify (task-sitemap-hreflang-clusters.md AC3).',
    )
  }
  for (const [loc, alternates] of byLoc) {
    const selfEntry = alternates.find((a) => a.href === loc)
    if (!selfEntry) {
      throw new Error(
        `prerender: sitemap ${loc} does not appear in its own hreflang cluster — every address ` +
          'sitemap.xml advertises must declare itself as one of its own alternates, otherwise no ' +
          'other page in the cluster can reciprocate it (task-sitemap-hreflang-clusters.md AC2).',
      )
    }
    const isSelfOnlySingleton = alternates.length === 1
    const enEntry = alternates.find((a) => a.hreflang === DEFAULT_LOCALE)
    const defaultEntry = alternates.find((a) => a.hreflang === 'x-default')
    if (!isSelfOnlySingleton && (!defaultEntry || !enEntry || defaultEntry.href !== enEntry.href)) {
      throw new Error(
        `prerender: sitemap ${loc}'s x-default href ("${defaultEntry?.href ?? '(missing)'}") does ` +
          `not match its own en href ("${enEntry?.href ?? '(missing)'}") — x-default must resolve ` +
          'to the SAME address as en across the whole cluster (task-sitemap-hreflang-clusters.md AC2).',
      )
    }
    for (const alt of alternates) {
      const targetAlternates = byLoc.get(alt.href)
      if (!targetAlternates) {
        throw new Error(
          `prerender: sitemap ${loc} declares hreflang="${alt.hreflang}" href="${alt.href}", but ` +
            `${alt.href} is not itself a <loc> in sitemap.xml — a dangling cluster member ` +
            '(task-sitemap-hreflang-clusters.md AC2).',
        )
      }
      if (!targetAlternates.some((a) => a.href === loc)) {
        throw new Error(
          `prerender: sitemap ${loc} declares ${alt.href} as an alternate, but ${alt.href}'s own ` +
            `cluster does not declare ${loc} back — hreflang clusters must be reciprocal ` +
            '(task-sitemap-hreflang-clusters.md AC2, plan-landing-i18n-seo.md §1 "взаимность").',
        )
      }
    }
  }
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

    // AC1 (task-soft-404-and-noindex.md) — belt-and-suspenders alongside
    // the nginx-level routing fix (nginx/conf.d/landing.conf): the 404
    // document itself must never be able to pass as home. Re-reads BOTH
    // sides off disk (review round 1: the first version re-read only
    // `homeHtml`, comparing it against the in-memory `notFoundHtml`
    // variable from `captureRoute()` above — an asymmetry that, however
    // harmless today, made the gate's whole justification ("checks what
    // would actually ship") only half true; the value of reading from disk
    // is exactly that it does not trust an in-memory value some future
    // refactor could let drift from what actually got written) — this
    // checks the exact bytes a client would actually receive for BOTH
    // documents, not values that merely flowed through this function's own
    // closure.
    const [writtenNotFoundHtml, homeHtml] = await Promise.all([
      readFile(path.join(DIST, '404.html'), 'utf8'),
      readFile(path.join(DIST, 'index.html'), 'utf8'),
    ])
    assertNotFoundDoesNotImpersonateHome(writtenNotFoundHtml, homeHtml)
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
  const sitemapXml = buildSitemapXml(vacancies, buildTime, perLocaleVacancies)
  await writeFile(path.join(DIST, 'robots.txt'), buildRobotsTxt(), 'utf8')
  await writeFile(path.join(DIST, 'sitemap.xml'), sitemapXml, 'utf8')
  console.log('prerender: wrote robots.txt, sitemap.xml')

  // AC3/AC4 (task-soft-404-and-noindex.md) — independent post-build gate,
  // re-reading the files that were ACTUALLY written above rather than
  // trusting the generation step that just ran. See
  // `assertSitemapMatchesDist`'s own doc for what this catches and why.
  assertSitemapMatchesDist(sitemapXml, (relPath) => {
    try {
      return readFileSync(path.join(DIST, relPath), 'utf8')
    } catch {
      return null
    }
  })
  console.log(
    'prerender: sitemap.xml verified against dist/ — every advertised URL exists, is indexable, ' +
      'and carries its own canonical (AC3/AC4).',
  )

  // task-sitemap-missing-vacancy-locales.md (backlog #177) AC4 "first
  // half" — the gate `assertSitemapMatchesDist` above was missing (see its
  // own doc): every route captured to dist/ as indexable must ALSO be in
  // sitemap.xml, not just the reverse.
  assertEveryIndexableRouteInSitemap(routes, sitemapXml)
  console.log(
    'prerender: every indexable captured route is present in sitemap.xml — no orphaned page ' +
      '(task-sitemap-missing-vacancy-locales.md AC4).',
  )

  // task-sitemap-hreflang-clusters.md AC3/AC4 — runs on EVERY prerender
  // build (dev + CI's `Build landing (prerender)` step, ci.yml, which
  // already seeds a non-empty, partially-translated vacancy set beforehand
  // — "Seed landing vacancy fixtures") right alongside the existing
  // INDEX-4 gate above, so no separate workflow wiring is needed.
  assertSitemapHreflangClusters(sitemapXml)
  console.log(
    'prerender: sitemap.xml hreflang clusters verified — every address belongs to a reciprocal ' +
      'cluster with a consistent x-default (task-sitemap-hreflang-clusters.md AC3).',
  )

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
  assertRobotsMeta,
  assertHtmlLang,
  assertCanonicalSelf,
  assertAlternatesMatch,
  assertNoHomeJsonLdLeak,
  assertNotFoundDoesNotImpersonateHome,
  assertSitemapMatchesDist,
  assertEveryIndexableRouteInSitemap,
  assertSitemapHreflangClusters,
  parseSitemapClusters,
  computeAlternateHrefs,
  vacancyHreflangExcludes,
  LOCALES,
  createRateLimiter,
  estimateRequestWeight,
  rateLimitError,
  apiReachabilityVerdict,
}
