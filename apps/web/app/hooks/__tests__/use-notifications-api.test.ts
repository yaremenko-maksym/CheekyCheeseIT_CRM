import { describe, expect, it } from 'vitest'
import {
  NOTIFICATIONS_POLL_MS,
  NOTIFICATIONS_STALE_MS,
  notificationsQueryKey,
  useDeleteNotification,
} from '../use-notifications-api'

describe('use-notifications-api', () => {
  it('polls every 30s (per spec)', () => {
    expect(NOTIFICATIONS_POLL_MS).toBe(30_000)
  })

  it('staleTime matches the polling interval to avoid double-fires', () => {
    expect(NOTIFICATIONS_STALE_MS).toBe(NOTIFICATIONS_POLL_MS)
  })

  it('query key default shape — unreadOnly=false, limit=10', () => {
    expect(notificationsQueryKey()).toEqual(['notifications', { unreadOnly: false, limit: 10 }])
  })

  it('query key includes unreadOnly + limit overrides', () => {
    expect(notificationsQueryKey({ unreadOnly: true, limit: 50 })).toEqual([
      'notifications',
      { unreadOnly: true, limit: 50 },
    ])
  })

  it('exports useDeleteNotification hook', () => {
    // Smoke test — the hook is a function suitable for use inside a
    // React component context. We can't render it here without a
    // QueryClientProvider, but verifying the export shape catches
    // accidental rename / removal.
    expect(typeof useDeleteNotification).toBe('function')
  })
})
