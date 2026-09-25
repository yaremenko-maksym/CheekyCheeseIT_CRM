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
})
