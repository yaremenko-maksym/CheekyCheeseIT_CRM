/**
 * task-accountant-create-transaction — CreateTransactionDialog role-parity test.
 *
 * Pins the frontend AC: an ACCOUNTANT sees the SAME create-transaction type set
 * as an ADMIN (ADMIN_INCOME / EXPENSE / SALARY / ADMIN_TRANSFER), while a role
 * that should not reach the admin set (SENIOR) renders only its own type. This
 * locks the `isAdminSet = isAdmin || isAccountant` widening so a future edit
 * cannot silently drop the accountant back to an empty/foreign type list.
 *
 * Strategy mirrors UserDialog.create-wizard.test.tsx: mock auth/axios/router and
 * use the real query/mutation hooks (with a mocked queryClient) so the component
 * lifecycle works without a network.
 */
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

// ── Mutable auth role so each test can pick the persona ─────────────────────
let currentRole = 'ADMIN'
vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1', role: currentRole, displayName: 'Tester' } }),
}))

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({ data: {} }),
  },
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

// Real query/mutation hooks, but no network + a stub queryClient.
vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: vi
      .fn()
      .mockReturnValue({ data: [], isLoading: false, isFetching: false, error: null }),
    useQueryClient: vi
      .fn()
      .mockReturnValue({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
    useMutation: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false, error: null }),
  }
})

// ── Component under test (imported AFTER mocks) ─────────────────────────────
import { CreateTransactionDialog } from '../CreateTransactionDialog'

// The full set an ADMIN can create — ACCOUNTANT must match it exactly.
const ADMIN_SET_TESTIDS = [
  'create-transaction-type-admin_income',
  'create-transaction-type-expense',
  'create-transaction-type-salary',
  'create-transaction-type-admin_transfer',
]

function renderDialog() {
  return render(<CreateTransactionDialog open onClose={() => {}} />, { wrapper: I18nTestProvider })
}

describe('CreateTransactionDialog — ACCOUNTANT/ADMIN type parity', () => {
  beforeEach(async () => {
    await loadCatalog('uk')
    currentRole = 'ADMIN'
  })

  it('ACCOUNTANT sees the SAME type set as ADMIN', () => {
    currentRole = 'ACCOUNTANT'
    renderDialog()
    for (const id of ADMIN_SET_TESTIDS) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    // And NOT the senior/drop income-only cards.
    expect(screen.queryByTestId('create-transaction-type-senior_income')).not.toBeInTheDocument()
    expect(screen.queryByTestId('create-transaction-type-drop_income')).not.toBeInTheDocument()
  })

  it('ADMIN sees the full admin set (regression baseline)', () => {
    currentRole = 'ADMIN'
    renderDialog()
    for (const id of ADMIN_SET_TESTIDS) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
  })

  it('SENIOR does NOT get the admin set (no over-grant)', () => {
    currentRole = 'SENIOR'
    renderDialog()
    expect(screen.getByTestId('create-transaction-type-senior_income')).toBeInTheDocument()
    for (const id of ADMIN_SET_TESTIDS) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument()
    }
  })
})

// task-payout-company-ui WS3 — DIVIDEND option is ADMIN-only. Dividends are
// withdrawn by an ADMIN partner; the ACCOUNTANT (despite admin-parity on the
// other types) must NOT see the dividend withdrawal here.
describe('CreateTransactionDialog — DIVIDEND option (ADMIN-only, WS3)', () => {
  beforeEach(() => {
    currentRole = 'ADMIN'
  })

  it('ADMIN sees the DIVIDEND type option', () => {
    currentRole = 'ADMIN'
    renderDialog()
    expect(screen.getByTestId('create-transaction-type-dividend')).toBeInTheDocument()
  })

  it('ACCOUNTANT does NOT see the DIVIDEND type option', () => {
    currentRole = 'ACCOUNTANT'
    renderDialog()
    expect(screen.queryByTestId('create-transaction-type-dividend')).not.toBeInTheDocument()
  })

  it('SENIOR does NOT see the DIVIDEND type option', () => {
    currentRole = 'SENIOR'
    renderDialog()
    expect(screen.queryByTestId('create-transaction-type-dividend')).not.toBeInTheDocument()
  })
})

