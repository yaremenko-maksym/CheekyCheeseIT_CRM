import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  jobExclusionListSchema,
  jobExclusionSchema,
  jobSuggestionListSchema,
  jobSuggestionSchema,
  type CreateJobExclusionDto,
  type JobExclusionDto,
  type JobExclusionListDto,
  type JobSuggestionDto,
  type JobSuggestionListDto,
  type JobSuggestionStatus,
} from '@crm/shared'
import { api } from '@/lib/axios'

/**
 * Job sourcing queries — task-job-sourcing-slice1.
 *
 * Query keys are namespaced `['job-sourcing', …]` and that prefix is NOT in the
 * persist allow-list in `__root.tsx`: this data names the companies a specific
 * senior is being pitched to, which has no business sitting in IndexedDB on a
 * shared laptop. Same reasoning as `['hr', 'summary']` — see use-hr-summary.ts.
 *
 * Every response is `.parse()`d: the payload originates in a third-party feed,
 * so the schema (https-only URL in particular) is a real runtime guard here,
 * not a formality.
 */

export const jobSuggestionsQueryKey = (seniorId: string | undefined) =>
  ['job-sourcing', 'suggestions', seniorId ?? 'self'] as const

export const jobExclusionsQueryKey = (seniorId: string | undefined) =>
  ['job-sourcing', 'exclusions', seniorId ?? 'self'] as const

/** The senior's queue of NEW suggestions (already filtered server-side). */
export function useJobSuggestions(seniorId: string | undefined, enabled = true) {
  return useQuery<JobSuggestionListDto>({
    queryKey: jobSuggestionsQueryKey(seniorId),
    queryFn: async () => {
      const res = await api.get<unknown>('/job-sourcing/suggestions', {
        params: seniorId ? { seniorId } : undefined,
      })
      return jobSuggestionListSchema.parse(res.data)
    },
    enabled,
    staleTime: 30_000,
  })
}

export function useJobExclusions(seniorId: string | undefined, enabled = true) {
  return useQuery<JobExclusionListDto>({
    queryKey: jobExclusionsQueryKey(seniorId),
    queryFn: async () => {
      const res = await api.get<unknown>('/job-sourcing/exclusions', {
        params: seniorId ? { seniorId } : undefined,
      })
      return jobExclusionListSchema.parse(res.data)
    },
    enabled,
    staleTime: 60_000,
  })
}

/**
 * «Откликнулись» / «Не подходит».
 *
 * NOTE FOR CALLERS: this mutation must never gate opening the original posting.
 * `window.open` has to run synchronously inside the click handler — see
 * JobSuggestionDialog and its test for why (a popup opened after an `await` is
 * blocked on mobile).
 */
export function useUpdateJobSuggestionStatus(seniorId: string | undefined) {
  const queryClient = useQueryClient()

  return useMutation<JobSuggestionDto, unknown, { id: string; status: JobSuggestionStatus }>({
    mutationFn: async ({ id, status }) => {
      const res = await api.patch<unknown>(`/job-sourcing/suggestions/${id}/status`, { status })
      return jobSuggestionSchema.parse(res.data)
    },
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: jobSuggestionsQueryKey(seniorId) })
      toast.success(updated.status === 'APPLIED' ? 'Отмечено: откликнулись' : 'Вакансия скрыта')
    },
    onError: () => {
      toast.error('Не удалось сохранить статус')
    },
  })
}

export function useCreateJobExclusion(seniorId: string | undefined) {
  const queryClient = useQueryClient()

  return useMutation<JobExclusionDto, unknown, CreateJobExclusionDto>({
    mutationFn: async (dto) => {
      const res = await api.post<unknown>('/job-sourcing/exclusions', dto)
      return jobExclusionSchema.parse(res.data)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: jobExclusionsQueryKey(seniorId) })
      void queryClient.invalidateQueries({ queryKey: jobSuggestionsQueryKey(seniorId) })
      toast.success('Исключение добавлено')
    },
    onError: () => {
      toast.error('Не удалось добавить исключение')
    },
  })
}

export function useDeleteJobExclusion(seniorId: string | undefined) {
  const queryClient = useQueryClient()

  return useMutation<void, unknown, string>({
    mutationFn: async (id) => {
      await api.delete(`/job-sourcing/exclusions/${id}`)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: jobExclusionsQueryKey(seniorId) })
      void queryClient.invalidateQueries({ queryKey: jobSuggestionsQueryKey(seniorId) })
      toast.success('Исключение удалено')
    },
    onError: () => {
      toast.error('Не удалось удалить исключение')
    },
  })
}
