import { ParseUUIDPipe, RequestMethod } from '@nestjs/common'
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants'
import type { SessionUser } from '@crm/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import { ROLES_KEY } from '../../common/decorators/roles.decorator'
import { RolesGuard } from '../../common/guards/roles.guard'
import { JobQueueController } from './job-queue.controller'
import type { JobQueueService } from './job-queue.service'
import type { JobQueueActionsService } from './queue-actions.service'

/**
 * r5 Task 6.4 — unit doubles for the `/job-queue` controller (the mutation gate never runs the
 * integration specs). The guard chain over a real database is job-queue-rbac.integration.spec.ts.
 * Expected values are literals: the plan's table and this task's throttle decisions.
 */
const HR = { id: 'h', role: 'HR' } as SessionUser
const OPP = '11111111-2222-4333-8444-555555555555'
const SUB = '66666666-7777-4888-9999-aaaaaaaaaaaa'
const KEY = '77777777-8888-4999-8aaa-bbbbbbbbbbbb'
const SENIOR = '88888888-9999-4aaa-8bbb-cccccccccccc'
const TEAM = '99999999-aaaa-4bbb-8ccc-dddddddddddd'
const T = '2026-11-04T10:00:00.000Z'

const LIST = {
  items: [],
  nextCursor: null,
  counts: { NEW: 0, SUBMITTED: 0, HIDDEN: 0 },
  generation: null,
}
const PAGE = { items: [], totalCount: 0, nextCursor: null }
const CARD = {
  opportunityId: OPP,
  revision: 1,
  title: 't',
  companyName: null,
  location: null,
  primarySource: {
    sourceRecordId: SUB,
    sourceType: 'GREENHOUSE_ATS',
    url: 'https://jobs.example.test/1',
  },
  alsoSeenOnCount: 0,
  availability: 'OPEN',
  eligibility: 'LEAD',
  matchedSeniorCount: 0,
  submittedSeniorCount: 0,
  stopListedSeniorCount: 0,
  openedByTeam: false,
  hidden: false,
  publishedAt: null,
  firstSeenAt: T,
  descriptionMd: '',
  newerThanList: false,
  seniors: PAGE,
  sources: PAGE,
  possibleDuplicates: null,
}
const SUBMISSION = {
  submission: {
    id: SUB,
    opportunityId: OPP,
    seniorId: SENIOR,
    state: 'TAKEN',
    submittedAt: T,
    cancelledAt: null,
    version: 1,
    submittedByName: null,
  },
}
const DISMISSAL = { opportunityId: OPP, scope: 'TEAM', reason: 'SPAM', hidden: true, version: 1 }

function harness() {
  const queue = {
    list: vi.fn(async () => LIST),
    card: vi.fn(async () => CARD),
    sources: vi.fn(async () => PAGE),
    seniors: vi.fn(async () => PAGE),
  }
  const actions = {
    submit: vi.fn(async () => SUBMISSION),
    cancelSubmission: vi.fn(async () => SUBMISSION),
    dismiss: vi.fn(async () => DISMISSAL),
    undo: vi.fn(async () => ({ ...DISMISSAL, hidden: false, version: 2 })),
    opened: vi.fn(async () => undefined),
    suppress: vi.fn(async () => undefined),
  }
  return {
    controller: new JobQueueController(
      queue as unknown as JobQueueService,
      actions as unknown as JobQueueActionsService,
    ),
    queue,
    actions,
  }
}

const proto = JobQueueController.prototype
type Handler = keyof typeof proto & string
const handler = (name: Handler) => proto[name] as unknown as object
const throttle = (h: object, kind: 'LIMIT' | 'TTL'): unknown =>
  (Reflect.getMetadata(`THROTTLER:${kind}default`, h) as () => number)()

