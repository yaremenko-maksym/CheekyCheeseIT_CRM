/**
 * date-picker.test.tsx — task-drop-payout-currency (owner addendum, 2026-08)
 * + calendar-opens-on-selected-month regression (2026-09-01).
 *
 * `DatePickerField` gained optional `minDate`/`maxDate` bounds, rendered as
 * a react-day-picker `disabled` matcher so out-of-range days are greyed out
 * AND genuinely unselectable in the calendar itself — not just a submit-time
 * validation. This pins that behaviour directly against the component (the
 * SettleSeniorPayoutDialog tests only exercise the DEFAULT value, never the
 * bounds), and that every EXISTING caller (no minDate/maxDate passed) keeps
 * its unrestricted picker byte-for-byte.
 *
 * `showOutsideDays` (default true) renders leading/trailing days from the
 * ADJACENT month too, so a locator matching just the day NUMBER is ambiguous
 * (August's grid also shows a September "4" as an outside cell). Each day
 * button's own `aria-label` is the FULL localized date (e.g. "вторник, 4
 * августа 2026 г."), so matching on "<day> августа" — scoped to the open
 * popover panel via `within` — is both unambiguous AND a proper Testing
 * Library semantic query (no raw node access).
 *
 * Frozen "today" (2026-09-01 incident): this whole file used to run with the
 * REAL system clock. Every fixture below is dated August 2026, and the suite
 * passed for months purely because CI's real "today" also happened to be
 * August — it never actually verified which month the calendar opens on. The
 * day the real month rolled over to September, all five tests went red with
 * zero code changes. The underlying component bug (calendar always opened on
 * "today", never on the selected value) had been there the whole time,
 * unobserved.
 *
 * Fix has two parts:
 *  1. Product (`date-picker.tsx`): pass `defaultMonth={selected ?? new
 *     Date()}` to the Calendar — react-day-picker's own `defaultMonth`
 *     default is "the current month" per its docs, it does NOT infer the
 *     month from `selected`.
 *  2. Test: freeze "today" via `vi.setSystemTime()` (Date-only mock — no
 *     `vi.useFakeTimers()`, so Radix Popover's real `requestAnimationFrame`
 *     positioning and userEvent's own internals are untouched) to a month
 *     that is DELIBERATELY NOT August, so every existing assertion below
 *     only passes if the calendar truly follows the selected VALUE's month —
 *     not the frozen "today". A dedicated describe block further down covers
 *     the one branch that legitimately SHOULD depend on "today" (no value
 *     passed) and proves it stays green across several different frozen
 *     months, so we are not just relocating the same date-coupling bug.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatePickerField } from '@/components/ui/date-picker'

// Deliberately NOT August (the fixtures' month) and NOT the real "today" —
// see file docstring. Individual tests/cases may re-freeze to a different
// month via `vi.setSystemTime()`; `afterEach` always restores the real clock.
const FROZEN_TODAY = new Date(2026, 11, 25, 12, 0, 0) // December 25, 2026

beforeEach(() => {
  vi.setSystemTime(FROZEN_TODAY)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('DatePickerField — minDate/maxDate bounds (owner addendum, 2026-08)', () => {
  it('a day BEFORE minDate is disabled in the open calendar', async () => {
    const user = userEvent.setup({ delay: null })
    render(
      <DatePickerField
        value="2026-08-07"
        onChange={() => {}}
        minDate="2026-08-05"
        maxDate="2026-08-10"
      />,
    )
    await user.click(screen.getByRole('button', { name: /07 авг/i }))
    const panel = within(screen.getByRole('dialog'))
    expect(panel.getByRole('button', { name: /, 4 августа 2026/ })).toBeDisabled()
  })

  it('a day AFTER maxDate is disabled in the open calendar', async () => {
    const user = userEvent.setup({ delay: null })
    render(
      <DatePickerField
        value="2026-08-07"
        onChange={() => {}}
        minDate="2026-08-05"
        maxDate="2026-08-10"
      />,
    )
    await user.click(screen.getByRole('button', { name: /07 авг/i }))
    const panel = within(screen.getByRole('dialog'))
    expect(panel.getByRole('button', { name: /, 11 августа 2026/ })).toBeDisabled()
  })

  it('a day WITHIN [minDate, maxDate] (inclusive of both bounds) is NOT disabled', async () => {
    const user = userEvent.setup({ delay: null })
    render(
      <DatePickerField
        value="2026-08-07"
        onChange={() => {}}
        minDate="2026-08-05"
        maxDate="2026-08-10"
      />,
    )
    await user.click(screen.getByRole('button', { name: /07 авг/i }))
    const panel = within(screen.getByRole('dialog'))
    // The bounds themselves are inclusive (before/after are exclusive matchers).
    expect(panel.getByRole('button', { name: /, 5 августа 2026/ })).not.toBeDisabled()
    expect(panel.getByRole('button', { name: /, 10 августа 2026/ })).not.toBeDisabled()
    expect(panel.getByRole('button', { name: /, 7 августа 2026/ })).not.toBeDisabled()
  })

  it('with NEITHER minDate NOR maxDate passed (every pre-existing caller), no day is disabled', async () => {
    const user = userEvent.setup({ delay: null })
    render(<DatePickerField value="2026-08-07" onChange={() => {}} />)
    await user.click(screen.getByRole('button', { name: /07 авг/i }))
    const panel = within(screen.getByRole('dialog'))
    // Far in the past AND far in the future — unrestricted either direction.
    expect(panel.getByRole('button', { name: /, 1 августа 2026/ })).not.toBeDisabled()
    expect(panel.getByRole('button', { name: /, 29 августа 2026/ })).not.toBeDisabled()
  })

  it('with ONLY minDate passed, there is no upper bound', async () => {
    const user = userEvent.setup({ delay: null })
    render(<DatePickerField value="2026-08-07" onChange={() => {}} minDate="2026-08-05" />)
    await user.click(screen.getByRole('button', { name: /07 авг/i }))
    const panel = within(screen.getByRole('dialog'))
    expect(panel.getByRole('button', { name: /, 4 августа 2026/ })).toBeDisabled()
    expect(panel.getByRole('button', { name: /, 29 августа 2026/ })).not.toBeDisabled()
  })
})

describe('DatePickerField — calendar opens on the SELECTED month, not "today" (regression, 2026-09-01)', () => {
  it('opens on the VALUE month even though "today" is frozen to a different month (December)', async () => {
    const user = userEvent.setup({ delay: null })
    render(<DatePickerField value="2026-08-07" onChange={() => {}} />)
    await user.click(screen.getByRole('button', { name: /07 авг/i }))
    const panel = within(screen.getByRole('dialog'))
    expect(panel.getByText('Август')).toBeInTheDocument()
    expect(panel.getByText('2026')).toBeInTheDocument()
    // Frozen "today" (December) must NOT be what's showing.
    expect(panel.queryByText('Декабрь')).not.toBeInTheDocument()
  })

  it('with NO value, opens on "today" — with no value there is nothing else to follow', async () => {
    const user = userEvent.setup({ delay: null })
    render(<DatePickerField value="" onChange={() => {}} />)
    await user.click(screen.getByRole('button', { name: /Выберите дату/i }))
    const panel = within(screen.getByRole('dialog'))
    expect(panel.getByText('Декабрь')).toBeInTheDocument()
    expect(panel.getByText('2026')).toBeInTheDocument()
  })

  // The "no value" branch is the one case that legitimately still depends on
  // "today" — react-day-picker's own default. Proven stable across several
  // unrelated frozen months (not just the one above) so this suite cannot
  // pass by coincidence the way the pre-fix version did for a year.
  it.each([
    { frozen: new Date(2026, 7, 15, 12, 0, 0), monthLabel: 'Август', year: '2026' },
    { frozen: new Date(2026, 11, 25, 12, 0, 0), monthLabel: 'Декабрь', year: '2026' },
    { frozen: new Date(2027, 0, 5, 12, 0, 0), monthLabel: 'Январь', year: '2027' },
  ])(
    'with NO value, opens on $monthLabel $year when that is the frozen "today"',
    async ({ frozen, monthLabel, year }) => {
      vi.setSystemTime(frozen)
      const user = userEvent.setup({ delay: null })
      render(<DatePickerField value="" onChange={() => {}} />)
      await user.click(screen.getByRole('button', { name: /Выберите дату/i }))
      const panel = within(screen.getByRole('dialog'))
      expect(panel.getByText(monthLabel)).toBeInTheDocument()
      expect(panel.getByText(year)).toBeInTheDocument()
    },
  )
})
