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
 * The "orchestrator finding" describe blocks below (page-identity — careers/
 * vacancy-detail must NOT render as the locale home) additionally need ONE
 * published vacancy with slug `senior-ml-engineer` reachable through
 * whatever `/api/public/vacancies*` proxies to (`VITE_PROXY_API_TARGET` for
 * `vite preview`, see `apps/landing/vite.config.ts`) — a real seeded scratch
 * DB + API, OR a lightweight mock server returning the same shape (no DB
 * required for the mock; see `scripts/prerender.mjs`'s own `fetchVacancies`
 * for the exact public-API shape it expects).
 */
import { test, expect, type Page } from '@playwright/test'

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
      expect(careersCanonical).not.toBe(homeCanonical)
      expect(careersCanonical).toBe(`${SITE_ORIGIN}${careers}`)

      // The vacancy LIST is genuinely rendered, not just "some non-empty
      // h1" — a real link to this locale's own vacancy-detail page for the
      // seeded fixture (see file header for what the API must serve).
      await expect(page.locator(`a[href="${careers}senior-ml-engineer/"]`)).toBeVisible()
    })
  }
})

test.describe('orchestrator finding — vacancy DETAIL pages render the DETAIL content in every locale, not home', () => {
  for (const { locale, careers } of LOCALE_ROUTES) {
    test(`${locale}: ${careers}senior-ml-engineer/ shows the vacancy detail with its own canonical`, async ({
      page,
    }) => {
      const detailPath = `${careers}senior-ml-engineer/`
      const res = await page.goto(detailPath)
      expect(res?.status()).toBe(200)
      await page.waitForSelector('footer', { state: 'visible' })

      // VacancyDetailPageContent's own <h1> carries the SAME
      // data-vacancy-morph-slug attribute the list card it morphs from does
      // (vacancy-card.tsx) — an unambiguous "this is the detail page for
      // THIS vacancy" marker the home page's h1 never carries.
      await expect(page.locator('h1[data-vacancy-morph-slug="senior-ml-engineer"]')).toBeVisible()

      const canonical = await page.locator('link[rel="canonical"]').getAttribute('href')
      expect(canonical).toBe(`${SITE_ORIGIN}${detailPath}`)
    })
  }
})
