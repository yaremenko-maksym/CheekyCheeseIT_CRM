import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  addLegendEntrySchema,
  legendSchema,
  upsertLegendSchema,
  type AddLegendEntryDto,
  type Legend,
  type UpsertLegendDto,
} from '@crm/shared'
import { api } from '@/lib/axios'
import { getAxiosStatus } from '@/lib/axios-utils'

/**
 * Fetch the legend for a project.
 *
 * - 404 → no legend yet → returns null (not an error)
 * - 403 → viewer lacks access (subject excluded / ACCOUNTANT etc.) → returns null silently
 */
export function useLegend(projectId: string | undefined, enabled = true) {
  return useQuery<Legend | null>({
    queryKey: ['legend', projectId],
    queryFn: async () => {
      try {
        const res = await api.get<unknown>(`/projects/${projectId}/legend`)
        return legendSchema.parse(res.data)
      } catch (err: unknown) {
        // 404 = no legend yet — empty state, not an error
        // 403 = no permission (subject excluded / ACCOUNTANT) — silent
        if (getAxiosStatus(err) === 404 || getAxiosStatus(err) === 403) return null
        throw err
      }
    },
    enabled: enabled && !!projectId,
    staleTime: 30_000,
    retry: (failureCount, error: unknown) => {
      const status = getAxiosStatus(error)
      if (status === 403 || status === 404 || status === 400) return false
      return failureCount < 2
    },
  })
}

export function useUpsertLegend(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: UpsertLegendDto) => {
      const dto = upsertLegendSchema.parse(data)
      return api
        .put<unknown>(`/projects/${projectId}/legend`, dto)
        .then((r) => legendSchema.parse(r.data))
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['legend', projectId] })
      toast.success('Легенда сохранена')
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}

export function useAddLegendEntry(projectId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data: AddLegendEntryDto) => {
      const dto = addLegendEntrySchema.parse(data)
      return api
        .post<unknown>(`/projects/${projectId}/legend/entries`, dto)
        .then((r) => legendSchema.parse(r.data))
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['legend', projectId] })
      toast.success('Запись добавлена')
    },
    onError: (e: Error) => toast.error(`Ошибка: ${e.message}`),
  })
}
