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
    telegram: null,
    notes: null,
    createdAt: '2024-01-10T00:00:00.000Z',
    updatedAt: '2024-01-10T00:00:00.000Z',
    members: [
      toMember(USERS.hr),
      toMember(USERS.senior),
      toMember(USERS.accountant),
      toMember(EXTRA_ACCOUNTANT),
    ],
  },
]

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
  }
}

/** Full admin viewing anyone: all tabs + all actions */
export function buildAdminViewingUser(
  targetUser: (typeof USERS)[keyof typeof USERS],
): object {
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
export function buildHrViewingSenior(
  senior: (typeof USERS)[keyof typeof USERS],
): object {
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
export function buildJuniorViewingJunior(
  targetUser: (typeof USERS)[keyof typeof USERS],
): object {
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
export function buildSelfView(
  user: (typeof USERS)[keyof typeof USERS],
): object {
  // Mirrors users-access.service.ts isSelf branch.
  // SENIOR: interviews surfaced via header link, not tab.
  const tabs: string[] = ['overview', 'projects', 'team', 'requisites', 'documents']
  if (
    user.role === 'SENIOR' ||
    user.role === 'JUNIOR' ||
    user.role === 'HR' ||
    user.role === 'ACCOUNTANT'
  ) {
    tabs.push('finance')
  }

  const isSalaryRole = user.role === 'JUNIOR' || user.role === 'HR' || user.role === 'ACCOUNTANT'
  const isShareRole = user.role === 'SENIOR' || user.role === 'ADMIN'

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
export async function mockAuthAs(
  page: Page,
  user: (typeof USERS)[keyof typeof USERS],
) {
  // All routes use the exact API base (localhost:3001/api) to avoid
  // intercepting Vite page navigation requests (localhost:3000).

  // Auth
  await page.route(`${API}/auth/me`, (r) => jsonOk(r, user))
  await page.route(`${API}/auth/logout`, (r) => noContent(r))

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
      { id: USERS.hr.id, displayName: USERS.hr.displayName, role: 'HR', avatarUrl: null, avatarDocumentId: null },
      { id: USERS.accountant.id, displayName: USERS.accountant.displayName, role: 'ACCOUNTANT', avatarUrl: null, avatarDocumentId: null },
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
  // /users — supports `?archived=true|false` filter
  await page.route(new RegExp(`${API}/users(\\?.*)?$`), (r) => {
    if (r.request().method() === 'POST') {
      return jsonOk(r, { ...USERS.junior, id: 'new-user-id', ...(JSON.parse(r.request().postData() ?? '{}') as object) }, 201)
    }
    const url = new URL(r.request().url())
    const archived = url.searchParams.get('archived') === 'true'
    // For the mock: archived list is empty unless explicitly testing archived flows
    return jsonOk(r, archived ? [] : ALL_USERS)
  })

  // Teams
  await page.route(new RegExp(`${API}/teams/([^/?]+)/members`), (r) =>
    r.request().method() === 'DELETE' ? noContent(r) : jsonOk(r, TEAMS[0], 201),
  )
  await page.route(new RegExp(`${API}/teams/([^/?]+)$`), (r) => {
    const teamId = r.request().url().split('/').at(-1)
    const team = TEAMS.find(t => t.id === teamId) || TEAMS[0]
    
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
      return jsonOk(r, PROJECTS.filter((p) => p.archivedAt !== null))
    }
    return jsonOk(r, PROJECTS.filter((p) => p.archivedAt === null))
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
  await page.route(new RegExp(`${API}/finance/junior-payments(\\?.*)?$`), (r) =>
    jsonOk(r, []),
  )
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
  await page.route(new RegExp(`${API}/finance/chart(/.*)?$`), (r) =>
    jsonOk(r, []),
  )
  await page.route(new RegExp(`${API}/finance/partner-balance(\\?.*)?$`), (r) =>
    jsonOk(r, {
      maksymSpentUsd: '6000.00',
      kostyaSpentUsd: '6000.00',
      debtUsd: '0.00',
      debtDirection: 'SETTLED',
    }),
  )
  await page.route(new RegExp(`${API}/finance/my-salary(\\?.*)?$`), (r) =>
    jsonOk(r, []),
  )
  await page.route(new RegExp(`${API}/finance/expenses/hints(\\?.*)?$`), (r) =>
    jsonOk(r, { projects: [], users: [] }),
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
  await page.route(new RegExp(`${API}/documents/([^/?]+)/thumbnail$`), (r) =>
    jsonOk(r, null),
  )
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
  await page.route(new RegExp(`${API}/documents/([^/?]+)/hard$`), (r) =>
    noContent(r),
  )
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
}

// ---------------------------------------------------------------------------
// Custom fixture types
// ---------------------------------------------------------------------------
type Fixtures = {
  asAdmin: Page
  asSenior: Page
  asHr: Page
  asJunior: Page
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
