/**
 * Characterization tests for `FinanceSection` (SENIOR share | DROP share | salary)
 * after it moved out of `UserDialog.tsx` verbatim. SECURITY-SENSITIVE (finance):
 * pins the role gating (which fields each role sees), the share defaults (26 / 5),
 * the 1-100 / 0-100 onBlur validators and the pending-share notice wiring through a
 * real TanStack form.
 */
import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react'
import { useForm } from '@tanstack/react-form'
import type { ReactElement } from 'react'
import type { UserProfileDto } from '@crm/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { FinanceSection } from '../FinanceSection'

function render(ui: ReactElement) {
  return rtlRender(ui, { wrapper: I18nTestProvider })
}

// The notice owns a react-query mutation; only the props the section feeds it matter here.
vi.mock('@/components/pending-share/cancel-pending-share', () => ({
  PendingShareEditNotice: (props: {
    scope: string
    id: string
    pendingPercent: number
    approverName: string
  }) => (
    <div
      data-testid="pending-notice"
      data-scope={props.scope}
      data-id={props.id}
      data-percent={props.pendingPercent}
      data-approver={props.approverName}
    />
  ),
}))

// The real input fetches the NBU rate via react-query; the section only wires props.
vi.mock('@/components/ui/amount-currency-input', () => ({
  AmountCurrencyInput: (props: {
    amount: string
    currency: string
    label: string
    currencyLabel: string
    placeholder: string
    onAmountChange: (v: string) => void
    onCurrencyChange: (v: string) => void
  }) => (
    <div data-testid="amount-currency">
      <span data-testid="amount-label">{props.label}</span>
      <span data-testid="currency-label">{props.currencyLabel}</span>
      <span data-testid="amount-placeholder">{props.placeholder}</span>
      <span data-testid="amount-value">{props.amount}</span>
      <span data-testid="currency-value">{props.currency}</span>
      <button data-testid="set-amount" onClick={() => props.onAmountChange('1234')} />
      <button data-testid="set-currency" onClick={() => props.onCurrencyChange('EUR')} />
    </div>
  ),
}))

type Pending = NonNullable<UserProfileDto['pendingSeniorShare']>
type EditingUser = Pick<UserProfileDto, 'id' | 'pendingSeniorShare'>

interface Defaults {
  role?: string
  seniorSharePercent?: number | undefined
  dropSharePercent?: number | undefined
  monthlySalary?: string
  salaryCurrency?: string
}

function Harness({
  defaults = {},
  isCreate = false,
  editingUser = null,
}: {
  defaults?: Defaults
  isCreate?: boolean
  editingUser?: EditingUser | null
}) {
  const form = useForm({
    defaultValues: {
      role: 'SENIOR',
      seniorSharePercent: undefined as number | undefined,
      dropSharePercent: undefined as number | undefined,
      monthlySalary: '',
      salaryCurrency: 'USD',
      ...defaults,
    },
  })
  return (
    <>
      <FinanceSection form={form} isCreate={isCreate} editingUser={editingUser} />
      <button data-testid="to-drop" onClick={() => form.setFieldValue('role', 'DROP')} />
      <button data-testid="to-junior" onClick={() => form.setFieldValue('role', 'JUNIOR')} />
      <button
        data-testid="senior-out"
        onClick={() => form.setFieldValue('seniorSharePercent', 0)}
      />
      <button data-testid="drop-out" onClick={() => form.setFieldValue('dropSharePercent', 101)} />
      <form.Subscribe selector={(s) => s.values}>
        {(v) => <output data-testid="values">{JSON.stringify(v)}</output>}
      </form.Subscribe>
    </>
  )
}

function values() {
  return JSON.parse(screen.getByTestId('values').textContent ?? '{}') as Record<string, unknown>
}

