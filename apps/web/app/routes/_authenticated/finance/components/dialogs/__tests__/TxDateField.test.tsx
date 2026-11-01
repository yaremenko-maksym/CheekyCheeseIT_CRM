import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

vi.mock('@/components/ui/date-picker', () => ({
  DatePickerField: ({
    value,
    onChange,
    'data-testid': dataTestId,
  }: {
    value: string
    onChange: (value: string) => void
    'data-testid'?: string
  }) => (
    <input
      type="date"
      value={value}
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
    expect(msg).not.toHaveAttribute('role')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-describedby', msg.id)
    expect(input).toHaveClass('border-destructive')
    expect(msg).toHaveClass('text-destructive')
  })

  it('shows no inline error and no destructive style when not invalid', () => {
    renderField({ value: '2026-08-01' })
    expect(screen.queryByTestId('admin-edit-tx-date-reason-error')).toBeNull()
    expect(screen.getByTestId('admin-edit-tx-date-reason-input')).not.toHaveClass(
      'border-destructive',
    )
  })
})
