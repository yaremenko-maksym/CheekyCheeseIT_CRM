/**
 * drop-archive-cascade.spec.ts — Drop role - phase 1 (AC6) + round-2
 * UI smoke layer.
 *
 * This is the **mock-based UI smoke** for the drop archive flow. It runs
 * fast (no real backend, no DB) and gates only on:
 *   - Archive button visibility per role (ADMIN sees it; SENIOR doesn't).
 *   - The archive confirm dialog mounts with the right testids.
 *   - The cancel button leaves the page state untouched.
 *
 * The **real backend integration** — including the actual archive cascade
 * (drop user archived, team archived, senior detached, projects archived)
 * — is covered by `drop-archive-real.spec.ts` and
 * `drop-archive-user-real.spec.ts`. Those specs hit live `/api/users/drops`
 * and `/api/teams/:id`, the only way to catch backend regressions like
 * the one fixed in PR #63 where archiving a drop-team didn't archive the
 * DROP user.
 *
 * Keep this spec lean — duplicating real-API assertions here would just
 * mock them away. If you find yourself adding more mocked DB assertions,
 * move them to the real-API spec instead.
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
  test('ADMIN sees the «Архивировать» button on a drop-team detail page', async ({
    asAdmin: page,
  }) => {
    await withDropTeamFixtures(page)
    await page.goto(`/team/${DROP_TEAM.id}`)
    await expect(page.getByTestId('team-archive-button')).toBeVisible({ timeout: 8_000 })
  })

  test('Clicking «Архивировать» on a drop-team opens the archive confirm dialog with cascade copy', async ({
    asAdmin: page,
  }) => {
    await withDropTeamFixtures(page)
    await page.goto(`/team/${DROP_TEAM.id}`)

    await page.getByTestId('team-archive-button').click()
    // The team-archive variant uses the shared archive ArchiveConfirmDialog
    // (apps/web/app/components/archive/ArchiveConfirmDialog.tsx) which
    // exposes `archive-confirm-input` + `archive-confirm-submit` testids.
    await expect(page.getByTestId('archive-confirm-input')).toBeVisible({ timeout: 8_000 })
    await expect(page.getByTestId('archive-confirm-submit')).toBeVisible()
  })

  test('ADMIN can open archive dialog for DROP user from /users', async ({ asAdmin: page }) => {
    await withDropTeamFixtures(page)
    await page.goto('/users')

    // DROP fixture user is included in ALL_USERS — the archive button for
    // their row is the entry point per AC6 (archive дропа = cascade).
    const archiveBtn = page.getByTestId(`user-row-archive-${USERS.drop.id}`)
    await expect(archiveBtn).toBeVisible({ timeout: 8_000 })
    await archiveBtn.click()

    // User-archive dialog uses the per-user variant which carries the
    // `archive-confirm-dialog` testid (apps/web/app/components/users/...).
    await expect(page.getByTestId('archive-confirm-dialog')).toBeVisible({ timeout: 8_000 })
  })

  test('SENIOR cannot trigger drop-team archive (no button rendered)', async ({
    asSenior: page,
  }) => {
    await withDropTeamFixtures(page)
    await page.goto(`/team/${DROP_TEAM.id}`)
    // Senior should still see the read-only page but no archive controls.
    await expect(page.getByTestId('team-archive-button')).toHaveCount(0)
  })

  test('Cancel on the archive confirm dialog leaves the drop-team active', async ({
    asAdmin: page,
  }) => {
    await withDropTeamFixtures(page)
    await page.goto(`/team/${DROP_TEAM.id}`)

    await page.getByTestId('team-archive-button').click()
    // The shared archive dialog doesn't expose a dialog-level testid; gate
    // on the confirm-input + confirm-submit which it always renders.
    await expect(page.getByTestId('archive-confirm-input')).toBeVisible({ timeout: 8_000 })

    // Cancel button — uses the shared dialog footer "Отмена".
    await page.getByRole('button', { name: 'Отмена' }).first().click()
    await expect(page.getByTestId('archive-confirm-input')).not.toBeVisible()
  })
})
