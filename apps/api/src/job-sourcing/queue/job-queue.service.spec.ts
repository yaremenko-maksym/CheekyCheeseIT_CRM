import { ForbiddenException, HttpException, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  JOB_QUEUE_ROW_KEYWORDS_MAX,
  JOB_QUEUE_SENIOR_OPTIONS_MAX,
  type JobQueueListQuery,
  MAX_STACK_KEYWORD_CHARS,
  type SessionUser,
} from '@crm/shared'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../config/env'
import type { DatabaseService } from '../../database/database.service'
import {
  matchEvidence,
  matchFacts,
  JobQueueService,
  noMatchReason,
  toListItem,
  toSubmission,
} from './job-queue.service'
import { parseCursor, type QueueCursor, requestSignature, signCursor } from './queue-cursor'
import { filterIdentity, policySignature } from './queue-read-sql'
import type { JobQueueScope, LiveSeniorVersion } from './queue-scope'
import { JobQueueScopeService } from './queue-scope.service'

/**
 * Unit double for the mutation gate (it cannot run `*.integration.spec.ts`): the DB is a scripted
 * `execute`, each call answering the next queued row set, and an unscripted call FAILS the test. The
 * real SQL and every foreign-row guarantee are pinned against Postgres by
 * `job-queue.service.integration.spec.ts`.
 */
const SECRET = 'unit-test-secret-unit-test-secret'
const TEAM = '11111111-1111-4111-8111-111111111111'
const OTHER_TEAM = '22222222-2222-4222-8222-222222222222'
const SEN = '33333333-3333-4333-8333-333333333333'
const SEN_2 = '88888888-8888-4888-8888-888888888888'
const OPP = '44444444-4444-4444-8444-444444444444'
const GEN = '55555555-5555-4555-8555-555555555555'
const SRC = '66666666-6666-4666-8666-666666666666'
const SUB = '77777777-7777-4777-8777-777777777777'
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NOW = new Date('2026-11-04T12:00:00.000Z')
const LATER = new Date('2026-11-04T12:10:00.000Z')

const versions: LiveSeniorVersion[] = [{ seniorId: SEN, profile: 'p', exclusion: 'e' }]
const teamScope: JobQueueScope = {
  kind: 'TEAM',
  teamId: TEAM,
  seniorIds: [SEN],
  versions,
  inputsVersion: 'inputs-1',
}
const user = { id: ACTOR, role: 'HR', email: 'x@example.test' } as SessionUser
const query = (over: Partial<JobQueueListQuery> = {}): JobQueueListQuery => ({
  tab: 'NEW',
  limit: 2,
  ...over,
})

type Rows = Array<Record<string, unknown>>

function harness(scope: JobQueueScope, ...answers: Rows[]) {
  const execute = vi.fn(async (_q: SQL) => {
    const next = answers.shift()
    if (next === undefined) throw new Error('unexpected query')
    return { rows: next }
  })
  const scopes = {
    resolve: vi.fn(async () => scope),
    assertVisible: vi.fn(async () => undefined),
    liveVersions: vi.fn(async () => versions),
    policy: vi.fn(<T>(fn: () => Promise<T>) => fn()),
  }
  const transaction = vi.fn(<T>(fn: (tx: unknown) => Promise<T>, _config?: unknown) =>
    fn({ execute }),
  )
  const db = { execute, transaction }
  const get = vi.fn(() => SECRET)
  const config = { get } as unknown as ConfigService<Env, true>
  const svc = new JobQueueService(
    { db } as unknown as DatabaseService,
    scopes as unknown as JobQueueScopeService,
    config,
  )
  const compiled = (call: number) => {
    const q = new PgDialect().sqlToQuery((execute.mock.calls[call] as [SQL])[0])
    return { text: q.sql.replace(/\s+/g, ' '), params: q.params }
  }
  return { svc, execute, scopes, compiled, get, transaction, db }
}

