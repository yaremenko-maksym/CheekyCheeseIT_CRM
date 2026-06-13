import { useQuery } from '@tanstack/react-query'
import {
  dropProjectDtoSchema,
  dropPaymentDtoSchema,
  paginatedDropIncomesSchema,
  type DropIncomeStatus,
  type DropPaymentDto,
  type DropProjectDto,
  type PaginatedDropIncomes,
} from '@crm/shared'
import { api } from '@/lib/axios'

/**
 * Namespaced query-keys for all DROP data hooks.
 *
 * ALL keys start with `'drop'` — which is NOT in PERSISTED_KEY_PREFIXES
 * in __root.tsx, so none of this financial data is ever written to
 * IndexedDB. Do NOT add `'drop'` to the allow-list.
 */
export const DROP_INCOMES_QUERY_KEY_PREFIX = 'drop' as const

export interface DropIncomesFilters {
  status?: DropIncomeStatus
  from?: string
  to?: string
  page?: number
  limit?: number
}

/**
 * DROP-only hook: paginated list of the drop's income rows.
 * GET /api/finance/drop/me/incomes?status=&from=&to=&page=&limit=
 */
export function useDropIncomes(filters: DropIncomesFilters = {}) {
  const { status, from, to, page = 1, limit = 20 } = filters

  const params: Record<string, string | number> = { page, limit }
  if (status) params.status = status
  if (from) params.from = from
  if (to) params.to = to

  return useQuery<PaginatedDropIncomes>({
    queryKey: ['drop', 'incomes', filters],
    queryFn: async () => {
      const res = await api.get<unknown>('/finance/drop/me/incomes', { params })
      return paginatedDropIncomesSchema.parse(res.data)
    },
    staleTime: 30_000,
    retry: 2,
  })
}

/**
 * DROP-only hook: the drop's assigned projects.
 * GET /api/projects/drop/me → DropProjectDto[]
 */
export function useDropProjects() {
  return useQuery<DropProjectDto[]>({
    queryKey: ['drop', 'projects'],
    queryFn: async () => {
      const res = await api.get<unknown>('/projects/drop/me')
      return dropProjectDtoSchema.array().parse(res.data)
    },
    staleTime: 5 * 60_000,
    retry: 2,
  })
}

/**
 * DROP-only hook: outgoing payments (drop → company).
 * GET /api/finance/drop/me/payments → DropPaymentDto[]
 */
export function useDropPayments() {
  return useQuery<DropPaymentDto[]>({
    queryKey: ['drop', 'payments'],
    queryFn: async () => {
      const res = await api.get<unknown>('/finance/drop/me/payments')
      return dropPaymentDtoSchema.array().parse(res.data)
    },
    staleTime: 30_000,
    retry: 2,
  })
}
