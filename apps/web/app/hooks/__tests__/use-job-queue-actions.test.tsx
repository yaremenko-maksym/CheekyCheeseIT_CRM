import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'

const post = vi.fn()
const del = vi.fn()
vi.mock('@/lib/axios', () => ({
  api: {
    post: (...args: unknown[]) => post(...args),
    delete: (...args: unknown[]) => del(...args),
  },
}))

const {
  getJobQueuePossibleDuplicateConflict,
  jobQueueCardQueryKey,
  jobQueueQueryKey,
  useCancelJobQueueSubmission,
  useCreateManualJobQueueCard,
  useDismissJobQueueItem,
  useGrantJobQueueTeamTriage,
  useMarkJobOpened,
  useRecomputeJobQueue,
  useRevokeJobQueueTeamTriage,
  useSubmitJobQueueSenior,
  useSubscribeJobQueueTeamTriage,
  useSuppressJobQueueItem,
  useUndoJobQueueDismissal,
  useUnsubscribeJobQueueTeamTriage,
} = await import('../use-job-queue')

/**
 * r5 Task 7.1 — the queue's write hooks against a mocked `api`: the exact route and body each one
 * sends, the parsed answer, the idempotency key's life and what each settle refreshes.
 */

const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TEAM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const OTHER_TEAM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const OPP = '11111111-1111-4111-8111-111111111111'
const SRC = '22222222-2222-4222-8222-222222222222'
const SENIOR = '33333333-3333-4333-8333-333333333333'
const SUBMISSION = '44444444-4444-4444-8444-444444444444'
const RESUME = '55555555-5555-4555-8555-555555555555'
const GRANT = '66666666-6666-4666-8666-666666666666'
const SUBSCRIPTION = '77777777-7777-4777-8777-777777777777'
const RUN = '88888888-8888-4888-8888-888888888888'
const DUP = '99999999-9999-4999-8999-999999999999'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const scope = { actorId: ACTOR, role: 'HR' as const, teamId: TEAM }
const studio = { actorId: ACTOR, role: 'ADMIN' as const, teamId: null }

const submission = {
  id: SUBMISSION,
  opportunityId: OPP,
  seniorId: SENIOR,
  state: 'TAKEN',
  submittedAt: '2026-10-03T00:00:00.000Z',
  cancelledAt: null,
  version: 1,
  submittedByName: 'Olena',
}
const dismissal = { opportunityId: OPP, scope: 'TEAM', reason: 'SPAM', hidden: true, version: 2 }
const grant = {
  id: GRANT,
  opportunityId: OPP,
  teamId: TEAM,
  assignedBy: ACTOR,
  policyVersion: 1,
  opportunityRevision: 3,
  grantVersion: 1,
  evidence: {},
  expiresAt: '2026-12-01T00:00:00.000Z',
  revokedAt: null,
  createdAt: '2026-10-03T00:00:00.000Z',
}
const subscription = {
  id: SUBSCRIPTION,
  teamId: TEAM,
  roleFamily: 'SOFTWARE',
  sourceTypes: [],
  policyVersion: 1,
  subscriptionVersion: 1,
  expiresAt: '2026-12-01T00:00:00.000Z',
  revokedAt: null,
  createdAt: '2026-10-03T00:00:00.000Z',
}

const httpError = (status: number, data: unknown) => ({
  isAxiosError: true,
  response: { status, data },
})
const coded = (status: number, code: string) =>
  httpError(status, { statusCode: status, code, message: code })
const lostResponse = { isAxiosError: true, message: 'Network Error' }

let client: QueryClient
function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const keyOf = (call: unknown[] | undefined) =>
  (call?.[1] as { idempotencyKey?: string } | undefined)?.idempotencyKey

beforeEach(() => {
  post.mockReset()
  del.mockReset()
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
})

