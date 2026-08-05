/**
 * amount-currency-input.test.tsx — task-mobile-keyboards.md AC2.
 *
 * `type="number"` silently discards a comma-decimal value in ru/uk locales
 * (the field just goes blank, no error) or truncates it — this pins the
 * fix at the component boundary (not just the `normalizeDecimalInput`
 * helper in isolation): typing `1,5` into the real rendered input must
 * reach `onAmountChange` as `"1.5"`, never `"15"` and never `""`.
 */
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { AmountCurrencyInput } from '@/components/ui/amount-currency-input'

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn(() => Promise.reject(new Error('not used — currency=USDT needs no rate'))) },
}))

/**
 * Controlled-input harness: mirrors every real call site (TanStack Form /
 * `useState`), where `onAmountChange` feeds back into the `amount` prop.
 * Rendering `<AmountCurrencyInput amount="" .../>` with a value that never
 * updates would make `userEvent.type` fire each keystroke against a DOM
 * value that keeps resetting to "" — not a real reproduction of the bug.
 */
function AmountHarness({ onAmountChange }: { onAmountChange: (v: string) => void }) {
  const [amount, setAmount] = useState('')
  return (
    <AmountCurrencyInput
      amount={amount}
      currency="USDT"
      onAmountChange={(v) => {
        setAmount(v)
        onAmountChange(v)
      }}
      onCurrencyChange={() => {}}
    />
  )
}

function renderInput(onAmountChange: (v: string) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AmountHarness onAmountChange={onAmountChange} />
    </QueryClientProvider>,
  )
}

describe('AmountCurrencyInput — task-mobile-keyboards.md', () => {
  it('renders a text input with a decimal mobile keyboard, not type="number" (AC2)', () => {
    renderInput(() => {})
    const input = screen.getByTestId('amount-currency-amount-input')
    expect(input).toHaveAttribute('type', 'text')
    expect(input).toHaveAttribute('inputMode', 'decimal')
  })

  it('typing a comma decimal reaches onAmountChange as a dot decimal — not truncated, not emptied (AC2)', async () => {
    const user = userEvent.setup()
    const onAmountChange = vi.fn()
    renderInput(onAmountChange)

    const input = screen.getByTestId('amount-currency-amount-input')
    await user.type(input, '1,5')

    const calls = onAmountChange.mock.calls.map((c) => c[0] as string)
    // The final call must be the correctly-normalized value.
    expect(calls.at(-1)).toBe('1.5')
    // None of the intermediate calls corrupted the amount into "15" (the
    // comma silently stripped) or "" (type="number" rejecting the comma).
    expect(calls).not.toContain('15')
    expect(calls.every((v) => v !== '')).toBe(true)
  })
})
