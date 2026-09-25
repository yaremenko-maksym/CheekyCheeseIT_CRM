/**
 * `UserDialog` — exact-text pins for Section titles, Field labels/hints/
 * placeholders, and a handful of role-dependent conditionals.
 *
 * task-i18n-stage3b-pr3 round B (mutation gate): none of the other five
 * `UserDialog.*.test.tsx` files assert the LITERAL catalog text of these —
 * they test wizard navigation, POST/PATCH payloads, and validation errors,
 * all of which pass just as well whether a label reads "Роль" or "". This
 * file is the one place that actually reads what an admin sees.
 *
 * Step 1 (the create form) renders on first mount without any wizard
 * navigation, so most of this file is a single render per role — no
 * `userEvent` step-advancing needed. Only the payment-method toggle and the
 * team-mode radios need a click to reach their second branch.
 */
import { render as rtlRender, screen, within, type RenderOptions } from '@testing-library/react'
import type { ReactElement } from 'react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { i18n } from '@lingui/core'
import type { TeamDto, UserProfileDto } from '@crm/shared'

function render(ui: ReactElement, options?: RenderOptions) {
  return rtlRender(ui, { wrapper: I18nTestProvider, ...options })
}

beforeAll(() => {
  i18n.load('uk', {})
  i18n.activate('uk')
})

beforeEach(async () => {
  await loadCatalog('uk')
})

// ── Mocks (same shape as UserDialog.create-wizard.test.tsx) ────────────────

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'admin-1', role: 'ADMIN', displayName: 'Admin' } }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    Link: ({ children, to }: { children?: React.ReactNode; to?: string }) => (
      <a href={to ?? '#'}>{children}</a>
    ),
    useNavigate: () => vi.fn(),
  }
})

const mockPost = vi.fn()
const mockPatch = vi.fn()
const mockGet = vi.fn()

vi.mock('@/lib/axios', () => ({
  api: {
    post: (...args: unknown[]) => mockPost(...args),
    patch: (...args: unknown[]) => mockPatch(...args),
    get: (...args: unknown[]) => mockGet(...args),
  },
}))

