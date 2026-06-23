/**
 * app-shell-responsive.spec.ts
 *
 * Responsive behaviour of the CRM app-shell introduced in PR #287
 * (feat(web): app-shell header identity block + full responsive adaptive).
 *
 * Covered:
 *   R1 — Desktop (≥lg, 1280×720): identity block visible, desktop aside visible,
 *         burger button hidden.
 *   R2 — Mobile (375×812): identity block hidden, desktop aside hidden,
 *         burger visible → click → Sheet dialog opens with nav list.
 *   R3 — Overflow smoke: no horizontal scroll at 375 and 1280 on the root route.
 *
 * Notes:
 *   - Uses `asSenior` fixture (mockAuthAs) — no OAuth, no real backend.
 *   - Viewport is set per-test via `page.setViewportSize()` AFTER goto so that
 *     Playwright's default 1280px context is overridden in the mobile tests only.
 *   - The desktop aside is the `<aside>` / complementary landmark rendered by
 *     NavSidebar for md+ screens (hidden md:block CSS class → aria-hidden on mobile).
 *   - The mobile burger has aria-label="Открыть меню" and is md:hidden.
 *   - The mobile Sheet opens as role="dialog" and contains the nav links.
 */

import { test, expect, USERS } from './fixtures'

// ---------------------------------------------------------------------------
// R1 — Desktop ≥lg (1280×720)
// ---------------------------------------------------------------------------

test.describe('R1 — App-shell desktop (1280×720)', () => {
  test('identity block visible, desktop sidebar visible, burger hidden', async ({ asSenior }) => {
    await asSenior.goto('/')

    // Default Playwright Desktop Chrome viewport is already 1280×720, but set
    // explicitly so the test is self-documenting and immune to config drift.
    await asSenior.setViewportSize({ width: 1280, height: 720 })

    // Identity block (name + email) — rendered with hidden lg:flex, so it
    // becomes a flex container at ≥1024px and is visible in the layout.
    const identityBlock = asSenior.getByTestId('header-user-identity')
    await expect(identityBlock).toBeVisible()

    // Both name and email are present inside the block.
    await expect(identityBlock.getByText(USERS.senior.displayName, { exact: true })).toBeVisible()
    await expect(identityBlock.getByText(USERS.senior.email, { exact: true })).toBeVisible()

    // Desktop sidebar: NavSidebar renders an <aside> visible from md breakpoint.
    // Assert the complementary landmark exists and is attached (visible in layout).
    await expect(asSenior.locator('aside').first()).toBeVisible()

    // Burger button (md:hidden) must NOT be visible at desktop width.
    const burger = asSenior.getByRole('button', { name: 'Открыть меню' })
    await expect(burger).not.toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// R2 — Mobile (375×812)
// ---------------------------------------------------------------------------

test.describe('R2 — App-shell mobile (375×812)', () => {
  test('identity block hidden, desktop sidebar hidden, burger visible', async ({ asSenior }) => {
    await asSenior.goto('/')
    await asSenior.setViewportSize({ width: 375, height: 812 })

    // Identity block is hidden lg:flex — at 375px (< 1024px) it must be hidden.
    // Use toBeHidden() because the element exists in DOM but is CSS-hidden.
    const identityBlock = asSenior.getByTestId('header-user-identity')
    await expect(identityBlock).toBeHidden()

    // Desktop aside is hidden on mobile (hidden md:block at <768px is hidden too).
    // At 375px the aside is CSS-hidden (display:none) — not visible.
    // We check the complementary landmark is not visible (may still be in DOM).
    const aside = asSenior.locator('aside').first()
    await expect(aside).toBeHidden()

    // Burger button (md:hidden means it IS shown below md=768px, and 375<768) must be visible.
    const burger = asSenior.getByRole('button', { name: 'Открыть меню' })
    await expect(burger).toBeVisible()
  })

  test('burger click opens Sheet dialog with navigation links', async ({ asSenior }) => {
    await asSenior.goto('/')
    await asSenior.setViewportSize({ width: 375, height: 812 })

    const burger = asSenior.getByRole('button', { name: 'Открыть меню' })
    await expect(burger).toBeVisible()
    await burger.click()

    // NavSidebar renders a Sheet (Radix Dialog) for mobile — role="dialog".
    const sheet = asSenior.getByRole('dialog')
    await expect(sheet).toBeVisible()

    // The Sheet must contain at least one nav link — proves nav is rendered inside.
    // Use the complementary/navigation inside the dialog rather than global getByRole
    // to avoid matching potential other dialogs.
    const navInsideSheet = sheet.getByRole('navigation')
    await expect(navInsideSheet).toBeVisible()

    // Verify at least one known nav link is present inside the Sheet.
    await expect(navInsideSheet.getByRole('link', { name: /Профиль/i })).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// R3 — Overflow smoke (no horizontal scroll)
// ---------------------------------------------------------------------------

test.describe('R3 — No horizontal overflow', () => {
  test('no horizontal scroll at 375px on root route', async ({ asSenior }) => {
    await asSenior.goto('/')
    await asSenior.setViewportSize({ width: 375, height: 812 })

    const overflows = await asSenior.evaluate(() => {
      return document.documentElement.scrollWidth <= document.documentElement.clientWidth
    })
    expect(overflows, 'horizontal scroll detected at 375px').toBe(true)
  })

  test('no horizontal scroll at 1280px on root route', async ({ asSenior }) => {
    await asSenior.goto('/')
    await asSenior.setViewportSize({ width: 1280, height: 720 })

    const overflows = await asSenior.evaluate(() => {
      return document.documentElement.scrollWidth <= document.documentElement.clientWidth
    })
    expect(overflows, 'horizontal scroll detected at 1280px').toBe(true)
  })
})
