/**
 * Pins the route registration of /stats: the file-route path and that the
 * registered component is the exported StatsPage.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: (path: string) => (opts: Record<string, unknown>) => ({ path, ...opts }),
  useNavigate: () => vi.fn(),
}))
vi.mock('@tanstack/react-query', () => ({ useQuery: vi.fn() }))
vi.mock('@/context/auth', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('../../finance/api', () => ({
  financeApi: { getSummary: vi.fn(), getIncomeCompliance: vi.fn() },
  companyAccountApi: { getAccount: vi.fn() },
}))

import { Route, StatsPage } from '../../stats'

describe('/stats route registration', () => {
  it('registers StatsPage under the /_authenticated/stats file route', () => {
    const route = Route as unknown as { path: string; component: unknown }
    expect(route.path).toBe('/_authenticated/stats')
    expect(route.component).toBe(StatsPage)
  })
})
