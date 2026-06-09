import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { legendSchema, upsertLegendSchema, type Legend, type UpsertLegendDto } from '@crm/shared'
import { api } from '@/lib/axios'

export function useLegend(userId: string | undefined, enabled = true) {
  return useQuery<Legend | null>({
    queryKey: ['legend', userId],
    queryFn: async () => {
      try {
        const res = await api.get<unknown>(`/users/${userId}/legend`)
        return legendSchema.parse(res.data)
      } catch (err: unknown) {
        // 404 = no legend yet — not an error, just empty state
        if (
          err &&
          typeof err === 'object' &&
          'response' in err &&
          (err as { response?: { status?: number } }).response?.status === 404
        ) {
          return null
        }
        throw err
      }
    },
    enabled: enabled && !!userId,
    staleTime: 30_000,
    // 403 = no permission (e.g. ACCOUNTANT) — treat as empty, not error
    retry: (failureCount, error: unknown) => {
      const status =
        error &&
        typeof error === 'object' &&
        'response' in error
          ? (error as { response?: { status?: number } }).response?.status
          : undefined
      if (status === 403 || status === 400) return false
      return failureCount < 2
    },
  })
}

export function useUpsertLegend(userId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: UpsertLegendDto) => {
      const dto = upsertLegendSchema.parse(data)
      return api.put<unknown>(`/users/${userId}/legend`, dto).then((r) =>
        legendSchema.parse(r.data),
      )
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['legend', userId] })
      toast.success('Легенда сохранена')
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}
