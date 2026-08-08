/**
 * landing/i18n.spec.ts — task-landing-i18n.md / plan-landing-i18n-seo.md.
 *
 * Opt-in project (`--project=landing`, see ../../playwright.config.ts) — NOT
 * run by the default `chromium` project or ci.yml's default shard. Same
 * external-server contract as `responsive.spec.ts`: `LANDING_BASE_URL`
 * (default `:3002`).
 *
 * The A3 "без моргания" test specifically requires the server to be serving
 * the PRERENDERED static build (`pnpm --filter @crm/landing build:prerender`
 * then `pnpm --filter @crm/landing start` — `vite preview`, NOT `vite dev`):
 * only the prerendered `dist/` actually contains the final text in the raw
 * HTML response; a plain dev-server response is an empty `<div id="root">`
 * shell, which would make the comparison meaningless (trivially "equal" —
 * both empty). Run locally:
 *   pnpm --filter @crm/landing build:prerender && pnpm --filter @crm/landing start
 *   LANDING_BASE_URL=http://localhost:4173 pnpm --filter @crm/e2e exec playwright test --project=landing tests/landing/i18n.spec.ts
 *
 * Every vacancy-specific assertion below (page-identity, hreflang exclusion)
 * needs the fixtures `pnpm --filter @crm/e2e seed:landing` creates against a
 * real API (task-landing-e2e-in-ci.md КОНТРАКТ) — see `./fixtures.ts` for
 * exactly what each slug carries and why. Slugs are imported from there, not
 * hardcoded, so a fixture rename is a compile error here instead of a silent
 * drift between what was seeded and what this file asserts.
 */
import { test, expect, type Page } from '@playwright/test'
import {
  CLOSED_VACANCY_SLUG,
  FULLY_TRANSLATED_VACANCY_SLUG,
  UNTRANSLATED_VACANCY_SLUG,
  UNTRANSLATED_VACANCY_TITLE,
} from './fixtures'

// Keep in sync with app/lib/seo.ts SITE_ORIGIN — `<link rel="canonical">` is
// ALWAYS the fixed production origin (SEO requirement: canonical must not
// vary by whatever host actually served the page), never `page.url()`'s own
// origin — this test run's `localhost:3002` in particular.
const SITE_ORIGIN = 'https://cheekycheese.tech'

const LOCALE_ROUTES: { locale: string; home: string; careers: string; htmlLang: string }[] = [
  { locale: 'en', home: '/', careers: '/careers/', htmlLang: 'en' },
  { locale: 'uk', home: '/uk/', careers: '/uk/careers/', htmlLang: 'uk' },
  { locale: 'ru', home: '/ru/', careers: '/ru/careers/', htmlLang: 'ru' },
  { locale: 'es', home: '/es/', careers: '/es/careers/', htmlLang: 'es' },
  { locale: 'pt', home: '/pt/', careers: '/pt/careers/', htmlLang: 'pt' },
]

async function gotoStable(page: Page, path: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(path)
  await page.waitForSelector('footer', { state: 'visible' })
}

test.describe('plan §1/§4 A1 — every locale route resolves to 200 with real content', () => {
  for (const { locale, home, careers } of LOCALE_ROUTES) {
    test(`${locale}: home (${home}) and careers list (${careers}) both render`, async ({
      page,
    }) => {
      const homeRes = await page.goto(home)
      expect(homeRes?.status()).toBe(200)
      await page.waitForSelector('footer', { state: 'visible' })
      await expect(page.locator('h1').first()).not.toBeEmpty()

      const careersRes = await page.goto(careers)
      expect(careersRes?.status()).toBe(200)
      await page.waitForSelector('footer', { state: 'visible' })
      await expect(page.locator('h1').first()).not.toBeEmpty()
    })
  }
})

test.describe('plan §4 A5 — <html lang> matches the locale', () => {
  for (const { locale, home, htmlLang } of LOCALE_ROUTES) {
    test(`${locale}: <html lang="${htmlLang}">`, async ({ page }) => {
      await gotoStable(page, home)
      await expect(page.locator('html')).toHaveAttribute('lang', htmlLang)
    })
  }
})

