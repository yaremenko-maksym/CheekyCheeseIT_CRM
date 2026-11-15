/**
 * PR #1330 QA-HIGH-1 — a user who has not finished onboarding must land on `/onboarding`, with the
 * `_authenticated` layout's real `beforeLoad` (the awaited session check) on a REAL router and the
 * layout's own redirect effects rendered. The JUNIOR flow of the bug report: `/` redirects to
 * `/project` (index.tsx), the layout redirects a not-onboarded user to `/onboarding`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { type PropsWithChildren, type ReactNode } from 'react'
import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type ParsedLocation,
} from '@tanstack/react-router'
import { loadCatalog, I18nTestProvider } from '@/test/i18n'

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }))
vi.mock('@/lib/axios', () => ({ api: { get: apiGet } }))
vi.mock('idb-keyval', () => ({ del: vi.fn(() => Promise.resolve()), get: vi.fn(), set: vi.fn() }))
vi.mock('@/context/notifications', () => ({
  NotificationsProvider: ({ children }: PropsWithChildren) => children,
}))
vi.mock('@/lib/use-logout', () => ({ useLogout: () => vi.fn() }))
vi.mock('@/components/crm/nav-sidebar', () => ({ NavSidebar: () => null }))
vi.mock('@/components/layout/notifications-bell', () => ({ NotificationsBell: () => null }))
vi.mock('@/components/onboarding/TosUpdateBanner', () => ({ TosUpdateBanner: () => null }))
vi.mock('@/components/layout/ImpersonationBanner', () => ({ ImpersonationBanner: () => null }))
vi.mock('@/components/users/UserAvatar', () => ({ UserAvatar: () => null }))
vi.mock('@/components/brand-mark', () => ({ BrandMark: () => null }))

import { ONBOARDING_STATUS_TIMEOUT_MS } from '@/context/onboarding'
import { queryClient } from '@/lib/query-client'
import { navigationContext, type RouterContext } from '@/lib/router-context'
import { Route } from '../route'
import { Route as IndexRoute } from '../index'

// the real `/`: it sends a JUNIOR on to their own hub
const IndexPage = IndexRoute.options.component!
const Index = () => <IndexPage />

const user = (id: string, role: string) => ({
  id,
  role,
  email: `${id}@test.com`,
  displayName: id,
  avatarUrl: null,
  avatarDocumentId: null,
  legalFullName: null,
  seniorSharePercent: 0,
  locale: 'uk',
  impersonating: false,
})
const ivan = user('user-ivan', 'JUNIOR')
const anna = user('user-anna', 'HR')
const notOnboarded = { requiresContract: true, requiresTos: true }
const onboarded = { requiresContract: false, requiresTos: false }

/** A network answer, `ms` later, as the real API gives one. */
const answer = (data: unknown, ms = 5) =>
  new Promise((resolve) => setTimeout(() => resolve({ status: 200, data }), ms))

let me: unknown = ivan
beforeEach(async () => {
  await loadCatalog('uk')
  vi.setSystemTime(Date.now() + 5000) // past the route revalidator's reuse window
  queryClient.clear()
  me = ivan
  apiGet.mockReset().mockImplementation((url: string) => {
    if (url === '/auth/me') return answer(me, 40) // slower than the status: the redirect fires mid-navigation
    if (url === '/onboarding/status') return answer(me === anna ? onboarded : notOnboarded)
    return answer(null)
  })
})

afterEach(() => {
  vi.useRealTimers()
})

function MyProject() {
  // project.tsx: the JUNIOR hub asks for its projects, an endpoint the API refuses before onboarding
  useQuery({ queryKey: ['projects', 'junior'], queryFn: () => apiGet('/projects') })
  return <div>my project</div>
}

// The tree is built at runtime with the app's real layout, so its route types are not the app's
// registered ones: build and drive it through these loose shapes (as route.preload.test.ts does).
interface CrmTestRouter {
  navigate(to: { to: string }): Promise<void>
  latestLocation: ParsedLocation
  state: { location: { pathname: string } }
}
interface LooseRoute {
  addChildren(children: LooseRoute[]): LooseRoute
}
const route = createRoute as unknown as (options: Record<string, unknown>) => LooseRoute
const router = createRouter as unknown as (options: Record<string, unknown>) => CrmTestRouter

