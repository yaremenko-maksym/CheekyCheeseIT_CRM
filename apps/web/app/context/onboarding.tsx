/**
 * useOnboardingGate — lightweight hook that exposes whether the current user
 * has completed onboarding (both ToS + MSA contract).
 *
 * Design notes:
 * - Does NOT issue a new network request. TanStack Query deduplicates queries
 *   sharing the same `queryKey` — since `CrmLayout` (route.tsx) already
 *   fetches `['onboarding-status']`, every call to this hook simply reads the
 *   same in-flight or cached result.
 * - ADMIN users always return `{ isComplete: true }` — they bypass the
 *   onboarding gate server-side anyway. The query is disabled via `enabled`.
 * - `isPending` stays `true` while the CrmLayout query is still in flight.
 *   Callers should NOT send "post-onboarding" queries while `isPending` is true
 *   (that is when the 403-spam occurs for non-ADMIN users).
 *
 * Usage:
 *   const { isComplete } = useOnboardingGate()
 *   useNotificationsList({ enabled: isComplete })
 */
import { useQuery } from '@tanstack/react-query'
import type { OnboardingStatusDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'

export interface OnboardingGateResult {
  /** True once we know onboarding is fully complete (both ToS + contract). */
  isComplete: boolean
  /** True while the status query is still loading. */
  isPending: boolean
  /**
   * SR-M-2 / COPY-H-2 (PR #667, fix-round 4): true when the status request
   * itself FAILED. `isComplete: false` alone cannot tell "not asked yet"
   * from "asked and it broke", and the difference is load-bearing for any
   * caller that gates a query on this hook: `_authenticated/route.tsx`
   * redirects to `/onboarding` only when a status actually ARRIVES saying
   * so, so a failed status leaves a non-ADMIN sitting on a gated screen for
   * the rest of the session. A screen that reads this can say «не смогли
   * проверить» instead of silently rendering as if there were nothing to
   * show.
   */
  isError: boolean
  /** Re-issues `GET /onboarding/status` — what a «Повторить» button on a gated screen has to call, since retrying the gated query itself would change nothing while the gate stays shut. */
  refetch: () => void
}

export function useOnboardingGate(): OnboardingGateResult {
  const { user } = useAuth()

  const isAdmin = user?.role === 'ADMIN'

  // Re-use the same query key as CrmLayout so TanStack deduplicates the
  // request — no extra network call is made.
  // ADMIN is excluded via `enabled: !!user && !isAdmin` — they never sign
  // contracts or accept ToS, so the status query would 200 with all-false
  // fields anyway, but skipping it avoids the round-trip entirely.
  const { data, isPending, isError, refetch } = useQuery<OnboardingStatusDto>({
    queryKey: ['onboarding-status'],
    queryFn: async () => {
      const res = await api.get<OnboardingStatusDto>('/onboarding/status')
      return res.data
    },
    enabled: !!user && !isAdmin,
    staleTime: 5 * 60 * 1000,
  })

  // ADMIN: always complete. `refetch` is handed back as-is rather than as a
  // no-op stub — the query is disabled for this role, so there is nothing to
  // special-case, and a stub would be a second code path to keep true.
  if (isAdmin) {
    return { isComplete: true, isPending: false, isError: false, refetch }
  }

  const isComplete = !isPending && !!data && !data.requiresContract && !data.requiresTos

  return { isComplete, isPending, isError, refetch }
}
