/**
 * task-pending-screen. `usePendingItems` is the ONE place `GET /pending` is
 * called from — the /pending screen, the nav-sidebar badge, and
 * `PendingProjectApprovalsPanel` (SR-L-6) all read through it, sharing the
 * same `PENDING_QUERY_KEY` so react-query dedupes the network call.
 *
 * SR-L-5 (fix-round 3): the onboarding gate lives HERE, inside the hook, not
 * in each of the three callers. react-query's `enabled: false` disables an
 * OBSERVER, not a query — one enabled observer anywhere in the tree is
 * enough for the request to go out and for every other observer to receive
 * the data. Gating only `NavSidebar` (fix-round 2) therefore did nothing on
 * the dashboard routes, where `PendingProjectApprovalsPanel` mounts a second,
 * ungated observer on the same key. As a property of the query, the gate
 * cannot be desynchronised between call sites.
 */
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import React from 'react'

vi.mock('@/lib/axios', () => ({
  api: { get: vi.fn() },
}))

let mockIsComplete = true
let mockGateIsError = false
const mockGateRefetch = vi.fn()

vi.mock('@/context/onboarding', async (orig) => {
  const real = await orig<typeof import('@/context/onboarding')>()
  return {
    ...real,
    useOnboardingGate: () => ({
      isComplete: mockIsComplete,
      isPending: !mockIsComplete && !mockGateIsError,
      isError: mockGateIsError,
      refetch: mockGateRefetch,
    }),
  }
})

import { api } from '@/lib/axios'
import type { PendingResponse } from '@crm/shared'
import { usePendingItems, PENDING_QUERY_KEY } from '../use-pending-items'

const mockGet = api.get as ReturnType<typeof vi.fn>

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children)
  }
}

