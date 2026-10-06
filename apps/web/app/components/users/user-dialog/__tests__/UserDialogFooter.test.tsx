/**
 * Characterization tests for `UserDialogFooter` (role badge + Cancel + wizard
 * Next/Back/submit) after it moved out of `UserDialog.tsx` verbatim.
 */
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react'
import { useForm } from '@tanstack/react-form'
import { useState, type ReactElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { UserDialogFooter } from '../UserDialogFooter'

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nTestProvider })
}

interface HarnessProps {
  role?: string
  isCreate?: boolean
  initialStep?: 1 | 2 | 3
  isPending?: boolean
  submitLabel?: string
  createPending?: boolean
  onClose?: () => void
  onSubmit?: () => void
}

function Harness({
  role = 'SENIOR',
  isCreate = true,
  initialStep = 1,
  isPending = false,
  submitLabel = 'Зберегти',
  createPending = false,
  onClose = () => {},
  onSubmit = () => {},
}: HarnessProps) {
  const form = useForm({ defaultValues: { role }, onSubmit: () => onSubmit() })
  const [step, setStep] = useState<1 | 2 | 3>(initialStep)
  return (
    <>
      <output data-testid="step">{step}</output>
      <UserDialogFooter
        form={form}
        isCreate={isCreate}
        currentStep={step}
        setCurrentStep={setStep}
        isPending={isPending}
        submitLabel={submitLabel}
        createPending={createPending}
        onClose={onClose}
      />
    </>
  )
}

const step = () => screen.getByTestId('step').textContent

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('UserDialogFooter', () => {
  it('renders the role badge label for the form role', () => {
    render(<Harness role="SENIOR" />)
    expect(screen.getByText('Сеньйор')).toBeInTheDocument()
  })

  it('renders a different role label for another role', () => {
    render(<Harness role="ACCOUNTANT" />)
    expect(screen.getByText('Бухгалтер')).toBeInTheDocument()
    expect(screen.queryByText('Сеньйор')).not.toBeInTheDocument()
  })

  it('Cancel calls onClose', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Скасувати' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('create step 1 shows only the Next button (no back / no submit)', () => {
    render(<Harness isCreate initialStep={1} />)
    expect(screen.getByTestId('wizard-next-btn')).toHaveTextContent('Далі')
    expect(screen.queryByTestId('wizard-back-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-step2-next-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-submit')).not.toBeInTheDocument()
  })

  it('create step 1 Next submits the form', async () => {
    const onSubmit = vi.fn()
    render(<Harness isCreate initialStep={1} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByTestId('wizard-next-btn'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  })

  it('create step 1 shows the creating label while the create mutation is pending', () => {
    render(<Harness isCreate initialStep={1} createPending />)
    expect(screen.getByTestId('wizard-next-btn')).toHaveTextContent('Створюємо…')
    expect(screen.getByTestId('wizard-next-btn')).not.toHaveTextContent('Далі')
  })

  it('create step 1 Next is disabled while pending and enabled otherwise', () => {
    const { unmount } = render(<Harness isCreate initialStep={1} isPending />)
    expect(screen.getByTestId('wizard-next-btn')).toBeDisabled()
    unmount()
    render(<Harness isCreate initialStep={1} />)
    expect(screen.getByTestId('wizard-next-btn')).toBeEnabled()
  })

  it('create step 1 Next carries the user-create tracking attribute', () => {
    render(<Harness isCreate initialStep={1} />)
    expect(screen.getByTestId('wizard-next-btn')).toHaveAttribute('data-track', 'user-create')
  })

  it('create step 2 shows Back + Next and hides the step-1 button', () => {
    render(<Harness isCreate initialStep={2} />)
    expect(screen.getByTestId('wizard-back-btn')).toHaveTextContent('Назад')
    expect(screen.getByTestId('wizard-step2-next-btn')).toHaveTextContent('Далі')
    expect(screen.queryByTestId('wizard-next-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-submit')).not.toBeInTheDocument()
  })

  it('create step 2 Back goes to step 1', () => {
    render(<Harness isCreate initialStep={2} />)
    fireEvent.click(screen.getByTestId('wizard-back-btn'))
    expect(step()).toBe('1')
  })

  it('create step 2 Next advances to step 3', () => {
    render(<Harness isCreate initialStep={2} />)
    fireEvent.click(screen.getByTestId('wizard-step2-next-btn'))
    expect(step()).toBe('3')
  })

  it('create step 3 shows no wizard / submit button, only Cancel', () => {
    render(<Harness isCreate initialStep={3} />)
    expect(screen.queryByTestId('wizard-next-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-back-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-step2-next-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('user-dialog-submit')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Скасувати' })).toBeInTheDocument()
  })

  it('edit mode shows the submit button with the given label and no wizard buttons', () => {
    render(<Harness isCreate={false} initialStep={1} submitLabel="Зберегти" />)
    expect(screen.getByTestId('user-dialog-submit')).toHaveTextContent('Зберегти')
    expect(screen.queryByTestId('wizard-next-btn')).not.toBeInTheDocument()
    expect(screen.queryByTestId('wizard-back-btn')).not.toBeInTheDocument()
  })

  it('edit mode submit is disabled while pending and enabled otherwise', () => {
    const { unmount } = render(<Harness isCreate={false} isPending submitLabel="Зберігаємо…" />)
    expect(screen.getByTestId('user-dialog-submit')).toBeDisabled()
    expect(screen.getByTestId('user-dialog-submit')).toHaveTextContent('Зберігаємо…')
    unmount()
    render(<Harness isCreate={false} />)
    expect(screen.getByTestId('user-dialog-submit')).toBeEnabled()
  })

  it('edit mode submit submits the form', async () => {
    const onSubmit = vi.fn()
    render(<Harness isCreate={false} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByTestId('user-dialog-submit'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  })
})
