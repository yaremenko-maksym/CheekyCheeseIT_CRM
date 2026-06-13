import { useQuery } from '@tanstack/react-query'
import { dropSelfSummarySchema, type DropSelfSummaryDto } from '@crm/shared'
import { api } from '@/lib/axios'

/**
 * Stable query-key for the DROP self-summary.
 *
 * Namespaced as `['drop', 'summary']` (NOT in PERSISTED_KEY_PREFIXES):
 *  1. Avoids cache collision with any general finance queries.
 *  2. Keeps drop financial data OFF disk — `'drop'` is NOT in the
 *     allow-list in __root.tsx, so it is never written to IndexedDB.
 *
 * IMPORTANT: Do NOT add `'drop'` to the persist allow-list.
 */
export const DROP_SUMMARY_QUERY_KEY = ['drop', 'summary'] as const

/**
 * DROP-only hook: fetches the authenticated drop's self-summary.
 * GET /api/finance/drop/me/summary → DropSelfSummaryDto
 *
 * Returns balance, dropSharePercent, pendingIncomesCount, debtToCompany.
 * Used by DropBalanceCard and DropActionRequiredBlock on /crm/routing hub.
 */
export function useDropSummary() {
  return useQuery<DropSelfSummaryDto>({
    queryKey: DROP_SUMMARY_QUERY_KEY,
    queryFn: async () => {
      const res = await api.get<unknown>('/finance/drop/me/summary')
      return dropSelfSummarySchema.parse(res.data)
    },
    staleTime: 30_000,
    retry: 2,
  })
}