vi.mock('@/components/user-profile/contract/useEmployeeContract', () => ({
  useEmployeeContract: vi.fn().mockReturnValue({ data: undefined, isLoading: false, error: null }),
  useSaveContractBody: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  useMarkContractReady: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  useResetContractToTemplate: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  useRevertContract: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  contractActionState: vi.fn().mockReturnValue({
    editable: true,
    showSave: true,
    showMarkReady: true,
    showReset: true,
    showRevert: false,
    revertDestructive: false,
  }),
  contractKeys: { detail: (id: string) => ['employee-contract', id] },
}))
vi.mock('@/components/user-profile/contract/ContractEditor', () => ({
  ContractEditor: () => <div data-testid="contract-editor-mock" />,
}))
vi.mock('@/components/user-profile/contract/ContractActionBar', () => ({
  ContractActionBar: () => <div data-testid="contract-action-bar-mock" />,
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// Flexible per-queryKey `useQuery` mock — lets individual tests supply just
// the fixture their scenario needs (vacant drop-teams, a junior's active
// project, …) instead of one giant shared fixture every other test also pays
// for.
let mockUsersAdmin: unknown[] | undefined = undefined
let mockProjects: unknown[] | undefined = undefined
let mockDropTeamsForJoin: TeamDto[] | undefined = undefined

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: vi.fn().mockImplementation((opts: { queryKey: readonly unknown[] }) => {
      const key = opts.queryKey[0]
      if (key === 'users-admin') return { data: mockUsersAdmin, isLoading: false, error: null }
      if (key === 'projects') return { data: mockProjects, isLoading: false, error: null }
      if (key === 'teams') {
        const second = opts.queryKey[1] as { type?: string } | undefined
        if (second?.type === 'DROP') {
          return { data: mockDropTeamsForJoin, isLoading: false, error: null }
        }
        return { data: undefined, isLoading: false, error: null }
      }
      return { data: undefined, isLoading: false, error: null }
    }),
    useQueryClient: vi
      .fn()
      .mockReturnValue({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
    useMutation: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  }
})

import { UserDialog } from '../UserDialog'

beforeEach(() => {
  vi.clearAllMocks()
  mockGet.mockResolvedValue({ data: [] })
  mockUsersAdmin = undefined
  mockProjects = undefined
  mockDropTeamsForJoin = undefined
})

async function selectRole(user: ReturnType<typeof userEvent.setup>, optionName: string) {
  await user.click(screen.getByTestId('user-dialog-role-trigger'))
  const listbox = await screen.findByRole('listbox')
  await user.click(within(listbox).getByRole('option', { name: optionName }))
}

// ── Always-visible Step 1 fields (JUNIOR default: BANK_UAH_FOP) ────────────

describe('UserDialog — Identity + contract-data sections (JUNIOR default)', () => {
  it('Section «Основне» + the always-visible identity fields', () => {
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    expect(screen.getByText('Основне')).toBeInTheDocument()
    expect(
      screen.getByText(
        'На цю адресу одразу піде запрошення. Увійти з цією адресою співробітник зможе лише після її підтвердження.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Ім’я та прізвище')).toBeInTheDocument()
    expect(screen.getByTestId('user-dialog-name')).toHaveAttribute(
      'placeholder',
      'Іваненко Іван Іванович',
    )
    expect(screen.getByText('Роль')).toBeInTheDocument()
    expect(screen.getByText('Мова інтерфейсу')).toBeInTheDocument()
    expect(
      screen.getByText('Мова інтерфейсу співробітника — він зможе змінити її у своєму профілі.'),
    ).toBeInTheDocument()
  })

  it('Section «Дані для контракту»: legal name + registration address', () => {
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    expect(screen.getByText('Дані для контракту')).toBeInTheDocument()
    expect(screen.getByText('Юридичне ПІБ')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Використовується в MSA-контракті замість імені та прізвища. Формат: Прізвище Ім’я По батькові.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByTestId('user-dialog-legal-full-name')).toHaveAttribute(
      'placeholder',
      'Іваненко Іван Іванович',
    )
    expect(screen.getByText('Адреса реєстрації (ФОП)')).toBeInTheDocument()
    expect(screen.getByText('Ця адреса підставляється в текст контракту')).toBeInTheDocument()
    expect(screen.getByTestId('user-dialog-registration-address')).toHaveAttribute(
      'placeholder',
      'м. Київ, вул. Хрещатик, 1',
    )
  })

  it('Section «Контакти»: phone field label', () => {
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    expect(screen.getByText('Контакти')).toBeInTheDocument()
    expect(screen.getByText('Телефон')).toBeInTheDocument()
  })

  it('Section «Професія»: tech-stack field label + placeholder', () => {
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    expect(screen.getByText('Професія')).toBeInTheDocument()
    expect(screen.getByText('Технології')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Почніть вводити: React, Node.js…')).toBeInTheDocument()
  })

  it('Section «Фінанси» (JUNIOR default): salary amount + currency labels', () => {
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    expect(screen.getByText('Фінанси')).toBeInTheDocument()
    expect(screen.getByText('Місячна зарплата')).toBeInTheDocument()
    expect(screen.getByText('Сума')).toBeInTheDocument()
    expect(screen.getByText('Валюта')).toBeInTheDocument()
  })

  it('Section «Команда» (JUNIOR create): project field label + hint', () => {
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    expect(screen.getByText('Команда')).toBeInTheDocument()
    expect(screen.getByText('Проєкт')).toBeInTheDocument()
    expect(screen.getByText('Можна прикріпити пізніше в розділі «Проєкти»')).toBeInTheDocument()
  })
})

describe('UserDialog — Section «Реквізити для виплат» (JUNIOR default: BANK_UAH_FOP)', () => {
  it('the toggle: label, radiogroup aria-label, both option texts, and the FOP note', () => {
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    expect(screen.getByText('Реквізити для виплат')).toBeInTheDocument()
    expect(screen.getByText('Спосіб виплати')).toBeInTheDocument()
    const group = screen.getByRole('radiogroup', { name: 'Спосіб виплати' })
    expect(within(group).getByText('USDT ERC-20')).toBeInTheDocument()
    expect(within(group).getByText('ФОП (UAH)')).toBeInTheDocument()
    // Default payment method for JUNIOR is BANK_UAH_FOP — the FOP note, not
    // the USDT one (distinguishes the `field.state.value === 'USDT_ERC20'`
    // ConditionalExpression/EqualityOperator mutants from the real behavior).
    expect(
      screen.getByText('Використовуватиметься український банківський рахунок ФОП.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Використовуватиметься адреса гаманця в мережі Ethereum.'),
    ).not.toBeInTheDocument()
  })

  it('BANK_UAH_FOP requisite fields: labels + placeholders', () => {
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    expect(screen.getByText('ПІБ отримувача (ФОП)')).toBeInTheDocument()
    expect(screen.getByTestId('user-dialog-bank-recipient')).toHaveAttribute(
      'placeholder',
      'Іваненко Іван Іванович',
    )
    expect(screen.getByText('РНОКПП')).toBeInTheDocument()
    expect(screen.getByText('Банк (необов’язково)')).toBeInTheDocument()
    // No data-testid on this one field — the placeholder itself is the only
    // stable handle, and it is also exactly what's under test here.
    expect(screen.getByPlaceholderText('ПриватБанк')).toBeInTheDocument()
  })

  it('switching the toggle to USDT ERC-20 flips the note AND reveals the wallet fields', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    const group = screen.getByRole('radiogroup', { name: 'Спосіб виплати' })
    await user.click(within(group).getByText('USDT ERC-20'))

    expect(
      screen.getByText('Використовуватиметься адреса гаманця в мережі Ethereum.'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText('Використовуватиметься український банківський рахунок ФОП.'),
    ).not.toBeInTheDocument()

    expect(screen.getByText('Гаманець USDT (ERC-20)')).toBeInTheDocument()
    expect(screen.getByText('Мітка гаманця (необов’язково)')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('наприклад: основний')).toBeInTheDocument()
  })
})

// ── Role-dependent sections ─────────────────────────────────────────────────

describe('UserDialog — role SENIOR: share field, USDT-only requisites, team section', () => {
  it('«Частка сеньйора (%)» field replaces the salary field', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    await selectRole(user, 'Сеньйор')
    expect(screen.getByText('Частка сеньйора (%)')).toBeInTheDocument()
    expect(screen.queryByText('Місячна зарплата')).not.toBeInTheDocument()
  })

  it('USDT-only requisites render directly (no toggle — SENIOR is USDT-only)', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    await selectRole(user, 'Сеньйор')
    expect(screen.getByText('Гаманець USDT (ERC-20)')).toBeInTheDocument()
    expect(screen.getByText('Мітка гаманця (необов’язково)')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('наприклад: основний')).toBeInTheDocument()
  })

  it('Section «Команда»: team-mode field, and "no vacant teams" when there are none', async () => {
    mockDropTeamsForJoin = []
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    await selectRole(user, 'Сеньйор')

    expect(screen.getByText('Тип команди')).toBeInTheDocument()
    expect(screen.getByText('Немає команд дропа без активного сеньйора.')).toBeInTheDocument()
  })

  it('with at least one vacant drop-team, shows the count instead of "none available"', async () => {
    mockDropTeamsForJoin = [
      {
        id: 'team-1',
        name: 'Drop Team Alpha',
        type: 'DROP',
        archivedAt: null,
        members: [],
      } as unknown as TeamDto,
    ]
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    await selectRole(user, 'Сеньйор')

    expect(screen.queryByText('Немає команд дропа без активного сеньйора.')).not.toBeInTheDocument()
    // <Plural> one="# команда доступна." — exact for count=1.
    expect(screen.getByText('1 команда доступна.')).toBeInTheDocument()
  })

  it('the team Telegram channel field: label + hint (CREATE_NEW is the default team mode)', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    await selectRole(user, 'Сеньйор')
    expect(screen.getByText('Telegram-канал команди')).toBeInTheDocument()
    expect(screen.getByText('Необов’язково. Канал для спілкування команди.')).toBeInTheDocument()
  })
})

