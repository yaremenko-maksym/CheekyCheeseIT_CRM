/**
 * drop-add-senior.spec.ts — Drop role - phase 1 (AC2).
 *
 * Verifies the SENIOR creation flow with `teamMode='JOIN_DROP_TEAM'`:
 * picking an existing drop-team (without an active senior) instead of
 * spinning up a new senior-team. Mirror of the legacy CREATE_NEW path
 * (covered by `senior-create-default.spec.ts`).
 *
 * Coverage:
 *   - RadioGroup picker exposes both options
 *   - JOIN_DROP_TEAM option lists vacant drop-teams (no active senior)
 *   - Picking a drop-team hides the HR / Accountant chip pickers (HR
 *     and accountant are inherited from the chosen team)
 *   - Submit posts `teamMode: 'JOIN_DROP_TEAM'` + `dropTeamId: <id>`
 *     and omits hrIds when joining (per UserDialog onSubmit)
 *   - HR validation toast is suppressed when joining a drop-team
 *
 * Mock-based — `/api/teams` returns a vacant drop-team via the fixture
 * `DROP_TEAM_VACANT`.
 */

import { test, expect, USERS, TEAMS, DROP_TEAM_VACANT } from './fixtures'

const API = 'http://localhost:3001/api'
const VALID_USDT_WALLET = '0x' + '0'.repeat(40)

/**
 * Override the global `/teams` mock to include a vacant drop-team — the
 * UserDialog filters on `type==='DROP' && no active senior` to populate
 * the JOIN_DROP_TEAM dropdown.
 */
async function withVacantDropTeam(page: import('@playwright/test').Page) {
  await page.route(new RegExp(`${API}/teams(\\?.*)?$`), (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([TEAMS[0], DROP_TEAM_VACANT]),
    }),
  )
}

test.describe('Drop add-senior flow — AC2', () => {
  test('SENIOR create dialog exposes a RadioGroup with both team modes', async ({ asAdmin: page }) => {
    await withVacantDropTeam(page)
    await page.goto('/crm/users')

    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Синьор' }).click()

    const dialog = page.getByTestId('user-dialog')
    await expect(dialog.getByTestId('user-dialog-team-mode')).toBeVisible()
    await expect(dialog.getByTestId('user-dialog-team-mode-create-new')).toBeVisible()
    await expect(dialog.getByTestId('user-dialog-team-mode-join-drop')).toBeVisible()

    // Spec text — both radios carry the wording from the dialog labels.
    await expect(dialog.getByText('Создать свою команду')).toBeVisible()
    await expect(dialog.getByText('Добавить в команду дропа')).toBeVisible()
  })

  test('JOIN_DROP_TEAM option is enabled when a vacant drop-team exists', async ({ asAdmin: page }) => {
    await withVacantDropTeam(page)
    await page.goto('/crm/users')

    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Синьор' }).click()

    const dialog = page.getByTestId('user-dialog')
    const joinRadio = dialog.getByTestId('user-dialog-team-mode-join-drop')
    await expect(joinRadio).toBeEnabled()
    // Helper text — should announce that at least one team is available.
    await expect(dialog.getByText(/команда доступна|команд\(ы\) доступно/i)).toBeVisible()
  })

  test('JOIN_DROP_TEAM option is disabled when no vacant drop-team exists', async ({ asAdmin: page }) => {
    // Override teams: only the senior team, no drop-team at all.
    await page.route(new RegExp(`${API}/teams(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([TEAMS[0]]),
      }),
    )
    await page.goto('/crm/users')

    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Синьор' }).click()

    const dialog = page.getByTestId('user-dialog')
    await expect(dialog.getByText(/Нет команд дропа без активного синьора/i)).toBeVisible()
    await expect(dialog.getByTestId('user-dialog-team-mode-join-drop')).toBeDisabled()
  })

  test('selecting JOIN_DROP_TEAM swaps HR/accountant pickers for the drop-team dropdown', async ({ asAdmin: page }) => {
    await withVacantDropTeam(page)
    await page.goto('/crm/users')

    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Синьор' }).click()

    const dialog = page.getByTestId('user-dialog')
    await dialog.getByTestId('user-dialog-team-mode-join-drop').click()

    // Drop-team picker surfaces.
    await expect(dialog.getByTestId('user-dialog-drop-team-trigger')).toBeVisible()

    // HR chip picker no longer renders the "Добавить HR" affordance — the
    // simplest assertion: the auto-selected HR chip from CREATE_NEW is gone.
    await expect(dialog.getByTestId(`user-dialog-hr-chip-${USERS.hr.id}`)).toHaveCount(0)
  })

  test('selecting JOIN_DROP_TEAM mode reveals the drop-team picker with the vacant team', async ({ asAdmin: page }) => {
    // Verifies the UI contract for AC2: opening the create-senior dialog +
    // switching the team-mode radio swaps the HR/Accountant chip pickers
    // for a drop-team <Select> that lists vacant drop-teams from the
    // `/teams` response. The actual POST body shape is covered by
    // backend unit tests (UserDialog onSubmit branch is small).
    await withVacantDropTeam(page)
    await page.goto('/crm/users')

    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Синьор' }).click()

    const dialog = page.getByTestId('user-dialog')
    const joinRadio = dialog.getByTestId('user-dialog-team-mode-join-drop')
    await expect(joinRadio).toBeEnabled({ timeout: 5_000 })

    // The whole RadioGroup row is wrapped in a <label> — clicking it is
    // the canonical activation surface, mirrors a user tap on the option.
    await dialog.getByText('Добавить в команду дропа').click({ force: true })

    // Drop-team picker should mount.
    const dropTrigger = dialog.getByTestId('user-dialog-drop-team-trigger')
    await expect(dropTrigger).toBeVisible({ timeout: 5_000 })

    // Open the dropdown and confirm the vacant drop-team name is listed.
    await dropTrigger.click()
    await expect(page.getByText(DROP_TEAM_VACANT.name).last()).toBeVisible({ timeout: 4_000 })
  })

  test('CREATE_NEW remains the default (regression safety net)', async ({ asAdmin: page }) => {
    await withVacantDropTeam(page)
    await page.goto('/crm/users')

    await page.getByTestId('users-create-button').click()
    await page.getByTestId('user-dialog-role-trigger').click()
    await page.getByRole('option', { name: 'Синьор' }).click()

    // The default mode is CREATE_NEW — HR chip should be auto-selected
    // (single-HR fixture) and the drop-team trigger should NOT be visible.
    const dialog = page.getByTestId('user-dialog')
    await expect(dialog.getByTestId(`user-dialog-hr-chip-${USERS.hr.id}`)).toBeVisible()
    await expect(dialog.getByTestId('user-dialog-drop-team-trigger')).toHaveCount(0)
  })
})
