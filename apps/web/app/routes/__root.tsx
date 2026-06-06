import { createRootRoute, Outlet } from '@tanstack/react-router'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createQueryClient } from '../lib/query-client'
import { queryPersister } from '../lib/persister'
import { Toaster } from '../components/ui/sonner'
import '../styles/globals.css'

const queryClient = createQueryClient()

// VITE_APP_VERSION инжектируется при сборке (env var или CI commit hash).
// При каждом деплое buster меняется → старый IndexedDB-кеш сбрасывается.
// Фолбэк на '1' для локальной разработки.
const CACHE_BUSTER = import.meta.env['VITE_APP_VERSION'] ?? '1'

export const Route = createRootRoute({
  component: RootDocument,
})

function RootDocument() {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister: queryPersister,
        // 12 часов — данные считаются свежими после перезагрузки страницы
        maxAge: 12 * 60 * 60 * 1000,
        // При смене версии деплоя старый кеш автоматически инвалидируется
        buster: CACHE_BUSTER,
      }}
    >
      <Outlet />
      <Toaster />
    </PersistQueryClientProvider>
  )
}
