import { devices } from '@playwright/test'
import type { Page } from '@playwright/test'
import { test, expect, USERS, mockAuthAs } from './fixtures'

/**
 * Job sourcing — MOBILE profile (task-job-sourcing-slice1 AC5 + AC7).
 *
 * WHY A MOBILE PROFILE, AND WHY THIS PARTICULAR ASSERTION
 * ------------------------------------------------------
 * «Открыть оригинал» must call `window.open` synchronously inside the click
 * handler. Put an `await` in front of it and the call lands outside the user
 * gesture, where a mobile browser's popup blocker silently drops it — the
 * button does nothing, with no error and no toast (the defect fixed in #476).
 *
 * A naive "expect a popup" assertion CANNOT catch this, for two measured
 * reasons:
 *   1. Playwright launches Chromium with `--disable-popup-blocking`
 *      (playwright-core/lib/server/chromium/chromiumSwitches.js:75), so the
 *      blocker is off entirely;
 *   2. even with it on, Chromium allows `window.open` for the whole ~5 s
 *      TRANSIENT-ACTIVATION window — measured here: `navigator.userActivation
 *      .isActive` reads `true` even for an open issued after `await`. The
 *      strict same-gesture rule is a mobile-Safari behaviour Chromium does not
 *      reproduce.
 *
 * So this spec asserts the ORDERING the strict browsers enforce, by bracketing
 * the click dispatch itself:
 *   - capture-phase `click` on `document` — the FIRST listener for this click,
 *     before React's root-container handler → sets `inGesture = true`;
 *   - bubble-phase `click` on `window` — the LAST listener → clears it.
 *   A synchronous `window.open` inside React's handler lands BETWEEN the two
 *   (`inGesture: true`); anything that awaited a server round-trip first
 *   resumes long after the dispatch finished (`inGesture: false`, and usually
 *   no call at all by assertion time).
 *
 * MEASURED behaviour of this guard (run on this branch, both directions):
 *   correct (synchronous)                → PASS  (`inGesture: true`)
 *   `await fetch(...)` then open (#476)  → FAIL  (no call recorded at all)
 *   `await Promise.resolve()` then open  → PASSES HERE (a microtask resumes
 *       inside React's own dispatch, still bracketed) — that variant is caught
 *       by the UNIT test instead, which asserts `window.open` was already
 *       called when `fireEvent.click` returned:
 *       apps/web/app/components/job-sourcing/__tests__/JobSuggestionDialog.test.tsx.
 * The two layers are complementary on purpose; neither is claimed to catch
 * everything alone.
 */

test.use({ ...devices['Pixel 5'] })

const POSTING = {
  id: '22222222-2222-4222-8222-222222222222',
  sourceType: 'DOU_RSS',
  externalId: 'https://jobs.dou.ua/companies/epam-systems/vacancies/356562',
  url: 'https://jobs.dou.ua/companies/epam-systems/vacancies/356562',
  title: 'Senior Frontend Engineer',
  companyName: 'EPAM',
  location: 'Київ, віддалено',
  descriptionMd:
    'We are **hiring** a frontend engineer.\n\n- Playwright\n- TypeScript\n\n<script>alert(1)</script>',
  publishedAt: '2026-08-07T08:48:38.000Z',
  collectedAt: '2026-08-07T09:00:00.000Z',
}

const SUGGESTION = {
  id: '33333333-3333-4333-8333-333333333333',
  seniorId: USERS.senior.id,
  status: 'NEW',
  statusChangedAt: null,
  statusChangedByName: null,
  createdAt: '2026-08-07T09:00:00.000Z',
  posting: POSTING,
}

type OpenCall = {
  url: string
  inGesture: boolean
  userActivation: boolean | null
  clicksSeen: number
}

declare global {
  interface Window {
    __jobOpenCalls?: OpenCall[]
  }
}

/**
 * Instrument `window.open` + the gesture-task flag. Installed via
 * `addInitScript` so it is in place before any app code runs.
 */
async function instrumentWindowOpen(page: Page) {
  await page.addInitScript(() => {
    const calls: OpenCall[] = []
    ;(window as Window).__jobOpenCalls = calls

    let inGesture = false
    let clicksSeen = 0
    // Opens the window: capture phase on `document` — the FIRST listener to run
    // for this click, before React's root-container handler.
    document.addEventListener(
      'click',
      () => {
        clicksSeen += 1
        inGesture = true
      },
      true,
    )
    // Closes it: bubble phase on `window` — the LAST listener to run. A
    // synchronous `window.open` inside React's handler lands between the two;
    // anything that `await`ed first resumes only after this reset has run.
    window.addEventListener('click', () => {
      inGesture = false
    })

    window.open = ((url?: string | URL) => {
      calls.push({
        url: String(url ?? ''),
        inGesture,
        userActivation: navigator.userActivation?.isActive ?? null,
        clicksSeen,
      })
      // Do not actually open a tab — the assertion is about ordering.
      return null
    }) as typeof window.open
  })
}