describe('JobQueueController — routing and gates', () => {
  // In a hook, not the test body: a failing assertion must not leak a stubbed env into later tests.
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is mounted at /job-queue behind RolesGuard', () => {
    expect(Reflect.getMetadata(PATH_METADATA, JobQueueController)).toBe('job-queue')
    expect(Reflect.getMetadata(GUARDS_METADATA, JobQueueController)).toEqual([RolesGuard])
  })

  // [handler, method, path, roles, throttle limit per minute, explicit HTTP code]
  it.each([
    ['list', RequestMethod.GET, '/', ['ADMIN', 'HR'], 30, undefined],
    ['card', RequestMethod.GET, ':id', ['ADMIN', 'HR'], 120, undefined],
    ['sources', RequestMethod.GET, ':id/sources', ['ADMIN', 'HR'], 60, undefined],
    ['seniors', RequestMethod.GET, ':id/seniors', ['ADMIN', 'HR'], 60, undefined],
    ['submit', RequestMethod.POST, ':id/submissions', ['ADMIN', 'HR'], 30, undefined],
    [
      'cancel',
      RequestMethod.POST,
      ':id/submissions/:submissionId/cancel',
      ['ADMIN', 'HR'],
      30,
      200,
    ],
    ['dismiss', RequestMethod.POST, ':id/dismiss', ['ADMIN', 'HR'], 60, 200],
    ['undo', RequestMethod.POST, ':id/undo', ['ADMIN', 'HR'], 60, 200],
    ['opened', RequestMethod.POST, ':id/opened', ['ADMIN', 'HR'], 120, 204],
    ['suppress', RequestMethod.POST, ':id/suppress', ['ADMIN'], 30, 204],
  ] as const)('%s: %s %s, roles %j, %i/min, code %s', (name, method, path, roles, limit, code) => {
    const h = handler(name)
    expect(Reflect.getMetadata(METHOD_METADATA, h)).toBe(method)
    expect(Reflect.getMetadata(PATH_METADATA, h)).toBe(path)
    expect(Reflect.getMetadata(ROLES_KEY, h)).toEqual(roles)
    // `RelaxableThrottle` stores resolvers, read per request: unrelaxed, the production cap.
    vi.stubEnv('THROTTLE_RELAXED', '')
    expect(throttle(h, 'LIMIT')).toBe(limit)
    expect(throttle(h, 'TTL')).toBe(60_000)
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, h)).toBe(code)
  })

  it('every cap is the RelaxableThrottle one: raised only when relaxed outside production', () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('THROTTLE_RELAXED', 'true')
    vi.stubEnv('THROTTLER_LIMIT', '1000')
    expect(throttle(handler('list'), 'LIMIT')).toBe(1000)
    vi.stubEnv('NODE_ENV', 'production')
    expect(throttle(handler('list'), 'LIMIT')).toBe(30)
  })

  it.each([
    ['card', ['id']],
    ['sources', ['id']],
    ['seniors', ['id']],
    ['submit', ['id']],
    ['cancel', ['id', 'submissionId']],
    ['dismiss', ['id']],
    ['undo', ['id']],
    ['opened', ['id']],
    ['suppress', ['id']],
  ] as const)('%s: every path id goes through ParseUUIDPipe', (name, params) => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, JobQueueController, name) as Record<
      string,
      { data?: unknown; pipes?: unknown[] }
    >
    const withPipe = Object.values(args)
      .filter((a) => typeof a.data === 'string' && (a.pipes ?? []).includes(ParseUUIDPipe))
      .map((a) => a.data)
      .sort()
    expect(withPipe).toEqual([...params].sort())
  })
})

describe('JobQueueController — reads', () => {
  it('list: parses the query (defaults applied) and passes the caller', async () => {
    const h = harness()
    expect(await h.controller.list({ teamId: TEAM }, HR)).toEqual(LIST)
    expect(h.queue.list).toHaveBeenCalledWith(HR, { teamId: TEAM, tab: 'NEW', limit: 20 })
  })

  it('list: a limit string is coerced', async () => {
    const h = harness()
    await h.controller.list({ limit: '50' }, HR)
    expect(h.queue.list).toHaveBeenCalledWith(HR, { tab: 'NEW', limit: 50 })
  })

  it.each([
    { limit: '51' },
    { limit: '0' },
    { teamId: 'not-a-uuid' },
    { cursor: 'x'.repeat(301) },
    { cursor: '' },
    { tab: 'IN_PROGRESS' },
    { unknown: '1' },
    { teamId: [TEAM, TEAM] },
  ])('list: refuses query %j before the service is called', async (query) => {
    const h = harness()
    await expect(h.controller.list(query, HR)).rejects.toThrow(ZodError)
    expect(h.queue.list).not.toHaveBeenCalled()
  })

  it('card: passes the id, the caller and the team', async () => {
    const h = harness()
    expect(await h.controller.card(OPP, { teamId: TEAM }, HR)).toEqual(CARD)
    expect(h.queue.card).toHaveBeenCalledWith(HR, OPP, { teamId: TEAM })
  })

  it.each([{ cursor: 'abc' }, { teamId: 'nope' }, { other: '1' }])(
    'card: refuses query %j (a cursor belongs to a continuation)',
    async (query) => {
      const h = harness()
      await expect(h.controller.card(OPP, query, HR)).rejects.toThrow(ZodError)
      expect(h.queue.card).not.toHaveBeenCalled()
    },
  )

  it.each(['sources', 'seniors'] as const)(
    '%s: passes the scope query and refuses an oversized cursor',
    async (name) => {
      const h = harness()
      expect(await h.controller[name](OPP, { teamId: TEAM, cursor: 'c' }, HR)).toEqual(PAGE)
      expect(h.queue[name]).toHaveBeenCalledWith(HR, OPP, { teamId: TEAM, cursor: 'c' })
      const bad = harness()
      await expect(bad.controller[name](OPP, { cursor: 'x'.repeat(301) }, HR)).rejects.toThrow(
        ZodError,
      )
      expect(bad.queue[name]).not.toHaveBeenCalled()
    },
  )

  it('a service answer that breaks the response schema is refused on the way out', async () => {
    const h = harness()
    h.queue.card.mockResolvedValueOnce({ ...CARD, secret: 'x' } as typeof CARD)
    await expect(h.controller.card(OPP, {}, HR)).rejects.toThrow(ZodError)
    h.queue.list.mockResolvedValueOnce({ ...LIST, extra: 1 } as typeof LIST)
    await expect(h.controller.list({}, HR)).rejects.toThrow(ZodError)
  })
})

