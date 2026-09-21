/**
 * calendar.tsx — unit tests for `<Calendar>`'s custom month/year caption
 * (`CustomMonthCaption`) and its `showOutsideDays`/`selected` styling.
 *
 * task-i18n-stage3a (Task 1), fix-round 2 (MUT-1/MUT-2). ZERO tests existed
 * for this file before this round — the fix-round-1 mutation-gate follow-up
 * flagged it in "Remaining gap, itemized" (9 survived / 24 no-coverage on a
 * scoped `mutation:changed` run) as pre-existing debt from Steps 1-7.
 * `date-picker.test.tsx` exercises the DAY grid (via `DatePickerField`'s
 * popover) but never opens the month/year dropdown picker this file adds.
 */
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { Calendar } from '../calendar'

// A plain `Partial<Parameters<typeof Calendar>[0]>` blows up under
// `exactOptionalPropertyTypes` — `CalendarProps` is `DayPickerProps`, a
// discriminated union on `mode`/`required`, and `Partial<>` flattens that
// union into something the `PropsSingleRequired` member's literal
// `required: true` no longer satisfies. Named, concrete optional props
// sidestep the union entirely; this file only ever needs these three.
function renderCalendar(
  props: {
    showOutsideDays?: boolean
    selected?: Date
    onSelect?: (d: Date | undefined) => void
  } = {},
) {
  return render(
    <Calendar
      mode="single"
      defaultMonth={new Date(Date.UTC(2026, 8, 15))} // September 2026, UTC-safe
      {...props}
    />,
    { wrapper: I18nTestProvider },
  )
}

const uaMonthFull = (m: number) =>
  new Intl.DateTimeFormat('uk-UA', { month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, m, 1)),
  )
const uaMonthShort = (m: number) =>
  new Intl.DateTimeFormat('uk-UA', { month: 'short', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2000, m, 1)),
  )

describe('Calendar — month/year picker caption (MUT-1/MUT-2)', () => {
  it('shows the full month name and year for the displayed month (uk locale)', async () => {
    await loadCatalog('uk')
    renderCalendar()
    expect(screen.getByText(uaMonthFull(8))).toBeInTheDocument() // September = index 8
    expect(screen.getByText('2026')).toBeInTheDocument()
  })

  it('shows English month names for a fresh render with the en catalog active (INTL_TAG.en)', async () => {
    await loadCatalog('en')
    renderCalendar()
    const enMonth = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(
      new Date(Date.UTC(2026, 8, 1)),
    )
    expect(screen.getByText(enMonth)).toBeInTheDocument()
  })

  // MUT-1 (fix-round 2): the test above renders FRESH under each locale, so
  // it would pass identically even if `monthsShort`/`monthsFull`'s useMemo
  // deps were mutated from `[locale]` to `[]` — the memo would simply run
  // once on mount either way. This one switches the locale on an
  // ALREADY-MOUNTED picker, which only re-derives the month-name arrays if
  // the dependency actually re-triggers the memo.
  it('recomputes month names when the locale changes on an already-mounted picker (useMemo [locale] dep)', async () => {
    await loadCatalog('uk')
    const user = userEvent.setup()
    renderCalendar()
    expect(screen.getByText(uaMonthFull(8))).toBeInTheDocument()

    await act(async () => {
      await loadCatalog('en')
    })
    const enMonthFull = new Intl.DateTimeFormat('en-GB', {
      month: 'long',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(2026, 8, 1)))
    expect(screen.getByText(enMonthFull)).toBeInTheDocument()
    expect(screen.queryByText(uaMonthFull(8))).not.toBeInTheDocument()

    // `monthsShort` — open the dropdown post-switch; a stale (uk) memo
    // would still show the Ukrainian short names here.
    await user.click(screen.getByText(enMonthFull))
    const enMonthShort = new Intl.DateTimeFormat('en-GB', {
      month: 'short',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(2026, 0, 1)))
    expect(screen.getByText(enMonthShort)).toBeInTheDocument()
    expect(screen.queryByText(uaMonthShort(0))).not.toBeInTheDocument()
  })

  it('opens the month dropdown on click, showing all 12 short month names', async () => {
    await loadCatalog('uk')
    const user = userEvent.setup()
    renderCalendar()

    await user.click(screen.getByText(uaMonthFull(8)))
    for (let m = 0; m < 12; m++) {
      expect(screen.getByText(uaMonthShort(m))).toBeInTheDocument()
    }
  })

  it('clicking the month button AGAIN (same picker) closes the dropdown instead of reopening it', async () => {
    await loadCatalog('uk')
    const user = userEvent.setup()
    renderCalendar()

    const monthBtn = screen.getByText(uaMonthFull(8))
    await user.click(monthBtn)
    expect(screen.getByText(uaMonthShort(0))).toBeInTheDocument()
    await user.click(monthBtn)
    expect(screen.queryByText(uaMonthShort(0))).not.toBeInTheDocument()
  })

  it('highlights the CURRENTLY displayed month in the dropdown, not any other', async () => {
    await loadCatalog('uk')
    const user = userEvent.setup()
    renderCalendar()

    await user.click(screen.getByText(uaMonthFull(8)))
    // September (idx 8) is displayed — its OWN short-name button is highlighted.
    expect(screen.getByText(uaMonthShort(8))).toHaveClass('bg-primary')
    expect(screen.getByText(uaMonthShort(0))).not.toHaveClass('bg-primary')
  })

  it('selecting a month from the dropdown navigates the caption and closes the picker', async () => {
    await loadCatalog('uk')
    const user = userEvent.setup()
    renderCalendar()

    await user.click(screen.getByText(uaMonthFull(8)))
    await user.click(screen.getByText(uaMonthShort(0))) // January

    expect(screen.getByText(uaMonthFull(0))).toBeInTheDocument()
    expect(screen.queryByText(uaMonthShort(5))).not.toBeInTheDocument() // dropdown closed
  })

  it('opens the year dropdown on click, and highlights the currently displayed year', async () => {
    await loadCatalog('uk')
    const user = userEvent.setup()
    renderCalendar()

    await user.click(screen.getByText('2026'))
    // Two buttons now share the name "2026": the caption trigger itself
    // (still showing the current year, untouched by opening the dropdown)
    // and the dropdown's own year-grid entry — only the LATTER carries the
    // highlight class, so disambiguate by class rather than name.
    const yearButtons = screen.getAllByRole('button', { name: '2026' })
    const currentYearBtn = yearButtons.find((btn) => btn.className.includes('rounded'))
    expect(currentYearBtn).toHaveClass('bg-primary')
    // A neighbouring year is present but NOT highlighted.
    expect(screen.getByRole('button', { name: '2025' })).not.toHaveClass('bg-primary')
  })

  // MUT-1 (fix-round 2): mirrors "clicking the month button AGAIN closes the
  // dropdown" — that test only exercises the MONTH button's own toggle
  // ternary (`p === 'month' ? null : 'month'`); the YEAR button has its own,
  // textually-identical-but-separate one (`p === 'year' ? null : 'year'`),
  // never exercised by a second click.
  it('clicking the year button AGAIN (same picker) closes the dropdown instead of reopening it', async () => {
    await loadCatalog('uk')
    const user = userEvent.setup()
    renderCalendar()

    const yearBtn = screen.getByText('2026')
    await user.click(yearBtn)
    expect(screen.getByRole('button', { name: '2025' })).toBeInTheDocument()
    await user.click(yearBtn)
    expect(screen.queryByRole('button', { name: '2025' })).not.toBeInTheDocument()
  })

  it('selecting a year from the dropdown navigates the caption and closes the picker', async () => {
    await loadCatalog('uk')
    const user = userEvent.setup()
    renderCalendar()

    await user.click(screen.getByText('2026'))
    await user.click(screen.getByRole('button', { name: '2024' }))

    expect(screen.getByText('2024')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '2025' })).not.toBeInTheDocument()
  })
})

