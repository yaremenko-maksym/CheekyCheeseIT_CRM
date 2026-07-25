/**
 * landing/motion-v3.spec.ts — task-landing-motion-v3.md, docs/design/
 * landing-redesign.md §M v3.5 verification checklist.
 *
 * Opt-in `landing` project (same pattern as `responsive.spec.ts` — see its
 * module doc). Requires an externally started `apps/landing` dev server
 * (default `:3002`, override via `LANDING_BASE_URL`) proxying to an API
 * instance seeded with at least 2 PUBLISHED vacancies (title-morph tests
 * need to click a specific card and land on a specific detail page).
 *
 * No hardcoded slugs/titles — fetched live from `/api/public/vacancies` per
 * test (same `request`-fixture pattern as `responsive.spec.ts`'s vacancy-
 * detail block), same reasoning: whatever is actually seeded in the scratch
 * DB at run time, not a fixed fixture that silently drifts from it.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'

interface VacancyFixture {
  slug: string
  title: string
}

/**
 * Fetches the live PUBLISHED vacancy list and returns the `index`-th entry
 * — `test.skip`s (not fails) when fewer than `index + 1` are seeded, same
 * graceful-skip contract as `responsive.spec.ts`'s vacancy-detail block.
 */
async function requireVacancy(
  request: APIRequestContext,
  baseURL: string | undefined,
  index: number,
): Promise<VacancyFixture> {
  const res = await request.get(`${baseURL}/api/public/vacancies`)
  const vacancies = (await res.json()) as VacancyFixture[]
  test.skip(
    vacancies.length <= index,
    `need at least ${index + 1} PUBLISHED vacancy/ies seeded in the scratch DB — see task file`,
  )
  return vacancies[index]!
}

async function gotoStable(page: Page, path: string) {
  await page.goto(path)
  await page.waitForSelector('footer', { state: 'visible' })
}

/** Escapes regex-special characters — vacancy titles are live/dynamic content now, not a fixed literal we control. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Tolerance for "did the overlay land on the real destination" position
 * checks below — NOT an arbitrary fudge factor, two confirmed, geometry-
 * driven (not flaky/random — reproduced within a couple px of the same
 * value across repeated runs) sources of legitimate slop between `destRect`
 * (the morph's animation target, measured ONCE inside `playTitleMorphOverlay`
 * at the destination's mount) and the caller's later `boundingBox()` read
 * (measured well after everything has visually settled):
 *
 * 1. `destRect` is measured while the WRAPPER's OWN lift-enter animation
 *    (`LIFT_OFFSET_ENTER` = 14px, §M v3.1) is still at its INITIAL offset,
 *    not yet settled to `y: 0` — confirmed via a live
 *    `getBoundingClientRect()` timeline (standalone reproduction script):
 *    the destination sits ~14px off at that instant vs. ~300ms later.
 * 2. The forward direction's destination `<h1>` (`careers_.$slug.tsx`) uses
 *    Tailwind `text-balance` (`text-wrap: balance`) at a fluid `clamp()`
 *    font-size — a genuinely async-settling layout feature in Chromium
 *    (line-break balancing can re-run after the element's initial layout,
 *    independent of the lift/morph animations entirely). Reproduced
 *    consistently (~84px, not the back direction's plain, non-balanced
 *    card `<h3>` — confirms it's `text-balance`-specific, not a generic
 *    "recently mounted" effect).
 *
 * 100px comfortably absorbs both while remaining FAR tighter than the
 * broken-code symptom this test guards against: the overlay landing back
 * near its OWN start position (hundreds of px away from the real
 * destination, see the regression comment below).
 *
 * `armOverlayFlightRecorder`/`collectOverlayFlight` below sample the live
 * transform via an in-browser `requestAnimationFrame` loop specifically so
 * this tolerance only has to cover the two geometry effects above, not ALSO
 * Node-side polling jitter under this spec's parallel test execution (a
 * first attempt using Node-side `expect.poll` needed an even larger,
 * load-dependent tolerance to stay green — a strictly worse test).
 */
const POSITION_TOLERANCE_PX = 100

interface MatrixTransform {
  scale: number
  x: number
  y: number
}