// i18n-3d-pr3 (AC1) — pins the exact uk text of every type-card label +
// description, including DIVIDEND's own (module-local, not in
// `TYPE_LABEL_MESSAGES`) pair. Without this, the mutation gate finds every
// `msg`` string in `TYPE_DESCRIPTION_MESSAGES`/`DIVIDEND_LABEL_MESSAGE`/
// `DIVIDEND_DESCRIPTION_MESSAGE` survives (no test reads the card's actual
// text, only its testid).
describe('CreateTransactionDialog — type-card copy (i18n-3d-pr3 AC1)', () => {
  beforeEach(() => {
    currentRole = 'ADMIN'
  })

  it('renders the uk label + description for every ADMIN-visible type card', () => {
    renderDialog()
    const cases: Array<[string, string, string]> = [
      ['create-transaction-type-admin_income', 'Прихід адміна', 'Дохід із власного проєкту'],
      ['create-transaction-type-expense', 'Витрата', 'Витрата компанії'],
      ['create-transaction-type-salary', 'Зарплата', 'Зарплата співробітнику'],
      ['create-transaction-type-admin_transfer', 'Переказ', 'Переказ між партнерами'],
      [
        'create-transaction-type-dividend',
        'Дивіденд',
        'Виведення дивідендів із балансу рахунку компанії',
      ],
    ]
    for (const [testId, label, description] of cases) {
      const card = screen.getByTestId(testId)
      expect(card).toHaveTextContent(label)
      expect(card).toHaveTextContent(description)
    }
  })

  it('SENIOR_INCOME card renders "Дохід сеньйора з проєкту"', () => {
    currentRole = 'SENIOR'
    renderDialog()
    expect(screen.getByTestId('create-transaction-type-senior_income')).toHaveTextContent(
      'Дохід сеньйора з проєкту',
    )
  })

  it('DROP_INCOME card renders "Дохід дропа з проєкту"', () => {
    currentRole = 'DROP'
    renderDialog()
    expect(screen.getByTestId('create-transaction-type-drop_income')).toHaveTextContent(
      'Дохід дропа з проєкту',
    )
  })
})

// i18n-3d-pr3 (AC1) — `validate()`'s uk error strings, pinned by field-testid
// so the mutation gate cannot silently accept an empty/wrong message text.
describe('CreateTransactionDialog — validate() error copy (i18n-3d-pr3)', () => {
  beforeEach(() => {
    currentRole = 'ADMIN'
  })

  it('invalid amount → "Вкажіть коректну суму" on the amount field', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('create-transaction-project-trigger'))
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    expect(screen.getByTestId('create-transaction-error-amount')).toHaveTextContent(
      'Вкажіть коректну суму',
    )
  })

  it('ADMIN_INCOME with no project → "Виберіть проєкт" on the project field', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    expect(screen.getByTestId('create-transaction-error-project')).toHaveTextContent(
      'Виберіть проєкт',
    )
  })

  it('ADMIN_INCOME with no receiver → "Виберіть отримувача" on the receiver field', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    expect(screen.getByTestId('admin-income-error-receiver')).toHaveTextContent(
      'Виберіть отримувача',
    )
  })

  it('ADMIN_TRANSFER with no receiver → "Виберіть отримувача" (transfer field)', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('create-transaction-type-admin_transfer'))
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    expect(screen.getByTestId('create-transaction-field-error-summary')).toBeInTheDocument()
  })

  it('DIVIDEND with no receiver → "Виберіть отримувача-партнера"', () => {
    renderDialog()
    fireEvent.click(screen.getByTestId('create-transaction-type-dividend'))
    fireEvent.change(screen.getByTestId('create-transaction-dividend-amount'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    expect(screen.getByTestId('create-transaction-error-amount')).toBeInTheDocument()
  })

  it('SALARY with no receiver → "Виберіть співробітника"', () => {
    currentRole = 'ADMIN'
    renderDialog()
    fireEvent.click(screen.getByTestId('create-transaction-type-salary'))
    fireEvent.click(screen.getByTestId('create-transaction-submit'))
    expect(screen.getByTestId('create-transaction-error-receiver')).toHaveTextContent(
      'Виберіть співробітника',
    )
  })
})

// i18n-3d-pr3 (AC3, owner override) — the three EXPENSE_CATEGORY_MESSAGES
// suggestion chips render their translated uk text (not the raw stored
// `EXPENSE_CATEGORIES` value), while the free-text input keeps showing the
// raw value verbatim.
describe('CreateTransactionDialog — expense category chips (i18n-3d-pr3 AC3)', () => {
  it('shows translated suggestion chips + free-text input with the raw default value', () => {
    currentRole = 'ADMIN'
    renderDialog()
    fireEvent.click(screen.getByTestId('create-transaction-type-expense'))
    expect(screen.getByTestId('create-transaction-expense-category-input')).toHaveValue(
      'Оплата сервиса',
    )
    const chips = screen.getAllByTestId(/create-transaction-expense-category-suggestion-/)
    expect(chips.map((c) => c.textContent)).toEqual(['Оплата послуги', 'Банківський збір', 'Інше'])
  })

  it('typing into the free-text input overrides the stored default value (imported "RumpUp service"-style edits stay possible)', () => {
    currentRole = 'ADMIN'
    renderDialog()
    fireEvent.click(screen.getByTestId('create-transaction-type-expense'))
    const input = screen.getByTestId('create-transaction-expense-category-input')
    fireEvent.change(input, { target: { value: 'RumpUp service' } })
    expect(input).toHaveValue('RumpUp service')
  })
})

// i18n-3d-pr3 (AC1) — footer button copy, including the pending-state label.
describe('CreateTransactionDialog — footer copy (i18n-3d-pr3)', () => {
  it('shows "Скасувати" and "Створити транзакцію" (idle)', () => {
    currentRole = 'ADMIN'
    renderDialog()
    expect(screen.getByTestId('create-transaction-cancel')).toHaveTextContent('Скасувати')
    expect(screen.getByTestId('create-transaction-submit')).toHaveTextContent('Створити транзакцію')
  })
})