async function mockJobSourcing(page: Page, items: unknown[] = [SUGGESTION]) {
  await page.route('**/api/job-sourcing/suggestions**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items, total: items.length }),
    }),
  )
  await page.route('**/api/job-sourcing/exclusions**', (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: '44444444-4444-4444-8444-444444444444',
          scope: 'SENIOR',
          seniorId: USERS.senior.id,
          kind: 'COMPANY',
          value: 'Ciklum',
          normalizedValue: 'ciklum',
          origin: 'MANUAL',
          sourceLabel: null,
          createdAt: '2026-08-07T09:00:00.000Z',
        }),
      })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            id: null,
            scope: 'SENIOR',
            seniorId: USERS.senior.id,
            kind: 'COMPANY',
            value: 'TechCorp AI',
            normalizedValue: 'techcorp ai',
            origin: 'PROJECT',
            sourceLabel: 'AI Platform v2',
            createdAt: null,
          },
        ],
      }),
    })
  })
  await page.route('**/api/job-sourcing/suggestions/*/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...SUGGESTION, status: 'APPLIED' }),
    }),
  )
}

/**
 * Round 3, BLOCKER 2 — the assertion this replaces could not fail.
 *
 * It read `document.documentElement.scrollWidth > clientWidth`. A Radix dialog
 * is `position: fixed`, so it never contributes to the document's scroll width:
 * the check was green no matter how wide the dialog got. Worse, the page BEHIND
 * the dialog is the interviews board, whose column strip is deliberately
 * horizontally scrollable — measured at 1749px inside a 393px viewport — so any
 * page-level width probe is meaningless here in both directions.
 *
 * What actually matters, measured on the dialog itself:
 *   - its box stays inside the viewport (`left >= 0`, `right <= innerWidth`);
 *   - nothing INSIDE it is wider than the viewport (long unbreakable tokens in
 *     a third-party description are the realistic cause);
 *   - it has no horizontal content overflow of its own
 *     (`scrollWidth <= clientWidth`).
 *
 * NOTE on the review's "858px in a 393px viewport": re-measured directly and it
 * does not reproduce — at 320/375/393 the dialog is exactly viewport-wide
 * (left 0, right = innerWidth) with zero overflowing descendants; at 768 it is
 * 672 (`sm:max-w-2xl`) and centred. 858 is an instrumentation artifact — the
 * kanban scroller behind the dialog is the element that really is wider than
 * the viewport. Numbers are in the PR comment.
 */
async function expectDialogFitsViewport(page: Page) {
  const dialog = page.getByTestId('job-suggestion-dialog')

  // The dialog enters with `zoom-in-95` + `slide-in-from-left-1/2` on top of a
  // permanent `translate-x-[-50%]`, so its box is in motion for the first few
  // frames — measured mid-flight it reports `left: -173` in a 393px viewport.
  // Wait for the animations themselves to finish rather than sleeping: this is
  // exact, and it keeps the assertion measuring the settled layout.
  await dialog.evaluate(async (el) => {
    await Promise.all(
      el.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => null)),
    )
  })

  const geometry = await dialog.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const tooWide: string[] = []
    for (const child of Array.from(el.querySelectorAll('*'))) {
      const box = child.getBoundingClientRect()
      if (box.width > window.innerWidth + 1) {
        tooWide.push(
          `${child.tagName}.${String(child.className).slice(0, 40)}=${Math.round(box.width)}`,
        )
      }
    }
    return {
      innerWidth: window.innerWidth,
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      tooWide,
    }
  })

  expect(geometry.left, 'dialog starts off-screen to the left').toBeGreaterThanOrEqual(-1)
  expect(geometry.right, 'dialog extends past the right edge').toBeLessThanOrEqual(
    geometry.innerWidth + 1,
  )
  expect(geometry.tooWide, 'element(s) inside the dialog wider than the viewport').toEqual([])
  expect(geometry.scrollWidth, 'dialog scrolls horizontally').toBeLessThanOrEqual(
    geometry.clientWidth + 1,
  )
}

async function openDialog(page: Page) {
  await page.goto('/interviews')
  await expect(page.getByTestId('interviews-page')).toBeVisible()
  await page.getByTestId('open-job-sourcing').click()
  await expect(page.getByTestId('job-suggestion-dialog')).toBeVisible()
}

