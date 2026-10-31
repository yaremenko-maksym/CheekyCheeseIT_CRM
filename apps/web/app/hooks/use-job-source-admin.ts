import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createJobSourceNoteSchema,
  jobSourceDetailSchema,
  jobSourceOperationalListSchema,
  type JobSourceDetailDto,
  type JobSourceOperationalListDto,
} from '@crm/shared'
import { api } from '@/lib/axios'

/**
 * Source-fetch-strategy U7 — the ADMIN source page.
 *
 * ADMIN-only server-side (`@Roles('ADMIN')` + a role check in the service body). The query key is
 * namespaced `['job-source-admin', …]` and is NOT in the persist allow-list (`__root.tsx`): this is
 * operational data about third-party feeds, with no business sitting in IndexedDB. Every response is
 * `.parse()`d — the run/event payload carries bounded third-party-derived samples.
 */

export const jobSourceHealthQueryKey = ['job-source-admin', 'health'] as const
export const jobSourceDetailQueryKey = (id: string) =>
  ['job-source-admin', 'detail', id] as const

/** Every source with its current health state, freshness and cadence summary. */
export function useJobSourceHealth(enabled = true) {
  return useQuery<JobSourceOperationalListDto>({
    queryKey: jobSourceHealthQueryKey,
    queryFn: async () => {
      const res = await api.get<unknown>('/job-sourcing/admin/sources/health')
      return jobSourceOperationalListSchema.parse(res.data)
    },
    enabled,
    // Freshness is the point — a stale cached state shown as current would mislead an operator.
    staleTime: 0,
  })
}

/** One source's run timeline + health-event log. */
export function useJobSourceDetail(id: string | undefined, enabled = true) {
  return useQuery<JobSourceDetailDto>({
    queryKey: jobSourceDetailQueryKey(id ?? ''),
    queryFn: async () => {
      const res = await api.get<unknown>(`/job-sourcing/admin/sources/${id}`)
      return jobSourceDetailSchema.parse(res.data)
    },
    enabled: enabled && !!id,
    staleTime: 0,
  })
}

/** Append an ADMIN note as an immutable NOTE health event, then refresh the timeline. */
export function useAddJobSourceNote(id: string) {
  const queryClient = useQueryClient()

  // Feedback (success/error) is announced by the caller (the note form's role=status/alert region),
  // so this hook only performs the write and refreshes the timeline.
  return useMutation<void, unknown, string>({
    mutationFn: async (note) => {
      // Validate before the request so a blank note never leaves the browser.
      const body = createJobSourceNoteSchema.parse({ note })
      await api.post(`/job-sourcing/admin/sources/${id}/notes`, body)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: jobSourceDetailQueryKey(id) })
    },
  })
}
