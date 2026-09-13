/**
 * notification-settings.spec.ts — task-notification-settings-ui
 * (position 7b), AC5/AC6.
 *
 * Real-API/real-UI coverage (not mocked) — the whole point of this screen is
 * a real round-trip through `GET/PUT /api/notifications/preferences` (7a)
 * and RBAC-driven group visibility, neither of which a mocked route
 * exercises (playwright-patterns skill: this exact gap has been walked past
 * repeatedly on earlier tasks per the dispatch brief).
 *
 * AC5. SENIOR toggles a regular type off → survives reload; a locked
 *      (action-required) type cannot be toggled; ADMIN and HR see the
 *      "Ваши предложения" group, SENIOR does not.
 * AC6. No horizontal overflow at any of the seven standard widths; on
 *      320/375 every switch's hit area is >=44x44px; the tab strip itself
 *      is reachable by clicking through it, not just via deep link
 *      (UX-H-1, design review fix-round 2).
 *
 * Both `notification-settings-desktop` and `notification-settings-mobile`
 * containers are ALWAYS in the DOM (Tailwind `hidden md:block`/`md:hidden`
 * — CSS-only breakpoint switch, design spec §8), so every locator below is
 * scoped to exactly one of them to avoid a strict-mode "multiple elements"
 * hit on the duplicated row testids.
 */
import { test, expect, REAL_API_BASE, SEED_EMAILS, loginViaApi } from './fixtures'

const REAL_API = `${REAL_API_BASE}/api`

/**
 * Resets SENIOR's TRANSACTION_ADDED preference back to the default (on) so
 * a re-run of this spec (or another spec sharing the same seed data) never
 * inherits a toggled-off state from a previous run.
 *
 * SR-L-2 (security-review, fix-round 2, PR #675): the reset PUT's failure
 * used to be silently swallowed (`.catch(() => undefined)`) — a failed
 * reset left the shared QA seed data with SENIOR's email OFF, and the NEXT
 * run (or a manual pass) would start from a state nobody set on purpose,
 * with no signal that anything went wrong. Asserting `response.ok()`
 * surfaces that failure the same turn it happens.
 */
async function resetSeniorTransactionAdded(page: import('@playwright/test').Page) {
  await loginViaApi(page, SEED_EMAILS.seniorA)
  const response = await page.request.put(`${REAL_API}/notifications/preferences`, {
    data: { items: [{ type: 'TRANSACTION_ADDED', emailEnabled: true }] },
  })
  expect(response.ok(), 'reset PUT for TRANSACTION_ADDED must succeed').toBe(true)
}