async function refusal(p: Promise<unknown>): Promise<{ status: number; code: string }> {
  const e: unknown = await p.then(
    () => new Error('expected a refusal'),
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(HttpException)
  const http = e as HttpException
  return { status: http.getStatus(), code: (http.getResponse() as { code: string }).code }
}
const NOT_FOUND = { status: 404, code: 'JOB_OPPORTUNITY_NOT_FOUND' }
const MALFORMED = { status: 400, code: 'JOB_QUEUE_CURSOR_MALFORMED' }
const REFRESH = { status: 409, code: 'JOB_QUEUE_REFRESH_REQUIRED' }

const generationRow = (over: Record<string, unknown> = {}) => ({
  id: GEN,
  scope_kind: 'TEAM',
  team_id: TEAM,
  status: 'PUBLISHED',
  expires_at: new Date('2026-11-04T12:15:00.000Z'),
  policy_signature: policySignature(teamScope, versions),
  rule_version: 'eval.1+l1.1',
  evaluated_at: new Date('2026-11-04T11:50:00.000Z'),
  ...over,
})
const tally = { new: '3', submitted: '1', hidden: '2', capped: false }
const FACTS = { ruleVersion: 'eval.1+l1.1', evaluatedAt: '2026-11-04T11:50:00.000Z', capped: false }
const dbRow = (over: Record<string, unknown> = {}) => ({
  id: OPP,
  revision: 2,
  title: 'Engineer',
  employer_name: 'Acme',
  location: 'Remote',
  availability: 'OPEN',
  published_at: new Date('2026-11-01T00:00:00.000Z'),
  first_seen_at: '2026-11-02T00:00:00.000Z',
  source_record_id: SRC,
  source_type: 'DOU_RSS',
  source_url: 'https://jobs.example.test/1',
  source_total: '3',
  application_url: null,
  matched: '2',
  stop_listed: '1',
  submitted: '1',
  opened: true,
  hidden: false,
  eligibility: 'LEAD',
  seniority: 'SENIOR',
  matched_evidence: [
    {
      score: 50,
      reasons: [{ code: 'TECH_MATCH', evidence: ['react:CORE', 'go:OPTIONAL'], ruleVersion: 'r' }],
    },
  ],
  order_key: 7,
  ...over,
})
const ITEM = {
  opportunityId: OPP,
  revision: 2,
  title: 'Engineer',
  companyName: 'Acme',
  location: 'Remote',
  primarySource: { sourceRecordId: SRC, sourceType: 'DOU_RSS', url: 'https://jobs.example.test/1' },
  applicationUrl: null,
  alsoSeenOnCount: 2,
  availability: 'OPEN',
  eligibility: 'LEAD',
  seniority: 'SENIOR',
  matchedKeywords: ['go', 'react'],
  matchedSeniorCount: 2,
  submittedSeniorCount: 1,
  stopListedSeniorCount: 1,
  openedByTeam: true,
  hidden: false,
  publishedAt: '2026-11-01T00:00:00.000Z',
  firstSeenAt: '2026-11-02T00:00:00.000Z',
}

/** The signature a list request of this shape carries; expected from the pieces it is defined by. */
const listSignature = (q: JobQueueListQuery, actor = ACTOR) =>
  requestSignature([actor, policySignature(teamScope, versions), ...filterIdentity(q)])
const FAR = Math.floor(new Date('2026-11-04T12:15:00.000Z').getTime() / 1000)
const listCursor = (q: JobQueueListQuery, over: Partial<QueueCursor> = {}) =>
  signCursor({ t: 'L', g: GEN, k: 7, s: listSignature(q), e: FAR, ...over } as QueueCursor, SECRET)
const continuationSig = () => requestSignature([ACTOR, policySignature(teamScope, versions), OPP])
const seekCursor = (t: 'SRC' | 'SEN', over: Partial<QueueCursor> = {}) =>
  signCursor({ t, g: OPP, k: SEN, s: continuationSig(), e: FAR, ...over } as QueueCursor, SECRET)

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('JobQueueService.list', () => {
  it('each NONE answer is its own object, never one shared instance (PN-2)', async () => {
    const h = harness({ kind: 'NONE' })
    const first = await h.svc.list(user, query())
    const second = await h.svc.list(user, query())
    expect(second).not.toBe(first)
    expect(second.items).not.toBe(first.items)
    expect(second.counts).not.toBe(first.counts)
    first.counts.NEW = 9
    expect((await h.svc.list(user, query())).counts.NEW).toBe(0)
  })

  it('a NONE scope is an empty list and runs no query', async () => {
    const h = harness({ kind: 'NONE' })
    await expect(h.svc.list(user, query())).resolves.toEqual({
      items: [],
      nextCursor: null,
      counts: { NEW: 0, SUBMITTED: 0, HIDDEN: 0 },
      generation: null,
    })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('a role outside the queue stops at resolve: nothing else runs', async () => {
    const h = harness(teamScope)
    h.scopes.resolve.mockRejectedValue(new ForbiddenException())
    await expect(h.svc.list(user, query())).rejects.toBeInstanceOf(ForbiddenException)
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('resolves the scope of this request from the requested team', async () => {
    const h = harness({ kind: 'NONE' })
    await h.svc.list(user, query({ teamId: OTHER_TEAM }))
    expect(h.scopes.resolve).toHaveBeenCalledWith(user, OTHER_TEAM, h.db)
  })

  it('a forged cursor is a 400 before any query, in a NONE scope too', async () => {
    const h = harness({ kind: 'NONE' })
    expect(await refusal(h.svc.list(user, query({ cursor: 'forged' })))).toEqual(MALFORMED)
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('a first page serves the current generation: items, counts, a next cursor at limit+1', async () => {
    const h = harness(
      teamScope,
      [generationRow()],
      [generationRow()],
      [tally],
      [dbRow(), dbRow({ order_key: 8 }), dbRow({ order_key: 9 })],
    )
    const res = await h.svc.list(user, query())
    expect(res.items).toEqual([ITEM, ITEM])
    expect(res.counts).toEqual({ NEW: 3, SUBMITTED: 1, HIDDEN: 2 })
    expect(res.generation).toEqual(FACTS)
    expect(parseCursor(res.nextCursor as string, 'L', SECRET)).toEqual({
      t: 'L',
      g: GEN,
      k: 8,
      s: listSignature(query()),
      e: FAR,
    })
    const page = h.compiled(3)
    expect(page.text).toContain('e.order_key > $')
    expect(page.text).toContain('ORDER BY e.order_key LIMIT $')
    expect(page.params).toContain(-1)
    expect(page.params).toContain(3)
    expect(page.params).toContain(GEN)
  })

  it('counts come before the filters are applied and the page after them', async () => {
    const q = query({ search: 'zzz' })
    const h = harness(teamScope, [generationRow()], [generationRow()], [tally], [])
    await h.svc.list(user, q)
    expect(h.compiled(2).params).not.toContain('%zzz%')
    expect(h.compiled(3).params).toContain('%zzz%')
    expect(h.compiled(3).text).toContain(' AND d.tab = $')
    expect(h.compiled(3).text).toContain(' AND (o.title ILIKE')
  })

  it('both reads re-apply the listable predicate for this scope', async () => {
    const h = harness(teamScope, [generationRow()], [generationRow()], [tally], [])
    await h.svc.list(user, query())
    for (const call of [2, 3]) {
      expect(h.compiled(call).text).toContain('FROM job_opportunity_team_triage g')
      expect(h.compiled(call).text).toContain(
        `WHERE m.opportunity_id = o.id AND m.outcome = 'LEAD'`,
      )
      expect(h.compiled(call).params).toContain(TEAM)
      expect(h.compiled(call).text).toContain('e.generation_id = $')
    }
    expect(h.compiled(2).text).toContain(`count(*) FILTER (WHERE d.tab = 'SUBMITTED') AS submitted`)
    expect(h.compiled(2).text).toContain(`count(*) FILTER (WHERE d.tab = 'HIDDEN') AS hidden`)
    expect(h.compiled(2).text).toContain(`count(*) FILTER (WHERE d.tab = 'NEW') AS new`)
    expect(h.compiled(3).text).toContain('o.id, o.revision, o.title')
  })

  it('a page exactly at the limit has no next cursor', async () => {
    const h = harness(teamScope, [generationRow()], [generationRow()], [tally], [dbRow(), dbRow()])
    const res = await h.svc.list(user, query())
    expect(res.items).toHaveLength(2)
    expect(res.nextCursor).toBeNull()
  })

  it('an empty page has no next cursor', async () => {
    const h = harness(teamScope, [generationRow()], [generationRow()], [tally], [])
    await expect(h.svc.list(user, query())).resolves.toMatchObject({ items: [], nextCursor: null })
  })

  it('lookup, counts and page share one read-only REPEATABLE READ snapshot; publishing stays out', async () => {
    const q = query()
    const h = harness(teamScope, [generationRow()], [tally], [])
    await h.svc.list(user, { ...q, cursor: listCursor(q) })
    expect(h.transaction).toHaveBeenCalledTimes(1)
    expect(h.transaction.mock.calls[0]?.[1]).toEqual({
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    })
  })

  it('a generation purged after it was chosen is a refresh, never a 200 with an empty page', async () => {
    const h = harness(teamScope, [generationRow()], [])
    expect(await refusal(h.svc.list(user, query()))).toEqual(REFRESH)
    expect(h.execute).toHaveBeenCalledTimes(2)
    expect(h.compiled(1).text).toContain('FROM job_queue_generations WHERE id = $')
    expect(h.compiled(1).params).toEqual([GEN])
  })

  it('reports reaching the entry cap: the last retained key, exact booleans only', async () => {
    const h = harness(
      teamScope,
      [generationRow()],
      [generationRow()],
      [{ ...tally, capped: true }],
      [],
    )
    const res = await h.svc.list(user, query())
    expect(res.generation).toEqual({ ...FACTS, capped: true })
    expect(h.compiled(2).text).toContain(
      'EXISTS (SELECT 1 FROM job_queue_generation_entries top WHERE top.generation_id = $',
    )
    expect(h.compiled(2).text).toContain('AND top.order_key = $')
    expect(h.compiled(2).params).toContain(4999)
    const other = harness(
      teamScope,
      [generationRow()],
      [generationRow()],
      [{ ...tally, capped: 'true' }],
      [],
    )
    expect((await other.svc.list(user, query())).generation?.capped).toBe(false)
  })

  it('a cursor resumes after its key, on its generation, and publishes nothing', async () => {
    const q = query()
    const h = harness(teamScope, [generationRow()], [tally], [dbRow({ order_key: 8 })])
    const res = await h.svc.list(user, { ...q, cursor: listCursor(q) })
    expect(res.items).toEqual([ITEM])
    expect(h.compiled(0).text).toContain('FROM job_queue_generations WHERE id = $')
    expect(h.compiled(0).params).toEqual([GEN])
    expect(h.compiled(2).params).toContain(7)
    expect(h.compiled(2).params).not.toContain(-1)
    expect(h.execute).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['gone', []],
    ['superseded', [generationRow({ status: 'INVALIDATED' })]],
    ['expired', [generationRow({ expires_at: new Date('2026-11-04T11:59:00.000Z') })]],
    ['of another team', [generationRow({ team_id: OTHER_TEAM })]],
    ['of the studio', [generationRow({ scope_kind: 'STUDIO', team_id: null })]],
  ])('a cursor on a generation that is %s must refresh, reading no data', async (_l, rows) => {
    const q = query()
    const h = harness(teamScope, rows as Rows)
    expect(await refusal(h.svc.list(user, { ...q, cursor: listCursor(q) }))).toEqual(REFRESH)
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it('an expired cursor must refresh before any query', async () => {
    const q = query()
    const h = harness(teamScope)
    const cursor = listCursor(q, { e: Math.floor(NOW.getTime() / 1000) })
    expect(await refusal(h.svc.list(user, { ...q, cursor }))).toEqual(REFRESH)
    expect(h.execute).not.toHaveBeenCalled()
  })

  it("another actor's cursor must refresh before any query: a cursor is not a grant", async () => {
    const q = query()
    const h = harness(teamScope)
    const cursor = listCursor(q, { s: listSignature(q, 'someone-else') })
    expect(await refusal(h.svc.list(user, { ...q, cursor }))).toEqual(REFRESH)
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('a cursor issued under other filters must refresh', async () => {
    const h = harness(teamScope)
    const cursor = listCursor(query({ tab: 'HIDDEN' }))
    expect(await refusal(h.svc.list(user, query({ cursor })))).toEqual(REFRESH)
  })

  it('a cursor issued before a roster change must refresh', async () => {
    const q = query()
    const h = harness(teamScope)
    h.scopes.liveVersions.mockResolvedValue([{ seniorId: SEN, profile: 'p2', exclusion: 'e' }])
    expect(await refusal(h.svc.list(user, { ...q, cursor: listCursor(q) }))).toEqual(REFRESH)
  })

  it('filtering by a senior outside the scope is an empty page with the scope totals', async () => {
    const h = harness(teamScope, [generationRow()], [generationRow()], [tally])
    await expect(h.svc.list(user, query({ seniorIds: [OTHER_TEAM] }))).resolves.toEqual({
      items: [],
      nextCursor: null,
      counts: { NEW: 3, SUBMITTED: 1, HIDDEN: 2 },
      generation: FACTS,
    })
    expect(h.execute).toHaveBeenCalledTimes(3)
  })

  it('a mix of a foreign senior and a scope senior reads the page', async () => {
    const other = 'abcdefab-abcd-4abc-8abc-abcdefabcdef'
    const live = [
      { seniorId: SEN, profile: 'p', exclusion: 'e' },
      { seniorId: other, profile: 'p', exclusion: 'e' },
    ]
    const head = generationRow({ policy_signature: policySignature(teamScope, live) })
    const h = harness(teamScope, [head], [head], [tally], [])
    h.scopes.liveVersions.mockResolvedValue(live)
    await h.svc.list(user, query({ seniorIds: [OTHER_TEAM, other] }))
    expect(h.execute).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(h.compiled(3).params)).toContain(other)
  })

  it('no senior filter reads the page even with an empty roster', async () => {
    const head = generationRow({ policy_signature: policySignature(teamScope, []) })
    const h = harness(teamScope, [head], [head], [tally], [])
    h.scopes.liveVersions.mockResolvedValue([])
    await h.svc.list(user, query())
    expect(h.execute).toHaveBeenCalledTimes(4)
  })

  it('a query failure inside the policy wrapper is the 503, never a default answer', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const execute = vi.fn(async () => {
      throw new Error('connection lost')
    })
    const database = { db: { execute } } as unknown as DatabaseService
    const scopes = new JobQueueScopeService()
    vi.spyOn(scopes, 'resolve').mockResolvedValue(teamScope)
    const config = { get: () => SECRET } as unknown as ConfigService<Env, true>
    const svc = new JobQueueService(database, scopes, config)
    expect(await refusal(svc.list(user, query()))).toEqual({
      status: 503,
      code: 'JOB_QUEUE_POLICY_UNAVAILABLE',
    })
  })
})

describe('JobQueueService.seniorOptions', () => {
  it('an empty roster answers no items and never reads the users', async () => {
    const h = harness({ kind: 'NONE' } as JobQueueScope)
    h.scopes.liveVersions.mockResolvedValue([])
    await expect(h.svc.seniorOptions(user, {})).resolves.toEqual({ items: [] })
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('reads only the scope seniors, bounded, inside the policy wrapper', async () => {
    const h = harness(teamScope, [
      { id: SEN, display_name: 'A Senior', team_name: 'Alpha', email: 'x@example.com' },
    ])
    await expect(h.svc.seniorOptions(user, { teamId: TEAM })).resolves.toEqual({
      items: [{ id: SEN, name: 'A Senior', teamName: 'Alpha' }],
    })
    expect(h.scopes.resolve).toHaveBeenCalledWith(user, TEAM, h.db)
    expect(h.scopes.liveVersions).toHaveBeenCalledWith(teamScope, h.db)
    expect(h.scopes.policy).toHaveBeenCalledTimes(1)
    // a TEAM scope names its own team, between the ids and the bound
    expect(h.compiled(0).params).toEqual([
      TEAM,
      JSON.stringify([SEN]),
      JOB_QUEUE_SENIOR_OPTIONS_MAX,
    ])
    expect(h.compiled(0).text).toContain('WHERE u.id IN (SELECT x::uuid FROM')
    expect(h.compiled(0).text).toContain('ORDER BY t.name NULLS LAST, u.display_name, u.id')
  })

  it('STUDIO names no team: any live membership may name the group, none is null (SO2-1)', async () => {
    const h = harness({ kind: 'STUDIO' } as JobQueueScope, [
      { id: SEN, display_name: 'A Senior', team_name: 'Beta' },
      { id: SEN_2, display_name: 'B Senior', team_name: null },
    ])
    await expect(h.svc.seniorOptions(user, {})).resolves.toEqual({
      items: [
        { id: SEN, name: 'A Senior', teamName: 'Beta' },
        { id: SEN_2, name: 'B Senior', teamName: null },
      ],
    })
    expect(h.compiled(0).params).toEqual([JSON.stringify([SEN]), JOB_QUEUE_SENIOR_OPTIONS_MAX])
    expect(h.compiled(0).text).not.toContain('tm.team_id =')
  })

  it('clips a name and a team name to the wire bound (SO2-2)', async () => {
    const h = harness(teamScope, [
      { id: SEN, display_name: 'n'.repeat(300), team_name: 't'.repeat(300) },
    ])
    const { items } = await h.svc.seniorOptions(user, {})
    expect(items[0]?.name).toBe('n'.repeat(255))
    expect(items[0]?.teamName).toBe('t'.repeat(255))
  })

  it('a read failure is the 503, never an empty picker', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    const execute = vi.fn(async () => {
      throw new Error('connection lost')
    })
    const database = { db: { execute } } as unknown as DatabaseService
    const scopes = new JobQueueScopeService()
    vi.spyOn(scopes, 'resolve').mockResolvedValue(teamScope)
    vi.spyOn(scopes, 'liveVersions').mockResolvedValue([
      { seniorId: SEN, profile: 'p', exclusion: 'e' },
    ])
    const config = { get: () => SECRET } as unknown as ConfigService<Env, true>
    const svc = new JobQueueService(database, scopes, config)
    expect(await refusal(svc.seniorOptions(user, {}))).toEqual({
      status: 503,
      code: 'JOB_QUEUE_POLICY_UNAVAILABLE',
    })
  })
})

describe('JobQueueService without a cursor key', () => {
  it('the key is the configured session secret', async () => {
    const h = harness(teamScope)
    await refusal(h.svc.list(user, query({ cursor: 'forged' })))
    expect(h.get).toHaveBeenCalledWith('SESSION_SECRET', { infer: true })
  })

  it.each([
    ['no ConfigService at all', undefined],
    ['an empty secret', { get: () => '' } as unknown as ConfigService<Env, true>],
  ])('%s: no cursor is honoured, whatever it was signed with', async (_label, config) => {
    const h = harness(teamScope)
    const svc = new JobQueueService(
      { db: { execute: h.execute } } as unknown as DatabaseService,
      h.scopes as unknown as JobQueueScopeService,
      config,
    )
    const forged = signCursor({ t: 'L', g: GEN, k: 0, s: 's', e: FAR }, '')
    expect(await refusal(svc.list(user, query({ cursor: forged })))).toEqual({
      status: 503,
      code: 'JOB_QUEUE_POLICY_UNAVAILABLE',
    })
    expect(h.execute).not.toHaveBeenCalled()
  })
})

describe('toListItem', () => {
  it('clips text to the wire bounds rather than failing the whole page', () => {
    const item = toListItem(
      dbRow({ title: 'x'.repeat(501), employer_name: 'y'.repeat(256), location: 'z'.repeat(501) }),
    )
    expect(item.title).toHaveLength(500)
    expect(item.companyName).toHaveLength(255)
    expect(item.location).toHaveLength(500)
  })
  it('keeps nullable facts null, and a lone source is not "also seen on"', () => {
    const item = toListItem(
      dbRow({ employer_name: null, location: null, published_at: null, source_total: '1' }),
    )
    expect(item).toMatchObject({
      companyName: null,
      location: null,
      publishedAt: null,
      alsoSeenOnCount: 0,
    })
  })
  it('a manual card has no primary source and carries its stated application URL', () => {
    const item = toListItem(
      dbRow({
        source_record_id: null,
        source_type: null,
        source_url: null,
        source_total: null,
        application_url: 'https://careers.example.test/42',
      }),
    )
    expect(item).toMatchObject({
      primarySource: null,
      applicationUrl: 'https://careers.example.test/42',
      alsoSeenOnCount: 0,
    })
  })
  it('flags are exact booleans, not truthiness', () => {
    expect(toListItem(dbRow({ opened: 'true', hidden: 'true' }))).toMatchObject({
      openedByTeam: false,
      hidden: false,
    })
    expect(toListItem(dbRow({ opened: false, hidden: true }))).toMatchObject({
      openedByTeam: false,
      hidden: true,
    })
  })

  it('carries the stored seniority as it is, UNKNOWN included', () => {
    expect(toListItem(dbRow({ seniority: 'LEAD' })).seniority).toBe('LEAD')
    expect(toListItem(dbRow({ seniority: 'UNKNOWN' })).seniority).toBe('UNKNOWN')
  })

  describe('matchedKeywords', () => {
    const tech = (...keywords: string[]) => ({
      reasons: [{ code: 'TECH_MATCH', evidence: keywords, ruleVersion: 'r' }],
    })
    const keywordsOf = (matched_evidence: unknown) =>
      toListItem(dbRow({ matched_evidence })).matchedKeywords

    it('is the sorted union over the seniors, strength dropped, no one named', () => {
      expect(
        keywordsOf([tech('react:CORE', 'go:OPTIONAL'), tech('go:CORE', 'aws:OPTIONAL')]),
      ).toEqual(['aws', 'go', 'react'])
    })

    it('is empty with no matched senior: a NULL aggregate, a non-array, a match without tech', () => {
      expect(keywordsOf(null)).toEqual([])
      expect(keywordsOf('react:CORE')).toEqual([])
      expect(keywordsOf([{ reasons: [{ code: 'SOFT', evidence: ['x:CORE'] }] }])).toEqual([])
    })

    it('stops at the wire cap, keeping the same keywords on every read', () => {
      const names = Array.from({ length: 25 }, (_, i) => `k${String(i).padStart(2, '0')}:CORE`)
      const expected = names.slice(0, JOB_QUEUE_ROW_KEYWORDS_MAX).map((k) => k.slice(0, 3))
      expect(keywordsOf([tech(...names)])).toEqual(expected)
      expect(keywordsOf([tech(...[...names].reverse())])).toEqual(expected)
      expect(expected).toHaveLength(JOB_QUEUE_ROW_KEYWORDS_MAX)
    })

    it('sorts case-insensitively, so the cap keeps the alphabetically-first keywords (UX-LOW-1)', () => {
      expect(
        keywordsOf([tech('TypeScript:CORE', 'aws:CORE', 'React:CORE', 'Node.js:CORE')]),
      ).toEqual(['aws', 'Node.js', 'React', 'TypeScript'])
      const upper = Array.from({ length: JOB_QUEUE_ROW_KEYWORDS_MAX }, (_, i) => `K${i}:CORE`)
      expect(keywordsOf([tech(...upper, 'aws:CORE')])[0]).toBe('aws')
    })

    it('orders two keywords that differ only by case the same way on every read', () => {
      expect(keywordsOf([tech('react:CORE', 'React:CORE')])).toEqual(['React', 'react'])
      expect(keywordsOf([tech('React:CORE', 'react:CORE')])).toEqual(['React', 'react'])
    })

    it('drops a keyword that is only a strength suffix, before the union (SO-2)', () => {
      expect(keywordsOf([tech(':CORE', 'go:CORE'), tech('', ':OPTIONAL')])).toEqual(['go'])
    })

    it('clips an overlong keyword rather than failing the whole page', () => {
      const [only, ...rest] = keywordsOf([tech(`${'x'.repeat(MAX_STACK_KEYWORD_CHARS + 1)}:CORE`)])
      expect(rest).toEqual([])
      expect(only).toHaveLength(MAX_STACK_KEYWORD_CHARS)
    })
  })
})

describe('card text bounds', () => {
  it('clips a senior name and a duplicate title and company to the wire bounds', async () => {
    const h = harness(
      teamScope,
      [cardDbRow()],
      [seniorDbRow({ display_name: 'n'.repeat(256) })],
      [{ total: '1' }],
      [],
      [{ total: '0' }],
      [{ id: SRC, title: 't'.repeat(501), employer_name: 'c'.repeat(256), total: '1' }],
    )
    const card = await h.svc.card(user, OPP)
    expect(card.seniors.items[0]?.displayName).toHaveLength(255)
    expect(card.possibleDuplicates?.items[0]?.title).toHaveLength(500)
    expect(card.possibleDuplicates?.items[0]?.companyName).toHaveLength(255)
  })
})

describe('matchFacts', () => {
  it('reads the keywords of the TECH_MATCH reason, keeping colons inside a keyword', () => {
    const evidence = {
      reasons: [
        { code: 'OTHER', evidence: ['ignored:CORE'] },
        { code: 'TECH_MATCH', evidence: ['Go:CORE', 'c:sharp:OPTIONAL'] },
      ],
    }
    expect(matchFacts(evidence)).toEqual({ keywords: ['Go', 'c:sharp'], approximate: false })
  })

  it('an evidence item without a strength suffix is the whole keyword (PN-1)', () => {
    const evidence = { reasons: [{ code: 'TECH_MATCH', evidence: ['Rust', 'Go:CORE'] }] }
    expect(matchFacts(evidence)).toEqual({ keywords: ['Rust', 'Go'], approximate: false })
  })
  it('an OPTIONAL-only match is approximate', () => {
    const evidence = { reasons: [{ code: 'TECH_MATCH', evidence: ['Go:OPTIONAL'] }] }
    expect(matchFacts(evidence)).toEqual({ keywords: ['Go'], approximate: true })
  })
  it('a row with no TECH_MATCH (a TRIAGE row) has no keywords and is approximate', () => {
    const evidence = { reasons: [{ code: 'UNKNOWN_STACK', evidence: ['x'] }] }
    expect(matchFacts(evidence)).toEqual({ keywords: [], approximate: true })
  })
  it.each([
    ['null', null],
    ['no reasons', {}],
    ['reasons that are not a list', { reasons: 'x' }],
    ['a reason without evidence', { reasons: [{ code: 'TECH_MATCH' }] }],
    ['a null reason', { reasons: [null] }],
  ])('tolerates %s', (_label, evidence) => {
    expect(matchFacts(evidence)).toEqual({ keywords: [], approximate: true })
  })
  it('bounds the keywords to the wire maximum', () => {
    const evidence = {
      reasons: [
        { code: 'TECH_MATCH', evidence: Array.from({ length: 201 }, (_, i) => `k${i}:CORE`) },
      ],
    }
    expect(matchFacts(evidence).keywords).toHaveLength(200)
  })
  it('drops an empty keyword before the cap, so it never takes a slot (SO-2)', () => {
    const named = Array.from({ length: 200 }, (_, i) => `k${i}:CORE`)
    const evidence = { reasons: [{ code: 'TECH_MATCH', evidence: [':CORE', '', ...named] }] }
    const { keywords } = matchFacts(evidence)
    expect(keywords).toHaveLength(200)
    expect(keywords).not.toContain('')
    expect(keywords[0]).toBe('k0')
  })
})

describe('matchEvidence (Task 7.3b «Чому збіг»)', () => {
  it('pairs each TECH_MATCH keyword with its strength, keeping colons inside a keyword', () => {
    const evidence = {
      reasons: [
        { code: 'OTHER', evidence: ['ignored:CORE'] },
        { code: 'TECH_MATCH', evidence: ['Go:CORE', 'c:sharp:OPTIONAL'] },
      ],
    }
    expect(matchEvidence(evidence)).toEqual([
      { keyword: 'Go', strength: 'CORE' },
      { keyword: 'c:sharp', strength: 'OPTIONAL' },
    ])
  })
  it('drops an item with no known strength or no keyword: it cannot say why it matched', () => {
    const evidence = {
      reasons: [{ code: 'TECH_MATCH', evidence: ['Rust', 'Go:STRONG', ':CORE', 'ts:CORE'] }],
    }
    expect(matchEvidence(evidence)).toEqual([{ keyword: 'ts', strength: 'CORE' }])
  })
  it('reads the whole item: a strength must end it, a keyword must start it', () => {
    const evidence = {
      reasons: [
        { code: 'TECH_MATCH', evidence: ['x:COREy', 'x:CORE ', '\nx:CORE', 'ts:OPTIONAL'] },
      ],
    }
    expect(matchEvidence(evidence)).toEqual([{ keyword: 'ts', strength: 'OPTIONAL' }])
  })
  it.each([
    ['null', null],
    ['no reasons', {}],
    ['reasons that are not a list', { reasons: 'x' }],
    ['a null reason', { reasons: [null] }],
  ])('tolerates %s', (_label, evidence) => {
    expect(matchEvidence(evidence)).toEqual([])
  })
  it('clips an overlong keyword and stops at the wire cap', () => {
    const long = { reasons: [{ code: 'TECH_MATCH', evidence: [`${'k'.repeat(101)}:CORE`] }] }
    expect(matchEvidence(long)[0]?.keyword).toHaveLength(100)
    const many = {
      reasons: [
        { code: 'TECH_MATCH', evidence: Array.from({ length: 201 }, (_, i) => `k${i}:CORE`) },
      ],
    }
    const items = matchEvidence(many)
    expect(items).toHaveLength(200)
    expect(items[199]).toEqual({ keyword: 'k199', strength: 'CORE' })
  })
})

describe('noMatchReason (Task 7.3b, four empty states)', () => {
  // A sourced card evaluated OPEN at its current revision, verified, with no own LEAD/TRIAGE/stop row.
  const evaluated = {
    matched: '0',
    stop_listed: '0',
    triaged: '0',
    manual_team_id: null,
    employer_verified: true,
    evaluated_current: true,
    evaluation_verdict: 'OPEN',
  }
  const excluded = { ...evaluated, evaluation_verdict: 'EXCLUDED' }
  it('a card excluded at its current revision is EXCLUDED, never NO_MATCH (CR2-M-1)', () => {
    expect(noMatchReason(excluded)).toBe('EXCLUDED')
    expect(noMatchReason({ ...excluded, employer_verified: false })).toBe('EXCLUDED')
    expect(noMatchReason({ ...excluded, triaged: '1' })).toBe('EXCLUDED')
    expect(noMatchReason({ ...excluded, manual_team_id: TEAM })).toBe('EXCLUDED')
  })
  it('a stop-list wins over the exclusion; a LEAD wins over both', () => {
    expect(noMatchReason({ ...excluded, stop_listed: '1' })).toBe('STOP_LISTED')
    expect(noMatchReason({ ...excluded, matched: '1' })).toBeNull()
  })
  it('an exclusion at an older revision is not EXCLUDED: the new revision awaits evaluation', () => {
    expect(noMatchReason({ ...excluded, evaluated_current: false })).toBe('TRIAGE')
  })
  it('NO_MATCH needs an OPEN verdict: a missing verdict is TRIAGE', () => {
    expect(noMatchReason({ ...evaluated, evaluation_verdict: null })).toBe('TRIAGE')
  })
  it('is null as soon as one senior matched, whatever else holds', () => {
    expect(noMatchReason({ ...evaluated, matched: '1', stop_listed: '3', triaged: '2' })).toBeNull()
  })
  it('a stop-list on every matching senior is STOP_LISTED, a manual card included', () => {
    expect(noMatchReason({ ...evaluated, stop_listed: '1', triaged: '1' })).toBe('STOP_LISTED')
    expect(noMatchReason({ ...evaluated, stop_listed: '1', manual_team_id: TEAM })).toBe(
      'STOP_LISTED',
    )
  })
  it('a TRIAGE row for an own senior is TRIAGE, however verified or evaluated (SPEC-H-1)', () => {
    expect(noMatchReason({ ...evaluated, triaged: '1' })).toBe('TRIAGE')
    expect(noMatchReason({ ...evaluated, triaged: '1', manual_team_id: TEAM })).toBe('TRIAGE')
  })
  it('a manual card nobody matched is NO_MATCH: it is never evaluated, a person placed it', () => {
    const manual = { ...evaluated, manual_team_id: TEAM }
    expect(noMatchReason({ ...manual, employer_verified: false, evaluated_current: false })).toBe(
      'NO_MATCH',
    )
  })
  it('a sourced card evaluated at its revision with no own row is NO_MATCH (SPEC-H-1)', () => {
    expect(noMatchReason(evaluated)).toBe('NO_MATCH')
  })
  it('an unverified employer, or no evaluation at the current revision, is TRIAGE', () => {
    expect(noMatchReason({ ...evaluated, employer_verified: false })).toBe('TRIAGE')
    expect(noMatchReason({ ...evaluated, evaluated_current: false })).toBe('TRIAGE')
    expect(noMatchReason({ ...evaluated, evaluated_current: null })).toBe('TRIAGE')
  })
})

describe('toSubmission', () => {
  const own = {
    opportunity_id: OPP,
    senior_id: SEN,
    submission_id: SUB,
    submission_state: 'RELEASED',
    taken_at: '2026-11-01T00:00:00.000Z',
    released_at: new Date('2026-11-02T00:00:00.000Z'),
    submission_version: 3,
    submitted_by_name: 'Recruiter',
    submitted_elsewhere: false,
  }
  it('an own row in full', () => {
    expect(toSubmission(own)).toEqual({
      id: SUB,
      opportunityId: OPP,
      seniorId: SEN,
      state: 'RELEASED',
      submittedAt: '2026-11-01T00:00:00.000Z',
      cancelledAt: '2026-11-02T00:00:00.000Z',
      version: 3,
      submittedByName: 'Recruiter',
    })
  })
  it('an own live row has no cancellation, and wins over the marker', () => {
    expect(
      toSubmission({
        ...own,
        submission_state: 'TAKEN',
        released_at: null,
        submitted_elsewhere: true,
      }),
    ).toMatchObject({ state: 'TAKEN', cancelledAt: null })
  })
  it('a foreign live row is the bare marker and nothing else', () => {
    expect(
      toSubmission({
        opportunity_id: OPP,
        senior_id: SEN,
        submission_id: null,
        submitted_elsewhere: true,
      }),
    ).toEqual({ submittedElsewhere: true })
  })
  it('none at all, or a foreign cancelled one, is null', () => {
    expect(
      toSubmission({
        opportunity_id: OPP,
        senior_id: SEN,
        submission_id: null,
        submitted_elsewhere: false,
      }),
    ).toBeNull()
  })
})

const cardDbRow = (over: Record<string, unknown> = {}) => ({
  ...dbRow(),
  description: '# Role',
  newer_than_list: false,
  last_observed_at: new Date('2026-11-03T00:00:00.000Z'),
  stack_keywords: ['go', 'react'],
  manual_team_id: null,
  triaged: '0',
  employer_verified: true,
  evaluated_current: true,
  evaluation_verdict: 'OPEN',
  employment_type: 'B2B',
  dismissal_version: null,
  ...over,
})
const seniorDbRow = (over: Record<string, unknown> = {}) => ({
  senior_id: SEN,
  opportunity_id: OPP,
  evidence: { reasons: [{ code: 'TECH_MATCH', evidence: ['Go:CORE'] }] },
  display_name: 'Senior One',
  submission_id: null,
  submitted_elsewhere: false,
  ...over,
})
const sourceDbRow = (id = SRC) => ({
  source_record_id: id,
  source_type: 'DOU_RSS',
  source_url: 'https://jobs.example.test/1',
  linked_at: '2026-11-01T00:00:00.000Z',
})
const uuidOf = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`

describe('JobQueueService.card', () => {
  it('a visibility miss stops there: no read, the same 404', async () => {
    const h = harness(teamScope)
    h.scopes.assertVisible.mockRejectedValue(
      Object.assign(new HttpException({ code: NOT_FOUND.code }, 404)),
    )
    expect(await refusal(h.svc.card(user, OPP))).toEqual(NOT_FOUND)
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('the full shape: facts, seniors, sources, duplicates', async () => {
    const h = harness(
      teamScope,
      [cardDbRow()],
      [seniorDbRow()],
      [{ total: '1' }],
      [sourceDbRow()],
      [{ total: '1' }],
      [
        {
          id: SRC,
          title: 'Engineer',
          employer_name: null,
          total: '6',
          submitted_senior_names: ['Senior One'],
        },
      ],
    )
    const card = await h.svc.card(user, OPP, { teamId: TEAM })
    expect(h.scopes.resolve).toHaveBeenCalledWith(user, TEAM, h.db)
    expect(h.scopes.assertVisible).toHaveBeenCalledWith(teamScope, OPP, h.db)
    // A TEAM scope never carries the ADMIN team key at all (toEqual alone ignores an undefined one).
    expect(card.seniors.items[0]).not.toHaveProperty('team')
    expect(card).toEqual({
      ...ITEM,
      descriptionMd: '# Role',
      newerThanList: false,
      lastSeenAt: '2026-11-03T00:00:00.000Z',
      stackKeywords: ['go', 'react'],
      noMatchReason: null,
      engagementForm: 'B2B',
      dismissal: null,
      seniors: {
        items: [
          {
            seniorId: SEN,
            displayName: 'Senior One',
            matchApproximate: false,
            matchedKeywords: ['Go'],
            matchEvidence: [{ keyword: 'Go', strength: 'CORE' }],
            submission: null,
          },
        ],
        totalCount: 1,
        nextCursor: null,
      },
      sources: {
        items: [
          {
            sourceRecordId: SRC,
            sourceType: 'DOU_RSS',
            url: 'https://jobs.example.test/1',
            linkedAt: '2026-11-01T00:00:00.000Z',
          },
        ],
        totalCount: 1,
        nextCursor: null,
      },
      possibleDuplicates: {
        items: [
          {
            opportunityId: SRC,
            title: 'Engineer',
            companyName: null,
            submittedSeniorNames: ['Senior One'],
          },
        ],
        totalCount: 6,
      },
    })
  })

  const tailCard = (scope: JobQueueScope, row: Record<string, unknown>, seniors: Rows = []) =>
    harness(scope, [row], seniors, [{ total: String(seniors.length) }], [], [{ total: '0' }], [])

  it('the dismissal is this scope row and its version; none is null (Task 7.3b)', async () => {
    const live = await tailCard(teamScope, cardDbRow({ dismissal_version: 3 })).svc.card(user, OPP)
    expect(live.dismissal).toEqual({ scope: 'TEAM', version: 3 })
    const studio = await tailCard({ kind: 'STUDIO' }, cardDbRow({ dismissal_version: '2' })).svc.card(user, OPP) // prettier-ignore
    expect(studio.dismissal).toEqual({ scope: 'STUDIO', version: 2 })
    const none = await tailCard(teamScope, cardDbRow()).svc.card(user, OPP)
    expect(none.dismissal).toBeNull()
    // Unreachable in production (NONE is refused before the read); the type still has no scope.
    const noScope = await tailCard({ kind: 'NONE' }, cardDbRow({ dismissal_version: 3 })).svc.card(user, OPP) // prettier-ignore
    expect(noScope.dismissal).toBeNull()
  })

  it('an unmatched card states its reason; the stack is clipped and capped (Task 7.3b)', async () => {
    const stack = [`${'s'.repeat(101)}`, ...Array.from({ length: 60 }, (_, i) => `k${i}`)]
    const card = await tailCard(
      teamScope,
      cardDbRow({ matched: '0', stop_listed: '0', manual_team_id: TEAM, stack_keywords: stack }),
    ).svc.card(user, OPP)
    expect(card.noMatchReason).toBe('NO_MATCH')
    expect(card.stackKeywords).toHaveLength(60)
    expect(card.stackKeywords[0]).toHaveLength(100)
    expect(card.stackKeywords[59]).toBe('k58')
    const empty = await tailCard(teamScope, cardDbRow({ stack_keywords: null })).svc.card(user, OPP)
    expect(empty.stackKeywords).toEqual([])
  })

  it('the engagement form is mapped from the primary source text; unknown or none is null (SPEC-M-1)', async () => {
    const form = async (employment_type: unknown) =>
      (await tailCard(teamScope, cardDbRow({ employment_type })).svc.card(user, OPP)).engagementForm
    expect(await form('Employment contract')).toBe('EMPLOYMENT')
    expect(await form('b2b')).toBe('B2B')
    expect(await form('full_time')).toBeNull()
    expect(await form(null)).toBeNull()
  })

  it('the stack names each token once, deduped after clipping, before the cap', async () => {
    const long = 's'.repeat(100)
    const stack = [
      'go',
      'go',
      `${long}a`,
      `${long}b`,
      ...Array.from({ length: 60 }, (_, i) => `k${i}`),
    ]
    const card = await tailCard(teamScope, cardDbRow({ stack_keywords: stack })).svc.card(user, OPP)
    expect(card.stackKeywords.slice(0, 3)).toEqual(['go', long, 'k0'])
    expect(card.stackKeywords).toHaveLength(60)
    expect(card.stackKeywords[59]).toBe('k57')
  })

  it('a STUDIO card names each senior team; a senior with no live team is null (Task 7.3b)', async () => {
    const card = await tailCard({ kind: 'STUDIO' }, cardDbRow(), [
      seniorDbRow({ team_id: TEAM, team_name: 't'.repeat(256) }),
      seniorDbRow({ senior_id: SEN_2, team_id: null, team_name: null }),
    ]).svc.card(user, OPP)
    expect(card.seniors.items[0]?.team).toEqual({ teamId: TEAM, teamName: 't'.repeat(255) })
    expect(card.seniors.items[1]?.team).toBeNull()
    expect(card.seniors.items[1]).toHaveProperty('team')
  })

  it('a TEAM card drops a team column even if one arrived (defence in depth)', async () => {
    const card = await tailCard(teamScope, cardDbRow(), [
      seniorDbRow({ team_id: OTHER_TEAM, team_name: 'Other' }),
    ]).svc.card(user, OPP)
    expect(card.seniors.items[0]).not.toHaveProperty('team')
  })

  it('a duplicate without submissions names nobody; names are clipped and capped', async () => {
    const dup = (names: unknown) =>
      harness(
        teamScope,
        [cardDbRow()],
        [],
        [{ total: '0' }],
        [],
        [{ total: '0' }],
        [{ id: SRC, title: 'D', employer_name: null, total: '1', submitted_senior_names: names }],
      ).svc.card(user, OPP)
    expect((await dup(null)).possibleDuplicates?.items[0]?.submittedSeniorNames).toEqual([])
    const many = Array.from({ length: 201 }, (_, i) => `n${i}`)
    const capped = (await dup(['x'.repeat(256), ...many])).possibleDuplicates?.items[0]
    expect(capped?.submittedSeniorNames).toHaveLength(200)
    expect(capped?.submittedSeniorNames[0]).toHaveLength(255)
  })

  it('without an active source link it is the same 404, and reads nothing further', async () => {
    const h = harness(teamScope, [])
    expect(await refusal(h.svc.card(user, OPP))).toEqual(NOT_FOUND)
    expect(h.execute).toHaveBeenCalledTimes(1)
  })

  it('an uppercase id reads the canonical one', async () => {
    const upper = 'ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF'
    const h = harness(teamScope, [])
    await refusal(h.svc.card(user, upper))
    expect(h.compiled(0).params).toContain(upper.toLowerCase())
  })

  it('no description is empty text, an oversized one is clipped; newer-than-list is exact', async () => {
    const tail = (row: Record<string, unknown>) =>
      harness(teamScope, [row], [], [{ total: '0' }], [], [{ total: '0' }], [])
    const none = await tail(cardDbRow({ description: null, newer_than_list: true })).svc.card(
      user,
      OPP,
    )
    expect(none).toMatchObject({ descriptionMd: '', newerThanList: true, possibleDuplicates: null })
    const big = await tail(cardDbRow({ description: 'x'.repeat(50001), newer_than_list: 'true' })).svc.card(user, OPP) // prettier-ignore
    expect(big.descriptionMd).toHaveLength(50000)
    expect(big.newerThanList).toBe(false)
  })

  it('previews stop at 200 seniors and 20 sources and continue independently', async () => {
    const seniors = Array.from({ length: 201 }, (_, i) => seniorDbRow({ senior_id: uuidOf(i) }))
    const sources = Array.from({ length: 21 }, (_, i) => sourceDbRow(uuidOf(i)))
    const h = harness(
      teamScope,
      [cardDbRow()],
      seniors,
      [{ total: '250' }],
      sources,
      [{ total: '30' }],
      [],
    )
    const card = await h.svc.card(user, OPP)
    expect(card.seniors.items).toHaveLength(200)
    expect(card.seniors.totalCount).toBe(250)
    expect(card.sources.items).toHaveLength(20)
    expect(card.sources.totalCount).toBe(30)
    expect(h.compiled(1).params).toContain(201)
    expect(h.compiled(3).params).toContain(21)
    const e = Math.floor(NOW.getTime() / 1000) + 900
    expect(parseCursor(card.seniors.nextCursor as string, 'SEN', SECRET)).toEqual({
      t: 'SEN',
      g: OPP,
      k: uuidOf(199),
      s: continuationSig(),
      e,
    })
    expect(parseCursor(card.sources.nextCursor as string, 'SRC', SECRET)).toEqual({
      t: 'SRC',
      g: OPP,
      k: uuidOf(19),
      s: continuationSig(),
      e,
    })
  })

  it('previews exactly at their bound have no next cursor', async () => {
    const seniors = Array.from({ length: 200 }, (_, i) => seniorDbRow({ senior_id: uuidOf(i) }))
    const sources = Array.from({ length: 20 }, (_, i) => sourceDbRow(uuidOf(i)))
    const h = harness(teamScope, [cardDbRow()], seniors, [{ total: '200' }], sources, [{ total: '20' }], []) // prettier-ignore
    const card = await h.svc.card(user, OPP)
    expect(card.seniors.nextCursor).toBeNull()
    expect(card.sources.nextCursor).toBeNull()
  })

  it('a failure on the way is the policy wrapper, around the whole read', async () => {
    const h = harness(teamScope, [cardDbRow()])
    h.scopes.policy.mockImplementation(async () => {
      throw new HttpException({ code: 'JOB_QUEUE_POLICY_UNAVAILABLE' }, 503)
    })
    expect(await refusal(h.svc.card(user, OPP))).toEqual({
      status: 503,
      code: 'JOB_QUEUE_POLICY_UNAVAILABLE',
    })
  })
})

describe('JobQueueService continuations', () => {
  it('seniors: no cursor is the first page, in this scope', async () => {
    const h = harness(teamScope, [seniorDbRow()], [{ total: '1' }])
    const page = await h.svc.seniors(user, OPP, { teamId: TEAM })
    expect(h.scopes.resolve).toHaveBeenCalledWith(user, TEAM, h.db)
    expect(h.scopes.assertVisible).toHaveBeenCalledWith(teamScope, OPP, h.db)
    expect(page.items.map((s) => s.seniorId)).toEqual([SEN])
    expect(page.totalCount).toBe(1)
    expect(h.compiled(0).text).not.toContain('ms.senior_id > $')
  })

  it('seniors: a cursor resumes after its key', async () => {
    const h = harness(teamScope, [], [{ total: '1' }])
    const page = await h.svc.seniors(user, OPP, { cursor: seekCursor('SEN') })
    expect(page.items).toEqual([])
    expect(h.compiled(0).text).toContain('ms.senior_id > $')
    expect(h.compiled(0).params).toContain(SEN)
  })

  it('sources: a cursor resumes after its key', async () => {
    const h = harness(teamScope, [sourceDbRow()], [{ total: '2' }])
    const page = await h.svc.sources(user, OPP, { cursor: seekCursor('SRC', { k: SRC }) })
    expect(page.items.map((s) => s.sourceRecordId)).toEqual([SRC])
    expect(page.totalCount).toBe(2)
    expect(h.compiled(0).text).toContain('s.source_record_id > $')
    expect(h.compiled(0).params).toContain(SRC)
  })

  it.each([
    ['seniors', 'SRC'],
    ['sources', 'SEN'],
  ] as const)(
    '%s refuses a cursor of the other kind as malformed, before visibility',
    async (m, t) => {
      const h = harness(teamScope)
      expect(await refusal(h.svc[m](user, OPP, { cursor: seekCursor(t) }))).toEqual(MALFORMED)
      expect(h.scopes.assertVisible).not.toHaveBeenCalled()
    },
  )

  it('the role is refused before the cursor is looked at', async () => {
    const h = harness(teamScope)
    h.scopes.resolve.mockRejectedValue(new ForbiddenException())
    await expect(h.svc.seniors(user, OPP, { cursor: 'forged' })).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('a cursor for another opportunity must refresh, reading nothing', async () => {
    const h = harness(teamScope)
    const s = requestSignature([ACTOR, policySignature(teamScope, versions), SEN])
    expect(await refusal(h.svc.seniors(user, OPP, { cursor: seekCursor('SEN', { s }) }))).toEqual(
      REFRESH,
    )
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('an expired continuation must refresh', async () => {
    const h = harness(teamScope)
    const cursor = seekCursor('SRC', { e: Math.floor(LATER.getTime() / 1000) - 600 })
    expect(await refusal(h.svc.sources(user, OPP, { cursor }))).toEqual(REFRESH)
  })

  it('a visibility miss on a continuation is the 404, with a valid cursor too', async () => {
    const h = harness(teamScope)
    h.scopes.assertVisible.mockRejectedValue(new HttpException({ code: NOT_FOUND.code }, 404))
    expect(await refusal(h.svc.sources(user, OPP, { cursor: seekCursor('SRC') }))).toEqual(
      NOT_FOUND,
    )
    expect(h.execute).not.toHaveBeenCalled()
  })

  it('both continuations run inside the policy wrapper', async () => {
    const h = harness(teamScope, [], [{ total: '0' }], [], [{ total: '0' }])
    await h.svc.seniors(user, OPP, {})
    expect(h.scopes.policy).toHaveBeenCalledTimes(1)
    await h.svc.sources(user, OPP, {})
    expect(h.scopes.policy).toHaveBeenCalledTimes(2)
  })
})
