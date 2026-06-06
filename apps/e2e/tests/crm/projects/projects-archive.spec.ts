/**
 * projects-archive.spec.ts
 *
 * E2E coverage for the project archive views, cascade-unarchive flow,
 * and the effective-team computed view introduced in PR 3.
 *
 * Routes under test:
 * - GET /crm/projects?archived=true
 * - GET /crm/projects/:projectId (detail with admin actions + tabs)
 *
 * The effective team dynamism test verifies that HR/Accountant come from the
 * senior's CURRENT team_members snapshot — not frozen at archive time.
 */

import { test, expect, USERS, PROJECTS } from '../../fixtures'

const API = 'http://localhost:3001/api'

const activeProject = PROJECTS[0]!

const archivedProject = {
  ...activeProject,
  id: 'project-archived-1',
  name: 'Archived Project',
  archivedAt: '2026-05-19T00:00:00.000Z',
}

const projectWithEffectiveTeam = {
  ...activeProject,
  effectiveTeam: {
    senior: {
      id: USERS.senior.id,
      displayName: USERS.senior.displayName,
      email: USERS.senior.email,
      avatar: null,
      role: 'SENIOR',
    },
    hrs: [
      {
        id: 'tm-hr-1',
        userId: USERS.hr.id,
        displayName: USERS.hr.displayName,
        email: USERS.hr.email,
        avatar: null,
        role: 'HR',
      },
    ],
    accountants: [
      {
        id: 'tm-acc-1',
        userId: USERS.accountant.id,
        displayName: USERS.accountant.displayName,
        email: USERS.accountant.email,
        avatar: null,
        role: 'ACCOUNTANT',
      },
    ],
    juniors: [],
  },
}

test.describe('Projects archive — list page tab', () => {
  // ut-25: «Показать архивных» button replaced with «Архив» tab in tabs row.
  test('ADMIN sees «Архив» tab on projects list', async ({ asAdmin: page }) => {
    await page.goto('/crm/projects')
    await expect(page.getByTestId('toggle-archived-projects')).toBeVisible()
  })

  test('non-ADMIN does not see «Архив» tab on projects list', async ({ asHr: page }) => {
    await page.goto('/crm/projects')
    await expect(page.getByTestId('toggle-archived-projects')).not.toBeVisible()
  })

  test('archived project card has data-archived=true and no inline restore button (ut-38)', async ({ asAdmin: page }) => {
    await page.route(new RegExp(`${API}/projects(\\?.*)?$`), (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([archivedProject]),
      }),
    )

    await page.goto('/crm/projects?archived=true')
    const card = page.getByTestId(`project-card-${archivedProject.id}`)
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-archived', 'true')
    await expect(card.getByText('В архиве')).toBeVisible()
    // ut-38: inline unarchive button removed from list cards — unarchive now
    // lives on the project detail page header.
    await expect(page.getByTestId(`project-unarchive-${archivedProject.id}`)).toHaveCount(0)
  })

  test('unarchive without cascade — POST succeeds, no modal shown', async ({ asAdmin: page }) => {
    // ut-38: unarchive moved to the detail page header — drive the test
    // through `project-unarchive-button` instead of the (removed) inline list
    // button.
    const archived = {
      ...projectWithEffectiveTeam,
      ...archivedProject,
      effectiveTeam: projectWithEffectiveTeam.effectiveTeam,
    }
    await page.route(`${API}/projects/${archivedProject.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(archived) }),
    )
    const unarchived = page.waitForRequest(
      (req) => req.url().endsWith(`/projects/${archivedProject.id}/unarchive`) && req.method() === 'POST',
      { timeout: 5000 },
    )
    await page.route(`${API}/projects/${archivedProject.id}/unarchive`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    )

    await page.goto(`/crm/projects/${archivedProject.id}`)
    await page.getByTestId('project-unarchive-button').click()
    await unarchived
    // No cascade modal shown
    await expect(page.getByTestId('cascade-unarchive-confirm')).not.toBeVisible()
  })

  test('unarchive with 409 cascade — shows modal with paired entities', async ({ asAdmin: page }) => {
    // ut-38: same redirect — exercise the detail-page Unarchive button.
    const archived = {
      ...projectWithEffectiveTeam,
      ...archivedProject,
      effectiveTeam: projectWithEffectiveTeam.effectiveTeam,
    }
    await page.route(`${API}/projects/${archivedProject.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(archived) }),
    )
    // First call returns 409 with cascade required
    let called = 0
    await page.route(`${API}/projects/${archivedProject.id}/unarchive`, (r) => {
      called++
      r.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          requiresCascade: true,
          entities: [
            { type: 'user', id: USERS.senior.id, name: USERS.senior.displayName },
            { type: 'team', id: 'team-1-id', name: 'Alpha Team' },
          ],
        }),
      })
    })
    // Cascade=true call
    await page.route(`${API}/projects/${archivedProject.id}/unarchive?cascade=true`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    )

    await page.goto(`/crm/projects/${archivedProject.id}`)
    await page.getByTestId('project-unarchive-button').click()

    const cascadeBtn = page.getByTestId('cascade-unarchive-confirm')
    await expect(cascadeBtn).toBeVisible({ timeout: 3000 })

    // Both paired entities listed in modal
    await expect(page.getByTestId('cascade-entity-user')).toBeVisible()
    await expect(page.getByTestId('cascade-entity-team')).toBeVisible()

    expect(called).toBeGreaterThanOrEqual(1)
  })
})

