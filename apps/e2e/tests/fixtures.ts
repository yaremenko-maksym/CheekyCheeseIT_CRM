import { test as base, expect, type Page, type Route } from '@playwright/test'

// ---------------------------------------------------------------------------
// Seed data — mirrors what the dev seed script creates
// ---------------------------------------------------------------------------

export const USERS = {
  admin: {
    id: 'a0000000-0000-4000-8000-000000000001',
    email: 'admin@cheekycheese.dev',
    displayName: 'Admin User',
    role: 'ADMIN' as const,
    avatarUrl: null,
    avatarDocumentId: null,
    telegram: null,
    phone: null,
    techStack: null,
    paymentMethod: null,
    seniorSharePercent: 0,
    monthlySalary: null,
    salaryCurrency: 'USD' as const,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  },
  senior: {
    id: 'a0000000-0000-4000-8000-000000000002',
    email: 'senior@cheekycheese.dev',
    displayName: 'Senior Dev',
    role: 'SENIOR' as const,
    avatarUrl: null,
    avatarDocumentId: null,
    telegram: '@seniordev',
    phone: '+380661234567',
    techStack: ['TypeScript', 'React'],
    paymentMethod: 'USDT_ERC20' as const,
    seniorSharePercent: 26,
    monthlySalary: null,
    salaryCurrency: 'USD' as const,
    createdAt: '2024-01-02T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
  },
  junior: {
    id: 'a0000000-0000-4000-8000-000000000003',
    email: 'junior@cheekycheese.dev',
    displayName: 'Junior Dev',
    role: 'JUNIOR' as const,
    avatarUrl: null,
    avatarDocumentId: null,
    telegram: null,
    phone: null,
    techStack: null,
    paymentMethod: 'BANK_UAH_FOP' as const,
    seniorSharePercent: 0,
    monthlySalary: '800',
    salaryCurrency: 'USD' as const,
    createdAt: '2024-01-03T00:00:00.000Z',
    updatedAt: '2024-01-03T00:00:00.000Z',
  },
  hr: {
    id: 'a0000000-0000-4000-8000-000000000004',
    email: 'hr@cheekycheese.dev',
    displayName: 'HR Manager',
    role: 'HR' as const,
    avatarUrl: null,
    avatarDocumentId: null,
    telegram: null,
    phone: null,
    techStack: null,
    paymentMethod: 'BANK_UAH_FOP' as const,
    seniorSharePercent: 0,
    monthlySalary: '1000',
    salaryCurrency: 'USD' as const,
    createdAt: '2024-01-04T00:00:00.000Z',
    updatedAt: '2024-01-04T00:00:00.000Z',
  },
  accountant: {
    id: 'a0000000-0000-4000-8000-000000000005',
    email: 'accountant@cheekycheese.dev',
    displayName: 'Accountant User',
    role: 'ACCOUNTANT' as const,
    avatarUrl: null,
    avatarDocumentId: null,
    telegram: null,
    phone: null,
    techStack: null,
    paymentMethod: 'BANK_UAH_FOP' as const,
    seniorSharePercent: 0,
    monthlySalary: '1200',
    salaryCurrency: 'USD' as const,
    createdAt: '2024-01-05T00:00:00.000Z',
    updatedAt: '2024-01-05T00:00:00.000Z',
  },
  // Drop role - phase 1 (AC1, AC8 RBAC). The DROP persona owns a dedicated
  // drop-team. Acts as the financial conduit between the senior and the
  // platform. Sees only Profile / Team / Finance in the sidebar.
  drop: {
    id: 'a0000000-0000-4000-8000-000000000007',
    email: 'drop@cheekycheese.dev',
    displayName: 'Drop User',
    role: 'DROP' as const,
    avatarUrl: null,
    avatarDocumentId: null,
    telegram: '@dropuser',
    phone: null,
    techStack: null,
    paymentMethod: 'USDT_ERC20' as const,
    seniorSharePercent: 0,
    /** Drop's percentage off project income — spec default 5 (AC1 uses 7). */
    dropSharePercent: 5,
    monthlySalary: null,
    salaryCurrency: 'USD' as const,
    createdAt: '2024-01-07T00:00:00.000Z',
    updatedAt: '2024-01-07T00:00:00.000Z',
  },
  // Drop role - phase 1 (AC5): a SENIOR sitting in no active team. Surfaces
  // the «У вас нет активной команды» banner on `/crm/profile` and the
  // empty-state on `/crm/projects` + `/crm/interviews`.
  seniorOrphan: {
    id: 'a0000000-0000-4000-8000-000000000008',
    email: 'senior-orphan@cheekycheese.dev',
    displayName: 'Senior Orphan',
    role: 'SENIOR' as const,
    avatarUrl: null,
    avatarDocumentId: null,
    telegram: null,
    phone: null,
    techStack: ['TypeScript'],
    paymentMethod: 'USDT_ERC20' as const,
    seniorSharePercent: 26,
    monthlySalary: null,
    salaryCurrency: 'USD' as const,
    createdAt: '2024-01-08T00:00:00.000Z',
    updatedAt: '2024-01-08T00:00:00.000Z',
  },
  // Drop role - phase 1 (AC2, AC4): a "free" SENIOR available for joining
  // a drop-team or for rotation. Distinct from senior-orphan so AC2 (join
  // drop-team) and AC4 (rotate-senior) can target a non-archived candidate.
  seniorFree: {
    id: 'a0000000-0000-4000-8000-000000000009',
    email: 'senior-free@cheekycheese.dev',
    displayName: 'Senior Free',
    role: 'SENIOR' as const,
    avatarUrl: null,
    avatarDocumentId: null,
    telegram: null,
    phone: null,
    techStack: ['TypeScript'],
    paymentMethod: 'USDT_ERC20' as const,
    seniorSharePercent: 26,
    monthlySalary: null,
    salaryCurrency: 'USD' as const,
    createdAt: '2024-01-09T00:00:00.000Z',
    updatedAt: '2024-01-09T00:00:00.000Z',
  },
}

export const ALL_USERS = Object.values(USERS)

function toMember(user: (typeof USERS)[keyof typeof USERS], joinedAt = '2024-01-10T00:00:00.000Z') {
  return {
    id: `member-${user.id}`,
    userId: user.id,
    displayName: user.displayName,
    email: user.email,
    avatarUrl: user.avatarUrl,
    avatarDocumentId: user.avatarDocumentId,
    role: user.role,
    techStack: user.techStack,
    joinedAt,
  }
}

// Extra accountant for "remove member" test — two accountants means neither is "last"
const EXTRA_ACCOUNTANT = {
  id: 'a0000000-0000-4000-8000-000000000006',
  email: 'accountant2@cheekycheese.dev',
  displayName: 'Accountant Two',
  role: 'ACCOUNTANT' as const,
  avatarUrl: null,
  avatarDocumentId: null,
  telegram: null,
  phone: null,
  techStack: null,
  paymentMethod: 'BANK_UAH_FOP' as const,
  seniorSharePercent: 0,
  monthlySalary: '1200',
  salaryCurrency: 'USD' as const,
  createdAt: '2024-01-06T00:00:00.000Z',
  updatedAt: '2024-01-06T00:00:00.000Z',
}

export const TEAMS = [
  {
    id: 'team-1-id',
    name: 'Alpha Team',
    // Drop role - phase 1: `type` field added to TeamDto schema. Existing
    // senior-team fixtures carry the default 'SENIOR' value so legacy specs
    // remain a no-op regression.
    type: 'SENIOR' as const,
    telegram: null,
    telegramChannel: null,
    notes: null,
    createdAt: '2024-01-10T00:00:00.000Z',
    updatedAt: '2024-01-10T00:00:00.000Z',
    archivedAt: null,
    members: [
      { ...toMember(USERS.hr), leftAt: null },
      { ...toMember(USERS.senior), leftAt: null },
      { ...toMember(USERS.accountant), leftAt: null },
      { ...toMember(EXTRA_ACCOUNTANT), leftAt: null },
    ],
  },
]

/**
 * Drop role - phase 1 fixtures.
 *
 * A DROP-typed team — paired with the DROP user. Owns its HR + accountant
 * and (in this fixture) carries an active SENIOR via `USERS.senior` so the
 * rotation flow (AC4) has a meaningful starting state.
 *
 * Tests that need a "drop-team without an active senior" can either
 * reuse `DROP_TEAM_VACANT` below, or layer a per-test mock that overrides
 * the team to remove the senior member.
 */
