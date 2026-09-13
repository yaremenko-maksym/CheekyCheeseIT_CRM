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
 *
 * SR-M-1/CR-M-2 (security-review + code-review, fix-round 2, PR #675): the
 * GET response is now parsed through `notificationPreferencesResponseClientSchema`
 * instead of trusted as `res.data` — the same class of gap `use-pending-
 * items.ts` closed for `/pending` (CR-M-1 on #667). A malformed/truncated
 * response (missing `items`, `locked` disagreeing with the type it's on) now
 * throws inside `queryFn`, which React Query surfaces as `isError` — the
 * SAME `ErrorState` + «Повторить» this tab already renders for an HTTP
 * failure, not a crash.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  notificationPreferencesResponseClientSchema,
  type NewNotificationType,
  type NotificationPreferencesResponseClient,
} from '@crm/shared'
import { api } from '@/lib/axios'

export const NOTIFICATION_PREFERENCES_QUERY_KEY = ['notification-preferences'] as const

export function useNotificationPreferences(): UseQueryResult<
  NotificationPreferencesResponseClient,
  Error
> {
  return useQuery<NotificationPreferencesResponseClient, Error>({
    queryKey: NOTIFICATION_PREFERENCES_QUERY_KEY,
    queryFn: async () => {
      const res = await api.get<unknown>('/notifications/preferences')
      return notificationPreferencesResponseClientSchema.parse(res.data)
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
 * `onError` rolls back ONLY this mutation's own row (see CR-M-1 comment on
 * `onError` below) and shows the server's (already
 * `getUserFacingErrorMessage`-processed, see `axios.ts`) message;
 * `onSuccess` shows "Сохранено"; `onSettled` re-syncs with the server
 * regardless of outcome.
 */
export function useUpdateNotificationPreference(): UseMutationResult<
  void,
  Error,
  UpdateNotificationPreferenceVars,
  { previousItem: NotificationPreferencesResponseClient['items'][number] | undefined }
> {
  const qc = useQueryClient()
  return useMutation<
    void,
    Error,
    UpdateNotificationPreferenceVars,
    { previousItem: NotificationPreferencesResponseClient['items'][number] | undefined }
  >({
    mutationFn: async ({ type, emailEnabled }) => {
      await api.put('/notifications/preferences', { items: [{ type, emailEnabled }] })
    },
    onMutate: async ({ type, emailEnabled }) => {
      await qc.cancelQueries({ queryKey: NOTIFICATION_PREFERENCES_QUERY_KEY })
      const previous = qc.getQueryData<NotificationPreferencesResponseClient>(
        NOTIFICATION_PREFERENCES_QUERY_KEY,
      )
      const previousItem = previous?.items.find((item) => item.type === type)
      if (previous) {
        qc.setQueryData<NotificationPreferencesResponseClient>(NOTIFICATION_PREFERENCES_QUERY_KEY, {
          items: previous.items.map((item) =>
            item.type === type ? { ...item, emailEnabled } : item,
          ),
        })
      }
      return { previousItem }
    },
    // CR-M-1 (code-review, fix-round 2, PR #675): rolling back to the WHOLE
    // snapshot taken at THIS mutation's `onMutate` clobbers any row a
    // SECOND, concurrent mutation optimistically wrote after that snapshot
    // was taken — e.g. toggle row A, then row B before A's PUT resolves; if
    // A then fails, restoring A's snapshot (which predates B's optimistic
    // write) would silently revert B on screen too, even though B's own
    // mutation is still in flight or has already succeeded. Rolling back
    // only THIS mutation's own row, via a functional `setQueryData` updater
    // reading the CURRENT cache (not the stale snapshot) at rollback time,
    // touches exactly the one row this mutation owns and leaves every
    // sibling row's independent optimistic state untouched.
    onError: (err, { type }, context) => {
      if (context?.previousItem) {
        const restored = context.previousItem
        qc.setQueryData<NotificationPreferencesResponseClient>(
          NOTIFICATION_PREFERENCES_QUERY_KEY,
          (current) =>
            current
              ? { items: current.items.map((item) => (item.type === type ? restored : item)) }
              : current,
        )
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
