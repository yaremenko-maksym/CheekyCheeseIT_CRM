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
// review PR #140). Opt-in / safe-by-default: only relatively-stable business &
// reference data is persisted, and NEVER payment credentials (wallet / IBAN /
// RNOKPP / salary), transaction / balance data, or the auth role. Listed keys
// (teams, projects, …) may carry incidental contact fields such as email, but no
// payment requisites. Everything NOT listed — auth, user-profile, payment
// channels, the finance family, users* PII lists, volatile gating/counters — is
// never written to disk, so a new sensitive queryKey can't leak by default.
const PERSISTED_KEY_PREFIXES = new Set<string>([
  'teams',
  'team',
  'projects',
  'user-projects',
  'user-team',
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
