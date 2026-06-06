/**
 * team-archive.spec.ts
 *
 * E2E coverage for the team archive views and pair-unarchive flow added in PR 3.
 *
 * Routes under test:
 * - GET /crm/team?archived=true
 * - GET /crm/team/:teamId (detail page with admin actions + audit log tab)
 *
 * Mocks are layered on top of the global fixture routes; specific routes are
 * registered first to override the generic ones from `mockAuthAs`.
 */

import { test, expect, USERS, TEAMS } from '../../fixtures'

const API = 'http://localhost:3001/api'

// TEAMS[0] is the seed Alpha Team — non-null in fixtures.
const activeTeam = TEAMS[0]!

const archivedTeam = {
  ...activeTeam,
  id: 'team-archived-1',
  name: 'Archived Team',
  archivedAt: '2026-05-19T00:00:00.000Z',
}

test.describe('Team archive — list page tab', () => {
  test('ADMIN sees «Архив» tab and clicking switches to archived list', async ({ asAdmin: page }) => {
    // Active teams response — default
    await page.route(`${API}/teams`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([activeTeam]),
      }),
    )
    // Archived teams response
    await page.route(`${API}/teams?archived=true`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([archivedTeam]),
      }),
    )

    await page.goto('/crm/team')

    // ut-25: «Показать архивных» button replaced with «Архив» tab.
    const archiveTab = page.getByTestId('toggle-archived-teams')
    await expect(archiveTab).toBeVisible()
    await expect(archiveTab).toHaveText(/Архив/)
    await expect(page.getByText('Alpha Team')).toBeVisible()
    await expect(page.getByText('Archived Team')).not.toBeVisible()
  })

  test('non-ADMIN does not see the «Архив» tab', async ({ asHr: page }) => {
    await page.goto('/crm/team')
    await expect(page.getByText('Alpha Team')).toBeVisible()
    await expect(page.getByTestId('toggle-archived-teams')).not.toBeVisible()
  })

  test('archived team card has opacity-60 and no inline action buttons (ADMIN)', async ({ asAdmin: page }) => {
    await page.route(new RegExp(`${API}/teams(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([archivedTeam]),
      }),
    )

    await page.goto('/crm/team?archived=true')

    const card = page.getByTestId(`team-card-${archivedTeam.id}`)
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-archived', 'true')

    // "В архиве" badge present
    await expect(card.getByText('В архиве')).toBeVisible()

    // ut-39a: inline restore + edit buttons removed from list cards. Card is
    // purely navigational — unarchive now lives on the detail page header.
    await expect(page.getByTestId(`team-unarchive-${archivedTeam.id}`)).toHaveCount(0)
  })

  test('detail-page restore button calls POST /teams/:id/unarchive', async ({ asAdmin: page }) => {
    // ut-39b: the unarchive action moved from the list to the detail header.
    await page.route(`${API}/teams/${archivedTeam.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(archivedTeam) }),
    )
    const unarchived = page.waitForRequest(
      (req) => req.url().endsWith(`/teams/${archivedTeam.id}/unarchive`) && req.method() === 'POST',
      { timeout: 5000 },
    )
    await page.route(`${API}/teams/${archivedTeam.id}/unarchive`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    )

    await page.goto(`/crm/team/${archivedTeam.id}`)
    await page.getByTestId('team-unarchive-button').click()
    await unarchived
    // Toast confirms pair-unarchive happened
    await expect(page.getByText(/Команда и синьор восстановлены/)).toBeVisible({ timeout: 3000 })
  })
})

test.describe('Team detail page — admin actions', () => {
  // ut-39b: «Действия» dropdown replaced with explicit «Архивировать» /
  // «Восстановить» buttons. Add / Edit remain as primary actions.
  test('ADMIN sees explicit Archive button on active team detail', async ({ asAdmin: page }) => {
    await page.route(`${API}/teams/${activeTeam.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activeTeam) }),
    )
    await page.goto(`/crm/team/${activeTeam.id}`)
    await expect(page.getByRole('heading', { name: activeTeam.name })).toBeVisible()
    await expect(page.getByTestId('team-archive-button')).toBeVisible()
  })

  test('non-ADMIN does not see Archive button on team detail', async ({ asHr: page }) => {
    await page.route(`${API}/teams/${activeTeam.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activeTeam) }),
    )
    await page.goto(`/crm/team/${activeTeam.id}`)
    await expect(page.getByRole('heading', { name: activeTeam.name })).toBeVisible()
    await expect(page.getByTestId('team-archive-button')).not.toBeVisible()
  })

  test('ADMIN sees Состав tab on team detail', async ({ asAdmin: page }) => {
    await page.route(`${API}/teams/${activeTeam.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activeTeam) }),
    )
    await page.goto(`/crm/team/${activeTeam.id}`)
    await expect(page.getByTestId('tab-members')).toBeVisible()
  })

  test('opening "Архивировать" shows ArchiveConfirmDialog with senior-name input', async ({ asAdmin: page }) => {
    await page.route(`${API}/teams/${activeTeam.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activeTeam) }),
    )
    await page.route(`${API}/teams/${activeTeam.id}/archive-impact`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'team',
          isPaired: true,
          teamName: activeTeam.name,
          seniorName: USERS.senior.displayName,
          projectsCount: 1,
          membersAffected: 2,
        }),
      }),
    )
    await page.goto(`/crm/team/${activeTeam.id}`)
    // ut-39b: explicit Archive button replaces the «Действия» dropdown.
    await page.getByTestId('team-archive-button').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: /Архивировать команду/ })).toBeVisible()
    await expect(dialog.getByText(/имя синьора/)).toBeVisible({ timeout: 3000 })
    // Submit disabled until name typed
    const submit = page.getByTestId('archive-confirm-submit')
    await expect(submit).toBeDisabled()
  })

  test('typing senior name enables submit and DELETE /teams/:id is called', async ({ asAdmin: page }) => {
    await page.route(`${API}/teams/${activeTeam.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activeTeam) }),
    )
    await page.route(`${API}/teams/${activeTeam.id}/archive-impact`, (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          type: 'team',
          isPaired: true,
          teamName: activeTeam.name,
          seniorName: USERS.senior.displayName,
          projectsCount: 0,
          membersAffected: 0,
        }),
      }),
    )
    const archived = page.waitForRequest(
      (req) => req.url().endsWith(`/teams/${activeTeam.id}`) && req.method() === 'DELETE',
      { timeout: 5000 },
    )

    await page.goto(`/crm/team/${activeTeam.id}`)
    // ut-39b: explicit Archive button.
    await page.getByTestId('team-archive-button').click()

    await page.getByTestId('archive-confirm-input').fill(USERS.senior.displayName)
    const submit = page.getByTestId('archive-confirm-submit')
    await expect(submit).toBeEnabled()
    await submit.click()
    await archived
  })

  test('archived team shows "В архиве" badge and Unarchive button only', async ({ asAdmin: page }) => {
    await page.route(`${API}/teams/${archivedTeam.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(archivedTeam) }),
    )

    await page.goto(`/crm/team/${archivedTeam.id}`)
    await expect(page.getByTestId('team-archived-badge')).toBeVisible()

    // ut-39b: explicit Unarchive button replaces the dropdown action.
    await expect(page.getByTestId('team-unarchive-button')).toBeVisible()
    await expect(page.getByTestId('team-archive-button')).not.toBeVisible()
  })
})
