/**
 * `FinanceChart` — exact-text pins for the catalog-driven labels (task-i18n stage 6A).
 *
 * The chart used to key its data by Russian words (`Доход`, `Расходы`, …) and show those keys
 * as the tooltip's series names. The keys are now stable identifiers and the visible names go
 * through the catalog, so this file reads what an admin actually sees: the title, the mode
 * select's options, the swatch colour per mode, and the tooltip's series names.
 */
import { render as rtlRender, screen, within, type RenderOptions } from '@testing-library/react'
import type { ReactElement } from 'react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ChartTooltip, FinanceChart } from './FinanceChart'

// Recharts measures a 0x0 container under happy-dom and renders nothing, so the data keys and
// the Y-axis domain the component computes would be unobservable. Thin stand-ins expose them.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  ReferenceLine: () => null,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: ({ domain }: { domain?: [number, number] }) => (
    <div data-testid="y-axis" data-domain={JSON.stringify(domain)} />
  ),
  Bar: ({ dataKey, fill }: { dataKey: string; fill: string }) => (
    <div data-testid="bar" data-key={dataKey} data-fill={fill} />
  ),
}))

function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: I18nTestProvider, ...options })
}

const SUMMARY = {
  monthly: [
    { month: '2026-01', income: 100, expenses: 40, salaries: 30, profit: 30 },
    { month: '2026-02', income: 200, expenses: 50, salaries: 60, profit: 90 },
  ],
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('FinanceChart — labels', () => {
  it('shows the title and the default «Дохід» mode with its swatch colour', () => {
    render(<FinanceChart summary={SUMMARY} />)

    expect(screen.getByText('Динаміка за місяцями')).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toHaveTextContent('Дохід')
    expect(screen.getByTestId('finance-chart-swatch')).toHaveStyle({ background: '#22c55e' })
  })

  it('lists the four modes by their uk labels, each switching the swatch colour', async () => {
    const user = userEvent.setup()
    render(<FinanceChart summary={SUMMARY} />)

    const expected: [string, string][] = [
      ['Прибуток', '#06b6d4'],
      ['Витрати', '#f97316'],
      ['Зарплати', '#a855f7'],
      ['Дохід', '#22c55e'],
    ]
    for (const [label, color] of expected) {
      await user.click(screen.getByRole('combobox'))
      const listbox = await screen.findByRole('listbox')
      expect(within(listbox).getAllByRole('option')).toHaveLength(4)
      await user.click(within(listbox).getByRole('option', { name: label }))
      expect(screen.getByRole('combobox')).toHaveTextContent(label)
      expect(screen.getByTestId('finance-chart-swatch')).toHaveStyle({ background: color })
    }
  })
})

describe('FinanceChart — plotted series', () => {
  it('plots the matching data field and Y domain for each mode', async () => {
    const user = userEvent.setup()
    render(<FinanceChart summary={SUMMARY} />)

    // income [100, 200] → pad 10 → domain [0, 210]
    expect(screen.getAllByTestId('bar').at(-1)).toHaveAttribute('data-key', 'income')
    expect(screen.getAllByTestId('y-axis')[0]).toHaveAttribute('data-domain', '[0,210]')

    const expected: [string, string, string][] = [
      ['Прибуток', 'profit', '[0,96]'], // [30, 90] → pad 6 → ceil(96)
      ['Витрати', 'expenses', '[0,51]'], // [40, 50] → pad 1 → 51
      ['Зарплати', 'salaries', '[0,63]'], // [30, 60] → pad 3 → 63
    ]
    for (const [label, key, domain] of expected) {
      await user.click(screen.getByRole('combobox'))
      await user.click(await screen.findByRole('option', { name: label }))
      expect(screen.getAllByTestId('bar').at(-1)).toHaveAttribute('data-key', key)
      expect(screen.getAllByTestId('y-axis')[0]).toHaveAttribute('data-domain', domain)
    }
  })
})

describe('ChartTooltip — series names', () => {
  it('renders the catalog label for a known series, not its data key', () => {
    render(
      <ChartTooltip
        active
        label="2026-02"
        payload={[
          { dataKey: 'income', value: 1234.5, color: '#22c55e' },
          { dataKey: 'salaries', value: 60, color: '#a855f7' },
          { dataKey: 'profit', value: 30, color: '#06b6d4' },
          { dataKey: 'expenses', value: 40, color: '#f97316' },
        ]}
      />,
    )

    expect(screen.getByText('2026-02')).toBeInTheDocument()
    expect(screen.getByText('Дохід')).toBeInTheDocument()
    expect(screen.getByText('Зарплати')).toBeInTheDocument()
    expect(screen.getByText('Прибуток')).toBeInTheDocument()
    expect(screen.getByText('Витрати')).toBeInTheDocument()
    expect(screen.queryByText('income')).not.toBeInTheDocument()
    expect(screen.queryByText('salaries')).not.toBeInTheDocument()
    expect(screen.getByText('$1,234.50')).toBeInTheDocument()
  })

  it('falls back to the raw data key for a series it does not know', () => {
    render(<ChartTooltip active payload={[{ dataKey: 'mystery', value: 1, color: '#000' }]} />)

    expect(screen.getByText('mystery')).toBeInTheDocument()
  })

  it('renders nothing when inactive', () => {
    render(
      <ChartTooltip active={false} payload={[{ dataKey: 'income', value: 1, color: '#000' }]} />,
    )

    expect(screen.queryByText('Дохід')).not.toBeInTheDocument()
  })
})
