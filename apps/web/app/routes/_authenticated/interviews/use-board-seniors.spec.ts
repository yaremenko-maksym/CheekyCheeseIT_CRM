/**
 * task-hr-drop-team-senior-board (AC4) — unit coverage for useBoardSeniors,
 * the board selector's data source.
 *
 * Before this hook, `InterviewsPage` derived the selector from `GET /users`
 * (queryKey ['users']) intersected client-side with `GET /teams` (queryKey
 * ['teams']) for HR — the exact client/server scope divergence this task
 * fixes (see the hook's own docblock). This spec proves the hook talks to
 * the NEW single-source-of-truth endpoint and — the AC4 requirement this
 * repo can't get from the E2E alone — that it NEVER touches `/teams`.
 *
 * Mounting the full `InterviewsPage` route component isn't done here: it's
 * TanStack-Router-bound (`Route.useSearch`), and the established local
 * pattern for that shape of page (see `login-as.spec.tsx`) is to test the
 * extracted, router-independent piece directly instead. `useBoardSeniors`
 * IS that extracted piece — a small `renderHook` test exercises the REAL
 * production hook, so a mutant in it is visible to the mutation gate,
 * unlike a hand-mirrored copy of the query would be.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import type { BoardSeniorDto } from '@crm/shared'

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn((_url?: string) => Promise.resolve({ data: [] as BoardSeniorDto[] })),
}))
vi.mock('@/lib/axios', () => ({ api: { get: getMock } }))

import { useBoardSeniors } from './use-board-seniors'

const SENIOR: BoardSeniorDto = {
  id: '11111111-1111-4111-8111-111111111111',
  displayName: 'Иван Синьор',
  avatarUrl: null,
  avatarDocumentId: null,
}

function makeWrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

describe('useBoardSeniors', () => {
  beforeEach(() => {
    getMock.mockClear()
    getMock.mockResolvedValue({ data: [SENIOR] })
  })

  it('fetches GET /interviews/seniors, never /teams or /users, when enabled', async () => {
    const qc = new QueryClient()
    const { result } = renderHook(() => useBoardSeniors(true), { wrapper: makeWrapper(qc) })

    await waitFor(() => {
      expect(result.current.data).toEqual([SENIOR])
    })

    expect(getMock).toHaveBeenCalledWith('/interviews/seniors')
    expect(getMock).not.toHaveBeenCalledWith('/teams')
    expect(getMock).not.toHaveBeenCalledWith('/users')
    expect(getMock).toHaveBeenCalledTimes(1)

    // Mutation-gate: the returned DATA alone doesn't pin the exact cache key
    // used to store it — a mutated `queryKey` (emptied array, or either
    // string blanked) still resolves the SAME in-flight request and the SAME
    // `result.current.data` above, because there's only one query in flight
    // in this test. The key itself matters for real: other code in this app
    // invalidates by exactly this key after a mutation (see
    // `queryClient.invalidateQueries` call sites) — a wrong key would silently
    // stop those invalidations from ever reaching this query. Reading the
    // data back out BY the literal key is what actually pins it.
    expect(qc.getQueryData(['interviews', 'seniors'])).toEqual([SENIOR])

    // Mutation-gate: `staleTime: 5 * 60_000` mutated to `5 / 60_000` is
    // invisible to every assertion above (it only affects WHEN a refetch is
    // considered necessary, never the first fetch's data/URL). Read the
    // resolved option back off the query cache instead of inferring it from
    // timing.
    const query = qc.getQueryCache().find({ queryKey: ['interviews', 'seniors'] })
    expect(query?.options.staleTime).toBe(5 * 60_000)
  })

  it('does not fetch at all when disabled (SENIOR viewing their own board)', async () => {
    const qc = new QueryClient()
    renderHook(() => useBoardSeniors(false), { wrapper: makeWrapper(qc) })

    // No assertion window to "wait" for a negative — assert immediately AND
    // after a microtask flush, so a hook that fires the request async still
    // gets caught.
    await Promise.resolve()
    expect(getMock).not.toHaveBeenCalled()
  })
})
