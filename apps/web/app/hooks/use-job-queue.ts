import { useEffect, useRef } from 'react'
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query'
import {
  jobQueueCardResponseSchema,
  jobQueueDismissalResponseSchema,
  jobQueueListResponseSchema,
  jobQueuePossibleDuplicateConflictSchema,
  jobQueueRecomputeResponseSchema,
  jobQueueSeniorsContinuationSchema,
  jobQueueSourcesContinuationSchema,
  jobQueueSubmissionResponseSchema,
  jobQueueTeamTriageGrantSchema,
  jobQueueTeamTriageSubscriptionSchema,
  type JobQueueCancelSubmissionRequestDto,
  type JobQueueDismissRequestDto,
  type JobQueueListQuery,
  type JobQueueManualCardRequestDto,
  type JobQueuePossibleDuplicateConflictDto,
  type JobQueueSubmitRequestDto,
  type JobQueueTab,
  type JobQueueTeamTriageGrantRequest,
  type JobQueueTeamTriageRevokeRequest,
  type JobQueueTeamTriageSubscribeRequest,
  type JobQueueTeamTriageUnsubscribeRequest,
  type JobQueueUndoRequestDto,
  type Role,
} from '@crm/shared'
import { api } from '@/lib/axios'
import { getApiErrorCode, getAxiosStatus } from '@/lib/axios-utils'

/**
 * r5 Task 7.1 — the data hooks of the HR vacancy queue (`/job-queue`).
 *
 * Every key starts with `['job-queue', actorId, role, teamId]`: the queue is scoped per actor and
 * per team, so a cache filled under one account, role or team can never answer for another. The
 * `'job-queue'` prefix is NOT in `PERSISTED_KEY_PREFIXES` (`__root.tsx`): the queue names the
 * seniors a team pitches, which has no business in IndexedDB on a shared laptop. Logout already
 * clears the whole client (`use-logout.ts`); a scope change evicts the other scopes (`useJobQueue`).
 *
 * Every response is `.parse()`d against its `@crm/shared` schema (strict objects, https-only URLs).
 * The hooks show no text: callers map `getApiErrorCode(error)` to localized copy (Task 7.4).
 */

/** Who is looking, as which role, at which team (`null` = the server's default scope). */
export interface QueueScopeSignature {
  actorId: string
  role: Role
  teamId: string | null
}

export type QueueFilters = Partial<
  Pick<JobQueueListQuery, 'search' | 'source' | 'eligibility' | 'availability' | 'activity' | 'seniorId'>
>

export const JOB_QUEUE_PAGE_LIMIT = 20

export const jobQueueScopeKey = (scope: QueueScopeSignature) =>
  ['job-queue', scope.actorId, scope.role, scope.teamId ?? 'default'] as const

export const jobQueueQueryKey = (
  scope: QueueScopeSignature,
  tab: JobQueueTab,
  filters: QueueFilters,
) => [...jobQueueScopeKey(scope), 'list', tab, filters] as const

export const jobQueueCardQueryKey = (scope: QueueScopeSignature, id: string) =>
  [...jobQueueScopeKey(scope), 'card', id] as const

/** Codes after which the list cannot continue and must restart from its first page. */
const REFRESH_CODES = new Set(['JOB_QUEUE_REFRESH_REQUIRED', 'JOB_QUEUE_CURSOR_MALFORMED'])

function teamParam(scope: QueueScopeSignature) {
  return scope.teamId === null ? {} : { teamId: scope.teamId }
}

/** The wire form of the filters: multi-selects comma-joined, empty selections omitted. */
function filterParams(filters: QueueFilters) {
  const params: Record<string, string> = {}
  for (const [name, value] of Object.entries(filters)) {
    const wire = Array.isArray(value) ? value.join(',') : value
    if (wire) params[name] = wire
  }
  return params
}

function sameScope(key: QueryKey, scope: QueueScopeSignature) {
  const own = jobQueueScopeKey(scope)
  return own.every((part, i) => key[i] === part)
}

/** Drops every cached queue page and card (all scopes). */
export function clearJobQueueCaches(queryClient: QueryClient) {
  queryClient.removeQueries({ queryKey: ['job-queue'] })
}

