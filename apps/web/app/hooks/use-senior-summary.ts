import { useQuery } from '@tanstack/react-query'
import { seniorSummarySchema, type SeniorSummaryDto } from '@crm/shared'
import { api } from '@/lib/axios'

/**
 * Stable query-key for the SENIOR summary KPI.
 *
 * Namespaced as `['senior', 'summary']` (NOT in PERSISTED_KEY_PREFIXES):
 *   1. Avoids cache collision with general finance/projects queries.
 *   2. Keeps the senior's own income / payout / salary figures OFF disk —
 *      `'senior'` is NOT in the persist allow-list in __root.tsx, so it is
 *      never written to IndexedDB.
 *
 * IMPORTANT: Do NOT add `'senior'` to the persist allow-list (finance / PII).
 */
export const SENIOR_SUMMARY_QUERY_KEY = ['senior', 'summary'] as const

/**
 * SENIOR/ADMIN-only hook: fetches the senior хаб KPI snapshot.
 * GET /api/finance/senior-summary → SeniorSummaryDto.
 *
 * RBAC lives on the backend (SENIOR + ADMIN → 200, everyone else → 403); the
 * endpoint is STRICTLY self-scoped to the caller's id — there is no target-user
 * param, so a senior can never read another senior's figures. Callers should
 * only mount this for those roles (SeniorDashboard does so via the
 * crm/index.tsx role dispatch).
 */
export function useSeniorSummary() {
  return useQuery<SeniorSummaryDto>({
    queryKey: SENIOR_SUMMARY_QUERY_KEY,
    queryFn: async () => {
      const res = await api.get<unknown>('/finance/senior-summary')
      return seniorSummarySchema.parse(res.data)
    },
    staleTime: 30_000,
    retry: 2,
  })
}
