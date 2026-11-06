import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeamDto } from '@crm/shared'

const get = vi.fn()
vi.mock('@/lib/axios', () => ({ api: { get: (...args: unknown[]) => get(...args) } }))
let user: { id: string } | null = null
vi.mock('@/context/auth', () => ({ useAuth: () => ({ user }) }))
let onboardingComplete = true
vi.mock('@/context/onboarding', () => ({
  useOnboardingGate: () => ({ isComplete: onboardingComplete }),
}))

const { useActiveTeam, useActiveTeams } = await import('../use-active-team')

/** r5 Task 7.2 (CR-M-6) — the membership rule behind the job-queue team switcher. */

const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function team(
  id: string,
  members: Array<{ userId: string; leftAt: string | null }>,
  archivedAt: string | null = null,
): TeamDto {
  return { id, name: id, archivedAt, members } as unknown as TeamDto
}

const BETA = team('beta', [{ userId: ME, leftAt: null }])
const LEFT = team('left', [{ userId: ME, leftAt: '2026-10-01T00:00:00.000Z' }])
const ARCHIVED = team('archived', [{ userId: ME, leftAt: null }], '2026-10-01T00:00:00.000Z')
const FOREIGN = team('foreign', [{ userId: OTHER, leftAt: null }])
const ALPHA = team('alpha', [
  { userId: OTHER, leftAt: null },
  { userId: ME, leftAt: null },
])

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('useActiveTeams', () => {
  beforeEach(() => {
    get.mockReset()
    user = { id: ME }
    onboardingComplete = true
  })

  it('keeps only active memberships in non-archived teams, in server order', async () => {
    get.mockResolvedValue({ data: [BETA, LEFT, ARCHIVED, FOREIGN, ALPHA] })
    const { result } = renderHook(() => useActiveTeams(), { wrapper })
    await waitFor(() => expect(result.current.teams).not.toBeNull())
    expect(result.current.teams?.map((t) => t.id)).toEqual(['beta', 'alpha'])
    expect(result.current.isLoading).toBe(false)
    expect(get).toHaveBeenCalledWith('/teams')
  })

  it('is null while the request is in flight', () => {
    get.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useActiveTeams(), { wrapper })
    expect(result.current).toMatchObject({ teams: null, isLoading: true, isError: false })
  })

  it('reports a failed request and refetches on demand (QA-M-2)', async () => {
    get.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useActiveTeams(), { wrapper })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.teams).toBeNull()
    get.mockResolvedValueOnce({ data: [BETA] })
    await result.current.refetch()
    await waitFor(() => expect(result.current.teams?.map((t) => t.id)).toEqual(['beta']))
    expect(result.current.isError).toBe(false)
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('is null and fetches nothing without a user', () => {
    user = null
    const { result } = renderHook(() => useActiveTeams(), { wrapper })
    expect(result.current.teams).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })

  it('is null without a user even when the team list is cached (sign-out)', () => {
    user = null
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(['teams', { archived: 'active' }], [BETA, ALPHA])
    const { result } = renderHook(() => useActiveTeams(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    })
    expect(result.current).toMatchObject({ teams: null, isLoading: false, isError: false })
    expect(get).not.toHaveBeenCalled()
  })

  it('fetches nothing while onboarding is incomplete', () => {
    onboardingComplete = false
    const { result } = renderHook(() => useActiveTeams(), { wrapper })
    expect(result.current.teams).toBeNull()
    expect(get).not.toHaveBeenCalled()
  })
})

describe('useActiveTeam', () => {
  beforeEach(() => {
    get.mockReset()
    user = { id: ME }
    onboardingComplete = true
  })

  it('takes the first active team', async () => {
    get.mockResolvedValue({ data: [LEFT, BETA, ALPHA] })
    const { result } = renderHook(() => useActiveTeam(), { wrapper })
    await waitFor(() => expect(result.current.team).not.toBeNull())
    expect(result.current).toEqual({ team: BETA, isTeamless: false, isLoading: false })
  })

  it('is teamless when no membership is active', async () => {
    get.mockResolvedValue({ data: [LEFT, ARCHIVED, FOREIGN] })
    const { result } = renderHook(() => useActiveTeam(), { wrapper })
    await waitFor(() => expect(result.current.isTeamless).toBe(true))
    expect(result.current).toEqual({ team: null, isTeamless: true, isLoading: false })
  })

  it('is neither a team nor teamless while unknown', () => {
    get.mockReturnValue(new Promise(() => {}))
    const { result } = renderHook(() => useActiveTeam(), { wrapper })
    expect(result.current).toEqual({ team: null, isTeamless: false, isLoading: true })
  })
})