/** The list, one page of 20 per `nextCursor`. A scope change evicts every other scope's cache. */
export function useJobQueue(scope: QueueScopeSignature, tab: JobQueueTab, filters: QueueFilters) {
  const queryClient = useQueryClient()
  const queryKey = jobQueueQueryKey(scope, tab, filters)
  const { actorId, role, teamId } = scope

  useEffect(() => {
    queryClient.removeQueries({
      queryKey: ['job-queue'],
      predicate: (q) => !sameScope(q.queryKey, { actorId, role, teamId }),
    })
  }, [queryClient, actorId, role, teamId])

  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const res = await api.get<unknown>('/job-queue', {
        params: {
          ...teamParam(scope),
          tab,
          ...filterParams(filters),
          limit: JOB_QUEUE_PAGE_LIMIT,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
      })
      return jobQueueListResponseSchema.parse(res.data)
    },
    getNextPageParam: (last) => last.nextCursor,
  })

  return {
    ...query,
    /** The generation behind the cursor is gone: offer «Показати оновлений список». */
    refreshRequired: REFRESH_CODES.has(getApiErrorCode(query.error) ?? ''),
    /** Replaces the list with a fresh first page (no stale pages kept). */
    restart: () => queryClient.resetQueries({ queryKey, exact: true }),
  }
}

/**
 * One card. `notFound` (404 — missing OR no longer authorized, indistinguishable by design) hides
 * the last data so no stale name stays on screen, and refreshes the scope's lists.
 */
export function useJobQueueCard(scope: QueueScopeSignature, id: string | null) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: jobQueueCardQueryKey(scope, id ?? ''),
    queryFn: async () => {
      const res = await api.get<unknown>(`/job-queue/${id}`, { params: teamParam(scope) })
      return jobQueueCardResponseSchema.parse(res.data)
    },
    enabled: id !== null,
  })
  const notFound = getApiErrorCode(query.error) === 'JOB_OPPORTUNITY_NOT_FOUND'
  const { actorId, role, teamId } = scope

  useEffect(() => {
    if (notFound) {
      void queryClient.invalidateQueries({
        queryKey: [...jobQueueScopeKey({ actorId, role, teamId }), 'list'],
      })
    }
  }, [notFound, queryClient, actorId, role, teamId])

  return { ...query, data: notFound ? undefined : query.data, notFound }
}

/**
 * The continuation of a card preview (seniors past 200, sources past 20), from the preview's own
 * `nextCursor`; disabled while that cursor is `null`. `totalCount` is the server's denominator.
 */
function useContinuation<T extends { nextCursor: string | null }>(
  scope: QueueScopeSignature,
  id: string | null,
  cursor: string | null,
  part: 'seniors' | 'sources',
  parse: (data: unknown) => T,
) {
  return useInfiniteQuery({
    queryKey: [...jobQueueCardQueryKey(scope, id ?? ''), part, cursor],
    initialPageParam: cursor ?? '',
    queryFn: async ({ pageParam }) => {
      const res = await api.get<unknown>(`/job-queue/${id}/${part}`, {
        params: { ...teamParam(scope), cursor: pageParam },
      })
      return parse(res.data)
    },
    getNextPageParam: (last) => last.nextCursor,
    enabled: id !== null && cursor !== null,
  })
}

export function useJobQueueSeniors(
  scope: QueueScopeSignature,
  id: string | null,
  cursor: string | null,
) {
  return useContinuation(scope, id, cursor, 'seniors', (d) =>
    jobQueueSeniorsContinuationSchema.parse(d),
  )
}

export function useJobQueueSources(
  scope: QueueScopeSignature,
  id: string | null,
  cursor: string | null,
) {
  return useContinuation(scope, id, cursor, 'sources', (d) =>
    jobQueueSourcesContinuationSchema.parse(d),
  )
}

