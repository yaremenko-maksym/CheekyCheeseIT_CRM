/**
 * Characterization of the drop attach/detach mutation extracted from
 * `$projectId.tsx` (Mikado leaf 8). Expected values are hand-written literals.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { createElement } from 'react'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nTestProvider, loadCatalog } from '@/test/i18n'

const { patch, toastError, getApiErrorMessage } = vi.hoisted(() => ({
  patch: vi.fn(),
  toastError: vi.fn(),
  getApiErrorMessage: vi.fn(),
}))

vi.mock('@/lib/axios', () => ({ api: { patch } }))
vi.mock('@/lib/axios-utils', () => ({ getApiErrorMessage }))
vi.mock('sonner', () => ({ toast: { error: toastError } }))

import { useProjectDropMutations } from '../use-project-drop-mutations'

function setup(onSuccessClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const invalidate = vi.spyOn(qc, 'invalidateQueries')
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(I18nTestProvider, null, children),
    )
  const hook = renderHook(() => useProjectDropMutations('proj-1', onSuccessClose), { wrapper })
  return { hook, invalidate, onSuccessClose }
}

describe('useProjectDropMutations', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    await loadCatalog('uk')
  })

  it('attach: PATCHes { dropId } to the project and returns data', async () => {
    patch.mockResolvedValue({ data: { id: 'proj-1' } })
    const { hook } = setup()
    await act(async () => {
      await hook.result.current.dropMutation.mutateAsync('drop-9')
    })
    expect(patch).toHaveBeenCalledWith('/projects/proj-1', { dropId: 'drop-9' })
  })

  it('detach: PATCHes { dropId: null }', async () => {
    patch.mockResolvedValue({ data: { id: 'proj-1' } })
    const { hook } = setup()
    await act(async () => {
      await hook.result.current.dropMutation.mutateAsync(null)
    })
    expect(patch).toHaveBeenCalledWith('/projects/proj-1', { dropId: null })
  })

  it('success: invalidates project, projects, users in order, then closes dialogs', async () => {
    patch.mockResolvedValue({ data: { id: 'proj-1' } })
    const { hook, invalidate, onSuccessClose } = setup()
    await act(async () => {
      await hook.result.current.dropMutation.mutateAsync('drop-9')
    })
    expect(invalidate.mock.calls.map((c) => c[0])).toEqual([
      { queryKey: ['projects', 'proj-1'] },
      { queryKey: ['projects'] },
      { queryKey: ['users'] },
    ])
    expect(onSuccessClose).toHaveBeenCalledTimes(1)
    expect(toastError).not.toHaveBeenCalled()
  })

  it('error: toasts the resolved message with the uk fallback, no invalidation, no close', async () => {
    const err = new Error('boom')
    patch.mockRejectedValue(err)
    getApiErrorMessage.mockReturnValue('server says no')
    const { hook, invalidate, onSuccessClose } = setup()
    await act(async () => {
      hook.result.current.dropMutation.mutate('drop-9')
    })
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    expect(getApiErrorMessage).toHaveBeenCalledWith(err, 'Не вдалося змінити дропа')
    expect(toastError).toHaveBeenCalledWith('server says no')
    expect(invalidate).not.toHaveBeenCalled()
    expect(onSuccessClose).not.toHaveBeenCalled()
  })
})
