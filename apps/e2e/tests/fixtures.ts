import { test as base, expect, type Page, type Route } from '@playwright/test'

// Re-exported so specs can take their Playwright types from the same barrel
// they already import `test` / `expect` / fixtures from. persist-query.spec.ts
// has imported `type Page` from here since it was written; the import was
// simply never valid (`Module './fixtures' declares 'Page' locally, but it is
// not exported`) and nothing ran `tsc` over this package to say so.
// (task-lint-teeth)
export type { Page, Route }

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
    // A3-4: legalFullName required for SignContractStep (server-side signature block)
    legalFullName: 'Oleksiy Kovalenko Mykolayovych',
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
    legalFullName: 'Ivan Petrenko Vasyliovych',
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
    legalFullName: 'Natalia Kovalchuk Ivanivna',
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
    legalFullName: 'Mykola Bondarenko Petrovych',
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
    legalFullName: 'Olha Drozdova Serhiivna',
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
  // the «У вас нет активной команды» banner on `/profile` and the
  // empty-state on `/projects` + `/interviews`.
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

/**
 * Build a team-member fixture row from any user-shaped fixture.
 *
 * Generic over the input rather than typed as `(typeof USERS)[keyof typeof USERS]`
 * (task-lint-teeth): that nominal union rejected `EXTRA_ACCOUNTANT` below, which
 * is a perfectly well-formed user fixture that simply does not live inside the
 * `USERS` object. The constraint states what this helper actually needs, and the
 * generic keeps each call's literal field types in the returned row.
 */
function toMember<
  T extends {
    id: string
    email: string
    displayName: string
    role: string
    avatarUrl: string | null
    avatarDocumentId: string | null
    techStack: string[] | null
  },
>(user: T, joinedAt = '2024-01-10T00:00:00.000Z') {
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
    // Annotated, not bare `null` (task-lint-teeth): both seed projects happen to
    // carry `null` here, so TS inferred the field's type as exactly `null` and
    // `Partial<(typeof PROJECTS)[number]>` — the override bag every spec helper
    // takes — became `null | undefined`. That made
    // `mockProjectDetail({ seniorSharePercentOverride: 30 })` a type error in
    // all 8 places projects-senior-share-override.spec.ts sets a real percent,
    // i.e. the entire point of that spec. `number | null` is the DTO's actual
    // type — this file already declares it that way at `seniorSharePercentOverride?:
    // number | null` in the drop-project options below.
    seniorSharePercentOverride: null as number | null,
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
    // Same reason as project-1-id above.
    seniorSharePercentOverride: null as number | null,
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
  // ADMIN viewing non-ADMIN: includes 'contract' tab (A3-2).
  // ADMIN viewing another ADMIN (self or peer): no 'contract' tab (ADMINs have no contracts).
  const contractTab = targetUser.role !== 'ADMIN' ? ['contract'] : []
  // task-resume-base §4: the resume tab exists ONLY on a SENIOR card. Mirrors
  // users-access.service.ts (`targetIsSenior && canSeeResumeTab(...)`), appended
  // last so no existing tab shifts position.
  const resumeTab = targetUser.role === 'SENIOR' ? ['resume'] : []
  // RBAC 2026-06-09: ADMIN can view+edit legend of SENIOR/DROP targets (subject excluded)
  const legendField =
    targetUser.role === 'SENIOR' || targetUser.role === 'DROP' ? { legend: true as const } : {}
  return {
    user: { ...targetUser, ...profileExtras(targetUser) },
    permissions: {
      tabs: [
        'overview',
        'finance',
        'projects',
        'team',
        'requisites',
        'documents',
        ...contractTab,
        ...resumeTab,
      ],
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
        ...legendField,
      },
    },
    data: {},
  }
}

/** HR viewing their own senior: overview + projects + team only, no actions.
 *  RBAC 2026-06-09: HR can view+edit legend of SENIOR/DROP in their team. */
export function buildHrViewingSenior(senior: (typeof USERS)[keyof typeof USERS]): object {
  const isLegendTarget = senior.role === 'SENIOR' || senior.role === 'DROP'
  // task-resume-base §4: HR maintains a senior's resume, so the tab is present
  // for a SENIOR target (mirrors users-access.service.ts).
  const resumeTab = senior.role === 'SENIOR' ? ['resume'] : []
  return {
    user: { ...senior, ...profileExtras(senior) },
    permissions: {
      tabs: ['overview', 'projects', 'team', ...resumeTab],
      actions: [],
      fields: {
        techStack: true,
        registrationDate: true,
        ...(isLegendTarget ? { legend: true as const } : {}),
      },
    },
    data: {},
  }
}

/** JUNIOR viewing their senior: overview only, no actions.
 *  RBAC 2026-06-09: JUNIOR can view+edit legend of their SENIOR/DROP. */
