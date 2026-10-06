import { renderHook } from '@testing-library/react'
import type { UserProfileDto } from '@crm/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { useUserMock } = vi.hoisted(() => ({ useUserMock: vi.fn() }))
vi.mock('@/hooks/use-user-profile', () => ({ useUser: useUserMock }))

import { useEditingUser } from '../useEditingUser'

function dto(over: Record<string, unknown>): UserProfileDto {
  return {
    id: 'u-1',
    email: 'slim@x.io',
    displayName: 'Slim',
    ...over,
  } as unknown as UserProfileDto
}

describe('useEditingUser', () => {
  beforeEach(() => {
    useUserMock.mockReset()
    useUserMock.mockReturnValue({ data: undefined })
  })

  it('returns null in create mode even when a user is passed', () => {
    const { result } = renderHook(() =>
      useEditingUser({ isEdit: false, open: true, listUser: dto({}) }),
    )
    expect(result.current.editingUser).toBeNull()
    expect(result.current.fullProfileLoadedId).toBeNull()
  })

  it('returns null in edit mode without a list user', () => {
    const { result } = renderHook(() =>
      useEditingUser({ isEdit: true, open: true, listUser: null }),
    )
    expect(result.current.editingUser).toBeNull()
    expect(useUserMock).toHaveBeenCalledWith(undefined, false)
  })

  it('stays null with no list user even if a stale full profile is cached', () => {
    useUserMock.mockReturnValue({ data: { user: dto({}) } })
    const { result } = renderHook(() =>
      useEditingUser({ isEdit: true, open: true, listUser: null }),
    )
    expect(result.current.editingUser).toBeNull()
    expect(result.current.fullProfileLoadedId).toBeNull()
  })

  it('recomputes when the list user or the full profile changes', () => {
    const first = dto({})
    const second = dto({ id: 'u-3', displayName: 'Third' })
    const { result, rerender } = renderHook(
      (p: { listUser: UserProfileDto }) =>
        useEditingUser({ isEdit: true, open: true, listUser: p.listUser }),
      { initialProps: { listUser: first } },
    )
    expect(result.current.editingUser).toBe(first)
    rerender({ listUser: second })
    expect(result.current.editingUser).toBe(second)
    useUserMock.mockReturnValue({ data: { user: dto({ id: 'u-3', displayName: 'Full3' }) } })
    rerender({ listUser: second })
    expect(result.current.editingUser?.displayName).toBe('Full3')
    expect(result.current.fullProfileLoadedId).toBe('u-3')
  })

  it('falls back to the slim list user until the full profile loads', () => {
    const slim = dto({})
    const { result } = renderHook(() =>
      useEditingUser({ isEdit: true, open: true, listUser: slim }),
    )
    expect(result.current.editingUser).toBe(slim)
    expect(result.current.fullProfileLoadedId).toBeNull()
  })

  it('merges the full profile over the slim user (full wins, slim-only keys kept)', () => {
    const slim = dto({ slimOnly: 'keep', displayName: 'Slim' })
    useUserMock.mockReturnValue({
      data: { user: dto({ displayName: 'Full', walletUsdtErc20: '0xabc' }) },
    })
    const { result } = renderHook(() =>
      useEditingUser({ isEdit: true, open: true, listUser: slim }),
    )
    expect(result.current.editingUser).toEqual({
      id: 'u-1',
      email: 'slim@x.io',
      displayName: 'Full',
      slimOnly: 'keep',
      walletUsdtErc20: '0xabc',
    })
    expect(result.current.fullProfileLoadedId).toBe('u-1')
  })

  it('ignores a full profile that belongs to a different user', () => {
    const slim = dto({})
    useUserMock.mockReturnValue({ data: { user: dto({ id: 'u-2', displayName: 'Other' }) } })
    const { result } = renderHook(() =>
      useEditingUser({ isEdit: true, open: true, listUser: slim }),
    )
    expect(result.current.editingUser).toBe(slim)
    expect(result.current.fullProfileLoadedId).toBeNull()
  })

  it('enables the fetch only for an open edit dialog with a list user', () => {
    const slim = dto({})
    renderHook(() => useEditingUser({ isEdit: true, open: true, listUser: slim }))
    expect(useUserMock).toHaveBeenLastCalledWith('u-1', true)
    renderHook(() => useEditingUser({ isEdit: true, open: false, listUser: slim }))
    expect(useUserMock).toHaveBeenLastCalledWith('u-1', false)
    renderHook(() => useEditingUser({ isEdit: false, open: true, listUser: slim }))
    expect(useUserMock).toHaveBeenLastCalledWith('u-1', false)
  })
})
