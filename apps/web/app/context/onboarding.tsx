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
}

export function useOnboardingGate(): OnboardingGateResult {
  const { user } = useAuth()

  const isAdmin = user?.role === 'ADMIN'

  // Re-use the same query key as CrmLayout so TanStack deduplicates the
  // request — no extra network call is made.
  // ADMIN is excluded via `enabled: !!user && !isAdmin` — they never sign
  // contracts or accept ToS, so the status query would 200 with all-false
  // fields anyway, but skipping it avoids the round-trip entirely.
  const { data, isPending } = useQuery<OnboardingStatusDto>({
    queryKey: ['onboarding-status'],
    queryFn: async () => {
      const res = await api.get<OnboardingStatusDto>('/onboarding/status')
      return res.data
    },
    enabled: !!user && !isAdmin,
    staleTime: 5 * 60 * 1000,
  })

  // ADMIN: always complete.
  if (isAdmin) {
    return { isComplete: true, isPending: false }
  }

  const isComplete = !isPending && !!data && !data.requiresContract && !data.requiresTos

  return { isComplete, isPending }
}
