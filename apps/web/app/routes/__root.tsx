import { createRootRoute, Outlet } from '@tanstack/react-router'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import type { Query } from '@tanstack/react-query'
import { createQueryClient } from '../lib/query-client'
import { persister } from '../lib/persister'
import { TelemetryProvider } from '../lib/telemetry'
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
export const PERSISTED_KEY_PREFIXES = new Set<string>([
  'projects',
  'user-projects',
  'interviews',
  'contract-templates-all',
  'contract-template',
  'tos-current',
  'tos-versions-all',
])

// SR-L-4 (PR #667 fix-round 2): exported so `persisted-key-prefixes.test.ts`'s
// AC3 case can import the REAL predicate instead of maintaining its own copy
// — a copy proves nothing about this file: change the key this app persists
// on (e.g. `queryKey[1]` instead of `[0]`) and a same-file mirror stays green
// while `pendingPercent` starts landing in `crm-query-cache`.
export function shouldDehydrateQuery(query: Query): boolean {
  return query.state.status === 'success' && PERSISTED_KEY_PREFIXES.has(String(query.queryKey[0]))
}

export const Route = createRootRoute({
  component: RootDocument,
})

function RootDocument() {
  return (
    // task-telemetry-web: mounted ABOVE the query provider (and above every
    // route's own `AuthProvider` — see `routes/login.tsx` /
    // `routes/_authenticated/route.tsx`) so error/route/click capture
    // covers the whole app, not just the authenticated CRM shell. No-ops
    // entirely unless `VITE_TELEMETRY=on` — see `lib/telemetry/config.ts`.
    <TelemetryProvider>
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
            shouldDehydrateQuery,
          },
        }}
      >
        <Outlet />
        <Toaster />
      </PersistQueryClientProvider>
    </TelemetryProvider>
  )
}
