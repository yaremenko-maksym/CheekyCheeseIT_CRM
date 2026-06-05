import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import {
  contractActionState,
  useSaveContractBody,
  useMarkContractReady,
  useRevertContract,
  useResetContractToTemplate,
  contractKeys,
} from '../useEmployeeContract'

// Test the pure contractActionState helper per the §4 lifecycle/action matrix.
// Hook integration (useQuery/useMutation) is covered by E2E on the real stack.

// ─── Mock @/lib/axios ─────────────────────────────────────────────────────────

vi.mock('@/lib/axios', () => ({
  api: {
    patch: vi.fn(),
    post: vi.fn(),
    get: vi.fn(),
  },
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

import { api } from '@/lib/axios'

const mockPatch = api.patch as ReturnType<typeof vi.fn>
const mockPost = api.post as ReturnType<typeof vi.fn>

// ─── Shared schema mock — parse returns data unchanged ───────────────────────

vi.mock('@crm/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@crm/shared')>()
  return {
    ...actual,
    employeeContractSchema: {
      parse: (data: unknown) => data,
    },
  }
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MOCK_CONTRACT = {
  id: 'contract-uuid',
  userId: 'user-uuid',
  sourceTemplateId: 'tmpl-uuid',
  bodyMarkdown: '# Body',
  status: 'DRAFT' as const,
  signedContractId: null,
  createdByUserId: 'admin-uuid',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

function makeWrapper(qc: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children)
  }
}

function makeQC() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
}

describe('contractActionState', () => {
  it('DRAFT: editable, Save + MarkReady + Reset visible, Revert hidden', () => {
    const s = contractActionState('DRAFT')
    expect(s.editable).toBe(true)
    expect(s.showSave).toBe(true)
    expect(s.showMarkReady).toBe(true)
    expect(s.showReset).toBe(true)
    expect(s.showRevert).toBe(false)
    expect(s.revertDestructive).toBe(false)
  })

  it('READY_TO_SIGN: read-only, Revert visible, Save + MarkReady + Reset hidden', () => {
    const s = contractActionState('READY_TO_SIGN')
    expect(s.editable).toBe(false)
    expect(s.showSave).toBe(false)
    expect(s.showMarkReady).toBe(false)
    expect(s.showReset).toBe(false)
    expect(s.showRevert).toBe(true)
    expect(s.revertDestructive).toBe(false)
  })

  it('SIGNED: read-only, only destructive Revert visible', () => {
    const s = contractActionState('SIGNED')
    expect(s.editable).toBe(false)
    expect(s.showSave).toBe(false)
    expect(s.showMarkReady).toBe(false)
    expect(s.showReset).toBe(false)
    expect(s.showRevert).toBe(true)
    expect(s.revertDestructive).toBe(true)
  })

  it('CANCELLED: all hidden, not editable', () => {
    const s = contractActionState('CANCELLED')
    expect(s.editable).toBe(false)
    expect(s.showSave).toBe(false)
    expect(s.showMarkReady).toBe(false)
    expect(s.showReset).toBe(false)
    expect(s.showRevert).toBe(false)
    expect(s.revertDestructive).toBe(false)
  })
})

// ─── GAP 4: Mutation hooks hit correct endpoints + invalidate query ───────────

describe('useSaveContractBody', () => {
  beforeEach(() => {
    mockPatch.mockReset()
    mockPost.mockReset()
  })

  it('calls PATCH /users/:id/contract with body markdown', async () => {
    const qc = makeQC()
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    mockPatch.mockResolvedValue({ data: MOCK_CONTRACT })

    const { result } = renderHook(() => useSaveContractBody('user-uuid'), {
      wrapper: makeWrapper(qc),
    })

    result.current.mutate('# New body')

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(mockPatch).toHaveBeenCalledWith('/users/user-uuid/contract', {
      bodyMarkdown: '# New body',
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: contractKeys.detail('user-uuid'),
    })
  })
})

describe('useMarkContractReady', () => {
  beforeEach(() => {
    mockPost.mockReset()
  })

  it('calls POST /users/:id/contract/ready', async () => {
    const qc = makeQC()
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    mockPost.mockResolvedValue({ data: { ...MOCK_CONTRACT, status: 'READY_TO_SIGN' } })

    const { result } = renderHook(() => useMarkContractReady('user-uuid'), {
      wrapper: makeWrapper(qc),
    })

    result.current.mutate()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(mockPost).toHaveBeenCalledWith('/users/user-uuid/contract/ready')
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: contractKeys.detail('user-uuid'),
    })
  })
})

describe('useRevertContract', () => {
  beforeEach(() => {
    mockPost.mockReset()
  })

  it('calls POST /users/:id/contract/revert', async () => {
    const qc = makeQC()
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    mockPost.mockResolvedValue({ data: MOCK_CONTRACT })

    const { result } = renderHook(() => useRevertContract('user-uuid'), {
      wrapper: makeWrapper(qc),
    })

    result.current.mutate()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(mockPost).toHaveBeenCalledWith('/users/user-uuid/contract/revert')
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: contractKeys.detail('user-uuid'),
    })
  })
})

describe('useResetContractToTemplate', () => {
  beforeEach(() => {
    mockPost.mockReset()
  })

  it('calls POST /users/:id/contract/reset', async () => {
    const qc = makeQC()
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
    mockPost.mockResolvedValue({ data: MOCK_CONTRACT })

    const { result } = renderHook(() => useResetContractToTemplate('user-uuid'), {
      wrapper: makeWrapper(qc),
    })

    result.current.mutate()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(mockPost).toHaveBeenCalledWith('/users/user-uuid/contract/reset')
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: contractKeys.detail('user-uuid'),
    })
  })

  it('shows error toast when mutation fails', async () => {
    const { toast } = await import('sonner')
    const toastError = toast.error as ReturnType<typeof vi.fn>
    toastError.mockReset()

    mockPost.mockRejectedValue(new Error('Template not found'))

    const qc = makeQC()
    const { result } = renderHook(() => useResetContractToTemplate('user-uuid'), {
      wrapper: makeWrapper(qc),
    })

    result.current.mutate()

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Template not found'))
  })
})
