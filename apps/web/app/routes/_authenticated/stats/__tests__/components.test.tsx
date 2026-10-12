/* eslint-disable testing-library/no-node-access, testing-library/no-container --
   these tests pin classes/SVG icons that have no role or label to query by */
/**
 * Unit tests for the components/utils extracted out of the /stats route
 * (pure move). They pin the rendered contract of each piece in isolation so
 * the extraction stays coverage-neutral under the mutation gate.
 */
import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest'
import { render as rtlRender, screen, fireEvent, type RenderResult } from '@testing-library/react'
import type { ReactElement } from 'react'
import type { FinanceSummaryDto, IncomeComplianceReceiverDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

beforeAll(async () => {
  await loadCatalog('uk')
})

function render(ui: ReactElement): RenderResult {
  return rtlRender(ui, { wrapper: I18nTestProvider })
}

const useQueryMock = vi.fn()
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts: unknown) => useQueryMock(opts),
}))
vi.mock('../../finance/api', () => ({
  financeApi: { getSummary: vi.fn(), getIncomeCompliance: vi.fn() },
  companyAccountApi: { getAccount: vi.fn() },
}))

import { StatCard } from '../components/StatCard'
import { CompanyAndPartnersCard, fmtUsdt, shortAddress } from '../components/CompanyAndPartnersCard'
import {
  ComplianceKpi,
  ComplianceReceiverRow,
  IncomeComplianceSection,
  receiverInitials,
} from '../components/IncomeComplianceSection'
import { financeApi } from '../../finance/api'
import { computeExtraStats } from '../utils/computeExtraStats'

beforeEach(() => {
  useQueryMock.mockReset()
})

// ── fmtUsdt / shortAddress ────────────────────────────────────────────────────

describe('fmtUsdt', () => {
  it('always renders exactly two fraction digits with en-US grouping', () => {
    expect(fmtUsdt(4200)).toBe('4,200.00')
    expect(fmtUsdt(1.5)).toBe('1.50')
    expect(fmtUsdt(0.126)).toBe('0.13')
  })
})

describe('shortAddress', () => {
  it('truncates addresses longer than 12 chars to first 6 + … + last 4', () => {
    expect(shortAddress('0x1234567890abcdef')).toBe('0x1234…cdef')
  })
  it('keeps a 13-char address truncated (boundary: > 12)', () => {
    expect(shortAddress('0123456789abc')).toBe('012345…9abc')
  })
  it('returns an address of exactly 12 chars unchanged (boundary)', () => {
    expect(shortAddress('0123456789ab')).toBe('0123456789ab')
  })
  it('returns a short address unchanged', () => {
    expect(shortAddress('abc')).toBe('abc')
  })
})

// ── receiverInitials ──────────────────────────────────────────────────────────

describe('receiverInitials', () => {
  it.each<[string, string]>([
    ['Ivan Petrov', 'IP'],
    ['ivan petrov', 'IP'],
    ['ivan', 'IV'],
    ['a', 'A'],
    ['  Ivan   Petrov  ', 'IP'],
    ['Ivan Petrovych Sidorenko', 'IP'],
    ['', '—'],
    ['   ', '—'],
  ])('%j -> %j', (name, expected) => {
    expect(receiverInitials(name)).toBe(expected)
  })
})

// ── computeExtraStats ─────────────────────────────────────────────────────────

function summaryWith(monthly: FinanceSummaryDto['monthly']): FinanceSummaryDto {
  return {
    totalIncome: 0,
    totalExpenses: 0,
    totalSalaries: 0,
    netBalance: 0,
    adminBalances: [],
    dropBalances: [],
    monthly,
  }
}

