/**
 * task-project-status-filter-ui. `use-project-approvals.ts` is the ONE
 * place `POST /projects/:id/approve` / `/reject` are called from, and the
 * ONE place that decides which project a DRAFT-bucket widget shows.
 */
import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type { ProjectDto } from '@crm/shared'

vi.mock('@/lib/axios', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}))

import { api } from '@/lib/axios'
import {
  isAlreadyRespondedError,
  useApproveProjectDraft,
  useRejectProjectDraft,
  usePendingProjectApprovals,
  PROJECTS_DEFAULT_QUERY_KEY,
} from '../use-project-approvals'

const mockGet = api.get as ReturnType<typeof vi.fn>
const mockPost = api.post as ReturnType<typeof vi.fn>

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children)
  }
}

function project(overrides: Partial<ProjectDto>): ProjectDto {
  return {
    id: '00000000-0000-0000-0000-0000000000a1',
    name: 'Project',
    companyName: 'Acme',
    domain: 'Other',
    logoDocumentId: null,
    logoExternalUrl: null,
    startDate: '2026-01-01T00:00:00.000Z',
    seniorId: 'senior-1',
    seniorName: 'Senior One',
    dropId: null,
    dropName: null,
    dropSharePercent: null,
    rate: 3000,
    currency: 'USD',
    seniorSharePercentOverride: null,
    seniorSharePercentDefault: 26,
    members: [],
    techStack: null,
    teamSize: null,
    benefits: null,
    paymentType: null,
    salaryReview: null,
    corpTech: null,
    notesGeneral: null,
    status: 'ACTIVE',
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  mockGet.mockReset()
  mockPost.mockReset()
})

describe('isAlreadyRespondedError', () => {
  it('true for a 409 (ConflictException — "уже получило ответ")', () => {
    expect(
      isAlreadyRespondedError({ isAxiosError: true, response: { status: 409 } }),
    ).toBe(true)
  })

  it('SR-M-4 (PR #646 fix-round 1): false for a 404 — used to be true, but a 404 can mean the caller was NEVER an invited approver (real auth failure), not just "already responded"; only 409 is unambiguous', () => {
    expect(
      isAlreadyRespondedError({ isAxiosError: true, response: { status: 404 } }),
    ).toBe(false)
  })

  it('false for a 500 — a real error, must stay surfaced', () => {
    expect(
      isAlreadyRespondedError({ isAxiosError: true, response: { status: 500 } }),
    ).toBe(false)
  })

  it('false for a network error with no response at all', () => {
    expect(isAlreadyRespondedError({ isAxiosError: true, message: 'Network Error' })).toBe(
      false,
    )
  })

  it('false for a non-axios value (defensive)', () => {
    expect(isAlreadyRespondedError(new Error('boom'))).toBe(false)
    expect(isAlreadyRespondedError(undefined)).toBe(false)
  })
})