describe('UserDialog — role DROP: share field replaces salary', () => {
  it('«Частка дропа (%)» field + hint', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)
    await selectRole(user, 'Дроп')
    expect(screen.getByText('Частка дропа (%)')).toBeInTheDocument()
    expect(screen.getByText('Скільки дроп залишає собі з кожної виплати')).toBeInTheDocument()
    expect(screen.queryByText('Місячна зарплата')).not.toBeInTheDocument()
  })
})

describe('UserDialog — JUNIOR edit mode: read-only "Активні проєкти"', () => {
  const juniorProfile: UserProfileDto = {
    id: 'junior-42',
    email: 'junior42@example.dev',
    displayName: 'Джуніор Едіт',
    role: 'JUNIOR',
    avatarUrl: null,
    avatarDocumentId: null,
    telegram: null,
    phone: null,
    techStack: null,
    paymentMethod: 'BANK_UAH_FOP',
    walletUsdtErc20: null,
    walletUsdtLabel: null,
    bankUahRecipient: 'Тест Тестов',
    bankUahIban: 'UA123456789012345678901234567',
    bankUahRnokpp: '1234567890',
    bankUahBankName: null,
    seniorSharePercent: 0,
    dropSharePercent: null,
    legalFullName: 'Тестов Тест Тестович',
    monthlySalary: null,
    salaryCurrency: 'USD',
    archivedAt: null,
    adminNote: null,
    createdAt: new Date().toISOString(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture, real UserProfileDto has more fields than this scenario needs
  } as any

  it('Section «Команда» (JUNIOR edit): "Активні проєкти" label + populated badge list', () => {
    mockProjects = [
      {
        id: 'proj-1',
        companyName: 'Acme',
        name: 'Website',
        archivedAt: null,
        members: [{ userId: 'junior-42', role: 'JUNIOR', leftAt: null }],
      },
    ]
    render(<UserDialog mode="edit" user={juniorProfile} onClose={vi.fn()} />)
    expect(screen.getByText('Команда')).toBeInTheDocument()
    expect(screen.getByText('Активні проєкти')).toBeInTheDocument()
    expect(screen.getByTestId('user-dialog-junior-projects')).toHaveTextContent('Acme — Website')
  })

  it('the submit button reads "Зберегти" (exact) while idle — the ONLY place submitLabel is actually rendered', () => {
    // (`submitLabel`'s create-branch, "Створити", is unreachable — the
    // wizard's own step buttons stand in for it in create mode; see the
    // Stryker suppression comment on that ternary in UserDialog.tsx.)
    render(<UserDialog mode="edit" user={juniorProfile} onClose={vi.fn()} />)
    expect(screen.getByTestId('user-dialog-submit')).toHaveTextContent('Зберегти')
    expect(screen.getByTestId('user-dialog-submit')).not.toHaveTextContent('Зберігаємо')
  })
})

// ── Email-change confirmation dialog (edit mode only) ──────────────────────

describe('UserDialog — email-change confirmation dialog (edit mode)', () => {
  const seniorProfile: UserProfileDto = {
    id: 'senior-9',
    email: 'old@example.dev',
    displayName: 'Сеньйор Едіт',
    role: 'SENIOR',
    avatarUrl: null,
    avatarDocumentId: null,
    telegram: null,
    phone: null,
    techStack: null,
    paymentMethod: 'USDT_ERC20',
    walletUsdtErc20: '0x' + '1'.repeat(40),
    walletUsdtLabel: null,
    bankUahRecipient: null,
    bankUahIban: null,
    bankUahRnokpp: null,
    bankUahBankName: null,
    seniorSharePercent: 26,
    dropSharePercent: null,
    legalFullName: 'Тестов Тест Тестович',
    monthlySalary: null,
    salaryCurrency: 'USD',
    archivedAt: null,
    adminNote: null,
    createdAt: new Date().toISOString(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fixture, real UserProfileDto has more fields than this scenario needs
  } as any

  it('shows the old/new email pair, exactly labeled "Старий:"/"Новий:"', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="edit" user={seniorProfile} onClose={vi.fn()} />)

    const emailInput = screen.getByTestId('user-dialog-email')
    await user.clear(emailInput)
    await user.type(emailInput, 'new@example.dev')
    await user.tab()

    const dialog = await screen.findByTestId('email-change-warning')
    // The two labels and the two addresses sit as sibling text/element nodes
    // inside one <span> (no per-label wrapper), so `toHaveTextContent`
    // (whole-subtree substring match) is the correct query here — `getByText`
    // matches per-element own-text and would see "Старий: Новий:" concatenated
    // as this span's single computed text, never "Старий:" alone.
    expect(dialog).toHaveTextContent('Зміна email може розірвати вхід через Google для')
    expect(dialog).toHaveTextContent('Старий:')
    expect(dialog).toHaveTextContent('old@example.dev')
    expect(dialog).toHaveTextContent('Новий:')
    expect(dialog).toHaveTextContent('new@example.dev')
  })
})
