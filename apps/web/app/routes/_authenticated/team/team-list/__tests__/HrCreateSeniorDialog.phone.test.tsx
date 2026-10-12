/* Node access: the error paragraph has no role/label to query, so it is reached by selector. */
/* eslint-disable testing-library/no-node-access */
/**
 * HrCreateSeniorDialog phone length guard. The real phone widget caps input
 * length itself, so the dialog's own `max(30)` check is only reachable with a
 * plain input standing in for it.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: [] }), post: vi.fn() },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock('@/components/ui/phone-input', () => ({
  PhoneInput: ({
    value,
    onChange,
    onBlur,
  }: {
    value?: string
    onChange: (v: string) => void
    onBlur?: () => void
  }) => (
    <input
      data-testid="plain-phone"
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
    />
  ),
}))

import { HrCreateSeniorDialog } from '../components/HrCreateSeniorDialog'

function renderDialog() {
  render(
    <I18nTestProvider>
      <QueryClientProvider client={new QueryClient()}>
        <HrCreateSeniorDialog
          open
          onClose={vi.fn()}
          hrUserId="11111111-1111-4111-8111-111111111111"
        />
      </QueryClientProvider>
    </I18nTestProvider>,
  )
}

function phoneError(): string | null {
  const grid = screen.getByText('Телефон').closest('div.grid')
  return grid?.querySelector('p.text-destructive')?.textContent ?? null
}

beforeEach(async () => {
  vi.clearAllMocks()
  await loadCatalog('uk')
})

describe('HrCreateSeniorDialog phone length guard', () => {
  it('reports the length error, not the format error, for a value over 30 characters', () => {
    renderDialog()
    const input = screen.getByTestId('plain-phone')
    fireEvent.change(input, { target: { value: `+${'1'.repeat(30)}` } })
    fireEvent.blur(input)
    const err = phoneError()
    expect(err).not.toBeNull()
    expect(err).not.toBe('Введіть номер у міжнародному форматі, напр. +380671234567')
  })

  it('falls through to the format check for a short invalid number', () => {
    renderDialog()
    const input = screen.getByTestId('plain-phone')
    fireEvent.change(input, { target: { value: '+3801' } })
    fireEvent.blur(input)
    expect(phoneError()).toBe('Введіть номер у міжнародному форматі, напр. +380671234567')
  })
})
