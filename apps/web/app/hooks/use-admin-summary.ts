import { useQuery } from '@tanstack/react-query'
import { adminSummarySchema, type AdminSummary } from '@crm/shared'
import { api } from '@/lib/axios'

/**
 * Stable query-key for the ADMIN dashboard summary.
 *
 * Namespaced as `['admin', 'summary']` and deliberately NOT in the persist
 * allow-list (__root.tsx) — it carries company-wide financial figures + active
 * transactions, which must never be written to IndexedDB. Mirrors the
 * accountant/senior summary hooks.
 *
 * IMPORTANT: Do NOT add `'admin'` to the persist allow-list (финансы / PII).
 */
export const ADMIN_SUMMARY_QUERY_KEY = ['admin', 'summary'] as const

/**
 * ADMIN-only hook: fetches the «центр действий» dashboard snapshot.
 * GET /api/admin/summary → AdminSummary (KPI counters + active transactions).
 *
 * RBAC lives on the backend (ADMIN → 200, everyone else → 403); callers should
 * only mount this for ADMIN (the index.tsx role dispatch does so). The response
 * is Zod-validated with `.parse` so any wire-shape drift fails loudly.
 */
export function useAdminSummary() {
  return useQuery<AdminSummary>({
    queryKey: ADMIN_SUMMARY_QUERY_KEY,
    queryFn: async () => {
      const res = await api.get<unknown>('/admin/summary')
      return adminSummarySchema.parse(res.data)
    },
    staleTime: 30_000,
    retry: 2,
  })
}
