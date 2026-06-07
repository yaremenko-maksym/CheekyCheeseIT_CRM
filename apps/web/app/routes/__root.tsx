import { createRootRoute, Outlet } from '@tanstack/react-router'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createQueryClient } from '../lib/query-client'
import { persister } from '../lib/persister'
import { Toaster } from '../components/ui/sonner'
import '../styles/globals.css'

const queryClient = createQueryClient()

// Build version buster — invalidates the persisted cache when the build changes
// so stale serialised query shapes don't break a new deploy. VITE_BUILD_VERSION
// is injected per-build via vite `define` (see vite.config.ts); falls back to
// MODE under vitest (define absent there).
const CACHE_BUSTER = import.meta.env.VITE_BUILD_VERSION ?? import.meta.env.MODE

// Query-key prefixes that must NEVER be persisted to IndexedDB (security review
// PR #140): 'auth' carries role/PII → stale persisted role would drift the
// client-side RBAC; the finance family + volatile gating/counter queries must
// always be fetched fresh, never served stale from a restored cache.
const NON_PERSISTED_KEY_PREFIXES = new Set<string>([
  'auth',
  'transactions',
  'transaction',
  'profile-transactions',
  'finance-summary',
  'pending-settlements-senior',
  'pending-settlements-company',
  'invoices',
  'payout-requests',
  'payout-request',
  'balance',
  'exchange-rate',
  'onboarding-status',
  'notifications',
])

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
          // Persist only successfully resolved queries, excluding auth / finance
          // / volatile keys (see NON_PERSISTED_KEY_PREFIXES). Pending / error
          // states are transient and never rehydrated into a fresh session.
          shouldDehydrateQuery: (query) =>
            query.state.status === 'success' &&
            !NON_PERSISTED_KEY_PREFIXES.has(String(query.queryKey[0])),
        },
      }}
    >
      <Outlet />
      <Toaster />
    </PersistQueryClientProvider>
  )
}
