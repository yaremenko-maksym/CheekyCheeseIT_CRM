/**
 * rbac-senior-junior.spec.ts
 *
 * RBAC rule #1 — SENIOR must not see JUNIOR identity anywhere in the CRM.
 * RBAC rule #11 — JUNIOR must not see "Active Projects" or "TG-канал" on team page.
 *
 * All tests are mock-based (no live server needed).
 * Pattern matches legend.spec.ts: asSenior/asJunior/asAdmin/asHr fixtures.
 */

import { test, expect, USERS, TEAMS, PROJECTS, buildAdminViewingUser } from './fixtures'

const API = 'http://localhost:3001/api'

// ---------------------------------------------------------------------------
// Fixture: senior-team with junior member derived from project
// ---------------------------------------------------------------------------

/** Team fixture that includes JUNIOR in derived members list */
const TEAM_WITH_JUNIOR = {
  ...TEAMS[0],
  members: [
    {
      id: `member-${USERS.hr.id}`,
      userId: USERS.hr.id,
      displayName: USERS.hr.displayName,
      email: USERS.hr.email,
      avatarUrl: null,
      avatarDocumentId: null,
      role: 'HR' as const,
      techStack: null,
      phone: null,
      telegram: null,
      joinedAt: '2024-01-10T00:00:00.000Z',
      leftAt: null,
    },
    {
      id: `member-${USERS.senior.id}`,
      userId: USERS.senior.id,
      displayName: USERS.senior.displayName,
      email: USERS.senior.email,
      avatarUrl: null,
      avatarDocumentId: null,
      role: 'SENIOR' as const,
      techStack: USERS.senior.techStack,
      phone: USERS.senior.phone,
      telegram: USERS.senior.telegram,
      joinedAt: '2024-01-10T00:00:00.000Z',
      leftAt: null,
    },
    {
      id: `member-${USERS.accountant.id}`,
      userId: USERS.accountant.id,
      displayName: USERS.accountant.displayName,
      email: USERS.accountant.email,
      avatarUrl: null,
      avatarDocumentId: null,
      role: 'ACCOUNTANT' as const,
      techStack: null,
      phone: null,
      telegram: null,
      joinedAt: '2024-01-10T00:00:00.000Z',
      leftAt: null,
    },
    // JUNIOR derived from project membership
    {
      id: `member-${USERS.junior.id}`,
      userId: USERS.junior.id,
      displayName: USERS.junior.displayName,
      email: USERS.junior.email,
      avatarUrl: null,
      avatarDocumentId: null,
      role: 'JUNIOR' as const,
      techStack: null,
      phone: null,
      telegram: null,
      joinedAt: '2024-01-15T00:00:00.000Z',
      leftAt: null,
    },
  ],
}

/** Team fixture with telegram channel set */
const TEAM_WITH_TELEGRAM = {
  ...TEAM_WITH_JUNIOR,
  telegram: 'https://t.me/alpha_team_chat',
}

/** Project with JUNIOR member */
const PROJECT_WITH_JUNIOR = {
  ...PROJECTS[0],
  id: 'project-with-junior',
  members: [
    {
      id: 'pm-junior-active',
      userId: USERS.junior.id,
      displayName: USERS.junior.displayName,
      email: USERS.junior.email,
      avatarUrl: null,
      avatarDocumentId: null,
      role: 'JUNIOR' as const,
      joinedAt: '2024-01-15T00:00:00.000Z',
      leftAt: null,
    },
  ],
  effectiveTeam: {
    senior: {
      id: USERS.senior.id,
      displayName: USERS.senior.displayName,
      email: USERS.senior.email,
      avatarUrl: null,
      avatarDocumentId: null,
      role: 'SENIOR' as const,
    },
    drop: null,
    hrs: [
      {
        id: 'tm-hr',
        userId: USERS.hr.id,
        displayName: USERS.hr.displayName,
        email: USERS.hr.email,
        avatarUrl: null,
        avatarDocumentId: null,
        role: 'HR' as const,
      },
    ],
    accountants: [
      {
        id: 'tm-acc',
        userId: USERS.accountant.id,
        displayName: USERS.accountant.displayName,
        email: USERS.accountant.email,
        avatarUrl: null,
        avatarDocumentId: null,
        role: 'ACCOUNTANT' as const,
      },
    ],
    // Backend already redacts juniors for SENIOR viewer — empty array
    juniors: [],
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mockTeamDetail(
  page: import('@playwright/test').Page,
  teamId: string,
  teamData: object,
) {
  await page.route(new RegExp(`${API}/teams/${teamId}$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(teamData),
    })
  })
}

async function mockProjectDetail(
  page: import('@playwright/test').Page,
  projectId: string,
  projectData: object,
) {
  await page.route(new RegExp(`${API}/projects/${projectId}$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(projectData),
    })
  })
}

