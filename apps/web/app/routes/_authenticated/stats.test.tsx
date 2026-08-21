/**
 * stats.test.tsx — role-split rendering for /stats.
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
import { render, screen, fireEvent, within } from '@testing-library/react'
import type {
  FinanceSummaryDto,
  IncomeComplianceOverviewDto,
  IncomeComplianceReceiverDto,
  SessionUser,
} from '@crm/shared'

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

// FinanceChart is now lazy (React.lazy + Suspense). Mock the module so the
// component resolves synchronously in the test environment — avoids the need
// for act()/waitFor() wrappers in existing synchronous assertions.
vi.mock('@/components/stats/FinanceChart', () => ({
  FinanceChart: ({ summary }: { summary: { monthly: unknown[] } }) => (
    <div data-testid="finance-chart-stub">
      <span>Динамика по месяцам</span>
      <span data-testid="chart-month-count">{summary.monthly.length}</span>
    </div>
  ),
}))

vi.mock('./finance/api', () => ({
  financeApi: { getSummary: vi.fn(), getIncomeCompliance: vi.fn() },
  // Phase 8 v2: the company-account balance KPI lives on /stats now.
  companyAccountApi: { getAccount: vi.fn() },
}))

import { StatsPage, receiverStatus } from './stats'

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
      expectedProjects: 5,
      submittedProjects: 2,
      laggingReceivers: 1,
      completeReceivers: 1,
      pendingProjects: 1,
      accruedProjects: 1,
    },
    receivers: [
      {
        userId: 'sr-lag',
        displayName: 'Senior Lag',
        role: 'SENIOR',
        expected: 3,
        submitted: 1,
        pendingCount: 1,
        accruedCount: 0,
        missingProjects: [
          {
            projectId: 'p-pending',
            name: 'EdNext LMS',
            companyName: 'EdNext Inc.',
            submitted: false,
            pendingValidation: true,
            accrued: false,
          },
          {
            projectId: 'p-missing',
            name: 'ShopCore Backend',
            companyName: 'ShopCore Ltd.',
            submitted: false,
            pendingValidation: false,
            accrued: false,
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
        accruedCount: 0,
        missingProjects: [],
      },
      // task-compliance-overview-pending-types: a receiver whose ONLY open
      // project is an unpaid company-booked obligation (accrued) — must render
      // as a non-lagging (amber) state, never the red «Нет приходов» false
      // alarm (the reported prod regression).
      {
        userId: 'drop-accrued',
        displayName: 'Drop Accrued',
        role: 'DROP',
        expected: 1,
        submitted: 0,
        pendingCount: 0,
        accruedCount: 1,
        missingProjects: [
          {
            projectId: 'p-accrued',
            name: 'GamingTec',
            companyName: 'GamingTec LLC',
            submitted: false,
            pendingValidation: false,
            accrued: true,
          },
        ],
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
    if (key === 'company-account')
      return {
        data: {
          walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
          confirmationThreshold: 12,
          balance: 4200,
          updatedAt: '2026-06-20T00:00:00.000Z',
        },
        isLoading: false,
      }
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
    async (role) => {
      setup(role)
      expect(screen.getByTestId('stats-finance-section')).toBeInTheDocument()
      expect(screen.getByText('Общий доход')).toBeInTheDocument()
      expect(screen.getByText('Расходы')).toBeInTheDocument()
      expect(screen.getByText('Зарплаты')).toBeInTheDocument()
      expect(screen.getByText('Net balance')).toBeInTheDocument()
      // FinanceChart is now lazy (React.lazy + Suspense) — its title resolves on
      // the next microtask even with the module mocked, so assert async.
      expect(await screen.findByText('Динамика по месяцам')).toBeInTheDocument()
    },
  )

  // Phase 8 v2: company USDT account balance moved from the Финансы page card to
  // this KPI strip — both ADMIN and ACCOUNTANT must see it.
  it.each<SessionUser['role']>(['ADMIN', 'ACCOUNTANT'])(
    '%s sees the company-account balance KPI',
    (role) => {
      setup(role)
      const kpi = screen.getByTestId('stats-company-account-balance')
      expect(kpi).toBeInTheDocument()
      expect(kpi).toHaveTextContent('4,200.00 USDT')
      expect(screen.getByText('Счёт компании · USDT')).toBeInTheDocument()
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

  // code-review (round 2, HIGH): sr-lag's pendingCount (1) covers only ONE of
  // its TWO missing projects (EdNext LMS is pendingValidation; ShopCore
  // Backend is genuinely missing — see `makeCompliance()`) — a PARTIAL
  // coverage, so `receiverStatus()` correctly returns 'lagging'. Before the
  // badge-gating fix, the row badge showed the reassuring amber «На
  // валидации» regardless (checking `pendingCount > 0` alone, never whether
  // it covered the WHOLE gap) — the exact contradiction (red row, amber
  // badge) the reviewer reproduced. It must now be red end-to-end.
  it('sr-lag (partial pendingCount coverage) renders RED end-to-end, never the amber «На валидации» badge', () => {
    setup('ADMIN')
    const row = screen.getByTestId('compliance-row-sr-lag')
    expect(row.className).toContain('border-l-red-500')
    expect(row.className).not.toContain('border-l-amber-500')
    const badge = within(row).getByText('2 без прихода')
    expect(badge.className).toContain('bg-red-500/10')
    expect(badge.className).toContain('text-red-500')
    expect(within(row).queryByText(/на валидации/i)).not.toBeInTheDocument()
  })

  // mutation-gate: when pendingCount FULLY covers the gap (a genuine
  // 'pending'/amber status) and equals exactly 1, the badge must say the
  // SINGULAR «На валидации», not «1 на валидации».
  it('a receiver whose singular pendingCount fully covers its gap shows singular «На валидации», amber end-to-end', () => {
    useAuthMock.mockReturnValue({ user: makeUser('ADMIN'), isLoading: false })
    useQueryMock.mockImplementation((opts: { queryKey?: unknown[] }) => {
      const key = opts?.queryKey?.[0]
      if (key === 'finance-summary') return { data: makeSummary(), isLoading: false }
      if (key === 'income-compliance')
        return {
          data: {
            month: '2026-06',
            totals: {
              expectedProjects: 1,
              submittedProjects: 0,
              laggingReceivers: 0,
              completeReceivers: 0,
              pendingProjects: 1,
              accruedProjects: 0,
            },
            receivers: [
              {
                userId: 'r-singular-pending',
                displayName: 'Singular Pending',
                role: 'SENIOR',
                expected: 1,
                submitted: 0,
                pendingCount: 1,
                accruedCount: 0,
                missingProjects: [],
              },
            ],
          } satisfies IncomeComplianceOverviewDto,
          isLoading: false,
        }
      return { data: undefined, isLoading: false }
    })
    render(<StatsPage />)
    const row = screen.getByTestId('compliance-row-r-singular-pending')
    expect(row.className).toContain('border-l-amber-500')
    const badge = within(row).getByText('На валидации')
    expect(badge.className).toContain('bg-amber-500/10')
    expect(badge.className).toContain('text-amber-500')
    expect(within(row).queryByText('1 на валидации')).not.toBeInTheDocument()
  })

  // code-review (round 2, HIGH): a receiver whose pending+accrued only
  // PARTIALLY covers the gap must be red end-to-end — accent AND badge — not
  // a red-bordered row with a reassuring amber "На валидации" badge (the
  // exact contradiction the reviewer reproduced: expected=3, submitted=0,
  // pendingCount=1 covers only 1 of 3 missing projects, so receiverStatus()
  // returns 'lagging', but the OLD badge code checked `pendingCount > 0`
  // alone — ignoring whether it covered the WHOLE gap — and showed amber
  // regardless).
  it('HIGH: partial pendingCount/accruedCount coverage renders RED end-to-end, never a contradictory amber badge', () => {
    useAuthMock.mockReturnValue({ user: makeUser('ADMIN'), isLoading: false })
    useQueryMock.mockImplementation((opts: { queryKey?: unknown[] }) => {
      const key = opts?.queryKey?.[0]
      if (key === 'finance-summary') return { data: makeSummary(), isLoading: false }
      if (key === 'income-compliance')
        return {
          data: {
            month: '2026-06',
            totals: {
              expectedProjects: 3,
              submittedProjects: 0,
              laggingReceivers: 1,
              completeReceivers: 0,
              pendingProjects: 1,
              accruedProjects: 0,
            },
            receivers: [
              {
                userId: 'r-partial',
                displayName: 'Partial Coverage',
                role: 'SENIOR',
                expected: 3,
                submitted: 0,
                pendingCount: 1,
                accruedCount: 0,
                missingProjects: [],
              },
            ],
          } satisfies IncomeComplianceOverviewDto,
          isLoading: false,
        }
      return { data: undefined, isLoading: false }
    })
    render(<StatsPage />)
    const row = screen.getByTestId('compliance-row-r-partial')
    // Accent: red, not amber.
    expect(row.className).toContain('border-l-red-500')
    expect(row.className).not.toContain('border-l-amber-500')
    // Badge: red «Нет приходов», never the amber «На валидации» the old
    // ungated code would have shown.
    const badge = within(row).getByText('Нет приходов')
    expect(badge.className).toContain('bg-red-500/10')
    expect(badge.className).toContain('text-red-500')
    expect(within(row).queryByText('На валидации')).not.toBeInTheDocument()
    expect(within(row).queryByText(/на валидации/)).not.toBeInTheDocument()
  })

  // task-compliance-overview-pending-types: the reported prod regression — a
  // receiver whose ONLY open project is an unpaid, company-booked obligation
  // must render as a non-lagging (amber «Начислено») row, NEVER the red «Нет
  // приходов» false alarm on someone who did nothing wrong.
  it('an accrued-only receiver renders amber «Начислено», never the red «Нет приходов» false alarm', () => {
    setup('ADMIN')
    const row = screen.getByTestId('compliance-row-drop-accrued')
    expect(row).toBeInTheDocument()
    // Amber left-accent border, NOT the red lagging one.
    expect(row.className).toContain('border-l-amber-500')
    expect(row.className).not.toContain('border-l-red-500')
    expect(screen.getByText('Начислено')).toBeInTheDocument()
    expect(screen.queryByText('Нет приходов')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('compliance-toggle-drop-accrued'))
    const detail = screen.getByTestId('compliance-detail-drop-accrued')
    expect(detail).toBeInTheDocument()
    expect(screen.getByText('GamingTec')).toBeInTheDocument()
    expect(screen.getByText('Начислено · ожидает выплаты')).toBeInTheDocument()
  })

  it('does NOT render the removed participants-balances section', () => {
    setup('ADMIN')
    expect(screen.queryByTestId('participants-balances-card')).not.toBeInTheDocument()
    expect(screen.queryByText('Балансы участников')).not.toBeInTheDocument()
  })

  // task-compliance-overview-pending-types (mutation-gate): every reachable
  // badge/colour combination in ONE payload — mixed pending+accrued, plural
  // accrued-only, plural pending-only, and the genuinely red «без прихода» /
  // «Нет приходов» states (never positively rendered by any fixture before
  // this task — the whole point of `accruedCount`/`pendingCount` is that
  // THESE are the only states that should ever be red).
  it('renders every badge/colour combination (mixed, plural accrued, plural pending, genuinely-lagging red)', () => {
    useAuthMock.mockReturnValue({ user: makeUser('ADMIN'), isLoading: false })
    useQueryMock.mockImplementation((opts: { queryKey?: unknown[] }) => {
      const key = opts?.queryKey?.[0]
      if (key === 'finance-summary') return { data: makeSummary(), isLoading: false }
      if (key === 'income-compliance')
        return {
          data: {
            month: '2026-06',
            totals: {
              expectedProjects: 9,
              submittedProjects: 0,
              laggingReceivers: 4,
              completeReceivers: 0,
              pendingProjects: 2,
              accruedProjects: 3,
            },
            receivers: [
              {
                userId: 'r-mixed',
                displayName: 'Mixed',
                role: 'SENIOR',
                expected: 2,
                submitted: 0,
                pendingCount: 1,
                accruedCount: 1,
                missingProjects: [
                  {
                    projectId: 'p-mixed-a',
                    name: 'Mixed A',
                    companyName: 'C',
                    submitted: false,
                    pendingValidation: true,
                    accrued: false,
                  },
                  {
                    projectId: 'p-mixed-b',
                    name: 'Mixed B',
                    companyName: 'C',
                    submitted: false,
                    pendingValidation: false,
                    accrued: true,
                  },
                ],
              },
              {
                userId: 'r-accrued-plural',
                displayName: 'Accrued Plural',
                role: 'DROP',
                expected: 2,
                submitted: 0,
                pendingCount: 0,
                accruedCount: 2,
                missingProjects: [],
              },
              {
                userId: 'r-pending-plural',
                displayName: 'Pending Plural',
                role: 'SENIOR',
                expected: 2,
                submitted: 0,
                pendingCount: 2,
                accruedCount: 0,
                missingProjects: [],
              },
              {
                userId: 'r-lagging-partial',
                displayName: 'Lagging Partial',
                role: 'SENIOR',
                expected: 2,
                submitted: 1,
                pendingCount: 0,
                accruedCount: 0,
                missingProjects: [],
              },
              {
                userId: 'r-lagging-zero',
                displayName: 'Lagging Zero',
                role: 'DROP',
                expected: 1,
                submitted: 0,
                pendingCount: 0,
                accruedCount: 0,
                missingProjects: [],
              },
            ],
          } satisfies IncomeComplianceOverviewDto,
          isLoading: false,
        }
      return { data: undefined, isLoading: false }
    })
    render(<StatsPage />)

    // Every assertion below is scoped to ITS OWN row via `within(...)` — a
    // mutation that merely SWAPS which receiver gets which text (e.g. the
    // submitted===0 ternary inverted) still leaves each string existing
    // exactly once globally, so an unscoped `screen.getByText` cannot catch
    // it; only checking WHICH row carries WHICH text can.

    // Mixed: badge sums pending+accrued ("2 в процессе"), amber accent + cls.
    const mixedRow = screen.getByTestId('compliance-row-r-mixed')
    expect(mixedRow.className).toContain('border-l-amber-500')
    const mixedBadge = within(mixedRow).getByText('2 в процессе')
    expect(mixedBadge.className).toContain('bg-amber-500/10')
    expect(mixedBadge.className).toContain('text-amber-500')

    // Plural accrued-only — text AND badge cls (mutation-gate: StringLiteral
    // on `cls` survives text-only assertions since `cls` never renders as
    // visible text).
    const accruedPluralRow = screen.getByTestId('compliance-row-r-accrued-plural')
    const accruedPluralBadge = within(accruedPluralRow).getByText('2 начислено')
    expect(accruedPluralBadge.className).toContain('bg-amber-500/10')
    expect(accruedPluralBadge.className).toContain('text-amber-500')

    // Plural pending-only — same, text AND cls.
    const pendingPluralRow = screen.getByTestId('compliance-row-r-pending-plural')
    const pendingPluralBadge = within(pendingPluralRow).getByText('2 на валидации')
    expect(pendingPluralBadge.className).toContain('bg-amber-500/10')
    expect(pendingPluralBadge.className).toContain('text-amber-500')

    // Genuinely lagging (no pending, no accrued): red accent + red badge
    // text+cls, scoped per row (the "some submitted" and "zero submitted"
    // wordings must land on the RIGHT receiver, not just exist somewhere).
    const laggingPartialRow = screen.getByTestId('compliance-row-r-lagging-partial')
    expect(laggingPartialRow.className).toContain('border-l-red-500')
    const laggingPartialBadge = within(laggingPartialRow).getByText('1 без прихода')
    expect(laggingPartialBadge.className).toContain('bg-red-500/10')
    expect(laggingPartialBadge.className).toContain('text-red-500')

    const laggingZeroRow = screen.getByTestId('compliance-row-r-lagging-zero')
    expect(laggingZeroRow.className).toContain('border-l-red-500')
    const laggingZeroBadge = within(laggingZeroRow).getByText('Нет приходов')
    expect(laggingZeroBadge.className).toContain('bg-red-500/10')
    expect(laggingZeroBadge.className).toContain('text-red-500')
    // Explicitly NOT the other row's wording — catches a submitted===0 vs
    // !==0 swap that a global `getByText` would miss.
    expect(within(laggingZeroRow).queryByText('1 без прихода')).not.toBeInTheDocument()
    expect(within(laggingPartialRow).queryByText('Нет приходов')).not.toBeInTheDocument()

    // Drawer-level per-project colour: expand Mixed and check BOTH the
    // amber-pendingValidation dot/text AND the amber-accrued dot/text via
    // their own data-testids (the dot has no text of its own to query by).
    fireEvent.click(screen.getByTestId('compliance-toggle-r-mixed'))
    const pendingText = screen.getByTestId('compliance-project-status-p-mixed-a')
    expect(pendingText).toHaveTextContent('На валидации')
    expect(pendingText.className).toContain('text-amber-500')
    expect(pendingText.className).not.toContain('text-red-500')
    const pendingDot = screen.getByTestId('compliance-project-dot-p-mixed-a')
    expect(pendingDot.className).toContain('bg-amber-500')
    expect(pendingDot.className).not.toContain('bg-red-500')

    const accruedText = screen.getByTestId('compliance-project-status-p-mixed-b')
    expect(accruedText).toHaveTextContent('Начислено · ожидает выплаты')
    expect(accruedText.className).toContain('text-amber-500')
    expect(accruedText.className).not.toContain('text-red-500')
    const accruedDot = screen.getByTestId('compliance-project-dot-p-mixed-b')
    expect(accruedDot.className).toContain('bg-amber-500')
    expect(accruedDot.className).not.toContain('bg-red-500')

    // Genuinely missing (red) drawer colour — the existing sr-lag fixture's
    // ShopCore Backend entry, expanded via a fresh render for isolation.
  })

  it('a genuinely-missing project (no pending, no accrued) renders the RED dot/text in the drawer', () => {
    setup('ADMIN')
    fireEvent.click(screen.getByTestId('compliance-toggle-sr-lag'))
    const missingText = screen.getByTestId('compliance-project-status-p-missing')
    expect(missingText).toHaveTextContent('Нет прихода')
    expect(missingText.className).toContain('text-red-500')
    expect(missingText.className).not.toContain('text-amber-500')
    const missingDot = screen.getByTestId('compliance-project-dot-p-missing')
    expect(missingDot.className).toContain('bg-red-500')
    expect(missingDot.className).not.toContain('bg-amber-500')
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
              accruedProjects: 0,
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

// backlog #132: `useMemo` used to sit AFTER `if (!user || !isPrivilegedViewer)
// return null` — a hook declared past an early-return guard. `useAuth()`
// genuinely starts as `{ user: null, isLoading: true }` on the real page's
// FIRST render (the /auth/me query hasn't resolved yet) and later re-renders
// the SAME mounted instance with a resolved, privileged user — exactly the
// loading→resolved transition `rerender()` reproduces below. A hook that
// only runs on SOME renders of a component is a Rules-of-Hooks violation;
// React throws "Rendered more hooks than during the previous render" the
// instant it happens, which took the whole page down via the app's error
// boundary in production (see project_ui_perf_pass memory) — no lint rule
// and no code review caught it; only a live render transition does, which
// is why this pins the transition itself, not just a single static render.
describe('StatsPage — Rules of Hooks (backlog #132 regression)', () => {
  function mockLoadingQueries() {
    useQueryMock.mockReturnValue({ data: undefined, isLoading: true })
  }

  function mockResolvedQueries() {
    useQueryMock.mockImplementation((opts: { queryKey?: unknown[] }) => {
      const key = opts?.queryKey?.[0]
      if (key === 'finance-summary') return { data: makeSummary(), isLoading: false }
      if (key === 'income-compliance') return { data: makeCompliance(), isLoading: false }
      return { data: undefined, isLoading: false }
    })
  }

  it('does not throw when auth resolves loading→ADMIN across renders of the same instance', () => {
    useAuthMock.mockReturnValue({ user: null, isLoading: true })
    mockLoadingQueries()
    const { rerender } = render(<StatsPage />)

    useAuthMock.mockReturnValue({ user: makeUser('ADMIN'), isLoading: false })
    mockResolvedQueries()

    expect(() => rerender(<StatsPage />)).not.toThrow()
    expect(screen.getByTestId('stats-page-admin')).toBeInTheDocument()
  })

  it('does not throw when auth resolves loading→ACCOUNTANT across renders of the same instance', () => {
    useAuthMock.mockReturnValue({ user: null, isLoading: true })
    mockLoadingQueries()
    const { rerender } = render(<StatsPage />)

    useAuthMock.mockReturnValue({ user: makeUser('ACCOUNTANT'), isLoading: false })
    mockResolvedQueries()

    expect(() => rerender(<StatsPage />)).not.toThrow()
    expect(screen.getByTestId('stats-page-accountant')).toBeInTheDocument()
  })

  // The guard is `!user || !isPrivilegedViewer` — the two cases below hit it
  // with exactly ONE side true each, which is what distinguishes `||` from
  // `&&`. Under `&&` a signed-in non-privileged viewer (JUNIOR/SENIOR/HR)
  // would fall through the guard and render the finance page — the exact
  // leak this early return exists to prevent. Both roots are asserted absent
  // because ADMIN and ACCOUNTANT render different testids.
  it.each(['JUNIOR', 'SENIOR', 'HR', 'DROP'] as const)(
    'renders nothing for a signed-in non-privileged viewer (%s)',
    (role) => {
      useAuthMock.mockReturnValue({ user: makeUser(role), isLoading: false })
      mockResolvedQueries()

      render(<StatsPage />)

      expect(screen.queryByTestId('stats-page-admin')).not.toBeInTheDocument()
      expect(screen.queryByTestId('stats-page-accountant')).not.toBeInTheDocument()
    },
  )

  it('renders nothing when there is no user at all (other side of the same guard)', () => {
    useAuthMock.mockReturnValue({ user: null, isLoading: false })
    mockResolvedQueries()

    render(<StatsPage />)

    expect(screen.queryByTestId('stats-page-admin')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stats-page-accountant')).not.toBeInTheDocument()
  })
})

// task-compliance-overview-pending-types (mutation-gate). `receiverStatus`
// decides the amber-vs-red false-positive-avoidance colour this task exists
// to fix — pinned directly (pure function), not only through rendered text,
// so the boundary arithmetic itself is provably exercised.
describe('receiverStatus (pure) — coverage boundary, mutation-gate', () => {
  function r(overrides: Partial<IncomeComplianceReceiverDto>): IncomeComplianceReceiverDto {
    return {
      userId: 'x',
      displayName: 'X',
      role: 'SENIOR',
      expected: 1,
      submitted: 0,
      pendingCount: 0,
      accruedCount: 0,
      missingProjects: [],
      ...overrides,
    }
  }

  it.each<[string, Partial<IncomeComplianceReceiverDto>, 'complete' | 'pending' | 'lagging']>([
    ['submitted === expected → complete', { expected: 1, submitted: 1 }, 'complete'],
    ['submitted > expected → still complete', { expected: 1, submitted: 2 }, 'complete'],
    [
      'no pending, no accrued at all → lagging',
      { expected: 3, submitted: 0, pendingCount: 0, accruedCount: 0 },
      'lagging',
    ],
    [
      'pending+accrued cover PART of the gap, not all of it → lagging',
      { expected: 3, submitted: 0, pendingCount: 1, accruedCount: 0 },
      'lagging',
    ],
    [
      'accruedCount ALONE exactly covers the gap → pending, never lagging (the reported regression)',
      { expected: 1, submitted: 0, pendingCount: 0, accruedCount: 1 },
      'pending',
    ],
    [
      'pendingCount ALONE exactly covers the gap → pending',
      { expected: 1, submitted: 0, pendingCount: 1, accruedCount: 0 },
      'pending',
    ],
    [
      'pendingCount + accruedCount SUM (not one alone) exactly covers a 2-project gap',
      { expected: 2, submitted: 0, pendingCount: 1, accruedCount: 1 },
      'pending',
    ],
    [
      'pendingCount + accruedCount SUM (not difference) covers a 3-project gap',
      { expected: 3, submitted: 0, pendingCount: 2, accruedCount: 1 },
      'pending',
    ],
    [
      'pending+accrued OVER-covers the gap → still pending, not lagging',
      { expected: 1, submitted: 0, pendingCount: 1, accruedCount: 1 },
      'pending',
    ],
    [
      // mutation-gate: submitted > 0 (not just 0) — proves the gap is
      // `expected - submitted`, not `expected + submitted` (which would give
      // the SAME number whenever submitted is 0, as every case above does).
      // Real gap = 3-1 = 2, exactly covered by pendingCount 2 → pending. The
      // `+` mutant would compute a gap of 4, NOT covered by 2 → lagging.
      'gap is expected MINUS submitted, not plus (submitted > 0 case)',
      { expected: 3, submitted: 1, pendingCount: 2, accruedCount: 0 },
      'pending',
    ],
  ])('%s', (_label, overrides, expectedStatus) => {
    expect(receiverStatus(r(overrides))).toBe(expectedStatus)
  })
})
