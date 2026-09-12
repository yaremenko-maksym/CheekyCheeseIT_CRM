/**
 * `useOnboardingGate` — the gate every "post-onboarding" query is enabled on
 * (`usePendingItems`, `useNotificationsList`, `useActiveTeam`).
 *
 * SR-M-2 (PR #667 fix-round 4) added `isError`/`refetch` to its result,
 * because `isComplete: false` alone cannot tell "we have not asked yet" from
 * "we asked and the request failed" — and the `_authenticated` shell only
 * redirects to `/onboarding` when a status actually ARRIVES, so a failed
 * status leaves a non-ADMIN sitting on a gated screen for the whole session.
 * A screen that cannot tell those apart renders "nothing is pending" while
 * something is.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

vi.mock('@/lib/axios', () => ({ api: { get: vi.fn() } }))

let mockRole = 'SENIOR'
vi.mock('@/context/auth', async (orig) => {
  const real = await orig<typeof import('@/context/auth')>()
  return { ...real, useAuth: () => ({ user: { id: 'u1', role: mockRole } }) }
})

import { api } from '@/lib/axios'
import { useOnboardingGate } from '../onboarding'

const mockGet = api.get as ReturnType<typeof vi.fn>

const COMPLETE = {
  requiresContract: false,
  requiresTos: false,
  contractReady: false,
  contractTemplate: null,
  tosVersion: null,
  tosUpdateAvailable: false,
  latestTosVersion: null,
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children)
  }
}

beforeEach(() => {
  mockGet.mockReset()
  mockRole = 'SENIOR'
})

describe('useOnboardingGate', () => {
  it('ADMIN short-circuits to complete AND NOT pending — a caller gating on `isPending` must fire for them immediately', () => {
    mockRole = 'ADMIN'
    mockGet.mockReturnValue(new Promise(() => {})) // would never resolve if asked

    const { result } = renderHook(() => useOnboardingGate(), { wrapper: makeWrapper() })

    expect(result.current).toEqual({
      isComplete: true,
      isPending: false,
      isError: false,
      refetch: expect.any(Function),
    })
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('non-ADMIN, status in flight: pending, not complete, not an error', () => {
    mockGet.mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(() => useOnboardingGate(), { wrapper: makeWrapper() })

    expect(result.current.isPending).toBe(true)
    expect(result.current.isComplete).toBe(false)
    expect(result.current.isError).toBe(false)
  })

  it('non-ADMIN, status FAILED: isError — distinguishable from "still asking" and from "nothing required"', async () => {
    mockGet.mockRejectedValue(new Error('500'))

    const { result } = renderHook(() => useOnboardingGate(), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.isComplete).toBe(false)
    expect(result.current.isPending).toBe(false)
  })

  it('non-ADMIN, onboarding done: complete', async () => {
    mockGet.mockResolvedValue({ data: COMPLETE })

    const { result } = renderHook(() => useOnboardingGate(), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.isComplete).toBe(true))
    expect(result.current.isError).toBe(false)
  })

  it('non-ADMIN with onboarding still owed: NOT complete, and not an error either', async () => {
    mockGet.mockResolvedValue({ data: { ...COMPLETE, requiresTos: true } })

    const { result } = renderHook(() => useOnboardingGate(), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.isPending).toBe(false))
    expect(result.current.isComplete).toBe(false)
    expect(result.current.isError).toBe(false)
  })

  it('`refetch` re-asks GET /onboarding/status', async () => {
    mockGet.mockResolvedValue({ data: COMPLETE })

    const { result } = renderHook(() => useOnboardingGate(), { wrapper: makeWrapper() })
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1))
    result.current.refetch()

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2))
    expect(mockGet).toHaveBeenLastCalledWith('/onboarding/status')
  })
})
