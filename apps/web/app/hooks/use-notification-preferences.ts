/**
 * Notification channel preferences — GET/PUT `/api/notifications/preferences`
 * (position 7a, task-notification-settings-ui position 7b).
 *
 * Contract (verified against the merged 7a backend, NOT the pre-merge
 * projected shape in `docs/design/notification-settings.md` §6.3):
 *   GET  → { items: Array<{ type, emailEnabled, locked }> }   — all ten types
 *   PUT  body: { items: Array<{ type, emailEnabled }> }       — batch, 1..10
 *   PUT  →     { items: Array<{ type, emailEnabled, locked }> } — same shape as GET
 *
 * Mirrors the query/mutation pattern in `use-notifications-api.ts`. Query key
 * is a plain constant tuple (never added to `PERSISTED_KEY_PREFIXES` —
 * `project_persist_query_allowlist`: only an explicit allow-list persists,
 * and notification preferences are per-session-fresh data, not something we
 * want served stale from IndexedDB on reload).
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import type { NewNotificationType, NotificationPreferencesResponse } from '@crm/shared'
import { api } from '@/lib/axios'

export const NOTIFICATION_PREFERENCES_QUERY_KEY = ['notification-preferences'] as const

export function useNotificationPreferences(): UseQueryResult<
  NotificationPreferencesResponse,
  Error
> {
  return useQuery<NotificationPreferencesResponse, Error>({
    queryKey: NOTIFICATION_PREFERENCES_QUERY_KEY,
    queryFn: async () => {
      const res = await api.get<NotificationPreferencesResponse>('/notifications/preferences')
      return res.data
    },
  })
}

export interface UpdateNotificationPreferenceVars {
  type: NewNotificationType
  emailEnabled: boolean
}

/**
 * Toggles a single type's email channel. The backend endpoint accepts a
 * BATCH body (`{ items: [...] }`, 1..10 entries) — this hook always sends a
 * single-item batch, which is a valid batch of size 1.
 *
 * Optimistic update (design spec §6.2): the switch flips immediately;
 * `onError` rolls back to the pre-mutation snapshot and shows the server's
 * (already `getUserFacingErrorMessage`-processed, see `axios.ts`) message;
 * `onSuccess` shows "Сохранено"; `onSettled` re-syncs with the server
 * regardless of outcome.
 */
export function useUpdateNotificationPreference(): UseMutationResult<
  void,
  Error,
  UpdateNotificationPreferenceVars,
  { previous: NotificationPreferencesResponse | undefined }
> {
  const qc = useQueryClient()
  return useMutation<
    void,
    Error,
    UpdateNotificationPreferenceVars,
    { previous: NotificationPreferencesResponse | undefined }
  >({
    mutationFn: async ({ type, emailEnabled }) => {
      await api.put('/notifications/preferences', { items: [{ type, emailEnabled }] })
    },
    onMutate: async ({ type, emailEnabled }) => {
      await qc.cancelQueries({ queryKey: NOTIFICATION_PREFERENCES_QUERY_KEY })
      const previous = qc.getQueryData<NotificationPreferencesResponse>(
        NOTIFICATION_PREFERENCES_QUERY_KEY,
      )
      if (previous) {
        qc.setQueryData<NotificationPreferencesResponse>(NOTIFICATION_PREFERENCES_QUERY_KEY, {
          items: previous.items.map((item) =>
            item.type === type ? { ...item, emailEnabled } : item,
          ),
        })
      }
      return { previous }
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(NOTIFICATION_PREFERENCES_QUERY_KEY, context.previous)
      }
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Не удалось сохранить настройку: ${msg}`)
    },
    onSuccess: () => {
      toast.success('Сохранено')
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: NOTIFICATION_PREFERENCES_QUERY_KEY })
    },
  })
}
