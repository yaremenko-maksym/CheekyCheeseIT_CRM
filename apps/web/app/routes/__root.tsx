import { createRootRoute, Outlet } from '@tanstack/react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { createQueryClient } from '../lib/query-client'
import { Toaster } from '../components/ui/sonner'
import '../styles/globals.css'

const queryClient = createQueryClient()

// NOTE: PersistQueryClientProvider was removed from this PR because it causes
// a race condition with the auth guard in routes/crm/route.tsx.
//
// Mechanism: PersistQueryClientProvider suspends all useQuery calls while
// restoring the IndexedDB cache (isRestoring = true). During this window the
// ['auth','me'] query has status:'pending' / fetchStatus:'idle'. When the
// restore completes with an empty cache (E2E: serviceWorkers:'block' + fresh
// browser context) there is a render cycle where isLoading=false and
// user=null — the CrmLayout guard fires navigate({ to:'/crm/login' })
// before the real /auth/me response arrives, causing a redirect to /crm
// instead of staying on /crm/interviews.
//
// SW-based caching (Workbox NetworkFirst for /api/*, CacheFirst for media)
// is preserved — it provides the core offline/caching benefit without the
// auth-guard race. persistQueryClient can be reintroduced in a follow-up
// task once the guard is made isRestoring-aware (useIsRestoring hook).

export const Route = createRootRoute({
  component: RootDocument,
})

function RootDocument() {
  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
      <Toaster />
    </QueryClientProvider>
  )
}
