import { useQuery } from '@tanstack/react-query'
import { accountantSummarySchema, type AccountantSummaryDto } from '@crm/shared'
import { api } from '@/lib/axios'

/**
 * Stable query-key for the ACCOUNTANT summary KPI.
 *
 * Namespaced as `['accountant', 'summary']` (NOT in PERSISTED_KEY_PREFIXES):
 *   1. Avoids cache collision with general finance queries.
 *   2. Keeps company-wide financial KPI OFF disk — `'accountant'` is NOT in the
 *      persist allow-list in __root.tsx, so it is never written to IndexedDB.
 *
 * IMPORTANT: Do NOT add `'accountant'` to the persist allow-list (финансы / PII).
 */
export const ACCOUNTANT_SUMMARY_QUERY_KEY = ['accountant', 'summary'] as const

/**
 * ACCOUNTANT/ADMIN-only hook: fetches the accountant финансовый хаб KPI snapshot.
 * GET /api/finance/accountant-summary → AccountantSummaryDto.
 *
 * RBAC lives on the backend (ACCOUNTANT + ADMIN → 200, everyone else → 403);
 * callers should only mount this for those roles (AccountantDashboard does so via
 * the dashboard.tsx role dispatch).
 */
export function useAccountantSummary() {
  return useQuery<AccountantSummaryDto>({
    queryKey: ACCOUNTANT_SUMMARY_QUERY_KEY,
    queryFn: async () => {
      const res = await api.get<unknown>('/finance/accountant-summary')
      return accountantSummarySchema.parse(res.data)
    },
    staleTime: 30_000,
    retry: 2,
  })
}
