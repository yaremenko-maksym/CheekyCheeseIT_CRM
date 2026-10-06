import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { i18n } from '@lingui/core'
import { I18nProvider } from '@lingui/react'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { AxiosError } from 'axios'
import type { UserProfileDto } from '@crm/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { postMock, patchMock, toastSuccess, toastError, navigateMock } = vi.hoisted(() => ({
  postMock: vi.fn(),
  patchMock: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  navigateMock: vi.fn(),
}))
vi.mock('@/lib/axios', () => ({ api: { post: postMock, patch: patchMock } }))
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigateMock }))

import { useUserDialogMutations } from '../useUserDialogMutations'

const CREATE_FALLBACK =
  'Не вдалося створити користувача — дані залишилися у формі, спробуйте ще раз'
const DROP_FALLBACK = 'Не вдалося створити дропа — дані залишилися у формі, спробуйте ще раз'
const SAVE_FALLBACK = 'Не вдалося зберегти зміни — дані залишилися у формі, спробуйте ще раз'
const READY_FALLBACK = 'Не вдалося позначити контракт готовим до підписання'

function setup(over: Partial<Parameters<typeof useUserDialogMutations>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const args = {
    queryClient: client,
    createdUserId: 'created-1' as string | null,
    setCreatedUserId: vi.fn(),
    setCurrentStep: vi.fn(),
    setHasContract: vi.fn(),
    editingUser: { id: 'edit-1' } as unknown as UserProfileDto,
    onClose: vi.fn(),
    ...over,
  }
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(I18nProvider, { i18n }, createElement(QueryClientProvider, { client }, children))
  const hook = renderHook(() => useUserDialogMutations(args), { wrapper })
  return { args, invalidate, ...hook }
}

const keys = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey)

const axiosErr = (data?: unknown) =>
  ({ response: data === undefined ? undefined : { status: 409, data } }) as AxiosError<{
    message?: string
  }>