describe('usePendingProjectApprovals', () => {
  it('buckets DRAFT only — ACTIVE/REJECTED in the same response are excluded', async () => {
    mockGet.mockResolvedValue({
      data: [
        project({ id: 'p-active', status: 'ACTIVE' }),
        project({ id: 'p-draft', status: 'DRAFT' }),
        project({ id: 'p-rejected', status: 'REJECTED' }),
      ],
    })
    const qc = makeQC()
    const { result } = renderHook(() => usePendingProjectApprovals(), {
      wrapper: makeWrapper(qc),
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(result.current.pending.map((p) => p.id)).toEqual(['p-draft'])
    expect(mockGet).toHaveBeenCalledWith('/projects')
  })

  it('empty response → empty pending list, not an error', async () => {
    mockGet.mockResolvedValue({ data: [] })
    const qc = makeQC()
    const { result } = renderHook(() => usePendingProjectApprovals(), {
      wrapper: makeWrapper(qc),
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.pending).toEqual([])
  })

  it('enabled=false never calls the API at all, and `pending` defaults to [] (not undefined/crash) with no data yet', () => {
    const qc = makeQC()
    const { result } = renderHook(() => usePendingProjectApprovals(false), {
      wrapper: makeWrapper(qc),
    })

    expect(mockGet).not.toHaveBeenCalled()
    expect(result.current.pending).toEqual([])
  })
})

describe('useApproveProjectDraft / useRejectProjectDraft', () => {
  it('approve posts to /projects/:id/approve and resolves with the response BODY (not the whole axios envelope)', async () => {
    const approved = project({ id: 'proj-1', status: 'ACTIVE' })
    mockPost.mockResolvedValue({ data: approved })
    const qc = makeQC()
    const { result } = renderHook(() => useApproveProjectDraft(), { wrapper: makeWrapper(qc) })

    act(() => result.current.mutate('proj-1'))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(mockPost).toHaveBeenCalledWith('/projects/proj-1/approve')
    expect(result.current.data).toEqual(approved)
  })

  it('reject posts to /projects/:id/reject with the reason and resolves with the response BODY', async () => {
    const rejected = project({ id: 'proj-1', status: 'REJECTED' })
    mockPost.mockResolvedValue({ data: rejected })
    const qc = makeQC()
    const { result } = renderHook(() => useRejectProjectDraft(), { wrapper: makeWrapper(qc) })

    act(() => result.current.mutate({ projectId: 'proj-1', reason: 'нет бюджета' }))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(mockPost).toHaveBeenCalledWith('/projects/proj-1/reject', { reason: 'нет бюджета' })
    expect(result.current.data).toEqual(rejected)
  })

  it('a successful approve invalidates the shared projects query (both surfaces refresh)', async () => {
    mockPost.mockResolvedValue({ data: project({ status: 'ACTIVE' }) })
    const qc = makeQC()
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useApproveProjectDraft(), { wrapper: makeWrapper(qc) })

    act(() => result.current.mutate('proj-1'))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] })
  })

  it('an "already responded" 409 on approve STILL invalidates — the list was stale, not the mutation broken', async () => {
    mockPost.mockRejectedValue(
      Object.assign(new Error('Conflict'), { isAxiosError: true, response: { status: 409 } }),
    )
    const qc = makeQC()
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useApproveProjectDraft(), { wrapper: makeWrapper(qc) })

    act(() => result.current.mutate('proj-1'))
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] })
  })

  it('an "already responded" 409 on REJECT ALSO invalidates (the same onSettled logic, exercised on its own hook)', async () => {
    mockPost.mockRejectedValue(
      Object.assign(new Error('Conflict'), { isAxiosError: true, response: { status: 409 } }),
    )
    const qc = makeQC()
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useRejectProjectDraft(), { wrapper: makeWrapper(qc) })

    act(() => result.current.mutate({ projectId: 'proj-1', reason: 'x' }))
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] })
  })

  it('SR-M-4 (PR #646 fix-round 1): a 404 on APPROVE does NOT invalidate — it is a real error now (possibly an unauthorized caller), not a stale-list signal', async () => {
    mockPost.mockRejectedValue(
      Object.assign(new Error('Not Found'), { isAxiosError: true, response: { status: 404 } }),
    )
    const qc = makeQC()
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useApproveProjectDraft(), { wrapper: makeWrapper(qc) })

    act(() => result.current.mutate('proj-1'))
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  it('a genuine 500 on APPROVE does NOT invalidate — nothing actually changed server-side', async () => {
    mockPost.mockRejectedValue(
      Object.assign(new Error('boom'), { isAxiosError: true, response: { status: 500 } }),
    )
    const qc = makeQC()
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useApproveProjectDraft(), { wrapper: makeWrapper(qc) })

    act(() => result.current.mutate('proj-1'))
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  it('a genuine 500 on REJECT does NOT invalidate either', async () => {
    mockPost.mockRejectedValue(
      Object.assign(new Error('boom'), { isAxiosError: true, response: { status: 500 } }),
    )
    const qc = makeQC()
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    const { result } = renderHook(() => useRejectProjectDraft(), { wrapper: makeWrapper(qc) })

    act(() => result.current.mutate({ projectId: 'proj-1', reason: 'x' }))
    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(invalidateSpy).not.toHaveBeenCalled()
  })
})

describe('PROJECTS_DEFAULT_QUERY_KEY', () => {
  it('is a prefix of the /projects list page\'s own default query key, so one invalidation reaches both', () => {
    // The literal key the list page uses for its default (non-archived)
    // fetch — kept identical on purpose (see the module doc). A drift here
    // would silently break cross-surface cache sharing without any test
    // failing anywhere else.
    expect(PROJECTS_DEFAULT_QUERY_KEY).toEqual(['projects', { archived: 'active' }])
  })
})
