/**
 * Task 7.6c, PR #1330 CR-M-2 / SR-M-1 / CR-M-3 — the `_authenticated` layout's `beforeLoad` on a
 * REAL router.
 *
 * Inside the CRM the layout match is already active, so TanStack Router passes `preload: false` to
 * its `beforeLoad` even for a hover preload of a sidebar link. A hand-built `{ preload: true }`
 * context proves nothing; this drives `router.preloadRoute`, `router.navigate` and the history
 * instead and counts the `/auth/me` requests the layout sends. Every real load must check, however
 * the URL is spelled (case, trailing slash, characters a rebuilt path would encode).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  type ParsedLocation,
} from '@tanstack/react-router'

const { apiGet } = vi.hoisted(() => ({ apiGet: vi.fn() }))
vi.mock('@/lib/axios', () => ({ api: { get: apiGet } }))
vi.mock('idb-keyval', () => ({ del: vi.fn(), get: vi.fn(), set: vi.fn() }))

import { queryClient } from '@/lib/query-client'
import { navigationContext, type RouterContext } from '@/lib/router-context'
import { Route } from '../route'

const anna = { id: 'user-anna', role: 'HR' }
const meCalls = () => apiGet.mock.calls.filter(([url]) => url === '/auth/me').length

// The tree is built at runtime with the app's real `beforeLoad`, so its route types are not the
// app's registered ones: build and drive it through these loose shapes.
interface Destination {
  to?: string
  href?: string
  params?: Record<string, string>
  search?: Record<string, number>
}
interface CrmTestRouter {
  load(): Promise<void>
  preloadRoute(to: Destination): Promise<unknown>
  navigate(to: Destination): Promise<void>
  history: { back(): void; forward(): void }
  latestLocation: ParsedLocation
  state: { location: { pathname: string; searchStr: string } }
}
interface LooseRoute {
  addChildren(children: LooseRoute[]): LooseRoute
}
const route = createRoute as unknown as (options: Record<string, unknown>) => LooseRoute
const router = createRouter as unknown as (options: Record<string, unknown>) => CrmTestRouter

async function crmRouterAt(path: string): Promise<CrmTestRouter> {
  const root = createRootRouteWithContext<RouterContext>()() as unknown as LooseRoute
  const layout = route({
    getParentRoute: () => root,
    id: '_authenticated',
    beforeLoad: Route.options.beforeLoad,
  })
  const page = (p: string) => route({ getParentRoute: () => layout, path: p })
  const crm: CrmTestRouter = router({
    routeTree: root.addChildren([
      layout.addChildren([
        page('/job-queue'),
        page('/projects'),
        page('/teams'),
        page('/vacancies/$vacancyId'),
      ]),
    ]),
    history: createMemoryHistory({ initialEntries: [path] }),
    context: navigationContext(() => crm),
  })
  await crm.load()
  return crm
}

/** Past the revalidator's 1s reuse window, so a repeat of the same path must ask again. */
const later = () => vi.setSystemTime(Date.now() + 2000)

/** A history move as the browser makes it: `<Transitioner>` answers it with `router.load()`. */
async function move(crm: CrmTestRouter, step: 'back' | 'forward') {
  crm.history[step]()
  await crm.load()
}

// Faked once per file, so the clock only moves forward across tests.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterAll(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  later() // the route's revalidator is a module singleton: start each test outside its reuse window
  queryClient.clear()
  queryClient.setQueryData(['auth', 'me'], anna)
  apiGet.mockReset().mockResolvedValue({ status: 200, data: anna })
})

afterEach(async () => {
  await new Promise((settled) => setTimeout(settled, 0)) // a check still settling stays in its test
})

describe('_authenticated beforeLoad on a real router: a hover preload sends no check (CR-M-2)', () => {
  it('a hover preload of another CRM link sends no /auth/me; the click that follows sends one', async () => {
    const crm = await crmRouterAt('/job-queue')
    apiGet.mockClear()

    await crm.preloadRoute({ to: '/projects' })
    expect(meCalls()).toBe(0)

    await crm.navigate({ to: '/projects' })
    expect(meCalls()).toBe(1)
    expect(crm.state.location.pathname).toBe('/projects')
  })

  it('a hover preload while on the page sends none, and a later navigation still checks', async () => {
    const crm = await crmRouterAt('/job-queue')
    apiGet.mockClear()

    await crm.preloadRoute({ to: '/projects' })
    await crm.preloadRoute({ to: '/teams' })
    expect(meCalls()).toBe(0)

    await crm.navigate({ to: '/teams' })
    expect(meCalls()).toBe(1)
  })

  it('a hover preload and the click on a page with path params: none, then exactly one', async () => {
    const crm = await crmRouterAt('/vacancies/vac-1')
    apiGet.mockClear()

    await crm.preloadRoute({ to: '/vacancies/$vacancyId', params: { vacancyId: 'vac-2' } })
    expect(meCalls()).toBe(0)

    await crm.navigate({ to: '/vacancies/$vacancyId', params: { vacancyId: 'vac-2' } })
    expect(meCalls()).toBe(1)
    expect(crm.state.location.pathname).toBe('/vacancies/vac-2')
  })

  it('a hover preload of the page already open sends none either', async () => {
    const crm = await crmRouterAt('/job-queue')
    later()
    apiGet.mockClear()

    await crm.preloadRoute({ to: '/job-queue' })
    expect(meCalls()).toBe(0)
  })
})

describe('_authenticated beforeLoad on a real router: every real load checks (SR-M-1, CR-M-3)', () => {
  it.each([['/job-queue'], ['/JOB-QUEUE'], ['/Job-Queue'], ['/job-queue/'], ['/vacancies/a+b@c']])(
    'the first load of %s sends exactly one /auth/me',
    async (path) => {
      const crm = await crmRouterAt(path)

      expect(crm.state.location.pathname).toBe(path) // the router kept the URL as spelled
      expect(meCalls()).toBe(1)
    },
  )

  it('navigate({ href: "/PROJECTS" }) sends exactly one /auth/me', async () => {
    const crm = await crmRouterAt('/job-queue')
    apiGet.mockClear()

    await crm.navigate({ href: '/PROJECTS' })
    expect(crm.state.location.pathname).toBe('/PROJECTS')
    expect(meCalls()).toBe(1)
  })

  it('a search-only change checks again', async () => {
    const crm = await crmRouterAt('/job-queue')
    later()
    apiGet.mockClear()

    await crm.navigate({ to: '/job-queue', search: { page: 2 } })
    expect(crm.state.location.searchStr).toBe('?page=2')
    expect(meCalls()).toBe(1)
  })

  it('a navigation to the page already open checks again', async () => {
    const crm = await crmRouterAt('/job-queue')
    later()
    apiGet.mockClear()

    await crm.navigate({ to: '/job-queue' })
    expect(meCalls()).toBe(1)
  })

  it('history back and forward each check', async () => {
    const crm = await crmRouterAt('/job-queue')
    await crm.navigate({ to: '/projects' })
    later()
    apiGet.mockClear()

    await move(crm, 'back')
    expect(crm.state.location.pathname).toBe('/job-queue')
    expect(meCalls()).toBe(1)

    await move(crm, 'forward')
    expect(crm.state.location.pathname).toBe('/projects')
    expect(meCalls()).toBe(2)
  })
})
