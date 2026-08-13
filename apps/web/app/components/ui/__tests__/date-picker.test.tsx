/**
 * date-picker.test.tsx — task-drop-payout-currency (owner addendum, 2026-08).
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
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { DatePickerField } from '@/components/ui/date-picker'

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
