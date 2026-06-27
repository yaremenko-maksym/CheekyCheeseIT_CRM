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

// Allow-list of query-key prefixes that MAY be persisted to IndexedDB (security
// review PR #140). Opt-in / safe-by-default: only non-PII reference data.
// NEVER persist: auth, user-profile, payment credentials (wallet / IBAN /
// RNOKPP / salary), transaction / balance data, PII lists (email / phone /
// telegram), or any team-member data (teamMemberSchema carries email+phone).
// Removed (security audit): 'teams', 'team', 'user-team' — teamMemberSchema
// carries PII fields (email, phone, telegram); persisting these writes contact
// data to IndexedDB across browser sessions. Projects/contracts/ToS are
// non-PII reference data and remain safe to persist.
const PERSISTED_KEY_PREFIXES = new Set<string>([
  'projects',
  'user-projects',
  'interviews',
  'contract-templates-all',
  'contract-template',
  'tos-current',
  'tos-versions-all',
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
          // Persist only successfully resolved queries whose key prefix is in the
          // allow-list (see PERSISTED_KEY_PREFIXES). Pending / error states are
          // transient and never rehydrated into a fresh session.
          shouldDehydrateQuery: (query) =>
            query.state.status === 'success' &&
            PERSISTED_KEY_PREFIXES.has(String(query.queryKey[0])),
        },
      }}
    >
      <Outlet />
      <Toaster />
    </PersistQueryClientProvider>
  )
}
