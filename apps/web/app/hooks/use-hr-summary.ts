import { useQuery } from '@tanstack/react-query'
import { hrSummarySchema, type HrSummaryDto } from '@crm/shared'
import { api } from '@/lib/axios'

/**
 * Stable query-key for the HR summary KPI.
 *
 * Namespaced as `['hr', 'summary']` (NOT in PERSISTED_KEY_PREFIXES):
 *   1. Avoids cache collision with general interview/finance queries.
 *   2. Keeps team-scoped recruiting KPI + the caller's own salary status OFF
 *      disk — `'hr'` is NOT in the persist allow-list in __root.tsx, so it is
 *      never written to IndexedDB.
 *
 * IMPORTANT: Do NOT add `'hr'` to the persist allow-list (salary status / PII).
 */
export const HR_SUMMARY_QUERY_KEY = ['hr', 'summary'] as const

/**
 * HR/ADMIN-only hook: fetches the HR хаб KPI snapshot.
 * GET /api/interviews/hr-summary → HrSummaryDto.
 *
 * RBAC lives on the backend (HR + ADMIN → 200, everyone else → 403); callers
 * should only mount this for those roles (HRDashboard does so via the
 * dashboard.tsx role dispatch).
 */
export function useHrSummary() {
  return useQuery<HrSummaryDto>({
    queryKey: HR_SUMMARY_QUERY_KEY,
    queryFn: async () => {
      const res = await api.get<unknown>('/interviews/hr-summary')
      return hrSummarySchema.parse(res.data)
    },
    staleTime: 30_000,
    retry: 2,
  })
}
