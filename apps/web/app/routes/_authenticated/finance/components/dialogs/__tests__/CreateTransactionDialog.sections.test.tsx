/**
 * Direct tests for the form sections extracted verbatim from `CreateTransactionDialog`
 * (`create-transaction/*`): each is rendered on its own with props, so a field's
 * wiring (which setter / error-clearer it calls with what) and its observable state
 * (error styling, fallbacks, gate hints) is pinned without driving the whole dialog.
 * Expected values are literals; class assertions pin the error / active / inactive
 * state the user actually sees.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'
import type { ReceiptState } from '../../ReceiptInput'
import type { ProjectOption, UserOption } from '../create-transaction/shared'

// ReceiptInput owns upload mutations — replace it with a button that emits a change.
vi.mock('../../ReceiptInput', () => ({
  ReceiptInput: (props: {
    onChange: (s: ReceiptState) => void
    explorerOnly: boolean
    label: string
    error?: string
  }) => (
    <button
      data-testid="fake-receipt-input"
      data-explorer-only={String(props.explorerOnly)}
      data-label={props.label}
      data-error={props.error ?? ''}
      onClick={() =>
        props.onChange({
          mode: 'url',
          documentId: null,
          externalUrl: 'https://x.test/r',
          fileName: '',
          previewUrl: null,
          mimeType: '',
        })
      }
    />
  ),
  emptyReceiptState: () => ({}),
}))

import { AdminIncomeReceiverField } from '../create-transaction/AdminIncomeReceiverField'
import { DividendFields } from '../create-transaction/DividendFields'
import { ExpenseCategoryField } from '../create-transaction/ExpenseCategoryField'
import { ProjectSelectSection } from '../create-transaction/ProjectSelectSection'
import { ReceiptField } from '../create-transaction/ReceiptField'
import { SalaryFields } from '../create-transaction/SalaryFields'
import { TransferSwapField } from '../create-transaction/TransferSwapField'
import { TypeSelector } from '../create-transaction/TypeSelector'

const ADMINS: UserOption[] = [
  { id: 'adm-1', displayName: 'Alice Admin', role: 'ADMIN' },
  { id: 'adm-2', displayName: 'Bob Admin', role: 'ADMIN' },
]
const fmt = (n: number) => `fmt(${n})`

function ui(node: React.ReactNode) {
  return render(<I18nTestProvider>{node}</I18nTestProvider>)
}

async function pick(triggerTestId: string, optionName: string) {
  fireEvent.click(screen.getByTestId(triggerTestId))
  fireEvent.click(await screen.findByRole('option', { name: optionName }))
}

beforeEach(async () => {
  await loadCatalog('uk')
})

describe('AdminIncomeReceiverField', () => {
  function renderField(over: Partial<Parameters<typeof AdminIncomeReceiverField>[0]> = {}) {
    const props = {
      receiverId: '',
      setReceiverId: vi.fn(),
      clearFieldError: vi.fn(),
      fieldErrors: {} as Record<string, string>,
      adminUsers: ADMINS,
      isSelectedProjectUsdt: false,
      companyBalance: 1234.5,
      fmtUsdt: fmt,
      ...over,
    }
    ui(<AdminIncomeReceiverField {...props} />)
    return props
  }

  it('picking an admin stores it and clears the receiver error', async () => {
    const props = renderField()
    await pick('admin-income-receiver-trigger', 'Bob Admin')
    expect(props.setReceiverId).toHaveBeenCalledWith('adm-2')
    expect(props.clearFieldError).toHaveBeenCalledWith('receiver')
  })

  it('error state: red border + the message', () => {
    renderField({ fieldErrors: { receiver: 'Виберіть отримувача' } })
    expect(screen.getByTestId('admin-income-receiver-trigger')).toHaveClass(
      'h-9',
      'text-sm',
      'border-destructive',
    )
    expect(screen.getByTestId('admin-income-error-receiver')).toHaveTextContent(
      'Виберіть отримувача',
    )
  })

  it('no error: plain border and no message', () => {
    renderField()
    const trigger = screen.getByTestId('admin-income-receiver-trigger')
    expect(trigger).toHaveClass('h-9', 'text-sm')
    expect(trigger).not.toHaveClass('border-destructive')
    expect(screen.queryByTestId('admin-income-error-receiver')).not.toBeInTheDocument()
  })

  it('shows the company balance only when the company account is the receiver', () => {
    renderField({ receiverId: 'COMPANY_ACCOUNT' })
    expect(screen.getByTestId('create-transaction-company-balance-hint')).toHaveTextContent(
      'fmt(1234.5) USDT',
    )
  })
})

describe('DividendFields', () => {
  function renderField(over: Partial<Parameters<typeof DividendFields>[0]> = {}) {
    const props = {
      companyBalance: 800,
      fmtUsdt: fmt,
      dividendReceiverId: 'adm-1',
      setReceiverId: vi.fn(),
      clearFieldError: vi.fn(),
      fieldErrors: {} as Record<string, string>,
      adminUsers: ADMINS,
      amount: '',
      setAmount: vi.fn(),
      ...over,
    }
    ui(<DividendFields {...props} />)
    return props
  }

  it('shows the company balance', () => {
    renderField()
    expect(screen.getByTestId('create-transaction-dividend-balance')).toHaveTextContent(
      'fmt(800) USDT',
    )
  })

  it('lists every admin partner and picking one stores it + clears the receiver error', async () => {
    const props = renderField()
    fireEvent.click(screen.getByTestId('create-transaction-dividend-receiver-trigger'))
    expect(await screen.findByRole('option', { name: 'Alice Admin' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('option', { name: 'Bob Admin' }))
    expect(props.setReceiverId).toHaveBeenCalledWith('adm-2')
    expect(props.clearFieldError).toHaveBeenCalledWith('receiver')
  })

  it('receiver error: red border + message; otherwise neither', () => {
    renderField({ fieldErrors: { receiver: 'Виберіть отримувача-партнера' } })
    expect(screen.getByTestId('create-transaction-dividend-receiver-trigger')).toHaveClass(
      'h-9',
      'text-sm',
      'border-destructive',
    )
    expect(screen.getByTestId('create-transaction-error-receiver')).toHaveTextContent(
      'Виберіть отримувача-партнера',
    )
  })

  it('no receiver error: plain border, no message', () => {
    renderField()
    expect(screen.getByTestId('create-transaction-dividend-receiver-trigger')).not.toHaveClass(
      'border-destructive',
    )
    expect(screen.queryByTestId('create-transaction-error-receiver')).not.toBeInTheDocument()
  })

  it('typing an amount stores it and clears the amount error', () => {
    const props = renderField()
    fireEvent.change(screen.getByTestId('create-transaction-dividend-amount'), {
      target: { value: '12.5' },
    })
    expect(props.setAmount).toHaveBeenCalledWith('12.5')
    expect(props.clearFieldError).toHaveBeenCalledWith('amount')
  })

  it('amount error: red border + message; otherwise plain', () => {
    renderField({ fieldErrors: { amount: 'Сума перевищує баланс рахунку компанії' } })
    const input = screen.getByTestId('create-transaction-dividend-amount')
    expect(input).toHaveClass('h-9', 'pl-7', 'text-sm', 'tabular-nums', 'border-destructive')
    expect(screen.getByTestId('create-transaction-error-amount')).toHaveTextContent(
      'Сума перевищує баланс рахунку компанії',
    )
  })

  it('no amount error: the input has the base classes only', () => {
    renderField()
    const input = screen.getByTestId('create-transaction-dividend-amount')
    expect(input).toHaveClass('h-9', 'pl-7', 'text-sm', 'tabular-nums')
    expect(input).not.toHaveClass('border-destructive')
  })
})

describe('SalaryFields', () => {
  const EMPLOYEES: UserOption[] = [
    { id: 'emp-1', displayName: 'Eve Employee', role: 'JUNIOR' },
    { id: 'emp-2', displayName: 'Sam Senior', role: 'SENIOR' },
  ]

  function renderField(over: Partial<Parameters<typeof SalaryFields>[0]> = {}) {
    const props = {
      receiverId: '',
      setReceiverId: vi.fn(),
      clearFieldError: vi.fn(),
      fieldErrors: {} as Record<string, string>,
      salaryTargets: EMPLOYEES,
      salaryMonth: '2025-03',
      setSalaryMonth: vi.fn(),
      ...over,
    }
    ui(<SalaryFields {...props} />)
    return props
  }

  it('picking an employee stores it and clears the receiver error', async () => {
    const props = renderField()
    fireEvent.click(screen.getByTestId('create-transaction-receiver-trigger'))
    expect(await screen.findByRole('option', { name: /Eve Employee/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Sam Senior/ })).toHaveTextContent('(SENIOR)')
    fireEvent.click(screen.getByRole('option', { name: /Eve Employee/ }))
    expect(props.setReceiverId).toHaveBeenCalledWith('emp-1')
    expect(props.clearFieldError).toHaveBeenCalledWith('receiver')
  })

  it('receiver error: red border + message; otherwise neither', () => {
    renderField({ fieldErrors: { receiver: 'Виберіть співробітника' } })
    expect(screen.getByTestId('create-transaction-receiver-trigger')).toHaveClass(
      'h-9',
      'text-sm',
      'border-destructive',
    )
    expect(screen.getByTestId('create-transaction-error-receiver')).toHaveTextContent(
      'Виберіть співробітника',
    )
  })

  it('no receiver error: plain border, no message', () => {
    renderField()
    expect(screen.getByTestId('create-transaction-receiver-trigger')).not.toHaveClass(
      'border-destructive',
    )
    expect(screen.queryByTestId('create-transaction-error-receiver')).not.toBeInTheDocument()
  })

  it('the month input shows the month and reports changes', () => {
    const props = renderField()
    const month = screen.getByTestId('create-transaction-salary-month') as HTMLInputElement
    expect(month.value).toBe('2025-03')
    fireEvent.change(month, { target: { value: '2025-04' } })
    expect(props.setSalaryMonth).toHaveBeenCalledWith('2025-04')
  })

  it('the month input carries its full control + dark picker styling', () => {
    renderField()
    expect(screen.getByTestId('create-transaction-salary-month')).toHaveClass(
      'flex',
      'h-9',
      'w-full',
      'rounded-md',
      'border',
      'border-input',
      'bg-transparent',
      'px-3',
      'py-1',
      'text-sm',
      'shadow-sm',
      'transition-colors',
      'placeholder:text-muted-foreground',
      'focus-visible:outline-none',
      'focus-visible:ring-1',
      'focus-visible:ring-ring',
      'disabled:cursor-not-allowed',
      'disabled:opacity-50',
      'cursor-pointer',
      '[color-scheme:dark]',
      '[&::-webkit-calendar-picker-indicator]:opacity-60',
      '[&::-webkit-calendar-picker-indicator]:cursor-pointer',
      '[&::-webkit-calendar-picker-indicator]:invert',
      '[&::-webkit-calendar-picker-indicator]:hover:opacity-100',
    )
  })

  it('click and focus open the native picker when the browser has one', () => {
    renderField()
    const month = screen.getByTestId('create-transaction-salary-month') as HTMLInputElement
    const showPicker = vi.fn()
    month.showPicker = showPicker
    fireEvent.click(month)
    expect(showPicker).toHaveBeenCalledTimes(1)
    fireEvent.focus(month)
    expect(showPicker).toHaveBeenCalledTimes(2)
  })

  it('click and focus are harmless in a browser without showPicker', () => {
    renderField()
    const month = screen.getByTestId('create-transaction-salary-month') as HTMLInputElement
    expect(month.showPicker).toBeUndefined()
    expect(() => {
      fireEvent.click(month)
      fireEvent.focus(month)
    }).not.toThrow()
  })
})

describe('TransferSwapField', () => {
  const SWAP_TITLE = 'Натисніть, щоб змінити напрямок'

  function renderField(over: Partial<Parameters<typeof TransferSwapField>[0]> = {}) {
    const props = {
      transferSender: ADMINS[0],
      transferReceiver: ADMINS[1],
      swapTransfer: vi.fn(),
      ...over,
    }
    ui(<TransferSwapField {...props} />)
    return props
  }

  it('shows both parties: initial, name and role caption', () => {
    renderField()
    const [senderCard, , receiverCard] = screen.getAllByRole('button')
    expect(senderCard).toHaveTextContent('A')
    expect(senderCard).toHaveTextContent('Alice Admin')
    expect(senderCard).toHaveTextContent('надсилає')
    expect(receiverCard).toHaveTextContent('B')
    expect(receiverCard).toHaveTextContent('Bob Admin')
    expect(receiverCard).toHaveTextContent('отримує')
  })

  it('falls back to "?" and an em dash while a party is unresolved', () => {
    renderField({ transferSender: undefined, transferReceiver: undefined })
    const [senderCard, , receiverCard] = screen.getAllByRole('button')
    expect(senderCard).toHaveTextContent('?')
    expect(senderCard).toHaveTextContent('—')
    expect(receiverCard).toHaveTextContent('?')
    expect(receiverCard).toHaveTextContent('—')
  })

  it('the sender card, the arrow and the receiver card all swap the direction', () => {
    const props = renderField()
    for (const button of screen.getAllByRole('button')) fireEvent.click(button)
    expect(props.swapTransfer).toHaveBeenCalledTimes(3)
  })

  it('has the swap hint titles and caption', () => {
    renderField()
    expect(screen.getAllByTitle(SWAP_TITLE)).toHaveLength(2)
    expect(screen.getByTitle('Поміняти напрямок')).toBeInTheDocument()
    expect(
      screen.getByText('Натисніть на картки або стрілку, щоб змінити напрямок'),
    ).toBeInTheDocument()
  })

  it('the two party cards share the bordered card styling', () => {
    renderField()
    const [senderCard, , receiverCard] = screen.getAllByRole('button')
    for (const card of [senderCard, receiverCard]) {
      expect(card).toHaveClass(
        'flex-1',
        'flex',
        'flex-col',
        'items-center',
        'gap-1',
        'rounded-lg',
        'border',
        'px-3',
        'py-2.5',
        'transition-all',
        'text-center',
        'border-border',
        'bg-muted/20',
        'hover:bg-muted/40',
      )
    }
  })
})

describe('TypeSelector', () => {
  it('marks the active type and reports a click on another one', () => {
    const onSelectType = vi.fn()
    ui(
      <TypeSelector
        availableTypes={['ADMIN_INCOME', 'EXPENSE']}
        type="ADMIN_INCOME"
        onSelectType={onSelectType}
      />,
    )
    const active = screen.getByTestId('create-transaction-type-admin_income')
    const inactive = screen.getByTestId('create-transaction-type-expense')
    expect(active).toHaveClass(
      'flex',
      'items-center',
      'gap-3',
      'rounded-lg',
      'border',
      'px-3',
      'py-2',
      'text-left',
      'transition-all',
      'border-primary',
      'bg-primary/8',
      'text-foreground',
    )
    expect(inactive).toHaveClass(
      'flex',
      'items-center',
      'gap-3',
      'rounded-lg',
      'border',
      'border-border',
      'bg-muted/20',
      'text-muted-foreground',
      'hover:border-border/80',
      'hover:bg-muted/40',
    )
    expect(inactive).not.toHaveClass('border-primary')
    fireEvent.click(inactive)
    expect(onSelectType).toHaveBeenCalledWith('EXPENSE')
  })
})

describe('ExpenseCategoryField', () => {
  it('suggestion chips: the typed category is highlighted, the others are muted, click fills the input', () => {
    const setCategory = vi.fn()
    ui(<ExpenseCategoryField category="" setCategory={setCategory} />)
    const chip = screen.getByTestId('create-transaction-expense-category-suggestion-0')
    expect(chip).toHaveClass(
      'border-border',
      'text-muted-foreground',
      'hover:border-border/80',
      'hover:bg-muted/50',
    )
    expect(chip).not.toHaveClass('border-primary')
    fireEvent.click(chip)
    expect(setCategory).toHaveBeenCalledWith(chip.textContent)
  })

  it('the chip equal to the typed category is highlighted', () => {
    const { unmount } = ui(<ExpenseCategoryField category="" setCategory={vi.fn()} />)
    const label = screen.getByTestId(
      'create-transaction-expense-category-suggestion-0',
    ).textContent!
    unmount()
    ui(<ExpenseCategoryField category={label} setCategory={vi.fn()} />)
    expect(screen.getByTestId('create-transaction-expense-category-suggestion-0')).toHaveClass(
      'border-primary',
      'bg-primary/10',
      'text-primary',
    )
  })
})

describe('ReceiptField', () => {
  function renderField(fieldErrors: Record<string, string> = {}) {
    const props = {
      receipt: {} as ReceiptState,
      setReceipt: vi.fn(),
      clearFieldError: vi.fn(),
      fieldErrors,
      isExplorerOnly: true,
    }
    ui(<ReceiptField {...props} />)
    return props
  }

  it('forwards the explorer-only mode and the mandatory label', () => {
    renderField()
    const input = screen.getByTestId('fake-receipt-input')
    expect(input).toHaveAttribute('data-explorer-only', 'true')
    expect(input).toHaveAttribute('data-label', 'Чек / підтвердження *')
  })

  it('a change is stored and clears the receipt error', () => {
    const props = renderField()
    fireEvent.click(screen.getByTestId('fake-receipt-input'))
    expect(props.setReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'url', externalUrl: 'https://x.test/r' }),
    )
    expect(props.clearFieldError).toHaveBeenCalledWith('receipt')
  })

  it('shows the receipt error under the input', () => {
    renderField({ receipt: 'Додайте чек' })
    expect(screen.getByTestId('create-transaction-error-receipt')).toHaveTextContent('Додайте чек')
    expect(screen.getByTestId('fake-receipt-input')).toHaveAttribute('data-error', 'Додайте чек')
  })

  it('shows no error text when there is none', () => {
    renderField()
    expect(screen.queryByTestId('create-transaction-error-receipt')).not.toBeInTheDocument()
  })
})

describe('ProjectSelectSection', () => {
  const OWN: ProjectOption = { id: 'p-own', name: 'Own Project', seniorId: 'u-1' }
  const ADMIN_POOL: ProjectOption = { id: 'p-admin', name: 'Admin Pool Project', seniorId: 'u-1' }
  const DROP_POOL: ProjectOption = {
    id: 'p-drop',
    name: 'Drop Pool Project',
    seniorId: 'u-9',
    dropId: 'u-1',
  }

  function renderSection(over: Partial<Parameters<typeof ProjectSelectSection>[0]> = {}) {
    const props = {
      type: 'ADMIN_INCOME' as const,
      projectId: '',
      fieldErrors: {} as Record<string, string>,
      adminProjects: [ADMIN_POOL],
      dropProjects: [DROP_POOL],
      myProjects: [OWN],
      adminOwnProjects: [ADMIN_POOL],
      projects: [OWN, ADMIN_POOL, DROP_POOL],
      userId: 'u-1',
      isAccountant: false,
      onProjectChange: vi.fn(),
      ...over,
    }
    ui(<ProjectSelectSection {...props} />)
    return props
  }

  async function optionNames(): Promise<string[]> {
    fireEvent.click(screen.getByTestId('create-transaction-project-trigger'))
    const listbox = await screen.findByRole('listbox')
    return within(listbox)
      .getAllByRole('option')
      .map((o) => o.textContent ?? '')
  }

  it('ADMIN_INCOME offers the admin pool', async () => {
    renderSection({ type: 'ADMIN_INCOME' })
    expect(await optionNames()).toEqual(['Admin Pool Project'])
  })

  it('DROP_INCOME offers the drop pool', async () => {
    renderSection({ type: 'DROP_INCOME' })
    expect(await optionNames()).toEqual(['Drop Pool Project'])
  })

  it('SENIOR_INCOME offers the senior pool', async () => {
    renderSection({ type: 'SENIOR_INCOME' })
    expect(await optionNames()).toEqual(['Own Project'])
  })

  it('picking a project reports its id', async () => {
    const props = renderSection({ type: 'SENIOR_INCOME' })
    fireEvent.click(screen.getByTestId('create-transaction-project-trigger'))
    fireEvent.click(await screen.findByRole('option', { name: 'Own Project' }))
    expect(props.onProjectChange).toHaveBeenCalledWith('p-own')
  })

  it('project error: red border + message; otherwise neither', () => {
    renderSection({ fieldErrors: { project: 'Виберіть проєкт' } })
    expect(screen.getByTestId('create-transaction-project-trigger')).toHaveClass(
      'h-9',
      'text-sm',
      'border-destructive',
    )
    expect(screen.getByTestId('create-transaction-error-project')).toHaveTextContent(
      'Виберіть проєкт',
    )
  })

  it('no project error: plain border, no message', () => {
    renderSection()
    expect(screen.getByTestId('create-transaction-project-trigger')).not.toHaveClass(
      'border-destructive',
    )
    expect(screen.queryByTestId('create-transaction-error-project')).not.toBeInTheDocument()
  })

  it('types without a project render no selector at all', () => {
    renderSection({ type: 'EXPENSE' })
    expect(screen.queryByTestId('create-transaction-project-trigger')).not.toBeInTheDocument()
  })

  describe('USDT gate hints', () => {
    it('SENIOR with projects, all of them USDT (empty pool) sees the senior hint only', () => {
      renderSection({
        type: 'SENIOR_INCOME',
        myProjects: [],
        projects: [{ ...OWN, paymentType: 'USDT' }],
        userId: 'u-1',
      })
      expect(screen.getByTestId('senior-income-usdt-gate-hint')).toBeInTheDocument()
      expect(screen.queryByTestId('drop-income-usdt-gate-hint')).not.toBeInTheDocument()
    })

    it('SENIOR with a usable project sees no hint', () => {
      renderSection({ type: 'SENIOR_INCOME', myProjects: [OWN], projects: [OWN], userId: 'u-1' })
      expect(screen.queryByTestId('senior-income-usdt-gate-hint')).not.toBeInTheDocument()
    })

    it('SENIOR owning nothing sees no hint', () => {
      renderSection({
        type: 'SENIOR_INCOME',
        myProjects: [],
        projects: [OWN],
        userId: 'someone-else',
      })
      expect(screen.queryByTestId('senior-income-usdt-gate-hint')).not.toBeInTheDocument()
    })

    it('the senior hint is for SENIOR_INCOME only', () => {
      renderSection({ type: 'EXPENSE', myProjects: [], projects: [OWN], userId: 'u-1' })
      expect(screen.queryByTestId('senior-income-usdt-gate-hint')).not.toBeInTheDocument()
    })

    it('DROP with projects, all of them USDT (empty pool) sees the drop hint only', () => {
      renderSection({
        type: 'DROP_INCOME',
        dropProjects: [],
        projects: [{ ...DROP_POOL, paymentType: 'USDT' }],
        userId: 'u-1',
      })
      expect(screen.getByTestId('drop-income-usdt-gate-hint')).toBeInTheDocument()
      expect(screen.queryByTestId('senior-income-usdt-gate-hint')).not.toBeInTheDocument()
    })

    it('DROP with a usable project sees no hint', () => {
      renderSection({
        type: 'DROP_INCOME',
        dropProjects: [DROP_POOL],
        projects: [DROP_POOL],
        userId: 'u-1',
      })
      expect(screen.queryByTestId('drop-income-usdt-gate-hint')).not.toBeInTheDocument()
    })

    it('DROP owning nothing sees no hint', () => {
      renderSection({
        type: 'DROP_INCOME',
        dropProjects: [],
        projects: [DROP_POOL],
        userId: 'someone-else',
      })
      expect(screen.queryByTestId('drop-income-usdt-gate-hint')).not.toBeInTheDocument()
    })

    it('the drop hint is for DROP_INCOME only', () => {
      renderSection({ type: 'EXPENSE', dropProjects: [], projects: [DROP_POOL], userId: 'u-1' })
      expect(screen.queryByTestId('drop-income-usdt-gate-hint')).not.toBeInTheDocument()
    })
  })
})