describe('useUserDialogMutations', () => {
  beforeEach(() => {
    postMock.mockReset()
    patchMock.mockReset()
    toastSuccess.mockReset()
    toastError.mockReset()
    navigateMock.mockReset()
  })

  describe('createMutation', () => {
    it('POSTs /users, stores the id, advances to step 2, no toast for non-drop', async () => {
      postMock.mockResolvedValue({ data: { id: 'new-1' } })
      const { result, args } = setup()
      const payload = { role: 'JUNIOR', email: 'a@b.c' } as never
      await act(() => result.current.createMutation.mutateAsync(payload))
      expect(postMock).toHaveBeenCalledExactlyOnceWith('/users', payload)
      expect(args.setCreatedUserId).toHaveBeenCalledExactlyOnceWith('new-1')
      expect(args.setCurrentStep).toHaveBeenCalledExactlyOnceWith(2)
      expect(toastSuccess).not.toHaveBeenCalled()
      expect(args.onClose).not.toHaveBeenCalled()
    })

    it('shows the 4500ms toast only for SENIOR + JOIN_DROP_TEAM', async () => {
      postMock.mockResolvedValue({ data: { id: 'new-1' } })
      const { result } = setup()
      await act(() =>
        result.current.createMutation.mutateAsync({
          role: 'SENIOR',
          teamMode: 'JOIN_DROP_TEAM',
        } as never),
      )
      expect(toastSuccess).toHaveBeenCalledExactlyOnceWith('Сеньйора додано до команди дропа', {
        duration: 4500,
      })
      toastSuccess.mockReset()
      await act(() =>
        result.current.createMutation.mutateAsync({ role: 'SENIOR', teamMode: 'NEW' } as never),
      )
      await act(() =>
        result.current.createMutation.mutateAsync({
          role: 'JUNIOR',
          teamMode: 'JOIN_DROP_TEAM',
        } as never),
      )
      expect(toastSuccess).not.toHaveBeenCalled()
    })

    it('on error toasts the explained message and does not advance', async () => {
      postMock.mockRejectedValue(axiosErr())
      const { result, args } = setup()
      await act(() => result.current.createMutation.mutateAsync({} as never).catch(() => {}))
      expect(toastError).toHaveBeenCalledExactlyOnceWith(CREATE_FALLBACK)
      expect(args.setCurrentStep).not.toHaveBeenCalled()
      expect(args.setCreatedUserId).not.toHaveBeenCalled()
    })
  })

  describe('createDropMutation', () => {
    it('POSTs /users/drops, invalidates 4 caches, toasts, closes, navigates to the team', async () => {
      postMock.mockResolvedValue({ data: { user: {}, team: { id: 'team-9' } } })
      const { result, args, invalidate } = setup()
      const payload = { email: 'd@d.d' } as never
      await act(() => result.current.createDropMutation.mutateAsync(payload))
      expect(postMock).toHaveBeenCalledExactlyOnceWith('/users/drops', payload)
      expect(keys(invalidate)).toEqual([['users-admin'], ['users'], ['teams'], ['projects']])
      expect(toastSuccess).toHaveBeenCalledExactlyOnceWith('Дропа створено', { duration: 4500 })
      expect(args.onClose).toHaveBeenCalledOnce()
      expect(navigateMock).toHaveBeenCalledExactlyOnceWith({
        to: '/team/$teamId',
        params: { teamId: 'team-9' },
      })
    })

    it('does not navigate when the response has no team id', async () => {
      postMock.mockResolvedValue({ data: { user: {} } })
      const { result, args } = setup()
      await act(() => result.current.createDropMutation.mutateAsync({} as never))
      expect(args.onClose).toHaveBeenCalledOnce()
      expect(navigateMock).not.toHaveBeenCalled()
    })

    it('on error toasts the drop fallback and keeps the dialog open', async () => {
      postMock.mockRejectedValue(axiosErr())
      const { result, args } = setup()
      await act(() => result.current.createDropMutation.mutateAsync({} as never).catch(() => {}))
      expect(toastError).toHaveBeenCalledExactlyOnceWith(DROP_FALLBACK)
      expect(args.onClose).not.toHaveBeenCalled()
      expect(navigateMock).not.toHaveBeenCalled()
    })
  })

  describe('wizardUpdateMutation', () => {
    it('PATCHes /users/:createdUserId and advances to step 2', async () => {
      patchMock.mockResolvedValue({ data: {} })
      const { result, args } = setup()
      const payload = { displayName: 'X' } as never
      await act(() => result.current.wizardUpdateMutation.mutateAsync(payload))
      expect(patchMock).toHaveBeenCalledExactlyOnceWith('/users/created-1', payload)
      expect(args.setCurrentStep).toHaveBeenCalledExactlyOnceWith(2)
      expect(args.onClose).not.toHaveBeenCalled()
    })

    it('on error toasts the save fallback and does not advance', async () => {
      patchMock.mockRejectedValue(axiosErr())
      const { result, args } = setup()
      await act(() => result.current.wizardUpdateMutation.mutateAsync({} as never).catch(() => {}))
      expect(toastError).toHaveBeenCalledExactlyOnceWith(SAVE_FALLBACK)
      expect(args.setCurrentStep).not.toHaveBeenCalled()
    })
  })

  describe('markReadyMutation', () => {
    it('POSTs /users/:id/contract/ready (no body), resets the wizard and closes', async () => {
      postMock.mockResolvedValue({ data: {} })
      const { result, args, invalidate } = setup()
      await act(() => result.current.markReadyMutation.mutateAsync())
      expect(postMock).toHaveBeenCalledExactlyOnceWith('/users/created-1/contract/ready')
      expect(keys(invalidate)).toEqual([['users-admin'], ['users']])
      expect(toastSuccess).toHaveBeenCalledExactlyOnceWith(
        'Користувача створено, контракт готовий до підписання',
        { duration: 4500 },
      )
      expect(args.setCurrentStep).toHaveBeenCalledExactlyOnceWith(1)
      expect(args.setCreatedUserId).toHaveBeenCalledExactlyOnceWith(null)
      expect(args.setHasContract).toHaveBeenCalledExactlyOnceWith(false)
      expect(args.onClose).toHaveBeenCalledOnce()
    })

    it('on error toasts the ready fallback and leaves state untouched', async () => {
      postMock.mockRejectedValue(axiosErr())
      const { result, args } = setup()
      await act(() => result.current.markReadyMutation.mutateAsync().catch(() => {}))
      expect(toastError).toHaveBeenCalledExactlyOnceWith(READY_FALLBACK)
      expect(args.setCurrentStep).not.toHaveBeenCalled()
      expect(args.setCreatedUserId).not.toHaveBeenCalled()
      expect(args.setHasContract).not.toHaveBeenCalled()
      expect(args.onClose).not.toHaveBeenCalled()
    })
  })

  describe('updateMutation', () => {
    it('PATCHes /users/:editingUser.id, invalidates 4 caches, plain toast, closes', async () => {
      patchMock.mockResolvedValue({ data: {} })
      const { result, args, invalidate } = setup()
      const payload = { displayName: 'Y' } as never
      await act(() => result.current.updateMutation.mutateAsync(payload))
      expect(patchMock).toHaveBeenCalledExactlyOnceWith('/users/edit-1', payload)
      expect(keys(invalidate)).toEqual([
        ['users-admin'],
        ['users'],
        ['teams'],
        ['user-profile', 'edit-1'],
      ])
      expect(toastSuccess).toHaveBeenCalledExactlyOnceWith('Зміни збережено')
      expect(args.onClose).toHaveBeenCalledOnce()
    })

    it('survives the dialog closing mid-PATCH: onSuccess sees editingUser === null', async () => {
      let resolvePatch: (v: { data: object }) => void = () => {}
      patchMock.mockReturnValue(new Promise((r) => (resolvePatch = r)))
      const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
      const invalidate = vi.spyOn(client, 'invalidateQueries')
      const base = {
        queryClient: client,
        createdUserId: null as string | null,
        setCreatedUserId: vi.fn(),
        setCurrentStep: vi.fn(),
        setHasContract: vi.fn(),
        onClose: vi.fn(),
      }
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(
          I18nProvider,
          { i18n },
          createElement(QueryClientProvider, { client }, children),
        )
      const { result, rerender } = renderHook(
        (editingUser: UserProfileDto | null) => useUserDialogMutations({ ...base, editingUser }),
        { wrapper, initialProps: { id: 'edit-1' } as unknown as UserProfileDto | null },
      )
      let pending: Promise<unknown> = Promise.resolve()
      act(() => {
        pending = result.current.updateMutation.mutateAsync({ displayName: 'Y' } as never)
      })
      await waitFor(() =>
        expect(patchMock).toHaveBeenCalledExactlyOnceWith('/users/edit-1', expect.anything()),
      )
      rerender(null)
      await act(async () => {
        resolvePatch({ data: {} })
        await pending
      })
      expect(keys(invalidate)).toContainEqual(['user-profile', undefined])
      expect(base.onClose).toHaveBeenCalledOnce()
    })

    it('announces a pending senior-share proposal instead of the plain toast', async () => {
      patchMock.mockResolvedValue({
        data: { pendingSeniorShare: { percent: 40 }, seniorSharePercent: 30 },
      })
      const { result, args } = setup()
      await act(() => result.current.updateMutation.mutateAsync({} as never))
      expect(toastSuccess).toHaveBeenCalledExactlyOnceWith(
        'Збережено. Сеньйору запропоновано 40% замість чинних 30%',
      )
      expect(args.onClose).toHaveBeenCalledOnce()
    })

    it('on error toasts the save fallback and keeps the dialog open', async () => {
      patchMock.mockRejectedValue(axiosErr())
      const { result, args } = setup()
      await act(() => result.current.updateMutation.mutateAsync({} as never).catch(() => {}))
      expect(toastError).toHaveBeenCalledExactlyOnceWith(SAVE_FALLBACK)
      expect(args.onClose).not.toHaveBeenCalled()
    })
  })

  describe('explainUserMutationError', () => {
    it('prefers a backend-provided message, else the fallback', async () => {
      const { result } = setup()
      await waitFor(() => expect(result.current.explainUserMutationError).toBeTypeOf('function'))
      expect(
        result.current.explainUserMutationError(axiosErr({ message: 'Email already used' }), 'fb'),
      ).toBe('Email already used')
      expect(result.current.explainUserMutationError(axiosErr(), 'fb')).toBe('fb')
    })
  })
})
