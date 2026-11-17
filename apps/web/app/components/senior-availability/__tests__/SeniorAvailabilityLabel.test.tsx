/**
 * SeniorAvailabilityLabel (vacancy-queue design §5.2): text plus a dot shape. A future FREE day
 * reads «Вільно з {d}» (short month); today or an earlier day reads as free now; BUSY is hollow.
 */
import { render, screen } from '@testing-library/react'
import { I18nProvider } from '@lingui/react'
import { describe, expect, it } from 'vitest'
import { kyivToday, type SeniorAvailabilityDto } from '@crm/shared'
import { i18n } from '@/lib/i18n'
import { SeniorAvailabilityLabel } from '../SeniorAvailabilityLabel'

function renderLabel(availability: SeniorAvailabilityDto) {
  render(
    <I18nProvider i18n={i18n}>
      <SeniorAvailabilityLabel availability={availability} testId="label" />
    </I18nProvider>,
  )
  const label = screen.getByTestId('label')
  // eslint-disable-next-line testing-library/no-node-access -- the dot is aria-hidden and has no text: its shape is the only thing to read
  const dot = label.firstElementChild
  return { label, dot, filled: dot?.classList.contains('bg-current') }
}

describe('SeniorAvailabilityLabel', () => {
  it('a future FREE day: «Вільно з {d}» with a short month and a filled dot', () => {
    const { label, filled } = renderLabel({ status: 'FREE', availableFrom: '2099-11-01' })
    expect(label).toHaveTextContent(/^Вільно з 1 лист\.$/)
    expect(filled).toBe(true)
  })

  it('a FREE day that is today (Kyiv) already reads as free now', () => {
    const { label, filled } = renderLabel({ status: 'FREE', availableFrom: kyivToday() })
    expect(label).toHaveTextContent(/^Вільно$/)
    expect(filled).toBe(true)
  })

  it('a past FREE day reads as free now, never a stale «Вільно з <old day>»', () => {
    const { label, filled } = renderLabel({ status: 'FREE', availableFrom: '2020-01-01' })
    expect(label).toHaveTextContent(/^Вільно$/)
    expect(filled).toBe(true)
  })

  it('BUSY: «Зайнято» with a hollow dot, even if a stray day rides along', () => {
    const stray = {
      status: 'BUSY',
      availableFrom: '2099-11-01',
    } as unknown as SeniorAvailabilityDto
    const { label, dot, filled } = renderLabel(stray)
    expect(label).toHaveTextContent(/^Зайнято$/)
    // the hollow dot is only a ring: without the round border it would not show at all
    expect(dot).toHaveClass('rounded-full', 'border', 'border-current')
    // secondary meta text, the dot inline before it
    expect(label).toHaveClass('inline-flex', 'text-muted-foreground')
    expect(label).toHaveAttribute('data-availability', 'BUSY')
    expect(filled).toBe(false)
  })
})
