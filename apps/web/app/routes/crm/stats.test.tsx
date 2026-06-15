/**
 * stats.test.tsx — role-split rendering for /crm/stats (task-accountant-stats).
 *
 * The page is shared by ADMIN and ACCOUNTANT, but the visible surface differs:
 *
 *   ECONOMIC (both ADMIN + ACCOUNTANT): finance KPIs (income / expenses /
 *     salaries / Net), secondary KPIs, the monthly chart — i.e. the P&L.
 *
 *   ADMIN-ONLY: «Балансы участников» (ParticipantsBalancesSection → calls
 *     /api/users, ADMIN/HR-only), the partner-balances settlement card, and the
 *     «Другие разделы» HR/Команда/Проекты placeholders.
 *
 * This pins AC1–AC3: ACCOUNTANT sees the economic section but NONE of the
 * employee/partner-level balances or placeholders; ADMIN sees everything.
 *
 * Heavy dependencies (router file-route, query client, recharts, finance api)
 * are mocked so the component renders in isolation — mirrors
 * AccountantDashboard.test.tsx conventions.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { FinanceSummaryDto, SessionUser } from '@crm/shared'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const navigateMock = vi.fn()
const useAuthMock = vi.fn()
const useQueryMock = vi.fn()
const useQueriesMock = vi.fn()

// createFileRoute(...)(opts) → returns the route object; component is read off it
// by the router, never by this test (we render StatsPage directly).
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: unknown) => opts,
  useNavigate: () => navigateMock,
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: unknown) => useQueryMock(opts),
  useQueries: (opts: unknown) => useQueriesMock(opts),
}))

vi.mock('@/context/auth', () => ({
  useAuth: () => useAuthMock(),
}))

// recharts pulls in ResizeObserver / canvas — stub to plain divs so the chart
// section renders without a real DOM measuring environment.
vi.mock('recharts', () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    Bar: Passthrough,
    BarChart: Passthrough,
    CartesianGrid: Passthrough,
    ReferenceLine: Passthrough,
    ResponsiveContainer: Passthrough,
    Tooltip: Passthrough,
    XAxis: Passthrough,
    YAxis: Passthrough,
  }
})

vi.mock('./finance/api', () => ({
  financeApi: { getSummary: vi.fn() },
}))

import { StatsPage } from './stats'

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeUser(role: SessionUser['role']): SessionUser {
  return {
    id: '00000000-0000-4000-a000-000000000001',
    email: `${role.toLowerCase()}@test.spec`,
    displayName: `Test ${role}`,
    avatarUrl: null,
    avatarDocumentId: null,
    role,
    seniorSharePercent: 26,
    legalFullName: null,
  }
}

function makeSummary(): FinanceSummaryDto {
  return {
    totalIncome: 10000,
    totalExpenses: 2000,
    totalSalaries: 3000,
    netBalance: 5000,
    adminBalances: [
      { userId: 'admin-1', displayName: 'Admin One', balance: 4000 },
      { userId: 'admin-2', displayName: 'Admin Two', balance: 1000 },
    ],
    dropBalances: [],
    monthly: [
      { month: '2026-05', income: 4000, expenses: 800, salaries: 1200, profit: 2000 },
      { month: '2026-06', income: 6000, expenses: 1200, salaries: 1800, profit: 3000 },
    ],
  }
}

function setup(role: SessionUser['role']) {
  useAuthMock.mockReturnValue({ user: makeUser(role), isLoading: false })
  // StatsPage uses ONE useQuery (finance summary). ParticipantsBalancesSection
  // (ADMIN-only) uses its own useQuery + useQueries — return empty so it renders
  // cleanly if mounted.
  useQueryMock.mockImplementation((opts: { queryKey?: unknown[] }) => {
    const key = opts?.queryKey?.[0]
    if (key === 'finance-summary') return { data: makeSummary(), isLoading: false }
    if (key === 'stats-participants') return { data: [], isLoading: false }
    return { data: undefined, isLoading: false }
  })
  useQueriesMock.mockReturnValue([])
  return render(<StatsPage />)
}

beforeEach(() => {
  navigateMock.mockReset()
  useAuthMock.mockReset()
  useQueryMock.mockReset()
  useQueriesMock.mockReset()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StatsPage — economic data (both roles)', () => {
  it.each<SessionUser['role']>(['ADMIN', 'ACCOUNTANT'])(
    '%s sees the economic finance section + core KPIs',
    (role) => {
      setup(role)
      expect(screen.getByTestId('stats-finance-section')).toBeInTheDocument()
      // Core P&L KPI titles are present for both roles.
      expect(screen.getByText('Общий доход')).toBeInTheDocument()
      expect(screen.getByText('Расходы')).toBeInTheDocument()
      expect(screen.getByText('Зарплаты')).toBeInTheDocument()
      expect(screen.getByText('Net balance')).toBeInTheDocument()
      // Monthly chart (P&L over time) is rendered.
      expect(screen.getByText('Динамика по месяцам')).toBeInTheDocument()
    },
  )
})

describe('StatsPage — ACCOUNTANT economic-only (AC1, AC2)', () => {
  it('renders the accountant variant root, NOT the admin root', () => {
    setup('ACCOUNTANT')
    expect(screen.getByTestId('stats-page-accountant')).toBeInTheDocument()
    expect(screen.queryByTestId('stats-page-admin')).not.toBeInTheDocument()
  })

  it('does NOT render the participants-balances section', () => {
    setup('ACCOUNTANT')
    expect(screen.queryByTestId('participants-balances-card')).not.toBeInTheDocument()
    expect(screen.queryByText('Балансы участников')).not.toBeInTheDocument()
  })

  it('does NOT render the partner-balances settlement card', () => {
    setup('ACCOUNTANT')
    expect(screen.queryByText('Балансы партнёров')).not.toBeInTheDocument()
  })

  it('does NOT render the HR/Команда/Проекты placeholders', () => {
    setup('ACCOUNTANT')
    expect(screen.queryByTestId('stats-placeholders-section')).not.toBeInTheDocument()
    expect(screen.queryByText('Другие разделы')).not.toBeInTheDocument()
    expect(screen.queryByText('HR — воронка собеседований')).not.toBeInTheDocument()
  })

  it('does NOT issue the ADMIN-only /users participants query', () => {
    setup('ACCOUNTANT')
    // ParticipantsBalancesSection is gated out entirely → its query key never runs.
    const keys = useQueryMock.mock.calls.map(
      (c) => (c[0] as { queryKey?: unknown[] })?.queryKey?.[0],
    )
    expect(keys).not.toContain('stats-participants')
  })
})

describe('StatsPage — ADMIN full surface (AC3 — no regression)', () => {
  it('renders the admin variant root', () => {
    setup('ADMIN')
    expect(screen.getByTestId('stats-page-admin')).toBeInTheDocument()
    expect(screen.queryByTestId('stats-page-accountant')).not.toBeInTheDocument()
  })

  it('renders the participants-balances section', () => {
    setup('ADMIN')
    expect(screen.getByTestId('participants-balances-card')).toBeInTheDocument()
  })

  it('renders the partner-balances settlement card', () => {
    setup('ADMIN')
    expect(screen.getByText('Балансы партнёров')).toBeInTheDocument()
  })

  it('renders the HR/Команда/Проекты placeholders', () => {
    setup('ADMIN')
    expect(screen.getByTestId('stats-placeholders-section')).toBeInTheDocument()
    expect(screen.getByText('Другие разделы')).toBeInTheDocument()
  })

  it('issues the ADMIN-only participants query', () => {
    setup('ADMIN')
    const keys = useQueryMock.mock.calls.map(
      (c) => (c[0] as { queryKey?: unknown[] })?.queryKey?.[0],
    )
    expect(keys).toContain('stats-participants')
  })
})