describe('useSubmitJobQueueSenior', () => {
  const vars = { opportunityId: OPP, seniorId: SENIOR, expectedOpportunityRevision: 3 }

  it('posts one senior with the scope, the expected revision and a fresh idempotency key', async () => {
    post.mockResolvedValueOnce({ data: { submission } })
    const { result } = renderHook(() => useSubmitJobQueueSenior(scope), { wrapper })

    const answer = await act(() => result.current.mutateAsync(vars))

    expect(post).toHaveBeenCalledWith(`/job-queue/${OPP}/submissions`, {
      teamId: TEAM,
      seniorId: SENIOR,
      expectedOpportunityRevision: 3,
      idempotencyKey: expect.stringMatching(UUID),
    })
    expect(answer.submission.submittedByName).toBe('Olena')
  })

  it('refreshes the whole scope after an answer', async () => {
    client.setQueryData(jobQueueQueryKey(scope, 'NEW', {}), { pages: [], pageParams: [] })
    client.setQueryData(jobQueueCardQueryKey(scope, OPP), { title: 'x' })
    client.setQueryData(jobQueueCardQueryKey({ ...scope, teamId: OTHER_TEAM }, OPP), { title: 'y' })
    post.mockResolvedValueOnce({ data: { submission } })
    const { result } = renderHook(() => useSubmitJobQueueSenior(scope), { wrapper })

    await act(() => result.current.mutateAsync(vars))

    expect(client.getQueryState(jobQueueQueryKey(scope, 'NEW', {}))?.isInvalidated).toBe(true)
    expect(client.getQueryState(jobQueueCardQueryKey(scope, OPP))?.isInvalidated).toBe(true)
    expect(
      client.getQueryState(jobQueueCardQueryKey({ ...scope, teamId: OTHER_TEAM }, OPP))
        ?.isInvalidated,
    ).toBe(false)
  })

  it('replays the same key after a lost response, and the retry receives the earlier success', async () => {
    post.mockRejectedValueOnce(lostResponse).mockResolvedValueOnce({ data: { submission } })
    const { result } = renderHook(() => useSubmitJobQueueSenior(scope), { wrapper })

    await act(() => result.current.mutateAsync(vars).catch(() => undefined))
    const answer = await act(() => result.current.mutateAsync(vars))

    expect(keyOf(post.mock.calls[1])).toBe(keyOf(post.mock.calls[0]))
    expect(answer.submission.id).toBe(SUBMISSION)
  })

  it.each([500, 504, 408, 429])(
    'replays the same key after a %i (the write may have landed)',
    async (status) => {
      post
        .mockRejectedValueOnce(coded(status, 'TRANSIENT'))
        .mockResolvedValueOnce({ data: { submission } })
      const { result } = renderHook(() => useSubmitJobQueueSenior(scope), { wrapper })

      await act(() => result.current.mutateAsync(vars).catch(() => undefined))
      await act(() => result.current.mutateAsync(vars))

      expect(keyOf(post.mock.calls[1])).toBe(keyOf(post.mock.calls[0]))
    },
  )

  it.each([400, 409, 499])('takes a new key after a %i (a definitive refusal)', async (status) => {
    post
      .mockRejectedValueOnce(coded(status, 'REFUSED'))
      .mockResolvedValueOnce({ data: { submission } })
    const { result } = renderHook(() => useSubmitJobQueueSenior(scope), { wrapper })

    await act(() => result.current.mutateAsync(vars).catch(() => undefined))
    await act(() => result.current.mutateAsync(vars))

    expect(keyOf(post.mock.calls[1])).not.toBe(keyOf(post.mock.calls[0]))
  })

  it('takes a new key for the same variables under another team, and keeps it per team', async () => {
    post
      .mockRejectedValueOnce(coded(500, 'TRANSIENT'))
      .mockRejectedValueOnce(coded(500, 'TRANSIENT'))
      .mockResolvedValueOnce({ data: { submission } })
    const { result, rerender } = renderHook(({ s }) => useSubmitJobQueueSenior(s), {
      wrapper,
      initialProps: { s: scope },
    })

    await act(() => result.current.mutateAsync(vars).catch(() => undefined))
    rerender({ s: { ...scope, teamId: OTHER_TEAM } })
    await act(() => result.current.mutateAsync(vars).catch(() => undefined))
    rerender({ s: scope })
    await act(() => result.current.mutateAsync(vars))

    expect(post).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({ teamId: TEAM }),
    )
    expect(post).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ teamId: OTHER_TEAM }),
    )
    expect(keyOf(post.mock.calls[1])).not.toBe(keyOf(post.mock.calls[0]))
    expect(keyOf(post.mock.calls[2])).toBe(keyOf(post.mock.calls[0]))
  })

  it('takes a new key for other variables, even while a pending key is kept', async () => {
    post
      .mockRejectedValueOnce(coded(500, 'TRANSIENT'))
      .mockResolvedValueOnce({ data: { submission } })
    const { result } = renderHook(() => useSubmitJobQueueSenior(scope), { wrapper })

    await act(() => result.current.mutateAsync(vars).catch(() => undefined))
    await act(() => result.current.mutateAsync({ ...vars, expectedOpportunityRevision: 4 }))

    expect(post).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ expectedOpportunityRevision: 4 }),
    )
    expect(keyOf(post.mock.calls[1])).not.toBe(keyOf(post.mock.calls[0]))
  })

  it('drops the key of the scope the write started under when the team switches mid-flight', async () => {
    let refuse: (reason: unknown) => void = () => {}
    post
      .mockRejectedValueOnce(coded(500, 'TRANSIENT'))
      .mockReturnValueOnce(new Promise((_, reject) => (refuse = reject)))
      .mockResolvedValueOnce({ data: { submission } })
    const { result, rerender } = renderHook(({ s }) => useSubmitJobQueueSenior(s), {
      wrapper,
      initialProps: { s: scope },
    })

    await act(() => result.current.mutateAsync(vars).catch(() => undefined))
    let inFlight: Promise<unknown> = Promise.resolve()
    act(() => {
      inFlight = result.current.mutateAsync(vars).catch(() => undefined)
    })
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    rerender({ s: { ...scope, teamId: OTHER_TEAM } })
    await act(async () => {
      refuse(coded(409, 'JOB_QUEUE_REVISION_CONFLICT'))
      await inFlight
    })
    rerender({ s: scope })
    await act(() => result.current.mutateAsync(vars))

    expect(keyOf(post.mock.calls[1])).toBe(keyOf(post.mock.calls[0]))
    expect(keyOf(post.mock.calls[2])).not.toBe(keyOf(post.mock.calls[0]))
  })

  it('encodes the ids into the path', async () => {
    post.mockResolvedValueOnce({ data: { submission } })
    const { result } = renderHook(() => useCancelJobQueueSubmission(scope), { wrapper })
    await act(() =>
      result.current.mutateAsync({
        opportunityId: 'a/b',
        submissionId: '../x',
        expectedVersion: 1,
      }),
    )
    expect(post.mock.calls[0]?.[0]).toBe('/job-queue/a%2Fb/submissions/..%2Fx/cancel')
  })

  it('takes a new key once the server answered, and for a different intent', async () => {
    post
      .mockResolvedValueOnce({ data: { submission } })
      .mockResolvedValueOnce({ data: { submission } })
      .mockRejectedValueOnce(coded(409, 'JOB_QUEUE_VERSION_CONFLICT'))
      .mockResolvedValueOnce({ data: { submission } })
    const { result } = renderHook(() => useSubmitJobQueueSenior(scope), { wrapper })

    await act(() => result.current.mutateAsync(vars))
    await act(() => result.current.mutateAsync({ ...vars, seniorId: SUBMISSION }))
    await act(() => result.current.mutateAsync(vars).catch(() => undefined))
    await act(() => result.current.mutateAsync(vars))

    const keys = post.mock.calls.map(keyOf)
    expect(new Set(keys).size).toBe(4)
  })

  it('exposes a possible-duplicate 409 so the caller can confirm, then confirms with a new key', async () => {
    const conflict = {
      code: 'JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED',
      possibleDuplicates: {
        items: [{ opportunityId: DUP, title: 'Same role', companyName: 'Acme' }],
        totalCount: 1,
      },
    }
    post
      .mockRejectedValueOnce(httpError(409, conflict))
      .mockResolvedValueOnce({ data: { submission } })
    const { result } = renderHook(() => useSubmitJobQueueSenior(scope), { wrapper })

    await act(() => result.current.mutateAsync(vars).catch(() => undefined))
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(getJobQueuePossibleDuplicateConflict(result.current.error)).toEqual(conflict)

    await act(() => result.current.mutateAsync({ ...vars, confirmPossibleDuplicate: true }))
    expect(post.mock.calls[1]?.[1]).toMatchObject({ confirmPossibleDuplicate: true })
    expect(keyOf(post.mock.calls[1])).not.toBe(keyOf(post.mock.calls[0]))
  })

  it('evicts the card on a 404 so no stale names stay, and refreshes the lists', async () => {
    client.setQueryData(jobQueueCardQueryKey(scope, OPP), { title: 'x' })
    client.setQueryData(jobQueueQueryKey(scope, 'NEW', {}), { pages: [], pageParams: [] })
    post.mockRejectedValueOnce(coded(404, 'JOB_OPPORTUNITY_NOT_FOUND'))
    const { result } = renderHook(() => useSubmitJobQueueSenior(scope), { wrapper })

    await act(() => result.current.mutateAsync(vars).catch(() => undefined))

    expect(client.getQueryData(jobQueueCardQueryKey(scope, OPP))).toBeUndefined()
    expect(client.getQueryState(jobQueueQueryKey(scope, 'NEW', {}))?.isInvalidated).toBe(true)
  })

  it('settles a 404 against the team the write started under, not the one switched to mid-flight', async () => {
    const teamCard = ['job-queue', ACTOR, 'HR', TEAM, 'card', OPP]
    const teamList = ['job-queue', ACTOR, 'HR', TEAM, 'list', 'NEW', {}]
    const otherCard = ['job-queue', ACTOR, 'HR', OTHER_TEAM, 'card', OPP]
    const otherList = ['job-queue', ACTOR, 'HR', OTHER_TEAM, 'list', 'NEW', {}]
    client.setQueryData(teamCard, { title: 'x' })
    client.setQueryData(teamList, { pages: [], pageParams: [] })
    client.setQueryData(otherCard, { title: 'y' })
    client.setQueryData(otherList, { pages: [], pageParams: [] })
    let refuse: (reason: unknown) => void = () => {}
    post.mockReturnValueOnce(new Promise((_, reject) => (refuse = reject)))
    const { result, rerender } = renderHook(({ s }) => useSubmitJobQueueSenior(s), {
      wrapper,
      initialProps: { s: scope },
    })

    let inFlight: Promise<unknown> = Promise.resolve()
    act(() => {
      inFlight = result.current.mutateAsync(vars).catch(() => undefined)
    })
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    rerender({ s: { ...scope, teamId: OTHER_TEAM } })
    await act(async () => {
      refuse(coded(404, 'JOB_OPPORTUNITY_NOT_FOUND'))
      await inFlight
    })

    expect(client.getQueryData(teamCard)).toBeUndefined()
    expect(client.getQueryState(teamList)?.isInvalidated).toBe(true)
    expect(client.getQueryData(otherCard)).toEqual({ title: 'y' })
    expect(client.getQueryState(otherCard)?.isInvalidated).toBe(false)
    expect(client.getQueryState(otherList)?.isInvalidated).toBe(false)
  })

  it('keeps the card on a version conflict (it is refetched, not dropped)', async () => {
    client.setQueryData(jobQueueCardQueryKey(scope, OPP), { title: 'x' })
    post.mockRejectedValueOnce(coded(409, 'JOB_QUEUE_VERSION_CONFLICT'))
    const { result } = renderHook(() => useSubmitJobQueueSenior(scope), { wrapper })

    await act(() => result.current.mutateAsync(vars).catch(() => undefined))

    expect(client.getQueryData(jobQueueCardQueryKey(scope, OPP))).toEqual({ title: 'x' })
    expect(client.getQueryState(jobQueueCardQueryKey(scope, OPP))?.isInvalidated).toBe(true)
  })

  it('refuses an answer outside the contract with a ZodError', async () => {
    post.mockResolvedValueOnce({ data: { submission: { ...submission, teamName: 'Other' } } })
    const { result } = renderHook(() => useSubmitJobQueueSenior(scope), { wrapper })
    await expect(act(() => result.current.mutateAsync(vars))).rejects.toBeInstanceOf(ZodError)
  })
})

