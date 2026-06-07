import { createRootRoute, Outlet } from '@tanstack/react-router'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createQueryClient } from '../lib/query-client'
import { persister } from '../lib/persister'
import { Toaster } from '../components/ui/sonner'
import '../styles/globals.css'

const queryClient = createQueryClient()

// Build version buster — invalidates the persisted cache on code changes so
// stale serialised query shapes don't cause runtime errors after a deploy.
// In development Vite injects the timestamp; in production use the package version.
const CACHE_BUSTER = import.meta.env.VITE_BUILD_VERSION ?? import.meta.env.MODE

export const Route = createRootRoute({
  component: RootDocument,
})

function RootDocument() {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours — matches persister TTL
        buster: CACHE_BUSTER,
        dehydrateOptions: {
          // Only persist successfully resolved queries.  Pending / error states
          // are transient and should never be rehydrated into a fresh session.
          shouldDehydrateQuery: (query) => query.state.status === 'success',
        },
      }}
    >
      <Outlet />
      <Toaster />
    </PersistQueryClientProvider>
  )
}
