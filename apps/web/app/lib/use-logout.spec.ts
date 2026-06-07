/**
 * use-logout — unit coverage for the logout-clear security contract (PR-B #47).
 *
 * Deterministic replacement for the (racy) E2E logout-clear assertion: verifies
 * that triggering logout clears the in-memory TanStack cache AND deletes the
 * persisted IndexedDB key — the exact key the persister writes (PERSIST_KEY).
 * This is the cross-user-leak guard on shared devices.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'

// idb-keyval del — capture calls
const delMock = vi.fn(() => Promise.resolve())
vi.mock('idb-keyval', () => ({ del: (...args: unknown[]) => delMock(...args) }))

// axios api — logout endpoint resolves
const getMock = vi.fn(() => Promise.resolve({ data: {} }))
vi.mock('@/lib/axios', () => ({ api: { get: (...args: unknown[]) => getMock(...args) } }))

import { useLogout } from './use-logout'
import { PERSIST_KEY } from './persister'

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

describe('useLogout', () => {
  beforeEach(() => {
    delMock.mockClear()
    getMock.mockClear()
    // Stub the hard-redirect target so happy-dom does not attempt navigation.
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { href: '' },
    })
  })

  it('hits /auth/logout, clears TanStack cache, and deletes persist key crm-query-cache', async () => {
    const qc = new QueryClient()
    const clearSpy = vi.spyOn(qc, 'clear')

    const { result } = renderHook(() => useLogout(), { wrapper: makeWrapper(qc) })
    result.current()

    await vi.waitFor(() => {
      expect(getMock).toHaveBeenCalledWith('/auth/logout')
      expect(clearSpy).toHaveBeenCalledTimes(1)
      expect(delMock).toHaveBeenCalledWith(PERSIST_KEY)
    })

    // PERSIST_KEY is the security contract: the persister writes this exact key.
    expect(PERSIST_KEY).toBe('crm-query-cache')
  })

  it('still clears client state when the logout request fails (best-effort)', async () => {
    getMock.mockImplementationOnce(() => Promise.reject(new Error('network')))
    const qc = new QueryClient()
    const clearSpy = vi.spyOn(qc, 'clear')

    const { result } = renderHook(() => useLogout(), { wrapper: makeWrapper(qc) })
    result.current()

    await vi.waitFor(() => {
      expect(clearSpy).toHaveBeenCalledTimes(1)
      expect(delMock).toHaveBeenCalledWith(PERSIST_KEY)
    })
  })
})
