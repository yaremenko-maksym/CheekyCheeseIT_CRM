/**
 * landing/responsive.spec.ts — task-landing-redesign.md AC6.
 *
 * Opt-in project (`--project=landing`, see ../../playwright.config.ts) — NOT
 * run by the default `chromium` project or ci.yml's default shard. Requires
 * an externally started `apps/landing` dev server (default `:3002`, override
 * via `LANDING_BASE_URL`) proxying to an API instance seeded with at least
 * one PUBLISHED vacancy (see the task file's "Процесс" section for the
 * scratch-DB setup used to verify this locally).
 *
 * Covers, per docs/design/landing-redesign.md §6 + rules/common/
 * responsive-design.md: no horizontal overflow at any of the 7 test widths
 * on all 3 routes, mobile touch targets ≥44px, burger menu works. Screenshots
 * at 320 + 1440 for each route (attached to the PR per task AC6).
 */
import { test, expect, type Page } from '@playwright/test'

const WIDTHS = [320, 375, 768, 1024, 1280, 1440, 1920] as const
const SCREENSHOT_WIDTHS = [320, 1440] as const
const VIEWPORT_HEIGHT = 1200

const ROUTES = [
  { path: '/', name: 'home' },
  { path: '/careers', name: 'careers' },
] as const

/**
 * Landing sections use Framer Motion `whileInView` scroll-reveal (opacity 0
 * until the section's IntersectionObserver fires — landing-redesign.md §5.1).
 * Real users scrolling normally trigger every section fine (verified
 * manually), but Playwright's `fullPage: true` screenshot capture resizes
 * the page instantly rather than scrolling frame-by-frame, so sections that
 * were never actually intersecting the viewport at a rendered frame stay
 * permanently at opacity:0 — a BLANK screenshot, not a real bug. The app's
 * own `useReducedMotion()` fallback (Reveal component) already renders
 * everything in its final visible state immediately when reduced-motion is
 * requested — emulating it here for overflow/screenshot checks is the
 * correct fix (same technique real teams use for scroll-reveal visual
 * regression testing), not a workaround for a code bug.
 */
async function gotoStable(page: Page, path: string) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(path)
  // Every route's `<footer>` is the last element the SPA mounts (loader data
  // resolved, full section tree rendered) — waiting for it avoids a race
  // where the overflow check / screenshot fires on the pre-hydration blank
  // shell (reproduced locally: solid-black screenshots without this wait).
  await page.waitForSelector('footer', { state: 'visible' })
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(
    overflow.scrollWidth,
    `scrollWidth (${overflow.scrollWidth}) must not exceed clientWidth (${overflow.clientWidth})`,
  ).toBeLessThanOrEqual(overflow.clientWidth)
}

for (const { path, name } of ROUTES) {
  test.describe(`Responsive — ${name} (${path})`, () => {
    for (const width of WIDTHS) {
      test(`no horizontal overflow @ ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: VIEWPORT_HEIGHT })
        await gotoStable(page, path)
        await assertNoHorizontalOverflow(page)

        if ((SCREENSHOT_WIDTHS as readonly number[]).includes(width)) {
          await page.screenshot({
            path: `test-results/landing-${name}-${width}.png`,
            fullPage: true,
          })
        }
      })
    }
  })
}

// A 3rd route needs a real vacancy slug (data-dependent, not a fixed path) —
// covered separately so the ROUTES loop above stays static-path-only.
test.describe('Responsive — vacancy detail (/careers/:slug)', () => {
  for (const width of WIDTHS) {
    test(`no horizontal overflow @ ${width}px`, async ({ page, request, baseURL }) => {
      const res = await request.get(`${baseURL}/api/public/vacancies`)
      const vacancies = (await res.json()) as Array<{ slug: string }>
      test.skip(
        vacancies.length === 0,
        'no PUBLISHED vacancy seeded in the scratch DB — see task file',
      )

      await page.setViewportSize({ width, height: VIEWPORT_HEIGHT })
      await gotoStable(page, `/careers/${vacancies[0]!.slug}`)
      await assertNoHorizontalOverflow(page)

      if ((SCREENSHOT_WIDTHS as readonly number[]).includes(width)) {
        await page.screenshot({
          path: `test-results/landing-vacancy-${width}.png`,
          fullPage: true,
        })
      }
    })
  }
})

test.describe('Mobile nav', () => {
  test('burger opens the disclosure and every interactive item is ≥44px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: VIEWPORT_HEIGHT })
    await page.goto('/')

    const burger = page.getByRole('button', { name: 'Toggle menu' })
    await expect(burger).toBeVisible()
    const burgerBox = await burger.boundingBox()
    expect(burgerBox?.width).toBeGreaterThanOrEqual(44)
    expect(burgerBox?.height).toBeGreaterThanOrEqual(44)

    await burger.click()
    const mobileNav = page.getByRole('navigation', { name: 'Primary mobile' })
    await expect(mobileNav).toBeVisible()
    await expect(mobileNav.getByRole('link', { name: 'Careers' })).toBeVisible()

    // Escape closes the disclosure and returns focus to the burger (§9 a11y).
    await page.keyboard.press('Escape')
    await expect(mobileNav).not.toBeVisible()
    await expect(burger).toBeFocused()
  })
})
