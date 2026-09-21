import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

/**
 * Unit tests for LoginAsPage (admin impersonation list).
 *
 * task-i18n-stage3a (Task 1), fix-round 2 (MUT-1/MUT-2). REWRITTEN — the
 * previous version of this file could not render the real page ("We can't
 * import the page directly because createFileRoute is mocked", per its own
 * comment) and instead exercised a hand-duplicated `filterUsers()` helper
 * and a hand-duplicated `ConfirmDialogStub` component with stale,
 * pre-migration Russian literals ('Войти как', 'Отмена', 'Входим...') that
 * had already drifted from the real file's catalog strings. Neither
 * touched a single line of `../login-as.tsx` — the mutation gate reported
 * 0% coverage on it (8 no-coverage mutants) despite 11 "passing" tests.
 *
 * That comment was also simply wrong: `createFileRoute(path)(opts)` — real,
 * unmocked — exposes the component at `Route.options.component`, the exact
 * pattern already used by `routes/_authenticated/__tests__/index.test.tsx`
 * and `route.header.test.tsx` in this same round. This file now renders
 * the REAL `LoginAsPage` end to end (real `useQuery`/`useMutation`, only
 * `@/lib/axios` and `@/context/auth` mocked at the boundary).
 *
 * Covers:
 *   L1. ADMIN users are excluded from the list (real fetchNonAdminUsers)
 *   L2. Archived users are excluded from the list
 *   L3. Search filter narrows by displayName
 *   L4. Search filter narrows by email
 *   L5. Search filter narrows by telegram
 *   L6. "N із M" count — LogicalOperator (`??`) on `users?.length ?? 0`
 *   L7. "N із M" count stays safe (no crash) when the query has settled
 *       with no data yet — OptionalChaining (`?.`) on the same expression
 *   L8. "Увійти як" button opens confirm dialog, dialog title interpolates
 *       the target user's name — OptionalChaining on `confirm?.user...`
 *   L9. Cancel button closes dialog without mutation
 *   L10. Confirm OK calls POST /auth/impersonate with the correct userId
 *   L11. Confirm OK shows the pending catalog label while in-flight
 *   L12. Impersonate failure shows the catalog error toast with the
 *        server's own message interpolated
 *
 * Integration tests in auth.impersonation.integration.spec.ts cover the
 * backend security invariants (403/400/200 flows). These unit tests verify
 * frontend filtering & dialog UX logic.
 */

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}))

vi.mock('@/context/auth', () => ({
  useAuth: vi.fn(),
}))

vi.mock('framer-motion', () => ({
  motion: {
    div: ({
      children,
      ...props
    }: React.HTMLAttributes<HTMLDivElement> & { children?: React.ReactNode }) => (
      <div {...props}>{children}</div>
    ),
  },
}))