test.describe('Job sourcing modal — mobile profile', () => {
  test.beforeEach(async ({ page }) => {
    await instrumentWindowOpen(page)
    await mockAuthAs(page, USERS.senior)
    await mockJobSourcing(page)
  })

  test('AC5: «Открыть оригинал» opens the posting INSIDE the click gesture', async ({ page }) => {
    await openDialog(page)

    const button = page.getByTestId('job-open-original')
    await expect(button).toBeVisible()
    await button.click()

    const calls = await page.evaluate(() => window.__jobOpenCalls ?? [])
    expect(
      calls,
      'no window.open recorded — the handler awaited something before opening',
    ).toHaveLength(1)
    expect(calls[0]?.url).toBe(POSTING.url)
    // The assertion that fails on an `await`-before-open implementation —
    // see the file header for why a popup-count assertion would not.
    expect(
      calls[0]?.inGesture,
      'window.open must run in the same task as the click — an implementation that awaits first is blocked on real mobile browsers',
    ).toBe(true)
  })

  test('AC5: the touch target is comfortable on a phone (>= 44px)', async ({ page }) => {
    await openDialog(page)

    for (const testid of ['job-open-original', 'job-mark-applied', 'job-mark-rejected']) {
      // `offsetHeight`, not `boundingBox()`: the dialog enters with a
      // `zoom-in-95` scale animation, so a bounding box measured mid-animation
      // reports ~42px for a 44px button (measured — this exact flake). The
      // layout height is what the CSS actually specifies and is not affected
      // by the transform.
      const height = await page
        .getByTestId(testid)
        .evaluate((el) => (el as HTMLElement).offsetHeight)
      expect(height, `${testid} height`).toBeGreaterThanOrEqual(44)
    }
  })

  /**
   * Code review round 3: `order-last` was applied but pinned by nothing.
   * `CrmDialogFooter` is `flex-col-reverse` on mobile, so without it «Открыть
   * оригинал» — the FIRST thing a user does — sinks below both verdicts. The
   * assertion is on real rendered geometry, so it fails if the class is dropped
   * or the shared footer's direction changes underneath us.
   */
  test('«Открыть оригинал» sits above the two verdicts on a phone', async ({ page }) => {
    await openDialog(page)

    const top = async (testid: string) => {
      const box = await page.getByTestId(testid).boundingBox()
      return box!.y
    }
    const [open, rejected, applied] = await Promise.all([
      top('job-open-original'),
      top('job-mark-rejected'),
      top('job-mark-applied'),
    ])

    expect(open, '«Открыть оригинал» must be the topmost action').toBeLessThan(rejected)
    expect(rejected, '«Не подходит» must sit above «Откликнулись»').toBeLessThan(applied)
  })

  test('AC6: an injected <script> in the description is not executed or rendered', async ({
    page,
  }) => {
    const consoleErrors: string[] = []
    page.on('pageerror', (err) => consoleErrors.push(err.message))

    await openDialog(page)

    const description = page.getByTestId('job-suggestion-description')
    await expect(description).toBeVisible()
    await expect(description).toContainText('hiring')

    const scriptCount = await description.evaluate((el) => el.querySelectorAll('script').length)
    expect(scriptCount).toBe(0)
    const html = await description.innerHTML()
    expect(html).not.toContain('<script')
    expect(consoleErrors).toEqual([])
  })

  test('the dialog fits the phone viewport — no horizontal overflow', async ({ page }) => {
    await openDialog(page)
    await expectDialogFitsViewport(page)
  })

  test('statuses and the empty state work on mobile', async ({ page }) => {
    await openDialog(page)
    await expect(page.getByTestId('job-suggestion-title')).toHaveText(POSTING.title)

    // After answering, the list refetches — return an empty queue this time.
    await mockJobSourcing(page, [])
    await page.getByTestId('job-mark-applied').click()

    await expect(page.getByTestId('job-suggestion-empty')).toBeVisible()
    await expect(page.getByTestId('job-suggestion-empty')).toContainText('Подходящих вакансий нет')
  })

  test('project-derived exclusions are shown as read-only chips', async ({ page }) => {
    await openDialog(page)

    const derived = page.getByTestId('job-exclusion-derived')
    await expect(derived).toHaveCount(1)
    await expect(derived).toContainText('TechCorp AI')
    // Derived entries have no row to delete — no remove button on them.
    await expect(derived.getByRole('button')).toHaveCount(0)
  })
})

/**
 * AC7 — the modal has to be usable on every device class the CRM supports
 * (`.claude/rules/common/responsive-design.md`: 320 · 768 · 1024 · 1440).
 *
 * Viewports are switched with `setViewportSize` rather than a per-describe
 * `test.use({ ...devices[…] })`, because changing `defaultBrowserType`/
 * `isMobile` inside a describe forces a new worker and Playwright rejects it.
 */
test.describe('Job sourcing modal — responsive widths (AC7)', () => {
  test.beforeEach(async ({ page }) => {
    await instrumentWindowOpen(page)
    await mockAuthAs(page, USERS.senior)
    await mockJobSourcing(page)
  })

  for (const width of [320, 768, 1024, 1440]) {
    test(`no horizontal overflow and controls reachable at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await openDialog(page)

      await expect(page.getByTestId('job-suggestion-title')).toBeVisible()
      await expect(page.getByTestId('job-open-original')).toBeVisible()
      await expect(page.getByTestId('job-mark-applied')).toBeVisible()
      await expect(page.getByTestId('job-mark-rejected')).toBeVisible()

      // Same working check as the mobile suite — the page-level scrollWidth
      // probe that used to live here could not fail (see its docblock).
      await expectDialogFitsViewport(page)
    })
  }

  test('opens in the same gesture at desktop width too', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openDialog(page)

    await page.getByTestId('job-open-original').click()

    const calls = await page.evaluate(() => window.__jobOpenCalls ?? [])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.inGesture).toBe(true)
  })
})
