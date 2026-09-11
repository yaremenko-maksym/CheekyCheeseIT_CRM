/**
 * task-pending-screen. `usePendingItems` is the ONE place `GET /pending` is
 * called from — the /pending screen, the nav-sidebar badge, and
 * `PendingProjectApprovalsPanel` (SR-L-6) all read through it, sharing the
 * same `PENDING_QUERY_KEY` so react-query dedupes the network call.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn() },
}))

import { api } from '@/lib/axios'
import { usePendingItems, PENDING_QUERY_KEY, type PendingResponse } from '../use-pending-items'

const mockGet = api.get as ReturnType<typeof vi.fn>

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children)
  }
}

beforeEach(() => {
  mockGet.mockReset()
})

describe('usePendingItems', () => {
  it('SR-L-6: calls GET /pending — never /projects (this is the query PendingProjectApprovalsPanel and the /pending screen share)', async () => {
    const response: PendingResponse = { mine: [], proposedByMe: [] }
    mockGet.mockResolvedValue({ data: response })
    const { result } = renderHook(() => usePendingItems(), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(mockGet).toHaveBeenCalledWith('/pending')
    expect(mockGet).not.toHaveBeenCalledWith('/projects')
  })

  it('exposes `mine`/`proposedByMe` defaulting to [] before data arrives, not undefined/crash', () => {
    mockGet.mockReturnValue(new Promise(() => {})) // never resolves
    const { result } = renderHook(() => usePendingItems(), { wrapper: makeWrapper() })

    expect(result.current.mine).toEqual([])
    expect(result.current.proposedByMe).toEqual([])
  })

  it('enabled=false never calls the API at all', () => {
    const { result } = renderHook(() => usePendingItems(false), { wrapper: makeWrapper() })
    expect(mockGet).not.toHaveBeenCalled()
    expect(result.current.mine).toEqual([])
  })

  it('surfaces both buckets from a real response', async () => {
    const response: PendingResponse = {
      mine: [
        {
          kind: 'PROJECT_APPROVAL',
          subjectId: 'p1',
          title: 'Acme',
          proposedBy: 'Admin One',
          createdAt: '2026-01-01T00:00:00.000Z',
          actions: ['approve', 'reject'],
          link: '/projects/p1',
        },
      ],
      proposedByMe: [],
    }
    mockGet.mockResolvedValue({ data: response })
    const { result } = renderHook(() => usePendingItems(), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.mine).toEqual(response.mine)
    expect(result.current.proposedByMe).toEqual([])
  })
})

describe('PENDING_QUERY_KEY', () => {
  it('is a single-element key, not prefixed "projects"/"approvals" — must fall outside the persist allow-list on its own merits', () => {
    expect(PENDING_QUERY_KEY).toEqual(['pending'])
  })
})
