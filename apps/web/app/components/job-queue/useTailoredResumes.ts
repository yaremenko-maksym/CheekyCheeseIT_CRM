import { useEffect, useRef } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import {
  TAILORED_LIST_MAX_SENIORS,
  openJobOpportunityResultSchema,
  tailoredResumeDetailSchema,
  tailoredResumeRowSchema,
  type TailoredEditRequest,
  type TailoredResumeDetailDto,
  type TailoredResumeRowDto,
} from '@crm/shared'
import { api } from '@/lib/axios'
import type { QueueScopeSignature } from '@/hooks/use-job-queue'

/**
 * Tailored resume plan Task 13 — the data hooks of the per-senior CV + cover letter controls.
 *
 * Keys start with `'tailored-resume'`, NOT `'job-queue'`: every queue write invalidates the whole
 * `'job-queue'` scope, and a batch GET answered 404 (the feature flag off) must never be asked
 * again by an unrelated write. The prefix is not in `PERSISTED_KEY_PREFIXES` (`__root.tsx`): the
 * rows and the cover letter are PII. A 404/403 here is NOT the queue's access loss: the card stays
 * open and only the controls stay away. Reads never retry and never poll the batch.
 */

export const tailoredScopeKey = (scope: QueueScopeSignature) =>
  ['tailored-resume', scope.actorId, scope.role, scope.teamId ?? 'default'] as const

const seg = encodeURIComponent

const teamParam = (scope: QueueScopeSignature) =>
  scope.teamId === null ? {} : { teamId: scope.teamId }

const seniorPath = (opportunityId: string, seniorId: string) =>
  `/job-queue/${seg(opportunityId)}/seniors/${seg(seniorId)}/tailored`

/** A run or a render still moving: the only time a row's detail polls. */
export const runActive = (row: Pick<TailoredResumeRowDto, 'runStatus'>) =>
  row.runStatus === 'QUEUED' || row.runStatus === 'RUNNING'
export const renderActive = (row: Pick<TailoredResumeRowDto, 'pdfStatus'>) =>
  row.pdfStatus === 'QUEUED' || row.pdfStatus === 'RUNNING'

/** Fixed request size (D10): a 200-senior card asks twice. Arrival order keeps earlier chunks stable. */
const chunks = (ids: readonly string[]) =>
  Array.from({ length: Math.ceil(ids.length / TAILORED_LIST_MAX_SENIORS) }, (_, i) =>
    ids.slice(i * TAILORED_LIST_MAX_SENIORS, (i + 1) * TAILORED_LIST_MAX_SENIORS),
  )

/**
 * A logical clock shared by the reads and writes of this module: a read stamped after a write's
 * answer was sent after the server had already applied that write.
 */
let clock = 0
const stamp = () => ++clock

const READ_ONCE = { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false } as const

/** The batch status of the card's seniors (on card open and after a mutation; never on an interval). */
export function useTailoredRows(
  scope: QueueScopeSignature,
  opportunityId: string,
  seniorIds: readonly string[],
): Map<string, TailoredResumeRowDto> {
  return useQueries({
    queries: chunks(seniorIds).map((ids) => ({
      queryKey: [...tailoredScopeKey(scope), opportunityId, ids],
      queryFn: async () => {
        const res = await api.get<unknown>(`/job-queue/${seg(opportunityId)}/tailored`, {
          params: { ...teamParam(scope), seniorIds: ids.join(',') },
          // 404 = the feature flag is off: the inert answer, so not a refusal the api logs
          validateStatus: (s) => (s >= 200 && s < 300) || s === 404,
        })
        if (res.status === 404) return []
        return z.array(tailoredResumeRowSchema).parse(res.data)
      },
      ...READ_ONCE,
    })),
    combine: (results) =>
      new Map(results.flatMap(({ data }) => data?.map((r) => [r.seniorId, r] as const) ?? [])),
  })
}

/**
 * D1: one `POST /job-sourcing/opportunities/:id/open` per card open, only when a row waits for the
 * posting. The ref holds through every later batch refetch, even one that flips the row back.
 */
