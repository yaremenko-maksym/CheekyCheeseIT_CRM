import type { Locator, Page } from '@playwright/test'

/**
 * A SENIOR needs at least one technical role (`SENIOR_MIN_ROLES` in @crm/shared); the forms block
 * submit with none. Two roles, in the canonical `sortRoles` order, so a payload assertion can
 * compare the array as written.
 */
export const SENIOR_ROLES = ['BACKEND_ENGINEER', 'FRONTEND_ENGINEER'] as const

/** `scope` may be the page or a dialog; the add-popover renders in a portal, so rows are page-level. */
function pageOf(scope: Page | Locator): Page {
  return 'page' in scope ? scope.page() : scope
}

/**
 * Picks technical roles the way a user does: open the add popover, click one row per role, close it.
 * The popover stays open between picks, so one open covers the whole list.
 */
export async function pickRoles(
  scope: Page | Locator,
  roles: readonly string[] = SENIOR_ROLES,
): Promise<void> {
  if (roles.length === 0) return
  const page = pageOf(scope)
  await scope.getByTestId('roles-section-add-trigger').click()
  for (const role of roles) {
    await page.getByTestId(`roles-section-option-${role}`).click()
  }
  // Dismisses the popover only: it is the topmost dismissable layer, above the dialog.
  await page.keyboard.press('Escape')
  // Radix PopoverContent also carries role="dialog", so until it is gone a caller's
  // `getByRole('dialog')` resolves to two elements and fails strict mode.
  await page.getByTestId('roles-section-popover').waitFor({ state: 'detached' })
  await scope.getByTestId(`roles-section-chip-${roles[roles.length - 1]}`).waitFor()
}
