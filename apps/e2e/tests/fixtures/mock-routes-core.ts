import type { Page } from '@playwright/test'
import {
  USERS,
  ALL_USERS,
  TEAMS,
  DROP_TEAM_VACANT,
  DROP_TEAM,
  ALL_TEAMS,
  toMember,
  type MockUser,
} from './mock-data'
import { buildAdminViewingUser, buildSelfView } from './view-builders'
import { API_GLOB, API_RE, jsonOk, noContent } from './route-helpers'

export async function mockCoreRoutes(page: Page, user: MockUser) {
  // Auth
  await page.route(`${API_GLOB}/auth/me`, (r) => jsonOk(r, user))
  await page.route(`${API_GLOB}/auth/logout`, (r) => noContent(r))

  // Notifications (Round 4 — Invoice Signing Epic) — NotificationsBell mounts
  // in the CRM header layout and immediately fires GET /api/notifications via
  // useNotificationsList() with a 30s polling interval. Without these mocks
  // the request hits the real backend → 401 → axios interceptor →
  // window.location.href = '/login' → user gets logged out mid-test (same
  // failure mode as PR #48 documents mocks). Register specific sub-routes
  // before the generic list route so PATCH /:id/read and PATCH /read-all
  // hit the right handlers.
  await page.route(new RegExp(`${API_RE}/notifications/read-all$`), (r) => noContent(r))
  await page.route(new RegExp(`${API_RE}/notifications/([^/?]+)/read$`), (r) => noContent(r))
  await page.route(new RegExp(`${API_RE}/notifications(\\?.*)?$`), (r) =>
    jsonOk(r, { items: [], unreadCount: 0 }),
  )

  // task-pending-screen, PR #667 fix-round 5 — NavSidebar mounts
  // usePendingItems() unconditionally (badge count) on EVERY authenticated
  // page via `useOnboardingGate().isComplete` (that gate is already mocked
  // above via /onboarding/status). Without this mock GET /pending hits the
  // real backend → 401 → axios interceptor → window.location.href = '/login'
  // → the test loses its session mid-click (same failure mode as the
  // notifications mock above). The `$` anchor is required — without it this
  // pattern would also swallow /pending-settlements/* below (registered
  // after, so a wider first match would still steal the request).
  // Shape matches `pendingResponseSchema` in packages/shared/src/schemas/
  // pending.ts. Mock is role-agnostic (empty for everyone) — specs for the
  // /pending screen itself (pending.spec.ts) use loginViaApi, not this mock.
  await page.route(new RegExp(`${API_RE}/pending(\\?.*)?$`), (r) =>
    jsonOk(r, { mine: [], proposedByMe: [] }),
  )

  // task-drop-company-debt-and-invoices. Senior IOUs are owed by the
  // company — DROP no longer has any debts. Replaced
  // `/pending-settlements/drop` with `/pending-settlements/company`.
  await page.route(new RegExp(`${API_RE}/pending-settlements/senior(\\?.*)?$`), (r) =>
    jsonOk(r, []),
  )
  await page.route(new RegExp(`${API_RE}/pending-settlements/company(\\?.*)?$`), (r) =>
    jsonOk(r, []),
  )

  await page.route(new RegExp(`${API_RE}/balances/admin/([^/?]+)(\\?.*)?$`), (r) =>
    jsonOk(r, { balance: 0, currency: 'USD', breakdown: {} }),
  )
  await page.route(new RegExp(`${API_RE}/balances/senior/([^/?]+)(\\?.*)?$`), (r) =>
    jsonOk(r, { balance: 0, currency: 'USD', breakdown: {} }),
  )

  // Users — register specific sub-routes before the generic one
  // /users/me — profile shell expects UserWithPermissionsResponse shape
  await page.route(`${API_GLOB}/users/me`, (r) =>
    r.request().method() === 'PATCH'
      ? jsonOk(r, { ...user, ...(JSON.parse(r.request().postData() ?? '{}') as object) })
      : jsonOk(r, buildSelfView(user)),
  )
  // /users/me/requisites — PATCH for self requisites update
  await page.route(`${API_GLOB}/users/me/requisites`, (r) =>
    jsonOk(r, { ...user, ...(JSON.parse(r.request().postData() ?? '{}') as object) }),
  )
  // /users/:id/role — PATCH for admin role change
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/role$`), (r) =>
    jsonOk(r, { ...user, ...(JSON.parse(r.request().postData() ?? '{}') as object) }),
  )
  // /users/:id/archive-impact — used by ArchiveConfirmDialog to populate warning text
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/archive-impact$`), (r) => {
    const targetId = r.request().url().split('/').slice(-2, -1)[0]
    const target = ALL_USERS.find((u) => u.id === targetId) ?? user
    const impact = (() => {
      switch (target.role) {
        case 'SENIOR':
          return {
            type: 'user' as const,
            role: 'SENIOR' as const,
            isPaired: true,
            teamName: 'Alpha Team',
            projectsCount: 2,
            juniorsAffected: 1,
            hrAccountantsOnTeam: 2,
          }
        case 'HR':
          return { type: 'user' as const, role: 'HR' as const, teamsCount: 1 }
        case 'ACCOUNTANT':
          return { type: 'user' as const, role: 'ACCOUNTANT' as const, teamsCount: 1 }
        case 'JUNIOR':
          return { type: 'user' as const, role: 'JUNIOR' as const, projectsCount: 1 }
        default:
          return { type: 'user' as const, role: 'ADMIN' as const, noDependencies: true }
      }
    })()
    return jsonOk(r, impact)
  })

  // /users/:id/unarchive — pair-unarchive for SENIOR, single for others
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/unarchive$`), (r) => {
    const targetId = r.request().url().split('/').slice(-2, -1)[0]
    const target = ALL_USERS.find((u) => u.id === targetId) ?? user
    return jsonOk(r, { ...target, archivedAt: null })
  })

  // /users/:id/team — used by UserDialog Edit to seed HR/Accountant selections
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/team$`), (r) =>
    jsonOk(r, [
      {
        id: USERS.hr.id,
        displayName: USERS.hr.displayName,
        role: 'HR',
        avatarUrl: null,
        avatarDocumentId: null,
      },
      {
        id: USERS.accountant.id,
        displayName: USERS.accountant.displayName,
        role: 'ACCOUNTANT',
        avatarUrl: null,
        avatarDocumentId: null,
      },
    ]),
  )

  // /users/:id — profile shell expects UserWithPermissionsResponse shape for view mode
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)$`), (r) => {
    const id = r.request().url().split('/').at(-1)
    const found = ALL_USERS.find((u) => u.id === id) ?? user
    if (r.request().method() === 'PATCH') {
      return jsonOk(r, { ...found, ...(JSON.parse(r.request().postData() ?? '{}') as object) })
    }
    // GET — return UserWithPermissionsResponse; viewer is `user`, target is `found`
    return jsonOk(r, buildAdminViewingUser(found))
  })
  // Drop role - phase 1 (AC1): POST /api/users/drops creates a DROP user
  // AND atomically provisions a drop-team. Response shape per spec:
  // `{ user, team: { id, ... }, members }` — frontend navigates to
  // `/team/<team.id>` on success (UserDialog.createDropMutation
  // — unified dialog after task-fix-drop-unify-dialog).
  await page.route(new RegExp(`${API_RE}/users/drops$`), (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    const body = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>
    const newUser = {
      ...USERS.drop,
      id: 'drop-new-id',
      email: (body.email as string) ?? USERS.drop.email,
      displayName: (body.displayName as string) ?? USERS.drop.displayName,
      dropSharePercent: (body.dropSharePercent as number) ?? 5,
    }
    const newTeam = {
      ...DROP_TEAM_VACANT,
      id: 'drop-team-new-id',
      name: `${newUser.displayName} Drop Team`,
      telegramChannel: (body.telegramChannel as string | null) ?? null,
      members: [{ ...toMember(newUser), leftAt: null }],
    }
    return jsonOk(r, { user: newUser, team: newTeam, members: newTeam.members }, 201)
  })

  // Drop role - phase 1 (AC7): POST /api/users/me/rejoin-team — teamless
  // SENIOR rejoins via CREATE_NEW (auto-team) or JOIN_DROP_TEAM (existing
  // drop-team). 204 no-content is plenty for the dialog; the real API
  // returns 200 with details, but neither path is asserted by the UI.
  await page.route(new RegExp(`${API_RE}/users/me/rejoin-team$`), (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    return jsonOk(r, { ok: true })
  })

  // /users — supports `?archived=true|false` filter
  await page.route(new RegExp(`${API_RE}/users(\\?.*)?$`), (r) => {
    if (r.request().method() === 'POST') {
      return jsonOk(
        r,
        {
          ...USERS.junior,
          id: 'new-user-id',
          ...(JSON.parse(r.request().postData() ?? '{}') as object),
        },
        201,
      )
    }
    const url = new URL(r.request().url())
    const archived = url.searchParams.get('archived') === 'true'
    // For the mock: archived list is empty unless explicitly testing archived flows
    return jsonOk(r, archived ? [] : ALL_USERS)
  })

  // Teams
  // Drop role - phase 1 (AC4): rotate-senior on a drop-team. Register
  // BEFORE the generic `/teams/:id` matcher so PATCH on the rotate path
  // doesn't accidentally hit the team-update handler.
  await page.route(new RegExp(`${API_RE}/teams/([^/?]+)/rotate-senior$`), (r) => {
    if (r.request().method() !== 'PATCH' && r.request().method() !== 'POST') {
      return r.fallback()
    }
    const teamId = r.request().url().split('/').slice(-2, -1)[0]
    const team = ALL_TEAMS.find((t) => t.id === teamId) ?? DROP_TEAM
    return jsonOk(r, team)
  })
  await page.route(new RegExp(`${API_RE}/teams/([^/?]+)/members`), (r) =>
    r.request().method() === 'DELETE' ? noContent(r) : jsonOk(r, TEAMS[0], 201),
  )
  await page.route(new RegExp(`${API_RE}/teams/([^/?]+)$`), (r) => {
    const teamId = r.request().url().split('/').at(-1)
    // Drop role - phase 1: search across senior + drop fixtures.
    const team = ALL_TEAMS.find((t) => t.id === teamId) ?? TEAMS[0]

    return r.request().method() === 'DELETE'
      ? noContent(r)
      : r.request().method() === 'GET'
        ? jsonOk(r, team)
        : jsonOk(r, { ...team, ...(JSON.parse(r.request().postData() ?? '{}') as object) })
  })
  await page.route(`${API_GLOB}/teams`, (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { ...TEAMS[0], id: 'new-team-id', name: 'New Team' }, 201)
      : jsonOk(r, TEAMS),
  )
}
