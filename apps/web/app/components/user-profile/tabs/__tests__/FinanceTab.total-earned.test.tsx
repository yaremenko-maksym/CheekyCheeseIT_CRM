/**
 * FinanceTab.total-earned.test.tsx — task-profile-earned-balance frontend AC.
 *
 * Verifies the «Всего заработано с нами» card visibility contract on the
 * profile Finance tab:
 *   - ADMIN / ACCOUNTANT viewer on a SENIOR/DROP/JUNIOR/HR profile → card shown
 *     with the server-provided amount (AC1).
 *   - Non-privileged viewer (SENIOR/JUNIOR/HR/DROP) → card NOT rendered AND the
 *     total-earned endpoint is never called (AC2 — front guard mirrors the
 *     backend 403).
 *   - ADMIN viewer on a non-payee target role (e.g. ADMIN profile) → no card.
 *
 * Strategy: mock useAuth (viewer), axios `api` (capture total-earned calls),
 * react-router useNavigate, and the heavy finance sub-imports so the tab renders
 * deterministically without the real transactions table / dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Role, TotalEarnedDto, TransactionDto } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const TARGET_ID = 'fe000000-0000-4000-8000-000000000001'

// ── Mutable mock state, set per-test ─────────────────────────────────────────
let viewerRole = 'ADMIN'
const getMock = vi.fn()

vi.mock('@/context/auth', () => ({
  useAuth: () => ({ user: { id: 'viewer-1', role: viewerRole } }),
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock('@/lib/axios', () => ({
  api: { get: (url: string) => getMock(url) },
}))

// @crm/shared is aliased to the MAIN-repo TS source in the worktree vitest
// config (see apps/web/vitest.config.ts) — that copy may lag this branch's new
// `totalEarnedSchema` export, which would make the real schema `undefined` and
// blow up `.parse()` at runtime. Mock only the value export FinanceTab uses
// (`totalEarnedSchema`) with a passthrough parser so the test is hermetic and
// resolution-independent (worktree local AND CI alike). Types are erased at
// compile time so they need no mock.
// task-i18n-stage3a (Task 2): FinanceTab's `formatAmount` (`@/lib/format-amount`)
// now routes through `resolveLocale`/`formatMoney` from `@crm/shared` — this
// mock needs both, hermetic same as `totalEarnedSchema` above (real
// `Intl`-backed implementations, not a passthrough, since the test asserts
// on the rendered amount text).
vi.mock('@crm/shared', () => ({
  totalEarnedSchema: { parse: (x: unknown) => x },
  resolveLocale: () => 'uk' as const,
  formatMoney: (amount: number | string, currency: string) => {
    const n = Number(amount)
    const body = new Intl.NumberFormat('uk-UA', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n)
    return `${body} ${currency}`
  },
  // task-i18n-stage3b (Task 1): `@/lib/i18n.ts`'s `activateLocale()` (used by
  // `loadCatalog()` below, so the component's own `useLingui()`/`<Trans>`
  // resolve instead of throwing without an `I18nProvider`) reads these two
  // directly — vitest's mock is exact-shape, not permissive-undefined, so an
  // omitted export throws at the call site, not silently.
  LOCALE_COOKIE_NAME: 'pref_locale',
  DEFAULT_LOCALE: 'uk' as const,
}))

// financeApi.getTransactions is only used on the non-privileged branch; stub it
// so it never hits the network.
vi.mock('@/routes/_authenticated/finance/api', () => ({
  financeApi: { getTransactions: () => Promise.resolve([]) },
}))

// Heavy presentational deps — stub to keep the render light + deterministic.
vi.mock('@/routes/_authenticated/finance/components/TransactionRow', () => ({
  TransactionRow: () => null,
}))
vi.mock('@/routes/_authenticated/finance/components/dialogs/TransactionDetailDialog', () => ({
  TransactionDetailDialog: () => null,
}))
vi.mock('@/routes/_authenticated/finance/constants', () => ({
  STATUS_LABELS: {},
  TYPE_LABELS: {},
}))

// Import AFTER mocks are registered.
import { FinanceTab } from '../FinanceTab'

const EARNED: TotalEarnedDto = {
  userId: TARGET_ID,
  role: 'SENIOR',
  totalEarned: 12345.5,
  currency: 'USD',
  breakdown: { income: 12345.5 },
}

function renderTab(targetRole: Role) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <FinanceTab userId={TARGET_ID} targetRole={targetRole} />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
}

describe('FinanceTab — «Всего заработано» card', () => {
  beforeEach(async () => {
    viewerRole = 'ADMIN'
    getMock.mockReset()
    await loadCatalog('uk')
    // Default: total-earned returns the figure; transactions endpoint returns [].
    getMock.mockImplementation((url: string) => {
      if (url.includes('/balances/total-earned/')) return Promise.resolve({ data: EARNED })
      if (url.includes('/users/') && url.endsWith('/transactions'))
        return Promise.resolve({ data: [] })
      if (url.includes('/finance/exchange-rate'))
        return Promise.resolve({ data: { usdUah: '41.5', eurUah: '44.8' } })
      return Promise.resolve({ data: [] })
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('ADMIN viewer on SENIOR profile sees the card with the amount', async () => {
    viewerRole = 'ADMIN'
    renderTab('SENIOR')
    await waitFor(() => {
      expect(screen.getByTestId('total-earned-card')).toBeInTheDocument()
    })
    expect(screen.getByTestId('total-earned-amount')).toHaveTextContent('12')
    expect(screen.getByText('Усього виплачено цій людині')).toBeInTheDocument()
  })

  it('ACCOUNTANT viewer on JUNIOR profile sees the card', async () => {
    viewerRole = 'ACCOUNTANT'
    renderTab('JUNIOR')
    await waitFor(() => {
      expect(screen.getByTestId('total-earned-card')).toBeInTheDocument()
    })
  })

  it('SENIOR viewer never sees the card and never calls the endpoint', async () => {
    viewerRole = 'SENIOR'
    renderTab('SENIOR')
    // Give the component a tick to settle any queries.
    await waitFor(() => {
      expect(screen.queryByTestId('total-earned-card')).not.toBeInTheDocument()
    })
    // The privileged total-earned endpoint must NOT be hit for a non-privileged viewer.
    const earnedCalls = getMock.mock.calls.filter((c) =>
      String(c[0]).includes('/balances/total-earned/'),
    )
    expect(earnedCalls).toHaveLength(0)
  })

  it('JUNIOR viewer (self) never sees the card', async () => {
    viewerRole = 'JUNIOR'
    renderTab('JUNIOR')
    await waitFor(() => {
      expect(screen.queryByTestId('total-earned-card')).not.toBeInTheDocument()
    })
    const earnedCalls = getMock.mock.calls.filter((c) =>
      String(c[0]).includes('/balances/total-earned/'),
    )
    expect(earnedCalls).toHaveLength(0)
  })

  it('ADMIN viewer on an ADMIN profile does not see the card (non-payee role)', async () => {
    viewerRole = 'ADMIN'
    renderTab('ADMIN')
    await waitFor(() => {
      expect(screen.queryByTestId('total-earned-card')).not.toBeInTheDocument()
    })
    const earnedCalls = getMock.mock.calls.filter((c) =>
      String(c[0]).includes('/balances/total-earned/'),
    )
    expect(earnedCalls).toHaveLength(0)
  })
})

// task-i18n-stage3b (Task 1), Step 7 (M-5): `hasActive ? 'Ничего не найдено' :
// 'Нет данных'` collapsed to one canon text — the `!hasActive` branch was
// unreachable (see the comment on the ternary's removal in FinanceTab.tsx).
// This is the one REACHABLE case the mutation gate needs a live assertion
// for: transactions exist, but the active filter matches none of them.
describe('FinanceTab — filtered-empty state (M-5)', () => {
  it('a search that matches nothing shows the canon "no matches" text, with transactions present', async () => {
    viewerRole = 'ADMIN'
    getMock.mockImplementation((url: string) => {
      if (url.includes('/balances/total-earned/')) return Promise.resolve({ data: EARNED })
      if (url.includes('/users/') && url.endsWith('/transactions')) {
        const tx: Partial<TransactionDto> = {
          id: 'tx-1',
          type: 'PAYOUT',
          status: 'PAID',
          senderId: 'admin-1',
          receiverId: TARGET_ID,
          senderName: 'Admin One',
          receiverName: 'Target Senior',
          senderLabel: null,
          receiverLabel: null,
          projectName: null,
          notes: null,
          txDate: '2026-01-10T00:00:00.000Z',
          createdAt: '2026-01-10T00:00:00.000Z',
        }
        return Promise.resolve({ data: [tx] })
      }
      if (url.includes('/finance/exchange-rate'))
        return Promise.resolve({ data: { usdUah: '41.5', eurUah: '44.8' } })
      return Promise.resolve({ data: [] })
    })

    renderTab('SENIOR')
    const user = userEvent.setup()
    // The search input is `disabled={isLoading}` — wait for it to become
    // enabled before typing, or the keystrokes land on a disabled input and
    // `value` silently stays empty (TransactionRow is stubbed to `null`
    // above, so there is no row text to wait on instead).
    const search = await screen.findByPlaceholderText('Пошук…')
    await waitFor(() => expect(search).not.toBeDisabled())
    await user.type(search, 'zzz-no-such-transaction')

    await waitFor(() => {
      expect(screen.getByText('Нічого не знайдено — скиньте фільтри')).toBeInTheDocument()
    })
  })
})