/**
 * `getComputedStyle(el).transform` for a pure `translate(Xpx, Ypx) scale(S)`
 * resolves to `matrix(a, b, c, d, e, f)` where (CSS composes transform
 * functions left-to-right as matrix multiplication, translate first so it
 * is NOT itself pre-scaled) `a = d = S`, `e = X`, `f = Y`.
 */
function parseMatrixTransform(value: string): MatrixTransform | null {
  const m = value.match(
    /matrix\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\)/,
  )
  if (!m) return null
  return { scale: parseFloat(m[1]!), x: parseFloat(m[5]!), y: parseFloat(m[6]!) }
}

/**
 * Arms an IN-BROWSER `requestAnimationFrame` recorder for the title-morph
 * overlay's live `getComputedStyle().transform`, BEFORE the caller triggers
 * the click that starts the flight. Must run in-browser (not Node-side
 * `expect.poll`/`setTimeout`): this spec runs several tests concurrently
 * (Playwright's default parallel workers), and Node-side polling intervals
 * are subject to that CPU contention — a first attempt using `expect.poll`
 * reliably UNDER-sampled the tail of the (350ms) animation under load,
 * landing the "last" captured frame well short of the true final frame
 * (confirmed empirically: 40-85px short, scaling with parallel load, not a
 * fixed offset). `requestAnimationFrame` inside the page runs at the
 * browser's own native paint cadence regardless of Node/IPC scheduling,
 * so it reliably captures a frame within ~1 tick of the true end.
 *
 * Reads the COMPUTED style (not `element.style.transform`, the literal
 * inline attribute) — framer-motion's standalone `animate()` drives
 * `transform` via the Web Animations API on a plain DOM node, which does
 * NOT keep rewriting the inline style string every frame; only
 * `getComputedStyle` reflects the live, currently-animating matrix.
 */