test.describe('plan §4 A4 — hreflang cluster present on every locale page', () => {
  for (const { locale, home } of LOCALE_ROUTES) {
    test(`${locale}: 5 alternate + x-default hreflang links`, async ({ page }) => {
      await gotoStable(page, home)
      const hreflangs = await page
        .locator('link[rel="alternate"]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('hreflang')))
      expect(hreflangs.sort()).toEqual(['en', 'es', 'pt', 'ru', 'uk', 'x-default'])
    })
  }
})

test.describe('plan §2 A3 — без моргания: prerendered HTML text === post-hydration text', () => {
  for (const { locale, home } of LOCALE_ROUTES) {
    test(`${locale}: home page first-frame text matches post-hydration text`, async ({
      page,
      request,
      baseURL,
    }) => {
      const raw = await request.get(`${baseURL}${home}`)
      const rawHtml = await raw.text()
      // Crude but sufficient body-text extraction from the raw prerendered
      // HTML — strips tags/scripts/styles so it's comparable to `innerText`.
      const rawText = rawHtml
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      await gotoStable(page, home)
      const hydratedText = await page.evaluate(() =>
        document.body.innerText.replace(/\s+/g, ' ').trim(),
      )

      // The hero H1 + nav brand text must appear in BOTH captures, verbatim
      // — the strongest possible "first frame === final frame" signal
      // without a byte-for-byte HTML diff (whitespace/attribute-order noise
      // between raw HTML and the live DOM's innerText is expected and fine).
      const h1Text = await page.locator('h1').first().innerText()
      expect(rawText).toContain(h1Text.split('\n')[0])
      expect(hydratedText).toContain(h1Text.split('\n')[0])
    })
  }
})

test.describe('plan §1/§2/§4 A6 — language switcher', () => {
  test('every locale option is a real <a href>, present in the DOM at 320px, and sets the cookie on click', async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 320, height: 1200 })
    await gotoStable(page, '/')

    // Both the header AND footer render their own <LanguageSwitcher> (plan
    // §2 "видимый в шапке и футере") — scope to the header (`<header>` ==
    // the `banner` landmark) to avoid a strict-mode double-match.
    const nav = page.getByRole('banner')
    const switcherButton = nav.getByRole('button', { name: 'Language' })
    await expect(switcherButton).toBeVisible()

    // Plain attribute selector (not `getByRole`) — the closed dropdown is
    // `display:none`, which Playwright's accessibility-role matching
    // excludes by default; the AC is that the links exist as real
    // `<a href>` in the DOM regardless of open state (crawlability), so the
    // check must not depend on the dropdown being open. `<header>` renders
    // TWO switcher instances (desktop nav + mobile, one hidden per
    // breakpoint via CSS, both always present in the DOM) — deduplicated
    // via `Set` since both instances produce the identical 5-locale href set.
    const options = nav.locator('[role="menuitem"]')
    const hrefs = await options.evaluateAll((els) => els.map((el) => el.getAttribute('href')))
    expect([...new Set(hrefs)].sort()).toEqual(['/', '/es/', '/pt/', '/ru/', '/uk/'])

    await switcherButton.click()
    await nav.getByRole('menuitem', { name: /Русский/ }).click()
    await page.waitForURL('**/ru/')

    const cookies = await context.cookies()
    const pref = cookies.find((c) => c.name === 'pref_locale')
    expect(pref?.value).toBe('ru')
  })

  // Review round 1, HIGH-3 — the original bug (`path="/"` hardcoded in
  // `nav.tsx`/`footer.tsx`) was invisible to a switcher test that only ever
  // starts from `/`, since `/` -> `/ru/` happens to be the CORRECT target
  // there too. Starting from `/careers/` is the regression-proof case: the
  // bug would have sent this to `/ru/` (home), not `/ru/careers/`.
  test('from /careers/, switching to Russian lands on /ru/careers/ — the SAME document, not the RU home page', async ({
    page,
  }) => {
    await gotoStable(page, '/careers/')

    const nav = page.getByRole('banner')
    await nav.getByRole('button', { name: 'Language' }).click()
    await nav.getByRole('menuitem', { name: /Русский/ }).click()

    await page.waitForURL('**/ru/careers/')
    expect(new URL(page.url()).pathname).toBe('/ru/careers/')
  })
})

