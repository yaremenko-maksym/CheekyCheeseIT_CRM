import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

vi.mock('@/components/ui/date-picker', () => ({
  DatePickerField: ({
    value,
    onChange,
    disabled,
    'aria-describedby': describedBy,
    'data-testid': dataTestId,
  }: {
    value: string
    onChange: (value: string) => void
    disabled?: boolean
    'aria-describedby'?: string
    'data-testid'?: string
  }) => (
    <input
      type="date"
      value={value}
      disabled={disabled}
      aria-describedby={describedBy}
      data-testid={dataTestId}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

import { TxDateField } from '../TxDateField'

beforeEach(async () => {
  await loadCatalog('uk')
})

function renderField(over: Partial<React.ComponentProps<typeof TxDateField>> = {}) {
  const onChange = vi.fn()
  const onReasonChange = vi.fn()
  render(
    <TxDateField
      value="2026-10-20"
      stored="2026-10-20"
      reason=""
      onChange={onChange}
      onReasonChange={onReasonChange}
      {...over}
    />,
    { wrapper: I18nTestProvider },
  )
  return { onChange, onReasonChange }
}

describe('TxDateField', () => {
  it('shows the date and hides the reason while the day is the stored one', () => {
    renderField()
    expect(screen.getByTestId('admin-edit-tx-date')).toHaveValue('2026-10-20')
    expect(screen.queryByTestId('admin-edit-tx-date-reason')).toBeNull()
  })

  it('shows the reason input once the day differs, with the 31-day hint', () => {
    renderField({ value: '2026-08-01' })
    expect(screen.getByTestId('admin-edit-tx-date-reason')).toBeInTheDocument()
    expect(screen.getByTestId('admin-edit-tx-date-reason-input')).toHaveAttribute(
      'placeholder',
      'Для дат давніших за 31 день',
    )
  })

  it('renders the window hint in English from the shared limit', async () => {
    await loadCatalog('en')
    renderField({ value: '2026-08-01' })
    expect(screen.getByTestId('admin-edit-tx-date-reason-input')).toHaveAttribute(
      'placeholder',
      'For dates older than 31 days',
    )
  })

  it('keeps the reason hidden when the date is cleared', () => {
    renderField({ value: '', stored: '2026-10-20' })
    expect(screen.queryByTestId('admin-edit-tx-date-reason')).toBeNull()
  })

  it('caps the reason at 500 characters, the server limit', () => {
    renderField({ value: '2026-08-01' })
    expect(screen.getByTestId('admin-edit-tx-date-reason-input')).toHaveAttribute(
      'maxlength',
      '500',
    )
  })

  it('reports a picked day', () => {
    const { onChange } = renderField()
    fireEvent.change(screen.getByTestId('admin-edit-tx-date'), { target: { value: '2026-10-25' } })
    expect(onChange).toHaveBeenCalledWith('2026-10-25')
  })

  it('reports a typed reason', () => {
    const { onReasonChange } = renderField({ value: '2026-08-01' })
    fireEvent.change(screen.getByTestId('admin-edit-tx-date-reason-input'), {
      target: { value: 'late statement' },
    })
    expect(onReasonChange).toHaveBeenCalledWith('late statement')
  })

  it('renders the error text under the reason input, wired by aria-describedby', () => {
    renderField({ value: '2026-08-01', invalid: true, errorMessage: 'Вкажіть причину' })
    const input = screen.getByTestId('admin-edit-tx-date-reason-input')
    const msg = screen.getByTestId('admin-edit-tx-date-reason-error')
    expect(msg).toHaveTextContent('Вкажіть причину')
    expect(msg).toHaveAttribute('role', 'alert')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-describedby', msg.id)
    expect(input).toHaveClass('border-destructive')
    expect(msg).toHaveClass('text-destructive')
  })

  it('locked: disables the date trigger, shows the note and never the reason field', () => {
    renderField({ value: '2026-08-01', locked: true })
    expect(screen.getByTestId('admin-edit-tx-date')).toBeDisabled()
    const note = screen.getByTestId('admin-edit-tx-date-locked-note')
    expect(screen.getByTestId('admin-edit-tx-date')).toHaveAttribute('aria-describedby', note.id)
    expect(note.id).toBe('admin-edit-tx-date-locked-note-text')
    expect(screen.queryByTestId('admin-edit-tx-date-reason')).toBeNull()
  })

  it('unlocked: trigger enabled, no note, no describedby', () => {
    renderField({ value: '2026-08-01' })
    expect(screen.getByTestId('admin-edit-tx-date')).not.toBeDisabled()
    expect(screen.getByTestId('admin-edit-tx-date')).not.toHaveAttribute('aria-describedby')
    expect(screen.queryByTestId('admin-edit-tx-date-locked-note')).toBeNull()
  })

  it('shows no inline error and no destructive style when not invalid', () => {
    renderField({ value: '2026-08-01' })
    expect(screen.queryByTestId('admin-edit-tx-date-reason-error')).toBeNull()
    expect(screen.getByTestId('admin-edit-tx-date-reason-input')).not.toHaveClass(
      'border-destructive',
    )
  })

  it('marks the reason input with the stable describedby id and base classes', () => {
    renderField({ value: '2026-08-01', invalid: true, errorMessage: 'm' })
    const input = screen.getByTestId('admin-edit-tx-date-reason-input')
    expect(input).toHaveAttribute('aria-describedby', 'admin-edit-tx-date-reason-error')
    expect(screen.getByTestId('admin-edit-tx-date-reason-error')).toHaveAttribute(
      'id',
      'admin-edit-tx-date-reason-error',
    )
    expect(input).toHaveClass('min-h-[44px]', 'text-sm')
  })

  it('omits aria-describedby when invalid without a message', () => {
    renderField({ value: '2026-08-01', invalid: true })
    expect(screen.getByTestId('admin-edit-tx-date-reason-input')).not.toHaveAttribute(
      'aria-describedby',
    )
  })

  it('omits aria-describedby and the error when a message arrives without invalid', () => {
    renderField({ value: '2026-08-01', errorMessage: 'm' })
    expect(screen.getByTestId('admin-edit-tx-date-reason-input')).not.toHaveAttribute(
      'aria-describedby',
    )
    expect(screen.queryByTestId('admin-edit-tx-date-reason-error')).toBeNull()
  })

  it('focuses the reason input when it becomes invalid, and not before', () => {
    const props = {
      value: '2026-08-01',
      stored: '2026-10-20',
      reason: '',
      onChange: vi.fn(),
      onReasonChange: vi.fn(),
    }
    const { rerender } = render(<TxDateField {...props} />, { wrapper: I18nTestProvider })
    const input = screen.getByTestId('admin-edit-tx-date-reason-input')
    expect(input).not.toHaveFocus()
    rerender(<TxDateField {...props} invalid />)
    expect(input).toHaveFocus()
  })

  it('does not throw when invalid while the reason input is not rendered', () => {
    expect(() => renderField({ invalid: true })).not.toThrow()
    expect(screen.queryByTestId('admin-edit-tx-date-reason-input')).toBeNull()
  })
})