async function armOverlayFlightRecorder(page: Page, expectedText: string): Promise<void> {
  await page.evaluate((text) => {
    const w = window as unknown as {
      __morphSamples: string[]
      __morphDone: boolean
    }
    w.__morphSamples = []
    w.__morphDone = false
    const tick = () => {
      const overlay = Array.from(document.body.children).find(
        (el) => el.getAttribute('aria-hidden') === 'true' && el.textContent === text,
      )
      if (overlay) {
        w.__morphSamples.push(getComputedStyle(overlay).transform)
      } else if (w.__morphSamples.length > 0) {
        // Was present, now gone -> the flight is over. Stop recording.
        w.__morphDone = true
        return
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, expectedText)
}

/**
 * Waits for the recorder armed by `armOverlayFlightRecorder` to finish (the
 * overlay appeared, then disappeared), via `page.waitForFunction` — itself
 * polled by Playwright at a `raf`-aligned cadence, but the SAMPLES it's
 * waiting on were already captured natively in-browser, so Node-side
 * scheduling jitter no longer affects sample precision, only how quickly
 * the (already-complete) result is retrieved. Returns the FIRST and LAST
 * successfully-parsed samples of the recorded flight.
 */
async function collectOverlayFlight(
  page: Page,
): Promise<{ first: MatrixTransform; last: MatrixTransform }> {
  await page.waitForFunction(
    () => (window as unknown as { __morphDone: boolean }).__morphDone === true,
    { timeout: 2000, polling: 'raf' },
  )
  const samples = await page.evaluate(
    () => (window as unknown as { __morphSamples: string[] }).__morphSamples,
  )
  const parsed = samples.map(parseMatrixTransform).filter((s): s is MatrixTransform => s !== null)
  const first = parsed[0]
  const last = parsed[parsed.length - 1]
  if (!first || !last)
    throw new Error('title-morph overlay never appeared with a readable transform')
  return { first, last }
}

// ── §M v3.1 Lift cross-fade (base, all page transitions) ─────────────────

test.describe('Lift cross-fade page transitions', () => {
  test('no AnimatePresence / scrim / caret-line artifacts exist anywhere in the DOM', async ({
    page,
  }) => {
    await gotoStable(page, '/')
    // §M.3's removed overlay rendered two `aria-hidden` fixed divs at
    // z-[999]/z-[1000] with distinctive inline styles — assert neither
    // exists, confirming page-transition-overlay.tsx was actually deleted
    // from the bundle, not just unused.
    const scrimLike = await page
      .locator('div[style*="z-index: 999"], div[style*="z-index:999"]')
      .count()
    expect(scrimLike).toBe(0)
  })

  test('client-side navigation moves focus to the new page’s <main> landmark (WCAG 2.4.3)', async ({
    page,
  }) => {
    await gotoStable(page, '/')
    await page.getByRole('link', { name: 'See open roles' }).click()
    await page.waitForURL('**/careers/')
    await page.waitForSelector('footer', { state: 'visible' })
    // Enter transition (DUR_LIFT_ENTER=300ms) must finish before focus moves.
    await expect
      .poll(async () => page.evaluate(() => document.activeElement?.tagName), { timeout: 2000 })
      .toBe('MAIN')
  })

  test('browser back navigation (lightweight/"back" direction) still works and re-focuses <main>', async ({
    page,
  }) => {
    await gotoStable(page, '/')
    await page.getByRole('link', { name: 'See open roles' }).click()
    await page.waitForURL('**/careers/')
    await page.goBack()
    await page.waitForURL(/\/$/)
    await page.waitForSelector('footer', { state: 'visible' })
    await expect
      .poll(async () => page.evaluate(() => document.activeElement?.tagName), { timeout: 2000 })
      .toBe('MAIN')
  })

  test('prefers-reduced-motion: page transition is an instant swap, still lands on <main>', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await gotoStable(page, '/')
    await page.getByRole('link', { name: 'See open roles' }).click()
    await page.waitForURL('**/careers/')
    await page.waitForSelector('footer', { state: 'visible' })
    await expect
      .poll(async () => page.evaluate(() => document.activeElement?.tagName), { timeout: 2000 })
      .toBe('MAIN')
  })
})

// ── §M v3.2 Shared-element title morph, /careers <-> /careers/:slug ──────

test.describe('Title-morph — /careers <-> /careers/:slug', () => {
  // Regression guard for the HIGH fidelity-review finding (2026-07-25): the
  // morph previously NEVER actually flew in either direction — a spurious
  // remount of the SOURCE page (caused by __root.tsx flipping the wrapper's
  // `key` optimistically on `onBeforeNavigate`, before the router actually
  // committed) consumed the one-shot `pendingMorph` before the real
  // destination ever mounted, so the overlay appeared and vanished
  // ~in place (scale stuck at 1, ~14px stray shift from the wrapper's OWN
  // concurrent lift-enter offset — not real travel). The weaker assertions
  // that used to live here ("overlay eventually disappears" + "h1 is
  // eventually visible") were BOTH trivially true even in that broken
  // state, which is exactly why they didn't catch it. These strengthened
  // versions assert the overlay's LIVE computed transform actually changes
  // scale substantially AND its last observed frame lands within a few px
  // of the REAL destination's rect — provably distinguishing "the morph
  // flew to the correct element" from "an overlay appeared and sat still".

  test('forward (list -> detail): overlay clone actually flies from the card to the real <h1>', async ({
    page,
    request,
    baseURL,
  }) => {
    const vacancy = await requireVacancy(request, baseURL, 0)
    await gotoStable(page, '/careers/')
    const card = page.getByRole('link', { name: new RegExp(escapeRegExp(vacancy.title)) })
    const overlay = page.locator('body > div[aria-hidden="true"]', { hasText: vacancy.title })
    const h1 = page.getByRole('heading', { level: 1, name: vacancy.title })

    await armOverlayFlightRecorder(page, vacancy.title)
    await card.click()

    // (a) overlay actually appears and is visible during the transition —
    // not skipped straight through to the base lift.
    await expect(overlay).toBeVisible({ timeout: 1000 })

    // (b) its live transform genuinely animates: font-size scale must climb
    // substantially (card ≈19-20px -> h1 clamp(2rem,5.5vw,3.4rem) ≈ 40-55px
    // on a desktop viewport, i.e. roughly 2x+), measured at two points in
    // time via an in-browser rAF recorder, not a fixed sleep.
    const { first, last } = await collectOverlayFlight(page)
    const scaleDelta = Math.abs(last.scale - first.scale)
    expect(scaleDelta).toBeGreaterThan(0.3)

    await page.waitForURL(new RegExp(`/careers/${vacancy.slug}/?$`))
    await page.waitForSelector('footer', { state: 'visible' })
    await expect(h1).toBeVisible()
    await expect(h1).toHaveCSS('visibility', 'visible')

    // (c) the overlay's LAST observed frame landed within a few px of the
    // REAL <h1>'s actual, settled position — proves it flew to the CORRECT
    // element (not e.g. back onto the same card it started from, which is
    // exactly the broken-code symptom this test guards against).
    const h1Box = await h1.boundingBox()
    if (!h1Box) throw new Error('h1 has no bounding box')
    expect(Math.abs(last.x - h1Box.x)).toBeLessThanOrEqual(POSITION_TOLERANCE_PX)
    expect(Math.abs(last.y - h1Box.y)).toBeLessThanOrEqual(POSITION_TOLERANCE_PX)
  })

  test('back (detail -> list, via "All roles" BackLink): overlay clone actually flies from the <h1> to the real card title', async ({
    page,
    request,
    baseURL,
  }) => {
    const vacancy = await requireVacancy(request, baseURL, 0)
    await gotoStable(page, `/careers/${vacancy.slug}/`)
    const backLink = page.getByRole('link', { name: 'All roles' })
    const overlay = page.locator('body > div[aria-hidden="true"]', { hasText: vacancy.title })
    const cardTitle = page.getByRole('heading', { level: 3, name: vacancy.title })

    await armOverlayFlightRecorder(page, vacancy.title)
    await backLink.click()

    await expect(overlay).toBeVisible({ timeout: 1000 })

    const { first, last } = await collectOverlayFlight(page)
    const scaleDelta = Math.abs(last.scale - first.scale)
    expect(scaleDelta).toBeGreaterThan(0.3)

    await page.waitForURL(/\/careers\/?$/)
    await page.waitForSelector('footer', { state: 'visible' })
    await expect(cardTitle).toBeVisible()
    await expect(cardTitle).toHaveCSS('visibility', 'visible')

    const cardBox = await cardTitle.boundingBox()
    if (!cardBox) throw new Error('card title has no bounding box')
    expect(Math.abs(last.x - cardBox.x)).toBeLessThanOrEqual(POSITION_TOLERANCE_PX)
    expect(Math.abs(last.y - cardBox.y)).toBeLessThanOrEqual(POSITION_TOLERANCE_PX)
  })

  test('direct load on /careers/:slug (no capture) never renders a morph overlay', async ({
    page,
    request,
    baseURL,
  }) => {
    const vacancy = await requireVacancy(request, baseURL, 0)
    await gotoStable(page, `/careers/${vacancy.slug}/`)
    const overlayCount = await page.evaluate(
      (title) =>
        Array.from(document.body.children).filter(
          (el) => el.getAttribute('aria-hidden') === 'true' && el.textContent === title,
        ).length,
      vacancy.title,
    )
    expect(overlayCount).toBe(0)
    await expect(page.getByRole('heading', { level: 1, name: vacancy.title })).toHaveCSS(
      'visibility',
      'visible',
    )
  })

  test('Home teaser -> detail (NOT the /careers list) falls back to the base lift, no morph overlay', async ({
    page,
    request,
    baseURL,
  }) => {
    const vacancy = await requireVacancy(request, baseURL, 0)
    await gotoStable(page, '/')
    const teaserCard = page.getByRole('link', { name: new RegExp(escapeRegExp(vacancy.title)) })
    await teaserCard.click()
    await page.waitForURL(new RegExp(`/careers/${vacancy.slug}/?$`))
    await page.waitForSelector('footer', { state: 'visible' })

    const overlayCount = await page.evaluate(
      (title) =>
        Array.from(document.body.children).filter(
          (el) => el.getAttribute('aria-hidden') === 'true' && el.textContent === title,
        ).length,
      vacancy.title,
    )
    expect(overlayCount).toBe(0)
    await expect(page.getByRole('heading', { level: 1, name: vacancy.title })).toHaveCSS(
      'visibility',
      'visible',
    )
  })

  test('prefers-reduced-motion: capture is skipped, no morph overlay on list -> detail', async ({
    page,
    request,
    baseURL,
  }) => {
    // A DIFFERENT vacancy than the tests above (index 1, not 0) — purely for
    // test isolation/diversity, no functional requirement ties this to a
    // specific one.
    const vacancy = await requireVacancy(request, baseURL, 1)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await gotoStable(page, '/careers/')
    await page.getByRole('link', { name: new RegExp(escapeRegExp(vacancy.title)) }).click()
    await page.waitForURL(new RegExp(`/careers/${vacancy.slug}/?$`))
    await page.waitForSelector('footer', { state: 'visible' })

    const overlayCount = await page.evaluate(
      (title) =>
        Array.from(document.body.children).filter(
          (el) => el.getAttribute('aria-hidden') === 'true' && el.textContent === title,
        ).length,
      vacancy.title,
    )
    expect(overlayCount).toBe(0)
  })
})

// ── Mobile audit fixes (§M v3.4) — 320/375/390 ────────────────────────────

test.describe('Mobile audit fixes', () => {
  for (const width of [320, 375, 390]) {
    test(`hero eyebrow Chip — dot aligns with the FIRST line of text @ ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1200 })
      await gotoStable(page, '/')

      const { dotCenterY, firstLineCenterY } = await page.evaluate(() => {
        // The dot is the first `aria-hidden` span inside <main> (hero eyebrow
        // Chip renders first); its direct parent is the Chip itself.
        const dot = document.querySelector('main span[aria-hidden="true"]')!
        const chip = dot.parentElement!
        const dotRect = dot.getBoundingClientRect()
        // Text is the chip's own text node (a sibling of the dot span).
        const textNode = Array.from(chip.childNodes).find((n) => n.nodeType === Node.TEXT_NODE)!
        const range = document.createRange()
        range.selectNodeContents(textNode)
        const firstLineRect = range.getClientRects()[0]!
        return {
          dotCenterY: dotRect.top + dotRect.height / 2,
          firstLineCenterY: firstLineRect.top + firstLineRect.height / 2,
        }
      })

      expect(Math.abs(dotCenterY - firstLineCenterY)).toBeLessThanOrEqual(3)
    })

    test(`case-study metrics — zero horizontal overlap between adjacent columns @ ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1200 })
      await page.emulateMedia({ reducedMotion: 'reduce' }) // metrics render immediately, no scroll-linked reveal needed
      await gotoStable(page, '/')

      const overlaps = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('#work .grid.grid-cols-3'))
        const results: number[] = []
        for (const grid of cards) {
          const cols = Array.from(grid.children).map((c) => c.getBoundingClientRect())
          for (let i = 0; i < cols.length - 1; i++) {
            results.push(cols[i]!.right - cols[i + 1]!.left) // > 0 means overlap
          }
        }
        return results
      })

      for (const overlap of overlaps) {
        expect(overlap).toBeLessThanOrEqual(0)
      }
      expect(overlaps.length).toBeGreaterThan(0) // sanity — the selector actually found cards
    })
  }
})