export const DROP_TEAM = {
  id: 'drop-team-1-id',
  name: 'Drop Team Alpha',
  type: 'DROP' as const,
  telegram: null,
  telegramChannel: 'drop_team_channel',
  notes: null,
  createdAt: '2024-02-01T00:00:00.000Z',
  updatedAt: '2024-02-01T00:00:00.000Z',
  archivedAt: null,
  members: [
    { ...toMember(USERS.drop), leftAt: null },
    { ...toMember(USERS.hr), leftAt: null },
    { ...toMember(USERS.accountant), leftAt: null },
    { ...toMember(USERS.senior), leftAt: null },
  ],
}

/** Drop-team variant with NO active senior — used by AC2 (join) + AC4 (assign). */
export const DROP_TEAM_VACANT = {
  ...DROP_TEAM,
  id: 'drop-team-vacant-id',
  name: 'Drop Team Vacant',
  members: [
    { ...toMember(USERS.drop), leftAt: null },
    { ...toMember(USERS.hr), leftAt: null },
    { ...toMember(USERS.accountant), leftAt: null },
  ],
}

/**
 * Drop role - phase 1: unified lookup over senior + drop teams. Used by the
 * `/api/teams/:id` route mock so a drop-team URL resolves correctly without
 * each spec re-mocking it. Tests that need only the senior list can keep
 * using `TEAMS`.
 */
export const ALL_TEAMS = [...TEAMS, DROP_TEAM, DROP_TEAM_VACANT]

// Round 5: project lifecycle is binary — ACTIVE (archivedAt = null) vs
// ARCHIVED (archivedAt = timestamp). The legacy CLOSED state and end_date
// column are gone, so the "EdTech Portal" fixture below is archived rather
// than CLOSED to preserve archive-flow test coverage.
export const PROJECTS = [
  {
    id: 'project-1-id',
    name: 'AI Platform v2',
    companyName: 'TechCorp AI',
    domain: 'AI',
    logoDocumentId: null,
    logoExternalUrl: null,
    seniorId: USERS.senior.id,
    seniorName: USERS.senior.displayName,
    rate: 5000,
    currency: 'USDT',
    seniorSharePercentOverride: null,
    seniorSharePercentDefault: 26,
    startDate: '2024-01-15T00:00:00.000Z',
    archivedAt: null,
    createdAt: '2024-01-15T00:00:00.000Z',
    updatedAt: '2024-01-15T00:00:00.000Z',
    members: [],
  },
  {
    id: 'project-2-id',
    name: 'EdTech Portal',
    companyName: 'LearnFast Ltd',
    domain: 'EdTech',
    logoDocumentId: null,
    logoExternalUrl: null,
    seniorId: USERS.senior.id,
    seniorName: USERS.senior.displayName,
    rate: 3000,
    currency: 'USD',
    seniorSharePercentOverride: null,
    seniorSharePercentDefault: 26,
    sharePercent: null,
    startDate: '2023-06-01T00:00:00.000Z',
    archivedAt: '2024-01-01T00:00:00.000Z',
    createdAt: '2023-06-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    members: [
      {
        id: 'pm-junior-1',
        userId: USERS.junior.id,
        displayName: USERS.junior.displayName,
        email: USERS.junior.email,
        avatarUrl: USERS.junior.avatarUrl,
        avatarDocumentId: USERS.junior.avatarDocumentId,
        role: USERS.junior.role,
        joinedAt: '2023-06-01T00:00:00.000Z',
        leftAt: null,
      },
    ],
  },
]

export const INTERVIEWS = [
  {
    id: 'interview-1-id',
    seniorId: USERS.senior.id,
    seniorName: USERS.senior.displayName,
    hrId: USERS.hr.id,
    hrName: USERS.hr.displayName,
    companyName: 'Acme Corp',
    vacancyUrl: 'https://jobs.acme.com/senior-dev',
    callUrl: 'https://meet.google.com/abc-def-ghi',
    stage: 'HR_SCREEN',
    position: 0,
    notesDomain: null,
    notesTechStack: null,
    notesTeamSize: null,
    notesBenefits: null,
    notesPaymentType: null,
    notesSalaryReview: null,
    notesGeneral: null,
    createdAt: '2024-02-01T00:00:00.000Z',
    updatedAt: '2024-02-01T00:00:00.000Z',
  },
  {
    id: 'interview-2-id',
    seniorId: USERS.senior.id,
    seniorName: USERS.senior.displayName,
    hrId: USERS.hr.id,
    hrName: USERS.hr.displayName,
    companyName: 'Beta Startup',
    vacancyUrl: null,
    callUrl: null,
    stage: 'TECH_INTERVIEW',
    position: 0,
    notesDomain: 'AI / fintech',
    notesTechStack: 'React, Node.js',
    notesTeamSize: '5 devs',
    notesBenefits: null,
    notesPaymentType: null,
    notesSalaryReview: null,
    notesGeneral: 'Looks promising',
    createdAt: '2024-02-05T00:00:00.000Z',
    updatedAt: '2024-02-10T00:00:00.000Z',
  },
  {
    id: 'interview-3-id',
    seniorId: USERS.senior.id,
    seniorName: USERS.senior.displayName,
    hrId: USERS.hr.id,
    hrName: USERS.hr.displayName,
    companyName: 'Old Corp',
    vacancyUrl: null,
    callUrl: null,
    stage: 'HIRED',
    position: 0,
    notesDomain: null,
    notesTechStack: null,
    notesTeamSize: null,
    notesBenefits: null,
    notesPaymentType: null,
    notesSalaryReview: null,
    notesGeneral: null,
    createdAt: '2024-01-10T00:00:00.000Z',
    updatedAt: '2024-01-20T00:00:00.000Z',
  },
  {
    id: 'interview-4-id',
    seniorId: USERS.senior.id,
    seniorName: USERS.senior.displayName,
    hrId: USERS.hr.id,
    hrName: USERS.hr.displayName,
    companyName: 'Final Stage Corp',
    vacancyUrl: null,
    callUrl: null,
    stage: 'FINAL_INTERVIEW',
    position: 0,
    notesDomain: null,
    notesTechStack: null,
    notesTeamSize: null,
    notesBenefits: null,
    notesPaymentType: null,
    notesSalaryReview: null,
    notesGeneral: null,
    createdAt: '2024-03-01T00:00:00.000Z',
    updatedAt: '2024-03-01T00:00:00.000Z',
  },
]

// ---------------------------------------------------------------------------
// UserWithPermissionsResponse builders — used by profile-page specs
// ---------------------------------------------------------------------------

/** Shared profile-DTO fields not present on the fixture seed users. */
function profileExtras(user: (typeof USERS)[keyof typeof USERS]) {
  return {
    walletUsdtErc20: user.paymentMethod === 'USDT_ERC20' ? '0x1234567890abcdef' : null,
    walletUsdtLabel: null,
    bankUahRecipient: user.paymentMethod === 'BANK_UAH_FOP' ? 'Test User' : null,
    bankUahIban: user.paymentMethod === 'BANK_UAH_FOP' ? 'UA213223130000026007233566001' : null,
    bankUahRnokpp: user.paymentMethod === 'BANK_UAH_FOP' ? '1234567890' : null,
    bankUahBankName: null,
    archivedAt: null,
    adminNote: null,
    // Drop role - phase 1: nullable for non-DROP roles. Default 5 for the
    // drop seed user (overridden per-user in USERS).
    dropSharePercent:
      'dropSharePercent' in user ? (user as { dropSharePercent: number }).dropSharePercent : null,
  }
}

/** Full admin viewing anyone: all tabs + all actions */
export function buildAdminViewingUser(targetUser: (typeof USERS)[keyof typeof USERS]): object {
  return {
    user: { ...targetUser, ...profileExtras(targetUser) },
    permissions: {
      tabs: ['overview', 'finance', 'projects', 'team', 'requisites', 'audit'],
      actions: [
        'edit-profile',
        'change-role',
        'change-salary',
        'change-requisites',
        'set-note',
        'archive',
      ],
      fields: {
        salary: true,
        share: true,
        paymentMethodKpi: true,
        techStack: true,
        registrationDate: true,
      },
    },
    data: {},
  }
}

/** HR viewing their own senior: overview + projects + team only, no actions */
export function buildHrViewingSenior(senior: (typeof USERS)[keyof typeof USERS]): object {
  return {
    user: { ...senior, ...profileExtras(senior) },
    permissions: {
      tabs: ['overview', 'projects', 'team'],
      actions: [],
      fields: { techStack: true, registrationDate: true },
    },
    data: {},
  }
}

/** Junior viewing another junior: header only, no tabs, no actions */
export function buildJuniorViewingJunior(targetUser: (typeof USERS)[keyof typeof USERS]): object {
  return {
    user: { ...targetUser, ...profileExtras(targetUser) },
    permissions: {
      tabs: [],
      actions: [],
      fields: {},
    },
    data: {},
  }
}

