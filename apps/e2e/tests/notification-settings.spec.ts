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
 *      (action-required) type cannot be toggled; ADMIN sees the "Для
 *      администратора" group, SENIOR does not.
 * AC6. No horizontal overflow at any of the seven standard widths; on
 *      320/375 every switch's hit area is >=44x44px.
 *
 * Both `notification-settings-desktop` and `notification-settings-mobile`
 * containers are ALWAYS in the DOM (Tailwind `hidden md:block`/`md:hidden`
 * — CSS-only breakpoint switch, design spec §8), so every locator below is
 * scoped to exactly one of them to avoid a strict-mode "multiple elements"
 * hit on the duplicated row testids.
 */
import { test, expect, REAL_API_BASE, SEED_EMAILS, loginViaApi } from './fixtures'

const REAL_API = `${REAL_API_BASE}/api`

/** Resets SENIOR's TRANSACTION_ADDED preference back to the default (on)
 * so a re-run of this spec (or another spec sharing the same seed data)
 * never inherits a toggled-off state from a previous run. */
async function resetSeniorTransactionAdded(page: import('@playwright/test').Page) {
  await loginViaApi(page, SEED_EMAILS.seniorA)
  await page.request
    .put(`${REAL_API}/notifications/preferences`, {
      data: { items: [{ type: 'TRANSACTION_ADDED', emailEnabled: true }] },
    })
    .catch(() => undefined)
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

    // No "Для администратора" group for a SENIOR viewer.
    await expect(desktopAfterReload.getByTestId('notification-group-admin')).toHaveCount(0)
  })

  test('ADMIN: sees the "Для администратора" group', async ({ page }) => {
    await loginViaApi(page, SEED_EMAILS.admin)
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

test.describe('Notification settings tab — responsive (AC6)', () => {
  test('no horizontal overflow at any standard width; mobile switch hit area >=44x44', async ({
    page,
  }) => {
    await loginViaApi(page, SEED_EMAILS.seniorA)
    await page.goto('/profile?tab=notifications')
    await expect(page.getByTestId('notification-settings-desktop')).toBeVisible()

    for (const width of RESPONSIVE_WIDTHS) {
      await page.setViewportSize({ width, height: 900 })
      const noOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      )
      expect(noOverflow, `horizontal overflow at width ${width}`).toBe(true)

      if (width < 768) {
        const mobile = page.getByTestId('notification-settings-mobile')
        await expect(mobile).toBeVisible()
        const sw = mobile
          .getByTestId('notification-row-mobile-TRANSACTION_ADDED')
          .getByRole('switch')
        const box = await sw.boundingBox()
        expect(box?.width ?? 0, `switch hit width at ${width}`).toBeGreaterThanOrEqual(44)
        expect(box?.height ?? 0, `switch hit height at ${width}`).toBeGreaterThanOrEqual(44)
      }
    }
  })
})
