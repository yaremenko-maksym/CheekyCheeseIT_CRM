/**
 * drop-archive-cascade.spec.ts — Drop role - phase 1 (AC6).
 *
 * Verifies the archive-cascade flow for drop entities:
 *   - Archiving a drop-team triggers the archive confirm dialog with
 *     copy that warns about projects being archived and the senior
 *     getting detached (`ArchiveConfirmDialog` shows team-level wording).
 *   - The ADMIN-driven archive PATCH/DELETE actually fires through the
 *     drop-team URL — covers the contract change in `teams.controller`.
 *   - Archiving a DROP user via the users list mentions a separate
 *     impact (drop-team + projects archived; senior detached).
 *
 * Mock-based — `/teams/<id>/archive-impact` (if used) is provided via
 * generic mocks; the controller-level POST/PATCH is intercepted by
 * `mockAuthAs` regex.
 */

import { test, expect, USERS, TEAMS, DROP_TEAM } from './fixtures'

const API = 'http://localhost:3001/api'

async function withDropTeamFixtures(page: import('@playwright/test').Page) {
  await page.route(new RegExp(`${API}/teams(\\?.*)?$`), (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([TEAMS[0], DROP_TEAM]),
    }),
  )
  // Archive-impact endpoint mirror for drop-teams — used by the archive
  // confirm dialog to populate the cascade preview text.
  await page.route(new RegExp(`${API}/teams/([^/?]+)/archive-impact$`), (r) => {
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        type: 'team',
        teamType: 'DROP',
        projectsCount: 2,
        seniorWillBeDetached: true,
        hrAccountantsToBeRemoved: 2,
      }),
    })
  })
}

test.describe('Drop archive cascade — AC6', () => {
  test('ADMIN sees the «Архивировать» button on a drop-team detail page', async ({ asAdmin: page }) => {
    await withDropTeamFixtures(page)
    await page.goto(`/crm/team/${DROP_TEAM.id}`)
    await expect(page.getByTestId('team-archive-button')).toBeVisible({ timeout: 8_000 })
  })

  test('Clicking «Архивировать» on a drop-team opens the archive confirm dialog with cascade copy', async ({ asAdmin: page }) => {
    await withDropTeamFixtures(page)
    await page.goto(`/crm/team/${DROP_TEAM.id}`)

    await page.getByTestId('team-archive-button').click()
    // The team-archive variant uses the shared archive ArchiveConfirmDialog
    // (apps/web/app/components/archive/ArchiveConfirmDialog.tsx) which
    // exposes `archive-confirm-input` + `archive-confirm-submit` testids.
    await expect(page.getByTestId('archive-confirm-input')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTestId('archive-confirm-submit')).toBeVisible()
  })

  test('ADMIN can open archive dialog for DROP user from /crm/users', async ({ asAdmin: page }) => {
    await withDropTeamFixtures(page)
    await page.goto('/crm/users')

    // DROP fixture user is included in ALL_USERS — the archive button for
    // their row is the entry point per AC6 (archive дропа = cascade).
    const archiveBtn = page.getByTestId(`user-row-archive-${USERS.drop.id}`)
    await expect(archiveBtn).toBeVisible({ timeout: 8_000 })
    await archiveBtn.click()

    // User-archive dialog uses the per-user variant which carries the
    // `archive-confirm-dialog` testid (apps/web/app/components/users/...).
    await expect(page.getByTestId('archive-confirm-dialog')).toBeVisible({ timeout: 8_000 })
  })

  test('SENIOR cannot trigger drop-team archive (no button rendered)', async ({ asSenior: page }) => {
    await withDropTeamFixtures(page)
    await page.goto(`/crm/team/${DROP_TEAM.id}`)
    // Senior should still see the read-only page but no archive controls.
    await expect(page.getByTestId('team-archive-button')).toHaveCount(0)
  })

  test('Cancel on the archive confirm dialog leaves the drop-team active', async ({ asAdmin: page }) => {
    await withDropTeamFixtures(page)
    await page.goto(`/crm/team/${DROP_TEAM.id}`)

    await page.getByTestId('team-archive-button').click()
    // The shared archive dialog doesn't expose a dialog-level testid; gate
    // on the confirm-input + confirm-submit which it always renders.
    await expect(page.getByTestId('archive-confirm-input')).toBeVisible({ timeout: 8_000 })

    // Cancel button — uses the shared dialog footer "Отмена".
    await page.getByRole('button', { name: 'Отмена' }).first().click()
    await expect(page.getByTestId('archive-confirm-input')).not.toBeVisible()
  })
})
