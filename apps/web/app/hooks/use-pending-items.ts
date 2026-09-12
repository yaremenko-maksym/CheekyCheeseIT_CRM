import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/axios'
import { useOnboardingGate } from '@/context/onboarding'
import { pendingResponseSchema } from '@crm/shared'

/**
 * task-pending-screen (position 7c). Client side of `GET /pending` — the one
 * screen-wide aggregate of everything the viewer owes a decision on, plus
 * (ADMIN only) what they are waiting on others for.
 *
 * The response TYPE lives in `@crm/shared` (`pending.ts`) and nowhere else:
 * this file used to carry a hand-copied placeholder shape, written while the
 * API half was still landing on the branch (task file "Разделение на две
 * половины"). That placeholder is gone — integration decision 5, 2026-09-11.
 * Consumers import `PendingItem` / `PendingItemKind` straight from
 * `@crm/shared`.
 */

/**
 * AC3 (client half): kept OUT of `PERSISTED_KEY_PREFIXES` (__root.tsx) on
 * purpose, same pattern as `PENDING_APPROVALS_QUERY_KEY`
 * (use-project-approvals.ts) — a SHARE_APPROVAL item's `pendingPercent` must
 * never reach IndexedDB. See `__tests__/persisted-key-prefixes.test.ts` for
 * the regression guard against the real allow-list constant (not a copy of
 * its literal keys).
 *
 * CR-M-2 (fix-round 3): every invalidation of this query imports THIS
 * constant — `use-project-approvals.ts`, `cancel-pending-share.tsx` and
 * `use-user-profile.ts` alike. A `queryKey: ['pending']` literal anywhere
 * else would survive a rename of the key silently, so
 * `__tests__/use-pending-items.test.ts` scans the app sources for one.
 */
export const PENDING_QUERY_KEY = ['pending'] as const

/**
 * The single source both the `/pending` screen, the nav-sidebar badge, and
 * `PendingProjectApprovalsPanel` (SR-L-6) read from — same query key means
 * react-query dedupes the network call across all three mount points
 * instead of each firing its own `GET /pending`.
 *
 * SR-L-5 (fix-round 3): the onboarding gate is taken HERE, and the hook
 * takes no argument, because `enabled: false` disables an OBSERVER, not a
 * query — one ungated observer anywhere in the tree fetches for everybody.
 * Round 2 gated only `NavSidebar`, which left the dashboards (where
 * `PendingProjectApprovalsPanel` mounts unconditionally for SENIOR/DROP —
 * precisely the roles the finding was about) firing `GET /pending` into
 * `OnboardingGuard`'s 403 exactly as before. As a property of the query the
 * gate cannot be desynchronised between the three call sites; ADMIN, whom
 * the guard lets through anyway, reads `isComplete: true` with no extra
 * round-trip (`useOnboardingGate` short-circuits on role).
 *
 * CR-M-1 (fix-round 3): the response is `.parse()`d, like ~9 other hooks in
 * this folder. The union in `pending.ts` is what makes a future server-side
 * leak "get silently stripped at this exact boundary instead of reaching the
 * client" (its own doc) — until now only the server half honoured it, so a
 * version skew between a deployed API and a cached bundle would have handed
 * all three surfaces unvalidated JSON. A failed parse rejects the query,
 * which the screen already renders as its error state (with «Повторить»).
 */
export function usePendingItems() {
  const gate = useOnboardingGate()
  const query = useQuery({
    queryKey: PENDING_QUERY_KEY,
    queryFn: () => api.get<unknown>('/pending').then((r) => pendingResponseSchema.parse(r.data)),
    enabled: gate.isComplete,
  })
  const mine = query.data?.mine ?? []
  const proposedByMe = query.data?.proposedByMe ?? []
  // SR-M-2 / COPY-H-2 (fix-round 4): "we have not asked yet". The gate above
  // is the right fix for SR-L-5, but `enabled: false` in react-query v5
  // reports `isLoading: false` (it is `isPending && isFetching`) with
  // `data: undefined` — so every consumer's "loading → error → empty" chain
  // fell through to EMPTY while the onboarding status was still in flight.
  // On `/pending`, whose entire purpose is to say what is unresolved, that
  // renders «Ничего не ждёт вашего решения» BEFORE the question is asked,
  // and keeps rendering it for the whole session when `GET
  // /onboarding/status` fails (no redirect happens on a failed status — see
  // `_authenticated/route.tsx`). Exposed as a flag AND folded into
  // `isLoading` so the three call sites cannot disagree about it, the same
  // reason the gate itself lives here.
  const gated = !gate.isComplete && !gate.isError
  return {
    ...query,
    mine,
    proposedByMe,
    gated,
    isLoading: query.isLoading || gated,
    // A failed gate is an honest error for this data too: nobody can tell
    // the viewer that nothing awaits them when the prerequisite request
    // never answered.
    isError: query.isError || gate.isError,
    // While the gate is what is broken, retrying `/pending` would change
    // nothing (the query stays disabled) — «Повторить» has to re-ask the
    // status instead.
    refetch: () => {
      if (gate.isError) gate.refetch()
      else void query.refetch()
    },
  }
}