export function buildJuniorViewingSenior(senior: (typeof USERS)[keyof typeof USERS]): object {
  const isLegendTarget = senior.role === 'SENIOR' || senior.role === 'DROP'
  return {
    user: { ...senior, ...profileExtras(senior) },
    permissions: {
      tabs: ['overview', 'projects', 'team'],
      actions: [],
      fields: {
        techStack: true,
        registrationDate: true,
        ...(isLegendTarget ? { legend: true as const } : {}),
      },
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
  // Mirrors users-access.service.ts isSelf branch exactly.
  //
  // JUNIOR self-view is an EXPLICIT allow-list (data-privacy, task-junior-ut-round2 §3 +
  // PR #188 fixture-fidelity fix §6a): ONLY overview / requisites.
  // MUST NOT include documents / finance / projects / team — those surface senior
  // identity and project internals. Mirrors users-access.service.ts:84 exactly:
  //   tabs.push('overview', 'requisites')
  //
  // DROP: overview / finance / team / requisites / documents / contract.
  //   Mirrors users-access.service.ts isSelf branch (task-drop-phase3-frontend):
  //     tabs.push('overview', 'finance', 'team', 'requisites', 'documents', 'contract')
  //   NOTE: 'projects' removed — /routing hub is the canonical project surface
  //   for DROP. 'contract' added — DROP has a signed employee_contract and must see
  //   it in their own profile (UT finding 3a, drop-phase3-frontend round 2).
  //   Updated 2026-06-13 (PR #198 drop-phase3-frontend).
  //
  // Everyone else (SENIOR, HR, ACCOUNTANT, ADMIN):
  //   overview / projects / team / requisites / documents
  //   + finance for SENIOR / HR / ACCOUNTANT.
  let tabs: string[]
  if (user.role === 'JUNIOR') {
    // Explicit allow-list — no documents, no finance, no projects, no team.
    tabs = ['overview', 'requisites']
  } else if (user.role === 'DROP') {
    // task-drop-phase3-frontend: 'projects' excluded (routing hub is canonical),
    // 'contract' included (DROP views own signed contract).
    tabs = ['overview', 'finance', 'team', 'requisites', 'documents', 'contract']
  } else {
    tabs = ['overview', 'projects', 'team', 'requisites', 'documents']
    if (user.role === 'SENIOR' || user.role === 'HR' || user.role === 'ACCOUNTANT') {
      tabs.push('finance')
    }
    // task-resume-base §4: a SENIOR maintains their OWN resume, so their
    // self-view carries the tab. Appended last, mirroring users-access.service.
    if (user.role === 'SENIOR') tabs.push('resume')
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
// API route matching — origin-agnostic
// ---------------------------------------------------------------------------
//
// Playwright page.route() intercepts at the browser-fetch URL, NOT the
// final backend URL after any proxy rewrite.  The web app can run on
// different origins depending on the test environment:
//
//   CI / vite dev (:3000)    → browser fetches http://localhost:3001/api/*
//                               (axios VITE_API_URL=http://localhost:3001)
//   Local preview (:3010)    → browser fetches http://localhost:3010/api/*
//                               (same-origin, vite preview proxy rewrites)
//   Future: any other port   → origin varies
//
// Using a hardcoded origin (e.g. "http://localhost:3001") OR deriving it
// from PLAYWRIGHT_BASE_URL both break in at least one scenario.
//
// Fix: match on the URL *path* only, ignoring the origin.
//   • String routes  → use Playwright glob  `**/api/<path>` which matches
//     any host/port prefix followed by /api/<path>.
//   • RegExp routes  → replace `${API_RE}/path` with `/\\/api\\/path/`
//     which matches the path segment in the full URL string on any origin.
//
// NOTE: we deliberately do NOT match Vite page-navigation URLs (/...)
// because those never contain "/api/" as a path segment.
//
// API_GLOB — prefix for string-literal page.route() patterns.
//
// Exported (task-e2e-origin-agnostic) — this is the ONE canonical
// origin-agnostic prefix for the whole suite. Spec files that need to mock
// an endpoint via a plain-string `page.route()`/`page.unroute()` call MUST
// import this instead of declaring a local `const API = 'http://localhost:3001/api'`
// — a hardcoded origin only matches when the web app happens to be served
// from exactly that host:port (CI's baked-in `VITE_API_URL`), and silently
// never fires (no error, the route handler is simply never installed —
// `mockAuthAs`'s earlier, broader route wins instead) against a `vite preview`
// origin, a scratch port, or any other local setup.
export const API_GLOB = '**/api'
// API_RE — prefix for RegExp-based page.route() patterns.  A leading
// `\\/` anchors to the `/api/` path component without accidentally
// matching a hostname that contains "api" as a substring.
//
// Exported (task-e2e-origin-agnostic) — same rationale as API_GLOB above,
// for the `new RegExp(...)` call sites instead of plain-string ones.
export const API_RE = '\\/api'

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
  // All routes use origin-agnostic patterns (see API_GLOB / API_RE above)
  // so mocks match regardless of dev (:3001), preview (:3010), or CI.

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

  // Projects
  // task-junior-ux-2-hub: GET /projects/:id/hr-contact — allowlist DTO.
  // Must be registered BEFORE the generic /projects/:id$ route (LIFO: later wins).
  await page.route(new RegExp(`${API_RE}/projects/([^/?]+)/hr-contact$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return jsonOk(r, { displayName: null, telegram: null, phone: null })
  })
  await page.route(new RegExp(`${API_RE}/projects/([^/?]+)/members`), (r) =>
    r.request().method() === 'DELETE' ? noContent(r) : jsonOk(r, PROJECTS[0], 201),
  )
  await page.route(new RegExp(`${API_RE}/projects/([^/?]+)$`), (r) =>
    r.request().method() === 'DELETE'
      ? noContent(r)
      : jsonOk(r, { ...PROJECTS[0], ...(JSON.parse(r.request().postData() ?? '{}') as object) }),
  )
  // Round 5: honor the `?archived=true|false` filter so the new «Все/Активные/Архив»
  // tabs return the expected slice of fixture projects. PROJECTS[0] is active
  // (archivedAt = null) and PROJECTS[1] is archived (archivedAt = timestamp).
  await page.route(new RegExp(`${API_RE}/projects(\\?.*)?$`), (r) => {
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

  // Per-project credentials (PR #178). ProjectCredentialsSection mounts on
  // /project (JUNIOR hub) and /projects/$id (overview) and fires
  // GET /api/projects/:id/credentials. Unmocked → 401 → axios interceptor →
  // /login (same failure mode as legend/documents mocks above).
  // Default: empty list []. Specs that need real data register their own
  // handler AFTER mockAuthAs (LIFO) so it wins.
  // reveal/:id sub-route registered first so the generic credentials$ doesn't swallow it.
  await page.route(new RegExp(`${API_RE}/projects/([^/?]+)/credentials/([^/?]+)/reveal$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    // Default reveal returns 200 with a placeholder — tests override per-credential.
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ password: 'mock-password' }),
    })
  })
  await page.route(new RegExp(`${API_RE}/projects/([^/?]+)/credentials/([^/?]+)$`), (r) => {
    if (r.request().method() === 'DELETE') return r.fulfill({ status: 204, body: '' })
    if (r.request().method() === 'PATCH')
      return r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      })
    return r.fallback()
  })
  await page.route(new RegExp(`${API_RE}/projects/([^/?]+)/credentials$`), (r) => {
    if (r.request().method() === 'GET')
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) })
    if (r.request().method() === 'POST')
      return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({}) })
    return r.fallback()
  })

  // Per-project legend (PR #164). Project-detail page renders ProjectLegendSection
  // for ADMIN/HR/JUNIOR → GET /api/projects/:id/legend on mount. Unmocked →
  // 401 → axios interceptor → /login (same failure mode as the notifications/
  // documents/contracts mocks above). /entries sub-route before the generic.
  await page.route(new RegExp(`${API_RE}/projects/([^/?]+)/legend/entries$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(
          r,
          {
            id: 'legend-1-id',
            projectId: r.request().url().split('/').slice(-3, -2)[0],
            fullName: 'Alexander Petrenko',
            dateOfBirth: null,
            address: null,
            presentedRole: null,
            presentedStack: null,
            backstory: null,
            hobbies: null,
            notes: null,
            entries: [],
            createdAt: '2024-01-15T00:00:00.000Z',
            updatedAt: '2024-01-15T00:00:00.000Z',
          },
          201,
        )
      : r.fallback(),
  )
  await page.route(new RegExp(`${API_RE}/projects/([^/?]+)/legend$`), (r) => {
    // GET (page load): default 404 "no legend" → section shows its empty state
    // (useLegend retry:false handles 403/404). Specs needing a real legend
    // register their own handler AFTER mockAuthAs (LIFO). PUT: echo.
    if (r.request().method() === 'GET') {
      return r.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Легенда не найдена' }),
      })
    }
    if (r.request().method() === 'PUT') {
      return jsonOk(r, {
        id: 'legend-1-id',
        projectId: r.request().url().split('/').slice(-2, -1)[0],
        fullName: 'Alexander Petrenko',
        dateOfBirth: null,
        address: null,
        presentedRole: null,
        presentedStack: null,
        backstory: null,
        hobbies: null,
        notes: null,
        entries: [],
        createdAt: '2024-01-15T00:00:00.000Z',
        updatedAt: '2024-01-15T00:00:00.000Z',
      })
    }
    return r.fallback()
  })

  // Interviews
  await page.route(new RegExp(`${API_RE}/interviews/([^/?]+)/move`), (r) =>
    jsonOk(r, { ...INTERVIEWS[0], stage: 'ENGLISH_CHECK' }),
  )
  await page.route(new RegExp(`${API_RE}/interviews/([^/?]+)$`), (r) =>
    r.request().method() === 'DELETE'
      ? noContent(r)
      : jsonOk(r, { ...INTERVIEWS[0], ...(JSON.parse(r.request().postData() ?? '{}') as object) }),
  )
  await page.route(new RegExp(`${API_RE}/interviews(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { ...INTERVIEWS[0], id: 'new-interview-id' }, 201)
      : jsonOk(r, INTERVIEWS),
  )
  // HR dashboard summary — registered AFTER the `/interviews/:id` route so it
  // wins under Playwright's LIFO route matching (last-registered handler runs
  // first). Without this ordering the `([^/?]+)` param matcher above would
  // swallow the literal `hr-summary` segment and return an interview row
  // (hrSummarySchema.parse would then throw → HRDashboard error-state).
  await page.route(new RegExp(`${API_RE}/interviews/hr-summary(\\?.*)?$`), (r) =>
    // Shape MUST match `hrSummarySchema` ({ openInterviews, hiredThisMonth,
    // activeProjects }) — the hook .parse()s the response, so a drifting shape
    // (e.g. the obsolete `mySalaryStatus` field + missing `activeProjects`) makes
    // HRDashboard render its error state and the RU KPI tokens never appear.
    jsonOk(r, {
      openInterviews: 3,
      hiredThisMonth: 1,
      activeProjects: 2,
    }),
  )

  // Finance — real API paths (no /finance/ prefix for transactions/payout-requests)
  await page.route(new RegExp(`${API_RE}/transactions/senior-income/([^/?]+)$`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-1), status: 'PENDING' }),
  )
  await page.route(new RegExp(`${API_RE}/transactions/([^/?]+)/(validate|pay|admin-edit)$`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-2), status: 'VALIDATED' }),
  )
  await page.route(new RegExp(`${API_RE}/transactions/([^/?]+)$`), (r) => {
    if (r.request().method() === 'DELETE') return jsonOk(r, { deleted: true })
    if (r.request().method() === 'POST') return jsonOk(r, { id: 'tx-new', status: 'PENDING' }, 201)
    return jsonOk(r, { id: r.request().url().split('/').at(-1), status: 'PENDING' })
  })
  await page.route(new RegExp(`${API_RE}/transactions(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'tx-new', status: 'PENDING' }, 201)
      : jsonOk(r, []),
  )
  await page.route(new RegExp(`${API_RE}/payout-requests/([^/?]+)/pay$`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-2), status: 'PAID' }),
  )
  // Phase 8 v2 (PR #253, AC3) — manual-confirm endpoint (ADMIN/ACCOUNTANT only).
  // Must be registered BEFORE the generic /payout-requests/:id$ route so PATCH
  // requests to /manual-confirm don't accidentally fall through to the generic
  // id-handler (LIFO: last-registered wins). Default: 200 success with method echo.
  await page.route(new RegExp(`${API_RE}/payout-requests/([^/?]+)/manual-confirm$`), (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    const body = JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>
    const payoutId = r.request().url().split('/').slice(-2, -1)[0]
    return jsonOk(r, {
      id: payoutId,
      status: 'PAID',
      method: body.method ?? 'COMPANY_ACCOUNT',
      note: body.note ?? null,
      txHash: body.txHash ?? null,
    })
  })
  await page.route(new RegExp(`${API_RE}/payout-requests(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'payout-req-new', status: 'PENDING_PAYMENT' }, 201)
      : jsonOk(r, []),
  )

  // Finance — summary, transactions, expenses, payouts, junior-payments, invoices, exchange rates
  await page.route(new RegExp(`${API_RE}/finance/summary(\\?.*)?$`), (r) =>
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
  // ACCOUNTANT Sprint 1 — accountant финансовый хаб KPI snapshot. Default
  // non-zero values so AccountantDashboard renders the loaded state. Tests that
  // need other figures register their own handler AFTER mockAuthAs (LIFO).
  await page.route(new RegExp(`${API_RE}/finance/accountant-summary(\\?.*)?$`), (r) =>
    jsonOk(r, {
      pendingValidation: { count: 4, amount: 15000 },
      validatedThisMonth: { count: 2, amount: 3500 },
      paidThisMonth: { amount: 12000 },
      recipientCount: 5,
    }),
  )
  // ADMIN dashboard «центр действий» — KPI snapshot + active-transactions feed
  // (GET /api/admin/summary, RBAC ADMIN-only). Без этого мока AdminDashboard's
  // `useAdminSummary` (retry: 2) бьёт по реальному backend'у → 401/hang →
  // дашборд застревает в loading/error и KPI-токены не рендерятся. Shape =
  // `adminSummarySchema`; default non-zero values так дашборд в loaded-состоянии.
  // Тесты, которым нужны иные данные, регистрируют свой handler ПОСЛЕ mockAuthAs.
  await page.route(new RegExp(`${API_RE}/admin/summary(\\?.*)?$`), (r) =>
    jsonOk(r, {
      kpis: {
        activeProjects: 8,
        employees: 21,
        projectsUnpaidThisMonth: 3,
        activeInterviews: 2,
      },
      activeTransactions: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          type: 'SENIOR_INCOME',
          status: 'PENDING',
          senderId: null,
          senderName: null,
          senderLabel: 'Acme Corp',
          receiverId: '33333333-3333-4333-8333-3333333330aa',
          receiverName: 'Mock Senior',
          receiverLabel: 'Mock Senior',
          projectId: '33333333-3333-4333-8333-3333333330bb',
          projectName: 'Mock Project A',
          amount: '4500.000000',
          currency: 'USDT',
          txDate: '2026-05-05T10:00:00.000Z',
          payoutRequestId: null,
          canPay: false,
        },
        {
          id: '44444444-4444-4444-8444-444444444444',
          type: 'PAYOUT',
          status: 'PENDING_PAYMENT',
          senderId: '44444444-4444-4444-8444-4444444440aa',
          senderName: 'Mock Senior',
          senderLabel: 'Mock Senior',
          receiverId: null,
          receiverName: null,
          receiverLabel: 'CheekyCheeseIT',
          projectId: '44444444-4444-4444-8444-4444444440bb',
          projectName: 'Mock Project B',
          amount: '600.000000',
          currency: 'USDT',
          txDate: '2026-05-01T10:00:00.000Z',
          payoutRequestId: null,
          canPay: true,
        },
      ],
    }),
  )
  // SENIOR dashboard (#234) — senior хаб KPI snapshot. STRICTLY self-scoped on
  // the backend (RBAC SENIOR+ADMIN → 200, everyone else → 403). Без этого мока
  // SeniorDashboard's `useSeniorSummary` (GET /api/finance/senior-summary,
  // retry: 2) бьёт по реальному backend'у → 401/hang → `networkidle` никогда не
  // достигается → таймаут навигационных тестов SENIOR (identical failure mode к
  // drop/me/summary комментарию ниже). Shape = `seniorSummarySchema`; default
  // non-zero значения, чтобы дашборд рендерил loaded-состояние. Тесты, которым
  // нужны иные цифры, регистрируют свой handler ПОСЛЕ mockAuthAs (LIFO).
  await page.route(new RegExp(`${API_RE}/finance/senior-summary(\\?.*)?$`), (r) =>
    jsonOk(r, {
      activeProjects: {
        count: 2,
        items: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            name: 'Mock Project A',
            companyName: 'Acme Corp',
            sharePercent: 26,
          },
          {
            id: '22222222-2222-4222-8222-222222222222',
            name: 'Mock Project B',
            companyName: 'Globex',
            sharePercent: 30,
          },
        ],
      },
      seniorShareIncome: { total: 8400, thisMonth: 1200, currency: 'USD' },
      pendingPayouts: { count: 1, amount: 600 },
      // task-salary-month-gap-and-status (E-6, security-review MED-3):
      // `mySalaryStatus` stays the pre-E-6 shape (deprecated, kept for old-
      // client compat); `mySalaryState` is the new 4-state discriminated
      // union. The hook .parse()s this response, so BOTH must be present or
      // the SENIOR dashboard renders its error state.
      mySalaryStatus: { amount: 1200, currency: 'USD', status: 'PENDING' },
      mySalaryState: { state: 'EXISTS', amount: 1200, currency: 'USD', status: 'PENDING' },
      // task-senior-stats-block — «Статистика заработка» (required in DTO). The
      // hook .parse()s the response, so this MUST carry the new shape or the
      // SENIOR dashboard renders the error state. Values keep the dashboard in a
      // loaded state (non-empty sparkline + a partial X/N arrival progress).
      earningsStats: {
        lastMonthIncome: 4200,
        monthlyHistory: [
          { month: '2025-11', amount: 2200 },
          { month: '2025-12', amount: 3100 },
          { month: '2026-01', amount: 2800 },
          { month: '2026-02', amount: 3600 },
          { month: '2026-03', amount: 4100 },
          { month: '2026-04', amount: 3900 },
          { month: '2026-05', amount: 4200 },
          { month: '2026-06', amount: 1200 },
        ],
        companyIncomeProgress: { received: 1, total: 2 },
      },
    }),
  )
  await page.route(new RegExp(`${API_RE}/finance/transactions(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'tx-new', status: 'PENDING' }, 201)
      : jsonOk(r, []),
  )
  await page.route(new RegExp(`${API_RE}/finance/transactions/([^/?]+)`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-1), status: 'VALIDATED' }),
  )
  await page.route(new RegExp(`${API_RE}/finance/expenses(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'exp-new', expenseType: 'COMPANY_INCOME' }, 201)
      : jsonOk(r, []),
  )
  await page.route(new RegExp(`${API_RE}/finance/expenses/([^/?]+)`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-1) }),
  )
  await page.route(new RegExp(`${API_RE}/finance/junior-payments(\\?.*)?$`), (r) => jsonOk(r, []))
  await page.route(new RegExp(`${API_RE}/finance/invoices(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'inv-new', status: 'DRAFT' }, 201)
      : jsonOk(r, []),
  )
  await page.route(new RegExp(`${API_RE}/finance/invoices/([^/?]+)`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-1), status: 'DRAFT' }),
  )
  await page.route(new RegExp(`${API_RE}/finance/payouts(\\?.*)?$`), (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { id: 'payout-new', status: 'PENDING_PAYMENT' }, 201)
      : jsonOk(r, []),
  )
  await page.route(new RegExp(`${API_RE}/finance/payouts/([^/?]+)`), (r) =>
    jsonOk(r, { id: r.request().url().split('/').at(-1), status: 'PENDING_PAYMENT' }),
  )
  await page.route(new RegExp(`${API_RE}/finance/exchange-rate(\\?.*)?$`), (r) =>
    jsonOk(r, { usdUah: '41.50', usdtUah: '41.50', eurUah: '44.80', date: '2026-05-10' }),
  )
  await page.route(new RegExp(`${API_RE}/finance/chart(/.*)?$`), (r) => jsonOk(r, []))
  await page.route(new RegExp(`${API_RE}/finance/partner-balance(\\?.*)?$`), (r) =>
    jsonOk(r, {
      maksymSpentUsd: '6000.00',
      kostyaSpentUsd: '6000.00',
      debtUsd: '0.00',
      debtDirection: 'SETTLED',
    }),
  )
  await page.route(new RegExp(`${API_RE}/finance/my-salary(\\?.*)?$`), (r) => jsonOk(r, []))
  await page.route(new RegExp(`${API_RE}/finance/expenses/hints(\\?.*)?$`), (r) =>
    jsonOk(r, { projects: [], users: [] }),
  )

  // Phase 8 — Company USDT account. CompanyAccountCard mounts on /finance
  // for ADMIN/ACCOUNTANT and fires GET /api/company-account unconditionally
  // (no `enabled` guard). Without this mock the request hits the real backend →
  // 401 → axios interceptor → /login redirect, OR the pending network request
  // prevents `networkidle` / `waitForLoadState('domcontentloaded')` from settling →
  // downstream navigation tests (navigation.spec.ts:281) time out. Default: a
  // wallet-not-set, zero-balance stub. Tests that need non-zero balance register
  // their own handler AFTER mockAuthAs (LIFO).
  await page.route(new RegExp(`${API_RE}/company-account/dividends$`), (r) => {
    if (r.request().method() !== 'POST') return r.fallback()
    return jsonOk(r, { id: 'dividend-new', amount: 0, receiverId: user.id })
  })
  await page.route(new RegExp(`${API_RE}/company-account/wallet$`), (r) => {
    if (r.request().method() !== 'PATCH') return r.fallback()
    return jsonOk(r, {
      walletAddress: (JSON.parse(r.request().postData() ?? '{}') as Record<string, unknown>)[
        'walletAddress'
      ] as string,
      confirmationThreshold: 12,
      balance: 0,
      updatedAt: null,
    })
  })
  await page.route(new RegExp(`${API_RE}/company-account$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return jsonOk(r, {
      walletAddress: '0x' + '1'.repeat(40),
      confirmationThreshold: 12,
      balance: 0,
      updatedAt: null,
    })
  })

  // Onboarding (Phase 6B) — default: fully onboarded, no wizard redirect.
  // Tests that need unboarded state call mockOnboardingApi() AFTER mockAuthAs();
  // Playwright's LIFO route-handler stack ensures the later registration wins.
  await page.route(`${API_GLOB}/onboarding/status`, (r) =>
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
  // navigation.spec.ts and others click sidebar → /documents which mounts
  // DocumentsPage → useDocuments() → GET /documents. Without these mocks the
  // request hits the real backend → 401 → axios interceptor → location.href =
  // '/login' → user gets logged out mid-navigation (root cause for PR #48 fails).
  await page.route(new RegExp(`${API_RE}/documents/([^/?]+)/download$`), (r) =>
    jsonOk(r, {
      url: 'http://localhost:9000/crm-documents/mock-download',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }),
  )
  await page.route(new RegExp(`${API_RE}/documents/([^/?]+)/thumbnail$`), (r) => jsonOk(r, null))
  await page.route(new RegExp(`${API_RE}/documents/([^/?]+)/restore$`), (r) =>
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
  await page.route(new RegExp(`${API_RE}/documents/([^/?]+)/hard$`), (r) => noContent(r))
  await page.route(new RegExp(`${API_RE}/documents/([^/?]+)$`), (r) =>
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
  await page.route(new RegExp(`${API_RE}/documents(\\?.*)?$`), (r) =>
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

  // Employee contracts (A3-2) — guard against ContractFillForm firing
  // GET /contract/variables which hits the real backend → 401 → axios
  // interceptor → window.location = '/login' on any test that opens a
  // profile page with the contract tab mounted.
  // Sub-routes must be registered BEFORE the generic /contract$ pattern so
  // they match first (Playwright uses LIFO within a registration sequence;
  // later-registered routes take priority over earlier ones).
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/contract/variables$`), (r) =>
    jsonOk(r, { variables: [], customVariables: [] }),
  )
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/contract/custom-values$`), (r) =>
    r.request().method() === 'PATCH' ? jsonOk(r, {}) : r.fallback(),
  )
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/contract/pdf$`), (r) =>
    r.fulfill({ status: 200, contentType: 'application/pdf', body: Buffer.from('%PDF-1.4') }),
  )
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/contract/(ready|revert|reset)$`), (r) =>
    r.fallback(),
  )
  await page.route(new RegExp(`${API_RE}/users/([^/?]+)/contract$`), (r) => {
    if (r.request().method() === 'GET') {
      // Default: 404 "no template" — tests that need a real contract
      // register their own handler AFTER mockAuthAs so it takes priority (LIFO).
      return r.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'No active contract template for role UNKNOWN' }),
      })
    }
    return r.fallback()
  })

  // Compliance audit trail (Phase 6 polish PR3)

  // task-junior-ux-2-hub: GET /contracts/me — JUNIOR hub uses this.
  // Default: 404 (no contract yet). Tests that need a SIGNED contract
  // register their own handler AFTER mockAuthAs (LIFO priority).
  await page.route(new RegExp(`${API_RE}/contracts/me$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'No contract found' }),
    })
  })

  // task-junior-ux-hub: GET /contracts/me/status — ContractStatusCard (JUNIOR hub).
  // Must be registered BEFORE the generic /contracts/me$ route so it matches first (LIFO).
  // Default: 404 "no contract". junior-hub.spec.ts overrides this after mockAuthAs for
  // SIGNED/READY_TO_SIGN scenarios. Without this mock the request hits the real backend
  // → 401 → axios interceptor → /login redirect → networkidle never settles
  // → navigation.spec.ts JUNIOR tests timeout at 30 000 ms.
  await page.route(new RegExp(`${API_RE}/contracts/me/status$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'No contract found' }),
    })
  })

  // task-junior-ux-hub: GET /users/me/salary-meta — SalarySnapshotCard (JUNIOR hub).
  // Default: null salary (role has no salary configured). junior-hub.spec.ts overrides
  // for the salary-populated scenarios. Without this mock same timeout failure as above.
  await page.route(new RegExp(`${API_RE}/users/me/salary-meta$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ monthlySalary: null, salaryCurrency: null, changedAt: null }),
    })
  })

  // Drop role - phase 2: DROP hub «Мой роутинг» + finance cabinet.
  //
  // GET /api/finance/drop/me/summary → DropSelfSummaryDto
  // GET /api/finance/drop/me/incomes → PaginatedDropIncomes
  // GET /api/finance/drop/me/payments → DropPaymentDto[]
  // GET /api/projects/drop/me → DropProjectDto[]
  //
  // Without these mocks the requests hit the real backend → 401 → axios
  // interceptor → window.location = '/login' — identical failure mode to the
  // JUNIOR hub mocks above. Defaults produce a minimal non-error state so the
  // hub renders its cards. Specs that need specific data register their own
  // handlers AFTER mockAuthAs (LIFO) so they take priority.
  await page.route(new RegExp(`${API_RE}/finance/drop/me/summary$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return jsonOk(r, {
      balance: 0,
      dropSharePercent: 5,
      pendingIncomesCount: 0,
      debtToCompany: 0,
      // task-drop-sees-own-obligations: dropSelfSummarySchema now REQUIRES
      // these two fields — omitting them fails the FE's Zod `.parse()`,
      // which silently error-states the whole hub/finance page (MED-3,
      // security-review PR #523 round 1: this exact gap broke
      // drop-share-usdt-gates.spec.ts via the missing `drop-add-income`
      // testid, downstream of this fixture, not of anything in that spec).
      pendingObligationAmount: 0,
      pendingObligationCount: 0,
    })
  })
  await page.route(new RegExp(`${API_RE}/finance/drop/me/incomes(\\?.*)?$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return jsonOk(r, { items: [], total: 0, page: 1, limit: 20 })
  })
  await page.route(new RegExp(`${API_RE}/finance/drop/me/payments$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return jsonOk(r, [])
  })
  await page.route(new RegExp(`${API_RE}/projects/drop/me$`), (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    return jsonOk(r, [])
  })
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
  /** ACCOUNTANT Sprint 1: ACCOUNTANT-authenticated page for the finance hub. */
  asAccountant: Page
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
  asAccountant: async ({ page }, use) => {
    await mockAuthAs(page, USERS.accountant)
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
// `page.goto('/...')` is authenticated.

/**
 * Backend HTTP origin used by the real-API helpers. Overridable via
 * `E2E_REAL_API_BASE` (task-drop-share-e2e) so a local run can point at a
 * throwaway API instance on a non-default port (e.g. when 3001 is already
 * occupied by a concurrent worktree's dev stack) without touching every
 * call-site. Defaults to the standard dev/CI port — existing specs are
 * unaffected.
 *
 * task-pending-share (2026-09-04): running the FULL suite against a
 * self-provisioned scratch DB + scratch API/web pair (never the live
 * `crm_db` or the live :3000/:3001 pair — see live-db-access.md /
 * light-track.md's port list) needs FOUR env vars set together, none of
 * which are collected in one place anywhere else in this repo:
 *   - `PLAYWRIGHT_BASE_URL` (playwright.config.ts) — drives BROWSER
 *     navigation only.
 *   - `E2E_REAL_API_BASE` (this constant) — drives the DIRECT
 *     `apiRequestContext` calls (`dev-login` and most setup/teardown
 *     helpers) in this file. Separate from the two below because neither
 *     of them is read by a Node test process at all — they configure the
 *     WEB DEV SERVER, started as its own separate command.
 *   - `VITE_PROXY_API_TARGET` (apps/web/vite.config.ts) — the web dev
 *     server's OWN `/api` proxy target for same-origin requests made BY
 *     THE BROWSER (i.e. the app under test, not this fixture file).
 *     Distinct from `VITE_API_URL` (the frontend axios client's base URL);
 *     both default to :3001 independently and neither is driven by the
 *     other — setting only one leaves the other silently pointed at the
 *     live pair, or (worse) creates a self-proxy loop if the web dev
 *     server was also given a non-default `--port` matching that default.
 *   - `THROTTLE_RELAXED=true` (apps/api/src/config/env.ts, non-production
 *     only) on the scratch API — the suite's own parallel workers calling
 *     `dev-login` from `127.0.0.1` comfortably exceed the default
 *     `THROTTLER_LIMIT` (100 req/60s), which 429s cascade into failures
 *     across spec files that have nothing to do with whatever the actual
 *     change under test touches.
 * Also start the web dev server with `--strictPort` (`vite --port <port>
 * --strictPort`, not `pnpm dev -- --port <port>` — a literal `--` can
 * reach vite's own arg parser and get silently ignored, falling back to
 * vite's default port search) so a port collision fails loudly instead of
 * silently binding elsewhere.
 */
export const REAL_API_BASE = process.env['E2E_REAL_API_BASE'] ?? 'http://localhost:3001'

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
export const MAKSYM_ID = 'a8f4d3b1-c2e5-4a1f-9b3d-8c7e6f5a4b21'
export const KOSTYA_ID = 'b9e5c4d2-d3f6-4b2e-ac4e-9d8f7a6b5c32'

/**
 * Plant a real JWT cookie for the given email via `/api/auth/dev-login`.
 *
 * Throws if the backend isn't reachable or rejects the login — real-API
 * specs must surface that loudly so the suite fails fast instead of
 * silently running unauthenticated.
 */
/**
 * Retry a request thunk up to `maxRetries` times on HTTP 429.
 * The global throttler is 100 req/60 s — local test runs can exhaust it
 * when multiple specs run back-to-back. Wait 5 s between retries.
 */
async function withThrottleRetry(
  thunk: () => Promise<import('@playwright/test').APIResponse>,
  label: string,
  maxRetries = 2,
): Promise<import('@playwright/test').APIResponse> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const res = await thunk()
    if (res.status() !== 429) return res
    if (attempt < maxRetries) {
      // Global throttler: 100 req/60 s sliding window. Wait 10 s to let
      // quota partially recover (enough for one more request).
      await new Promise((r) => setTimeout(r, 10_000))
    }
  }
  // Final attempt — return whatever we got (caller checks status).
  return thunk()
}

