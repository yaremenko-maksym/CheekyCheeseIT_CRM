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
      'Для дат старших за 31 день',
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
})