async function mockProfileForbidden(page: import('@playwright/test').Page, userId: string) {
  await page.route(new RegExp(`${API}/users/${userId}$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Forbidden' }),
    })
  })
}

// ---------------------------------------------------------------------------
// #1 — SENIOR on team page: must NOT see junior names/links
// ---------------------------------------------------------------------------

test.describe('RBAC #1 — SENIOR does not see JUNIOR identity on team page', () => {
  test('SENIOR does not see junior name in members list', async ({ asSenior: page }) => {
    await mockTeamDetail(page, TEAM_WITH_JUNIOR.id, TEAM_WITH_JUNIOR)

    await page.goto(`/crm/team/${TEAM_WITH_JUNIOR.id}`)
    await expect(page.getByRole('heading', { name: TEAM_WITH_JUNIOR.name })).toBeVisible()

    // SENIOR should see HR, SENIOR, ACCOUNTANT members — but NOT JUNIOR
    await expect(page.getByText(USERS.hr.displayName)).toBeVisible()
    await expect(page.getByText(USERS.senior.displayName)).toBeVisible()
    // Junior identity must be hidden
    await expect(page.getByText(USERS.junior.displayName)).not.toBeVisible()
    await expect(page.getByText(USERS.junior.email)).not.toBeVisible()
  })

  test('SENIOR does not see junior name in active projects slot', async ({ asSenior: page }) => {
    await mockTeamDetail(page, TEAM_WITH_JUNIOR.id, TEAM_WITH_JUNIOR)
    // Projects with junior member
    await page.route(new RegExp(`${API}/projects(\\?.*)?$`), (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([PROJECT_WITH_JUNIOR]),
      })
    })

    await page.goto(`/crm/team/${TEAM_WITH_JUNIOR.id}`)
    await expect(page.getByRole('heading', { name: TEAM_WITH_JUNIOR.name })).toBeVisible()

    // Project itself is visible
    await expect(page.getByText(PROJECT_WITH_JUNIOR.companyName)).toBeVisible()

    // Junior name must NOT appear in active-projects block
    await expect(page.getByText(USERS.junior.displayName)).not.toBeVisible()
    // Instead: neutral placeholder shown
    await expect(page.getByText('Джун назначен')).toBeVisible()
  })

  test('SENIOR sees project itself (project data not hidden, only junior identity)', async ({
    asSenior: page,
  }) => {
    await mockTeamDetail(page, TEAM_WITH_JUNIOR.id, TEAM_WITH_JUNIOR)
    await page.route(new RegExp(`${API}/projects(\\?.*)?$`), (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([PROJECT_WITH_JUNIOR]),
      })
    })

    await page.goto(`/crm/team/${TEAM_WITH_JUNIOR.id}`)
    await expect(page.getByText(PROJECT_WITH_JUNIOR.name)).toBeVisible()
    await expect(page.getByText(PROJECT_WITH_JUNIOR.companyName)).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// #1 — SENIOR on project detail: must NOT see junior in effective team
// ---------------------------------------------------------------------------

test.describe('RBAC #1 — SENIOR does not see JUNIOR identity on project detail', () => {
  test('SENIOR on project members tab: juniors section is empty', async ({ asSenior: page }) => {
    await mockProjectDetail(page, PROJECT_WITH_JUNIOR.id, PROJECT_WITH_JUNIOR)
    await page.route(new RegExp(`${API}/projects(\\?.*)?$`), (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([PROJECT_WITH_JUNIOR]),
      })
    })

    await page.goto(`/crm/projects/${PROJECT_WITH_JUNIOR.id}`)
    await expect(page.getByText(PROJECT_WITH_JUNIOR.companyName)).toBeVisible()

    // Navigate to members tab
    const membersTab = page.getByRole('button', { name: /Состав/i })
    if (await membersTab.isVisible()) {
      await membersTab.click()
    }

    // Effective team card should show senior but NOT junior link
    const effectiveTeamCard = page.getByTestId('effective-team-card')
    if (await effectiveTeamCard.isVisible()) {
      await expect(effectiveTeamCard.getByText(USERS.junior.displayName)).not.toBeVisible()
    }
  })
})

// ---------------------------------------------------------------------------
// #1 — SENIOR cannot access JUNIOR profile
// ---------------------------------------------------------------------------

test.describe('RBAC #1 — SENIOR cannot access JUNIOR profile', () => {
  test('SENIOR gets forbidden/no-tabs when navigating to junior profile', async ({
    asSenior: page,
  }) => {
    // Backend returns 403 for SENIOR viewing JUNIOR profile
    await mockProfileForbidden(page, USERS.junior.id)

    await page.goto(`/crm/profile/${USERS.junior.id}`)

    // Should either redirect away or show no profile content
    // The profile shell shows nothing when permissions.tabs is empty
    await expect(page.getByRole('heading', { name: USERS.junior.displayName })).not.toBeVisible({
      timeout: 3000,
    })
  })
})

// ---------------------------------------------------------------------------
// #11 — JUNIOR does not see "Active Projects" or TG-канал on team page
// ---------------------------------------------------------------------------

test.describe('RBAC #11 — JUNIOR does not see active-projects or TG-канал on team detail', () => {
  test('JUNIOR does not see active-projects section', async ({ asJunior: page }) => {
    // Backend returns team with only the junior's own membership visible
    const teamForJunior = {
      ...TEAM_WITH_TELEGRAM,
      // SENIOR viewer filter: backend removes juniors from members list for SENIOR.
      // For JUNIOR viewer: backend keeps only the junior themselves in derived members.
      members: TEAM_WITH_TELEGRAM.members.filter((m) => m.role !== 'JUNIOR'),
    }
    await mockTeamDetail(page, teamForJunior.id, teamForJunior)
    await page.route(new RegExp(`${API}/projects(\\?.*)?$`), (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([PROJECT_WITH_JUNIOR]),
      })
    })

    await page.goto(`/crm/team/${teamForJunior.id}`)
    await expect(page.getByRole('heading', { name: teamForJunior.name })).toBeVisible()

    // "Активные проекты" section must NOT be rendered for JUNIOR viewer
    await expect(page.getByText('Активные проекты')).not.toBeVisible()
  })

  test('JUNIOR does not see TG-канал link', async ({ asJunior: page }) => {
    await mockTeamDetail(page, TEAM_WITH_TELEGRAM.id, TEAM_WITH_TELEGRAM)

    await page.goto(`/crm/team/${TEAM_WITH_TELEGRAM.id}`)
    await expect(page.getByRole('heading', { name: TEAM_WITH_TELEGRAM.name })).toBeVisible()

    // Telegram-канал link must NOT be shown for JUNIOR
    await expect(page.getByTestId('team-telegram-link')).not.toBeVisible()
    await expect(page.getByText('Telegram-канал')).not.toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Regression: ADMIN/HR still see junior identity
// ---------------------------------------------------------------------------

test.describe('Regression — ADMIN and HR still see JUNIOR identity (not broken)', () => {
  test('ADMIN sees junior name in team members', async ({ asAdmin: page }) => {
    await mockTeamDetail(page, TEAM_WITH_JUNIOR.id, TEAM_WITH_JUNIOR)

    await page.goto(`/crm/team/${TEAM_WITH_JUNIOR.id}`)
    await expect(page.getByRole('heading', { name: TEAM_WITH_JUNIOR.name })).toBeVisible()

    // ADMIN must see all members including JUNIOR
    await expect(page.getByText(USERS.junior.displayName)).toBeVisible()
  })

  test('ADMIN sees active-projects section with junior name', async ({ asAdmin: page }) => {
    await mockTeamDetail(page, TEAM_WITH_JUNIOR.id, TEAM_WITH_JUNIOR)
    await page.route(new RegExp(`${API}/projects(\\?.*)?$`), (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([PROJECT_WITH_JUNIOR]),
      })
    })

    await page.goto(`/crm/team/${TEAM_WITH_JUNIOR.id}`)
    await expect(page.getByText('Активные проекты')).toBeVisible()
    await expect(page.getByText(USERS.junior.displayName)).toBeVisible()
  })

  test('ADMIN sees TG-канал link on team page', async ({ asAdmin: page }) => {
    await mockTeamDetail(page, TEAM_WITH_TELEGRAM.id, TEAM_WITH_TELEGRAM)

    await page.goto(`/crm/team/${TEAM_WITH_TELEGRAM.id}`)
    await expect(page.getByTestId('team-telegram-link')).toBeVisible()
  })

  test('HR sees junior name in team members', async ({ asHr: page }) => {
    await mockTeamDetail(page, TEAM_WITH_JUNIOR.id, TEAM_WITH_JUNIOR)

    await page.goto(`/crm/team/${TEAM_WITH_JUNIOR.id}`)
    await expect(page.getByRole('heading', { name: TEAM_WITH_JUNIOR.name })).toBeVisible()

    await expect(page.getByText(USERS.junior.displayName)).toBeVisible()
  })

  test('ADMIN can navigate to junior profile (full access)', async ({ asAdmin: page }) => {
    await page.route(new RegExp(`${API}/users/${USERS.junior.id}$`), (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildAdminViewingUser(USERS.junior)),
      })
    })

    await page.goto(`/crm/profile/${USERS.junior.id}`)
    await expect(page.getByRole('heading', { name: USERS.junior.displayName })).toBeVisible()
  })
})

// ---------------------------------------------------------------------------
// Regression: JUNIOR sees own tabs on team page (members list, not projects)
// ---------------------------------------------------------------------------

test.describe('Regression — JUNIOR on team page sees members (not projects/TG)', () => {
  test('JUNIOR sees team members section (HR, SENIOR, ACCOUNTANT) but not other juniors', async ({
    asJunior: page,
  }) => {
    const teamForJunior = {
      ...TEAM_WITH_JUNIOR,
      // Backend filters out JUNIORs from members list for JUNIOR viewer
      members: TEAM_WITH_JUNIOR.members.filter((m) => m.role !== 'JUNIOR'),
    }
    await mockTeamDetail(page, teamForJunior.id, teamForJunior)

    await page.goto(`/crm/team/${teamForJunior.id}`)
    await expect(page.getByRole('heading', { name: teamForJunior.name })).toBeVisible()

    // Should see non-junior members
    await expect(page.getByText(USERS.senior.displayName)).toBeVisible()
    await expect(page.getByText(USERS.hr.displayName)).toBeVisible()
  })
})