describe('computeExtraStats', () => {
  it('returns null for an empty history', () => {
    expect(computeExtraStats(summaryWith([]))).toBeNull()
  })

  it('single month: no previous month, no trend', () => {
    const only = { month: '2026-06', income: 100, expenses: 10, salaries: 10, profit: 50 }
    const r = computeExtraStats(summaryWith([only]))!
    expect(r.lastMonth).toBe(only)
    expect(r.prevMonth).toBeNull()
    expect(r.incomeTrend).toBeNull()
    expect(r.profitMargin).toBe(50)
    expect(r.avgMonthlyIncome).toBe(100)
    expect(r.avgMonthlyProfit).toBe(50)
    expect(r.bestMonth).toBe(only)
  })

  it('computes trend vs the previous month, averages and best month', () => {
    const a = { month: '2026-04', income: 300, expenses: 0, salaries: 0, profit: 30 }
    const b = { month: '2026-05', income: 100, expenses: 0, salaries: 0, profit: 10 }
    const c = { month: '2026-06', income: 200, expenses: 0, salaries: 0, profit: 40 }
    const r = computeExtraStats(summaryWith([a, b, c]))!
    expect(r.lastMonth).toBe(c)
    expect(r.prevMonth).toBe(b)
    expect(r.incomeTrend).toBe(100) // (200-100)/100*100
    expect(r.profitMargin).toBe(20) // 40/200*100
    expect(r.avgMonthlyIncome).toBe(200) // 600/3
    expect(r.avgMonthlyProfit).toBeCloseTo(80 / 3)
    expect(r.bestMonth).toBe(a)
  })

  it('negative trend when income dropped', () => {
    const b = { month: '2026-05', income: 200, expenses: 0, salaries: 0, profit: 0 }
    const c = { month: '2026-06', income: 100, expenses: 0, salaries: 0, profit: 0 }
    expect(computeExtraStats(summaryWith([b, c]))!.incomeTrend).toBe(-50)
  })

  it('no trend when the previous month had zero income; no margin when last income is zero', () => {
    const b = { month: '2026-05', income: 0, expenses: 0, salaries: 0, profit: 0 }
    const c = { month: '2026-06', income: 0, expenses: 5, salaries: 0, profit: -5 }
    const r = computeExtraStats(summaryWith([b, c]))!
    expect(r.incomeTrend).toBeNull()
    expect(r.profitMargin).toBeNull()
  })

  it('does not reorder the input array when picking the best month', () => {
    const a = { month: '2026-04', income: 1, expenses: 0, salaries: 0, profit: 0 }
    const b = { month: '2026-05', income: 9, expenses: 0, salaries: 0, profit: 0 }
    const monthly = [a, b]
    computeExtraStats(summaryWith(monthly))
    expect(monthly).toEqual([a, b])
  })
})

// ── StatCard ──────────────────────────────────────────────────────────────────

describe('StatCard', () => {
  const base = { title: 'Title', hint: 'Hint', value: '$1.00', icon: <i data-testid="ico" /> }

  it('renders title, value, optional sub and testid', () => {
    render(<StatCard {...base} sub="Subtext" testId="kpi-x" />)
    expect(screen.getByTestId('kpi-x')).toBeInTheDocument()
    expect(screen.getByText('Title')).toBeInTheDocument()
    expect(screen.getByText('$1.00')).toBeInTheDocument()
    expect(screen.getByText('Subtext')).toBeInTheDocument()
    expect(screen.getByTestId('ico')).toBeInTheDocument()
  })

  it('omits the testid attribute and sub when not provided', () => {
    const { container } = render(<StatCard {...base} />)
    expect(container.querySelector('[data-testid]')?.getAttribute('data-testid')).toBe('ico')
    expect(screen.queryByText('Subtext')).not.toBeInTheDocument()
  })

  it.each<[NonNullable<Parameters<typeof StatCard>[0]['color']> | undefined, string, string]>([
    [undefined, 'text-foreground', 'bg-muted'],
    ['default', 'text-foreground', 'bg-muted'],
    ['green', 'text-green-500', 'bg-green-500/10'],
    ['red', 'text-red-500', 'bg-red-500/10'],
    ['blue', 'text-blue-500', 'bg-blue-500/10'],
    ['yellow', 'text-yellow-500', 'bg-yellow-500/10'],
    ['purple', 'text-purple-500', 'bg-purple-500/10'],
    ['cyan', 'text-cyan-500', 'bg-cyan-500/10'],
  ])('color %s -> value %s / icon box %s', (color, text, bg) => {
    render(<StatCard {...base} {...(color ? { color } : {})} />)
    const value = screen.getByText('$1.00')
    expect(value).toHaveClass('text-2xl', 'font-bold', 'tabular-nums', text)
    const iconBox = screen.getByTestId('ico').parentElement!
    expect(iconBox).toHaveClass('rounded-lg', 'p-2', 'shrink-0', bg, text)
  })

  it('positive trend: green, + sign, one decimal', () => {
    render(<StatCard {...base} trend={{ value: 12.345, label: 'vs prev' }} />)
    const t = screen.getByText('+12.3% vs prev')
    expect(t).toHaveClass('text-green-500')
    expect(t).not.toHaveClass('text-red-500')
  })

  it('zero trend counts as non-negative (+0.0%, green)', () => {
    render(<StatCard {...base} trend={{ value: 0, label: 'vs prev' }} />)
    expect(screen.getByText('+0.0% vs prev')).toHaveClass('text-green-500')
  })

  it('negative trend: red, no + sign', () => {
    render(<StatCard {...base} trend={{ value: -5.25, label: 'vs prev' }} />)
    const t = screen.getByText('-5.3% vs prev')
    expect(t).toHaveClass('text-red-500')
    expect(t).not.toHaveClass('text-green-500')
  })

  it('sub renders in a muted <p>; absent sub renders no extra paragraph', () => {
    const withSub = render(<StatCard {...base} sub="Subtext" />)
    expect(screen.getByText('Subtext')).toHaveClass('text-xs', 'text-muted-foreground')
    expect(withSub.container.querySelectorAll('p')).toHaveLength(3)
    withSub.unmount()
    const without = render(<StatCard {...base} />)
    expect(without.container.querySelectorAll('p')).toHaveLength(2)
  })

  it('trend line carries its layout classes', () => {
    render(<StatCard {...base} trend={{ value: 1, label: 'x' }} />)
    expect(screen.getByText('+1.0% x')).toHaveClass(
      'flex',
      'items-center',
      'gap-1',
      'text-xs',
      'font-medium',
    )
  })

  it('zero trend shows the UP arrow (boundary: >= 0)', () => {
    const { container } = render(<StatCard {...base} trend={{ value: 0, label: 'x' }} />)
    expect(container.querySelector('svg.lucide-trending-up')).not.toBeNull()
    expect(container.querySelector('svg.lucide-trending-down')).toBeNull()
  })

  it('shows the trend arrow matching the sign', () => {
    const up = render(<StatCard {...base} trend={{ value: 1, label: 'x' }} />)
    expect(up.container.querySelector('svg.lucide-trending-up')).not.toBeNull()
    expect(up.container.querySelector('svg.lucide-trending-down')).toBeNull()
    up.unmount()
    const down = render(<StatCard {...base} trend={{ value: -1, label: 'x' }} />)
    expect(down.container.querySelector('svg.lucide-trending-down')).not.toBeNull()
    expect(down.container.querySelector('svg.lucide-trending-up')).toBeNull()
  })
})