beforeEach(() => {
  mockGet.mockReset()
  mockGateRefetch.mockReset()
  mockIsComplete = true
  mockGateIsError = false
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

  it('surfaces both buckets from a real response', async () => {
    const response: PendingResponse = {
      mine: [
        {
          kind: 'PROJECT_APPROVAL',
          approvalId: '00000000-0000-4000-8000-0000000000a1',
          subjectType: 'PROJECT',
          subjectId: '00000000-0000-4000-8000-0000000000b1',
          title: 'Acme',
          proposedBy: 'Admin One',
          viewerSharePercent: null,
          seniorName: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          actions: ['approve', 'reject'],
          link: '/projects/00000000-0000-4000-8000-0000000000b1',
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

describe('usePendingItems — SR-L-5: the onboarding gate is a property of the QUERY', () => {
  it('pre-onboarding (isComplete=false): no request is issued — whichever of the three call sites mounted it', () => {
    mockIsComplete = false
    mockGet.mockResolvedValue({ data: { mine: [], proposedByMe: [] } })

    renderHook(() => usePendingItems(), { wrapper: makeWrapper() })

    expect(mockGet).not.toHaveBeenCalled()
  })

  it('pre-onboarding: two simultaneous observers (nav badge + dashboard widget) still issue nothing', () => {
    mockIsComplete = false
    mockGet.mockResolvedValue({ data: { mine: [], proposedByMe: [] } })
    const wrapper = makeWrapper()

    renderHook(
      () => {
        usePendingItems()
        usePendingItems()
        return null
      },
      { wrapper },
    )

    expect(mockGet).not.toHaveBeenCalled()
  })

  it('post-onboarding (isComplete=true): the request goes out', async () => {
    mockIsComplete = true
    mockGet.mockResolvedValue({ data: { mine: [], proposedByMe: [] } })

    const { result } = renderHook(() => usePendingItems(), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(mockGet).toHaveBeenCalledWith('/pending')
  })

  it('ignores an `enabled` argument a caller might still pass — the gate cannot be desynchronised again', () => {
    mockIsComplete = false
    mockGet.mockResolvedValue({ data: { mine: [], proposedByMe: [] } })

    // The fix-round-2 signature took `enabled` from the caller; if it ever
    // comes back, passing `true` here would re-open the pre-onboarding hole
    // this finding is about.
    renderHook(() => (usePendingItems as (enabled?: boolean) => unknown)(true), {
      wrapper: makeWrapper(),
    })

    expect(mockGet).not.toHaveBeenCalled()
  })
})

describe('usePendingItems — SR-M-2: «не спрашивали» is not «нечего показать»', () => {
  it('a closed gate reads as LOADING, not as an answered query with nothing in it', () => {
    mockIsComplete = false
    mockGet.mockResolvedValue({ data: { mine: [], proposedByMe: [] } })

    const { result } = renderHook(() => usePendingItems(), { wrapper: makeWrapper() })

    expect(result.current.gated).toBe(true)
    expect(result.current.isLoading).toBe(true)
    expect(result.current.isError).toBe(false)
  })

  it('an OPEN gate with an empty response is not «gated» — the empty state it feeds is a real answer', async () => {
    mockGet.mockResolvedValue({ data: { mine: [], proposedByMe: [] } })

    const { result } = renderHook(() => usePendingItems(), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.gated).toBe(false)
  })

  it('a FAILED gate surfaces as an error, not as a permanent skeleton and not as an empty list', () => {
    mockIsComplete = false
    mockGateIsError = true
    mockGet.mockResolvedValue({ data: { mine: [], proposedByMe: [] } })

    const { result } = renderHook(() => usePendingItems(), { wrapper: makeWrapper() })

    expect(result.current.isError).toBe(true)
    expect(result.current.gated).toBe(false)
    expect(result.current.isLoading).toBe(false)
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('`refetch` re-asks the GATE when the gate is what failed — retrying the disabled query would change nothing', () => {
    mockIsComplete = false
    mockGateIsError = true

    const { result } = renderHook(() => usePendingItems(), { wrapper: makeWrapper() })
    result.current.refetch()

    expect(mockGateRefetch).toHaveBeenCalledTimes(1)
    expect(mockGet).not.toHaveBeenCalled()
  })

  it('`refetch` with a healthy gate re-asks /pending itself', async () => {
    mockGet.mockResolvedValue({ data: { mine: [], proposedByMe: [] } })

    const { result } = renderHook(() => usePendingItems(), { wrapper: makeWrapper() })
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(1))
    result.current.refetch()

    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2))
    expect(mockGateRefetch).not.toHaveBeenCalled()
  })
})

describe('usePendingItems — COPY-L-6: an unknown kind degrades to one row, it does not fail the screen', () => {
  const knownRow = {
    kind: 'PROJECT_APPROVAL',
    approvalId: '00000000-0000-4000-8000-0000000000a1',
    subjectType: 'PROJECT',
    subjectId: '00000000-0000-4000-8000-0000000000b1',
    title: 'Acme',
    viewerSharePercent: null,
    seniorName: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    actions: ['approve', 'reject'],
    link: '/projects/00000000-0000-4000-8000-0000000000b1',
  }

  it('a row of a kind this bundle has never heard of arrives stripped, next to the rows that still work', async () => {
    mockGet.mockResolvedValue({
      data: {
        mine: [
          knownRow,
          {
            kind: 'PAYOUT_TO_CONFIRM',
            subjectId: '00000000-0000-4000-8000-0000000000c1',
            title: 'Выплата на подтверждение',
            createdAt: '2026-01-02T00:00:00.000Z',
            actions: ['approve'],
            link: '/finance/x',
            amountUsd: 1200,
          },
        ],
        proposedByMe: [],
      },
    })

    const { result } = renderHook(() => usePendingItems(), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.isError).toBe(false)
    expect(result.current.mine).toHaveLength(2)
    expect(result.current.mine[0]).toEqual(knownRow)
    expect(result.current.mine[1]).toEqual({
      kind: 'UNKNOWN',
      subjectId: '00000000-0000-4000-8000-0000000000c1',
      createdAt: '2026-01-02T00:00:00.000Z',
      title: '',
      actions: [],
      link: '',
    })
  })
})

describe('usePendingItems — CR-M-1: the response is parsed, not merely typed', () => {
  it('a response whose shape does not match `pendingResponseSchema` fails the query instead of reaching the UI', async () => {
    mockGet.mockResolvedValue({
      data: { mine: [{ kind: 'WAT', approvalId: 'x' }], proposedByMe: [] },
    })

    const { result } = renderHook(() => usePendingItems(), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.mine).toEqual([])
    expect(result.current.proposedByMe).toEqual([])
  })

  it('a response missing a required field of a known kind also fails the query', async () => {
    mockGet.mockResolvedValue({
      data: {
        mine: [
          {
            kind: 'PROJECT_APPROVAL',
            approvalId: '00000000-0000-4000-8000-0000000000a1',
            // subjectType / subjectId / title / createdAt / actions missing
          },
        ],
        proposedByMe: [],
      },
    })

    const { result } = renderHook(() => usePendingItems(), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.isError).toBe(true))
  })

  it('strips a field the schema does not declare — the parse is the boundary, not a formality', async () => {
    mockGet.mockResolvedValue({
      data: {
        mine: [
          {
            kind: 'PROJECT_APPROVAL',
            approvalId: '00000000-0000-4000-8000-0000000000a1',
            subjectType: 'PROJECT',
            subjectId: '00000000-0000-4000-8000-0000000000b1',
            title: 'Acme',
            proposedBy: 'Admin One',
            viewerSharePercent: null,
            seniorName: null,
            createdAt: '2026-01-01T00:00:00.000Z',
            actions: ['approve', 'reject'],
            link: '/projects/00000000-0000-4000-8000-0000000000b1',
            secretSalary: 9000,
          },
        ],
        proposedByMe: [],
      },
    })

    const { result } = renderHook(() => usePendingItems(), { wrapper: makeWrapper() })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.mine[0]).not.toHaveProperty('secretSalary')
  })
})

describe('PENDING_QUERY_KEY', () => {
  it('is a single-element key, not prefixed "projects"/"approvals" — must fall outside the persist allow-list on its own merits', () => {
    expect(PENDING_QUERY_KEY).toEqual(['pending'])
  })

  it("CR-M-2: no production file re-spells the key as a `queryKey: ['pending']` literal — invalidation must follow a rename of the constant", () => {
    const root = join(__dirname, '..', '..')
    const offenders: string[] = []

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === '__tests__' || entry.name === 'node_modules') continue
          walk(full)
          continue
        }
        if (!/\.tsx?$/.test(entry.name)) continue
        if (full.endsWith(join('hooks', 'use-pending-items.ts'))) continue // the definition itself
        if (/queryKey:\s*\['pending'\]/.test(readFileSync(full, 'utf8'))) {
          offenders.push(full.slice(root.length + 1))
        }
      }
    }
    walk(root)

    expect(offenders).toEqual([])
  })
})
