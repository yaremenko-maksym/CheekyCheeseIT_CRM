import { render, screen } from '@testing-library/react'
import { describe, expect, it, beforeEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { CreateWizardStepper } from '../CreateWizardStepper'

function renderStepper(current: 1 | 2 | 3) {
  return render(<CreateWizardStepper current={current} />, { wrapper: I18nTestProvider })
}

describe('CreateWizardStepper', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
  })

  it('renders 3 steps with correct labels', () => {
    renderStepper(1)
    expect(screen.getByText('Дані')).toBeInTheDocument()
    expect(screen.getByText('Контракт')).toBeInTheDocument()
    expect(screen.getByText('Підтвердження')).toBeInTheDocument()
  })

  it('the nav carries the "Кроки створення користувача" aria-label', () => {
    renderStepper(1)
    expect(
      screen.getByRole('navigation', { name: 'Кроки створення користувача' }),
    ).toBeInTheDocument()
  })

  it('marks step 1 as active, 2 and 3 as upcoming when current=1', () => {
    renderStepper(1)
    expect(screen.getByTestId('wizard-step-1')).toHaveAttribute('data-state', 'active')
    expect(screen.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'upcoming')
    expect(screen.getByTestId('wizard-step-3')).toHaveAttribute('data-state', 'upcoming')
  })

  it('marks step 1 as done, step 2 as active, step 3 as upcoming when current=2', () => {
    renderStepper(2)
    expect(screen.getByTestId('wizard-step-1')).toHaveAttribute('data-state', 'done')
    expect(screen.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'active')
    expect(screen.getByTestId('wizard-step-3')).toHaveAttribute('data-state', 'upcoming')
  })

  it('marks steps 1 and 2 as done, step 3 as active when current=3', () => {
    renderStepper(3)
    expect(screen.getByTestId('wizard-step-1')).toHaveAttribute('data-state', 'done')
    expect(screen.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'done')
    expect(screen.getByTestId('wizard-step-3')).toHaveAttribute('data-state', 'active')
  })

  it('step testids are wizard-step-1, wizard-step-2, wizard-step-3', () => {
    renderStepper(1)
    expect(screen.getByTestId('wizard-step-1')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-step-2')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-step-3')).toBeInTheDocument()
  })

  /**
   * UX-LOW-1 fix (PR #720, round C): at 320px the uk label "Підтвердження"
   * (a single word) overflowed past the dialog edge under whitespace-nowrap.
   * These two classes are what stop that — `shrink-0` keeps the circle a
   * circle once its sibling is allowed to shrink, and `min-w-0` (on the
   * label itself, not just its wrapper) plus `whitespace-normal break-words`
   * is what lets the label actually wrap instead of overflowing. jsdom has
   * no real layout engine, so this can only assert the classes are PRESENT,
   * not that wrapping visually occurs — that was verified separately with a
   * live Playwright screenshot at a 320px viewport (see the PR body).
   */
  it('the circle keeps shrink-0 so it cannot be squashed once the label is allowed to shrink', () => {
    renderStepper(1)
    expect(screen.getByTestId('wizard-step-3-circle').className).toContain('shrink-0')
  })

  it('the label can shrink and wrap (min-w-0, whitespace-normal, break-words)', () => {
    renderStepper(1)
    const label = screen.getByText('Підтвердження')
    expect(label.className).toContain('min-w-0')
    expect(label.className).toContain('whitespace-normal')
    expect(label.className).toContain('break-words')
    expect(label.className).toContain('sm:whitespace-nowrap')
  })
})
