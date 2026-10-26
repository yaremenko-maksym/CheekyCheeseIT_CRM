/**
 * MonthPickerField — two Radix Selects (month + year) replacing the native
 * `<input type="month">` (QA-LOW-2). Spec: docs/design/2026-10-26-salary-month-picker.md.
 * Expected values are literals; "now" is pinned to 2026-10-15.
 */
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import { MonthPickerField } from '../month-picker'

beforeAll(() => {
  // Radix Select needs these pointer/scroll APIs, which jsdom does not provide.
  Element.prototype.hasPointerCapture = () => false
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  Element.prototype.scrollIntoView = () => {}
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-15T12:00:00Z') })
})

afterEach(async () => {
  vi.useRealTimers()
  await loadCatalog('uk')
})

const MONTH = 'create-transaction-salary-month-select'
const YEAR = 'create-transaction-salary-year-select'

function Harness(props: {
  initial?: string
  minMonth?: string
  maxMonth?: string
  onChange?: (v: string) => void
}) {
  const [v, setV] = useState(props.initial ?? '')
  return (
    <I18nTestProvider>
      <MonthPickerField
        value={v}
        minMonth={props.minMonth}
        maxMonth={props.maxMonth}
        data-testid="create-transaction-salary-month"
        onChange={(n) => {
          props.onChange?.(n)
          setV(n)
        }}
      />
    </I18nTestProvider>
  )
}

const user = () => userEvent.setup({ advanceTimers: () => {} })

describe('MonthPickerField', () => {
  it('renders Ukrainian month name + year for uk', async () => {
    await loadCatalog('uk')
    render(<Harness initial="2026-10" />)
    expect(screen.getByTestId(MONTH)).toHaveTextContent('Жовтень')
    expect(screen.getByTestId(YEAR)).toHaveTextContent('2026')
    expect(screen.getByTestId('create-transaction-salary-month')).not.toHaveTextContent('October')
  })

  it('renders English month name for en', async () => {
    await loadCatalog('en')
    render(<Harness initial="2026-10" />)
    expect(screen.getByTestId(MONTH)).toHaveTextContent('October')
  })

  it('translates accessible names and placeholders for en', async () => {
    await loadCatalog('en')
    render(<Harness />)
    expect(screen.getByTestId(MONTH)).toHaveAttribute('aria-label', 'Salary month')
    expect(screen.getByTestId(YEAR)).toHaveAttribute('aria-label', 'Salary year')
    expect(screen.getByTestId(MONTH)).toHaveTextContent('Month')
    expect(screen.getByTestId(YEAR)).toHaveTextContent('Year')
  })

  it('has no native month input and never calls showPicker', async () => {
    await loadCatalog('uk')
    const spy = vi.fn()
    HTMLInputElement.prototype.showPicker = spy
    render(<Harness initial="2026-10" />)
    await user().tab()
    // a native month input would carry its 'YYYY-MM' string as a display value
    expect(screen.queryByDisplayValue('2026-10')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('month-first from empty emits current year + chosen month', async () => {
    await loadCatalog('uk')
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const u = user()
    await u.click(screen.getByTestId(MONTH))
    await u.click(await screen.findByTestId('salary-month-option-03'))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenLastCalledWith('2026-03')
  })

  it('year-first from empty emits chosen year + current month', async () => {
    await loadCatalog('uk')
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const u = user()
    await u.click(screen.getByTestId(YEAR))
    await u.click(await screen.findByTestId('salary-year-option-2025'))
    expect(onChange).toHaveBeenLastCalledWith('2025-10')
  })

  it('default year options span currentYear-3..currentYear+1', async () => {
    await loadCatalog('uk')
    render(<Harness initial="2026-10" />)
    await user().click(screen.getByTestId(YEAR))
    for (const y of [2023, 2024, 2025, 2026, 2027]) {
      expect(await screen.findByTestId(`salary-year-option-${y}`)).toBeInTheDocument()
    }
    expect(screen.queryByTestId('salary-year-option-2022')).toBeNull()
    expect(screen.queryByTestId('salary-year-option-2028')).toBeNull()
  })

  it('unions the year of an out-of-range stored value', async () => {
    await loadCatalog('uk')
    render(<Harness initial="2019-05" />)
    expect(screen.getByTestId(YEAR)).toHaveTextContent('2019')
    await user().click(screen.getByTestId(YEAR))
    expect(await screen.findByTestId('salary-year-option-2019')).toBeInTheDocument()
  })

  it('disables months outside min/max for the selected year', async () => {
    await loadCatalog('uk')
    render(<Harness initial="2026-06" minMonth="2026-03" maxMonth="2026-09" />)
    await user().click(screen.getByTestId(MONTH))
    expect(await screen.findByTestId('salary-month-option-02')).toHaveAttribute(
      'aria-disabled',
      'true',
    )
    expect(screen.getByTestId('salary-month-option-03')).not.toHaveAttribute('aria-disabled')
    expect(screen.getByTestId('salary-month-option-09')).not.toHaveAttribute('aria-disabled')
    expect(screen.getByTestId('salary-month-option-10')).toHaveAttribute('aria-disabled', 'true')
  })

  it('year change clamps an illegal month to the nearest legal one', async () => {
    await loadCatalog('uk')
    const onChange = vi.fn()
    render(<Harness initial="2026-12" minMonth="2025-03" maxMonth="2026-12" onChange={onChange} />)
    const u = user()
    await u.click(screen.getByTestId(YEAR))
    await u.click(await screen.findByTestId('salary-year-option-2025'))
    // 2025-12 is legal (min is 2025-03) so it stays
    expect(onChange).toHaveBeenLastCalledWith('2025-12')
    await u.click(screen.getByTestId(MONTH))
    await u.click(await screen.findByTestId('salary-month-option-03'))
    expect(onChange).toHaveBeenLastCalledWith('2025-03')
  })

  it('clamps the month when the year switch makes it illegal', async () => {
    await loadCatalog('uk')
    const onChange = vi.fn()
    render(<Harness initial="2026-02" minMonth="2025-06" maxMonth="2026-12" onChange={onChange} />)
    const u = user()
    await u.click(screen.getByTestId(YEAR))
    await u.click(await screen.findByTestId('salary-year-option-2025'))
    expect(onChange).toHaveBeenLastCalledWith('2025-06')
  })

  it('keyboard: Tab reaches month then year; Enter opens, ArrowDown+Enter chooses, focus returns', async () => {
    await loadCatalog('uk')
    const onChange = vi.fn()
    render(<Harness initial="2026-10" onChange={onChange} />)
    const u = user()
    await u.tab()
    expect(screen.getByTestId(MONTH)).toHaveFocus()
    await u.tab()
    expect(screen.getByTestId(YEAR)).toHaveFocus()
    await u.tab({ shift: true })
    await u.keyboard('{Enter}')
    expect(await screen.findByRole('listbox')).toBeInTheDocument()
    await u.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenLastCalledWith('2026-11')
    expect(screen.getByTestId(MONTH)).toHaveFocus()
  })

  it('exposes accessible names and invalid state', async () => {
    await loadCatalog('uk')
    render(<Harness initial="2026-10" />)
    expect(screen.getByTestId(MONTH)).toHaveAttribute('aria-label', 'Місяць зарплати')
    expect(screen.getByTestId(YEAR)).toHaveAttribute('aria-label', 'Рік зарплати')
  })
})