describe('Calendar — showOutsideDays / selected styling (MUT-1)', () => {
  it('renders outside-month days by default (showOutsideDays defaults true)', async () => {
    await loadCatalog('uk')
    const { container } = renderCalendar()
    // react-day-picker tags adjacent-month cells with the "day-outside" class
    // (this file's own `outside` classNames entry), AND — by default
    // (showOutsideDays !== false) — renders a real, clickable `<button>`
    // inside each one (the complementary "hides" test below pins the
    // false case, where the wrapper stays but the button disappears).
    // Neither the class nor the presence of a nested button is reachable
    // via an accessible query, hence the raw `container` access below.
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    expect(container.querySelectorAll('.day-outside').length).toBeGreaterThan(0)
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    expect(container.querySelectorAll('.day-outside button').length).toBeGreaterThan(0)
  })

  it('hides outside-month days when showOutsideDays={false}', async () => {
    await loadCatalog('uk')
    const { container } = renderCalendar({ showOutsideDays: false })
    // react-day-picker keeps the grid rectangular: the outside-day `<td>`
    // wrapper (and its `.day-outside` class) still renders either way — what
    // `showOutsideDays={false}` actually changes is that the day becomes
    // react-day-picker's OWN `hidden` modifier, which skips rendering the
    // interactive `<button>` inside it entirely (see react-day-picker's
    // `DayPicker.js`: `!modifiers.hidden && isInteractive ? <DayButton> :
    // ...`). That absence of a button is the real, user-visible "hidden".
    // eslint-disable-next-line testing-library/no-container, testing-library/no-node-access
    expect(container.querySelectorAll('.day-outside button').length).toBe(0)
  })

  it('applies the "selected" className to the chosen day', async () => {
    await loadCatalog('uk')
    renderCalendar({
      selected: new Date(Date.UTC(2026, 8, 15)),
      onSelect: vi.fn(),
    })
    // react-day-picker puts `aria-selected` (and this file's `selected`
    // classNames entry) on the `<td role="gridcell">` wrapper, NOT on the
    // inner `<button>` — the button itself carries no selection attribute.
    const selectedCell = screen.getByRole('gridcell', { selected: true })
    expect(selectedCell).toHaveClass('bg-primary')
  })
})