// ── CompanyAndPartnersCard ────────────────────────────────────────────────────

type Account = { balance: number; walletAddress: string | null } | undefined

function mockAccount(account: Account, isLoading = false) {
  useQueryMock.mockReturnValue({ data: account, isLoading })
}

function summaryBalances(balances: { id: string; name: string; balance: number }[]) {
  return {
    ...summaryWith([]),
    adminBalances: balances.map((b) => ({
      userId: b.id,
      displayName: b.name,
      balance: b.balance,
    })),
  }
}

describe('CompanyAndPartnersCard — company account section', () => {
  it('queries the company-account key', () => {
    mockAccount({ balance: 1, walletAddress: null })
    render(<CompanyAndPartnersCard summary={summaryWith([])} isAdmin={false} />)
    expect(useQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['company-account'], queryFn: expect.any(Function) }),
    )
  })

  it('renders the balance and the shortened wallet address', () => {
    mockAccount({ balance: 4200, walletAddress: '0x1234567890abcdef1234567890abcdef12345678' })
    render(<CompanyAndPartnersCard summary={summaryWith([])} isAdmin={false} />)
    const section = screen.getByTestId('stats-company-account-balance')
    expect(section).toHaveTextContent('4,200.00 USDT')
    expect(section).toHaveTextContent('0x1234…5678')
    expect(screen.queryByText('Гаманець не налаштовано')).not.toBeInTheDocument()
  })

  it('shows the not-configured note and an em dash when there is no account / wallet', () => {
    mockAccount(undefined)
    render(<CompanyAndPartnersCard summary={summaryWith([])} isAdmin={false} />)
    const section = screen.getByTestId('stats-company-account-balance')
    expect(section).toHaveTextContent('—')
    expect(screen.getByText('Гаманець не налаштовано')).toBeInTheDocument()
  })

  it('not-configured note when the account exists but the wallet is null', () => {
    mockAccount({ balance: 0, walletAddress: null })
    render(<CompanyAndPartnersCard summary={summaryWith([])} isAdmin={false} />)
    expect(screen.getByTestId('stats-company-account-balance')).toHaveTextContent('0.00 USDT')
    expect(screen.getByText('Гаманець не налаштовано')).toBeInTheDocument()
  })

  it('renders a skeleton (no balance, no note) while loading', () => {
    mockAccount(undefined, true)
    render(<CompanyAndPartnersCard summary={summaryWith([])} isAdmin={false} />)
    const section = screen.getByTestId('stats-company-account-balance')
    expect(section).not.toHaveTextContent('USDT —')
    expect(screen.queryByText('Гаманець не налаштовано')).not.toBeInTheDocument()
    expect(section.querySelectorAll('.animate-pulse')).toHaveLength(2)
  })
})

