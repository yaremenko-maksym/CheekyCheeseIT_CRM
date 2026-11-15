import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/axios'
import { resetLocaleConfirmation } from '@/lib/i18n'
import { purgePersistedBeforeReload } from '@/lib/persister'

/**
 * Полный логаут: серверная сессия + все клиентские данные пользователя.
 * Best-effort: выполняется даже при сетевой ошибке. Чистит TanStack Query
 * (in-memory + IndexedDB persist-ключ) и SW runtime-кеши (api/media);
 * precache-статику не трогает. Затем hard-redirect на /login.
 */
export function useLogout(): () => void {
  const queryClient = useQueryClient()
  return () => {
    void api
      .post('/auth/logout')
      .catch(() => {})
      .finally(async () => {
        // CR-M-3 (fix-round 3, PR #706): drop any `lib/i18n.ts` locale-switch
        // marker BEFORE the hard navigation below — belt-and-suspenders, not
        // load-bearing today (the reload already resets every module-level
        // binding), but removes the reliance on logout always staying a hard
        // navigation. See that function's doc comment for the scenario this
        // guards against.
        resetLocaleConfirmation()

        // 1. Сбросить TanStack Query in-memory кеш
        queryClient.clear()

        // 2. Delete only the persisted query cache key (PERSIST_KEY), no other IDB data. The purge
        //    stops every later persist write first, so a save `clear()` itself started cannot land
        //    after the delete with the previous user's rows (PR #1334 SR-L-2)
        await purgePersistedBeforeReload()

        // 3. Удалить SW runtime кеши (api-cache + media-cache)
        //    Precache-стор ('workbox-precache-*') не трогаем
        if ('caches' in window) {
          const keys = await caches.keys()
          await Promise.all(
            keys
              .filter((k) => k.includes('api-cache') || k.includes('media-cache'))
              .map((k) => caches.delete(k)),
          )
        }

        window.location.href = '/login'
      })
  }
}
