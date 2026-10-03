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
import { beforeEach, describe, expect, it } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { ChartTooltip, FinanceChart } from './FinanceChart'

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
  it('shows the title and the default «Прихід» mode with its swatch colour', () => {
    render(<FinanceChart summary={SUMMARY} />)

    expect(screen.getByText('Динаміка за місяцями')).toBeInTheDocument()
    expect(screen.getByRole('combobox')).toHaveTextContent('Прихід')
    expect(screen.getByTestId('finance-chart-swatch')).toHaveStyle({ background: '#22c55e' })
  })

  it('lists the four modes by their uk labels, each switching the swatch colour', async () => {
    const user = userEvent.setup()
    render(<FinanceChart summary={SUMMARY} />)

    const expected: [string, string][] = [
      ['Прибуток', '#06b6d4'],
      ['Витрати', '#f97316'],
      ['Зарплати', '#a855f7'],
      ['Прихід', '#22c55e'],
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

describe('ChartTooltip — series names', () => {
  it('renders the catalog label for a known series, not its data key', () => {
    render(
      <ChartTooltip
        active
        label="2026-02"
        payload={[
          { dataKey: 'income', value: 1234.5, color: '#22c55e' },
          { dataKey: 'salaries', value: 60, color: '#a855f7' },
        ]}
      />,
    )

    expect(screen.getByText('2026-02')).toBeInTheDocument()
    expect(screen.getByText('Прихід')).toBeInTheDocument()
    expect(screen.getByText('Зарплати')).toBeInTheDocument()
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

    expect(screen.queryByText('Прихід')).not.toBeInTheDocument()
  })
})