// ---------------------------------------------------------------------------
// task-landing-i18n.md orchestrator finding (PR #421 issuecomment-
// 5080204989) — a TanStack Router file-nesting bug made `/ru/careers/` (and
// uk/es/pt) render the LOCALE HOME page: 200 status, `lang="ru"`, and a
// non-empty `h1` all still held true on the broken build, which is exactly
// why the existing "A1" describe block above (asserting only those three
// things) did not catch it. Every check below is chosen specifically because
// it FAILS on that broken build and PASSES on the fix — a same-locale
// careers/detail vs. home comparison, not an isolated one-page assertion.
// ---------------------------------------------------------------------------
test.describe('orchestrator finding — /:locale/careers/ renders the CAREERS page, not the locale HOME', () => {
  for (const { locale, home, careers } of LOCALE_ROUTES) {
    test(`${locale}: careers h1/canonical differ from home, and the seeded vacancy is actually listed`, async ({
      page,
    }) => {
      await gotoStable(page, home)
      const homeH1 = (await page.locator('h1').first().innerText()).trim()
      const homeCanonical = await page.locator('link[rel="canonical"]').getAttribute('href')

      await gotoStable(page, careers)
      const careersH1 = (await page.locator('h1').first().innerText()).trim()
      const careersCanonical = await page.locator('link[rel="canonical"]').getAttribute('href')

      // The exact symptom of the bug: /ru/careers/ was byte-identical to
      // /ru/ for both h1 and canonical. A real careers page's h1/canonical
      // MUST differ from that SAME locale's home, regardless of what the
      // translated copy actually says.
      expect(careersH1).not.toBe(homeH1)
      // `prefer-web-first-assertions` wants `toHaveAttribute` here, and it is
      // right in general — that form retries, a captured string does not. It
      // cannot apply to these two lines: both compare the CAREERS page's value
      // against a value captured from a DIFFERENT navigation (this locale's
      // home, read before `gotoStable(page, careers)` above). A retrying
      // locator assertion has no way to express "differs from what another page
      // rendered". The snapshots are taken after `gotoStable`, which already
      // waits for the page to settle, so there is no race being papered over.
      // The single-page form of this check is converted properly below.
      // (task-lint-teeth)
      // eslint-disable-next-line playwright/prefer-web-first-assertions
      expect(careersCanonical).not.toBe(homeCanonical)
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        `${SITE_ORIGIN}${careers}`,
      )

      // The vacancy LIST is genuinely rendered, not just "some non-empty
      // h1" — a real link to this locale's own vacancy-detail page for the
      // seeded fixture (see ./fixtures.ts for what seed:landing serves).
      await expect(
        page.locator(`a[href="${careers}${FULLY_TRANSLATED_VACANCY_SLUG}/"]`),
      ).toBeVisible()
    })
  }
})

test.describe('orchestrator finding — vacancy DETAIL pages render the DETAIL content in every locale, not home', () => {
  for (const { locale, careers } of LOCALE_ROUTES) {
    test(`${locale}: ${careers}${FULLY_TRANSLATED_VACANCY_SLUG}/ shows the vacancy detail with its own canonical`, async ({
      page,
    }) => {
      const detailPath = `${careers}${FULLY_TRANSLATED_VACANCY_SLUG}/`
      const res = await page.goto(detailPath)
      expect(res?.status()).toBe(200)
      await page.waitForSelector('footer', { state: 'visible' })

      // VacancyDetailPageContent's own <h1> carries a `data-vacancy-slug`
      // marker — an unambiguous "this is the detail page for THIS vacancy"
      // signal the home page's h1 never carries.
      await expect(
        page.locator(`h1[data-vacancy-slug="${FULLY_TRANSLATED_VACANCY_SLUG}"]`),
      ).toBeVisible()

      // Retrying form (task-lint-teeth): the previous
      // `expect(await …getAttribute('href')).toBe(…)` read the attribute once
      // and raced the page, which is how landing specs have gone flaky before.
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
        'href',
        `${SITE_ORIGIN}${detailPath}`,
      )
    })
  }
})

