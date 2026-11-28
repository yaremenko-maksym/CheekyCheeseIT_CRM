/**
 * `/` after login: a bookmarklet hand-off stashed before the Google round-trip is sent on to the
 * queue for the roles that can use it (ADMIN, HR) and dropped for everyone else. The dashboards
 * themselves are stubbed; only the hand-off decision and the real session storage are exercised.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { encodePrefill, hasStashedPrefill, PREFILL_STASH_KEY } from '@/lib/external-prefill'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', async (orig) => ({
  ...(await orig<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mockNavigate,
}))
const auth = vi.hoisted(() => ({ user: null as { role: string } | null }))
vi.mock('@/context/auth', () => ({ useAuth: () => ({ user: auth.user }) }))
vi.mock('@/context/onboarding', () => ({
  useOnboardingGate: () => ({ isComplete: true, isError: false }),
}))
vi.mock('@/hooks/use-admin-summary', () => ({
  ADMIN_SUMMARY_QUERY_KEY: ['admin-summary'],
  useAdminSummary: () => ({ data: undefined, isLoading: true, isError: false }),
}))
vi.mock('../routing/components/HRDashboard', () => ({ HRDashboard: () => null }))
vi.mock('../routing/components/SeniorDashboard', () => ({ SeniorDashboard: () => null }))

import { Route } from '../index'

const CrmDashboard = Route.options.component!
const HASH = `#external=${encodePrefill({
  v: 1,
  recognition: 'recognized',
  url: 'https://jobs.example.com/1',
  title: 'Go Engineer',
  company: 'Acme',
  description: 'Build.',
  status: { url: 'found', title: 'found', company: 'found', description: 'found' },
})}`

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    <I18nTestProvider>{children}</I18nTestProvider>
  </QueryClientProvider>
)

beforeEach(async () => {
  await loadCatalog('uk')
  auth.user = null
  mockNavigate.mockReset()
})
afterEach(() => sessionStorage.clear())

describe('/ — a stashed external hand-off after login', () => {
  it.each(['ADMIN', 'HR'])('%s is sent to the queue, with the hand-off kept for it', (role) => {
    sessionStorage.setItem(PREFILL_STASH_KEY, HASH)
    auth.user = { role }
    render(<CrmDashboard />, { wrapper })
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/job-queue', replace: true })
    expect(hasStashedPrefill()).toBe(true)
  })

  it('another role stays and the hand-off is dropped', () => {
    sessionStorage.setItem(PREFILL_STASH_KEY, HASH)
    auth.user = { role: 'SENIOR' }
    render(<CrmDashboard />, { wrapper })
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(hasStashedPrefill()).toBe(false)
  })

  it('nothing stashed: an ADMIN stays on the dashboard', () => {
    auth.user = { role: 'ADMIN' }
    render(<CrmDashboard />, { wrapper })
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('waits for the session: the hand-off moves once the user is in', () => {
    sessionStorage.setItem(PREFILL_STASH_KEY, HASH)
    const { rerender } = render(<CrmDashboard />, { wrapper })
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(hasStashedPrefill()).toBe(true)
    auth.user = { role: 'HR' }
    rerender(<CrmDashboard />)
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/job-queue', replace: true })
  })
})
