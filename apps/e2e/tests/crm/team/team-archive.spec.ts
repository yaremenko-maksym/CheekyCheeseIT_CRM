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

test.describe('Team archive — list page toggle', () => {
  test('ADMIN sees toggle "Показать архивных" and clicking switches to archived list', async ({ asAdmin: page }) => {
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

    // Active state — toggle visible, archived team not visible
    const toggle = page.getByTestId('toggle-archived-teams')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveText(/Показать архивных/)
    await expect(page.getByText('Alpha Team')).toBeVisible()
    await expect(page.getByText('Archived Team')).not.toBeVisible()
  })

  test('non-ADMIN does not see the archive toggle', async ({ asHr: page }) => {
    await page.goto('/crm/team')
    await expect(page.getByText('Alpha Team')).toBeVisible()
    await expect(page.getByTestId('toggle-archived-teams')).not.toBeVisible()
  })

  test('archived team card has opacity-60 and "Восстановить" inline button (ADMIN)', async ({ asAdmin: page }) => {
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

    // Inline restore button
    const restoreBtn = page.getByTestId(`team-unarchive-${archivedTeam.id}`)
    await expect(restoreBtn).toBeVisible()
  })

  test('inline restore button calls POST /teams/:id/unarchive', async ({ asAdmin: page }) => {
    await page.route(new RegExp(`${API}/teams(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([archivedTeam]),
      }),
    )
    const unarchived = page.waitForRequest(
      (req) => req.url().endsWith(`/teams/${archivedTeam.id}/unarchive`) && req.method() === 'POST',
      { timeout: 5000 },
    )
    await page.route(`${API}/teams/${archivedTeam.id}/unarchive`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    )

    await page.goto('/crm/team?archived=true')
    await page.getByTestId(`team-unarchive-${archivedTeam.id}`).click()
    await unarchived
    // Toast confirms pair-unarchive happened
    await expect(page.getByText(/Команда и синьор восстановлены/)).toBeVisible({ timeout: 3000 })
  })
})

test.describe('Team detail page — admin actions + audit log', () => {
  test('ADMIN sees AdminActionsMenu trigger on team detail', async ({ asAdmin: page }) => {
    await page.route(`${API}/teams/${activeTeam.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activeTeam) }),
    )
    await page.goto(`/crm/team/${activeTeam.id}`)
    await expect(page.getByRole('heading', { name: activeTeam.name })).toBeVisible()
    await expect(page.getByTestId('admin-actions-trigger')).toBeVisible()
  })

  test('non-ADMIN does not see AdminActionsMenu on team detail', async ({ asHr: page }) => {
    await page.route(`${API}/teams/${activeTeam.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activeTeam) }),
    )
    await page.goto(`/crm/team/${activeTeam.id}`)
    await expect(page.getByRole('heading', { name: activeTeam.name })).toBeVisible()
    await expect(page.getByTestId('admin-actions-trigger')).not.toBeVisible()
  })

  test('ADMIN sees both tabs (Состав + История изменений)', async ({ asAdmin: page }) => {
    await page.route(`${API}/teams/${activeTeam.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activeTeam) }),
    )
    await page.goto(`/crm/team/${activeTeam.id}`)
    await expect(page.getByTestId('tab-members')).toBeVisible()
    await expect(page.getByTestId('tab-audit')).toBeVisible()
  })

  test('clicking "История изменений" loads audit-log entries', async ({ asAdmin: page }) => {
    await page.route(`${API}/teams/${activeTeam.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(activeTeam) }),
    )
    await page.route(new RegExp(`${API}/teams/${activeTeam.id}/audit-log`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entries: [
            {
              id: 'audit-1',
              actorId: USERS.admin.id,
              targetId: activeTeam.id,
              action: 'team_renamed',
              changes: { name: { before: 'Old Name', after: 'Alpha Team' } },
              createdAt: '2026-05-01T10:00:00.000Z',
            },
          ],
          total: 1,
          page: 1,
          limit: 20,
        }),
      }),
    )

    await page.goto(`/crm/team/${activeTeam.id}`)
    await page.getByTestId('tab-audit').click()
    await expect(page.getByText('Команда переименована')).toBeVisible({ timeout: 3000 })
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
    await page.getByTestId('admin-actions-trigger').click()
    await page.getByTestId('admin-action-archive').click()

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
    await page.getByTestId('admin-actions-trigger').click()
    await page.getByTestId('admin-action-archive').click()

    await page.getByTestId('archive-confirm-input').fill(USERS.senior.displayName)
    const submit = page.getByTestId('archive-confirm-submit')
    await expect(submit).toBeEnabled()
    await submit.click()
    await archived
  })

  test('archived team shows "В архиве" badge and unarchive action only', async ({ asAdmin: page }) => {
    await page.route(`${API}/teams/${archivedTeam.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(archivedTeam) }),
    )

    await page.goto(`/crm/team/${archivedTeam.id}`)
    await expect(page.getByTestId('team-archived-badge')).toBeVisible()

    await page.getByTestId('admin-actions-trigger').click()
    await expect(page.getByTestId('admin-action-unarchive')).toBeVisible()
    await expect(page.getByTestId('admin-action-archive')).not.toBeVisible()
  })
})
