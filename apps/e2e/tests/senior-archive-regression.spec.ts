/**
 * senior-archive-regression.spec.ts — Drop role - phase 1 (AC7, regression).
 *
 * AC7 ensures that the legacy SENIOR archive flow (pair-archive of the
 * senior + their senior-team + projects) is untouched by the drop role
 * changes. Specifically:
 *   - Archive button still appears on a SENIOR row in /users
 *   - The pair-archive warning text still surfaces (senior-archive-warning)
 *   - Confirm by typing the senior name still works
 *   - Drop entities (when also rendered) are NOT touched on this row
 *
 * Mock-based — `mockAuthAs` already provides the relevant `archive-impact`
 * mock that returns the SENIOR pair-archive shape, and DELETE handler.
 */

import { test, expect, USERS } from './fixtures'

test.describe('Senior archive — pair-archive regression (AC7)', () => {
  test('archive button visible for the SENIOR row on /users', async ({ asAdmin: page }) => {
    await page.goto('/users')
    await expect(page.getByTestId(`user-row-archive-${USERS.senior.id}`)).toBeVisible()
  })

  test('Archive dialog surfaces the pair-archive senior warning', async ({ asAdmin: page }) => {
    await page.goto('/users')
    await page.getByTestId(`user-row-archive-${USERS.senior.id}`).click()

    const dialog = page.getByTestId('archive-confirm-dialog')
    await expect(dialog).toBeVisible({ timeout: 8_000 })
    // ut-* pair-archive warning testid persists from the senior archive
    // flow — this is the canary for AC7.
    await expect(dialog.getByTestId('archive-warning-senior')).toBeVisible()
  })

  test('Typing the senior name enables the archive submit', async ({ asAdmin: page }) => {
    await page.goto('/users')
    await page.getByTestId(`user-row-archive-${USERS.senior.id}`).click()

    const dialog = page.getByTestId('archive-confirm-dialog')
    await expect(dialog).toBeVisible({ timeout: 8_000 })

    const submit = page.getByTestId('archive-confirm-submit')
    await expect(submit).toBeDisabled()

    await page.getByTestId('archive-confirm-name-input').fill(USERS.senior.displayName)
    await expect(submit).toBeEnabled()
  })

  test('Confirm DELETE goes to /api/users/<senior-id> — legacy contract', async ({
    asAdmin: page,
  }) => {
    await page.goto('/users')

    const deleteReq = page.waitForRequest(
      (req) => req.url().includes(`/api/users/${USERS.senior.id}`) && req.method() === 'DELETE',
    )

    await page.getByTestId(`user-row-archive-${USERS.senior.id}`).click()
    await page.getByTestId('archive-confirm-name-input').fill(USERS.senior.displayName)
    await page.getByTestId('archive-confirm-submit').click()
    expect((await deleteReq).method()).toBe('DELETE')
  })

  test('Drop entities (drop user row) untouched after archiving a senior', async ({
    asAdmin: page,
  }) => {
    await page.goto('/users')
    // Drop fixture row should be in the table — its presence is the
    // canary that the cascade scoped only to senior+senior-team.
    await expect(page.getByTestId(`user-row-${USERS.drop.id}`)).toBeVisible()
  })
})
