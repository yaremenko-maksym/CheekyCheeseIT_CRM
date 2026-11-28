import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  jobSourceListSchema,
  jobSourceSwitchResultSchema,
  type JobSourceListDto,
  type JobSourceSwitchResultDto,
} from '@crm/shared'
import { api } from '@/lib/axios'
import { jobSourceHealthQueryKey } from './use-job-source-admin'

/**
 * Job sourcing — the ADMIN source catalog (task-job-sourcing-slice1).
 *
 * The suggestion and exclusion hooks that used to live here were deleted with
 * the Interviews-board dialog (task-sources-07c, 2026-11-19): the vacancy queue
 * is ADMIN/HR work on `/job-queue`, and a senior sees only its outcome as an
 * interview card. What is left is the source switchboard.
 *
 * Query keys are namespaced `['job-sourcing', …]` and that prefix is NOT in the
 * persist allow-list in `__root.tsx` — same reasoning as `['hr', 'summary']`,
 * see use-hr-summary.ts.
 *
 * Every response is `.parse()`d: the payload originates in a third-party feed,
 * so the schema (https-only URL in particular) is a real runtime guard here,
 * not a formality.
 */

export const jobSourcesQueryKey = ['job-sourcing', 'sources'] as const

/**
 * Configured sources + their remaining request budget (task-vacancy-matching
 * AC7). ADMIN-only server-side; `enabled` lets the caller avoid a guaranteed
 * 403 for everyone else.
 *
 * `staleTime: 0` on purpose: the whole point of this query is to show how much
 * allowance is LEFT, and a cached remainder shown after a collection run is a
 * wrong number presented as a fact.
 */
export function useJobSources(enabled = true) {
  return useQuery<JobSourceListDto>({
    queryKey: jobSourcesQueryKey,
    queryFn: async () => {
      const res = await api.get<unknown>('/job-sourcing/sources')
      return jobSourceListSchema.parse(res.data)
    },
    enabled,
    staleTime: 0,
  })
}

/**
 * ADMIN source switch (r5 Task 7.5). The caller passes the INVERTED value; the server answers 409
 * when it refuses to enable (`JOB_SOURCE_NOT_READY` / `JOB_SOURCE_AUTH_PAUSED`). Feedback is the
 * caller's (an inline note under the source), so this hook only writes and refetches — and only on
 * success: a refused change leaves both lists exactly as they were.
 */
export function useSetJobSourceEnabled() {
  const queryClient = useQueryClient()

  return useMutation<JobSourceSwitchResultDto, unknown, { id: string; enabled: boolean }>({
    mutationFn: async ({ id, enabled }) => {
      const res = await api.patch<unknown>(`/job-sourcing/sources/${id}`, { enabled })
      return jobSourceSwitchResultSchema.parse(res.data)
    },
    // Returned, not fire-and-forget: the mutation stays pending until both lists are refetched.
    // The switch keeps showing the old value while the request is pending and stays guarded
    // (`aria-disabled`) until the fresh value arrives, so it is never flipped by a stale click.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: jobSourcesQueryKey }),
        queryClient.invalidateQueries({ queryKey: jobSourceHealthQueryKey }),
      ]),
  })
}