describe('CompanyAndPartnersCard — partner balances section', () => {
  beforeEach(() => mockAccount({ balance: 1, walletAddress: null }))

  it('is hidden for non-admin viewers even when balances exist', () => {
    render(
      <CompanyAndPartnersCard
        summary={summaryBalances([
          { id: 'a', name: 'Alpha', balance: 10 },
          { id: 'b', name: 'Beta', balance: 5 },
        ])}
        isAdmin={false}
      />,
    )
    expect(screen.queryByTestId('stats-partner-balances')).not.toBeInTheDocument()
    expect(screen.queryByText('Баланси партнерів')).not.toBeInTheDocument()
  })

  it('is hidden for an admin when there are no balances', () => {
    render(<CompanyAndPartnersCard summary={summaryBalances([])} isAdmin />)
    expect(screen.queryByTestId('stats-partner-balances')).not.toBeInTheDocument()
    expect(screen.queryByText('Баланси партнерів')).not.toBeInTheDocument()
  })

  it('sorts by balance desc, shows shares, totals, bar widths and leading colours', () => {
    render(
      <CompanyAndPartnersCard
        summary={summaryBalances([
          { id: 'b', name: 'Beta', balance: 1000 },
          { id: 'a', name: 'Alpha', balance: 3000 },
        ])}
        isAdmin
      />,
    )
    const list = screen.getByTestId('stats-partner-balances')
    // order: Alpha (3000) before Beta (1000)
    const text = list.textContent ?? ''
    expect(text.indexOf('Alpha')).toBeLessThan(text.indexOf('Beta'))
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('25%')).toBeInTheDocument()
    expect(screen.getByText('$3,000.00')).toBeInTheDocument()
    expect(screen.getByText('$1,000.00', { selector: 'span.font-bold' })).toBeInTheDocument()
    // total in header (no fraction digits)
    expect(screen.getByText('$4,000')).toBeInTheDocument()

    const bars = Array.from(list.querySelectorAll<HTMLElement>('.h-full.rounded-full'))
    expect(bars).toHaveLength(2)
    expect(bars[0]).toHaveClass('bg-violet-500', 'transition-all')
    expect(bars[0]).not.toHaveClass('bg-sky-500')
    expect(bars[0]!.style.width).toBe('75%')
    expect(bars[1]).toHaveClass('bg-sky-500')
    expect(bars[1]).not.toHaveClass('bg-violet-500')
    expect(bars[1]!.style.width).toBe('25%')

    const dots = Array.from(list.querySelectorAll<HTMLElement>('.h-2\\.5.w-2\\.5'))
    expect(dots[0]).toHaveClass('bg-violet-500', 'rounded-full', 'shrink-0')
    expect(dots[1]).toHaveClass('bg-sky-500')
  })

  it('rounds the header total to whole dollars', () => {
    render(
      <CompanyAndPartnersCard
        summary={summaryBalances([
          { id: 'a', name: 'Alpha', balance: 3000.4 },
          { id: 'b', name: 'Beta', balance: 1000.3 },
        ])}
        isAdmin
      />,
    )
    expect(screen.getByText('$4,001')).toBeInTheDocument()
  })

  it('clamps the bar width to at least 2%', () => {
    render(
      <CompanyAndPartnersCard
        summary={summaryBalances([
          { id: 'a', name: 'Alpha', balance: 1000 },
          { id: 'b', name: 'Beta', balance: 0 },
        ])}
        isAdmin
      />,
    )
    const bars = screen
      .getByTestId('stats-partner-balances')
      .querySelectorAll<HTMLElement>('.h-full.rounded-full')
    expect(bars[1]!.style.width).toBe('2%')
  })

  it('a negative balance renders «—» share, red amount and a magnitude bar', () => {
    render(
      <CompanyAndPartnersCard
        summary={summaryBalances([
          { id: 'a', name: 'Alpha', balance: 3000 },
          { id: 'b', name: 'Beta', balance: -1000 },
        ])}
        isAdmin
      />,
    )
    const neg = screen.getByText('$-1,000.00')
    expect(neg).toHaveClass('font-bold', 'tabular-nums', 'text-red-400')
    expect(neg).not.toHaveClass('text-foreground')
    const pos = screen.getByText('$3,000.00')
    expect(pos).toHaveClass('text-foreground')
    expect(pos).not.toHaveClass('text-red-400')
    expect(screen.getByText('75%')).toBeInTheDocument()
    const row = neg.parentElement!
    expect(row).toHaveTextContent('—')
    // total is the plain sum (3000 - 1000)
    expect(screen.getByText('$2,000')).toBeInTheDocument()
  })

  it('a zero balance is non-negative: grey-foreground amount and a real 0% share', () => {
    render(
      <CompanyAndPartnersCard
        summary={summaryBalances([
          { id: 'a', name: 'Alpha', balance: 100 },
          { id: 'b', name: 'Beta', balance: 0 },
        ])}
        isAdmin
      />,
    )
    const zero = screen.getByText('$0.00')
    expect(zero).toHaveClass('text-foreground')
    expect(zero).not.toHaveClass('text-red-400')
    expect(screen.getByText('0%')).toBeInTheDocument()
  })

  it('shows the transfer block (sender → receiver, debt = half the gap)', () => {
    render(
      <CompanyAndPartnersCard
        summary={summaryBalances([
          { id: 'a', name: 'Alpha', balance: 3000 },
          { id: 'c', name: 'Gamma', balance: 2000 },
          { id: 'b', name: 'Beta', balance: 1000 },
        ])}
        isAdmin
      />,
    )
    expect(screen.getByText('Для вирівнювання')).toBeInTheDocument()
    expect(screen.queryByText('Баланси вирівняно')).not.toBeInTheDocument()
    // debt = |3000 - 1000| / 2
    expect(screen.getByText('$1,000.00', { selector: 'span.text-lg' })).toBeInTheDocument()
    expect(screen.getByText('надсилає')).toBeInTheDocument()
    expect(screen.getByText('отримує')).toBeInTheDocument()
    expect(screen.getByText('USDT', { selector: 'span.text-\\[10px\\]' })).toBeInTheDocument()
    // sender = richest, receiver = poorest (title attr + initial letter)
    const sender = screen.getByTitle('Alpha')
    const receiver = screen.getByTitle('Beta')
    expect(sender.previousElementSibling).toHaveTextContent(/^A$/)
    expect(receiver.previousElementSibling).toHaveTextContent(/^B$/)
    expect(sender.previousElementSibling).toHaveClass('text-violet-400')
    expect(receiver.previousElementSibling).toHaveClass('text-sky-400')
    expect(screen.queryByTitle('Gamma')).not.toBeInTheDocument()
  })

  it('shows «Баланси вирівняно» when balances are equal', () => {
    render(
      <CompanyAndPartnersCard
        summary={summaryBalances([
          { id: 'a', name: 'Alpha', balance: 500 },
          { id: 'b', name: 'Beta', balance: 500 },
        ])}
        isAdmin
      />,
    )
    expect(screen.getByText('Баланси вирівняно')).toBeInTheDocument()
    expect(screen.getByText('Ніхто нікому не винен')).toBeInTheDocument()
    expect(screen.queryByText('Для вирівнювання')).not.toBeInTheDocument()
  })

  it('debt of exactly 0.01 still counts as settled (boundary: <= 0.01)', () => {
    render(
      <CompanyAndPartnersCard
        summary={summaryBalances([
          { id: 'a', name: 'Alpha', balance: 0.02 },
          { id: 'b', name: 'Beta', balance: 0 },
        ])}
        isAdmin
      />,
    )
    expect(screen.getByText('Баланси вирівняно')).toBeInTheDocument()
  })

  it('debt just above 0.01 is NOT settled', () => {
    render(
      <CompanyAndPartnersCard
        summary={summaryBalances([
          { id: 'a', name: 'Alpha', balance: 0.04 },
          { id: 'b', name: 'Beta', balance: 0 },
        ])}
        isAdmin
      />,
    )
    expect(screen.getByText('Для вирівнювання')).toBeInTheDocument()
    expect(screen.queryByText('Баланси вирівняно')).not.toBeInTheDocument()
  })

  it('a single partner has nobody to settle with: shows the settled block', () => {
    render(
      <CompanyAndPartnersCard
        summary={summaryBalances([{ id: 'a', name: 'Alpha', balance: 700 }])}
        isAdmin
      />,
    )
    expect(screen.getByText('Баланси вирівняно')).toBeInTheDocument()
    expect(screen.getByText('100%')).toBeInTheDocument()
  })

  it('two rows sharing a userId are never a transfer pair', () => {
    render(
      <CompanyAndPartnersCard
        summary={summaryBalances([
          { id: 'same', name: 'Alpha', balance: 900 },
          { id: 'same', name: 'Beta', balance: 100 },
        ])}
        isAdmin
      />,
    )
    expect(screen.getByText('Баланси вирівняно')).toBeInTheDocument()
    expect(screen.queryByText('Для вирівнювання')).not.toBeInTheDocument()
  })

  it('does not mutate the summary balances order', () => {
    const summary = summaryBalances([
      { id: 'b', name: 'Beta', balance: 1 },
      { id: 'a', name: 'Alpha', balance: 9 },
    ])
    render(<CompanyAndPartnersCard summary={summary} isAdmin />)
    expect(summary.adminBalances.map((b) => b.userId)).toEqual(['b', 'a'])
  })
})

