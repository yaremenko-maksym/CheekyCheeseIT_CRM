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
    // task-i18n-stage2 (Task 3/4) — CR-M-1 (code-review PR #693 round 1):
    // required by `sessionUserSchema`; the `SessionUserShape` intersection
    // on `mockAuthAs` below makes tsc catch it if a future entry omits this.
    locale: 'uk' as const,
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
    locale: 'uk' as const,
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
    locale: 'uk' as const,
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
    locale: 'uk' as const,
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
    locale: 'uk' as const,
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
    locale: 'uk' as const,
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
    locale: 'uk' as const,
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
    locale: 'uk' as const,
    createdAt: '2024-01-09T00:00:00.000Z',
    updatedAt: '2024-01-09T00:00:00.000Z',
  },
}

export const ALL_USERS = Object.values(USERS)

/**
 * Locally mirrors `sessionUserSchema`'s REQUIRED fields — not imported from
 * `@crm/shared` (see `MAKSYM_ID`/`KOSTYA_ID`'s doc further down for why the
 * e2e package deliberately doesn't depend on it: keeps the test runner
 * independent of the workspace build pipeline).
 *
 * CR-M-1 (code-review PR #693 round 1): `mockAuthAs`'s `user` parameter used
 * to be typed as ONLY `(typeof USERS)[keyof typeof USERS]` — a plain
 * structural type with no link back to the real session shape. When `locale`
 * was added to `sessionUserSchema` (task-i18n-stage2), every `USERS` entry
 * fell out of sync with it silently: no test failed, `tsc` said nothing,
 * `/auth/me` mocks just quietly returned a session one field short of what
 * the real endpoint returns. Intersecting `mockAuthAs`'s parameter with this
 * shape (below) means a FUTURE required field added to `sessionUserSchema`
 * (and duplicated here) breaks every `USERS` entry that omits it — the same
 * safety a real `SessionUser` import would give, without the dependency.
 */
interface SessionUserShape {
  id: string
  email: string
  displayName: string
  avatarUrl: string | null
  role: 'ADMIN' | 'SENIOR' | 'JUNIOR' | 'HR' | 'ACCOUNTANT' | 'DROP'
  seniorSharePercent: number
  locale: 'uk' | 'en'
}

/**
 * Plain `Omit<T, K>` on a UNION type (like `(typeof USERS)[keyof typeof
 * USERS]`) does not distribute over the union's members — `keyof` on a
 * union is the INTERSECTION of each member's keys, so `Omit` collapses the
 * whole union into one flattened shape that loses the correlation between
 * e.g. `role: 'SENIOR'` and that member's own `paymentMethod`/`techStack`
 * fields (verified: this broke every existing `mockAuthAs(page,
 * USERS.senior)` call with `role`-mismatch errors when `mockAuthAs` first
 * tried a plain `Omit`). Wrapping in a distributive conditional
 * (`T extends any ? ... : never`) applies `Omit` to each member
 * separately, keeping the union's per-member shape intact.
 */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

/**
 * `mockAuthAs`'s parameter type, named so the helpers it calls internally
 * (`buildAdminViewingUser`, `buildSelfView` — both receive `user`/`found`,
 * which may be a locale-overridden object) can share it instead of the
 * original locale-pinned-to-`'uk'` `(typeof USERS)[keyof typeof USERS]`. A
 * plain `USERS.*` entry (`locale: 'uk'`) is still assignable here — `'uk'`
 * satisfies `'uk' | 'en'` — so this is strictly wider, not a different
 * shape.
 */
export type MockUser = DistributiveOmit<(typeof USERS)[keyof typeof USERS], 'locale'> &
  SessionUserShape

/**
 * Build a team-member fixture row from any user-shaped fixture.
 *
 * Generic over the input rather than typed as `(typeof USERS)[keyof typeof USERS]`
 * (task-lint-teeth): that nominal union rejected `EXTRA_ACCOUNTANT` below, which
 * is a perfectly well-formed user fixture that simply does not live inside the
 * `USERS` object. The constraint states what this helper actually needs, and the
 * generic keeps each call's literal field types in the returned row.
 */
export function toMember<
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
    // SPEC-H-2 (PR #646 fix-round 1): `status` added — this fixture predates
    // task-project-draft-status (PR #630), which made `status` a REQUIRED
    // field on ProjectDto. Without it, `p.status === 'ACTIVE'` (the Active
    // tab's own bucketing predicate, task-project-status-filter-ui) reads
    // `undefined === 'ACTIVE'` — false — and this project silently drops off
    // the DEFAULT tab, which is exactly what AC1 ("список совпадает с
    // сегодняшним") forbids. The real seed's own `status` column DEFAULT is
    // 'ACTIVE' (verified via postgres query), so this project — never a
    // draft — genuinely IS 'ACTIVE'; this is the fixture catching up to a
    // field it was always supposed to carry, not a new assumption.
    status: 'ACTIVE' as const,
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
    // SPEC-H-2: same as project-1-id — a completed, closed project (hence
    // archivedAt set) is still 'ACTIVE' by status; DRAFT/REJECTED is a
    // separate axis from archival (business spec §4.2 — never mixed).
    status: 'ACTIVE' as const,
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
    scheduledAt: null,
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
    scheduledAt: null,
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
    scheduledAt: null,
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
    scheduledAt: null,
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