/** Self-view response (used by GET /users/me on profile page) */
export function buildSelfView(user: (typeof USERS)[keyof typeof USERS]): object {
  // Mirrors users-access.service.ts isSelf branch.
  // SENIOR: interviews surfaced via header link, not tab.
  // Drop role - phase 1 (AC8): DROP sees Profile / Team / Finance — no
  // projects / interviews / documents tabs on the self-view.
  const tabs: string[] =
    user.role === 'DROP'
      ? ['overview', 'team', 'requisites', 'finance']
      : ['overview', 'projects', 'team', 'requisites', 'documents']
  if (
    user.role === 'SENIOR' ||
    user.role === 'JUNIOR' ||
    user.role === 'HR' ||
    user.role === 'ACCOUNTANT'
  ) {
    tabs.push('finance')
  }

  const isSalaryRole = user.role === 'JUNIOR' || user.role === 'HR' || user.role === 'ACCOUNTANT'
  const isShareRole = user.role === 'SENIOR' || user.role === 'ADMIN' || user.role === 'DROP'

  return {
    user: { ...user, ...profileExtras(user) },
    permissions: {
      tabs,
      actions: [],
      fields: {
        salary: isSalaryRole,
        share: isShareRole,
        paymentMethodKpi: true,
        registrationDate: true,
        techStack: true,
        requisites: true,
      },
    },
    data: {},
  }
}

// ---------------------------------------------------------------------------
// API base URL (matches what the web app uses via env)
// ---------------------------------------------------------------------------
const API = 'http://localhost:3001/api'

// ---------------------------------------------------------------------------
// Route helpers
// ---------------------------------------------------------------------------

