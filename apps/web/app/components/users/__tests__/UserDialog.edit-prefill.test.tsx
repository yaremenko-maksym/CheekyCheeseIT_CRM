/**
 * task-slim-users-projection — UserDialog edit-mode prefill from full profile.
 *
 * WHY this exists (AC2 / AC «пикеры работают» + non-regression):
 *   GET /api/users (list) is now slim — it no longer carries PII / finance
 *   (bankUah*, wallet*, monthlySalary, registrationAddress, usrRecord, …). The
 *   admin user list (/users) passes a slim list-item into <UserDialog
 *   mode="edit">. For the edit form to still prefill requisites / salary / FOP
 *   PII, the dialog now fetches the full single-resource profile via
 *   GET /api/users/:id (buildProfileView, RBAC-unmasked for ADMIN) and merges
 *   it over the slim list-item.
 *
 * This test drives that contract: given a SLIM list-item (no bank fields) and a
 * full profile from useUser() that DOES carry them, the edit form's IBAN /
 * RNOKPP / recipient inputs must be prefilled from the full profile.
 */
import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

// ── Mocks ──────────────────────────────────────────────────────────────────

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

const mockGet = vi.fn()
vi.mock('@/lib/axios', () => ({
  api: {
    post: vi.fn(),
    patch: vi.fn(),
    get: (...args: unknown[]) => mockGet(...args),
  },
}))

// The full single-resource profile the edit form prefills from. Returned by the
// mocked useUser() below. Carries the requisites / PII fields that are ABSENT
// from the slim list payload.
// JUNIOR with BANK_UAH_FOP — the bank requisite inputs only render for non-USDT
// roles (SENIOR/ADMIN are USDT-only), so a JUNIOR exercises the bank prefill.
const fullProfileResponse = {
  user: {
    id: 'junior-7',
    email: 'junior@example.com',
    displayName: 'Джуніор Тест',
    role: 'JUNIOR',
    avatarUrl: null,
    avatarDocumentId: null,
    googleId: null,
    telegram: null,
    phone: null,
    techStack: ['React'],
    paymentMethod: 'BANK_UAH_FOP',
    walletUsdtErc20: null,
    walletUsdtLabel: null,
    bankUahRecipient: 'Іваненко Іван',
    bankUahIban: 'UA903052992990004149123456789',
    bankUahRnokpp: '1234567890',
    bankUahBankName: 'ПриватБанк',
    seniorSharePercent: 0,
    dropSharePercent: null,
    legalFullName: 'Іваненко Іван Іванович',
    registrationAddress: 'м. Київ, вул. Хрещатик, 1',
    usrRecord: '12.05.2024 №2070010099',
    monthlySalary: null,
    salaryCurrency: 'USD',
    archivedAt: null,
    adminNote: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  permissions: { tabs: ['overview'], actions: [], fields: {} },
  data: {},
}

// useUser is the hook the dialog now uses for the full /:id fetch.
const mockUseUser = vi.fn()
vi.mock('@/hooks/use-user-profile', () => ({
  useUser: (...args: unknown[]) => mockUseUser(...args),
}))

// Other contract heavy deps — not exercised in edit-prefill, stub them.
vi.mock('@/components/user-profile/contract/useEmployeeContract', () => ({
  useEmployeeContract: vi.fn().mockReturnValue({ data: null, isLoading: false, error: null }),
  useSaveContractBody: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  contractKeys: { detail: (id: string) => ['employee-contract', id] },
}))
vi.mock('@/components/user-profile/contract/ContractEditor', () => ({
  ContractEditor: () => <div data-testid="contract-editor-mock" />,
}))
vi.mock('@/components/user-profile/contract/ContractActionBar', () => ({
  ContractActionBar: () => <div data-testid="contract-action-bar-mock" />,
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>()
  return {
    ...actual,
    // Aux queries inside the dialog (teams/projects/exchange-rate/users-admin).
    useQuery: vi.fn().mockReturnValue({ data: undefined, isLoading: false, error: null }),
    useQueryClient: vi
      .fn()
      .mockReturnValue({ invalidateQueries: vi.fn().mockResolvedValue(undefined) }),
    useMutation: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  }
})

import { UserDialog } from '../UserDialog'

// A SLIM list-item — exactly what GET /api/users now returns: identity + role +
// non-sensitive fields, NO bank / wallet / salary / FOP PII. Typed loosely so
// we can construct the realistic slim shape (the prop type is UserProfileDto,
// but at runtime the list-item is structurally a subset).
const slimListItem = {
  id: 'junior-7',
  email: 'junior@example.com',
  displayName: 'Джуніор Тест',
  role: 'JUNIOR',
  avatarUrl: null,
  avatarDocumentId: null,
  googleId: null,
  telegram: null,
  phone: null,
  techStack: ['React'],
  seniorSharePercent: 0,
  dropSharePercent: null,
  salaryCurrency: 'USD',
  archivedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  // NOTE: NO bankUah* / wallet* / monthlySalary / registrationAddress / usrRecord
}

describe('UserDialog — edit-mode prefill from full /:id profile', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGet.mockResolvedValue({ data: [] })
  })

  it('prefills bank IBAN / RNOKPP / recipient from the full profile, not the slim list-item', async () => {
    mockUseUser.mockReturnValue({ data: fullProfileResponse, isLoading: false, error: null })

    render(<UserDialog mode="edit" user={slimListItem as never} onClose={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByTestId('user-dialog-bank-iban')).toHaveValue(
        'UA903052992990004149123456789',
      )
    })
    expect(screen.getByTestId('user-dialog-bank-rnokpp')).toHaveValue('1234567890')
    expect(screen.getByTestId('user-dialog-bank-recipient')).toHaveValue('Іваненко Іван')
  })

  it('fetches the single-resource profile for the edited user', () => {
    mockUseUser.mockReturnValue({ data: fullProfileResponse, isLoading: false, error: null })

    render(<UserDialog mode="edit" user={slimListItem as never} onClose={vi.fn()} />)

    // useUser(userId, enabled) — first arg is the edited user's id.
    expect(mockUseUser).toHaveBeenCalled()
    expect(mockUseUser.mock.calls[0]?.[0]).toBe('junior-7')
  })

  it('falls back to identity from the slim list-item while the full profile loads', () => {
    // Simulate the loading window: useUser returns no data yet.
    mockUseUser.mockReturnValue({ data: undefined, isLoading: true, error: null })

    render(<UserDialog mode="edit" user={slimListItem as never} onClose={vi.fn()} />)

    // Identity fields come from the slim list-item — render is instant.
    expect(screen.getByTestId('user-dialog-email')).toHaveValue('junior@example.com')
    expect(screen.getByTestId('user-dialog-name')).toHaveValue('Джуніор Тест')
  })
})
