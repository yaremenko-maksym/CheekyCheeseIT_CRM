import { describe, expect, it } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createElement } from 'react'
import { NotificationsProvider, useNotifications } from './notifications'

function wrapper({ children }: { children: React.ReactNode }) {
  return createElement(NotificationsProvider, null, children)
}

describe('NotificationsProvider', () => {
  it('starts with no notifications', () => {
    const { result } = renderHook(() => useNotifications(), { wrapper })
    expect(result.current.notifications).toHaveLength(0)
    expect(result.current.unreadCount).toBe(0)
  })

  it('adds a notification', () => {
    const { result } = renderHook(() => useNotifications(), { wrapper })
    act(() => {
      result.current.addNotification({ title: 'Hello', message: 'World' })
    })
    expect(result.current.notifications).toHaveLength(1)
    expect(result.current.notifications[0]!.title).toBe('Hello')
    expect(result.current.notifications[0]!.read).toBe(false)
    expect(result.current.unreadCount).toBe(1)
  })

  it('markRead marks a single notification as read', () => {
    const { result } = renderHook(() => useNotifications(), { wrapper })
    act(() => {
      result.current.addNotification({ title: 'A', message: 'B' })
    })
    const id = result.current.notifications[0]!.id
    act(() => {
      result.current.markRead(id)
    })
    expect(result.current.notifications[0]!.read).toBe(true)
    expect(result.current.unreadCount).toBe(0)
  })

  it('markAllRead marks all notifications as read', () => {
    const { result } = renderHook(() => useNotifications(), { wrapper })
    act(() => {
      result.current.addNotification({ title: 'A', message: '1' })
      result.current.addNotification({ title: 'B', message: '2' })
    })
    expect(result.current.unreadCount).toBe(2)
    act(() => {
      result.current.markAllRead()
    })
    expect(result.current.unreadCount).toBe(0)
    expect(result.current.notifications.every((n) => n.read)).toBe(true)
  })

  it('prepends new notifications (newest first)', () => {
    const { result } = renderHook(() => useNotifications(), { wrapper })
    act(() => {
      result.current.addNotification({ title: 'First', message: '' })
    })
    act(() => {
      result.current.addNotification({ title: 'Second', message: '' })
    })
    expect(result.current.notifications[0]!.title).toBe('Second')
  })

  it('throws when used outside provider', () => {
    expect(() => renderHook(() => useNotifications())).toThrow(
      'useNotifications must be used within NotificationsProvider',
    )
  })
})
