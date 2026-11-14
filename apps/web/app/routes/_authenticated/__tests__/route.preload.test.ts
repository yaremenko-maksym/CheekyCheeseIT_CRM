/**
 * Task 7.6c, PR #1330 CR-M-2 — the `_authenticated` layout's `beforeLoad` on a REAL router.
 *
 * Inside the CRM the layout match is already active, so TanStack Router passes `preload: false` to
 * its `beforeLoad` even for a hover preload of a sidebar link. A hand-built `{ preload: true }`
 * context proves nothing; this drives `router.preloadRoute` and `router.navigate` instead and counts
 * the `/auth/me` requests the layout sends.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }))
vi.mock('@/lib/axios', () => ({ api: { get: apiGet } }))
vi.mock('idb-keyval', () => ({ del: vi.fn(), get: vi.fn(), set: vi.fn() }))

import { queryClient } from '@/lib/query-client'
import { Route } from '../route'

const anna = { id: 'user-anna', role: 'HR' }
const meCalls = () => apiGet.mock.calls.filter(([url]) => url === '/auth/me').length

// The tree is built at runtime with the app's real `beforeLoad`, so its route types are not the
// app's registered ones: build and drive it through these loose shapes.
interface CrmTestRouter {
  load(): Promise<void>
  preloadRoute(to: { to: string; params?: Record<string, string> }): Promise<unknown>
  navigate(to: { to: string; params?: Record<string, string> }): Promise<void>
  state: { location: { pathname: string } }
}
interface LooseRoute {
  addChildren(children: LooseRoute[]): LooseRoute
}
const route = createRoute as unknown as (options: Record<string, unknown>) => LooseRoute
const router = createRouter as unknown as (options: Record<string, unknown>) => CrmTestRouter

async function crmRouterAt(path: string): Promise<CrmTestRouter> {
  const root = createRootRoute() as unknown as LooseRoute
  const layout = route({
    getParentRoute: () => root,
    id: '_authenticated',
    beforeLoad: Route.options.beforeLoad,
  })
  const page = (p: string) => route({ getParentRoute: () => layout, path: p })
  const crm = router({
    routeTree: root.addChildren([
      layout.addChildren([
        page('/job-queue'),
        page('/projects'),
        page('/teams'),
        page('/vacancies/$vacancyId'),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
  })
  await crm.load()
  return crm
}

beforeEach(() => {
  queryClient.clear()
  queryClient.setQueryData(['auth', 'me'], anna)
  apiGet.mockReset().mockResolvedValue({ status: 200, data: anna })
})

describe('_authenticated beforeLoad on a real router (CR-M-2)', () => {
  it('a hover preload of another CRM link sends no /auth/me; the click that follows sends one', async () => {
    const router = await crmRouterAt('/job-queue')
    apiGet.mockClear()

    await router.preloadRoute({ to: '/projects' })
    expect(meCalls()).toBe(0)

    await router.navigate({ to: '/projects' })
    expect(meCalls()).toBe(1)
    expect(router.state.location.pathname).toBe('/projects')
  })

  it('a hover preload while on the page sends none, and a later navigation still checks', async () => {
    const router = await crmRouterAt('/job-queue')
    apiGet.mockClear()

    await router.preloadRoute({ to: '/projects' })
    await router.preloadRoute({ to: '/teams' })
    expect(meCalls()).toBe(0)

    await router.navigate({ to: '/teams' })
    expect(meCalls()).toBe(1)
  })

  it('a hover preload and the click on a page with path params: none, then exactly one', async () => {
    const router = await crmRouterAt('/vacancies/vac-1')
    apiGet.mockClear()

    await router.preloadRoute({ to: '/vacancies/$vacancyId', params: { vacancyId: 'vac-2' } })
    expect(meCalls()).toBe(0)

    await router.navigate({ to: '/vacancies/$vacancyId', params: { vacancyId: 'vac-2' } })
    expect(meCalls()).toBe(1)
    expect(router.state.location.pathname).toBe('/vacancies/vac-2')
  })

  it('the first load of a CRM page checks the session', async () => {
    await crmRouterAt('/job-queue')

    expect(meCalls()).toBe(1)
  })
})
