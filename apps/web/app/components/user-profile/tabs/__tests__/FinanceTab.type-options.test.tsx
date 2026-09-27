/**
 * FinanceTab.type-options.test.tsx — task-i18n-3d-pr1-fix (mutation-gate
 * follow-up).
 *
 * `FinanceTab.total-earned.test.tsx` mocks
 * `@/routes/_authenticated/finance/constants` to `{ STATUS_LABEL_MESSAGES:
 * {}, TYPE_LABEL_MESSAGES: {} }` — deliberately, to keep that file's own
 * assertions deterministic. A side-effect: `Object.keys({}).map(...)` never
 * INVOKES the map callback at all, so a Stryker mutant that replaces either
 * callback with `() => undefined` (`TYPE_OPTIONS`/`STATUS_OPTIONS` in
 * `FinanceTab.tsx`) survives there — the callback body is simply never
 * reached with an empty label map.
 *
 * This file renders with the REAL (unmocked) `TYPE_LABEL_MESSAGES`/
 * `STATUS_LABEL_MESSAGES` (20 / 7 real entries) instead. `TYPE_OPTIONS.map`/
 * `STATUS_OPTIONS.map` execute unconditionally on every render (JSX
 * evaluates `{TYPE_OPTIONS.map(...)}` regardless of whether Radix's
 * `SelectContent` is open) — with a real, non-empty label map the mutated
 * `() => undefined` callback produces an array of `undefined` entries, and
 * the very next line (`<SelectItem key={o.value} value={o.value}>`) throws
 * synchronously reading `.value` off `undefined`. A successful render is
 * therefore the kill: it can only happen when the callback runs for real.
 *
 * The OTHER two survived mutants for this component
 * (`[i18n]` → `[]` on both `useMemo` deps) are NOT addressed by this file —
 * see the `// Stryker disable` comments on those two deps arrays in
 * `FinanceTab.tsx` for why they genuinely cannot be observed in this test
 * environment (the derived list is only observable by opening the Radix
 * `<Select>`, which happy-dom cannot do — same limitation the long comment
 * on `TYPE_OPTIONS`/`STATUS_OPTIONS` already documents).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Role } from '@crm/shared'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const TARGET_ID = 'fe000000-0000-4000-8000-000000000002'

let viewerRole = 'SENIOR'
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

vi.mock('@/routes/_authenticated/finance/api', () => ({
  financeApi: { getTransactions: () => Promise.resolve([]) },
}))

vi.mock('@/routes/_authenticated/finance/components/TransactionRow', () => ({
  TransactionRow: () => null,
}))
vi.mock('@/routes/_authenticated/finance/components/dialogs/TransactionDetailDialog', () => ({
  TransactionDetailDialog: () => null,
}))

// Deliberately NOT mocking `@crm/shared` or
// `@/routes/_authenticated/finance/constants` — see the file doc comment.

import { FinanceTab } from '../FinanceTab'

function renderTab(targetRole: Role) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <FinanceTab userId={TARGET_ID} targetRole={targetRole} />
    </QueryClientProvider>,
    { wrapper: I18nTestProvider },
  )
}

describe('FinanceTab — TYPE_OPTIONS/STATUS_OPTIONS render with the real label maps', () => {
  beforeEach(async () => {
    viewerRole = 'SENIOR'
    getMock.mockReset()
    await loadCatalog('uk')
    getMock.mockImplementation((url: string) => {
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

  it('renders without throwing — the real TYPE_LABEL_MESSAGES/STATUS_LABEL_MESSAGES maps feed the option lists', async () => {
    renderTab('SENIOR')
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Пошук…')).toBeInTheDocument()
    })
    // The two type/status filter Selects mount their (closed) triggers —
    // reaching this point at all proves TYPE_OPTIONS.map/STATUS_OPTIONS.map
    // ran their real callback for every one of the 20/7 real keys without
    // throwing.
    expect(screen.getByText('Усі типи')).toBeInTheDocument()
    expect(screen.getByText('Усі статуси')).toBeInTheDocument()
  })
})
