/**
 * `UserDialog` — wiring of the extracted payload builders (UserDialog L18).
 *
 * `user-dialog/__tests__/payloads.test.ts` pins `buildCreateUserPayload` /
 * `computeMonthlySalaryUsd` as pure functions. This file pins the one thing
 * those unit tests cannot: that `onSubmit` feeds them the right inputs — the
 * HR / accountant selections (resolved from refs by the caller) and the
 * salary — and sends the result to the API.
 */
import {
  render as rtlRender,
  screen,
  waitFor,
  within,
  type RenderOptions,
} from '@testing-library/react'
import type { ReactElement } from 'react'
import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'
import { i18n } from '@lingui/core'

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

// Exactly one HR and one accountant exist -> create mode pre-selects both
// (see `useTeamSelection`), so the SENIOR flow needs no picker clicks.
// `createUserSchema` requires UUIDs for `hrIds` / `accountantId`.
const HR_ID = '11111111-1111-4111-8111-111111111111'
const ACCOUNTANT_ID = '22222222-2222-4222-8222-222222222222'
const USERS_ADMIN = [
  { id: HR_ID, role: 'HR', archivedAt: null, displayName: 'Hr One', email: 'hr@x.io' },
  {
    id: ACCOUNTANT_ID,
    role: 'ACCOUNTANT',
    archivedAt: null,
    displayName: 'Acc One',
    email: 'a@x.io',
  },
]
const RATES = { usdUah: '41', usdtUah: '41', eurUah: '44.5', date: '2026-10-06' }

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    useQuery: vi.fn().mockImplementation((opts: { queryKey: readonly unknown[] }) => {
      const key = opts.queryKey[0]
      if (key === 'users-admin') return { data: USERS_ADMIN, isLoading: false, error: null }
      if (key === 'exchange-rate') return { data: RATES, isLoading: false, error: null }
      return { data: undefined, isLoading: false, error: null }
    }),
    useQueryClient: vi
      .fn()
      .mockReturnValue({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
    useMutation: vi
      .fn()
      .mockImplementation(
        ({
          mutationFn,
          onSuccess,
          onError,
        }: {
          mutationFn: (data: unknown) => Promise<unknown>
          onSuccess?: (res: unknown, vars: unknown) => void
          onError?: (err: unknown, vars: unknown) => void
        }) => {
          const mutate = vi.fn(async (data: unknown) => {
            try {
              const res = await mutationFn(data)
              await onSuccess?.(res, data)
            } catch (e) {
              await onError?.(e, data)
            }
          })
          return { mutate, isPending: false }
        },
      ),
  }
})

import { UserDialog } from '../UserDialog'

const createdUser = { data: { id: 'new-user-id-1', email: 'new@example.com', role: 'JUNIOR' } }

beforeEach(() => {
  vi.clearAllMocks()
  mockGet.mockResolvedValue({ data: [] })
  mockPost.mockResolvedValue(createdUser)
  mockPatch.mockResolvedValue(createdUser)
})

async function selectRole(user: ReturnType<typeof userEvent.setup>, optionName: string) {
  await user.click(screen.getByTestId('user-dialog-role-trigger'))
  const listbox = await screen.findByRole('listbox')
  await user.click(within(listbox).getByRole('option', { name: optionName }))
}

describe('UserDialog — create payload wiring', () => {
  it('SENIOR create: POST /users carries the selected HR + accountant from the team pickers', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    await user.type(screen.getByTestId('user-dialog-email'), 'senior@example.com')
    await user.type(screen.getByTestId('user-dialog-name'), 'Senior Person')
    await selectRole(user, 'Сеньйор')
    await user.type(screen.getByTestId('user-dialog-legal-full-name'), 'Senior Legal Person')
    await user.type(
      screen.getByTestId('user-dialog-wallet'),
      '0x1234567890abcdef1234567890abcdef12345678',
    )
    await user.click(screen.getByTestId('wizard-next-btn'))

    await waitFor(() => {
      expect(mockPost.mock.calls.filter((c) => String(c[0]) === '/users')).toHaveLength(1)
    })
    const body = mockPost.mock.calls.find((c) => String(c[0]) === '/users')?.[1]
    expect(body).toMatchObject({
      email: 'senior@example.com',
      role: 'SENIOR',
      paymentMethod: 'USDT_ERC20',
      walletUsdtErc20: '0x1234567890abcdef1234567890abcdef12345678',
      hrIds: [HR_ID],
      accountantId: ACCOUNTANT_ID,
    })
  })

  it('non-SENIOR create: the salary is sent and the PATCH after «Назад» re-sends it via the same helper', async () => {
    const user = userEvent.setup()
    render(<UserDialog mode="create" open={true} onClose={vi.fn()} />)

    await user.type(screen.getByTestId('user-dialog-email'), 'junior@example.com')
    await user.type(screen.getByTestId('user-dialog-name'), 'Junior Person')
    await user.type(screen.getByTestId('user-dialog-legal-full-name'), 'Junior Legal Person')
    await user.type(screen.getByTestId('user-dialog-bank-recipient'), 'Junior Person')
    await user.type(screen.getByTestId('user-dialog-bank-iban'), 'UA123456789012345678901234567')
    await user.type(screen.getByTestId('user-dialog-bank-rnokpp'), '1234567890')
    await user.type(screen.getByTestId('amount-currency-amount-input'), '1500.5')
    await user.click(screen.getByTestId('wizard-next-btn'))

    await waitFor(() =>
      expect(screen.getByTestId('wizard-step-2')).toHaveAttribute('data-state', 'active'),
    )
    const postBody = mockPost.mock.calls.find((c) => String(c[0]) === '/users')?.[1]
    expect(postBody).toMatchObject({ monthlySalary: 1500.5, salaryCurrency: 'USD' })

    await user.click(screen.getByTestId('wizard-back-btn'))
    await waitFor(() =>
      expect(screen.getByTestId('wizard-step-1')).toHaveAttribute('data-state', 'active'),
    )
    await user.click(screen.getByTestId('wizard-next-btn'))

    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(1))
    expect(mockPatch.mock.calls[0]?.[1]).toMatchObject({
      monthlySalary: 1500.5,
      salaryCurrency: 'USD',
    })
  })
})
