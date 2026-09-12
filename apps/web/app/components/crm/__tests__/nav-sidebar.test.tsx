/**
 * SR-L-1 (PR #667 fix-round 2, security review round 1). `NavSidebar` used to
 * call `usePendingItems()` with no argument — always `enabled=true` — while
 * its own comment claimed "same pattern as `useActiveTeam` two lines up".
 * `useActiveTeam` actually gates on `useOnboardingGate().isComplete`
 * (`use-active-team.ts`'s own comment: "do not call /api/teams while the
 * user is still in the onboarding wizard — OnboardingGuard would 403
 * non-ADMIN pre-onboarding callers and produce console noise"). NavSidebar
 * did the OPPOSITE of what its comment claimed: a non-ADMIN mid-onboarding
 * (CrmLayout renders the full shell before the onboarding-status response
 * lands — see nav-sidebar.tsx's own case) fired `GET /pending` straight into
 * `OnboardingGuard`'s 403, same class of bug `useActiveTeam` was already
 * fixed for.
 *
 * This test does NOT re-verify that `enabled=false` skips the network call
 * — `use-pending-items.test.ts` already pins that at the hook level. It pins
 * the WIRING: that `NavSidebar` actually forwards `useOnboardingGate()`'s
 * `isComplete` into `usePendingItems(...)`, which is the exact thing the
 * stale comment claimed without the code doing it.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import type { SessionUser } from '@crm/shared'
import { NavSidebar } from '../nav-sidebar'

let mockIsComplete = false

vi.mock('@/context/onboarding', async (orig) => {
  const real = await orig<typeof import('@/context/onboarding')>()
  return {
    ...real,
    useOnboardingGate: () => ({ isComplete: mockIsComplete, isPending: !mockIsComplete }),
  }
})

let mockMine: unknown[] = []

const usePendingItemsSpy = vi.fn((_enabled?: boolean) => ({
  mine: mockMine,
  proposedByMe: [],
  isLoading: false,
  isError: false,
  dataUpdatedAt: 0,
  refetch: vi.fn(),
}))

vi.mock('@/hooks/use-pending-items', async (orig) => {
  const real = await orig<typeof import('@/hooks/use-pending-items')>()
  return {
    ...real,
    usePendingItems: (enabled?: boolean) => usePendingItemsSpy(enabled),
  }
})

const seniorUser: SessionUser = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'senior@cc.com',
  displayName: 'Senior',
  avatarUrl: null,
  role: 'SENIOR',
  seniorSharePercent: 26,
}

function renderSidebar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <NavSidebar
          user={seniorUser}
          collapsed={false}
          onToggle={() => {}}
          mobileOpen={false}
          onMobileClose={() => {}}
        />
      </QueryClientProvider>
    ),
  })
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  mockMine = []
})

describe('NavSidebar — SR-L-1: usePendingItems gated on onboarding completion', () => {
  it('pre-onboarding (isComplete=false): usePendingItems is called with enabled=false, not the default true', async () => {
    mockIsComplete = false
    usePendingItemsSpy.mockClear()

    renderSidebar()

    // TanStack Router resolves the route match asynchronously — NavSidebar
    // (and therefore its usePendingItems() call) is not mounted on the
    // synchronous first render pass. Wait for the sidebar's own <nav> before
    // asserting on the hook call.
    await screen.findByRole('navigation')

    expect(usePendingItemsSpy).toHaveBeenCalledWith(false)
  })

  it('post-onboarding (isComplete=true): usePendingItems is called with enabled=true', async () => {
    mockIsComplete = true
    usePendingItemsSpy.mockClear()

    renderSidebar()

    await screen.findByRole('navigation')

    expect(usePendingItemsSpy).toHaveBeenCalledWith(true)
  })
})

// mutation-gate (PR #667 fix-round 2): the «Ждут решения» NAV_ITEMS entry
// (label/to) and the badge-count ternary that targets it by `item.to ===
// '/pending'` had no test distinguishing them from any other nav item or
// from a no-op — nothing here failed if the label text, the link target, or
// the badge-targeting condition itself broke.
describe('NavSidebar — «Ждут решения» nav item (label, link target, badge targeting)', () => {
  it('renders the "Ждут решения" label, linking to /pending', async () => {
    mockIsComplete = true

    renderSidebar()

    const link = await screen.findByRole('link', { name: 'Ждут решения' })
    expect(link).toHaveAttribute('href', '/pending')
  })

  it('badge count attaches to the /pending item ONLY — not to any other nav item', async () => {
    mockIsComplete = true
    mockMine = [{ id: '1' }, { id: '2' }]

    renderSidebar()

    // getByTestId (not queryAllByTestId): the ternary must produce EXACTLY
    // one badge — either the always-true or the `!==`-flipped mutant would
    // put this same fixed testid on every OTHER nav item too, which fails
    // this call with "found multiple elements" rather than a clean
    // assertion mismatch; the always-false / wrong-string mutant instead
    // leaves no element at all, which also fails this call.
    const badge = await screen.findByTestId('nav-pending-badge')
    expect(badge).toHaveTextContent('2')
  })
})
