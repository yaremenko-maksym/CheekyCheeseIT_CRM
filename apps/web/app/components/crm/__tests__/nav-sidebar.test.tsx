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

function renderSidebar(opts: { mobileOpen?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <NavSidebar
          user={seniorUser}
          collapsed={false}
          onToggle={() => {}}
          mobileOpen={opts.mobileOpen ?? false}
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

  // mutation-gate (PR #667 fix-round 2, round 2 of the gate itself): the
  // test above only exercises `badgeCount > 99` at count=2 (false branch) —
  // a mutant that changes the false branch's OWN result, or that flips `>`
  // to `>=` (which only diverges from `>` exactly AT 99), survives a
  // count=2 case because it produces the SAME output as the real code for
  // that one input. These two pin the true branch and the exact boundary.
  it('badge count caps display at "99+" once the count exceeds 99, but shows the exact number AT 99', async () => {
    mockIsComplete = true
    mockMine = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }))

    renderSidebar()

    const badgeOver = await screen.findByTestId('nav-pending-badge')
    expect(badgeOver).toHaveTextContent('99+')
  })

  it('badge count shows the exact number "99" at the boundary — not "99+"', async () => {
    mockIsComplete = true
    mockMine = Array.from({ length: 99 }, (_, i) => ({ id: String(i) }))

    renderSidebar()

    const badgeAtBoundary = await screen.findByTestId('nav-pending-badge')
    expect(badgeAtBoundary).toHaveTextContent('99')
    expect(badgeAtBoundary).not.toHaveTextContent('99+')
  })

  // mutation-gate: the badge's own classNames (both the always-applied base
  // and the collapsed-vs-expanded ternary) had no assertion at all — a
  // mutant turning either string to "" changed nothing any test checked.
  it('badge carries its base classes and the expanded-state (non-collapsed) position classes', async () => {
    mockIsComplete = true
    mockMine = [{ id: '1' }]

    renderSidebar()

    const badge = await screen.findByTestId('nav-pending-badge')
    // Base classes (always applied, line 329's own literal).
    expect(badge).toHaveClass('rounded-full', 'bg-primary')
    // `collapsed` is false in this harness (renderSidebar's own prop) — the
    // expanded branch of the ternary, not the `absolute -top-0.5
    // -right-0.5` collapsed branch.
    expect(badge).toHaveClass('ml-auto', 'px-1')
    expect(badge).not.toHaveClass('absolute')
  })

  // mutation-gate: the MOBILE Sheet's own copy of the same `item.badgeCount
  // > 99 ? '99+' : item.badgeCount` ternary is a SEPARATE JSX expression
  // from the desktop one above — evaluated (and therefore "covered") every
  // render regardless of `mobileOpen`, since it is a plain child expression
  // inside `SheetContent`'s JSX, but its RESULT was never read by any
  // assertion. Radix's Dialog/Sheet does not mount `SheetContent` into the
  // DOM at all while `open=false` (confirmed by `mobileOpen={true}` being
  // required below for `nav-pending-badge-mobile` to be findable) — so this
  // is the only way to observe it.
  it('mobile Sheet badge (separate JSX from the desktop one) also caps at "99+"', async () => {
    mockIsComplete = true
    mockMine = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }))

    renderSidebar({ mobileOpen: true })

    const mobileBadge = await screen.findByTestId('nav-pending-badge-mobile')
    expect(mobileBadge).toHaveTextContent('99+')
  })
})