// ── ComplianceReceiverRow ─────────────────────────────────────────────────────

function makeReceiver(
  over: Partial<IncomeComplianceReceiverDto> = {},
): IncomeComplianceReceiverDto {
  return {
    userId: 'r1',
    displayName: 'Ivan Petrov',
    role: 'SENIOR',
    expected: 4,
    submitted: 1,
    pendingCount: 0,
    accruedCount: 0,
    missingProjects: [
      {
        projectId: 'p1',
        name: 'Proj',
        companyName: 'Co',
        submitted: false,
        pendingValidation: false,
        accrued: false,
      },
    ],
    ...over,
  }
}

function rowParts(userId = 'r1') {
  const row = screen.getByTestId(`compliance-row-${userId}`)
  const dot = row.querySelector<HTMLElement>('span.h-2.w-2')!
  const bar = row.querySelector<HTMLElement>('.h-full.rounded-full')!
  return { row, dot, bar }
}

describe('ComplianceReceiverRow — status styling', () => {
  it('complete: green accent / dot / bar', () => {
    render(
      <ComplianceReceiverRow
        receiver={makeReceiver({ expected: 2, submitted: 2, missingProjects: [] })}
      />,
    )
    const { row, dot, bar } = rowParts()
    expect(row).toHaveClass('rounded-lg', 'border', 'border-l-2', 'bg-card', 'border-l-green-500')
    expect(dot).toHaveClass('rounded-full', 'shrink-0', 'bg-green-500')
    expect(bar).toHaveClass('transition-all', 'bg-green-500')
    expect(bar.style.width).toBe('100%')
  })

  it('pending: amber accent / dot / bar', () => {
    render(
      <ComplianceReceiverRow
        receiver={makeReceiver({ expected: 4, submitted: 1, pendingCount: 3 })}
      />,
    )
    const { row, dot, bar } = rowParts()
    expect(row).toHaveClass('border-l-amber-500')
    expect(dot).toHaveClass('bg-amber-500')
    expect(bar).toHaveClass('bg-amber-500')
    expect(bar.style.width).toBe('25%')
  })

  it('lagging: red accent / dot / bar', () => {
    render(<ComplianceReceiverRow receiver={makeReceiver()} />)
    const { row, dot, bar } = rowParts()
    expect(row).toHaveClass('border-l-red-500')
    expect(dot).toHaveClass('bg-red-500')
    expect(bar).toHaveClass('bg-red-500')
    expect(row).not.toHaveClass('border-l-green-500')
  })

  it('bar width is clamped to a minimum of 2%', () => {
    render(<ComplianceReceiverRow receiver={makeReceiver({ expected: 4, submitted: 0 })} />)
    expect(rowParts().bar.style.width).toBe('2%')
  })

  it('rounds the percentage (1 of 3 -> 33%)', () => {
    render(<ComplianceReceiverRow receiver={makeReceiver({ expected: 3, submitted: 1 })} />)
    expect(rowParts().bar.style.width).toBe('33%')
  })

  it('expected = 0 counts as fully covered (100%)', () => {
    render(
      <ComplianceReceiverRow
        receiver={makeReceiver({ expected: 0, submitted: 0, missingProjects: [] })}
      />,
    )
    expect(rowParts().bar.style.width).toBe('100%')
  })

  it('shows initials, name, submitted/expected', () => {
    render(<ComplianceReceiverRow receiver={makeReceiver()} />)
    const { row } = rowParts()
    expect(row).toHaveTextContent('IP')
    expect(screen.getByTitle('Ivan Petrov')).toBeInTheDocument()
    expect(row).toHaveTextContent('1/4')
  })
})

