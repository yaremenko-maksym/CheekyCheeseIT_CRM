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
    avatar: null,
    telegram: null,
    phone: null,
    techStack: null,
    defaultSharePercent: null,
    monthlySalary: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  },
  senior: {
    id: 'a0000000-0000-4000-8000-000000000002',
    email: 'senior@cheekycheese.dev',
    displayName: 'Senior Dev',
    role: 'SENIOR' as const,
    avatar: null,
    telegram: '@seniordev',
    phone: '+380661234567',
    techStack: 'TypeScript FE',
    seniorSharePercent: 26,
    monthlySalary: null,
    createdAt: '2024-01-02T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
  },
  junior: {
    id: 'a0000000-0000-4000-8000-000000000003',
    email: 'junior@cheekycheese.dev',
    displayName: 'Junior Dev',
    role: 'JUNIOR' as const,
    avatar: null,
    telegram: null,
    phone: null,
    techStack: null,
    defaultSharePercent: null,
    monthlySalary: 800,
    createdAt: '2024-01-03T00:00:00.000Z',
    updatedAt: '2024-01-03T00:00:00.000Z',
  },
  hr: {
    id: 'a0000000-0000-4000-8000-000000000004',
    email: 'hr@cheekycheese.dev',
    displayName: 'HR Manager',
    role: 'HR' as const,
    avatar: null,
    telegram: null,
    phone: null,
    techStack: null,
    defaultSharePercent: null,
    monthlySalary: 1000,
    createdAt: '2024-01-04T00:00:00.000Z',
    updatedAt: '2024-01-04T00:00:00.000Z',
  },
  accountant: {
    id: 'a0000000-0000-4000-8000-000000000005',
    email: 'accountant@cheekycheese.dev',
    displayName: 'Accountant User',
    role: 'ACCOUNTANT' as const,
    avatar: null,
    telegram: null,
    phone: null,
    techStack: null,
    defaultSharePercent: null,
    monthlySalary: 1200,
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
    avatar: user.avatar,
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
  avatar: null,
  telegram: null,
  phone: null,
  techStack: null,
  defaultSharePercent: null,
  monthlySalary: 1200,
  createdAt: '2024-01-06T00:00:00.000Z',
  updatedAt: '2024-01-06T00:00:00.000Z',
}

export const TEAMS = [
  {
    id: 'team-1-id',
    name: 'Alpha Team',
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

export const PROJECTS = [
  {
    id: 'project-1-id',
    name: 'AI Platform v2',
    companyName: 'TechCorp AI',
    domain: 'AI',
    logoUrl: null,
    seniorId: USERS.senior.id,
    seniorName: USERS.senior.displayName,
    rate: 5000,
    currency: 'USDT',
    status: 'ACTIVE',
    startDate: '2024-01-15T00:00:00.000Z',
    endDate: null,
    createdAt: '2024-01-15T00:00:00.000Z',
    updatedAt: '2024-01-15T00:00:00.000Z',
    members: [],
  },
  {
    id: 'project-2-id',
    name: 'EdTech Portal',
    companyName: 'LearnFast Ltd',
    domain: 'EdTech',
    logoUrl: null,
    seniorId: USERS.senior.id,
    seniorName: USERS.senior.displayName,
    rate: 3000,
    currency: 'USD',
    status: 'CLOSED',
    sharePercent: null,
    startDate: '2023-06-01T00:00:00.000Z',
    endDate: '2024-01-01T00:00:00.000Z',
    createdAt: '2023-06-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    members: [
      {
        id: 'pm-junior-1',
        userId: USERS.junior.id,
        displayName: USERS.junior.displayName,
        email: USERS.junior.email,
        avatar: USERS.junior.avatar,
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
]

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
  await page.route(`${API}/users/me`, (r) => jsonOk(r, user))
  await page.route(new RegExp(`${API}/users/([^/?]+)$`), (r) => {
    const id = r.request().url().split('/').at(-1)
    const found = ALL_USERS.find((u) => u.id === id) ?? user
    return r.request().method() === 'PATCH'
      ? jsonOk(r, { ...found, ...(JSON.parse(r.request().postData() ?? '{}') as object) })
      : jsonOk(r, found)
  })
  await page.route(`${API}/users`, (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { ...USERS.junior, id: 'new-user-id', ...(JSON.parse(r.request().postData() ?? '{}') as object) }, 201)
      : jsonOk(r, ALL_USERS),
  )

  // Teams
  await page.route(new RegExp(`${API}/teams/([^/?]+)/members`), (r) =>
    r.request().method() === 'DELETE' ? noContent(r) : jsonOk(r, TEAMS[0], 201),
  )
  await page.route(new RegExp(`${API}/teams/([^/?]+)$`), (r) =>
    r.request().method() === 'DELETE'
      ? noContent(r)
      : jsonOk(r, { ...TEAMS[0], ...(JSON.parse(r.request().postData() ?? '{}') as object) }),
  )
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
  await page.route(`${API}/projects`, (r) =>
    r.request().method() === 'POST'
      ? jsonOk(r, { ...PROJECTS[0], id: 'new-project-id' }, 201)
      : jsonOk(r, PROJECTS),
  )

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
