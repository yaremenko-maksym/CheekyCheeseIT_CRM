import { useCallback, useEffect, useRef } from 'react'
import {
  skipToken,
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
  jobQueueSeniorOptionsResponseSchema,
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
 * clears the whole client (`apps/web/app/lib/use-logout.ts`); a scope change evicts the other scopes
 * (`useJobQueue`); a read answered 403/404 drops the scope's cached data (`useAccessLost`).
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
  Pick<
    JobQueueListQuery,
    'search' | 'source' | 'eligibility' | 'availability' | 'activity' | 'seniorIds'
  >
>

export const JOB_QUEUE_PAGE_LIMIT = 20

export const jobQueueScopeKey = (scope: QueueScopeSignature) =>
  ['job-queue', scope.actorId, scope.role, scope.teamId ?? 'default'] as const

/** One spelling of a senior set: lower-cased, de-duplicated, sorted (URL, picker and cache agree). */
export const canonicalSeniorIds = (ids: readonly string[]): string[] =>
  [...new Set(ids.map((id) => id.toLowerCase()))].sort()

export const jobQueueQueryKey = (
  scope: QueueScopeSignature,
  tab: JobQueueTab,
  filters: QueueFilters,
) =>
  [
    ...jobQueueScopeKey(scope),
    'list',
    tab,
    filters.seniorIds === undefined
      ? filters
      : { ...filters, seniorIds: canonicalSeniorIds(filters.seniorIds) },
  ] as const

export const jobQueueCardQueryKey = (scope: QueueScopeSignature, id: string | null) =>
  [...jobQueueScopeKey(scope), 'card', id] as const

/** Codes after which the list cannot continue and must restart from its first page. */
const REFRESH_CODES = new Set<string | null>([
  'JOB_QUEUE_REFRESH_REQUIRED',
  'JOB_QUEUE_CURSOR_MALFORMED',
])

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

/** A path segment from an id: never lets a value change the route. */
const seg = encodeURIComponent

/**
 * A read answered 403 or 404: the actor lost access (missing and unauthorized look alike by
 * design). Returns `true` so the caller hides its data, and drops every cached entry of the scope
 * that no screen is observing. Active entries (the caller's own among them) are left to their own
 * hooks: removing or invalidating them would refetch, hit 403 again and ping-pong between observers.
 */
function useAccessLost(scope: QueueScopeSignature, error: unknown) {
  const queryClient = useQueryClient()
  const lost = isAccessLoss(error)
  const { actorId, role, teamId } = scope

  useEffect(() => {
    if (!lost) return
    queryClient.removeQueries({
      queryKey: jobQueueScopeKey({ actorId, role, teamId }),
      predicate: (q) => !q.isActive(),
    })
  }, [lost, queryClient, actorId, role, teamId])

  return lost
}

/** A 403/404: the actor lost access (missing and unauthorized look alike by design). */
export const isAccessLoss = (error: unknown) => {
  const status = getAxiosStatus(error)
  return status === 403 || status === 404
}

/**
 * QA-LOW-6: a card read answered 403/404 is final, so it closes at once instead of asking again;
 * every other error keeps the client's default retry.
 */
function useRetryUnlessAccessLost() {
  const fallback = useQueryClient().getDefaultOptions().queries?.retry ?? 3
  return (failureCount: number, error: unknown): boolean => {
    if (isAccessLoss(error)) return false
    if (typeof fallback === 'function') return fallback(failureCount, error as Error)
    return typeof fallback === 'number' ? failureCount < fallback : fallback
  }
}

/**
 * A card read (the card or one of its continuations) lost access: refresh the scope's lists, so the
 * vacancy leaves them. Not for the list itself — refreshing its own 403 would loop. When the lost
 * card closes, its entry and its continuations are forgotten: browser Back or a second click must
 * ask the server again instead of repainting the names from cache. Removing them while the card is
 * still open would refetch under its live observer, so this waits for the unmount.
 */
function useRefreshListsOnLoss(scope: QueueScopeSignature, id: string | null, lost: boolean) {
  const queryClient = useQueryClient()
  const { actorId, role, teamId } = scope

  useEffect(() => {
    if (!lost) return
    const scopeKey = jobQueueScopeKey({ actorId, role, teamId })
    void queryClient.invalidateQueries({ queryKey: [...scopeKey, 'list'] })
    return () => queryClient.removeQueries({ queryKey: [...scopeKey, 'card', id] })
  }, [lost, queryClient, actorId, role, teamId, id])
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
  const accessLost = useAccessLost(scope, query.error)

  return {
    ...query,
    data: accessLost ? undefined : query.data,
    accessLost,
    /** The generation behind the cursor is gone: offer «Показати оновлений список». */
    refreshRequired: REFRESH_CODES.has(getApiErrorCode(query.error)),
    /** Replaces the list with a fresh first page (no stale pages kept). */
    restart: () => queryClient.resetQueries({ queryKey, exact: true }),
  }
}

/**
 * One card. `accessLost` (403/404) hides the last data so no stale name stays on screen, drops the
 * card's cached continuations (`useAccessLost`) and refreshes the scope's lists.
 */
export function useJobQueueCard(scope: QueueScopeSignature, id: string | null) {
  const query = useQuery({
    queryKey: jobQueueCardQueryKey(scope, id),
    retry: useRetryUnlessAccessLost(),
    // QA-LOW-1: not kept once the card closes, so a reopen never paints names (personal data)
    // the server has not just confirmed for the current scope; it loads afresh
    gcTime: 0,
    queryFn:
      id === null
        ? skipToken
        : async () => {
            const res = await api.get<unknown>(`/job-queue/${seg(id)}`, {
              params: teamParam(scope),
            })
            return jobQueueCardResponseSchema.parse(res.data)
          },
  })
  const accessLost = useAccessLost(scope, query.error)
  useRefreshListsOnLoss(scope, id, accessLost)
  return { ...query, data: accessLost ? undefined : query.data, accessLost }
}

/**
 * The continuation of a card preview (seniors past 200, sources past 20), from the preview's own
 * `nextCursor`; disabled while that cursor is `null`. `totalCount` is the server's denominator.
 * A 403/404 here is the card's loss too: the lists are refreshed the same way.
 */
function useContinuation<T extends { nextCursor: string | null }>(
  scope: QueueScopeSignature,
  id: string | null,
  cursor: string | null,
  part: 'seniors' | 'sources',
  parse: (data: unknown) => T,
) {
  const query = useInfiniteQuery({
    queryKey: [...jobQueueCardQueryKey(scope, id), part, cursor],
    retry: useRetryUnlessAccessLost(),
    // forgotten with the card (QA-LOW-1)
    gcTime: 0,
    initialPageParam: cursor,
    queryFn:
      id === null || cursor === null
        ? skipToken
        : async ({ pageParam }) => {
            const res = await api.get<unknown>(`/job-queue/${seg(id)}/${part}`, {
              params: { ...teamParam(scope), cursor: pageParam },
            })
            return parse(res.data)
          },
    getNextPageParam: (last) => last.nextCursor,
  })
  const accessLost = useAccessLost(scope, query.error)
  useRefreshListsOnLoss(scope, id, accessLost)
  return { ...query, data: accessLost ? undefined : query.data, accessLost }
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

/** The list filter's picker: the seniors of the scope, cached under the scope's key. */
export function useJobQueueSeniorOptions(scope: QueueScopeSignature) {
  return useQuery({
    queryKey: [...jobQueueScopeKey(scope), 'senior-options'],
    queryFn: async () => {
      const res = await api.get<unknown>('/job-queue/seniors', { params: teamParam(scope) })
      return jobQueueSeniorOptionsResponseSchema.parse(res.data)
    },
  })
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
 * Whether the server's answer settles the intent. 2xx and 4xx do (a retry must be a NEW attempt);
 * 5xx, 408, 429 and no response do not: the write may have landed, so the retry replays the key.
 */
function isDefinitiveAnswer(error: unknown) {
  if (error === null) return true
  // No response at all is as unsettled as a 5xx.
  const status = getAxiosStatus(error) ?? 500
  return status < 500 && status !== 408 && status !== 429
}

/**
 * Every queue write. The idempotency key belongs to the INTENT (the variables): it is kept while
 * an attempt got no definitive answer (the retry must replay the same key and receive the earlier
 * outcome), and dropped once it did. Settling always refreshes the scope; a 404 also evicts that
 * card so a revoked one cannot show its last data.
 */
function useQueueWrite<V, R>(
  scope: QueueScopeSignature,
  send: (vars: V, idempotencyKey: string) => Promise<R>,
  cardId?: (vars: V) => string,
) {
  const queryClient = useQueryClient()
  // Held in a ref: the pending keys are lost on unmount, so a retry from a remounted screen is a new attempt.
  const keys = useRef(new Map<string, string>())

  // The intent includes the scope: the same variables under another team are another write.
  const intentOf = (vars: V) => JSON.stringify([scope.actorId, scope.role, scope.teamId, vars])

  return useMutation<R, unknown, V, { intent: string; scope: QueueScopeSignature }>({
    // Captured at the start: the scope may change while the write is in flight.
    onMutate: (vars) => ({ intent: intentOf(vars), scope }),
    mutationFn: (vars) => {
      const intent = intentOf(vars)
      const key = keys.current.get(intent) ?? crypto.randomUUID()
      keys.current.set(intent, key)
      return send(vars, key)
    },
    onSettled: (_data, error, vars, context) => {
      // `context` is undefined only when onMutate throws, and JSON.stringify of plain variables does not.
      const started = context!
      if (isDefinitiveAnswer(error)) keys.current.delete(started.intent)
      if (cardId && getApiErrorCode(error) === 'JOB_OPPORTUNITY_NOT_FOUND') {
        queryClient.removeQueries({ queryKey: jobQueueCardQueryKey(started.scope, cardId(vars)) })
      }
      void queryClient.invalidateQueries({ queryKey: jobQueueScopeKey(started.scope) })
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
      const res = await api.post<unknown>(`/job-queue/${seg(opportunityId)}/submissions`, {
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
        `/job-queue/${seg(opportunityId)}/submissions/${seg(submissionId)}/cancel`,
        { ...teamParam(scope), ...body, idempotencyKey },
      )
      return jobQueueSubmissionResponseSchema.parse(res.data)
    },
    card,
  )
}

/**
 * The latest dismissal version per actor scope, vacancy and dismissal scope. The API refuses an
 * unversioned re-dismiss of an existing row, and a hide closes the card, so the version must
 * outlive the menu that got it. One map per QueryClient: it goes with the client, as the cache does.
 * A reload forgets it; the caller then sends the card's own `dismissal` version (7.3b). This
 * session's later write, when there is one, is fresher than the card the menu was opened from.
 */
const dismissalVersions = new WeakMap<QueryClient, Map<string, number>>()

function useDismissalVersions(scope: QueueScopeSignature) {
  const queryClient = useQueryClient()
  let versions = dismissalVersions.get(queryClient)
  if (!versions) {
    versions = new Map()
    dismissalVersions.set(queryClient, versions)
  }
  const store = versions
  const keyOf = (opportunityId: string, kind: string) =>
    JSON.stringify([...jobQueueScopeKey(scope), opportunityId, kind])
  return {
    get: (opportunityId: string, kind: string) => store.get(keyOf(opportunityId, kind)),
    set: (res: { opportunityId: string; scope: string; version: number }) =>
      store.set(keyOf(res.opportunityId, res.scope), res.version),
  }
}

/**
 * «Приховати» in the TEAM or (ADMIN) STUDIO scope; a re-dismiss sends the newest version known: this
 * session's own or the `expectedVersion` the caller read off the card, whichever is higher (a
 * teammate's hide and undo since this session's own leave the card ahead). Versions only grow.
 */
export function useDismissJobQueueItem(scope: QueueScopeSignature) {
  const versions = useDismissalVersions(scope)
  return useQueueWrite(
    scope,
    async ({ opportunityId, ...body }: OnCard<JobQueueDismissRequestDto>, idempotencyKey) => {
      const known = [versions.get(opportunityId, body.scope), body.expectedVersion].filter(
        (v) => v !== undefined,
      )
      const expectedVersion = known.length === 0 ? undefined : Math.max(...known)
      const res = await api.post<unknown>(`/job-queue/${seg(opportunityId)}/dismiss`, {
        ...teamParam(scope),
        ...body,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
        idempotencyKey,
      })
      const dismissal = jobQueueDismissalResponseSchema.parse(res.data)
      versions.set(dismissal)
      return dismissal
    },
    card,
  )
}

export function useUndoJobQueueDismissal(scope: QueueScopeSignature) {
  const versions = useDismissalVersions(scope)
  return useQueueWrite(
    scope,
    async ({ opportunityId, ...body }: OnCard<JobQueueUndoRequestDto>, idempotencyKey) => {
      const res = await api.post<unknown>(`/job-queue/${seg(opportunityId)}/undo`, {
        ...teamParam(scope),
        ...body,
        idempotencyKey,
      })
      const restored = jobQueueDismissalResponseSchema.parse(res.data)
      versions.set(restored)
      return restored
    },
    card,
  )
}

/**
 * Click telemetry. Fire-and-forget: it never throws and never delays the caller, who opens the
 * posting synchronously inside the gesture (`openOriginalPosting`).
 */
export function useMarkJobOpened(scope: QueueScopeSignature) {
  const { teamId } = scope
  return useCallback(
    (opportunityId: string, sourceRecordId: string): void => {
      api
        .post(`/job-queue/${seg(opportunityId)}/opened`, {
          ...(teamId === null ? {} : { teamId }),
          sourceRecordId,
        })
        .catch(() => {})
    },
    [teamId],
  )
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
      await api.post(`/job-queue/${seg(opportunityId)}/suppress`, { idempotencyKey })
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
      const res = await api.post<unknown>(`/job-queue/${seg(opportunityId)}/team-triage`, {
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
      const res = await api.delete<unknown>(`/job-queue/${seg(opportunityId)}/team-triage/${seg(teamId)}`, {
        data: { ...body, idempotencyKey },
      })
      return jobQueueTeamTriageGrantSchema.parse(res.data)
    },
    card,
  )
}

/**
 * ADMIN: a standing triage subscription for a team. `policyVersion` is the studio triage policy
 * version any ADMIN card carries (`triagePolicyVersion`); a stale one is a 409 (SR-M-1).
 */
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
      const res = await api.delete<unknown>(`/job-queue/team-triage-subscriptions/${seg(subscriptionId)}`, {
        data: { ...body, idempotencyKey },
      })
      return jobQueueTeamTriageSubscriptionSchema.parse(res.data)
    },
  )
}