describe('ComplianceReceiverRow — expand toggle', () => {
  it('with missing projects: collapsed by default, toggles aria-expanded and the detail drawer', () => {
    render(<ComplianceReceiverRow receiver={makeReceiver()} />)
    const toggle = screen.getByTestId('compliance-toggle-r1')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveClass('cursor-pointer')
    expect(toggle).not.toHaveClass('cursor-default')
    expect(screen.queryByTestId('compliance-detail-r1')).not.toBeInTheDocument()
    expect(toggle.querySelector('svg.lucide-chevron-down')).not.toHaveClass('rotate-180')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('compliance-detail-r1')).toBeInTheDocument()
    expect(toggle.querySelector('svg.lucide-chevron-down')).toHaveClass('rotate-180')

    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })

  it('without missing projects: not expandable, no aria-expanded, check icon instead of chevron', () => {
    render(
      <ComplianceReceiverRow
        receiver={makeReceiver({ expected: 1, submitted: 1, missingProjects: [] })}
      />,
    )
    const toggle = screen.getByTestId('compliance-toggle-r1')
    expect(toggle).not.toHaveAttribute('aria-expanded')
    expect(toggle).toHaveClass('cursor-default')
    expect(toggle).not.toHaveClass('cursor-pointer')
    fireEvent.click(toggle)
    expect(screen.queryByTestId('compliance-detail-r1')).not.toBeInTheDocument()
    expect(toggle.querySelector('svg.lucide-chevron-down')).toBeNull()
    expect(
      toggle.querySelector('svg.lucide-circle-check-big, svg.lucide-check-circle-2'),
    ).not.toBeNull()
  })
})