// ── §M v3.3 iOS-perf — touch/coarse-pointer emulation ─────────────────────

test.describe('iOS-perf — touch/coarse-pointer', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } })

  test('nav sticky header drops backdrop-filter on touch (computed style)', async ({ page }) => {
    await gotoStable(page, '/')
    const isCoarse = await page.evaluate(
      () => window.matchMedia('(hover: none), (pointer: coarse)').matches,
    )
    test.skip(!isCoarse, 'this Chromium/Playwright combo did not flip to coarse-pointer emulation')

    const backdropFilter = await page.evaluate(
      () => getComputedStyle(document.querySelector('header')!).backdropFilter,
    )
    expect(backdropFilter).toBe('none')
  })

  test('ScrollReveal sections still reveal on touch (one-shot fallback, not broken)', async ({
    page,
  }) => {
    await gotoStable(page, '/')
    const about = page.locator('#about')
    await about.scrollIntoViewIfNeeded()
    await expect.poll(async () => about.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  })

  test('desktop (non-touch) is unaffected — backdrop-filter still present', async ({ browser }) => {
    const context = await browser.newContext({ hasTouch: false })
    const page = await context.newPage()
    await gotoStable(page, '/')
    const backdropFilter = await page.evaluate(
      () => getComputedStyle(document.querySelector('header')!).backdropFilter,
    )
    expect(backdropFilter).not.toBe('none')
    await context.close()
  })
})
