/**
 * QA-H-3 (PR #646 fix-round 4, HIGH — manual-qa repro on `/projects?status=
 * REJECTED`). `persister.spec.ts` / `persister.real-library.spec.ts` prove
 * persister.ts's OWN mechanics (write-time `meta.strippedAt` mark, read-time
 * `dataUpdatedAt = 0` force). This file proves the OTHER half of the claim:
 * that forcing `dataUpdatedAt = 0` on a query actually makes a REAL
 * `useQuery` consumer of that exact key refetch on its very next mount,
 * exactly once, using the REAL `@tanstack/react-query` (only the HTTP layer
 * is mocked) — the same query-key shape and QueryClient defaults
 * (`createQueryClient`, staleTime 60s) the `/projects` list page actually
 * uses (`PROJECTS_DEFAULT_QUERY_KEY`, use-project-approvals.ts).
 *
 * This is deliberately NOT wired through persister.ts's restoreClient at
 * all — happy-dom's IndexedDB is incomplete (see persister.spec.ts's own
 * header comment), so seeding the QueryClient directly with
 * `setQueryData` + `.setState({ dataUpdatedAt: 0 })` is the same
 * end-state `hydrate()` (query-core) would produce for a query
 * `forceRefetchOfStrippedQueries` marked, without needing a working
 * IndexedDB to get there.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClientProvider, useQuery } from '@tanstack/react-query'
import React from 'react'
import { createQueryClient } from './query-client'

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn() },
}))

import { api } from '@/lib/axios'

const mockGet = api.get as ReturnType<typeof vi.fn>

// Same key shape the /projects list page actually queries under
// (PROJECTS_DEFAULT_QUERY_KEY, use-project-approvals.ts) — not load-bearing
// for the mechanism under test (any key works), but keeping it identical
// makes this test read as "the real query", not an artificial stand-in.
const QUERY_KEY = ['projects', { archived: 'active' }] as const

function makeWrapper(qc: ReturnType<typeof createQueryClient>) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children)
  }
}

beforeEach(() => {
  mockGet.mockReset()
})

describe('QA-H-3: a query seeded with dataUpdatedAt=0 refetches on its very next mount, exactly once', () => {
  it('renders the seeded (redacted) snapshot IMMEDIATELY, then replaces it with the fresh response from exactly one background fetch', async () => {
    const redactedSnapshot = [{ id: 'p1', companyName: 'Acme', status: 'REJECTED' }]
    const freshResponse = [
      { id: 'p1', companyName: 'Acme', status: 'REJECTED', rejectionReason: 'нет бюджета' },
    ]
    mockGet.mockResolvedValue({ data: freshResponse })

    const qc = createQueryClient()
    // Simulates exactly what persister.ts's restoreClient hands to
    // hydrate() for a query `meta.strippedAt` marked: data already present,
    // dataUpdatedAt forced to 0.
    qc.setQueryData(QUERY_KEY, redactedSnapshot)
    qc.getQueryCache().find({ queryKey: QUERY_KEY })?.setState({ dataUpdatedAt: 0 })

    const { result } = renderHook(
      () =>
        useQuery({
          queryKey: QUERY_KEY,
          queryFn: () => api.get<typeof freshResponse>('/projects').then((r) => r.data),
        }),
      { wrapper: makeWrapper(qc) },
    )

    // No loading flash — the (redacted) cached data is visible on the very
    // first render, exactly the "restored data renders immediately" half
    // this fix is careful not to regress.
    expect(result.current.data).toEqual(redactedSnapshot)

    await waitFor(() => expect(result.current.data).toEqual(freshResponse))

    expect(mockGet).toHaveBeenCalledTimes(1)
    expect(mockGet).toHaveBeenCalledWith('/projects')
  })

  it('control case: a query with a normal (non-zero, recent) dataUpdatedAt does NOT refetch on mount — proves the MARKING drives the fix, not staleTime alone', async () => {
    const cached = [{ id: 'p1', companyName: 'Acme', status: 'ACTIVE' }]
    mockGet.mockResolvedValue({ data: cached })

    const qc = createQueryClient()
    // No .setState() override here — setQueryData's own dataUpdatedAt
    // defaults to Date.now(), i.e. "just fetched", the common (non-QA-H-3)
    // case every OTHER persisted query still behaves exactly like today.
    qc.setQueryData(QUERY_KEY, cached)

    const { result } = renderHook(
      () =>
        useQuery({
          queryKey: QUERY_KEY,
          queryFn: () => api.get<typeof cached>('/projects').then((r) => r.data),
        }),
      { wrapper: makeWrapper(qc) },
    )

    expect(result.current.data).toEqual(cached)
    // Give a (wrongly triggered) background fetch a tick to have started.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mockGet).not.toHaveBeenCalled()
  })
})