export async function loginViaApi(page: Page, email: string): Promise<void> {
  const res = await withThrottleRetry(
    () => page.request.post(`${REAL_API_BASE}/api/auth/dev-login`, { data: { email } }),
    `dev-login(${email})`,
  )
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
    /**
     * Legal full name for the MSA contract — `createDropSchema` made this
     * mandatory (see superRefine "ФИО обязательно для контракта",
     * fix/drop-legal-name-persist). Defaults to a deterministic E2E value
     * derived from `displayName` so existing callers don't need to change;
     * override when a test asserts on the exact persisted value.
     */
    legalFullName?: string
  },
): Promise<{ dropId: string; teamId: string; email: string }> {
  const hrEmails = opts.hrEmails ?? [SEED_EMAILS.hrA]
  const accountantEmail = opts.accountantEmail ?? SEED_EMAILS.accountant
  const legalFullName = opts.legalFullName ?? `E2E Drop Legal ${opts.displayName}`

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
    legalFullName,
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

/**
 * Fetch a team's audit-log via GET /api/teams/:id/audit-log (ADMIN-only).
 *
 * `TeamsService.mapDropTeam` (security-review PR #541 round 3) filters
 * `members` to ACTIVE rows only (`leftAt === null`) — a drop-team's GET
 * response NEVER includes a detached (leftAt-set) historic member, by
 * design. Specs proving "the senior was detached, not archived" during a
 * drop-team/drop-user archive cascade therefore cannot observe the
 * `leftAt` timestamp via `getTeamViaAPI` — the member simply disappears
 * from the list. This helper reads the audit trail `archiveDropTeam`
 * writes instead (`action: 'team_member_removed'`, `changes.userId.before`
 * = the detached user, `changes.role.before` = their pre-detach role) —
 * the actual observable proof that the cascade ran, not an inference from
 * absence. Caller must be ADMIN.
 */
export async function getTeamAuditLogViaAPI(
  page: Page,
  teamId: string,
): Promise<
  Array<{
    id: string
    actorId: string | null
    targetId: string
    action: string
    changes: Record<string, { before: unknown; after: unknown }>
    createdAt: string
  }>
> {
  const res = await page.request.get(`${REAL_API_BASE}/api/teams/${teamId}/audit-log`)
  if (res.status() !== 200) {
    throw new Error(
      `getTeamAuditLogViaAPI failed for team ${teamId}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  const body = (await res.json()) as { entries: Awaited<ReturnType<typeof getTeamAuditLogViaAPI>> }
  return body.entries
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
 * Confirm a DRAFT project as one of its invited approvers via
 * POST /api/projects/:id/approve — task-project-draft-status. A fresh
 * project starts DRAFT and refuses income (400 «Проект ещё не
 * подтверждён») until EVERY invited approver (the project's senior, and
 * its drop when it has one) confirms — see `projects.service.ts`'s
 * `approveDraft`/`applyApprovalAggregate`.
 *
 * Switches the page's session to `approverEmail` (dev-login cookie swap,
 * same mechanism as `loginViaApi`) because only an INVITED approver may
 * call this — an ADMIN who is not the project's senior/drop gets 404
 * (`ApprovalsService` treats a non-invited caller as "no such approval
 * row", the same existence-oracle contract `assertAccess` uses for
 * visibility). Caller is responsible for restoring whatever session it
 * needs afterward (mirrors `onboardDropViaAPI`'s own contract).
 */
export async function approveProjectViaAPI(
  page: Page,
  projectId: string,
  approverEmail: string,
): Promise<{ id: string; status: string }> {
  await loginViaApi(page, approverEmail)
  const res = await withThrottleRetry(
    () => page.request.post(`${REAL_API_BASE}/api/projects/${projectId}/approve`),
    `approveProjectViaAPI(${approverEmail})`,
  )
  if (res.status() !== 200 && res.status() !== 201) {
    throw new Error(
      `approveProjectViaAPI failed for ${approverEmail}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  return (await res.json()) as { id: string; status: string }
}

/**
 * Decline a DRAFT project as one of its invited approvers via
 * POST /api/projects/:id/reject — mirror of `approveProjectViaAPI` for the
 * rejection branch. Voids the WHOLE approval proposal (not just this
 * approver's own row) and the project becomes `REJECTED` — same
 * income-refusal gate as DRAFT (`assertProjectActive` refuses both).
 */
export async function rejectProjectViaAPI(
  page: Page,
  projectId: string,
  approverEmail: string,
  reason: string,
): Promise<{ id: string; status: string }> {
  await loginViaApi(page, approverEmail)
  const res = await withThrottleRetry(
    () =>
      page.request.post(`${REAL_API_BASE}/api/projects/${projectId}/reject`, {
        data: { reason },
      }),
    `rejectProjectViaAPI(${approverEmail})`,
  )
  if (res.status() !== 200 && res.status() !== 201) {
    throw new Error(
      `rejectProjectViaAPI failed for ${approverEmail}: HTTP ${res.status()} — ${await res.text()}`,
    )
  }
  return (await res.json()) as { id: string; status: string }
}

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
 *
 * task-project-draft-status: the created project starts DRAFT and refuses
 * income (400 «Проект ещё не подтверждён») until both the senior and the
 * drop confirm it. By default this helper drives it through that real
 * confirmation flow (POST /api/projects/:id/approve as each approver, via
 * `approveProjectViaAPI`) before returning, so every EXISTING call site
 * keeps behaving exactly as it did before this column shipped — the
 * returned project is immediately usable for income. Pass
 * `skipApproval: true` when the test itself needs to observe the DRAFT
 * state (see `project-draft-status.spec.ts`).
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
    /**
     * task-drop-share-e2e. Optional project payment-type (ADR
     * 2026-07-13-payment-type-income-routing D1). Absent → backend default
     * 'FOP'. Pass 'USDT' to provision an admin-USDT-declaration fixture
     * (paired with `dropSharePercentOverride` below for Flow 4 assertions).
     */
    paymentType?: 'FOP' | 'GIG_CONTRACT' | 'USDT'
    dropSharePercentOverride?: number | null
    /** task-project-draft-status. Leave the project DRAFT — see doc above. */
    skipApproval?: boolean
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
    ...(opts.paymentType !== undefined && { paymentType: opts.paymentType }),
    ...(opts.dropSharePercentOverride !== undefined && {
      dropSharePercentOverride: opts.dropSharePercentOverride,
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

  if (!opts.skipApproval) {
    const dropUser = await getUserViaAPI(page, body.dropId)
    await approveProjectViaAPI(page, body.id, seniorEmail)
    await approveProjectViaAPI(page, body.id, dropUser.email)
    // Restore ADMIN session — every call site logs in as ADMIN right before
    // calling this helper (same contract `onboardDropViaAPI` uses).
    await loginViaApi(page, SEED_EMAILS.admin)
  }

  return { projectId: body.id, dropId: body.dropId, seniorId: body.seniorId }
}

/**
 * Create a regular SENIOR project (no dropId) via POST /api/projects.
 *
 * Mirror of `createDropProjectViaAPI` but omits `dropId` entirely — the
 * backend treats this as a regression-safe senior-project. Used by the
 * regression spec to assert that NO PAYOUT_DROP rows are produced.
 *
 * task-project-draft-status: same DRAFT-then-auto-confirm contract as
 * `createDropProjectViaAPI` (there being no drop here, only the senior's
 * own confirmation is needed) — see that function's doc for the full
 * reasoning and the `skipApproval` escape hatch.
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
    /** task-project-draft-status. Leave the project DRAFT. */
    skipApproval?: boolean
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

  if (!opts.skipApproval) {
    await approveProjectViaAPI(page, body.id, seniorEmail)
    // Restore ADMIN session — every call site logs in as ADMIN right before
    // calling this helper (same contract `onboardDropViaAPI` uses).
    await loginViaApi(page, SEED_EMAILS.admin)
  }

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
 *   - receiptExternalUrl: 'https://etherscan.io/tx/0xdrop00...' (task-receipts-e2e:
 *     the default currency is USDT, and mandatory-receipt now requires the
 *     receipt to be a blockchain-explorer link for USDT — a file is rejected
 *     and a non-explorer URL is rejected. An explorer link is also a valid
 *     plain http(s) URL, so this same default stays valid for callers that
 *     override `currency` to a non-USDT value too).
 *   - idempotencyKey: fresh `crypto.randomUUID()` per call (task-senior-drop-
 *     income-idempotency, backlog 73/A-3) — same optional-override contract
 *     as `declareUsdtIncomeViaAPI` above; a caller exercising the replay
 *     behaviour passes the SAME key across two calls explicitly.
 */
export async function createDropIncomeViaAPI(
  page: Page,
  opts: {
    projectId: string
    amount?: number
    currency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
    idempotencyKey?: string
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
    idempotencyKey: opts.idempotencyKey ?? crypto.randomUUID(),
    ...(opts.receiptDocumentId
      ? { receiptDocumentId: opts.receiptDocumentId }
      : {
          receiptExternalUrl:
            opts.receiptExternalUrl ?? 'https://etherscan.io/tx/0xdrop000000000000income',
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
 *
 * task-receipts-e2e: same explorer-link default fix as `createDropIncomeViaAPI`
 * — the default currency is USDT, so the default receipt must be an
 * allowlisted blockchain-explorer link (a `drive.example.com` URL is rejected
 * by the mandatory currency-aware receipt refine).
 *
 * task-senior-drop-income-idempotency (backlog 73/A-3): `idempotencyKey`
 * defaults to a fresh `crypto.randomUUID()` per call — same optional-override
 * contract as `createDropIncomeViaAPI` above.
 */
export async function createSeniorIncomeViaAPI(
  page: Page,
  opts: {
    projectId: string
    amount?: number
    currency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
    idempotencyKey?: string
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
    idempotencyKey: opts.idempotencyKey ?? crypto.randomUUID(),
    ...(opts.receiptDocumentId
      ? { receiptDocumentId: opts.receiptDocumentId }
      : {
          receiptExternalUrl:
            opts.receiptExternalUrl ?? 'https://etherscan.io/tx/0xsenior0000000000income',
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
 * Create a payout_request for a set of VALIDATED SENIOR_INCOME transactions
 * via POST /api/payout-requests.
 *
 * feat/finance-payout-flow (#7): validateTransaction for SENIOR_INCOME no
 * longer auto-creates a payout_request. The SENIOR must call this endpoint
 * manually (or via the UI PayoutDialog) to batch one or more VALIDATED incomes
 * into a single payout. This helper replaces the implicit assumption that
 * validateTransactionViaAPI returns a non-null payoutRequestId for
 * SENIOR_INCOME flows.
 *
 * Caller must be SENIOR. Returns the new payout_request id.
 */
export async function createPayoutRequestViaAPI(
  page: Page,
  transactionIds: string[],
): Promise<{ payoutRequestId: string }> {
  const res = await page.request.post(`${REAL_API_BASE}/api/payout-requests`, {
    data: { transactionIds },
  })
  if (res.status() !== 201) {
    throw new Error(`createPayoutRequestViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  const body = (await res.json()) as { id: string }
  return { payoutRequestId: body.id }
}

/**
 * Mark a PENDING payout_request as PAID via PATCH /api/payout-requests/:id/pay.
 *
 * Caller must be SENIOR or DROP (the seniorId/dropId on the payout_request
 * must match the caller). The backend books the distribution obligations:
 * for a drop-project, SENIOR_PENDING_PAYOUT + DROP_PENDING_PAYOUT (both
 * COMPANY debts, pending settle-with-receipt — task-drop-share-pending-parity,
 * 2026-07-27); a senior-project books nothing extra (the PAYOUT credit alone
 * is the whole settlement). No PAYOUT_ADMIN rows on either branch.
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
    // `currency` was undeclared here even though `mapTx` has always returned
    // it (same class of gap as the `payoutRequestId` note above) — backlog
    // item 139 needed it to read the placeholder PAYOUT row's currency
    // without a second request.
    currency: string
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
      currency: string
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
 * `?projectId=` filter captures them on both drop and senior flows.
 *
 * Backlog 144 (resolved): the placeholder PAYOUT row `createPayoutRequest`
 * inserts — and the PAYOUT_CONFIRMED row `confirmPayout` snapshots from it —
 * now ALSO carry `projectId` (see `TransactionsService.createPayoutRequest`),
 * so this filter finds those too. The legacy workaround
 * (`listPayoutRequestTransactionsViaAPI`) is still useful when you want a
 * single payout's rows in deterministic order regardless of project.
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
    // backlog 144: same undeclared-field gap as `payoutRequestId` below —
    // `mapTx` has always returned `currency`, the shape here just never said
    // so. drop-confirm-payout.spec.ts needs it now that it reads the PAYOUT
    // / PAYOUT_CONFIRMED rows straight off this helper (the `?projectId=`
    // filter finds them directly — see the fixed TRAP note above).
    currency: string
    senderId: string | null
    receiverId: string | null
    recipientId: string | null
    projectId: string | null
    // `TransactionsService.mapTx` has always returned this (transactions.service.ts
    // — `payoutRequestId: tx.payoutRequestId`); the shape above just never
    // declared it. senior-payout-no-dup.spec.ts asserts on it to prove a
    // SENIOR_INCOME is linked to the payout request that settled it — the
    // regression this whole spec exists for. Undeclared, that assertion was a
    // TS2339 nobody ran, so the link went unchecked. (task-lint-teeth)
    payoutRequestId: string | null
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
 *
 * TRAP (backlog item 139, found while de-flaking the drop specs) — FIXED
 * 2026-08 (backlog item 144, `TransactionsService.createPayoutRequest`,
 * apps/api/src/finance/transactions.service.ts). The placeholder PAYOUT row
 * `createPayoutRequest` inserts (and later flips to PAID in
 * `applyPayoutPaidCascade`) used to be inserted WITHOUT `projectId` — unlike
 * PAYOUT_ADMIN / SENIOR_PENDING_PAYOUT / DROP_PENDING_PAYOUT, which the same
 * cascade DOES stamp (see `bookCompanyObligations` in
 * transactions.service.ts) — so this helper's `?projectId=` filter (same one
 * `listTransactionsByProjectViaAPI` uses) never returned it, at any status,
 * before or after payment. `createPayoutRequest` now stamps `projectId` on
 * that row (the batch's "primary project" — first linked income's project,
 * same convention `applyPayoutPaidCascade` already used), and `confirmPayout`
 * inherits it onto PAYOUT_CONFIRMED via its existing `projectId:
 * payoutTx.projectId` snapshot, so both are found by this filter (and by
 * `listTransactionsByProjectViaAPI`) directly now. `listPayoutRequestTransactionsViaAPI(page,
 * payoutRequestId)` (joins on `payoutRequestId`, not `projectId`) remains a
 * valid alternative when you want a single payout's rows in deterministic
 * order regardless of project — it was never REQUIRED for this, just the
 * only thing that worked before the fix.
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

// ---------------------------------------------------------------------------
// ensureCompanyWalletViaAPI
// ---------------------------------------------------------------------------

/**
 * Ensure the company wallet is configured (required for payout-request creation).
 * The dev seed leaves walletAddress=NULL. Any spec that needs to create a
 * payout_request (DROP pay flow) must call this first. Idempotent.
 * Caller must be logged in as ADMIN.
 */
export async function ensureCompanyWalletViaAPI(page: Page): Promise<void> {
  const res = await withThrottleRetry(
    () =>
      page.request.patch(`${REAL_API_BASE}/api/company-account/wallet`, {
        data: { walletAddress: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      }),
    'PATCH company-account/wallet',
  )
  if (res.status() !== 200 && res.status() !== 201) {
    throw new Error(`ensureCompanyWalletViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
}

// ---------------------------------------------------------------------------
// onboardDropViaAPI
// ---------------------------------------------------------------------------

/**
 * Onboard a DROP user via HTTP so they can call income endpoints.
 *
 * Steps:
 *   1. ADMIN PATCH /api/users/:id {legalFullName} — required for contract signature
 *   2. ADMIN POST /api/users/:id/contract/ready — WITHOUT Content-Type:json (Fastify quirk)
 *   3. DROP POST /api/contracts/sign {typedName} — bypass-listed in OnboardingGuard
 *   4. DROP POST /api/tos/accept — bypass-listed in OnboardingGuard
 *
 * Restores ADMIN session on exit.
 * Safe to call multiple times — onboarding endpoints are idempotent on an
 * already-onboarded user (they return 200/201 regardless).
 */
export async function onboardDropViaAPI(
  page: Page,
  opts: { dropId: string; dropEmail: string },
): Promise<void> {
  // Step 1: ADMIN sets legalFullName (required for contract PDF generation)
  const patchRes = await withThrottleRetry(
    () =>
      page.request.patch(`${REAL_API_BASE}/api/users/${opts.dropId}`, {
        data: { legalFullName: 'Test Drop Onboarded Testovych' },
      }),
    'PATCH legalFullName',
  )
  if (patchRes.status() !== 200) {
    throw new Error(
      `onboardDropViaAPI: PATCH legalFullName failed: HTTP ${patchRes.status()} — ${await patchRes.text()}`,
    )
  }

  // Step 1b: ADMIN GET /api/users/:id/contract — lazy-creates the DRAFT contract row.
  // markReady (step 2) requires a non-CANCELLED contract row to already exist.
  const draftRes = await withThrottleRetry(
    () => page.request.get(`${REAL_API_BASE}/api/users/${opts.dropId}/contract`),
    'GET /contract draft',
  )
  if (draftRes.status() !== 200 && draftRes.status() !== 201) {
    throw new Error(
      `onboardDropViaAPI: GET /contract (draft create) failed: HTTP ${draftRes.status()} — ${await draftRes.text()}`,
    )
  }

  // Step 2: ADMIN marks user's contract as ready
  // IMPORTANT: must NOT send Content-Type: application/json with empty body —
  // Fastify returns 400 "Body cannot be empty when content-type is set to 'application/json'"
  const readyRes = await withThrottleRetry(
    () => page.request.post(`${REAL_API_BASE}/api/users/${opts.dropId}/contract/ready`),
    'POST /contract/ready',
  )
  if (readyRes.status() !== 200 && readyRes.status() !== 201) {
    throw new Error(
      `onboardDropViaAPI: POST /contract/ready failed: HTTP ${readyRes.status()} — ${await readyRes.text()}`,
    )
  }

  // Step 3 & 4: Switch to DROP session, sign contract and accept ToS
  await loginViaApi(page, opts.dropEmail)

  const signRes = await withThrottleRetry(
    () =>
      page.request.post(`${REAL_API_BASE}/api/contracts/sign`, {
        data: { typedName: 'Test Drop Onboarded Testovych' },
      }),
    'POST /contracts/sign',
  )
  if (signRes.status() !== 200 && signRes.status() !== 201) {
    throw new Error(
      `onboardDropViaAPI: POST /contracts/sign failed: HTTP ${signRes.status()} — ${await signRes.text()}`,
    )
  }

  const tosRes = await withThrottleRetry(
    () => page.request.post(`${REAL_API_BASE}/api/tos/accept`),
    'POST /tos/accept',
  )
  if (tosRes.status() !== 200 && tosRes.status() !== 201) {
    throw new Error(
      `onboardDropViaAPI: POST /tos/accept failed: HTTP ${tosRes.status()} — ${await tosRes.text()}`,
    )
  }

  // Restore ADMIN session so subsequent calls use ADMIN credentials
  await loginViaApi(page, SEED_ADMIN_EMAIL)
}

/**
 * Sign an ALREADY-READY-TO-SIGN contract for `email` + accept the current
 * ToS — the tail half of `onboardDropViaAPI` (its steps 3-4), for a user
 * whose contract is already `READY_TO_SIGN` and must NOT receive the
 * PATCH-legalFullName / mark-ready steps first.
 *
 * Needed for seed users deliberately left at `READY_TO_SIGN` for the
 * onboarding-wizard specs (`dmytro.marchenko` / `SEED_EMAILS.seniorB` —
 * apps/api/src/database/seed.ts: "dmytro.marchenko — READY_TO_SIGN (wizard
 * test)"). `onboardDropViaAPI` cannot be reused on them as-is: its
 * `POST /contract/ready` step 409s (`Cannot mark ready: contract is
 * READY_TO_SIGN, expected DRAFT`) because that transition is DRAFT-only —
 * seniorB is deliberately parked one step past it, forever, for that other
 * spec's own purposes.
 *
 * task-project-draft-status: `POST /api/projects/:id/approve` requires the
 * caller to have completed onboarding (OnboardingGuard) — so a test that
 * uses seniorB as an approving senior (e.g. to exercise a specific
 * `seniorSharePercent` override) needs this BEFORE `createDropProjectViaAPI`
 * / `createSeniorProjectViaAPI` auto-approves for them.
 *
 * `typedName` is ignored server-side (resolved from the user's
 * `legalFullName` — see `SignedContractsService.sign`'s own `@deprecated`
 * note), so any non-empty value is fine here.
 *
 * Restores ADMIN session on exit, same contract as `onboardDropViaAPI`.
 */
export async function signContractAndAcceptTosViaAPI(page: Page, email: string): Promise<void> {
  await loginViaApi(page, email)

  const signRes = await withThrottleRetry(
    () =>
      page.request.post(`${REAL_API_BASE}/api/contracts/sign`, {
        data: { typedName: 'E2E Contract Sign' },
      }),
    `signContractAndAcceptTosViaAPI(${email}): sign`,
  )
  if (signRes.status() !== 200 && signRes.status() !== 201) {
    throw new Error(
      `signContractAndAcceptTosViaAPI: POST /contracts/sign failed for ${email}: HTTP ${signRes.status()} — ${await signRes.text()}`,
    )
  }

  const tosRes = await withThrottleRetry(
    () => page.request.post(`${REAL_API_BASE}/api/tos/accept`),
    `signContractAndAcceptTosViaAPI(${email}): tos`,
  )
  if (tosRes.status() !== 200 && tosRes.status() !== 201) {
    throw new Error(
      `signContractAndAcceptTosViaAPI: POST /tos/accept failed for ${email}: HTTP ${tosRes.status()} — ${await tosRes.text()}`,
    )
  }

  await loginViaApi(page, SEED_ADMIN_EMAIL)
}

// ---------------------------------------------------------------------------
// task-drop-share-e2e — admin-USDT income declaration + obligation settle
// ---------------------------------------------------------------------------
//
// ADR docs/architecture/2026-07-13-payment-type-income-routing.md (D3/D4/D5).
// `declareUsdtIncomeViaAPI` hits the NEW ADMIN-only endpoint directly (used by
// gate/regression specs that don't need the full dialog UI). The happy-path
// spec drives the dialog through the UI instead (purpose statement: E2E
// proves the user path, not just the endpoint contract already covered by
// backend integration tests AC9-AC16).

/**
 * Declare USDT project income via POST /api/finance/usdt-income.
 * Caller must be ADMIN-authenticated (`loginViaApi(page, SEED_ADMIN_EMAIL)` or
 * another seed ADMIN). `receiverId` is either an ADMIN uuid (personal credit)
 * or the `'COMPANY_ACCOUNT'` sentinel (shared pool credit).
 *
 * task-receipts-e2e: `createUsdtIncomeSchema` now requires a mandatory,
 * explorer-only receipt (currency is always the `'USDT'` literal for this
 * flow) — defaults to a valid etherscan.io link so existing/future callers
 * that don't care about the receipt don't need to know about this invariant.
 */
export async function declareUsdtIncomeViaAPI(
  page: Page,
  opts: {
    projectId: string
    amount: number
    receiverId: string
    idempotencyKey?: string
    notes?: string | null
    txDate?: string | null
    receiptExternalUrl?: string
  },
): Promise<{ id: string; status: string; amount: string; receiverId: string | null }> {
  const payload = {
    projectId: opts.projectId,
    amount: opts.amount,
    currency: 'USDT' as const,
    receiverId: opts.receiverId,
    idempotencyKey: opts.idempotencyKey ?? crypto.randomUUID(),
    receiptExternalUrl: opts.receiptExternalUrl ?? 'https://etherscan.io/tx/0xusdtincome0000001',
    ...(opts.notes !== undefined && { notes: opts.notes }),
    ...(opts.txDate !== undefined && { txDate: opts.txDate }),
  }
  const res = await page.request.post(`${REAL_API_BASE}/api/finance/usdt-income`, {
    data: payload,
  })
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`declareUsdtIncomeViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  return (await res.json()) as Awaited<ReturnType<typeof declareUsdtIncomeViaAPI>>
}

/**
 * Settle a company obligation (SENIOR_PENDING_PAYOUT or DROP_PENDING_PAYOUT)
 * via POST /pending-settlements/by-source-transaction/:id/settle-company —
 * the SAME generic endpoint the finance-page «Выплатить» button calls
 * (`SettleSeniorPayoutDialog` → `financeApi.settleSeniorPayoutFromTransaction`).
 * Routes server-side by the source-transaction's `type` (ADR D5).
 * `TransactionRow.tsx` renders the «Выплатить» action for BOTH obligation
 * types since PR #367 (the earlier frontend gap flagged in the
 * task-drop-share-e2e report is closed). Settling via API here (instead of
 * clicking that button) is deliberate and mirrors the pre-existing
 * SENIOR_PENDING_PAYOUT pattern: these specs assert the money flow; the
 * button/dialog UI behaviour is covered by its own unit tests.
 *
 * task-receipts-e2e: `settleSeniorPayoutSchema` now requires a mandatory,
 * currency-aware receipt (task-receipts-backend #10) — defaults to a valid
 * etherscan.io link for the (also-defaulted) USDT currency so existing
 * callers keep working; pass `receiptExternalUrl`/`receiptDocumentId` to
 * override for a non-USDT currency.
 */
export async function settleObligationBySourceTransactionViaAPI(
  page: Page,
  sourceTransactionId: string,
  opts: {
    fundingSource: 'COMPANY_ACCOUNT' | 'ADMIN_PERSONAL'
    payerAdminId?: string
    currency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
    receiptExternalUrl?: string
    receiptDocumentId?: string
  },
): Promise<{ status: number; body: unknown }> {
  const res = await page.request.post(
    `${REAL_API_BASE}/api/pending-settlements/by-source-transaction/${sourceTransactionId}/settle-company`,
    {
      data: {
        fundingSource: opts.fundingSource,
        ...(opts.payerAdminId !== undefined && { payerAdminId: opts.payerAdminId }),
        currency: opts.currency ?? 'USDT',
        ...(opts.receiptDocumentId
          ? { receiptDocumentId: opts.receiptDocumentId }
          : {
              receiptExternalUrl:
                opts.receiptExternalUrl ?? 'https://etherscan.io/tx/0xsettleobligation00001',
            }),
      },
    },
  )
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = await res.text()
  }
  if (res.status() >= 400) {
    throw new Error(
      `settleObligationBySourceTransactionViaAPI failed: HTTP ${res.status()} — ${JSON.stringify(body)}`,
    )
  }
  return { status: res.status(), body }
}

/** Fetch the shared company-account balance via GET /api/company-account. */
export async function getCompanyAccountBalanceViaAPI(page: Page): Promise<number> {
  const res = await page.request.get(`${REAL_API_BASE}/api/company-account`)
  if (res.status() !== 200) {
    throw new Error(`getCompanyAccountBalanceViaAPI failed: HTTP ${res.status()}`)
  }
  const body = (await res.json()) as { balance: number | string }
  return typeof body.balance === 'string' ? parseFloat(body.balance) : body.balance
}

/**
 * Self-summary for a DROP via GET /api/finance/drop/me/summary (DROP-only).
 * Used to confirm the drop's aggregate `balance` moves after a
 * DROP_PENDING_PAYOUT settle (PAYOUT_DROP credit — `computeDropAggregate`).
 * Caller must already be logged in as the DROP (`loginViaApi(page, dropEmail)`).
 */
export async function getDropSelfSummaryViaAPI(
  page: Page,
): Promise<{ balance: number; debtToCompany: number; pendingIncomesCount: number }> {
  const res = await page.request.get(`${REAL_API_BASE}/api/finance/drop/me/summary`)
  if (res.status() !== 200) {
    throw new Error(`getDropSelfSummaryViaAPI failed: HTTP ${res.status()} — ${await res.text()}`)
  }
  return (await res.json()) as Awaited<ReturnType<typeof getDropSelfSummaryViaAPI>>
}
