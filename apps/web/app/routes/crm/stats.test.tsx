/**
 * stats.test.tsx — role-split rendering for /crm/stats.
 *
 * The page is shared by ADMIN and ACCOUNTANT. After task-income-compliance:
 *
 *   ECONOMIC (both ADMIN + ACCOUNTANT): finance KPIs (income / expenses /
 *     salaries / Net), secondary KPIs, the monthly chart — i.e. the P&L.
 *
 *   «КОНТРОЛЬ ПРИХОДОВ» (both ADMIN + ACCOUNTANT): the income-compliance section
 *     (X/N progress per receiver + expand of projects without a counted income).
 *     The ParticipantsBalancesSection (employee/partner balances) was REMOVED.
 *
 *   ADMIN-ONLY: the partner-balances settlement card and the «Другие разделы»
 *     HR/Команда/Проекты placeholders.
 *
 * This pins: both roles see the economic + income-compliance sections; the old
 * participants-balances section is gone for everyone; ADMIN still sees the
 * partner-balances card + placeholders (no regression), ACCOUNTANT does not.
 *
 * Heavy dependencies (router file-route, query client, recharts, finance api)
 * are mocked so the component renders in isolation.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { FinanceSummaryDto, IncomeComplianceOverviewDto, SessionUser } from '@crm/shared'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const navigateMock = vi.fn()
const useAuthMock = vi.fn()
const useQueryMock = vi.fn()

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (opts: unknown) => opts,
  useNavigate: () => navigateMock,
}))

vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: unknown) => useQueryMock(opts),
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
  financeApi: { getSummary: vi.fn(), getIncomeCompliance: vi.fn() },
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

function makeCompliance(): IncomeComplianceOverviewDto {
  return {
    month: '2026-06',
    totals: {
      expectedProjects: 4,
      submittedProjects: 2,
      laggingReceivers: 1,
      completeReceivers: 1,
      pendingProjects: 1,
    },
    receivers: [
      {
        userId: 'sr-lag',
        displayName: 'Senior Lag',
        role: 'SENIOR',
        expected: 3,
        submitted: 1,
        pendingCount: 1,
        missingProjects: [
          {
            projectId: 'p-pending',
            name: 'EdNext LMS',
            companyName: 'EdNext Inc.',
            submitted: false,
            pendingValidation: true,
          },
          {
            projectId: 'p-missing',
            name: 'ShopCore Backend',
            companyName: 'ShopCore Ltd.',
            submitted: false,
            pendingValidation: false,
          },
        ],
      },
      {
        userId: 'sr-done',
        displayName: 'Senior Done',
        role: 'SENIOR',
        expected: 1,
        submitted: 1,
        pendingCount: 0,
        missingProjects: [],
      },
    ],
  }
}

function setup(role: SessionUser['role']) {
  useAuthMock.mockReturnValue({ user: makeUser(role), isLoading: false })
  useQueryMock.mockImplementation((opts: { queryKey?: unknown[] }) => {
    const key = opts?.queryKey?.[0]
    if (key === 'finance-summary') return { data: makeSummary(), isLoading: false }
    if (key === 'income-compliance') return { data: makeCompliance(), isLoading: false }
    return { data: undefined, isLoading: false }
  })
  return render(<StatsPage />)
}

beforeEach(() => {
  navigateMock.mockReset()
  useAuthMock.mockReset()
  useQueryMock.mockReset()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StatsPage — economic data (both roles)', () => {
  it.each<SessionUser['role']>(['ADMIN', 'ACCOUNTANT'])(
    '%s sees the economic finance section + core KPIs',
    (role) => {
      setup(role)
      expect(screen.getByTestId('stats-finance-section')).toBeInTheDocument()
      expect(screen.getByText('Общий доход')).toBeInTheDocument()
      expect(screen.getByText('Расходы')).toBeInTheDocument()
      expect(screen.getByText('Зарплаты')).toBeInTheDocument()
      expect(screen.getByText('Net balance')).toBeInTheDocument()
      expect(screen.getByText('Динамика по месяцам')).toBeInTheDocument()
    },
  )
})

describe('StatsPage — income-compliance «Контроль приходов» (both roles)', () => {
  it.each<SessionUser['role']>(['ADMIN', 'ACCOUNTANT'])(
    '%s sees the income-compliance section + receivers + KPI strip',
    (role) => {
      setup(role)
      expect(screen.getByTestId('income-compliance-section')).toBeInTheDocument()
      expect(screen.getByText('Контроль приходов')).toBeInTheDocument()
      // KPI strip
      expect(screen.getByText('Всего приходов')).toBeInTheDocument()
      expect(screen.getByText('Закрыты полностью')).toBeInTheDocument()
      expect(screen.getByText('Отстают')).toBeInTheDocument()
      // Receiver rows
      expect(screen.getByTestId('compliance-row-sr-lag')).toBeInTheDocument()
      expect(screen.getByTestId('compliance-row-sr-done')).toBeInTheDocument()
      expect(screen.getByText('Senior Lag')).toBeInTheDocument()
    },
  )

  it('expands a lagging receiver to reveal missing projects (incl. pending badge)', () => {
    setup('ADMIN')
    // Detail drawer hidden initially.
    expect(screen.queryByTestId('compliance-detail-sr-lag')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('compliance-toggle-sr-lag'))
    const detail = screen.getByTestId('compliance-detail-sr-lag')
    expect(detail).toBeInTheDocument()
    expect(screen.getByText('EdNext LMS')).toBeInTheDocument()
    expect(screen.getByText('ShopCore Backend')).toBeInTheDocument()
    // The pending project shows «На валидации» (also the receiver-row badge, so
    // there are ≥1); the missing one «Нет прихода».
    expect(screen.getAllByText('На валидации').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Нет прихода')).toBeInTheDocument()
  })

  it('does NOT render the removed participants-balances section', () => {
    setup('ADMIN')
    expect(screen.queryByTestId('participants-balances-card')).not.toBeInTheDocument()
    expect(screen.queryByText('Балансы участников')).not.toBeInTheDocument()
  })

  it('shows an empty state when there are no receivers', () => {
    useAuthMock.mockReturnValue({ user: makeUser('ADMIN'), isLoading: false })
    useQueryMock.mockImplementation((opts: { queryKey?: unknown[] }) => {
      const key = opts?.queryKey?.[0]
      if (key === 'finance-summary') return { data: makeSummary(), isLoading: false }
      if (key === 'income-compliance')
        return {
          data: {
            month: '2026-06',
            totals: {
              expectedProjects: 0,
              submittedProjects: 0,
              laggingReceivers: 0,
              completeReceivers: 0,
              pendingProjects: 0,
            },
            receivers: [],
          } satisfies IncomeComplianceOverviewDto,
          isLoading: false,
        }
      return { data: undefined, isLoading: false }
    })
    render(<StatsPage />)
    expect(screen.getByText(/Нет активных проектов-получателей дохода/)).toBeInTheDocument()
  })
})

describe('StatsPage — ACCOUNTANT economic-only (no admin-only surface)', () => {
  it('renders the accountant variant root, NOT the admin root', () => {
    setup('ACCOUNTANT')
    expect(screen.getByTestId('stats-page-accountant')).toBeInTheDocument()
    expect(screen.queryByTestId('stats-page-admin')).not.toBeInTheDocument()
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
})

describe('StatsPage — ADMIN full surface (no regression)', () => {
  it('renders the admin variant root', () => {
    setup('ADMIN')
    expect(screen.getByTestId('stats-page-admin')).toBeInTheDocument()
    expect(screen.queryByTestId('stats-page-accountant')).not.toBeInTheDocument()
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
})