test.describe('Project detail page — header actions + tabs', () => {
  // ut-28: project detail page header now uses explicit Edit + Archive buttons
  // (replaces former «Действия» dropdown / AdminActionsMenu).
  test('ADMIN sees explicit Archive button on project detail', async ({ asAdmin: page }) => {
    await page.route(`${API}/projects/${activeProject.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(projectWithEffectiveTeam) }),
    )
    await page.goto(`/crm/projects/${activeProject.id}`)
    await expect(page.getByTestId('project-archive-button')).toBeVisible()
  })

  test('non-ADMIN does not see Archive button on project detail', async ({ asHr: page }) => {
    await page.route(`${API}/projects/${activeProject.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(projectWithEffectiveTeam) }),
    )
    await page.goto(`/crm/projects/${activeProject.id}`)
    await expect(page.getByTestId('project-archive-button')).not.toBeVisible()
  })

  test('project detail shows tabs (Обзор, Состав, Финансы) for ADMIN', async ({ asAdmin: page }) => {
    await page.route(`${API}/projects/${activeProject.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(projectWithEffectiveTeam) }),
    )
    await page.goto(`/crm/projects/${activeProject.id}`)
    await expect(page.getByTestId('tab-overview')).toBeVisible()
    await expect(page.getByTestId('tab-members')).toBeVisible()
    await expect(page.getByTestId('tab-finance')).toBeVisible()
  })

  test('Состав tab renders effective team from project.effectiveTeam', async ({ asAdmin: page }) => {
    await page.route(`${API}/projects/${activeProject.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(projectWithEffectiveTeam) }),
    )

    await page.goto(`/crm/projects/${activeProject.id}`)
    await page.getByTestId('tab-members').click()

    const card = page.getByTestId('effective-team-card')
    await expect(card).toBeVisible()
    // Senior + HR + Accountant from effectiveTeam
    await expect(card.getByText(USERS.senior.displayName)).toBeVisible()
    await expect(card.getByText(USERS.hr.displayName)).toBeVisible()
    await expect(card.getByText(USERS.accountant.displayName)).toBeVisible()
  })

  test('effective team dynamism — HR shown matches current team_members (not snapshot)', async ({ asAdmin: page }) => {
    // Simulate scenario: project was archived with HR0, while archived HR changed to HR1.
    // After unarchive, effective team should show HR1 (current), not HR0 (snapshot).
    const newHrName = 'Brand New HR'
    const dynamicProject = {
      ...activeProject,
      archivedAt: null,
      effectiveTeam: {
        senior: {
          id: USERS.senior.id,
          displayName: USERS.senior.displayName,
          email: USERS.senior.email,
          avatar: null,
          role: 'SENIOR',
        },
        hrs: [
          {
            id: 'tm-hr-new',
            userId: 'a0000000-0000-4000-8000-000000000099',
            displayName: newHrName,
            email: 'newhr@cheekycheese.dev',
            avatar: null,
            role: 'HR',
          },
        ],
        accountants: [],
        juniors: [],
      },
    }
    await page.route(`${API}/projects/${activeProject.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dynamicProject) }),
    )

    await page.goto(`/crm/projects/${activeProject.id}`)
    await page.getByTestId('tab-members').click()

    const card = page.getByTestId('effective-team-card')
    await expect(card.getByText(newHrName)).toBeVisible()
    // Old HR (Alpha Team's HR Manager) should NOT appear since it was replaced.
    await expect(card.getByText(USERS.hr.displayName)).not.toBeVisible()
  })

  test('archived project shows "В архиве" badge and unarchive button only', async ({ asAdmin: page }) => {
    const archived = { ...projectWithEffectiveTeam, ...archivedProject, effectiveTeam: projectWithEffectiveTeam.effectiveTeam }
    await page.route(`${API}/projects/${archivedProject.id}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(archived) }),
    )

    await page.goto(`/crm/projects/${archivedProject.id}`)
    await expect(page.getByTestId('project-archived-badge')).toBeVisible()
    // ut-28: explicit Unarchive button replaces the dropdown's unarchive action.
    await expect(page.getByTestId('project-unarchive-button')).toBeVisible()
    await expect(page.getByTestId('project-archive-button')).not.toBeVisible()
  })
})
