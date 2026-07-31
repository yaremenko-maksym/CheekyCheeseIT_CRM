import { useQueryClient } from '@tanstack/react-query'
import { del as idbDel } from 'idb-keyval'
import { api } from '@/lib/axios'

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
        // 1. Сбросить TanStack Query in-memory кеш
        queryClient.clear()

        // 2. Удалить persist-ключ TanStack Query из IndexedDB.
        //    Точечное удаление по ключу из persister.ts ('crm-query-cache') —
        //    не трогаем другие IDB-данные.
        await idbDel('crm-query-cache')

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