// ---------------------------------------------------------------------------
// plan §3/A10, round-4 "дорезка" — a locale with NO real translation for a
// given vacancy must NEVER advertise that vacancy's URL as an hreflang
// alternate (duplicate-content guard: the untranslated locale page shows the
// SAME `en` copy verbatim, so telling Google "this is the ru/uk/es/pt
// version" would flag it as duplicate content). Needs BOTH extremes from
// ./fixtures.ts: `FULLY_TRANSLATED_VACANCY_SLUG` (translated into EVERY
// non-en locale) proves nothing is incorrectly excluded when a real
// translation exists everywhere; `UNTRANSLATED_VACANCY_SLUG` (translated
// nowhere) proves the all-excluded case and that the page itself still
// renders (200, `en` fallback copy) even though it carries no hreflang
// alternates for it.
// ---------------------------------------------------------------------------
test.describe('plan §3/A10 — hreflang omits locales with no real translation (isFallback)', () => {
  async function hreflangSet(page: Page, path: string) {
    await gotoStable(page, path)
    const hreflangs = await page
      .locator('link[rel="alternate"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('hreflang')))
    return new Set(hreflangs)
  }

  test('fully-translated vacancy: hreflang cluster is every locale — {en, uk, ru, es, pt, x-default}', async ({
    page,
  }) => {
    const set = await hreflangSet(page, `/careers/${FULLY_TRANSLATED_VACANCY_SLUG}/`)
    expect(set).toEqual(new Set(['en', 'uk', 'ru', 'es', 'pt', 'x-default']))
  })

  test('untranslated vacancy: hreflang cluster is exactly {en, x-default} — every non-en locale excluded', async ({
    page,
  }) => {
    const set = await hreflangSet(page, `/careers/${UNTRANSLATED_VACANCY_SLUG}/`)
    expect(set).toEqual(new Set(['en', 'x-default']))
  })

  test('the same exclusion set holds from a NON-en locale page too (/ru/careers/<untranslated>/)', async ({
    page,
  }) => {
    // hreflangExcludes is computed from each locale's OWN isFallback flag for
    // this slug — it must not depend on which locale page you're currently
    // viewing (the alternates cluster describes the vacancy, not the viewer).
    const set = await hreflangSet(page, `/ru/careers/${UNTRANSLATED_VACANCY_SLUG}/`)
    expect(set).toEqual(new Set(['en', 'x-default']))
  })

  test('untranslated vacancy still renders 200 with the en fallback copy on /ru/ — excluded from hreflang, not from the route itself', async ({
    page,
  }) => {
    const res = await page.goto(`/ru/careers/${UNTRANSLATED_VACANCY_SLUG}/`)
    expect(res?.status()).toBe(200)
    await page.waitForSelector('footer', { state: 'visible' })
    // No `ru` translation exists — plan §3 "непереведённая — оригинал":
    // the page shows the EN title verbatim, not an error/empty state.
    await expect(
      page.locator(`h1[data-vacancy-slug="${UNTRANSLATED_VACANCY_SLUG}"]`),
    ).toContainText(UNTRANSLATED_VACANCY_TITLE)
  })
})

// ---------------------------------------------------------------------------
// task-landing-e2e-in-ci.md КОНТРАКТ — CLOSED fixture. A closed posting is
// GONE (410, not 404 — it existed and was removed, "never existed" is the
// wrong signal to send crawlers) and must never resurface in the public
// listing, the sitemap, or the careers page it used to appear on.
//
// The 410 status specifically comes from `VacanciesService.
// getPublishedRowBySlug()` — the REAL public API, hit here via `request.get`
// through the SAME `/api` proxy `vite preview` uses (not `page.goto()`): a
// CLOSED vacancy was never part of the `build:prerender` static output (the
// prerender script only ever fetches PUBLISHED vacancies), so there is no
// static HTML file for its URL — `page.goto()` on that path hits `vite
// preview`'s own SPA-fallback middleware, which serves the unrelated HOME
// page's prerendered `index.html` with a flat 200 (a static host has no
// concept of "this particular unbuilt route is 410"; that signal only
// exists at the API layer and in `sitemap.xml`, both asserted below).
// ---------------------------------------------------------------------------
test.describe('CLOSED vacancy — 410 + excluded from every public surface', () => {
  test('GET /api/public/vacancies/:slug returns 410 (not 200/404)', async ({
    request,
    baseURL,
  }) => {
    const res = await request.get(`${baseURL}/api/public/vacancies/${CLOSED_VACANCY_SLUG}`)
    expect(res.status()).toBe(410)
  })

  test('excluded from GET /api/public/vacancies (every locale)', async ({ request, baseURL }) => {
    for (const { locale } of LOCALE_ROUTES) {
      const res = await request.get(`${baseURL}/api/public/vacancies?locale=${locale}`)
      const slugs = (await res.json()) as Array<{ slug: string }>
      expect(slugs.map((v) => v.slug)).not.toContain(CLOSED_VACANCY_SLUG)
    }
  })

  test('excluded from the prerendered sitemap.xml', async ({ request, baseURL }) => {
    const res = await request.get(`${baseURL}/sitemap.xml`)
    const xml = await res.text()
    expect(xml).not.toContain(CLOSED_VACANCY_SLUG)
  })

  test('not linked from the /careers/ list page', async ({ page }) => {
    await gotoStable(page, '/careers/')
    await expect(page.locator(`a[href="/careers/${CLOSED_VACANCY_SLUG}/"]`)).toHaveCount(0)
  })
})