/** The 409 `JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED` body (the duplicates to confirm), else `null`. */
export function getJobQueuePossibleDuplicateConflict(
  error: unknown,
): JobQueuePossibleDuplicateConflictDto | null {
  const data = (error as { response?: { data?: unknown } } | null)?.response?.data
  const parsed = jobQueuePossibleDuplicateConflictSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

/**
 * Every queue write. The idempotency key belongs to the INTENT (the variables): it is kept while
 * an attempt got no answer (a lost response — the retry must replay the same key and receive the
 * earlier success), and dropped once the server answered. Settling always refreshes the scope; a
 * 404 also evicts that card so a revoked one cannot show its last data.
 */
function useQueueWrite<V, R>(
  scope: QueueScopeSignature,
  send: (vars: V, idempotencyKey: string) => Promise<R>,
  cardId?: (vars: V) => string,
) {
  const queryClient = useQueryClient()
  const keys = useRef(new Map<string, string>())

  return useMutation<R, unknown, V>({
    mutationFn: (vars) => {
      const intent = JSON.stringify(vars ?? null)
      const key = keys.current.get(intent) ?? crypto.randomUUID()
      keys.current.set(intent, key)
      return send(vars, key)
    },
    onSettled: (_data, error, vars) => {
      const answered = error === null || getAxiosStatus(error) !== undefined
      if (answered) keys.current.delete(JSON.stringify(vars ?? null))
      if (cardId && getApiErrorCode(error) === 'JOB_OPPORTUNITY_NOT_FOUND') {
        queryClient.removeQueries({ queryKey: jobQueueCardQueryKey(scope, cardId(vars)) })
      }
      void queryClient.invalidateQueries({ queryKey: jobQueueScopeKey(scope) })
    },
  })
}

type Body<T> = Omit<T, 'teamId' | 'idempotencyKey'>
type OnCard<T> = Body<T> & { opportunityId: string }

const card = (vars: { opportunityId: string }) => vars.opportunityId

/** «Записати подачу» for ONE senior (expected revision/version from the card). */
export function useSubmitJobQueueSenior(scope: QueueScopeSignature) {
  return useQueueWrite(
    scope,
    async (
      { opportunityId, ...body }: OnCard<Omit<JobQueueSubmitRequestDto, 'confirmPossibleDuplicate'>> & {
        confirmPossibleDuplicate?: boolean
      },
      idempotencyKey,
    ) => {
      const res = await api.post<unknown>(`/job-queue/${opportunityId}/submissions`, {
        ...teamParam(scope),
        ...body,
        idempotencyKey,
      })
      return jobQueueSubmissionResponseSchema.parse(res.data)
    },
    card,
  )
}

export function useCancelJobQueueSubmission(scope: QueueScopeSignature) {
  return useQueueWrite(
    scope,
    async (
      { opportunityId, submissionId, ...body }: OnCard<JobQueueCancelSubmissionRequestDto> & {
        submissionId: string
      },
      idempotencyKey,
    ) => {
      const res = await api.post<unknown>(
        `/job-queue/${opportunityId}/submissions/${submissionId}/cancel`,
        { ...teamParam(scope), ...body, idempotencyKey },
      )
      return jobQueueSubmissionResponseSchema.parse(res.data)
    },
    card,
  )
}

/** «Приховати» in the TEAM or (ADMIN) STUDIO scope; versioned on a re-dismiss. */
export function useDismissJobQueueItem(scope: QueueScopeSignature) {
  return useQueueWrite(
    scope,
    async ({ opportunityId, ...body }: OnCard<JobQueueDismissRequestDto>, idempotencyKey) => {
      const res = await api.post<unknown>(`/job-queue/${opportunityId}/dismiss`, {
        ...teamParam(scope),
        ...body,
        idempotencyKey,
      })
      return jobQueueDismissalResponseSchema.parse(res.data)
    },
    card,
  )
}

export function useUndoJobQueueDismissal(scope: QueueScopeSignature) {
  return useQueueWrite(
    scope,
    async ({ opportunityId, ...body }: OnCard<JobQueueUndoRequestDto>, idempotencyKey) => {
      const res = await api.post<unknown>(`/job-queue/${opportunityId}/undo`, {
        ...teamParam(scope),
        ...body,
        idempotencyKey,
      })
      return jobQueueDismissalResponseSchema.parse(res.data)
    },
    card,
  )
}

/**
 * Click telemetry. Fire-and-forget: it never throws and never delays the caller, who opens the
 * posting synchronously inside the gesture (`openOriginalPosting`).
 */
export function useMarkJobOpened(scope: QueueScopeSignature) {
  return (opportunityId: string, sourceRecordId: string): void => {
    api
      .post(`/job-queue/${opportunityId}/opened`, { ...teamParam(scope), sourceRecordId })
      .catch(() => {})
  }
}

/** A card for a vacancy found outside the sources, created with its first submission. */
export function useCreateManualJobQueueCard(scope: QueueScopeSignature) {
  return useQueueWrite(
    scope,
    async (
      body: Body<Omit<JobQueueManualCardRequestDto, 'confirmPossibleDuplicate'>> & {
        confirmPossibleDuplicate?: boolean
      },
      idempotencyKey,
    ) => {
      const res = await api.post<unknown>('/job-queue/manual', { ...body, idempotencyKey })
      return jobQueueSubmissionResponseSchema.parse(res.data)
    },
  )
}

/** ADMIN: takes the opportunity down for every team scope (204). */
export function useSuppressJobQueueItem(scope: QueueScopeSignature) {
  return useQueueWrite(
    scope,
    async ({ opportunityId }: { opportunityId: string }, idempotencyKey) => {
      await api.post(`/job-queue/${opportunityId}/suppress`, { idempotencyKey })
    },
    card,
  )
}

/** ADMIN: enqueues a match recompute (202 + run id). */
export function useRecomputeJobQueue(scope: QueueScopeSignature) {
  return useQueueWrite(scope, async (_vars: void) => {
    const res = await api.post<unknown>('/job-queue/recompute')
    return jobQueueRecomputeResponseSchema.parse(res.data)
  })
}

/** ADMIN: grants one team triage visibility of one opportunity. */
export function useGrantJobQueueTeamTriage(scope: QueueScopeSignature) {
  return useQueueWrite(
    scope,
    async (
      { opportunityId, ...body }: Omit<JobQueueTeamTriageGrantRequest, 'idempotencyKey'> & {
        opportunityId: string
      },
      idempotencyKey,
    ) => {
      const res = await api.post<unknown>(`/job-queue/${opportunityId}/team-triage`, {
        ...body,
        idempotencyKey,
      })
      return jobQueueTeamTriageGrantSchema.parse(res.data)
    },
    card,
  )
}

/** ADMIN: revokes a team's triage grant at the version the caller saw. */
export function useRevokeJobQueueTeamTriage(scope: QueueScopeSignature) {
  return useQueueWrite(
    scope,
    async (
      { opportunityId, teamId, ...body }: Body<JobQueueTeamTriageRevokeRequest> & {
        opportunityId: string
        teamId: string
      },
      idempotencyKey,
    ) => {
      const res = await api.delete<unknown>(`/job-queue/${opportunityId}/team-triage/${teamId}`, {
        data: { ...body, idempotencyKey },
      })
      return jobQueueTeamTriageGrantSchema.parse(res.data)
    },
    card,
  )
}

/** ADMIN: a standing triage subscription for a team. */
export function useSubscribeJobQueueTeamTriage(scope: QueueScopeSignature) {
  return useQueueWrite(
    scope,
    async (body: Omit<JobQueueTeamTriageSubscribeRequest, 'idempotencyKey'>, idempotencyKey) => {
      const res = await api.post<unknown>('/job-queue/team-triage-subscriptions', {
        ...body,
        idempotencyKey,
      })
      return jobQueueTeamTriageSubscriptionSchema.parse(res.data)
    },
  )
}

/** ADMIN: revokes a subscription at the version the caller saw. */
export function useUnsubscribeJobQueueTeamTriage(scope: QueueScopeSignature) {
  return useQueueWrite(
    scope,
    async (
      { subscriptionId, ...body }: Omit<JobQueueTeamTriageUnsubscribeRequest, 'idempotencyKey'> & {
        subscriptionId: string
      },
      idempotencyKey,
    ) => {
      const res = await api.delete<unknown>(`/job-queue/team-triage-subscriptions/${subscriptionId}`, {
        data: { ...body, idempotencyKey },
      })
      return jobQueueTeamTriageSubscriptionSchema.parse(res.data)
    },
  )
}