describe('JobQueueController — writes', () => {
  it('submit: parses the body (default confirm false) and answers the submission', async () => {
    const h = harness()
    const body = { seniorId: SENIOR, idempotencyKey: KEY, expectedOpportunityRevision: 3 }
    expect(await h.controller.submit(OPP, body, HR)).toEqual(SUBMISSION)
    expect(h.actions.submit).toHaveBeenCalledWith(HR, OPP, {
      ...body,
      confirmPossibleDuplicate: false,
    })
  })

  it('cancel: passes both ids and the body', async () => {
    const h = harness()
    const body = { idempotencyKey: KEY, expectedVersion: 1 }
    expect(await h.controller.cancel(OPP, SUB, body, HR)).toEqual(SUBMISSION)
    expect(h.actions.cancelSubmission).toHaveBeenCalledWith(HR, OPP, SUB, body)
  })

  it('dismiss and undo: pass the parsed body', async () => {
    const h = harness()
    const dismiss = { scope: 'TEAM', reason: 'SPAM', idempotencyKey: KEY, teamId: TEAM }
    expect(await h.controller.dismiss(OPP, dismiss, HR)).toEqual(DISMISSAL)
    expect(h.actions.dismiss).toHaveBeenCalledWith(HR, OPP, dismiss)
    const undo = { scope: 'TEAM', idempotencyKey: KEY, expectedVersion: 1 }
    expect(await h.controller.undo(OPP, undo, HR)).toEqual({
      ...DISMISSAL,
      hidden: false,
      version: 2,
    })
    expect(h.actions.undo).toHaveBeenCalledWith(HR, OPP, undo)
  })

  it('opened and suppress: answer nothing (204) after the service ran', async () => {
    const h = harness()
    expect(await h.controller.opened(OPP, { sourceRecordId: SUB }, HR)).toBeUndefined()
    expect(h.actions.opened).toHaveBeenCalledWith(HR, OPP, { sourceRecordId: SUB })
    expect(await h.controller.suppress(OPP, { idempotencyKey: KEY }, HR)).toBeUndefined()
    expect(h.actions.suppress).toHaveBeenCalledWith(HR, OPP, { idempotencyKey: KEY })
  })

  it.each([
    ['submit', undefined],
    ['submit', { seniorId: SENIOR, idempotencyKey: 'k', expectedOpportunityRevision: 1 }],
    ['submit', { seniorId: SENIOR, idempotencyKey: KEY, expectedOpportunityRevision: 0 }],
    ['submit', { seniorId: SENIOR, idempotencyKey: KEY, expectedOpportunityRevision: 1, x: 1 }],
    ['cancel', { idempotencyKey: KEY }],
    ['dismiss', { scope: 'TEAM', reason: 'free text', idempotencyKey: KEY }],
    ['undo', { scope: 'TEAM', idempotencyKey: KEY }],
    ['opened', {}],
    ['suppress', {}],
    ['suppress', { idempotencyKey: 'not-a-uuid' }],
    ['suppress', { idempotencyKey: KEY, teamId: TEAM }],
  ] as const)('%s: refuses body %j before the service is called', async (name, body) => {
    const h = harness()
    const call =
      name === 'cancel'
        ? h.controller.cancel(OPP, SUB, body, HR)
        : h.controller[name](OPP, body, HR)
    await expect(call).rejects.toThrow(ZodError)
    const service = name === 'cancel' ? h.actions.cancelSubmission : h.actions[name]
    expect(service).not.toHaveBeenCalled()
  })
})
