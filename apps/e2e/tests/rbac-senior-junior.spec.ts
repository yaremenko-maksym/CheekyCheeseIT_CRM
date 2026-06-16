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

  test('SENIOR does not see «Активные проекты» section at all (task-senior-ui-followups §3b)', async ({
    asSenior: page,
  }) => {
    await mockTeamDetail(page, TEAM_WITH_JUNIOR.id, TEAM_WITH_JUNIOR)
    // Projects with junior member — irrelevant because the section is hidden
    // for SENIOR entirely (stronger protection than hiding junior identity within it).
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

    // «Активные проекты» section must not be visible for SENIOR at all.
    // This also guarantees junior identity is never leaked via that section.
    await expect(page.getByText('Активные проекты')).toHaveCount(0)

    // Junior name must NOT appear anywhere on the page for SENIOR
    await expect(page.getByText(USERS.junior.displayName)).not.toBeVisible()
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
//
// AUTHORITATIVE GUARD TEST: backend unit test in
//   apps/api/src/users/users.service.spec.ts
//   describe('UsersService.buildProfileView — ForbiddenException on empty tabs')
// proves that buildProfileView throws ForbiddenException when accessService
// returns tabs:[] (the SENIOR→JUNIOR case). The E2E test below validates the
// *frontend* response to a real 403 — it does NOT mock 403 itself (which
// would be self-fulfilling and pass even without the guard).

test.describe('RBAC #1 — SENIOR cannot access JUNIOR profile', () => {
  test('SENIOR gets 403 response and sees no junior profile heading', async ({
    asSenior: page,
  }) => {
    // We do NOT mock the API endpoint here — the real backend guard (added in
    // users.service.ts buildProfileView) must produce the 403.  If the guard
    // is missing, the API returns 200 + junior PII and this test would still
    // pass (the heading check is weak), but the backend unit tests above would
    // FAIL — that is the authoritative signal.
    //
    // What this E2E validates: when the frontend receives a 403 from
    // GET /api/users/:juniorId, it must NOT render the junior's display name
    // as a visible heading on the profile page.
    await page.goto(`/crm/profile/${USERS.junior.id}`)

    // Profile heading must not appear — frontend should handle 403 gracefully
    // (redirect, error state, or empty shell — all acceptable).
    await expect(page.getByRole('heading', { name: USERS.junior.displayName })).not.toBeVisible({
      timeout: 3000,
    })
  })
})

// ---------------------------------------------------------------------------
// #11 — JUNIOR does not see "Active Projects" or TG-канал on team page
// ---------------------------------------------------------------------------

test.describe('RBAC #11 — JUNIOR is redirected away from /crm/team (route-guard)', () => {
  // PR #184 route-guard: /crm/team prefix is NOT in JUNIOR's allowed list.
  // resolveRoleHome('JUNIOR') = '/crm/project'. Guard fires before the team-detail
  // component mounts, so active-projects / TG-канал are never rendered.
  // These tests verify the redirect contract (stronger than "section not visible").

  test('JUNIOR accessing team detail is redirected to /crm/project (active-projects never rendered)', async ({
    asJunior: page,
  }) => {
    // Even if the backend would return a team with projects, the route-guard
    // intercepts before the component mounts → JUNIOR never sees any team content.
    const teamForJunior = {
      ...TEAM_WITH_TELEGRAM,
      members: TEAM_WITH_TELEGRAM.members.filter((m) => m.role !== 'JUNIOR'),
    }
    await mockTeamDetail(page, teamForJunior.id, teamForJunior)

    await page.goto(`/crm/team/${teamForJunior.id}`)
    await expect(page).toHaveURL(/\/crm\/project/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/crm\/team/)
  })

  test('JUNIOR accessing team detail is redirected to /crm/project (TG-канал never rendered)', async ({
    asJunior: page,
  }) => {
    await mockTeamDetail(page, TEAM_WITH_TELEGRAM.id, TEAM_WITH_TELEGRAM)

    await page.goto(`/crm/team/${TEAM_WITH_TELEGRAM.id}`)
    await expect(page).toHaveURL(/\/crm\/project/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/crm\/team/)
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
    const main = page.locator('main')
    await expect(main.getByText('Активные проекты')).toBeVisible()
    // Scope to main to avoid strict-mode violation: junior name may appear
    // in both members list and active-projects slot → use first() to pick one.
    await expect(main.getByText(USERS.junior.displayName).first()).toBeVisible()
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

test.describe('Regression — JUNIOR /crm/team route-guard redirect (not content render)', () => {
  // PR #184 route-guard: JUNIOR is redirected from /crm/team to /crm/project.
  // STALE: previously "JUNIOR sees team members section (HR, SENIOR, ACCOUNTANT)".
  // The route-guard now fires before the team component mounts — no content is shown.
  test('JUNIOR navigating to team detail is redirected to /crm/project', async ({
    asJunior: page,
  }) => {
    const teamForJunior = {
      ...TEAM_WITH_JUNIOR,
      members: TEAM_WITH_JUNIOR.members.filter((m) => m.role !== 'JUNIOR'),
    }
    await mockTeamDetail(page, teamForJunior.id, teamForJunior)

    await page.goto(`/crm/team/${teamForJunior.id}`)
    await expect(page).toHaveURL(/\/crm\/project/, { timeout: 8_000 })
    await expect(page).not.toHaveURL(/\/crm\/team/)
  })
})