const pending = (over: Partial<Pending> = {}): Pending =>
  ({
    percent: 30,
    effectivePercentAfterApproval: 30,
    approverName: 'Олексій',
    ...over,
  }) as Pending

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('FinanceSection — SENIOR', () => {
  it('shows the section title, the senior share slider and nothing salary/drop related', () => {
    render(<Harness />)
    expect(screen.getByRole('heading', { name: 'Фінанси' })).toBeInTheDocument()
    expect(screen.getByText('Частка сеньйора (%)')).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Частка сеньйора у відсотках' })).toBeInTheDocument()
    expect(
      screen.getByText(
        'Те, що сеньйор залишає собі. Нове значення набуде чинності після підтвердження сеньйора.',
      ),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('amount-currency')).not.toBeInTheDocument()
    expect(screen.queryByText('Частка дропа (%)')).not.toBeInTheDocument()
  })

  it('defaults the slider to 26 when the form value is unset, and shows a set value otherwise', () => {
    const { unmount } = render(<Harness />)
    expect(screen.getByRole('spinbutton')).toHaveValue(26)
    expect(screen.getByRole('slider')).toHaveValue('26')
    unmount()
    render(<Harness defaults={{ seniorSharePercent: 40 }} />)
    expect(screen.getByRole('spinbutton')).toHaveValue(40)
  })

  it('keeps the slider at the form value 0 (nullish-only default)', () => {
    render(<Harness defaults={{ seniorSharePercent: 0 }} />)
    expect(screen.getByRole('spinbutton')).toHaveValue(0)
  })

  it('writes slider changes into the form value', () => {
    render(<Harness />)
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '55' } })
    expect(values().seniorSharePercent).toBe(55)
  })

  it('marks the label required only in create mode', () => {
    const { unmount } = render(<Harness isCreate />)
    expect(screen.getByText('*')).toBeInTheDocument()
    unmount()
    render(<Harness />)
    expect(screen.queryByText('*')).not.toBeInTheDocument()
  })

  it('shows the 1-100 range error after blur on an out-of-range value, none for a valid one', async () => {
    render(<Harness defaults={{ seniorSharePercent: 40 }} />)
    fireEvent.blur(screen.getByRole('spinbutton'))
    await Promise.resolve()
    expect(screen.queryByText('Вкажіть від 1 до 100')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('senior-out'))
    fireEvent.blur(screen.getByRole('spinbutton'))
    expect(await screen.findByText('Вкажіть від 1 до 100')).toBeInTheDocument()
    expect(screen.getByRole('spinbutton').className).toContain('border-destructive')
  })

  it('does not surface the range error before the field is touched', async () => {
    render(<Harness defaults={{ seniorSharePercent: 40 }} />)
    fireEvent.click(screen.getByTestId('senior-out'))
    await Promise.resolve()
    expect(screen.queryByText('Вкажіть від 1 до 100')).not.toBeInTheDocument()
  })

  describe('pending share notice', () => {
    it('is absent without an editing user (create mode) or without a pending proposal', () => {
      const { unmount } = render(<Harness isCreate editingUser={null} />)
      expect(screen.queryByTestId('pending-notice')).not.toBeInTheDocument()
      unmount()
      render(<Harness editingUser={{ id: 'u1', pendingSeniorShare: null }} />)
      expect(screen.queryByTestId('pending-notice')).not.toBeInTheDocument()
    })

    it('renders with the proposed percent, approver and user scope/id', () => {
      render(
        <Harness editingUser={{ id: 'user-7', pendingSeniorShare: pending({ percent: 35 }) }} />,
      )
      const n = screen.getByTestId('pending-notice')
      expect(n).toHaveAttribute('data-scope', 'user')
      expect(n).toHaveAttribute('data-id', 'user-7')
      expect(n).toHaveAttribute('data-percent', '35')
      expect(n).toHaveAttribute('data-approver', 'Олексій')
    })

    it('uses effectivePercentAfterApproval (never 0) when the proposal clears the override', () => {
      render(
        <Harness
          editingUser={{
            id: 'u1',
            pendingSeniorShare: pending({ percent: null, effectivePercentAfterApproval: 20 }),
          }}
        />,
      )
      expect(screen.getByTestId('pending-notice')).toHaveAttribute('data-percent', '20')
    })

    it('keeps a literal 0% proposal as 0 (only null falls back)', () => {
      render(
        <Harness
          editingUser={{
            id: 'u1',
            pendingSeniorShare: pending({ percent: 0, effectivePercentAfterApproval: 20 }),
          }}
        />,
      )
      expect(screen.getByTestId('pending-notice')).toHaveAttribute('data-percent', '0')
    })

    it('is not rendered for non-SENIOR roles even when a proposal exists', () => {
      render(
        <Harness
          defaults={{ role: 'JUNIOR' }}
          editingUser={{ id: 'u1', pendingSeniorShare: pending() }}
        />,
      )
      expect(screen.queryByTestId('pending-notice')).not.toBeInTheDocument()
    })
  })
})