// ── ComplianceKpi ─────────────────────────────────────────────────────────────

describe('ComplianceKpi', () => {
  it.each<['default' | 'green' | 'red' | 'amber', string]>([
    ['default', 'text-foreground'],
    ['green', 'text-green-500'],
    ['red', 'text-red-500'],
    ['amber', 'text-amber-500'],
  ])('colour %s -> value class %s', (color, cls) => {
    render(<ComplianceKpi label="Label" value="7" sub="Sub" color={color} />)
    expect(screen.getByText('7')).toHaveClass('text-2xl', 'font-bold', 'tabular-nums', 'mt-1', cls)
    expect(screen.getByText('Label')).toHaveClass(
      'text-[11px]',
      'uppercase',
      'tracking-wider',
      'text-muted-foreground',
    )
    expect(screen.getByText('Sub')).toHaveClass('text-xs', 'text-muted-foreground', 'mt-0.5')
  })
})

// ── ComplianceReceiverRow — toggle / drawer classes ───────────────────────────

describe('ComplianceReceiverRow — classes', () => {
  it('toggle button layout classes (clickable vs not)', () => {
    const { unmount } = render(<ComplianceReceiverRow receiver={makeReceiver()} />)
    expect(screen.getByTestId('compliance-toggle-r1')).toHaveClass(
      'w-full',
      'flex',
      'items-center',
      'gap-3',
      'px-3',
      'py-2.5',
      'text-left',
      'hover:bg-muted/30',
    )
    unmount()
    render(
      <ComplianceReceiverRow
        receiver={makeReceiver({ expected: 1, submitted: 1, missingProjects: [] })}
      />,
    )
    expect(screen.getByTestId('compliance-toggle-r1')).toHaveClass(
      'w-full',
      'flex',
      'items-center',
      'gap-3',
      'px-3',
      'py-2.5',
      'text-left',
    )
  })

  it('badge pill and chevron classes', () => {
    render(<ComplianceReceiverRow receiver={makeReceiver()} />)
    const toggle = screen.getByTestId('compliance-toggle-r1')
    const badge = screen.getByText('3 без доходу')
    expect(badge).toHaveClass(
      'rounded',
      'px-2',
      'py-0.5',
      'text-[11px]',
      'font-medium',
      'shrink-0',
      'bg-red-500/10',
      'text-red-500',
    )
    expect(toggle.querySelector('svg.lucide-chevron-down')).toHaveClass(
      'h-4',
      'w-4',
      'text-muted-foreground',
      'shrink-0',
      'transition-transform',
    )
  })

  it('drawer dot / status classes for missing vs in-progress projects', () => {
    render(
      <ComplianceReceiverRow
        receiver={makeReceiver({
          missingProjects: [
            {
              projectId: 'pm',
              name: 'Missing',
              companyName: 'Co',
              submitted: false,
              pendingValidation: false,
              accrued: false,
            },
            {
              projectId: 'pp',
              name: 'Pending',
              companyName: 'Co',
              submitted: false,
              pendingValidation: true,
              accrued: false,
            },
          ],
        })}
      />,
    )
    fireEvent.click(screen.getByTestId('compliance-toggle-r1'))
    expect(screen.getByTestId('compliance-project-dot-pm')).toHaveClass(
      'h-1.5',
      'w-1.5',
      'rounded-full',
      'shrink-0',
      'bg-red-500',
    )
    expect(screen.getByTestId('compliance-project-status-pm')).toHaveClass(
      'text-xs',
      'font-medium',
      'text-red-500',
    )
    expect(screen.getByTestId('compliance-project-dot-pp')).toHaveClass('bg-amber-500')
    expect(screen.getByTestId('compliance-project-status-pp')).toHaveClass(
      'text-xs',
      'font-medium',
      'text-amber-500',
    )
  })
})