function jsonOk(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

function noContent(route: Route) {
  return route.fulfill({ status: 204, body: '' })
}

// ---------------------------------------------------------------------------
// Mock all API calls for a given authenticated user
// ---------------------------------------------------------------------------
export async function mockAuthAs(page: Page, user: (typeof USERS)[keyof typeof USERS]) {
  // All routes use the exact API base (localhost:3001/api) to avoid
  // intercepting Vite page navigation requests (localhost:3000).

  // Auth
  await page.route(`${API}/auth/me`, (r) => jsonOk(r, user))
  await page.route(`${API}/auth/logout`, (r) => noContent(r))

  // Notifications (Round 4 — Invoice Signing Epic) — NotificationsBell mounts
  // in the CRM header layout and immediately fires GET /api/notifications via
  // useNotificationsList() with a 30s polling interval. Without these mocks
  // the request hits the real backend → 401 → axios interceptor →
  // window.location.href = '/login' → user gets logged out mid-test (same
  // failure mode as PR #48 documents mocks). Register specific sub-routes
  // before the generic list route so PATCH /:id/read and PATCH /read-all
  // hit the right handlers.
  await page.route(new RegExp(`${API}/notifications/read-all$`), (r) => noContent(r))
  await page.route(new RegExp(`${API}/notifications/([^/?]+)/read$`), (r) => noContent(r))
  await page.route(new RegExp(`${API}/notifications(\\?.*)?$`), (r) =>
    jsonOk(r, { items: [], unreadCount: 0 }),
  )

  // task-drop-company-debt-and-invoices. Senior IOUs are owed by the
  // company — DROP no longer has any debts. Replaced
  // `/pending-settlements/drop` with `/pending-settlements/company`.
  await page.route(new RegExp(`${API}/pending-settlements/senior(\\?.*)?$`), (r) => jsonOk(r, []))
  await page.route(new RegExp(`${API}/pending-settlements/company(\\?.*)?$`), (r) => jsonOk(r, []))

  await page.route(new RegExp(`${API}/balances/admin/([^/?]+)(\\?.*)?$`), (r) =>
    jsonOk(r, { balance: 0, currency: 'USD', breakdown: {} }),
  )
  await page.route(new RegExp(`${API}/balances/senior/([^/?]+)(\\?.*)?$`), (r) =>
    jsonOk(r, { balance: 0, currency: 'USD', breakdown: {} }),
  )

  // Users — register specific sub-routes before the generic one
  // /users/me — profile shell expects UserWithPermissionsResponse shape
  await page.route(`${API}/users/me`, (r) =>
    r.request().method() === 'PATCH'
      ? jsonOk(r, { ...user, ...(JSON.parse(r.request().postData() ?? '{}') as object) })
      : jsonOk(r, buildSelfView(user)),
  )
  // /users/me/requisites — PATCH for self requisites update
  await page.route(`${API}/users/me/requisites`, (r) =>
    jsonOk(r, { ...user, ...(JSON.parse(r.request().postData() ?? '{}') as object) }),
  )
  // /users/:id/role — PATCH for admin role change
  await page.route(new RegExp(`${API}/users/([^/?]+)/role$`), (r) =>
    jsonOk(r, { ...user, ...(JSON.parse(r.request().postData() ?? '{}') as object) }),
  )
  // /users/:id/audit-log
  await page.route(new RegExp(`${API}/users/([^/?]+)/audit-log`), (r) =>
    jsonOk(r, {
      entries: [
        {
          id: 'audit-1',
          userId: user.id,
          action: 'role_change',
          performedBy: user.id,
          changes: { role: { from: 'JUNIOR', to: 'HR' } },
          createdAt: '2026-05-01T10:00:00.000Z',
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    }),
  )
  // /users/:id/archive-impact — used by ArchiveConfirmDialog to populate warning text
  await page.route(new RegExp(`${API}/users/([^/?]+)/archive-impact$`), (r) => {
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
            hrAccountantsToBeRemoved: 2,
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
  await page.route(new RegExp(`${API}/users/([^/?]+)/unarchive$`), (r) => {
    const targetId = r.request().url().split('/').slice(-2, -1)[0]
    const target = ALL_USERS.find((u) => u.id === targetId) ?? user
    return jsonOk(r, { ...target, archivedAt: null })
  })

  // /users/:id/team — used by UserDialog Edit to seed HR/Accountant selections
  await page.route(new RegExp(`${API}/users/([^/?]+)/team$`), (r) =>
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
  await page.route(new RegExp(`${API}/users/([^/?]+)$`), (r) => {
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
  // `/crm/team/<team.id>` on success (UserDialog.createDropMutation
  // — unified dialog after task-fix-drop-unify-dialog).
  await page.route(new RegExp(`${API}/users/drops$`), (r) => {
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
  await page.route(new RegExp(`${API}/users/me/rejoin-team$`), (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    return jsonOk(r, { ok: true })
  })

  // /users — supports `?archived=true|false` filter
  await page.route(new RegExp(`${API}/users(\\?.*)?$`), (r) => {
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
  await page.route(new RegExp(`${API}/teams/([^/?]+)/rotate-senior$`), (r) => {
    if (r.request().method() !== 'PATCH' && r.request().method() !== 'POST') {
      return r.fallback()
    }
    const teamId = r.request().url().split('/').slice(-2, -1)[0]
    const team = ALL_TEAMS.find((t) => t.id === teamId) ?? DROP_TEAM
    return jsonOk(r, team)
  })
  await page.route(new RegExp(`${API}/teams/([^/?]+)/members`), (r) =>
    r.request().method() === 'DELETE' ? noContent(r) : jsonOk(r, TEAMS[0], 201),
  )
  await page.route(new RegExp(`${API}/teams/([^/?]+)$`), (r) => {
    const teamId = r.request().url().split('/').at(-1)
    // Drop role - phase 1: search across senior + drop fixtures.
    const team = ALL_TEAMS.find((t) => t.id === teamId) ?? TEAMS[0]

    return r.request().method() === 'DELETE'
      ? noContent(r)
      : r.request().method() === 'GET'
        ? jsonOk(r, team)
        : jsonOk(r, { ...team, ...(JSON.parse(r.request().postData() ?? '{}') as object) })
  })
  await page.route(`${API}/teams`, (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { ...TEAMS[0], id: 'new-team-id', name: 'New Team' }, 201)
      : jsonOk(r, TEAMS),
  )

  // Projects
  await page.route(new RegExp(`${API}/projects/([^/?]+)/members`), (r) =>
    r.request().method() === 'DELETE' ? noContent(r) : jsonOk(r, PROJECTS[0], 201),
  )
  await page.route(new RegExp(`${API}/projects/([^/?]+)$`), (r) =>
    r.request().method() === 'DELETE'
      ? noContent(r)
      : jsonOk(r, { ...PROJECTS[0], ...(JSON.parse(r.request().postData() ?? '{}') as object) }),
  )
  // Round 5: honor the `?archived=true|false` filter so the new «Все/Активные/Архив»
  // tabs return the expected slice of fixture projects. PROJECTS[0] is active
  // (archivedAt = null) and PROJECTS[1] is archived (archivedAt = timestamp).
  await page.route(new RegExp(`${API}/projects(\\?.*)?$`), (r) => {
    if (r.request().method() === 'POST') {
      return jsonOk(r, { ...PROJECTS[0], id: 'new-project-id' }, 201)
    }
    const url = new URL(r.request().url())
    const archivedParam = url.searchParams.get('archived')
    if (archivedParam === 'true') {
      return jsonOk(
        r,
        PROJECTS.filter((p) => p.archivedAt !== null),
      )
    }
    return jsonOk(
      r,
      PROJECTS.filter((p) => p.archivedAt === null),
    )
  })

  // Interviews
  await page.route(new RegExp(`${API}/interviews/([^/?]+)/move`), (r) =>
    jsonOk(r, { ...INTERVIEWS[0], stage: 'ENGLISH_CHECK' }),
  )
  await page.route(new RegExp(`${API}/interviews/([^/?]+)$`), (r) =>
    r.request().method() === 'DELETE'
      ? noContent(r)
      : jsonOk(r, { ...INTERVIEWS[0], ...(JSON.parse(r.request().postData() ?? '{}') as object) }),
  )
  await page.route(new RegExp(`${API}/interviews(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { ...INTERVIEWS[0], id: 'new-interview-id' }, 201)
      : jsonOk(r, INTERVIEWS),
  )

  // Finance — real API paths (no /finance/ prefix for transactions/payout-requests)
  await page.route(new RegExp(`${API}/transactions/senior-income/([^/?]+)$`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-1), status: 'PENDING' }),
  )
  await page.route(new RegExp(`${API}/transactions/([^/?]+)/(validate|pay|admin-edit)$`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-2), status: 'VALIDATED' }),
  )
  await page.route(new RegExp(`${API}/transactions/([^/?]+)$`), (r) => {
    if (r.request().method() === 'DELETE') return jsonOk(r, { deleted: true })
    if (r.request().method() === 'POST') return jsonOk(r, { id: 'tx-new', status: 'PENDING' }, 201)
    return jsonOk(r, { id: r.request().url().split('/').at(-1), status: 'PENDING' })
  })
  await page.route(new RegExp(`${API}/transactions(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'tx-new', status: 'PENDING' }, 201)
      : jsonOk(r, []),
  )
  await page.route(new RegExp(`${API}/payout-requests/([^/?]+)/pay$`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-2), status: 'PAID' }),
  )
  await page.route(new RegExp(`${API}/payout-requests(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'payout-req-new', status: 'PENDING_PAYMENT' }, 201)
      : jsonOk(r, []),
  )

  // Finance — summary, transactions, expenses, payouts, junior-payments, invoices, exchange rates
  await page.route(new RegExp(`${API}/finance/summary(\\?.*)?$`), (r) =>
    jsonOk(r, {
      totalIncome: '50000.00',
      totalExpenses: '12000.00',
      netProfit: '38000.00',
      totalIncomeUsd: '50000.00',
      totalExpensesUsd: '12000.00',
      netProfitUsd: '38000.00',
      partnerBalance: {
        maksymSpentUsd: '6000.00',
        kostyaSpentUsd: '6000.00',
        debtUsd: '0.00',
        debtDirection: 'SETTLED',
      },
    }),
  )
  await page.route(new RegExp(`${API}/finance/transactions(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'tx-new', status: 'PENDING' }, 201)
      : jsonOk(r, []),
  )
  await page.route(new RegExp(`${API}/finance/transactions/([^/?]+)`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-1), status: 'VALIDATED' }),
  )
  await page.route(new RegExp(`${API}/finance/expenses(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'exp-new', expenseType: 'COMPANY_INCOME' }, 201)
      : jsonOk(r, []),
  )
  await page.route(new RegExp(`${API}/finance/expenses/([^/?]+)`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-1) }),
  )
  await page.route(new RegExp(`${API}/finance/junior-payments(\\?.*)?$`), (r) => jsonOk(r, []))
  await page.route(new RegExp(`${API}/finance/invoices(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'inv-new', status: 'DRAFT' }, 201)
      : jsonOk(r, []),
  )
  await page.route(new RegExp(`${API}/finance/invoices/([^/?]+)`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-1), status: 'DRAFT' }),
  )
  await page.route(new RegExp(`${API}/finance/payouts(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'payout-new', status: 'PENDING_PAYMENT' }, 201)
      : jsonOk(r, []),
  )
  await page.route(new RegExp(`${API}/finance/payouts/([^/?]+)`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-1), status: 'PENDING_PAYMENT' }),
  )
  await page.route(new RegExp(`${API}/finance/exchange-rate(\\?.*)?$`), (r) =>
    jsonOk(r, { usdUah: '41.50', usdtUah: '41.50', eurUah: '44.80', date: '2026-05-10' }),
  )
  await page.route(new RegExp(`${API}/finance/chart(/.*)?$`), (r) => jsonOk(r, []))
  await page.route(new RegExp(`${API}/finance/partner-balance(\\?.*)?$`), (r) =>
    jsonOk(r, {
      maksymSpentUsd: '6000.00',
      kostyaSpentUsd: '6000.00',
      debtUsd: '0.00',
      debtDirection: 'SETTLED',
    }),
  )
  await page.route(new RegExp(`${API}/finance/my-salary(\\?.*)?$`), (r) => jsonOk(r, []))
  await page.route(new RegExp(`${API}/finance/expenses/hints(\\?.*)?$`), (r) =>
    jsonOk(r, { projects: [], users: [] }),
  )

  // Onboarding (Phase 6B) — default: fully onboarded, no wizard redirect.
  // Tests that need unboarded state call mockOnboardingApi() AFTER mockAuthAs();
  // Playwright's LIFO route-handler stack ensures the later registration wins.
  await page.route(`${API}/onboarding/status`, (r) =>
    jsonOk(r, {
      requiresContract: false,
      requiresTos: false,
      contractTemplate: null,
      tosVersion: null,
      tosUpdateAvailable: false,
      latestTosVersion: null,
    }),
  )

  // Documents (PHASE 6) — register specific sub-routes before the generic one.
  // navigation.spec.ts and others click sidebar → /crm/documents which mounts
  // DocumentsPage → useDocuments() → GET /documents. Without these mocks the
  // request hits the real backend → 401 → axios interceptor → location.href =
  // '/login' → user gets logged out mid-navigation (root cause for PR #48 fails).
  await page.route(new RegExp(`${API}/documents/([^/?]+)/download$`), (r) =>
    jsonOk(r, {
      url: 'http://localhost:9000/crm-documents/mock-download',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
  )
  await page.route(new RegExp(`${API}/documents/([^/?]+)/thumbnail$`), (r) => jsonOk(r, null))
  await page.route(new RegExp(`${API}/documents/([^/?]+)/restore$`), (r) =>
    jsonOk(r, {
      id: r.request().url().split('/').slice(-2, -1)[0],
      ownerId: user.id,
      projectId: null,
      category: 'RESUME',
      name: 'restored.pdf',
      originalName: 'restored.pdf',
      s3Key: 'mock-key',
      thumbnailS3Key: null,
      sizeBytes: 1024,
      mimeType: 'application/pdf',
      uploadedBy: user.id,
      deletedAt: null,
      deletedBy: null,
      createdAt: '2026-05-01T10:00:00.000Z',
    }),
  )
  await page.route(new RegExp(`${API}/documents/([^/?]+)/hard$`), (r) => noContent(r))
  await page.route(new RegExp(`${API}/documents/([^/?]+)$`), (r) =>
    r.request().method() === 'DELETE'
      ? noContent(r)
      : jsonOk(r, {
          id: r.request().url().split('/').at(-1),
          ownerId: user.id,
          projectId: null,
          category: 'RESUME',
          name: 'mock.pdf',
          originalName: 'mock.pdf',
          s3Key: 'mock-key',
          thumbnailS3Key: null,
          sizeBytes: 1024,
          mimeType: 'application/pdf',
          uploadedBy: user.id,
          deletedAt: null,
          deletedBy: null,
          createdAt: '2026-05-01T10:00:00.000Z',
        }),
  )
  await page.route(new RegExp(`${API}/documents(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(
          r,
          {
            id: 'doc-new',
            ownerId: user.id,
            projectId: null,
            category: 'RESUME',
            name: 'uploaded.pdf',
            originalName: 'uploaded.pdf',
            s3Key: 'mock-key-new',
            thumbnailS3Key: null,
            sizeBytes: 2048,
            mimeType: 'application/pdf',
            uploadedBy: user.id,
            deletedAt: null,
            deletedBy: null,
            createdAt: '2026-05-01T10:00:00.000Z',
          },
          201,
        )
      : jsonOk(r, []),
  )

  // Compliance audit trail (Phase 6 polish PR3)
  // GET /me/audit-trail — self-service data portability endpoint
  // NOTE: ids must be valid UUIDs — auditTrailResponseSchema uses z.string().uuid()
  await page.route(`${API}/me/audit-trail`, (r) =>
    jsonOk(r, {
      signedContracts: [
        {
          type: 'contract',
          id: 'a0000000-0000-4000-8000-000000000101',
          contractNumber: 'CHK-1-2026',
          signedAt: '2026-01-15T10:00:00.000Z',
          signedTypedName: user.displayName,
          signedIp: '192.168.1.1',
          templateRole: user.role === 'ADMIN' ? 'SENIOR' : user.role,
          templateVersion: 1,
          bodyMarkdownSnapshot: `# MSA Contract\n\nПодписал: ${user.displayName}`,
        },
      ],
      tosAcceptances: [
        {
          type: 'tos',
          id: 'a0000000-0000-4000-8000-000000000102',
          acceptedAt: '2026-01-10T08:00:00.000Z',
          acceptedIp: '10.0.0.1',
          tosVersion: 1,
          tosBodyMarkdown: '# Terms of Service v1\n\nAll rights reserved.',
        },
      ],
    }),
  )
  // GET /audit/all — ACCOUNTANT + ADMIN compliance view
  // NOTE: ids must be valid UUIDs — auditAllResponseSchema uses z.string().uuid()
  await page.route(new RegExp(`${API}/audit/all(\\?.*)?$`), (r) =>
    jsonOk(r, {
      items: [
        {
          type: 'contract',
          id: 'a0000000-0000-4000-8000-000000000101',
          contractNumber: 'CHK-1-2026',
          signedAt: '2026-01-15T10:00:00.000Z',
          signedTypedName: 'Senior Dev',
          signedIp: '192.168.1.1',
          templateRole: 'SENIOR',
          templateVersion: 1,
          bodyMarkdownSnapshot: '# MSA Contract\n\nПодписал: Senior Dev',
        },
        {
          type: 'tos',
          id: 'a0000000-0000-4000-8000-000000000102',
          acceptedAt: '2026-01-10T08:00:00.000Z',
          acceptedIp: '10.0.0.1',
          tosVersion: 1,
          tosBodyMarkdown: '# Terms of Service v1\n\nAll rights reserved.',
        },
      ],
      total: 2,
    }),
  )
}

// ---------------------------------------------------------------------------
// Custom fixture types
// ---------------------------------------------------------------------------
type Fixtures = {
  asAdmin: Page
  asSenior: Page
  asHr: Page
  asJunior: Page
  /** Drop role - phase 1: DROP-authenticated page for AC8 RBAC sweep. */
  asDrop: Page
}

export const test = base.extend<Fixtures>({
  asAdmin: async ({ page }, use) => {
    await mockAuthAs(page, USERS.admin)
    await use(page)
  },
  asSenior: async ({ page }, use) => {
    await mockAuthAs(page, USERS.senior)
    await use(page)
  },
  asHr: async ({ page }, use) => {
    await mockAuthAs(page, USERS.hr)
    await use(page)
  },
  asJunior: async ({ page }, use) => {
    await mockAuthAs(page, USERS.junior)
    await use(page)
  },
  asDrop: async ({ page }, use) => {
    await mockAuthAs(page, USERS.drop)
    await use(page)
  },
})

export { expect }

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export async function waitForPageReady(page: Page) {
  await page.waitForLoadState('networkidle')
}

export async function dismissDialog(page: Page) {
  await page.getByRole('button', { name: 'Отмена' }).click()
}

// ---------------------------------------------------------------------------
// Real-API helpers (task-expand-drop-e2e-coverage)
// ---------------------------------------------------------------------------
//
// These helpers hit the *real* NestJS backend (no Playwright route mocks).
// Used by `drop-archive-real.spec.ts` and siblings to exercise the actual
// `/api/users/drops`, `/api/teams/:id`, etc. — so the test catches backend
// regressions that mock-based specs silently mask.
//
// They expect a running backend at `http://localhost:3001` and the dev seed
// applied (CI workflow runs `pnpm --filter @crm/api db:migrate && db:seed`
// before `pnpm --filter @crm/e2e test`). For local runs, `pnpm dev` + dev
// login work the same way (`auth.controller.devLogin` gates on NODE_ENV).
//
// Authentication: `loginViaApi` POSTs to `/api/auth/dev-login` and Playwright's
// request context shares cookies with the browser, so a subsequent
// `page.goto('/crm/...')` is authenticated.

/** Backend HTTP origin used by the real-API helpers. */
const REAL_API_BASE = 'http://localhost:3001'

/**
 * Seed ADMIN email used by the dev seed. Hardcoded here to keep the
 * fixtures file self-contained — kept in sync with `apps/api/src/database/seed.ts`.
 */
export const SEED_ADMIN_EMAIL = 'yaremenkomaksym99@gmail.com'

/**
 * Seed JUNIOR/HR/SENIOR/ACCOUNTANT emails used by the dev seed.
 * Mirror of `SEED_USERS` in `apps/api/src/database/seed.ts`.
 */
export const SEED_EMAILS = {
  admin: 'yaremenkomaksym99@gmail.com',
  seniorA: 'oleksiy.kovalenko@cheekycheese.dev',
  seniorB: 'dmytro.marchenko@cheekycheese.dev',
  juniorA: 'sofia.bondarenko@cheekycheese.dev',
  juniorB: 'ivan.petrenko@cheekycheese.dev',
  hrA: 'anna.lysenko@cheekycheese.dev',
  hrB: 'kateryna.shevchenko@cheekycheese.dev',
  accountant: 'mykola.savchenko@cheekycheese.dev',
} as const

/** A valid USDT ERC-20 address used as required-requisite payload filler. */
export const VALID_USDT_WALLET = '0x' + '0'.repeat(40)

/**
 * Hardcoded partner UUIDs — duplicated from `packages/shared/src/schemas/index.ts`
 * because the e2e package deliberately doesn't depend on `@crm/shared` (keeps
 * the test runner independent of the workspace build pipeline). These two
 * IDs are environment-stable (seeded by `apps/api/src/database/seed.ts`),
 * so the duplication is benign — a CI guard catches drift if the seed ever
 * changes.
 */
export const MAKSYM_ID = '00000000-0000-0000-0000-000000000001'
export const KOSTYA_ID = '00000000-0000-0000-0000-000000000002'

/**
 * Plant a real JWT cookie for the given email via `/api/auth/dev-login`.
 *
 * Throws if the backend isn't reachable or rejects the login — real-API
 * specs must surface that loudly so the suite fails fast instead of
 * silently running unauthenticated.
 */
export async function loginViaApi(page: Page, email: string): Promise<void> {
  const res = await page.request.post(`${REAL_API_BASE}/api/auth/dev-login`, {
    data: { email },
  })
  if (res.status() !== 200 && res.status() !== 201) {
    throw new Error(`dev-login failed for ${email}: HTTP ${res.status()} — ${await res.text()}`)
  }
}

/**
 * Resolve a seed user by email through GET /api/users. Returns `null` if
 * the user isn't found. Useful when a test needs the seed HR / accountant
 * UUIDs to build a CreateDropDto payload.
 */
export async function findUserByEmailViaApi(
  page: Page,
  email: string,
): Promise<{ id: string; displayName: string; role: string } | null> {
  const res = await page.request.get(`${REAL_API_BASE}/api/users`)
  if (res.status() !== 200) return null
  const users = (await res.json()) as Array<{
    id: string
    email: string
    displayName: string
    role: string
  }>
  const found = users.find((u) => u.email === email)
  return found ? { id: found.id, displayName: found.displayName, role: found.role } : null
}

/**
 * Create a DROP user + drop-team via POST /api/users/drops.
 *
 * Pre-conditions:
 *   - Caller is logged in as ADMIN via `loginViaApi(page, SEED_EMAILS.admin)`.
 *   - The HR / accountant referenced by `hrEmails` / `accountantEmail` exist
 *     in the DB (seed users by default).
 *
 * Returns the created drop user + team id. The team is provisioned with
 * the DROP user as a member; HR/Accountant added per the payload; no
 * SENIOR attached (use `addSeniorToDropTeamViaAPI` for that).
 */
export async function createDropViaAPI(
  page: Page,
  opts: {
    email: string
    displayName: string
    hrEmails?: string[]
    accountantEmail?: string
    dropSharePercent?: number
    telegramChannel?: string | null
  },
): Promise<{ dropId: string; teamId: string; email: string }> {
  const hrEmails = opts.hrEmails ?? [SEED_EMAILS.hrA]
  const accountantEmail = opts.accountantEmail ?? SEED_EMAILS.accountant

  const hrIds: string[] = []
  for (const e of hrEmails) {
    const u = await findUserByEmailViaApi(page, e)
    if (!u) throw new Error(`HR seed user not found: ${e}`)
    hrIds.push(u.id)
  }
  const accountant = await findUserByEmailViaApi(page, accountantEmail)
  if (!accountant) throw new Error(`Accountant seed user not found: ${accountantEmail}`)

  const payload = {
    email: opts.email,
    displayName: opts.displayName,
    paymentMethod: 'USDT_ERC20' as const,
    walletUsdtErc20: VALID_USDT_WALLET,
    hrIds,
    accountantId: accountant.id,
    ...(opts.dropSharePercent !== undefined && { dropSharePercent: opts.dropSharePercent }),
    ...(opts.telegramChannel !== undefined && { telegramChannel: opts.telegramChannel }),
  }

  const res = await page.request.post(`${REAL_API_BASE}/api/users/drops`, {
    data: payload,
  })
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(
      `createDropViaAPI failed for ${opts.email}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  const body = (await res.json()) as {
    user: { id: string; email: string }
    teamId?: string
    team?: { id: string }
  }
  // Service returns `{ user, teamId }`; some clients (UserDialog) read
  // `team.id`. Accept both shapes defensively.
  const teamId = body.teamId ?? body.team?.id
  if (!teamId) {
    throw new Error(`createDropViaAPI response missing teamId/team.id: ${JSON.stringify(body)}`)
  }
  return { dropId: body.user.id, teamId, email: body.user.email }
}

/**
 * Add a SENIOR to an existing drop-team via POST /api/teams/:id/members.
 *
 * Used by AC1 to plant a senior on the team before archiving, so the test
 * can assert that the senior is *detached* (leftAt set) without being archived.
 */
export async function addSeniorToDropTeamViaAPI(
  page: Page,
  teamId: string,
  opts: { seniorEmail?: string } = {},
): Promise<{ seniorId: string }> {
  const seniorEmail = opts.seniorEmail ?? SEED_EMAILS.seniorA
  const senior = await findUserByEmailViaApi(page, seniorEmail)
  if (!senior) throw new Error(`Senior seed user not found: ${seniorEmail}`)
  const res = await page.request.post(`${REAL_API_BASE}/api/teams/${teamId}/members`, {
    data: { userId: senior.id },
  })
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`addSeniorToDropTeamViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  return { seniorId: senior.id }
}

/**
 * Archive a drop-team via DELETE /api/teams/:id (the contract enforced
 * by the team-detail UI «Архивировать» button after the round-2 backend
 * fix). Used by tests that need to skip the UI dialog and just plant
 * archived state.
 */
export async function archiveDropTeamViaAPI(page: Page, teamId: string): Promise<void> {
  const res = await page.request.delete(`${REAL_API_BASE}/api/teams/${teamId}`)
  if (res.status() !== 200 && res.status() !== 204) {
    throw new Error(
      `archiveDropTeamViaAPI failed for team ${teamId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
}

/** Fetch a team by id via GET /api/teams/:id — returns the parsed body. */
export async function getTeamViaAPI(
  page: Page,
  teamId: string,
): Promise<{
  id: string
  name: string
  type: string
  archivedAt: string | null
  members: Array<{ userId: string; role: string; leftAt: string | null }>
}> {
  const res = await page.request.get(`${REAL_API_BASE}/api/teams/${teamId}`)
  if (res.status() !== 200) {
    throw new Error(`GET /api/teams/${teamId} failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  return (await res.json()) as Awaited<ReturnType<typeof getTeamViaAPI>>
}

/** Fetch a user by id via GET /api/users/:id — returns the user shell. */
export async function getUserViaAPI(
  page: Page,
  userId: string,
): Promise<{ id: string; email: string; role: string; archivedAt: string | null }> {
  const res = await page.request.get(`${REAL_API_BASE}/api/users/${userId}`)
  if (res.status() !== 200) {
    throw new Error(`GET /api/users/${userId} failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  const body = (await res.json()) as {
    user: { id: string; email: string; role: string; archivedAt: string | null }
  }
  return body.user
}

/**
 * Fetch projects filtered by `?dropId=` via GET /api/projects (real-API
 * branch — backend may not expose this exact filter; in that case the
 * helper falls back to listing all archived projects and filtering by
 * dropId client-side).
 */
export async function getDropProjectsViaAPI(
  page: Page,
  dropId: string,
): Promise<Array<{ id: string; dropId: string | null; archivedAt: string | null }>> {
  // Round 5: projects list takes `?archived=true|false`. Fetch both and
  // filter by dropId client-side — the backend doesn't expose a `?dropId`
  // filter in the public route.
  const [activeRes, archivedRes] = await Promise.all([
    page.request.get(`${REAL_API_BASE}/api/projects`),
    page.request.get(`${REAL_API_BASE}/api/projects?archived=true`),
  ])
  const active =
    activeRes.status() === 200
      ? ((await activeRes.json()) as Array<{
          id: string
          dropId: string | null
          archivedAt: string | null
        }>)
      : []
  const archived =
    archivedRes.status() === 200
      ? ((await archivedRes.json()) as Array<{
          id: string
          dropId: string | null
          archivedAt: string | null
        }>)
      : []
  return [...active, ...archived].filter((p) => p.dropId === dropId)
}

/**
 * Cleanup helper — archive the drop (cascade-archives the team + projects)
 * to leave the DB clean between tests. Idempotent: silently ignores
 * 4xx errors when the drop is already archived or missing.
 */
export async function cleanupDropViaAPI(page: Page, dropId: string): Promise<void> {
  await page.request.delete(`${REAL_API_BASE}/api/users/drops/${dropId}`).catch(() => undefined)
}

// ---------------------------------------------------------------------------
// Phase 2 real-API helpers (task-drop-phase2-e2e — AC1)
// ---------------------------------------------------------------------------
//
// These helpers extend the Phase 1 real-API surface to cover the Phase 2
// distribution flow:
//   - createDropProjectViaAPI — POST /api/projects with `dropId` set; the
//     backend marks the project as a drop-project and `payPayoutRequest`
//     routes its income through `computeDropDistribution`.
//   - createDropIncomeViaAPI — POST /api/transactions/drop-income; only the
//     DROP user routed by `project.dropId` may call this. Inserts a PENDING
//     DROP_INCOME row.
//   - validateTransactionViaAPI — PATCH /api/transactions/:id/validate;
//     ACCOUNTANT/ADMIN-only. Flips DROP_INCOME→VALIDATED, creates the
//     payout_request + placeholder PAYOUT row. The drop distribution math
//     fires later when `payPayoutRequest` is called.
//
// All helpers expect a real backend (CI seeds + migrations) and the caller
// is responsible for `loginViaApi(page, ...)` before invoking. They throw on
// any non-2xx response so tests fail fast.

/**
 * Create a project via POST /api/projects with an explicit `dropId`.
 *
 * Caller must be ADMIN-authenticated. The senior referenced by
 * `seniorEmail` and the drop by `dropId` must already exist in DB.
 *
 * Defaults:
 *   - rate: 5000
 *   - currency: 'USDT'
 *   - domain: 'AI / ML'
 *   - startDate: now (ISO)
 *   - companyName: 'Drop Phase 2 Co'
 *
 * Returns the created project id + dropId for downstream assertions.
 */
export async function createDropProjectViaAPI(
  page: Page,
  opts: {
    dropId: string
    seniorEmail?: string
    name?: string
    companyName?: string
    rate?: number
    currency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
    domain?: string
    startDate?: string
    seniorSharePercentOverride?: number | null
  },
): Promise<{ projectId: string; dropId: string; seniorId: string }> {
  const seniorEmail = opts.seniorEmail ?? SEED_EMAILS.seniorA
  const senior = await findUserByEmailViaApi(page, seniorEmail)
  if (!senior) throw new Error(`Senior seed user not found: ${seniorEmail}`)

  const payload = {
    name: opts.name ?? `Drop Phase 2 Project ${Date.now()}`,
    companyName: opts.companyName ?? 'Drop Phase 2 Co',
    domain: opts.domain ?? 'AI / ML',
    seniorId: senior.id,
    dropId: opts.dropId,
    rate: opts.rate ?? 5000,
    currency: opts.currency ?? 'USDT',
    startDate: opts.startDate ?? new Date().toISOString(),
    ...(opts.seniorSharePercentOverride !== undefined && {
      seniorSharePercentOverride: opts.seniorSharePercentOverride,
    }),
  }

  const res = await page.request.post(`${REAL_API_BASE}/api/projects`, { data: payload })
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`createDropProjectViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  const body = (await res.json()) as { id: string; dropId: string | null; seniorId: string }
  if (!body.dropId) {
    throw new Error(`Created project missing dropId: ${JSON.stringify(body)}`)
  }
  return { projectId: body.id, dropId: body.dropId, seniorId: body.seniorId }
}

/**
 * Create a regular SENIOR project (no dropId) via POST /api/projects.
 *
 * Mirror of `createDropProjectViaAPI` but omits `dropId` entirely — the
 * backend treats this as a regression-safe senior-project. Used by the
 * regression spec to assert that NO PAYOUT_DROP rows are produced.
 */
export async function createSeniorProjectViaAPI(
  page: Page,
  opts: {
    seniorEmail?: string
    name?: string
    companyName?: string
    rate?: number
    currency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
    domain?: string
    startDate?: string
  } = {},
): Promise<{ projectId: string; seniorId: string }> {
  const seniorEmail = opts.seniorEmail ?? SEED_EMAILS.seniorA
  const senior = await findUserByEmailViaApi(page, seniorEmail)
  if (!senior) throw new Error(`Senior seed user not found: ${seniorEmail}`)

  const payload = {
    name: opts.name ?? `Senior Regression Project ${Date.now()}`,
    companyName: opts.companyName ?? 'Senior Regression Co',
    domain: opts.domain ?? 'AI / ML',
    seniorId: senior.id,
    rate: opts.rate ?? 5000,
    currency: opts.currency ?? 'USDT',
    startDate: opts.startDate ?? new Date().toISOString(),
  }

  const res = await page.request.post(`${REAL_API_BASE}/api/projects`, { data: payload })
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`createSeniorProjectViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  const body = (await res.json()) as { id: string; seniorId: string }
  return { projectId: body.id, seniorId: body.seniorId }
}

/**
 * Insert a DROP_INCOME row via POST /api/transactions/drop-income.
 *
 * Caller must be DROP-authenticated and the project must be routed
 * through them (`project.dropId === drop.id`). The row lands in PENDING
 * until an ACCOUNTANT/ADMIN validates it (see `validateTransactionViaAPI`).
 *
 * Defaults:
 *   - amount: 1000
 *   - currency: 'USDT'
 *   - receiptExternalUrl: 'https://drive.example.com/drop-receipt.pdf'
 *     (DROP_INCOME requires a receipt — same XOR rule as SENIOR_INCOME).
 */
export async function createDropIncomeViaAPI(
  page: Page,
  opts: {
    projectId: string
    amount?: number
    currency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
    receiptExternalUrl?: string
    receiptDocumentId?: string
    notes?: string | null
    txDate?: string | null
  },
): Promise<{ txId: string; status: string; amount: string }> {
  const payload = {
    projectId: opts.projectId,
    amount: opts.amount ?? 1000,
    currency: opts.currency ?? 'USDT',
    ...(opts.receiptDocumentId
      ? { receiptDocumentId: opts.receiptDocumentId }
      : {
          receiptExternalUrl:
            opts.receiptExternalUrl ?? 'https://drive.example.com/drop-receipt.pdf',
        }),
    ...(opts.notes !== undefined && { notes: opts.notes }),
    ...(opts.txDate !== undefined && { txDate: opts.txDate }),
  }
  const res = await page.request.post(`${REAL_API_BASE}/api/transactions/drop-income`, {
    data: payload,
  })
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`createDropIncomeViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  const body = (await res.json()) as { id: string; status: string; amount: string }
  return { txId: body.id, status: body.status, amount: body.amount }
}

/**
 * Insert a SENIOR_INCOME row via POST /api/transactions/senior-income.
 *
 * Mirror of `createDropIncomeViaAPI` for the senior path. Required by
 * the regression spec which exercises the legacy senior distribution
 * branch end-to-end and asserts NO PAYOUT_DROP rows are produced.
 */
export async function createSeniorIncomeViaAPI(
  page: Page,
  opts: {
    projectId: string
    amount?: number
    currency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
    receiptExternalUrl?: string
    receiptDocumentId?: string
    notes?: string | null
    txDate?: string | null
  },
): Promise<{ txId: string; status: string; amount: string }> {
  const payload = {
    projectId: opts.projectId,
    amount: opts.amount ?? 1000,
    currency: opts.currency ?? 'USDT',
    ...(opts.receiptDocumentId
      ? { receiptDocumentId: opts.receiptDocumentId }
      : {
          receiptExternalUrl:
            opts.receiptExternalUrl ?? 'https://drive.example.com/senior-receipt.pdf',
        }),
    ...(opts.notes !== undefined && { notes: opts.notes }),
    ...(opts.txDate !== undefined && { txDate: opts.txDate }),
  }
  const res = await page.request.post(`${REAL_API_BASE}/api/transactions/senior-income`, {
    data: payload,
  })
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`createSeniorIncomeViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  const body = (await res.json()) as { id: string; status: string; amount: string }
  return { txId: body.id, status: body.status, amount: body.amount }
}

/**
 * Validate a PENDING SENIOR_INCOME/DROP_INCOME via PATCH /api/transactions/:id/validate.
 *
 * Caller must be ADMIN or ACCOUNTANT. The backend:
 *   1. Flips income status PENDING → VALIDATED.
 *   2. Creates a payout_request row.
 *   3. Inserts the placeholder PAYOUT row (PENDING_PAYMENT).
 *
 * The actual distribution math (PAYOUT_DROP + PAYOUT_ADMIN inserts) does
 * NOT happen here — those are created by `payPayoutRequest`. Callers
 * must invoke `payPayoutRequestViaAPI` to trigger distribution.
 */
export async function validateTransactionViaAPI(
  page: Page,
  txId: string,
): Promise<{ payoutRequestId: string | null }> {
  const res = await page.request.patch(`${REAL_API_BASE}/api/transactions/${txId}/validate`, {
    data: { action: 'validate' },
  })
  if (res.status() !== 200) {
    throw new Error(
      `validateTransactionViaAPI failed for ${txId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  const body = (await res.json()) as { payoutRequestId: string | null }
  return { payoutRequestId: body.payoutRequestId ?? null }
}

/**
 * Mark a PENDING payout_request as PAID via PATCH /api/payout-requests/:id/pay.
 *
 * Caller must be SENIOR or DROP (the seniorId/dropId on the payout_request
 * must match the caller). The backend inserts the distribution transactions
 * (PAYOUT_DROP + 2× PAYOUT_ADMIN for drop-projects, 2× PAYOUT_ADMIN for
 * senior-projects).
 *
 * Uses the dev simulate=success path so we don't need a real on-chain hash.
 */
export async function payPayoutRequestViaAPI(
  page: Page,
  payoutRequestId: string,
): Promise<{ status: string; txHash: string | null }> {
  // The pay endpoint runs the distribution cascade inside a long-running
  // transaction (multiple INSERTs + UPDATEs). Bump the per-request timeout
  // so we don't trip Playwright's default 30s/8s deadlines on busy CI.
  const res = await page.request.patch(
    `${REAL_API_BASE}/api/payout-requests/${payoutRequestId}/pay`,
    { data: { simulateResult: 'success' }, timeout: 60_000 },
  )
  // Backlog AC4 fix: the `payPayoutRequest` endpoint now returns 200 for
  // both SENIOR and DROP — `findPayoutRequest` was widened to let DROP read
  // their OWN payout_request (matching the SENIOR rule). Anything other
  // than 200 here is a real error.
  if (res.status() !== 200) {
    throw new Error(
      `payPayoutRequestViaAPI failed for ${payoutRequestId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  const body = (await res.json()) as { status: string; txHash: string | null }
  return { status: body.status, txHash: body.txHash }
}

/**
 * List a payout_request's transactions (full join) via
 * GET /api/payout-requests/:id. The payout_request endpoint surfaces every
 * transaction linked via `payout_request_id`, which is what tests need for
 * distribution assertions.
 *
 * Historical context (backlog AC5): PAYOUT_ADMIN rows for senior-projects
 * used to be inserted WITHOUT `projectId`, which meant a `?projectId=` filter
 * missed them — this helper was the workaround. The cascade now sets
 * `projectId` on every PAYOUT_ADMIN row (both drop and senior branches), so
 * `listTransactionsByProjectViaAPI` is also viable. This helper stays around
 * because it's still the simplest path to fetch a single payout's rows in
 * deterministic order.
 *
 * Caller must be ADMIN/ACCOUNTANT to view another user's payout request.
 * SENIOR/DROP callers can fetch their OWN payout requests (per
 * `findPayoutRequest` RBAC widened in backlog AC4).
 */
export async function listPayoutRequestTransactionsViaAPI(
  page: Page,
  payoutRequestId: string,
): Promise<
  Array<{
    id: string
    type: string
    status: string
    amount: string
    receiverId: string | null
    recipientId: string | null
    projectId: string | null
  }>
> {
  const res = await page.request.get(`${REAL_API_BASE}/api/payout-requests/${payoutRequestId}`)
  if (res.status() !== 200) {
    throw new Error(
      `listPayoutRequestTransactionsViaAPI failed for ${payoutRequestId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  const body = (await res.json()) as {
    transactions: Array<{
      id: string
      type: string
      status: string
      amount: string
      receiverId: string | null
      recipientId: string | null
      projectId: string | null
    }>
  }
  return body.transactions
}

/**
 * List ALL transactions for a project via GET /api/transactions?projectId=
 * — used by Phase 2 specs to assert the post-payout transaction set
 * (PAYOUT/PAYOUT_DROP/PAYOUT_ADMIN amounts and types).
 *
 * The caller must be authenticated as ADMIN or ACCOUNTANT for the full
 * unfiltered list — SENIOR/DROP-scoped callers will receive a subset
 * (their own send/receive only) per the RBAC rules in TransactionsService.
 *
 * Backlog AC5 (resolved): PAYOUT_ADMIN rows for senior-projects now carry
 * `projectId` (cascade was updated to insert it explicitly), so the
 * `?projectId=` filter captures them on both drop and senior flows. The
 * legacy workaround (`listPayoutRequestTransactionsViaAPI`) is still useful
 * when you want a single payout's rows in order.
 */
export async function listTransactionsByProjectViaAPI(
  page: Page,
  projectId: string,
): Promise<
  Array<{
    id: string
    type: string
    status: string
    amount: string
    senderId: string | null
    receiverId: string | null
    recipientId: string | null
    projectId: string | null
  }>
> {
  const res = await page.request.get(`${REAL_API_BASE}/api/transactions?projectId=${projectId}`)
  if (res.status() !== 200) {
    throw new Error(
      `listTransactionsByProjectViaAPI failed for ${projectId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  return (await res.json()) as Awaited<ReturnType<typeof listTransactionsByProjectViaAPI>>
}

/**
 * Update a user's senior_share_percent or drop_share_percent via PATCH
 * /api/users/:id. ADMIN-only — callers must `loginViaApi(page, admin)` first.
 *
 * Used by AC3 edge-case tests to flip a seed senior to e.g. 50% / 60% / 0%
 * for distribution math assertions. Pass `dropSharePercent` to override
 * the drop's share simultaneously.
 *
 * NOTE: This mutates a seed user! Tests that use this helper should either
 *   (a) restore the original percent in a finally{} block, or
 *   (b) use a freshly-created throwaway senior — best for parallel runs.
 * AC3 picks (b) where possible by using a different seed senior per test.
 */
export async function patchUserSharePercentViaAPI(
  page: Page,
  userId: string,
  opts: { seniorSharePercent?: number; dropSharePercent?: number },
): Promise<void> {
  const data: Record<string, number> = {}
  if (opts.seniorSharePercent !== undefined) data.seniorSharePercent = opts.seniorSharePercent
  if (opts.dropSharePercent !== undefined) data.dropSharePercent = opts.dropSharePercent
  const res = await page.request.patch(`${REAL_API_BASE}/api/users/${userId}`, { data })
  if (res.status() !== 200) {
    throw new Error(
      `patchUserSharePercentViaAPI failed for ${userId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
}

/**
 * Fetch a single transaction by id via GET /api/transactions/:id. Used
 * by helpers that need to read the status mutation after validation/pay.
 */
export async function getTransactionViaAPI(
  page: Page,
  txId: string,
): Promise<{
  id: string
  type: string
  status: string
  amount: string
  payoutRequestId: string | null
}> {
  const res = await page.request.get(`${REAL_API_BASE}/api/transactions/${txId}`)
  if (res.status() !== 200) {
    throw new Error(
      `getTransactionViaAPI failed for ${txId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  return (await res.json()) as Awaited<ReturnType<typeof getTransactionViaAPI>>
}

// ---------------------------------------------------------------------------
// Phase 3 real-API helpers (task-drop-phase3-e2e — AC1)
// ---------------------------------------------------------------------------
//
// Manual payout confirmation flow — ACCOUNTANT/ADMIN selects which admin
// partner actually received the off-platform PAYOUT. Backend (spec §8.4):
//   1) Flips PAYOUT row PENDING_PAYMENT → PAID + records validatedBy/At.
//   2) Inserts a fresh PAYOUT_CONFIRMED row crediting the chosen admin.
//
// Phase 2 auto-50/50 PAYOUT_ADMIN distribution is NOT replaced — the manual
// flow runs in parallel as a safety-net / audit-trail for the actual on-chain
// recipient. These helpers let tests trigger the endpoint without UI clicks
// (for RBAC sweeps and edge-case probes).

/**
 * Confirm a PAYOUT via POST /api/transactions/:id/confirm-payout.
 *
 * Pre-conditions:
 *   - Caller is ADMIN or ACCOUNTANT (anyone else → 403).
 *   - `payoutTxId` references a row with type=PAYOUT, status=PENDING_PAYMENT.
 *   - `recipientAdminId` is an active (non-archived) ADMIN — pass
 *     `MAKSYM_ID` or `KOSTYA_ID` for the seed partners.
 *
 * Returns the parsed `{ payout, confirmed }` body (matches the controller
 * response shape — `confirmed` may be `null` if the post-write lookup races
 * a transaction commit, but the cascade itself is atomic).
 *
 * Throws on any non-2xx response so tests surface backend regressions loudly.
 * Use `confirmPayoutRawViaAPI` below when the spec needs to assert a specific
 * non-2xx status (RBAC 403, validation 400).
 */
export async function confirmPayoutViaAPI(
  page: Page,
  payoutTxId: string,
  recipientAdminId: string,
): Promise<{
  payout: { id: string; status: string; validatedBy: string | null; validatedAt: string | null }
  confirmed: {
    id: string
    type: string
    status: string
    amount: string
    recipientId: string | null
    receiverId: string | null
    projectId: string | null
  } | null
}> {
  // Phase 4 refactor (AC4): confirmPayout now requires a payment method.
  // Tests don't care about the method semantics, so default to CASH which
  // doesn't need a real txHash. RBAC/edge specs override status assertions
  // anyway.
  const res = await page.request.post(
    `${REAL_API_BASE}/api/transactions/${payoutTxId}/confirm-payout`,
    { data: { recipientAdminId, method: 'CASH' } },
  )
  if (res.status() !== 200 && res.status() !== 201) {
    throw new Error(
      `confirmPayoutViaAPI failed for ${payoutTxId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  return (await res.json()) as Awaited<ReturnType<typeof confirmPayoutViaAPI>>
}

/**
 * Raw variant of `confirmPayoutViaAPI` — does NOT throw on non-2xx.
 *
 * Returns the HTTP status + parsed body (best-effort, falls back to text).
 * Used by RBAC + edge-case specs that need to assert "this role gets 403"
 * or "wrong tx type → 400 with backend message".
 */
export async function confirmPayoutRawViaAPI(
  page: Page,
  payoutTxId: string,
  recipientAdminId: string,
): Promise<{ status: number; body: unknown }> {
  // Phase 4 refactor (AC4): same method=CASH default as above so RBAC tests
  // still hit the RBAC branch (which runs before the method check).
  const res = await page.request.post(
    `${REAL_API_BASE}/api/transactions/${payoutTxId}/confirm-payout`,
    { data: { recipientAdminId, method: 'CASH' } },
  )
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = await res.text()
  }
  return { status: res.status(), body }
}

/**
 * Find PENDING_PAYMENT PAYOUT rows for a given project via
 * GET /api/transactions?projectId=. Returns the filtered array — empty if no
 * payouts are pending (e.g. the cascade hasn't fired yet, or the row was
 * already confirmed).
 *
 * The endpoint returns the full transaction shape; we re-read raw JSON here
 * (instead of casting `listTransactionsByProjectViaAPI`'s narrower type) so
 * the spec assertions get `payoutRequestId` + `currency` directly, which the
 * Phase 3 helpers actually use.
 *
 * Caller must be ADMIN or ACCOUNTANT to see the full unfiltered list. Other
 * roles get a partial slice per RBAC and may miss PAYOUT rows.
 */
export async function findPendingPayoutsForProjectViaAPI(
  page: Page,
  projectId: string,
): Promise<
  Array<{
    id: string
    type: string
    status: string
    amount: string
    currency: string
    senderId: string | null
    receiverId: string | null
    recipientId: string | null
    projectId: string | null
    payoutRequestId: string | null
  }>
> {
  const res = await page.request.get(`${REAL_API_BASE}/api/transactions?projectId=${projectId}`)
  if (res.status() !== 200) {
    throw new Error(
      `findPendingPayoutsForProjectViaAPI failed for ${projectId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  const rows = (await res.json()) as Array<{
    id: string
    type: string
    status: string
    amount: string
    currency: string
    senderId: string | null
    receiverId: string | null
    recipientId: string | null
    projectId: string | null
    payoutRequestId: string | null
  }>
  return rows.filter((t) => t.type === 'PAYOUT' && t.status === 'PENDING_PAYMENT')
}