describe('FinanceSection — DROP', () => {
  it('shows only the drop share slider with its hint and the 5% default note', () => {
    render(<Harness defaults={{ role: 'DROP' }} />)
    expect(screen.getByText('Частка дропа (%)')).toBeInTheDocument()
    expect(screen.getByText('Скільки дроп залишає собі з кожної виплати')).toBeInTheDocument()
    expect(screen.getByText('За замовчуванням 5%')).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'Частка дропа у відсотках' })).toBeInTheDocument()
    expect(screen.queryByText('Частка сеньйора (%)')).not.toBeInTheDocument()
    expect(screen.queryByTestId('amount-currency')).not.toBeInTheDocument()
  })

  it('defaults to 5, allows 0 as the minimum, and writes changes into the form', () => {
    render(<Harness defaults={{ role: 'DROP' }} />)
    expect(screen.getByRole('spinbutton')).toHaveValue(5)
    expect(screen.getByRole('slider')).toHaveAttribute('min', '0')
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } })
    expect(values().dropSharePercent).toBe(0)
  })

  it('shows a set value instead of the default', () => {
    render(<Harness defaults={{ role: 'DROP', dropSharePercent: 12 }} />)
    expect(screen.getByRole('spinbutton')).toHaveValue(12)
  })

  it('marks the label required only in create mode', () => {
    const { unmount } = render(<Harness defaults={{ role: 'DROP' }} isCreate />)
    expect(screen.getByText('*')).toBeInTheDocument()
    unmount()
    render(<Harness defaults={{ role: 'DROP' }} />)
    expect(screen.queryByText('*')).not.toBeInTheDocument()
  })

  it('replaces the hint with the 0-100 range error after blur on an invalid value', async () => {
    render(<Harness defaults={{ role: 'DROP', dropSharePercent: 5 }} />)
    fireEvent.blur(screen.getByRole('spinbutton'))
    await Promise.resolve()
    expect(screen.queryByText('Вкажіть від 0 до 100')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('drop-out'))
    fireEvent.blur(screen.getByRole('spinbutton'))
    expect(await screen.findByText('Вкажіть від 0 до 100')).toBeInTheDocument()
    expect(screen.queryByText('Скільки дроп залишає собі з кожної виплати')).not.toBeInTheDocument()
  })
})

describe('FinanceSection — salary (every other role)', () => {
  it('shows salary + currency input and neither share slider', () => {
    render(<Harness defaults={{ role: 'JUNIOR', monthlySalary: '900', salaryCurrency: 'UAH' }} />)
    expect(screen.getByText('Місячна зарплата')).toBeInTheDocument()
    expect(screen.getByTestId('amount-label')).toHaveTextContent('Сума')
    expect(screen.getByTestId('currency-label')).toHaveTextContent('Валюта')
    expect(screen.getByTestId('amount-placeholder')).toHaveTextContent('0')
    expect(screen.getByTestId('amount-value')).toHaveTextContent('900')
    expect(screen.getByTestId('currency-value')).toHaveTextContent('UAH')
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument()
  })

  it.each(['ADMIN', 'HR', 'ACCOUNTANT'])('%s sees the salary field, not a share slider', (role) => {
    render(<Harness defaults={{ role }} />)
    expect(screen.getByTestId('amount-currency')).toBeInTheDocument()
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })

  it('writes amount and currency changes into the form', () => {
    render(<Harness defaults={{ role: 'JUNIOR' }} />)
    fireEvent.click(screen.getByTestId('set-amount'))
    fireEvent.click(screen.getByTestId('set-currency'))
    expect(values().monthlySalary).toBe('1234')
    expect(values().salaryCurrency).toBe('EUR')
  })
})

describe('FinanceSection — role switching', () => {
  it('swaps the visible fields reactively when the role changes', async () => {
    render(<Harness />)
    expect(screen.getByText('Частка сеньйора (%)')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('to-drop'))
    await waitFor(() => expect(screen.getByText('Частка дропа (%)')).toBeInTheDocument())
    expect(screen.queryByText('Частка сеньйора (%)')).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId('to-junior'))
    await waitFor(() => expect(screen.getByTestId('amount-currency')).toBeInTheDocument())
    expect(screen.queryByText('Частка дропа (%)')).not.toBeInTheDocument()
  })
})