// ── IncomeComplianceSection ───────────────────────────────────────────────────

function compliance(
  totals: Partial<{ expectedProjects: number; submittedProjects: number }>,
  receivers: IncomeComplianceReceiverDto[] = [],
) {
  return {
    month: '2026-06',
    totals: {
      expectedProjects: 5,
      submittedProjects: 2,
      laggingReceivers: 1,
      completeReceivers: 1,
      pendingProjects: 1,
      accruedProjects: 0,
      ...totals,
    },
    receivers,
  }
}

describe('IncomeComplianceSection', () => {
  it('wires its query: key, volatile staleTime and the finance API call', () => {
    useQueryMock.mockReturnValue({ data: undefined, isLoading: false, isError: false })
    render(<IncomeComplianceSection />)
    const opts = useQueryMock.mock.calls[0]![0] as {
      queryKey: unknown[]
      staleTime: number
      queryFn: () => unknown
    }
    expect(opts.queryKey).toEqual(['income-compliance'])
    expect(opts.staleTime).toBe(60_000)
    vi.mocked(financeApi.getIncomeCompliance).mockResolvedValueOnce(compliance({}))
    void opts.queryFn()
    expect(financeApi.getIncomeCompliance).toHaveBeenCalledTimes(1)
  })

  it('renders nothing but the heading when there is no data and no error', () => {
    useQueryMock.mockReturnValue({ data: undefined, isLoading: false, isError: false })
    render(<IncomeComplianceSection />)
    expect(screen.getByTestId('income-compliance-section')).toBeInTheDocument()
    expect(screen.queryByTestId('compliance-list')).not.toBeInTheDocument()
    expect(screen.queryByTestId('income-compliance-error')).not.toBeInTheDocument()
  })

  it('error state with a working retry button', () => {
    const refetch = vi.fn()
    useQueryMock.mockReturnValue({ isError: true, isLoading: false, refetch, isRefetching: false })
    render(<IncomeComplianceSection />)
    expect(screen.getByTestId('income-compliance-error')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('income-compliance-retry'))
    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('retry is disabled while refetching', () => {
    useQueryMock.mockReturnValue({
      isError: true,
      isLoading: false,
      refetch: vi.fn(),
      isRefetching: true,
    })
    render(<IncomeComplianceSection />)
    expect(screen.getByTestId('income-compliance-retry')).toBeDisabled()
  })

  it('coverage % and the X / N value in the first KPI (2 of 5 -> 40%)', () => {
    useQueryMock.mockReturnValue({ data: compliance({}), isLoading: false, isError: false })
    render(<IncomeComplianceSection />)
    expect(screen.getByText('2 / 5')).toBeInTheDocument()
    expect(screen.getByText(/покриття 40%/)).toBeInTheDocument()
  })

  it('coverage rounds (1 of 3 -> 33%)', () => {
    useQueryMock.mockReturnValue({
      data: compliance({ expectedProjects: 3, submittedProjects: 1 }),
      isLoading: false,
      isError: false,
    })
    render(<IncomeComplianceSection />)
    expect(screen.getByText(/покриття 33%/)).toBeInTheDocument()
  })

  it('no expected projects -> 100% coverage, not NaN', () => {
    useQueryMock.mockReturnValue({
      data: compliance({ expectedProjects: 0, submittedProjects: 0 }),
      isLoading: false,
      isError: false,
    })
    render(<IncomeComplianceSection />)
    expect(screen.getByText('0 / 0')).toBeInTheDocument()
    expect(screen.getByText(/покриття 100%/)).toBeInTheDocument()
  })
})