function crmAt(path: string): CrmTestRouter {
  const root = createRootRouteWithContext<RouterContext>()({
    component: () => (
      <I18nTestProvider>
        <QueryClientProvider client={queryClient}>
          <Outlet />
        </QueryClientProvider>
      </I18nTestProvider>
    ),
  }) as unknown as LooseRoute
  const layout = route({
    getParentRoute: () => root,
    id: '_authenticated',
    beforeLoad: Route.options.beforeLoad,
    component: Route.options.component,
  })
  const page = (p: string, component: () => ReactNode) =>
    route({ getParentRoute: () => layout, path: p, component })
  const crm: CrmTestRouter = router({
    routeTree: root.addChildren([
      layout.addChildren([
        page('/', Index),
        page('/project', MyProject),
        page('/job-queue', () => <div>job queue</div>),
        page('/onboarding', () => <div>onboarding wizard</div>),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
    context: navigationContext(() => crm),
  })
  return crm
}

/** Renders the CRM at `path`; console errors are collected, so a nested-update loop fails the test. */
function renderCrmAt(path: string) {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const crm = crmAt(path)
  render(<RouterProvider router={crm as never} />)
  return { crm, errors }
}

async function expectOnboarding({ crm, errors }: ReturnType<typeof renderCrmAt>) {
  // The layout swaps to its onboarding-only branch when the location RESOLVES, so the wizard mounts
  // twice: one wizard node is removed after it first appears, on every run (measured). Holding the
  // FIRST node found raced that swap and read it detached under load; query the settled page.
  await waitFor(
    () => {
      expect(crm.state.location.pathname).toBe('/onboarding')
      expect(screen.getByText('onboarding wizard')).toBeInTheDocument()
    },
    { timeout: 3000 },
  )
  await act(() => new Promise((settle) => setTimeout(settle, 50))) // no redirect left in flight
  expect(crm.state.location.pathname).toBe('/onboarding')
  expect(screen.getByText('onboarding wizard')).toBeInTheDocument()
  expect(errors.mock.calls.flat().join(' ')).not.toMatch(/Maximum update depth/)
  errors.mockRestore()
}

describe('_authenticated: a not-onboarded user lands on /onboarding (QA-HIGH-1)', () => {
  it.each([
    ['nothing cached yet', undefined],
    ['ivan cached (a restored session)', ivan],
    ['anna cached (another account signed in under the page)', anna],
  ])(
    'the first load of / with %s ends on /onboarding, with no nested-update loop',
    async (_, cached) => {
      if (cached) queryClient.setQueryData(['auth', 'me'], cached)
      await expectOnboarding(renderCrmAt('/'))
    },
  )

  it('after impersonation (a hard reload to / with the cache cleared) it ends on /onboarding', async () => {
    me = { ...ivan, impersonating: true }
    await expectOnboarding(renderCrmAt('/'))
  })

  it('a switch to a not-onboarded account under an open page ends on /onboarding at the next click', async () => {
    me = anna
    const crm = renderCrmAt('/job-queue')
    expect(await screen.findByText('job queue', {}, { timeout: 3000 })).toBeInTheDocument()

    me = ivan // another tab signed in as ivan
    await act(() => crm.crm.navigate({ to: '/' }))
    await expectOnboarding(crm)
  })

  // PR #1334 QA-LOW-2: the switch purges the onboarding status, and `/` sends the JUNIOR on to
  // `/project`, whose own session check races the status refetch. When the check won, the hub
  // asked for `/projects` as the not-onboarded account (403) before the redirect.
  it.each([
    ['as fast as', 10],
    ['slower than', 30],
  ])(
    'a switch to a not-onboarded JUNIOR (status %s auth/me) never asks for the hub projects',
    async (_, statusMs) => {
      apiGet.mockImplementation((url: string) => {
        if (url === '/auth/me') return answer(me, 10)
        if (url === '/onboarding/status')
          return answer(me === anna ? onboarded : notOnboarded, statusMs)
        return answer(null)
      })
      me = anna
      const crm = renderCrmAt('/job-queue')
      expect(await screen.findByText('job queue', {}, { timeout: 3000 })).toBeInTheDocument()

      me = ivan
      await act(() => crm.crm.navigate({ to: '/' }))
      await expectOnboarding(crm)
      expect(apiGet).not.toHaveBeenCalledWith('/projects')
    },
  )

  // the other side of the same gate: `/` still sends a JUNIOR to their hub once the status is in
  it('an onboarded JUNIOR is sent on from / to their hub', async () => {
    apiGet.mockImplementation((url: string) =>
      url === '/onboarding/status' ? answer(onboarded) : answer(url === '/auth/me' ? me : null),
    )
    const { crm } = renderCrmAt('/')
    expect(await screen.findByText('my project', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(crm.state.location.pathname).toBe('/project')
  })

  it('a JUNIOR whose onboarding status fails is still sent on to their hub', async () => {
    apiGet.mockImplementation((url: string) =>
      url === '/onboarding/status'
        ? Promise.reject(new Error('status down'))
        : answer(url === '/auth/me' ? me : null),
    )
    const { crm } = renderCrmAt('/')
    expect(await screen.findByText('my project', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(crm.state.location.pathname).toBe('/project')
  })

  // A status request that never settles left the JUNIOR on a blank `/` for good. The mock stands
  // for axios: a request without a `timeout` hangs forever, one with a timeout fails at it (here at
  // once, so the test does not wait the real 2 × 8 s).
  it('a JUNIOR whose onboarding status hangs sees a placeholder, then is sent on to their hub', async () => {
    apiGet.mockImplementation((url: string, config?: { timeout?: number }) => {
      if (url !== '/onboarding/status') return answer(url === '/auth/me' ? me : null)
      if (!config?.timeout) return new Promise(() => {})
      return Promise.reject(new Error(`timeout of ${config.timeout}ms exceeded`))
    })
    const { crm } = renderCrmAt('/')
    expect(
      await screen.findByTestId('junior-hub-pending', {}, { timeout: 3000 }),
    ).toBeInTheDocument()
    expect(await screen.findByText('my project', {}, { timeout: 4000 })).toBeInTheDocument()
    expect(crm.state.location.pathname).toBe('/project')
    expect(apiGet).toHaveBeenCalledWith('/onboarding/status', {
      timeout: ONBOARDING_STATUS_TIMEOUT_MS,
    })
    expect(ONBOARDING_STATUS_TIMEOUT_MS).toBe(8000)
  })
})