test.describe('Notification settings tab — position 7b', () => {
  test.afterEach(async ({ page }) => {
    await resetSeniorTransactionAdded(page)
  })

  test('SENIOR: toggle a regular type off, it survives reload; a locked type cannot be toggled; no admin group', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_EMAILS.seniorA)
    await page.goto('/profile?tab=notifications')

    const desktop = page.getByTestId('notification-settings-desktop')
    await expect(desktop).toBeVisible()

    const txSwitch = desktop
      .getByTestId('notification-row-desktop-TRANSACTION_ADDED')
      .getByRole('switch')
    await expect(txSwitch).toHaveAttribute('aria-checked', 'true')

    await txSwitch.click()
    await expect(page.getByText('Сохранено')).toBeVisible()
    await expect(txSwitch).toHaveAttribute('aria-checked', 'false')

    // Reload — the switch must come back OFF (not an optimistic-only flip).
    await page.reload()
    const desktopAfterReload = page.getByTestId('notification-settings-desktop')
    await expect(desktopAfterReload).toBeVisible()
    await expect(
      desktopAfterReload
        .getByTestId('notification-row-desktop-TRANSACTION_ADDED')
        .getByRole('switch'),
    ).toHaveAttribute('aria-checked', 'false')

    // Locked type — «Проект ждёт решения» (PROJECT_CONFIRM_REQUIRED).
    const lockedSwitch = desktopAfterReload
      .getByTestId('notification-row-desktop-PROJECT_CONFIRM_REQUIRED')
      .getByRole('switch')
    await expect(lockedSwitch).toHaveAttribute('aria-checked', 'true')
    await expect(lockedSwitch).toHaveAttribute('aria-disabled', 'true')
    await lockedSwitch.click({ force: true })
    // Still checked — the click was a no-op (locked type never sends PUT).
    await expect(lockedSwitch).toHaveAttribute('aria-checked', 'true')

    // No "Ваши предложения" group for a SENIOR viewer.
    await expect(desktopAfterReload.getByTestId('notification-group-admin')).toHaveCount(0)
  })

  test('ADMIN: sees the "Ваши предложения" group', async ({ page }) => {
    await loginViaApi(page, SEED_EMAILS.admin)
    await page.goto('/profile?tab=notifications')
    const desktop = page.getByTestId('notification-settings-desktop')
    await expect(desktop).toBeVisible()
    await expect(desktop.getByTestId('notification-group-admin')).toBeVisible()
  })

  // SR-M-3 (security-review, fix-round 2, PR #675): HR is the OTHER actual
  // recipient of APPROVAL_CONFIRMED/APPROVAL_REJECTED (whoever proposed the
  // project — ADMIN or HR — not "the admin" specifically).
  test('HR: sees the "Ваши предложения" group too', async ({ page }) => {
    await loginViaApi(page, SEED_EMAILS.hrA)
    await page.goto('/profile?tab=notifications')
    const desktop = page.getByTestId('notification-settings-desktop')
    await expect(desktop).toBeVisible()
    await expect(desktop.getByTestId('notification-group-admin')).toBeVisible()
  })

  // SR-M-4 (security-review, fix-round 3, PR #675): ACCOUNTANT is the third
  // actual recipient — a finance-scoped `seniorSharePercentOverride` patch
  // (`projects.service.ts` `update()`) lets ACCOUNTANT propose a share
  // override, and the confirming SENIOR is a different user, so ACCOUNTANT
  // receives these two email types same as ADMIN/HR would.
  test('ACCOUNTANT: sees the "Ваши предложения" group too', async ({ page }) => {
    await loginViaApi(page, SEED_EMAILS.accountant)
    await page.goto('/profile?tab=notifications')
    const desktop = page.getByTestId('notification-settings-desktop')
    await expect(desktop).toBeVisible()
    await expect(desktop.getByTestId('notification-group-admin')).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// AC6 — responsive, no overflow, mobile touch targets
// ---------------------------------------------------------------------------

const RESPONSIVE_WIDTHS = [320, 375, 768, 1024, 1280, 1440, 1920]
const MOBILE_WIDTHS = [320, 375]

test.describe('Notification settings tab — responsive (AC6)', () => {
  test('no horizontal overflow at any standard width', async ({ page }) => {
    await loginViaApi(page, SEED_EMAILS.seniorA)
    await page.goto('/profile?tab=notifications')
    await expect(page.getByTestId('notification-settings-desktop')).toBeVisible()

    for (const width of RESPONSIVE_WIDTHS) {
      await page.setViewportSize({ width, height: 900 })
      const noOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      )
      expect(noOverflow, `horizontal overflow at width ${width}`).toBe(true)
    }
  })

  // UX-H-1 (design review, fix-round 2, PR #675): on 320/375 the profile's
  // tab strip is wider than the viewport (four self-profile tabs no longer
  // fit). Fix-round 2 scrolled the active tab into view via `scrollIntoView`
  // on mount/change; fix-round 3 (SR-L-4) replaced that with a hand-computed
  // `container.scrollLeft` adjustment on the same `overflow-x-auto` wrapper
  // — same visible outcome, verified below the same way regardless of which
  // mechanism produces it. This test drives the tab strip the way a person
  // would (click a tab BUTTON, not a deep link), in BOTH directions, and
  // asserts the just-activated tab actually lands fully inside the viewport
  // — not just "clickable via Playwright's own auto-scroll", which would
  // pass even without the fix.
  test('320px: clicking through the tab strip (Обзор → Уведомления → Обзор) works and scrolls the active tab fully into view', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_EMAILS.seniorA)
    await page.setViewportSize({ width: 320, height: 900 })
    await page.goto('/profile?tab=overview')

    // Scoped to `main` — the bell's own trigger button in the top bar shares
    // the exact accessible name "Уведомления" (`notifications-bell-trigger`).
    const tabBar = page.getByRole('main')
    const notificationsTab = tabBar.getByRole('button', { name: 'Уведомления' })
    const overviewTab = tabBar.getByRole('button', { name: 'Обзор' })

    await notificationsTab.click()
    await expect(page.getByTestId('notification-settings-mobile')).toBeVisible()
    let box = await notificationsTab.boundingBox()
    expect(box, 'notifications tab must have a bounding box after being clicked').not.toBeNull()
    expect(
      box!.x,
      'notifications tab must be fully scrolled into view (left edge)',
    ).toBeGreaterThanOrEqual(0)
    expect(
      box!.x + box!.width,
      'notifications tab must be fully scrolled into view (right edge)',
    ).toBeLessThanOrEqual(320)

    await overviewTab.click()
    await expect(page.getByTestId('notification-settings-mobile')).toHaveCount(0)
    box = await overviewTab.boundingBox()
    expect(box, 'overview tab must have a bounding box after being clicked').not.toBeNull()
    expect(
      box!.x,
      'overview tab must be fully scrolled into view (left edge)',
    ).toBeGreaterThanOrEqual(0)
    expect(
      box!.x + box!.width,
      'overview tab must be fully scrolled into view (right edge)',
    ).toBeLessThanOrEqual(320)
  })

  test('mobile switch hit area is >=44x44 on 320/375', async ({ page }) => {
    // Separate test (not a conditional inside the overflow loop above) —
    // `eslint-plugin-playwright`'s `no-conditional-expect` forbids an
    // `expect()` gated behind an `if`; two unconditional loops over two
    // width sets is the same coverage without the conditional.
    await loginViaApi(page, SEED_EMAILS.seniorA)
    await page.goto('/profile?tab=notifications')

    for (const width of MOBILE_WIDTHS) {
      await page.setViewportSize({ width, height: 900 })
      const mobile = page.getByTestId('notification-settings-mobile')
      await expect(mobile).toBeVisible()
      const sw = mobile.getByTestId('notification-row-mobile-TRANSACTION_ADDED').getByRole('switch')
      const box = await sw.boundingBox()
      expect(box?.width ?? 0, `switch hit width at ${width}`).toBeGreaterThanOrEqual(44)
      expect(box?.height ?? 0, `switch hit height at ${width}`).toBeGreaterThanOrEqual(44)
    }
  })
})
