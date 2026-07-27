/**
 * landing/motion-v3.spec.ts — task-landing-remove-page-transitions.md
 * (docs/design/landing-redesign.md §M v3.0/§M v3.1/§M v3.2, now SUPERSEDED —
 * the lift cross-fade + shared-element title-morph page transitions were
 * removed entirely, owner decision 2026-07-26: "получились криво, очень
 * быстро мигает — уберём совсем"). The two describe blocks that used to
 * exercise that machinery are replaced by `Instant page navigation` below;
 * `Mobile audit fixes` (§M v3.4) and `iOS-perf` (§M v3.3) are UNRELATED to
 * page-transition motion and unchanged.
 *
 * Opt-in `landing` project (same pattern as `responsive.spec.ts` — see its
 * module doc). Requires an externally started `apps/landing` dev server
 * (default `:3002`, override via `LANDING_BASE_URL`).
 */
import { test, expect, type Page } from '@playwright/test'

async function gotoStable(page: Page, path: string) {
  await page.goto(path)
  await page.waitForSelector('footer', { state: 'visible' })
}

// ── Instant page navigation (page-transition removed) ────────────────────

test.describe('Instant page navigation (no page-transition)', () => {
  test('client-side navigation swaps content immediately — never a genuinely empty <body> frame', async ({
    page,
  }) => {
    // In-browser rAF sampler (not Node-side polling — this spec's parallel
    // workers make Node-side setTimeout/expect.poll intervals unreliable at
    // this resolution) — the SAME technique used to originally diagnose the
    // task's "мигание" investigation. Armed BEFORE the click so it captures
    // every painted frame across the whole navigation, not just a
    // post-navigation snapshot.
    await gotoStable(page, '/')
    await page.evaluate(() => {
      const w = window as unknown as { __navSamples: number[] }
      w.__navSamples = []
      const tick = () => {
        w.__navSamples.push(document.body.innerText.length)
        if (w.__navSamples.length < 240) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })

    await page.getByRole('link', { name: 'See open roles' }).click()
    await page.waitForURL('**/careers/')
    await page.waitForSelector('footer', { state: 'visible' })
    await page.waitForTimeout(150) // let the 240-frame sampler finish recording

    const samples = await page.evaluate(
      () => (window as unknown as { __navSamples: number[] }).__navSamples,
    )
    expect(samples.length).toBeGreaterThan(0)
    expect(samples.some((len) => len === 0)).toBe(false)
  })

  test('client-side navigation moves focus to the new page’s <main> landmark (WCAG 2.4.3)', async ({
    page,
  }) => {
    await gotoStable(page, '/')
    await page.getByRole('link', { name: 'See open roles' }).click()
    await page.waitForURL('**/careers/')
    await page.waitForSelector('footer', { state: 'visible' })
    await expect
      .poll(async () => page.evaluate(() => document.activeElement?.tagName), { timeout: 2000 })
      .toBe('MAIN')
  })

  // fix/landing-focus-race — was `test.fixme` (task-landing-e2e-in-ci.md):
  // a real race in `apps/landing/app/routes/__root.tsx`'s `RootDocument()`
  // could swallow a forward-then-immediate-back (A→B→A) round trip entirely.
  // See that file's module doc (on `RootDocument`) for the full root-cause
  // writeup and the fix. Re-enabled once the fix landed; proof of both the
  // original failure (under contention) and the post-fix stability is in the
  // PR that re-enabled this test, not here — this comment intentionally
  // stays short so it doesn't go stale the way the pre-fix writeup would
  // have.
  test('browser back navigation still works and re-focuses <main>', async ({ page }) => {
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

  test('hash-only navigation on the SAME route does NOT steal focus (smoothScrollToId owns it, §M.4)', async ({
    page,
  }) => {
    await gotoStable(page, '/')
    // Focus something first so we can tell if it moved.
    await page.getByRole('link', { name: 'See open roles' }).focus()
    // Scoped to `header` — the footer has its OWN "Contact" link with the
    // same accessible name (strict-mode collision otherwise).
    await page.locator('header').getByRole('link', { name: 'Contact', exact: true }).click()
    await page.waitForURL(/#contact$/)
    await page.waitForTimeout(300) // smooth-scroll settle
    const activeTag = await page.evaluate(() => document.activeElement?.tagName)
    expect(activeTag).not.toBe('MAIN')
  })

  test('forward navigation lands scrolled to the top of the new page', async ({ page }) => {
    await gotoStable(page, '/')
    // Scroll partway down "/" before navigating away.
    await page.mouse.wheel(0, 1200)
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)

    await page.getByRole('link', { name: 'See open roles' }).click()
    await page.waitForURL('**/careers/')
    await page.waitForSelector('footer', { state: 'visible' })
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  })

  test('browser back restores the previous scroll position', async ({ page }) => {
    await gotoStable(page, '/')
    await page.mouse.wheel(0, 1200)
    // `mouse.wheel` dispatches the event but the browser's own scroll
    // handling lags a frame or two — poll instead of a single immediate read
    // (same reasoning as the "forward navigation" test above).
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0)

    await page.getByRole('link', { name: 'See open roles' }).click()
    await page.waitForURL('**/careers/')
    await page.waitForSelector('footer', { state: 'visible' })

    await page.goBack()
    await page.waitForURL(/\/$/)
    await page.waitForSelector('footer', { state: 'visible' })
    await expect
      .poll(() => page.evaluate(() => window.scrollY), { timeout: 2000 })
      .toBeGreaterThan(0)
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