describe('the other card writes', () => {
  it('cancel posts the submission version to its own route', async () => {
    post.mockResolvedValueOnce({ data: { submission } })
    const { result } = renderHook(() => useCancelJobQueueSubmission(scope), { wrapper })
    const answer = await act(() =>
      result.current.mutateAsync({
        opportunityId: OPP,
        submissionId: SUBMISSION,
        expectedVersion: 1,
      }),
    )
    expect(post).toHaveBeenCalledWith(`/job-queue/${OPP}/submissions/${SUBMISSION}/cancel`, {
      teamId: TEAM,
      expectedVersion: 1,
      idempotencyKey: expect.stringMatching(UUID),
    })
    expect(answer.submission.id).toBe(SUBMISSION)
  })

  it('dismiss posts the scope and the reason', async () => {
    post.mockResolvedValueOnce({ data: dismissal })
    const { result } = renderHook(() => useDismissJobQueueItem(scope), { wrapper })
    const answer = await act(() =>
      result.current.mutateAsync({ opportunityId: OPP, scope: 'TEAM', reason: 'SPAM' }),
    )
    expect(post).toHaveBeenCalledWith(`/job-queue/${OPP}/dismiss`, {
      teamId: TEAM,
      scope: 'TEAM',
      reason: 'SPAM',
      idempotencyKey: expect.stringMatching(UUID),
    })
    expect(answer.version).toBe(2)
  })

  it('undo posts the dismissal version in the same scope', async () => {
    post.mockResolvedValueOnce({ data: { ...dismissal, hidden: false, version: 3 } })
    const { result } = renderHook(() => useUndoJobQueueDismissal(scope), { wrapper })
    const answer = await act(() =>
      result.current.mutateAsync({ opportunityId: OPP, scope: 'TEAM', expectedVersion: 2 }),
    )
    expect(post).toHaveBeenCalledWith(`/job-queue/${OPP}/undo`, {
      teamId: TEAM,
      scope: 'TEAM',
      expectedVersion: 2,
      idempotencyKey: expect.stringMatching(UUID),
    })
    expect(answer.hidden).toBe(false)
  })

  it('CR-M-1: a dismissal version is kept per vacancy, not shared', async () => {
    const OTHER_OPP = '12121212-1212-4121-8121-121212121212'
    post.mockResolvedValueOnce({ data: dismissal })
    const { result } = renderHook(() => useDismissJobQueueItem(scope), { wrapper })
    await act(() =>
      result.current.mutateAsync({ opportunityId: OPP, scope: 'TEAM', reason: 'SPAM' }),
    )
    post.mockResolvedValueOnce({ data: { ...dismissal, opportunityId: OTHER_OPP, version: 1 } })
    await act(() =>
      result.current.mutateAsync({ opportunityId: OTHER_OPP, scope: 'TEAM', reason: 'SPAM' }),
    )
    expect(post.mock.calls[1]?.[1]).not.toHaveProperty('expectedVersion')
    post.mockResolvedValueOnce({ data: { ...dismissal, version: 3 } })
    await act(() =>
      result.current.mutateAsync({ opportunityId: OPP, scope: 'TEAM', reason: 'SPAM' }),
    )
    expect(post.mock.calls[2]?.[1]).toMatchObject({ expectedVersion: 2 })
  })

  it('the studio scope sends no teamId', async () => {
    post.mockResolvedValueOnce({ data: { ...dismissal, scope: 'STUDIO' } })
    const { result } = renderHook(() => useDismissJobQueueItem(studio), { wrapper })
    await act(() =>
      result.current.mutateAsync({ opportunityId: OPP, scope: 'STUDIO', reason: 'DEAD_LINK' }),
    )
    expect(post.mock.calls[0]?.[1]).not.toHaveProperty('teamId')
  })

  it('suppress (ADMIN) posts only the key', async () => {
    post.mockResolvedValueOnce({ data: undefined })
    const { result } = renderHook(() => useSuppressJobQueueItem(studio), { wrapper })
    await act(() => result.current.mutateAsync({ opportunityId: OPP }))
    expect(post).toHaveBeenCalledWith(`/job-queue/${OPP}/suppress`, {
      idempotencyKey: expect.stringMatching(UUID),
    })
  })
})

