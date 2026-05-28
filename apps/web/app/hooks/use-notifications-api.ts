/**
 * Backend-backed notifications hooks. Replaces the PHASE 1 in-memory
 * `NotificationsContext` (kept as a legacy stub at
 * `apps/web/app/context/notifications.tsx` for tests / future client-only
 * toasts — not consumed by the header bell anymore).
 *
 * Polling: 30s `refetchInterval` on the list query is enough to pick up
 * `INVOICE_SIGN_REQUIRED` notifications without resorting to WebSockets
 * for v1. `staleTime` mirrors the interval so a manual refetch (e.g. after
 * marking a row read) does not double-fire.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import type { NotificationsListResponse, NotificationListFilters } from '@crm/shared'
import { api } from '@/lib/axios'

// ---------------------------------------------------------------------------
// Cache constants
// ---------------------------------------------------------------------------

export const NOTIFICATIONS_POLL_MS = 30_000
export const NOTIFICATIONS_STALE_MS = 30_000

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export function notificationsQueryKey(filters: Partial<NotificationListFilters> = {}) {
  return [
    'notifications',
    {
      unreadOnly: filters.unreadOnly ?? false,
      limit: filters.limit ?? 10,
    },
  ] as const
}

// ---------------------------------------------------------------------------
// Query: list (bell + dropdown content)
// ---------------------------------------------------------------------------

export interface UseNotificationsOptions {
  unreadOnly?: boolean
  limit?: number
  enabled?: boolean
  /** Polling interval in ms. Defaults to NOTIFICATIONS_POLL_MS (30s). */
  refetchIntervalMs?: number
}

export function useNotificationsList(
  options: UseNotificationsOptions = {},
): UseQueryResult<NotificationsListResponse, Error> {
  const filters: Partial<NotificationListFilters> = {
    unreadOnly: options.unreadOnly ?? false,
    limit: options.limit ?? 10,
  }
  return useQuery<NotificationsListResponse, Error>({
    queryKey: notificationsQueryKey(filters),
    queryFn: async () => {
      const params: Record<string, string> = {
        limit: String(filters.limit ?? 10),
      }
      if (filters.unreadOnly) params['unreadOnly'] = 'true'
      const res = await api.get<NotificationsListResponse>('/notifications', { params })
      return res.data
    },
    refetchInterval: options.refetchIntervalMs ?? NOTIFICATIONS_POLL_MS,
    staleTime: NOTIFICATIONS_STALE_MS,
    enabled: options.enabled ?? true,
  })
}

// ---------------------------------------------------------------------------
// Mutation: mark single read
// ---------------------------------------------------------------------------

export function useMarkNotificationRead(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: async (id: string) => {
      await api.patch(`/notifications/${id}/read`)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}

// ---------------------------------------------------------------------------
// Mutation: mark all read
// ---------------------------------------------------------------------------

export function useMarkAllNotificationsRead(): UseMutationResult<void, Error, void> {
  const qc = useQueryClient()
  return useMutation<void, Error, void>({
    mutationFn: async () => {
      await api.patch('/notifications/read-all')
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}

// ---------------------------------------------------------------------------
// Mutation: delete single notification
// ---------------------------------------------------------------------------
// Hard-deletes a single notification on the backend. UI usage: Trash icon
// rendered next to each row in the header dropdown. No confirm dialog —
// notifications are ephemeral (re-emitted by the system when the underlying
// event re-occurs), so instant deletion is the right UX.

export function useDeleteNotification(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: async (id: string) => {
      await api.delete(`/notifications/${id}`)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notifications'] })
    },
  })
}
