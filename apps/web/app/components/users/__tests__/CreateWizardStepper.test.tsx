import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { CreateWizardStepper } from '../CreateWizardStepper'

describe('CreateWizardStepper', () => {
  it('renders 3 steps with correct labels', () => {
    render(<CreateWizardStepper current={1} />)
    expect(screen.getByText('Данные')).toBeInTheDocument()
    expect(screen.getByText('Контракт')).toBeInTheDocument()
    expect(screen.getByText('Подтверждение')).toBeInTheDocument()
  })

  it('marks step 1 as active, 2 and 3 as upcoming when current=1', () => {
    render(<CreateWizardStepper current={1} />)
    expect(screen.getByTestId('wizard-step-1')).toHaveAttribute('data-state', 'active')
    expect(screen.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'upcoming')
    expect(screen.getByTestId('wizard-step-3')).toHaveAttribute('data-state', 'upcoming')
  })

  it('marks step 1 as done, step 2 as active, step 3 as upcoming when current=2', () => {
    render(<CreateWizardStepper current={2} />)
    expect(screen.getByTestId('wizard-step-1')).toHaveAttribute('data-state', 'done')
    expect(screen.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'active')
    expect(screen.getByTestId('wizard-step-3')).toHaveAttribute('data-state', 'upcoming')
  })

  it('marks steps 1 and 2 as done, step 3 as active when current=3', () => {
    render(<CreateWizardStepper current={3} />)
    expect(screen.getByTestId('wizard-step-1')).toHaveAttribute('data-state', 'done')
    expect(screen.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'done')
    expect(screen.getByTestId('wizard-step-3')).toHaveAttribute('data-state', 'active')
  })

  it('step testids are wizard-step-1, wizard-step-2, wizard-step-3', () => {
    render(<CreateWizardStepper current={1} />)
    expect(screen.getByTestId('wizard-step-1')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-step-2')).toBeInTheDocument()
    expect(screen.getByTestId('wizard-step-3')).toBeInTheDocument()
  })
})