describe('useMarkJobOpened', () => {
  it('posts the source and returns at once', () => {
    post.mockResolvedValueOnce({ data: undefined })
    const { result } = renderHook(() => useMarkJobOpened(scope), { wrapper })
    expect(result.current(OPP, SRC)).toBeUndefined()
    expect(post).toHaveBeenCalledWith(`/job-queue/${OPP}/opened`, {
      teamId: TEAM,
      sourceRecordId: SRC,
    })
  })

  it('keeps one function across renders and takes a new one for another team', () => {
    post.mockResolvedValue({ data: undefined })
    const { result, rerender } = renderHook(({ s }) => useMarkJobOpened(s), {
      wrapper,
      initialProps: { s: scope },
    })
    const first = result.current
    rerender({ s: { ...scope } })
    expect(result.current).toBe(first)
    rerender({ s: { ...scope, teamId: OTHER_TEAM } })
    expect(result.current).not.toBe(first)
    result.current(OPP, SRC)
    expect(post).toHaveBeenCalledWith(`/job-queue/${OPP}/opened`, {
      teamId: OTHER_TEAM,
      sourceRecordId: SRC,
    })
  })

  it('never throws and never rejects unhandled', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    post.mockRejectedValueOnce(coded(503, 'JOB_QUEUE_POLICY_UNAVAILABLE'))
    const { result } = renderHook(() => useMarkJobOpened(studio), { wrapper })
    expect(() => result.current(OPP, SRC)).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith(`/job-queue/${OPP}/opened`, { sourceRecordId: SRC })
  })
})