// Components that use document queries (UserAvatar → DocumentImage) — stub
vi.mock('@/components/users/UserAvatar', () => ({
  UserAvatar: ({ displayName }: { displayName: string }) => (
    <div data-testid={`avatar-${displayName}`}>{displayName[0]}</div>
  ),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import { api } from '@/lib/axios'
import { useAuth } from '@/context/auth'
import { toast } from 'sonner'
import type { UserProfileDto } from '@crm/shared'
import { Route } from '../login-as'

// `createFileRoute(path)(opts)` — real, unmocked — the component itself
// isn't exported by name, only reachable via `Route.options.component`.
const LoginAsPage = Route.options.component!

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const BASE_USER_FIELDS = {
  avatarUrl: null,
  avatarDocumentId: null,
  legalFullName: null,
  telegram: null,
  phone: null,
  techStack: [],
  paymentMethod: null,
  walletUsdtErc20: null,
  walletUsdtLabel: null,
  bankUahRecipient: null,
  bankUahIban: null,
  bankUahRnokpp: null,
  bankUahBankName: null,
  seniorSharePercent: 26,
  dropSharePercent: null,
  monthlySalary: null,
  salaryCurrency: 'USD' as const,
  archivedAt: null,
  adminNote: null,
  createdAt: new Date('2024-01-01'),
}

const ADMIN_USER: UserProfileDto = {
  ...BASE_USER_FIELDS,
  id: 'admin-uuid-1',
  email: 'admin@crm.dev',
  displayName: 'Admin User',
  role: 'ADMIN',
}

const SENIOR_USER: UserProfileDto = {
  ...BASE_USER_FIELDS,
  id: 'senior-uuid-1',
  email: 'senior@crm.dev',
  displayName: 'Иван Синьор',
  role: 'SENIOR',
  telegram: '@ivan',
}

const JUNIOR_USER: UserProfileDto = {
  ...BASE_USER_FIELDS,
  id: 'junior-uuid-1',
  email: 'junior@crm.dev',
  displayName: 'Петя Джун',
  role: 'JUNIOR',
}

const ARCHIVED_SENIOR: UserProfileDto = {
  ...SENIOR_USER,
  id: 'senior-archived',
  displayName: 'Archived User',
  archivedAt: new Date('2024-06-01'),
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<LoginAsPage />, {
    wrapper: ({ children }) => (
      <I18nTestProvider>
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
      </I18nTestProvider>
    ),
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  await loadCatalog('uk')
  vi.mocked(useAuth).mockReturnValue({
    user: { id: 'admin-uuid-1', role: 'ADMIN' },
  } as ReturnType<typeof useAuth>)
})

describe('LoginAsPage — user list (real fetchNonAdminUsers filtering)', () => {
  it('L1/L2. excludes ADMIN and archived users, L6. shows the "N із M" count for the rest', async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: [ADMIN_USER, SENIOR_USER, JUNIOR_USER, ARCHIVED_SENIOR],
    })
    renderPage()

    expect(await screen.findByTestId(`login-as-row-${SENIOR_USER.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`login-as-row-${JUNIOR_USER.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`login-as-row-${ADMIN_USER.id}`)).not.toBeInTheDocument()
    expect(screen.queryByTestId(`login-as-row-${ARCHIVED_SENIOR.id}`)).not.toBeInTheDocument()

    // MUT-1: `{filtered.length} із {users?.length ?? 0}` — LogicalOperator.
    // A `?? 0` flipped to `&& 0` would turn this into "2 із 0" (users.length
    // is truthy, so `&& 0` always wins over the real count).
    expect(screen.getByText('2 із 2')).toBeInTheDocument()
  })

  it('L7. the "N із M" count stays safe (no render crash) once the query has settled with no users yet', async () => {
    // A real, settled (`isLoading: false`) query with `data: undefined` —
    // reachable via a rejected fetch with retries disabled. This is the
    // ONLY state that makes `users?.length ?? 0`'s optional chaining
    // observable: `users` is always a defined array once `!isLoading` is
    // reached via a successful fetch, so a mutant dropping `?.` (→
    // `users.length ?? 0`) is silently equivalent there and only throws
    // (a real TypeError, on `undefined.length`) in this error path.
    vi.mocked(api.get).mockRejectedValue(new Error('network down'))
    renderPage()

    expect(await screen.findByText('0 із 0')).toBeInTheDocument()
  })

  it('L3. search filter narrows by displayName (case-insensitive)', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [SENIOR_USER, JUNIOR_USER] })
    const user = userEvent.setup()
    renderPage()
    await screen.findByTestId(`login-as-row-${SENIOR_USER.id}`)

    await user.type(screen.getByTestId('login-as-search'), 'синьор')

    expect(screen.getByTestId(`login-as-row-${SENIOR_USER.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`login-as-row-${JUNIOR_USER.id}`)).not.toBeInTheDocument()
  })

  it('L4. search filter narrows by email', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [SENIOR_USER, JUNIOR_USER] })
    const user = userEvent.setup()
    renderPage()
    await screen.findByTestId(`login-as-row-${SENIOR_USER.id}`)

    await user.type(screen.getByTestId('login-as-search'), 'junior@crm')

    expect(screen.getByTestId(`login-as-row-${JUNIOR_USER.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`login-as-row-${SENIOR_USER.id}`)).not.toBeInTheDocument()
  })

  it('L5. search filter narrows by telegram', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [SENIOR_USER, JUNIOR_USER] })
    const user = userEvent.setup()
    renderPage()
    await screen.findByTestId(`login-as-row-${SENIOR_USER.id}`)

    await user.type(screen.getByTestId('login-as-search'), '@ivan')

    expect(screen.getByTestId(`login-as-row-${SENIOR_USER.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`login-as-row-${JUNIOR_USER.id}`)).not.toBeInTheDocument()
  })

  it('search placeholder carries the catalog string (MUT-1)', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [SENIOR_USER] })
    renderPage()
    await screen.findByTestId(`login-as-row-${SENIOR_USER.id}`)

    expect(screen.getByPlaceholderText('Пошук за іменем, email, telegram…')).toBeInTheDocument()
  })
})

describe('LoginAsPage — confirm dialog (real render, real useMutation)', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockResolvedValue({ data: [SENIOR_USER, JUNIOR_USER] })
  })

  async function openDialogFor(user: ReturnType<typeof userEvent.setup>, targetUserId: string) {
    renderPage()
    await screen.findByTestId(`login-as-row-${targetUserId}`)
    await user.click(screen.getByTestId(`login-as-btn-${targetUserId}`))
    await waitFor(() => {
      expect(screen.getByTestId('login-as-confirm-dialog')).toBeInTheDocument()
    })
  }

  it('L8. "Увійти як" button opens confirm dialog, title interpolates the target displayName', async () => {
    const user = userEvent.setup()
    await openDialogFor(user, SENIOR_USER.id)

    // MUT-1: `<Trans>Увійти як «{confirm?.user.displayName}»?</Trans>` —
    // OptionalChaining. Exact text catches a mutant that would still crash
    // (confirm is never null while the dialog is open, so `?.` vs `.`
    // wouldn't itself crash here — but a `null`/broken interpolation would
    // change this exact string).
    expect(
      screen.getByRole('heading', { name: `Увійти як «${SENIOR_USER.displayName}»?` }),
    ).toBeInTheDocument()
  })

  it('the target user\'s "Увійти як" button carries the catalog aria-label with their name (MUT-1)', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [SENIOR_USER] })
    renderPage()
    await screen.findByTestId(`login-as-row-${SENIOR_USER.id}`)

    expect(
      screen.getByRole('button', { name: `Увійти як ${SENIOR_USER.displayName}` }),
    ).toBeInTheDocument()
  })

  it('L9. cancel button closes dialog without mutation', async () => {
    const user = userEvent.setup()
    await openDialogFor(user, SENIOR_USER.id)

    await user.click(screen.getByTestId('login-as-confirm-cancel'))

    await waitFor(() => {
      expect(screen.queryByTestId('login-as-confirm-dialog')).not.toBeInTheDocument()
    })
    expect(api.post).not.toHaveBeenCalled()
  })

  it('L10. confirm OK calls POST /auth/impersonate with the correct userId', async () => {
    vi.mocked(api.post).mockImplementation(() => new Promise(() => {}))
    const user = userEvent.setup()
    await openDialogFor(user, SENIOR_USER.id)

    await user.click(screen.getByTestId('login-as-confirm-ok'))

    expect(api.post).toHaveBeenCalledWith('/auth/impersonate', { userId: SENIOR_USER.id })
  })

  it('L11. confirm OK shows the pending catalog label while in-flight, not the idle one (MUT-1)', async () => {
    vi.mocked(api.post).mockImplementation(() => new Promise(() => {}))
    const user = userEvent.setup()
    await openDialogFor(user, SENIOR_USER.id)

    await user.click(screen.getByTestId('login-as-confirm-ok'))

    await waitFor(() => {
      expect(screen.getByTestId('login-as-confirm-ok')).toBeDisabled()
    })
    expect(screen.getByText('Входимо…')).toBeInTheDocument()
    expect(
      screen.queryByText('Увійти як', { selector: '[data-testid="login-as-confirm-ok"] *' }),
    ).not.toBeInTheDocument()
  })

  it('L12. impersonate failure shows the catalog error toast with the server message interpolated (MUT-1)', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('user is archived'))
    const user = userEvent.setup()
    await openDialogFor(user, SENIOR_USER.id)

    await user.click(screen.getByTestId('login-as-confirm-ok'))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Не вдалося увійти: user is archived')
    })
  })
})
