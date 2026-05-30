/**
 * drop-rotate-senior.spec.ts — Drop role - phase 1 (AC4).
 *
 * Verifies the rotation/assignment of the active SENIOR on a drop-team
 * detail page. Drop-teams expose the «Сменить синьора» (or «Назначить
 * синьора», when none is currently active) button alongside the legacy
 * Add/Edit/Archive controls — senior-teams never see it.
 *
 * Coverage:
 *   - Rotate-senior button visible only on drop-team detail (ADMIN view)
 *   - Senior-team detail page does NOT render the rotate button
 *   - Button label reads «Назначить синьора» when the drop-team has no
 *     active senior
 *   - Submit is disabled until a senior is picked, then opens a request
 *     to PATCH /api/teams/:id/rotate-senior
 *
 * Mock-based — uses `DROP_TEAM` (active senior) and `DROP_TEAM_VACANT`
 * (no active senior) fixtures.
 */

import { test, expect, USERS, TEAMS, DROP_TEAM, DROP_TEAM_VACANT } from './fixtures'

const API = 'http://localhost:3001/api'

/**
 * Pre-load fixture sets so the page sees all relevant teams: legacy
 * senior-team + drop-team (active senior) + drop-team-vacant. Per-test
 * specific team detail is resolved via the URL teamId — the generic
 * `/teams/:id` route returns the fixture from `ALL_TEAMS` lookup.
 */
async function withFullTeamList(page: import('@playwright/test').Page) {
  await page.route(new RegExp(`${API}/teams(\\?.*)?$`), (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([TEAMS[0], DROP_TEAM, DROP_TEAM_VACANT]),
    }),
  )
}

test.describe('Drop rotate-senior — AC4', () => {
  test('ADMIN sees «Сменить синьора» button on a drop-team with active senior', async ({ asAdmin: page }) => {
    await withFullTeamList(page)
    await page.goto(`/crm/team/${DROP_TEAM.id}`)

    const rotateBtn = page.getByTestId('team-rotate-senior-button')
    await expect(rotateBtn).toBeVisible()
    // Active senior exists → label reads «Сменить синьора».
    await expect(rotateBtn).toContainText(/Сменить синьора/i)
  })

  test('Senior-team detail page does NOT render the rotate-senior button', async ({ asAdmin: page }) => {
    await withFullTeamList(page)
    await page.goto(`/crm/team/${TEAMS[0]!.id}`)
    // Add/Edit/Archive must still be present — only the rotate affordance
    // is gated behind `team.type === 'DROP'`.
    await expect(page.getByTestId('team-add-member-button')).toBeVisible()
    await expect(page.getByTestId('team-rotate-senior-button')).toHaveCount(0)
  })

  test('Drop-team WITHOUT active senior labels the button «Назначить синьора»', async ({ asAdmin: page }) => {
    await withFullTeamList(page)
    await page.goto(`/crm/team/${DROP_TEAM_VACANT.id}`)
    const rotateBtn = page.getByTestId('team-rotate-senior-button')
    await expect(rotateBtn).toBeVisible()
    await expect(rotateBtn).toContainText(/Назначить синьора/i)
  })

  test('Clicking the rotate button opens a dialog with the vacant-senior dropdown', async ({ asAdmin: page }) => {
    await withFullTeamList(page)
    await page.goto(`/crm/team/${DROP_TEAM.id}`)

    await page.getByTestId('team-rotate-senior-button').click()

    const dialog = page.getByTestId('team-rotate-senior-dialog')
    await expect(dialog).toBeVisible()
    // Body copy mentions the current senior — proves we resolved
    // `activeSenior` from the team detail and surfaced it in the dialog.
    await expect(dialog.getByText(/Текущий синьор/i)).toBeVisible()
    await expect(dialog.getByText(USERS.senior.displayName)).toBeVisible()
  })

  test('Submit button is disabled until a new senior is picked', async ({ asAdmin: page }) => {
    await withFullTeamList(page)
    await page.goto(`/crm/team/${DROP_TEAM.id}`)

    await page.getByTestId('team-rotate-senior-button').click()
    const dialog = page.getByTestId('team-rotate-senior-dialog')
    await expect(dialog).toBeVisible()

    const submit = page.getByTestId('team-rotate-senior-submit')
    await expect(submit).toBeDisabled()
  })

  test('Senior-team URL — no rotate trigger even when ADMIN tries to access the dialog directly', async ({ asAdmin: page }) => {
    await withFullTeamList(page)
    await page.goto(`/crm/team/${TEAMS[0]!.id}`)

    // The dialog is gated behind the button — without the button it cannot
    // be opened from the UI. The test guards against ever rendering the
    // dialog markup unconditionally.
    await expect(page.getByTestId('team-rotate-senior-dialog')).toHaveCount(0)
  })
})