describe('manual card and the ADMIN writes', () => {
  it('manual card posts the vacancy with its first submission', async () => {
    post.mockResolvedValueOnce({ data: { submission } })
    const { result } = renderHook(() => useCreateManualJobQueueCard(scope), { wrapper })
    const body = {
      title: 'Go developer',
      companyName: 'Acme',
      descriptionMd: 'Go',
      submission: { teamId: TEAM, seniorId: SENIOR, resumeId: RESUME },
    }
    const answer = await act(() => result.current.mutateAsync(body))
    expect(post).toHaveBeenCalledWith('/job-queue/manual', {
      ...body,
      idempotencyKey: expect.stringMatching(UUID),
    })
    expect(answer.submission.opportunityId).toBe(OPP)
  })

  it('recompute posts with no body and returns the run id', async () => {
    post.mockResolvedValueOnce({ data: { runId: RUN } })
    const { result } = renderHook(() => useRecomputeJobQueue(studio), { wrapper })
    const answer = await act(() => result.current.mutateAsync())
    expect(post).toHaveBeenCalledWith('/job-queue/recompute')
    expect(answer.runId).toBe(RUN)
  })

  it('grant posts the team, the expected revision and the policy version', async () => {
    post.mockResolvedValueOnce({ data: grant })
    const { result } = renderHook(() => useGrantJobQueueTeamTriage(studio), { wrapper })
    const body = {
      teamId: TEAM,
      expectedOpportunityRevision: 3,
      policyVersion: 1,
      reason: 'Needs review',
      expiresAt: '2026-12-01T00:00:00.000Z',
    }
    const answer = await act(() => result.current.mutateAsync({ opportunityId: OPP, ...body }))
    expect(post).toHaveBeenCalledWith(`/job-queue/${OPP}/team-triage`, {
      ...body,
      idempotencyKey: expect.stringMatching(UUID),
    })
    expect(answer.grantVersion).toBe(1)
  })

  it('revoke deletes the team grant at the version seen', async () => {
    del.mockResolvedValueOnce({ data: { ...grant, revokedAt: '2026-10-04T00:00:00.000Z' } })
    const { result } = renderHook(() => useRevokeJobQueueTeamTriage(studio), { wrapper })
    const answer = await act(() =>
      result.current.mutateAsync({
        opportunityId: OPP,
        teamId: TEAM,
        expectedGrantVersion: 1,
        reason: 'Done',
      }),
    )
    expect(del).toHaveBeenCalledWith(`/job-queue/${OPP}/team-triage/${TEAM}`, {
      data: {
        expectedGrantVersion: 1,
        reason: 'Done',
        idempotencyKey: expect.stringMatching(UUID),
      },
    })
    expect(answer.revokedAt).toBe('2026-10-04T00:00:00.000Z')
  })

  it('subscribe posts the standing subscription', async () => {
    post.mockResolvedValueOnce({ data: subscription })
    const { result } = renderHook(() => useSubscribeJobQueueTeamTriage(studio), { wrapper })
    const body = {
      teamId: TEAM,
      roleFamily: 'SOFTWARE' as const,
      sourceTypes: [],
      policyVersion: 1,
      expiresAt: '2026-12-01T00:00:00.000Z',
      reason: 'Weekly triage',
    }
    const answer = await act(() => result.current.mutateAsync(body))
    expect(post).toHaveBeenCalledWith('/job-queue/team-triage-subscriptions', {
      ...body,
      idempotencyKey: expect.stringMatching(UUID),
    })
    expect(answer.subscriptionVersion).toBe(1)
  })

  it('unsubscribe deletes the subscription at the version seen', async () => {
    del.mockResolvedValueOnce({ data: { ...subscription, revokedAt: '2026-10-04T00:00:00.000Z' } })
    const { result } = renderHook(() => useUnsubscribeJobQueueTeamTriage(studio), { wrapper })
    const answer = await act(() =>
      result.current.mutateAsync({
        subscriptionId: SUBSCRIPTION,
        expectedSubscriptionVersion: 1,
        reason: 'Stop',
      }),
    )
    expect(del).toHaveBeenCalledWith(`/job-queue/team-triage-subscriptions/${SUBSCRIPTION}`, {
      data: {
        expectedSubscriptionVersion: 1,
        reason: 'Stop',
        idempotencyKey: expect.stringMatching(UUID),
      },
    })
    expect(answer.revokedAt).toBe('2026-10-04T00:00:00.000Z')
  })
})

describe('getJobQueuePossibleDuplicateConflict', () => {
  it('is null for any other error, and for no error', () => {
    expect(
      getJobQueuePossibleDuplicateConflict(coded(409, 'JOB_QUEUE_VERSION_CONFLICT')),
    ).toBeNull()
    expect(getJobQueuePossibleDuplicateConflict(new Error('boom'))).toBeNull()
    expect(getJobQueuePossibleDuplicateConflict(null)).toBeNull()
  })
})
