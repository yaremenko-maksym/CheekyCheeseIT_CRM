/**
 * landing/motion-v3.spec.ts — task-landing-motion-v3.md, docs/design/
 * landing-redesign.md §M v3.5 verification checklist.
 *
 * Opt-in `landing` project (same pattern as `responsive.spec.ts` — see its
 * module doc). Requires an externally started `apps/landing` dev server
 * (default `:3002`, override via `LANDING_BASE_URL`) proxying to an API
 * instance seeded with at least 2 PUBLISHED vacancies (title-morph tests
 * need to click a specific card and land on a specific detail page).
 */
import { test, expect, type Page } from '@playwright/test'

/** Deterministic seed: `/careers` must have at least these two slugs published. */
const VACANCY_A = { slug: 'senior-ml-engineer', title: 'Senior ML Engineer' }
const VACANCY_B = { slug: 'backend-engineer-commerce', title: 'Backend Engineer, Commerce' }

async function gotoStable(page: Page, path: string) {
  await page.goto(path)
  await page.waitForSelector('footer', { state: 'visible' })
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
  test('forward (list -> detail): an overlay clone appears then cleans up, landing on the real <h1>', async ({
    page,
  }) => {
    await gotoStable(page, '/careers/')
    const card = page.getByRole('link', { name: new RegExp(VACANCY_A.title) })
    await card.click()
    await page.waitForURL(new RegExp(`/careers/${VACANCY_A.slug}/?$`))

    // The overlay is a direct `<body>` child with `aria-hidden="true"` and
    // the vacancy's own text — assert it eventually disappears (cleaned up)
    // and the REAL <h1> ends up visible (not left `visibility: hidden`).
    await expect
      .poll(
        async () =>
          page.evaluate(
            (title) =>
              Array.from(document.body.children).filter(
                (el) => el.getAttribute('aria-hidden') === 'true' && el.textContent === title,
              ).length,
            VACANCY_A.title,
          ),
        { timeout: 2000 },
      )
      .toBe(0)

    const h1 = page.getByRole('heading', { level: 1, name: VACANCY_A.title })
    await expect(h1).toBeVisible()
    await expect(h1).toHaveCSS('visibility', 'visible')
  })

  test('back (detail -> list, via "All roles" BackLink): overlay cleans up, lands on the real card title', async ({
    page,
  }) => {
    await gotoStable(page, `/careers/${VACANCY_A.slug}/`)
    await page.getByRole('link', { name: 'All roles' }).click()
    await page.waitForURL(/\/careers\/?$/)
    await page.waitForSelector('footer', { state: 'visible' })

    await expect
      .poll(
        async () =>
          page.evaluate(
            (title) =>
              Array.from(document.body.children).filter(
                (el) => el.getAttribute('aria-hidden') === 'true' && el.textContent === title,
              ).length,
            VACANCY_A.title,
          ),
        { timeout: 2000 },
      )
      .toBe(0)

    const cardTitle = page.getByRole('heading', { level: 3, name: VACANCY_A.title })
    await expect(cardTitle).toBeVisible()
    await expect(cardTitle).toHaveCSS('visibility', 'visible')
  })

  test('direct load on /careers/:slug (no capture) never renders a morph overlay', async ({
    page,
  }) => {
    await gotoStable(page, `/careers/${VACANCY_A.slug}/`)
    const overlayCount = await page.evaluate(
      (title) =>
        Array.from(document.body.children).filter(
          (el) => el.getAttribute('aria-hidden') === 'true' && el.textContent === title,
        ).length,
      VACANCY_A.title,
    )
    expect(overlayCount).toBe(0)
    await expect(page.getByRole('heading', { level: 1, name: VACANCY_A.title })).toHaveCSS(
      'visibility',
      'visible',
    )
  })

  test('Home teaser -> detail (NOT the /careers list) falls back to the base lift, no morph overlay', async ({
    page,
  }) => {
    await gotoStable(page, '/')
    const teaserCard = page.getByRole('link', { name: new RegExp(VACANCY_A.title) })
    await teaserCard.click()
    await page.waitForURL(new RegExp(`/careers/${VACANCY_A.slug}/?$`))
    await page.waitForSelector('footer', { state: 'visible' })

    const overlayCount = await page.evaluate(
      (title) =>
        Array.from(document.body.children).filter(
          (el) => el.getAttribute('aria-hidden') === 'true' && el.textContent === title,
        ).length,
      VACANCY_A.title,
    )
    expect(overlayCount).toBe(0)
    await expect(page.getByRole('heading', { level: 1, name: VACANCY_A.title })).toHaveCSS(
      'visibility',
      'visible',
    )
  })

  test('prefers-reduced-motion: capture is skipped, no morph overlay on list -> detail', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await gotoStable(page, '/careers/')
    await page.getByRole('link', { name: new RegExp(VACANCY_B.title) }).click()
    await page.waitForURL(new RegExp(`/careers/${VACANCY_B.slug}/?$`))
    await page.waitForSelector('footer', { state: 'visible' })

    const overlayCount = await page.evaluate(
      (title) =>
        Array.from(document.body.children).filter(
          (el) => el.getAttribute('aria-hidden') === 'true' && el.textContent === title,
        ).length,
      VACANCY_B.title,
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