export function useOpenForDetail(opportunityId: string, postingPending: boolean) {
  const sent = useRef(false)
  const { mutate } = useMutation({
    mutationFn: async () => {
      const res = await api.post<unknown>(`/job-sourcing/opportunities/${seg(opportunityId)}/open`)
      return openJobOpportunityResultSchema.parse(res.data)
    },
  })
  useEffect(() => {
    if (!postingPending || sent.current) return
    sent.current = true
    mutate()
  }, [postingPending, mutate])
}

/**
 * The per-senior GET, polled every 5 s while `poll` says the row is still moving. `onFetched` sees
 * every answer as it arrives, so a caller reacts to a transition once per fetch, not once per render,
 * with the clock reading taken when that read was sent.
 */
export function useTailoredDetail(
  scope: QueueScopeSignature,
  opportunityId: string,
  seniorId: string,
  {
    enabled,
    poll,
    onFetched,
  }: {
    enabled: boolean
    poll: (data: TailoredResumeDetailDto) => boolean
    onFetched: (data: TailoredResumeDetailDto, sentAt: number) => void
  },
) {
  const latest = useRef(onFetched)
  useEffect(() => {
    latest.current = onFetched
  })
  return useQuery({
    queryKey: [...tailoredScopeKey(scope), opportunityId, seniorId],
    queryFn: async () => {
      const sentAt = stamp()
      const res = await api.get<unknown>(seniorPath(opportunityId, seniorId), {
        params: teamParam(scope),
      })
      const data = tailoredResumeDetailSchema.parse(res.data)
      latest.current(data, sentAt)
      return data
    },
    enabled,
    ...READ_ONCE,
    // an error (access lost mid-poll) stops the poll even though the last data stays
    refetchInterval: (query) => query.state.status === 'success' && poll(query.state.data!) && 5000,
  })
}

function useRefreshTailored(scope: QueueScopeSignature) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: tailoredScopeKey(scope) })
}

/**
 * Start (or, with `overwrite`, replace) a generation: 202 with the run id. `onAccepted` gets the
 * clock reading of the 202 before the refetch it triggers is sent.
 */
export function useGenerateTailored(
  scope: QueueScopeSignature,
  opportunityId: string,
  seniorId: string,
  onAccepted: (at: number) => void,
) {
  const refresh = useRefreshTailored(scope)
  return useMutation({
    mutationFn: async (overwrite: boolean) => {
      const res = await api.post<unknown>(seniorPath(opportunityId, seniorId), {
        ...teamParam(scope),
        overwrite,
      })
      return z.object({ runId: z.string().uuid() }).parse(res.data)
    },
    onSuccess: () => {
      onAccepted(stamp())
      return refresh()
    },
  })
}

/** HR's edit of the published variant: 202 with the render it claimed. */
export function useEditTailored(
  scope: QueueScopeSignature,
  opportunityId: string,
  seniorId: string,
) {
  const refresh = useRefreshTailored(scope)
  return useMutation({
    mutationFn: async (body: Omit<TailoredEditRequest, 'teamId'>) => {
      const res = await api.put<unknown>(seniorPath(opportunityId, seniorId), {
        ...teamParam(scope),
        ...body,
      })
      return z.object({ renderId: z.string().uuid() }).parse(res.data)
    },
    onSuccess: () => refresh(),
  })
}

/**
 * The published PDF through a plain anchor: the browser names the file from the server's
 * `Content-Disposition`. Call only when the row's `pdfStatus` is READY (the route answers 202 otherwise).
 */
export function downloadTailoredPdf(
  scope: QueueScopeSignature,
  opportunityId: string,
  seniorId: string,
) {
  const a = document.createElement('a')
  a.href = api.getUri({
    url: `${seniorPath(opportunityId, seniorId)}/pdf`,
    params: teamParam(scope),
  })
  a.download = ''
  document.body.append(a)
  a.click()
  a.remove()
}
