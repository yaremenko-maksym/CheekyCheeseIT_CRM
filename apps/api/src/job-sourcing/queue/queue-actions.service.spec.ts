import { ForbiddenException, HttpException } from '@nestjs/common'
import type { SessionUser } from '@crm/shared'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import type { DatabaseService } from '../../database/database.service'
import { requestFingerprint } from './queue-actions'
import { JobQueueActionsService } from './queue-actions.service'
import type { JobQueueScope } from './queue-scope'
import type { JobQueueScopeService } from './queue-scope.service'

/**
 * r5 Task 6.3 — the service's branches against a scripted transaction, so the mutation gate can see
 * them (`mutation-gate-integration-specs.md`). What the database itself decides (grants, locks,
 * races, raw JSON through a real response) is `queue-actions.integration.spec.ts`.
 */
const OPP = '10000000-0000-4000-8000-000000000001'
const COPY = '10000000-0000-4000-8000-000000000002'
const SENIOR = '30000000-0000-4000-8000-000000000001'
const HR_ID = '40000000-0000-4000-8000-000000000001'
const ADMIN_ID = '40000000-0000-4000-8000-000000000002'
const OTHER_HR = '40000000-0000-4000-8000-000000000003'
const TEAM_A = '50000000-0000-4000-8000-00000000000a'
const TEAM_B = '50000000-0000-4000-8000-00000000000b'
const SUB = '60000000-0000-4000-8000-000000000001'
const NEW_SUB = '60000000-0000-4000-8000-000000000002'
const KEY = '70000000-0000-4000-8000-000000000001'
const SOURCE = '80000000-0000-4000-8000-000000000001'
const CARD = '10000000-0000-4000-8000-0000000000c1'
const RESUME = 'a0000000-0000-4000-8000-000000000001'
const T1 = '2026-11-04T10:00:00.000Z'
const T2 = '2026-11-04T11:00:00.000Z'

const HR = { id: HR_ID, role: 'HR' } as SessionUser
const ADMIN = { id: ADMIN_ID, role: 'ADMIN' } as SessionUser

const TEAM_SCOPE: JobQueueScope = {
  kind: 'TEAM',
  teamId: TEAM_A,
  seniorIds: [SENIOR],
  versions: [],
  inputsVersion: 'inputs-v1',
}
const STUDIO_SCOPE: JobQueueScope = { kind: 'STUDIO' }

type Rows = Array<Record<string, unknown>>
interface Call {
  text: string
  params: unknown[]
}

/** Named statements of the service: the first matching pattern answers. */
const PATTERNS = {
  // First: `loadOpportunity` joins tables other patterns name.
  canonical: /b\.text AS description/,
  lockSet: /FROM job_opportunities t JOIN job_opportunities d/,
  lockTarget: /SELECT id FROM job_opportunities WHERE id = /,
  earlier: /SELECT reason, after_version, created_at, opportunity_id FROM job_queue_actions/,
  blob: /INSERT INTO job_text_blobs/,
  urlLock: /pg_advisory_xact_lock/,
  urlTaken: /SELECT 1 FROM job_opportunities WHERE application_url_key/,
  card: /INSERT INTO job_opportunities/,
  resume: /FROM senior_resumes/,
  actor: /SELECT id FROM users/,
  membership: /SELECT id FROM team_members/,
  senior: /SELECT tm\.team_id FROM team_members tm/,
  team: /SELECT id FROM teams/,
  ownManual: /FROM job_exclusion_filters/,
  ownProjects: /FROM projects/,
  existing: /SELECT id, state, team_id, version FROM job_queue_assignments/,
  duplicates: /SELECT a\.opportunity_id FROM job_queue_assignments a/,
  remove: /DELETE FROM job_queue_assignments/,
  insert: /INSERT INTO job_queue_assignments/,
  reopen: /UPDATE job_queue_assignments SET state = 'TAKEN'/,
  cancelRead: /SELECT a\.senior_id, a\.assignee_id/,
  cancelWrite: /UPDATE job_queue_assignments SET state = 'RELEASED'/,
  dismissal: /SELECT version, reason, undone_at FROM job_queue_dismissals/,
  dismissInsert: /INSERT INTO job_queue_dismissals/,
  redismiss: /UPDATE job_queue_dismissals SET reason/,
  undoWrite: /UPDATE job_queue_dismissals SET undone_at/,
  link: /FROM job_opportunity_sources/,
  opened: /INSERT INTO job_queue_actions .*'OPENED'/,
  log: /INSERT INTO job_queue_actions/,
  name: /SELECT display_name FROM users/,
} as const
type Statement = keyof typeof PATTERNS

const COPY_ROW = {
  id: OPP,
  revision: 4,
  title: 'Go Developer',
  employer_name: 'Acme',
}

/** What `loadOpportunity` reads; the exclusion check takes its posting from this row. */
const CANONICAL_ROW = {
  id: OPP,
  revision: 4,
  title: 'Go Developer',
  employer_name: 'Acme',
  location: null,
  stack_keywords: [],
  application_url: null,
  availability: 'OPEN',
  first_seen_at: new Date(T1),
  description: null,
  normalized: null,
  evidence: null,
  source_type: 'DJINNI',
  source_url: 'https://djinni.test/jobs/1',
  on_demand_missing: [],
  on_demand_stale: [],
  grants: [],
}

const DEFAULTS: Partial<Record<Statement, Rows>> = {
  canonical: [CANONICAL_ROW],
  team: [{ id: TEAM_A }],
  lockSet: [COPY_ROW],
  lockTarget: [{ id: OPP }],
  earlier: [],
  blob: [],
  urlLock: [],
  urlTaken: [],
  card: [{ id: CARD }],
  resume: [{ id: RESUME }],
  actor: [{ id: HR_ID }],
  membership: [{ id: 'm' }],
  senior: [{ team_id: TEAM_A }],
  ownManual: [],
  ownProjects: [],
  existing: [],
  duplicates: [],
  remove: [],
  insert: [{ id: NEW_SUB, version: 1, taken_at: new Date(T1) }],
  reopen: [{ id: SUB, version: 3, taken_at: new Date(T1) }],
  dismissal: [],
  dismissInsert: [{ version: 1 }],
  redismiss: [{ version: 3 }],
  undoWrite: [{ version: 3 }],
  link: [{ linked: 1 }],
  opened: [],
  log: [],
  name: [{ display_name: 'Rita Recruiter' }],
}

function harness(
  answers: Partial<Record<Statement, Rows | Error>> = {},
  scope: JobQueueScope = TEAM_SCOPE,
) {
  const calls: Call[] = []
  const hits: Statement[] = []
  const execute = vi.fn(async (query: SQL) => {
    const compiled = new PgDialect().sqlToQuery(query)
    const text = compiled.sql.replace(/\s+/g, ' ').trim()
    calls.push({ text, params: compiled.params })
    const name = (Object.keys(PATTERNS) as Statement[]).find((k) => PATTERNS[k].test(text))
    if (name === undefined) throw new Error(`unexpected query: ${text}`)
    hits.push(name)
    const answer = answers[name] ?? DEFAULTS[name]
    if (answer === undefined) throw new Error(`no answer scripted for ${name}`)
    if (answer instanceof Error) throw answer
    return { rows: answer }
  })
  const tx = { execute }
  const transaction = vi.fn(async (body: (t: typeof tx) => Promise<unknown>) => body(tx))
  const scopes = {
    resolve: vi.fn(async () => scope),
    assertVisible: vi.fn(async () => undefined),
    policy: vi.fn(<T>(fn: () => Promise<T>) => fn()),
  }
  const svc = new JobQueueActionsService(
    { db: { transaction, execute } } as unknown as DatabaseService,
    scopes as unknown as JobQueueScopeService,
  )
  const param = (statement: Statement): unknown[] =>
    calls.find((c) => PATTERNS[statement].test(c.text))?.params ?? []
  return { svc, hits, calls, tx, transaction, scopes, param }
}

async function refusal(
  p: Promise<unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const e: unknown = await p.then(
    () => new Error('expected a refusal, got a result'),
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(HttpException)
  const http = e as HttpException
  return { status: http.getStatus(), body: http.getResponse() as Record<string, unknown> }
}

async function expectCode(p: Promise<unknown>, status: number, code: string): Promise<void> {
  const r = await refusal(p)
  expect(r.status).toBe(status)
  expect(r.body['code']).toBe(code)
}
const expectNotFound = (p: Promise<unknown>) => expectCode(p, 404, 'JOB_OPPORTUNITY_NOT_FOUND')
const expectStale = (p: Promise<unknown>) => expectCode(p, 409, 'JOB_QUEUE_VERSION_CONFLICT')

const submitBody = (over: Record<string, unknown> = {}) => ({
  seniorId: SENIOR,
  idempotencyKey: KEY,
  expectedOpportunityRevision: 4,
  confirmPossibleDuplicate: false,
  ...over,
})
const SUBMIT_FP = requestFingerprint(['TAKEN', OPP, 'TEAM', TEAM_A, SENIOR, 4, null, false])
const WRITES: Statement[] = ['remove', 'insert', 'reopen', 'log']
const noWrites = (hits: Statement[]) => expect(hits.filter((h) => WRITES.includes(h))).toEqual([])

describe('submit — a first submission', () => {
  it('writes the row and its action in one transaction, in the plan order', async () => {
    const h = harness()
    const res = await h.svc.submit(HR, OPP, submitBody())
    expect(res).toEqual({
      submission: {
        id: NEW_SUB,
        opportunityId: OPP,
        seniorId: SENIOR,
        state: 'TAKEN',
        submittedAt: T1,
        cancelledAt: null,
        version: 1,
        submittedByName: 'Rita Recruiter',
      },
    })
    expect(h.transaction).toHaveBeenCalledTimes(1)
    expect(h.hits).toEqual([
      'lockSet',
      'actor',
      'team',
      'membership',
      'earlier',
      'senior',
      'canonical',
      'ownManual',
      'ownProjects',
      'existing',
      'insert',
      'log',
      'name',
    ])
    // The scope and the visibility answer come from inside the transaction.
    expect(h.scopes.resolve).toHaveBeenCalledWith(HR, undefined, h.tx)
    expect(h.scopes.assertVisible).toHaveBeenCalledWith(TEAM_SCOPE, OPP, h.tx)
  })

  it('stores the row in the request scope, for the authenticated actor', async () => {
    const h = harness()
    await h.svc.submit(HR, OPP, submitBody())
    // An ordinary submit names no resume: resume_id is NULL.
    expect(h.param('insert')).toEqual([OPP, SENIOR, 'TEAM', TEAM_A, HR_ID, null])
  })

  it('logs TAKEN from version 0 to 1 with the replay in the reason', async () => {
    const h = harness()
    await h.svc.submit(HR, OPP, submitBody())
    const [kind, opp, actor, scopeKind, team, before, after, key, reason] = h.param('log')
    expect([kind, opp, actor, scopeKind, team, before, after, key]).toEqual([
      'TAKEN',
      OPP,
      HR_ID,
      'TEAM',
      TEAM_A,
      0,
      1,
      KEY,
    ])
    expect(JSON.parse(reason as string)).toEqual({
      fp: SUBMIT_FP,
      submissionId: NEW_SUB,
      submittedAt: T1,
    })
  })

  it('an ADMIN in STUDIO writes a STUDIO row with no team and needs no membership', async () => {
    const h = harness({}, STUDIO_SCOPE)
    await h.svc.submit(ADMIN, OPP, submitBody())
    expect(h.param('insert')).toEqual([OPP, SENIOR, 'STUDIO', null, ADMIN_ID, null])
    expect(h.hits).not.toContain('membership')
    expect(h.hits).not.toContain('team')
    expect(h.param('log').slice(3, 5)).toEqual(['STUDIO', null])
  })

  it('an ADMIN who named a team needs no membership of it', async () => {
    const h = harness()
    await h.svc.submit(ADMIN, OPP, submitBody())
    expect(h.hits).not.toContain('membership')
    expect(h.hits).toContain('team')
    expect(h.param('insert')[2]).toBe('TEAM')
  })

  it('asks the actor row for the live role, and the membership for the scope team', async () => {
    const h = harness()
    await h.svc.submit(HR, OPP, submitBody())
    expect(h.param('actor')).toEqual([HR_ID, 'HR'])
    expect(h.param('membership')).toEqual([TEAM_A, HR_ID])
    const actorSql = h.calls.find((c) => PATTERNS.actor.test(c.text))?.text
    expect(actorSql).toContain('archived_at IS NULL')
    expect(actorSql).toContain('FOR SHARE')
  })

  it('locks the live scope team for share, so an archival cannot commit under the write', async () => {
    const h = harness()
    await h.svc.submit(HR, OPP, submitBody())
    expect(h.param('team')).toEqual([TEAM_A])
    const text = h.calls.find((c) => PATTERNS.team.test(c.text))?.text
    expect(text).toContain('archived_at IS NULL')
    expect(text).toContain("type = 'SENIOR'")
    expect(text).toContain('FOR SHARE')
  })
})

describe('submit — refused before any write', () => {
  it('a malformed opportunity or senior id is a 404 without a transaction', async () => {
    const h = harness()
    await expectNotFound(h.svc.submit(HR, 'nope', submitBody()))
    await expectNotFound(h.svc.submit(HR, OPP, submitBody({ seniorId: 'nope' })))
    expect(h.transaction).not.toHaveBeenCalled()
  })

  it('accepts an uppercase spelling of both ids', async () => {
    const h = harness()
    await h.svc.submit(HR, OPP.toUpperCase(), submitBody({ seniorId: SENIOR.toUpperCase() }))
    expect(h.param('insert').slice(0, 2)).toEqual([OPP, SENIOR])
  })

  it('the NONE scope is a 404 before any statement', async () => {
    const h = harness({}, { kind: 'NONE' })
    await expectNotFound(h.svc.submit(HR, OPP, submitBody()))
    expect(h.hits).toEqual([])
  })

  it('an opportunity that does not exist is a 404', async () => {
    const h = harness({ lockSet: [] })
    await expectNotFound(h.svc.submit(HR, OPP, submitBody()))
    expect(h.hits).toEqual(['lockSet'])
  })

  it('an actor whose live role no longer matches is a 404', async () => {
    const h = harness({ actor: [] })
    await expectNotFound(h.svc.submit(HR, OPP, submitBody()))
    noWrites(h.hits)
  })

  it('a team archived since the scope was resolved is a 404', async () => {
    const h = harness({ team: [] })
    await expectNotFound(h.svc.submit(HR, OPP, submitBody()))
    expect(h.hits).not.toContain('membership')
    noWrites(h.hits)
  })

  it('an HR who has left the team is a 404', async () => {
    const h = harness({ membership: [] })
    await expectNotFound(h.svc.submit(HR, OPP, submitBody()))
    noWrites(h.hits)
  })

  it('a visibility miss propagates and stops the write', async () => {
    const h = harness()
    h.scopes.assertVisible.mockRejectedValueOnce(new HttpException({ code: 'X' }, 404))
    await expect(h.svc.submit(HR, OPP, submitBody())).rejects.toBeInstanceOf(HttpException)
    expect(h.hits).not.toContain('senior')
    noWrites(h.hits)
  })

  it('a senior who is no eligible member of the scope is a 404, filtered by the scope team', async () => {
    const h = harness({ senior: [] })
    await expectNotFound(h.svc.submit(HR, OPP, submitBody()))
    noWrites(h.hits)
    const seniorCall = h.calls.find((c) => PATTERNS.senior.test(c.text))
    expect(seniorCall?.params).toEqual([SENIOR, TEAM_A])
    expect(seniorCall?.text).toContain('tm.team_id = ')
    for (const clause of [
      'tm.left_at IS NULL',
      "u.role = 'SENIOR'",
      'u.archived_at IS NULL',
      't.archived_at IS NULL',
      "t.type = 'SENIOR'",
      'FOR SHARE OF tm, u, t',
    ]) {
      expect(seniorCall?.text).toContain(clause)
    }
  })

  const exclusion = (seniorId: string | null, value: string, kind = 'COMPANY') => ({
    id: '90000000-0000-4000-8000-000000000001',
    senior_id: seniorId,
    kind,
    value,
    normalized_value: value.toLowerCase(),
    created_at: new Date(T1),
  })

  it('a senior who stop-listed the company is a 404', async () => {
    const h = harness({ ownManual: [exclusion(SENIOR, 'Acme')] })
    await expectNotFound(h.svc.submit(HR, OPP, submitBody()))
    noWrites(h.hits)
  })

  it('a company on a project of the senior is a 404', async () => {
    const h = harness({
      ownProjects: [{ senior_id: SENIOR, name: 'P', company_name: 'Acme', archived_at: null }],
    })
    await expectNotFound(h.svc.submit(HR, OPP, submitBody()))
    noWrites(h.hits)
  })

  it('a stop-list entry matching only the DOU URL slug is a 404, as in the funnel', async () => {
    const answers = {
      canonical: [
        {
          ...CANONICAL_ROW,
          employer_name: 'Trading Name LLC',
          source_type: 'DOU_RSS',
          source_url: 'https://jobs.dou.ua/companies/slugonly/vacancies/1/',
        },
      ],
      ownManual: [exclusion(SENIOR, 'slugonly')],
    }
    const h = harness(answers)
    await expectNotFound(h.svc.submit(HR, OPP, submitBody()))
    noWrites(h.hits)
    const otherSource = harness({
      ...answers,
      canonical: [{ ...answers.canonical[0], source_type: 'DJINNI' }],
    })
    await expect(otherSource.svc.submit(HR, OPP, submitBody())).resolves.toBeDefined()
  })

  it('asks for this senior only, and the posting of this opportunity', async () => {
    const h = harness()
    await h.svc.submit(HR, OPP, submitBody())
    expect(h.param('canonical')).toContain(OPP)
    const texts = h.calls.map((c) => c.text)
    expect(texts).toContainEqual(
      expect.stringContaining(
        'SELECT id, senior_id, kind, value, normalized_value, created_at FROM job_exclusion_filters',
      ),
    )
    expect(texts).toContainEqual(
      expect.stringContaining('SELECT senior_id, name, company_name, archived_at FROM projects'),
    )
    for (const statement of ['ownManual', 'ownProjects'] as const) {
      expect(h.param(statement)).toEqual([SENIOR])
      const text = h.calls.find((c) => PATTERNS[statement].test(c.text))?.text
      expect(text).toContain('WHERE senior_id = ')
      expect(text).not.toContain('IS NULL')
    }
    expect(h.calls.filter((c) => c.text.includes('tech_stack'))).toEqual([])
  })

  it('an opportunity the posting read no longer finds is a 404', async () => {
    const h = harness({ canonical: [] })
    await expectNotFound(h.svc.submit(HR, OPP, submitBody()))
    expect(h.hits).not.toContain('ownManual')
    noWrites(h.hits)
  })

  it('a stop-list keyword matches the title; an unnamed employer matches nothing else', async () => {
    const keyword = harness({ ownManual: [exclusion(SENIOR, 'Developer', 'KEYWORD')] })
    await expectNotFound(keyword.svc.submit(HR, OPP, submitBody()))
    const unnamed = harness({
      canonical: [{ ...CANONICAL_ROW, employer_name: null }],
      ownManual: [exclusion(SENIOR, 'Acme')],
    })
    await expect(unnamed.svc.submit(HR, OPP, submitBody())).resolves.toBeDefined()
    expect(unnamed.param('insert')).toHaveLength(6)
  })

  it('reads the revision and company of the target, wherever it sorts in the set', async () => {
    const lowerCopy = {
      ...COPY_ROW,
      id: '00000000-0000-4000-8000-000000000001',
      revision: 99,
      employer_name: 'Other',
    }
    const h = harness({
      lockSet: [lowerCopy, COPY_ROW],
      ownManual: [exclusion(SENIOR, 'Other')],
    })
    await expect(h.svc.submit(HR, OPP, submitBody())).resolves.toBeDefined()
    expect(h.param('insert')[0]).toBe(OPP)
  })

  it('a stale opportunity revision is the generic conflict', async () => {
    const h = harness()
    await expectStale(h.svc.submit(HR, OPP, submitBody({ expectedOpportunityRevision: 3 })))
    noWrites(h.hits)
    expect(h.hits).not.toContain('existing')
  })
})

describe('submit — an existing row (owner decision A3)', () => {
  const foreign = (state: 'TAKEN' | 'RELEASED') => ({
    id: SUB,
    state,
    team_id: TEAM_B,
    version: 7,
  })
  const own = (state: 'TAKEN' | 'RELEASED') => ({ ...foreign(state), team_id: TEAM_A, version: 2 })

  it('another team LIVE row: a conflict holding only the marker', async () => {
    const h = harness({ existing: [foreign('TAKEN')] })
    const r = await refusal(h.svc.submit(HR, OPP, submitBody()))
    expect(r.status).toBe(409)
    expect(r.body).toEqual({
      statusCode: 409,
      code: 'JOB_QUEUE_VERSION_CONFLICT',
      message: 'The data has changed. Refresh the card and try again.',
      submittedElsewhere: true,
    })
    const raw = JSON.stringify(r.body)
    for (const leak of [SUB, TEAM_B, '"version"', 'submittedAt', 'teamId', 'submittedByName']) {
      expect(raw).not.toContain(leak)
    }
    noWrites(h.hits)
  })

  it('the own LIVE row: the generic conflict, with no marker', async () => {
    const h = harness({ existing: [own('TAKEN')] })
    const r = await refusal(h.svc.submit(HR, OPP, submitBody()))
    expect(r.status).toBe(409)
    expect(r.body['code']).toBe('JOB_QUEUE_VERSION_CONFLICT')
    expect(r.body).not.toHaveProperty('submittedElsewhere')
  })

  it('another team CANCELLED row: DELETE + INSERT, version 1, logged as a first submission', async () => {
    const h = harness({ existing: [foreign('RELEASED')] })
    const res = await h.svc.submit(HR, OPP, submitBody())
    expect(h.hits.indexOf('remove')).toBeLessThan(h.hits.indexOf('insert'))
    expect(h.param('remove')).toEqual([SUB])
    expect(res.submission.id).toBe(NEW_SUB)
    expect(res.submission.version).toBe(1)
    expect(h.param('log').slice(5, 7)).toEqual([0, 1])
    const raw = JSON.stringify(res) + JSON.stringify(h.param('log'))
    expect(raw).not.toContain(SUB)
    expect(raw).not.toContain(TEAM_B)
    expect(h.hits).not.toContain('reopen')
  })

  it('another team CANCELLED row with a named version is the conflict no row gives', async () => {
    const withRow = harness({ existing: [foreign('RELEASED')] })
    const noRow = harness()
    const a = await refusal(withRow.svc.submit(HR, OPP, submitBody({ expectedVersion: 7 })))
    const b = await refusal(noRow.svc.submit(HR, OPP, submitBody({ expectedVersion: 7 })))
    expect(a).toEqual(b)
    expect(withRow.hits).not.toContain('remove')
  })

  it('the own CANCELLED row: the versioned UPDATE of the same row', async () => {
    const h = harness({ existing: [own('RELEASED')] })
    const res = await h.svc.submit(HR, OPP, submitBody({ expectedVersion: 2 }))
    expect(h.param('reopen')).toEqual([HR_ID, SUB, 2])
    expect(res.submission).toMatchObject({ id: SUB, version: 3, state: 'TAKEN', cancelledAt: null })
    expect(h.param('log').slice(5, 7)).toEqual([2, 3])
    expect(h.hits).not.toContain('remove')
    expect(h.hits).not.toContain('insert')
  })

  it('a STUDIO cancelled row is the STUDIO scope own: UPDATE; a STUDIO live row is its own conflict', async () => {
    const studioRow = { id: SUB, team_id: null, version: 2 }
    const reopen = harness({ existing: [{ ...studioRow, state: 'RELEASED' }] }, STUDIO_SCOPE)
    await reopen.svc.submit(ADMIN, OPP, submitBody({ expectedVersion: 2 }))
    expect(reopen.hits).toContain('reopen')
    expect(reopen.hits).not.toContain('remove')
    const live = harness({ existing: [{ ...studioRow, state: 'TAKEN' }] }, STUDIO_SCOPE)
    const r = await refusal(live.svc.submit(ADMIN, OPP, submitBody()))
    expect(r.body).not.toHaveProperty('submittedElsewhere')
  })

  it('the UPDATE clears the release fields and takes the new actor', async () => {
    const h = harness({ existing: [own('RELEASED')] })
    await h.svc.submit(HR, OPP, submitBody({ expectedVersion: 2 }))
    const reopen = h.calls.find((c) => PATTERNS.reopen.test(c.text))?.text
    for (const clause of [
      'released_at = NULL',
      'released_by = NULL',
      'release_reason = NULL',
      'version = version + 1',
      "state = 'RELEASED'",
    ]) {
      expect(reopen).toContain(clause)
    }
  })

  it('a conditional UPDATE that matched nothing is the generic conflict', async () => {
    const h = harness({ existing: [own('RELEASED')], reopen: [] })
    await expectStale(h.svc.submit(HR, OPP, submitBody({ expectedVersion: 2 })))
    expect(h.hits).not.toContain('log')
  })

  it('an own CANCELLED row at a stale version is the generic conflict', async () => {
    const h = harness({ existing: [own('RELEASED')] })
    await expectStale(h.svc.submit(HR, OPP, submitBody({ expectedVersion: 1 })))
    noWrites(h.hits)
  })
})

describe('submit — possible duplicates', () => {
  const copies = (n: number) => [
    COPY_ROW,
    ...Array.from({ length: n }, (_, i) => ({
      ...COPY_ROW,
      id: `10000000-0000-4000-8000-00000000010${i}`,
      title: `Copy ${i}`,
      employer_name: i === 0 ? null : 'Acme',
    })),
  ]

  it('asks nothing when the target has no copy', async () => {
    const h = harness()
    await h.svc.submit(HR, OPP, submitBody())
    expect(h.hits).not.toContain('duplicates')
  })

  it('a live submission of the senior on a copy is the 409 with the authorized preview only', async () => {
    const set = copies(2)
    const h = harness({ lockSet: set, duplicates: [{ opportunity_id: set[1]?.id }] })
    const r = await refusal(h.svc.submit(HR, OPP, submitBody()))
    expect(r.status).toBe(409)
    expect(r.body).toEqual({
      code: 'JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED',
      possibleDuplicates: {
        items: [{ opportunityId: set[1]?.id, title: 'Copy 0', companyName: null }],
        totalCount: 1,
      },
    })
    noWrites(h.hits)
  })

  it('the preview names the employer of a copy that has one', async () => {
    const set = copies(2)
    const h = harness({ lockSet: set, duplicates: [{ opportunity_id: set[2]?.id }] })
    const r = await refusal(h.svc.submit(HR, OPP, submitBody()))
    expect(r.body['possibleDuplicates']).toEqual({
      items: [{ opportunityId: set[2]?.id, title: 'Copy 1', companyName: 'Acme' }],
      totalCount: 1,
    })
  })

  it('asks about the other copies only, for this senior, in the scope', async () => {
    const set = copies(1)
    const h = harness({ lockSet: set })
    await h.svc.submit(HR, OPP, submitBody())
    const call = h.calls.find((c) => PATTERNS.duplicates.test(c.text))
    expect(call?.params[0]).toBe(SENIOR)
    expect(call?.params[1]).toBe(JSON.stringify([set[1]?.id]))
    expect(call?.params).toContain(TEAM_A)
    expect(call?.text).toContain("a.state = 'TAKEN'")
    expect(call?.text).toContain('a.team_id = ')
    expect(call?.text).toContain('EXISTS (SELECT 1 FROM job_opportunity_matches')
    expect(call?.text).toContain('m.opportunity_id = a.opportunity_id')
  })

  it('bounds the preview at five and still counts them all', async () => {
    const set = copies(6)
    const h = harness({
      lockSet: set,
      duplicates: set.slice(1).map((c) => ({ opportunity_id: c.id })),
    })
    const r = await refusal(h.svc.submit(HR, OPP, submitBody()))
    const preview = r.body['possibleDuplicates'] as { items: unknown[]; totalCount: number }
    expect(preview.items).toHaveLength(5)
    expect(preview.totalCount).toBe(6)
  })

  it('no claimed copy passes without confirmation', async () => {
    const h = harness({ lockSet: copies(1) })
    await expect(h.svc.submit(HR, OPP, submitBody())).resolves.toBeDefined()
    expect(h.hits).toContain('duplicates')
  })

  it('a confirmation skips the check', async () => {
    const h = harness({ lockSet: copies(1) })
    await h.svc.submit(HR, OPP, submitBody({ confirmPossibleDuplicate: true }))
    expect(h.hits).not.toContain('duplicates')
    expect(h.hits).toContain('insert')
  })

  it('the existing-row answer comes before the duplicates answer', async () => {
    const h = harness({
      lockSet: copies(1),
      existing: [{ id: SUB, state: 'TAKEN', team_id: TEAM_A, version: 1 }],
    })
    await expectStale(h.svc.submit(HR, OPP, submitBody()))
    expect(h.hits).not.toContain('duplicates')
  })

  it('takes the sorted set from one locking statement', async () => {
    const h = harness()
    await h.svc.submit(HR, OPP, submitBody())
    const text = h.calls.find((c) => PATTERNS.lockSet.test(c.text))?.text
    expect(text).toContain('ORDER BY d.id FOR NO KEY UPDATE OF d')
    expect(text).toContain('t.employer_key IS NOT NULL')
    expect(text).toContain('d.title_key = t.title_key')
  })
})

describe('submit — a retry', () => {
  const earlier = (over: Record<string, unknown> = {}) => [
    {
      reason: JSON.stringify({
        fp: SUBMIT_FP,
        submissionId: SUB,
        submittedAt: T1,
        ...over,
      }),
      after_version: 5,
      created_at: new Date(T2),
    },
  ]

  it('answers the earlier success from the log, touching no row', async () => {
    const h = harness({ earlier: earlier() })
    const res = await h.svc.submit(HR, OPP, submitBody())
    expect(res).toEqual({
      submission: {
        id: SUB,
        opportunityId: OPP,
        seniorId: SENIOR,
        state: 'TAKEN',
        submittedAt: T1,
        cancelledAt: null,
        version: 5,
        submittedByName: 'Rita Recruiter',
      },
    })
    expect(h.hits).toEqual(['lockSet', 'actor', 'team', 'membership', 'earlier', 'name'])
    expect(h.param('earlier')).toEqual([HR_ID, KEY])
    // Neither the senior nor the assignee is in the log: the request and the actor give them.
    expect(h.param('name')).toEqual([HR_ID])
  })

  it('a name that cannot be read is null, never a failed retry', async () => {
    const h = harness({ earlier: earlier(), name: [] })
    const res = await h.svc.submit(HR, OPP, submitBody())
    expect(res.submission.submittedByName).toBeNull()
  })

  it('the same key with another payload is the idempotency conflict', async () => {
    const h = harness({ earlier: earlier({ fp: 'other' }) })
    await expectCode(h.svc.submit(HR, OPP, submitBody()), 409, 'JOB_QUEUE_IDEMPOTENCY_CONFLICT')
  })

  it('a key whose reason was redacted cannot be proved: the idempotency conflict', async () => {
    const h = harness({
      earlier: [{ reason: '[redacted]', after_version: 1, created_at: new Date(T1) }],
    })
    await expectCode(h.svc.submit(HR, OPP, submitBody()), 409, 'JOB_QUEUE_IDEMPOTENCY_CONFLICT')
  })

  it('every field of the request is part of its identity', async () => {
    for (const change of [
      { seniorId: COPY },
      { expectedOpportunityRevision: 5 },
      { expectedVersion: 1 },
      { confirmPossibleDuplicate: true },
    ]) {
      const h = harness({ earlier: earlier() })
      await expectCode(
        h.svc.submit(HR, OPP, submitBody(change)),
        409,
        'JOB_QUEUE_IDEMPOTENCY_CONFLICT',
      )
    }
  })

  it('the scope is part of the identity too', async () => {
    const h = harness({ earlier: earlier() }, STUDIO_SCOPE)
    await expectCode(h.svc.submit(ADMIN, OPP, submitBody()), 409, 'JOB_QUEUE_IDEMPOTENCY_CONFLICT')
  })
})

describe('cancelSubmission', () => {
  const body = { idempotencyKey: KEY, expectedVersion: 2 }
  const live = {
    senior_id: SENIOR,
    assignee_id: OTHER_HR,
    state: 'TAKEN',
    version: 2,
    taken_at: new Date(T1),
  }
  const answers = {
    cancelRead: [live],
    cancelWrite: [{ version: 3, released_at: new Date(T2) }],
  }
  const FP = requestFingerprint(['RELEASED', OPP, 'TEAM', TEAM_A, SUB, 2])

  it('cancels the row, keeps it, and logs RELEASED from the expected version', async () => {
    const h = harness(answers)
    const res = await h.svc.cancelSubmission(HR, OPP, SUB, body)
    expect(res).toEqual({
      submission: {
        id: SUB,
        opportunityId: OPP,
        seniorId: SENIOR,
        state: 'RELEASED',
        submittedAt: T1,
        cancelledAt: T2,
        version: 3,
        submittedByName: 'Rita Recruiter',
      },
    })
    expect(h.hits).toEqual([
      'lockTarget',
      'actor',
      'team',
      'membership',
      'cancelRead',
      'earlier',
      'cancelWrite',
      'log',
      'name',
    ])
    expect(h.param('name')).toEqual([OTHER_HR])
    expect(h.param('cancelWrite')).toEqual([HR_ID, SUB, 2])
    const logged = h.param('log')
    expect(logged.slice(0, 8)).toEqual(['RELEASED', OPP, HR_ID, 'TEAM', TEAM_A, 2, 3, KEY])
    expect(JSON.parse(logged[8] as string)).toEqual({
      fp: FP,
      submissionId: SUB,
      submittedAt: T1,
    })
  })

  it('reads the row by id, opportunity and scope; a TEAM scope filters on its team', async () => {
    const h = harness(answers)
    await h.svc.cancelSubmission(HR, OPP, SUB, body)
    expect(h.param('cancelRead')).toEqual([SUB, OPP, TEAM_A])
    expect(h.calls.find((c) => PATTERNS.cancelRead.test(c.text))?.text).toContain('a.team_id = ')
  })

  it('never calls assertVisible: a hidden opportunity can still have its record corrected', async () => {
    const h = harness(answers)
    await h.svc.cancelSubmission(HR, OPP, SUB, body)
    expect(h.scopes.assertVisible).not.toHaveBeenCalled()
  })

  it('an ADMIN in STUDIO reads any team row', async () => {
    const h = harness(answers, STUDIO_SCOPE)
    await h.svc.cancelSubmission(ADMIN, OPP, SUB, body)
    expect(h.param('cancelRead')).toEqual([SUB, OPP])
  })

  it('a missing, foreign or other-opportunity submission is the same 404', async () => {
    const h = harness({ cancelRead: [] })
    await expectNotFound(h.svc.cancelSubmission(HR, OPP, SUB, body))
    expect(h.hits).not.toContain('cancelWrite')
  })

  it('malformed ids, NONE and a missing opportunity are 404s', async () => {
    const h = harness()
    await expectNotFound(h.svc.cancelSubmission(HR, 'nope', SUB, body))
    await expectNotFound(h.svc.cancelSubmission(HR, OPP, 'nope', body))
    expect(h.transaction).not.toHaveBeenCalled()
    await expectNotFound(harness({}, { kind: 'NONE' }).svc.cancelSubmission(HR, OPP, SUB, body))
    await expectNotFound(harness({ lockTarget: [] }).svc.cancelSubmission(HR, OPP, SUB, body))
  })

  it('a stale version or an already cancelled row is the generic conflict', async () => {
    const stale = harness({ cancelRead: [{ ...live, version: 9 }] })
    await expectStale(stale.svc.cancelSubmission(HR, OPP, SUB, body))
    expect(stale.hits).not.toContain('cancelWrite')
    const gone = harness({ cancelRead: [{ ...live, state: 'RELEASED' }] })
    await expectStale(gone.svc.cancelSubmission(HR, OPP, SUB, body))
    expect(gone.hits).not.toContain('cancelWrite')
  })

  it('a conditional UPDATE that matched nothing logs nothing', async () => {
    const h = harness({ cancelRead: [live], cancelWrite: [] })
    await expectStale(h.svc.cancelSubmission(HR, OPP, SUB, body))
    expect(h.hits).not.toContain('log')
  })

  it('a retry answers the earlier cancellation from the log', async () => {
    const h = harness({
      cancelRead: [{ ...live, state: 'RELEASED', version: 3 }],
      earlier: [
        {
          reason: JSON.stringify({ fp: FP, submissionId: SUB, submittedAt: T1 }),
          after_version: 3,
          created_at: new Date(T2),
        },
      ],
    })
    const res = await h.svc.cancelSubmission(HR, OPP, SUB, body)
    expect(res.submission).toEqual({
      id: SUB,
      opportunityId: OPP,
      seniorId: SENIOR,
      state: 'RELEASED',
      submittedAt: T1,
      cancelledAt: T2,
      version: 3,
      submittedByName: 'Rita Recruiter',
    })
    expect(h.param('name')).toEqual([OTHER_HR])
    expect(h.hits).toEqual([
      'lockTarget',
      'actor',
      'team',
      'membership',
      'cancelRead',
      'earlier',
      'name',
    ])
  })

  it('the same key on another submission or version is the idempotency conflict', async () => {
    const earlier = [
      { reason: JSON.stringify({ fp: FP }), after_version: 3, created_at: new Date(T2) },
    ]
    const other = harness({ earlier, cancelRead: [live] })
    await expectCode(
      other.svc.cancelSubmission(HR, OPP, NEW_SUB, body),
      409,
      'JOB_QUEUE_IDEMPOTENCY_CONFLICT',
    )
    const version = harness({ earlier, cancelRead: [live] })
    await expectCode(
      version.svc.cancelSubmission(HR, OPP, SUB, { ...body, expectedVersion: 1 }),
      409,
      'JOB_QUEUE_IDEMPOTENCY_CONFLICT',
    )
  })
})

describe('dismiss', () => {
  const body = {
    scope: 'TEAM' as const,
    reason: 'SPAM' as const,
    idempotencyKey: KEY,
  }
  const FP = requestFingerprint(['DISMISSED', OPP, 'TEAM', TEAM_A, 'SPAM', null])

  it('a first dismissal: INSERT in the scope, logged from version 0', async () => {
    const h = harness()
    const res = await h.svc.dismiss(HR, OPP, body)
    expect(res).toEqual({
      opportunityId: OPP,
      scope: 'TEAM',
      reason: 'SPAM',
      hidden: true,
      version: 1,
    })
    expect(h.hits).toEqual([
      'lockTarget',
      'actor',
      'team',
      'membership',
      'earlier',
      'dismissal',
      'dismissInsert',
      'log',
    ])
    expect(h.param('dismissInsert')).toEqual([OPP, 'TEAM', TEAM_A, 'SPAM', HR_ID])
    expect(h.param('dismissal')).toEqual([OPP, 'TEAM', TEAM_A])
    const logged = h.param('log')
    expect(logged.slice(0, 8)).toEqual(['DISMISSED', OPP, HR_ID, 'TEAM', TEAM_A, 0, 1, KEY])
    expect(JSON.parse(logged[8] as string)).toEqual({ fp: FP, dismissReason: 'SPAM' })
    expect(h.scopes.assertVisible).toHaveBeenCalledWith(TEAM_SCOPE, OPP, h.tx)
  })

  it('a STUDIO dismissal is an ADMIN in the STUDIO scope, with no team', async () => {
    const h = harness({}, STUDIO_SCOPE)
    const res = await h.svc.dismiss(ADMIN, OPP, { ...body, scope: 'STUDIO' })
    expect(res.scope).toBe('STUDIO')
    expect(h.param('dismissInsert')).toEqual([OPP, 'STUDIO', null, 'SPAM', ADMIN_ID])
  })

  it('a request scope other than the resolved one is a 404 before any lock', async () => {
    const hr = harness()
    await expectNotFound(hr.svc.dismiss(HR, OPP, { ...body, scope: 'STUDIO' }))
    expect(hr.hits).toEqual([])
    const admin = harness({}, STUDIO_SCOPE)
    await expectNotFound(admin.svc.dismiss(ADMIN, OPP, body))
    expect(admin.hits).toEqual([])
  })

  it('a live dismissal re-dismissed at its version takes the new reason and actor', async () => {
    const h = harness({ dismissal: [{ version: 1, reason: 'SPAM', undone_at: null }] })
    const res = await h.svc.dismiss(HR, OPP, { ...body, reason: 'DEAD_LINK', expectedVersion: 1 })
    expect(res).toEqual({
      opportunityId: OPP,
      scope: 'TEAM',
      reason: 'DEAD_LINK',
      hidden: true,
      version: 3,
    })
    expect(h.param('redismiss')).toEqual(['DEAD_LINK', HR_ID, OPP, 'TEAM', TEAM_A, 1])
  })

  it('a re-dismiss matches the expected version and clears the undo pair', async () => {
    const h = harness({
      dismissal: [{ version: 2, reason: 'DEAD_LINK', undone_at: new Date(T1) }],
    })
    const res = await h.svc.dismiss(HR, OPP, { ...body, expectedVersion: 2 })
    expect(res).toMatchObject({ hidden: true, version: 3, reason: 'SPAM' })
    expect(h.param('redismiss')).toEqual(['SPAM', HR_ID, OPP, 'TEAM', TEAM_A, 2])
    const text = h.calls.find((c) => PATTERNS.redismiss.test(c.text))?.text
    expect(text).toContain('undone_at = NULL')
    expect(text).toContain('undone_by = NULL')
    expect(h.param('log').slice(5, 7)).toEqual([2, 3])
  })

  it('a stale or missing version is the generic conflict; a version on no row too', async () => {
    const row = [{ version: 2, reason: 'SPAM', undone_at: null }]
    await expectStale(harness({ dismissal: row }).svc.dismiss(HR, OPP, body))
    await expectStale(
      harness({ dismissal: row }).svc.dismiss(HR, OPP, { ...body, expectedVersion: 1 }),
    )
    await expectStale(harness().svc.dismiss(HR, OPP, { ...body, expectedVersion: 1 }))
  })

  it('a conditional write that matched nothing logs nothing', async () => {
    const h = harness({
      dismissal: [{ version: 2, reason: 'SPAM', undone_at: null }],
      redismiss: [],
    })
    await expectStale(h.svc.dismiss(HR, OPP, { ...body, expectedVersion: 2 }))
    expect(h.hits).not.toContain('log')
  })

  it('a visibility miss stops it; NONE and a malformed id are 404s', async () => {
    const h = harness()
    h.scopes.assertVisible.mockRejectedValueOnce(new HttpException({ code: 'X' }, 404))
    await expect(h.svc.dismiss(HR, OPP, body)).rejects.toBeInstanceOf(HttpException)
    expect(h.hits).not.toContain('dismissal')
    await expectNotFound(harness({}, { kind: 'NONE' }).svc.dismiss(HR, OPP, body))
    await expectNotFound(harness().svc.dismiss(HR, 'nope', body))
  })

  it('a named version is part of the request identity on a retry', async () => {
    const fp = requestFingerprint(['DISMISSED', OPP, 'TEAM', TEAM_A, 'SPAM', 2])
    const h = harness({
      earlier: [
        {
          reason: JSON.stringify({ fp, dismissReason: 'SPAM' }),
          after_version: 3,
          created_at: new Date(T1),
        },
      ],
    })
    const res = await h.svc.dismiss(HR, OPP, { ...body, expectedVersion: 2 })
    expect(res.version).toBe(3)
  })

  it('a retry answers from the log; another payload conflicts', async () => {
    const earlier = [
      {
        reason: JSON.stringify({ fp: FP, dismissReason: 'SPAM' }),
        after_version: 4,
        created_at: new Date(T1),
      },
    ]
    const h = harness({ earlier })
    expect(await h.svc.dismiss(HR, OPP, body)).toEqual({
      opportunityId: OPP,
      scope: 'TEAM',
      reason: 'SPAM',
      hidden: true,
      version: 4,
    })
    expect(h.hits).toEqual(['lockTarget', 'actor', 'team', 'membership', 'earlier'])
    await expectCode(
      harness({ earlier }).svc.dismiss(HR, OPP, { ...body, reason: 'DEAD_LINK' }),
      409,
      'JOB_QUEUE_IDEMPOTENCY_CONFLICT',
    )
  })
})

describe('undo', () => {
  const body = { scope: 'TEAM' as const, idempotencyKey: KEY, expectedVersion: 2 }
  const live = [{ version: 2, reason: 'NOT_RELEVANT', undone_at: null }]
  const FP = requestFingerprint(['UNDONE', OPP, 'TEAM', TEAM_A, 2])

  it('sets the undo pair on the same row and logs UNDONE', async () => {
    const h = harness({ dismissal: live })
    const res = await h.svc.undo(HR, OPP, body)
    expect(res).toEqual({
      opportunityId: OPP,
      scope: 'TEAM',
      reason: 'NOT_RELEVANT',
      hidden: false,
      version: 3,
    })
    expect(h.hits).toEqual([
      'lockTarget',
      'actor',
      'team',
      'membership',
      'dismissal',
      'earlier',
      'undoWrite',
      'log',
    ])
    expect(h.param('undoWrite')).toEqual([HR_ID, OPP, 'TEAM', TEAM_A, 2])
    const logged = h.param('log')
    expect(logged.slice(0, 8)).toEqual(['UNDONE', OPP, HR_ID, 'TEAM', TEAM_A, 2, 3, KEY])
    expect(JSON.parse(logged[8] as string)).toEqual({ fp: FP, dismissReason: 'NOT_RELEVANT' })
    expect(h.scopes.assertVisible).not.toHaveBeenCalled()
  })

  it('no dismissal in this scope is a 404', async () => {
    await expectNotFound(harness().svc.undo(HR, OPP, body))
  })

  it('an already undone row or a stale version is the generic conflict', async () => {
    await expectStale(
      harness({ dismissal: [{ ...live[0], undone_at: new Date(T1) }] }).svc.undo(HR, OPP, body),
    )
    await expectStale(harness({ dismissal: [{ ...live[0], version: 9 }] }).svc.undo(HR, OPP, body))
  })

  it('a conditional write that matched nothing logs nothing', async () => {
    const h = harness({ dismissal: live, undoWrite: [] })
    await expectStale(h.svc.undo(HR, OPP, body))
    expect(h.hits).not.toContain('log')
  })

  it('a request scope other than the resolved one, NONE and a bad id are 404s', async () => {
    const h = harness()
    await expectNotFound(h.svc.undo(HR, OPP, { ...body, scope: 'STUDIO' }))
    expect(h.hits).toEqual([])
    await expectNotFound(harness({}, { kind: 'NONE' }).svc.undo(HR, OPP, body))
    const malformed = harness()
    await expectNotFound(malformed.svc.undo(HR, 'nope', body))
    expect(malformed.transaction).not.toHaveBeenCalled()
  })

  it('a retry answers from the log with hidden false', async () => {
    const h = harness({
      dismissal: [{ ...live[0], version: 3, undone_at: new Date(T1) }],
      earlier: [
        {
          reason: JSON.stringify({ fp: FP, dismissReason: 'NOT_RELEVANT' }),
          after_version: 3,
          created_at: new Date(T1),
        },
      ],
    })
    expect(await h.svc.undo(HR, OPP, body)).toMatchObject({ hidden: false, version: 3 })
    expect(h.hits).toEqual(['lockTarget', 'actor', 'team', 'membership', 'dismissal', 'earlier'])
  })
})

describe('opened', () => {
  const body = { sourceRecordId: SOURCE }

  it('records the click once per actor, opportunity and source record', async () => {
    const h = harness()
    await h.svc.opened(HR, OPP, body)
    expect(h.hits).toEqual(['actor', 'team', 'membership', 'link', 'opened'])
    expect(h.param('link')).toEqual([OPP, SOURCE])
    expect(h.param('opened')).toEqual([
      OPP,
      SOURCE,
      HR_ID,
      'TEAM',
      TEAM_A,
      `opened:${OPP}:${SOURCE}`,
    ])
    const text = h.calls.find((c) => PATTERNS.opened.test(c.text))?.text
    expect(text).toContain('ON CONFLICT DO NOTHING')
    expect(h.scopes.assertVisible).toHaveBeenCalledWith(TEAM_SCOPE, OPP, h.tx)
  })

  it('a source record that is not a live link of the opportunity is a 404', async () => {
    const h = harness({ link: [] })
    await expectNotFound(h.svc.opened(HR, OPP, body))
    expect(h.hits).not.toContain('opened')
    expect(h.calls.find((c) => PATTERNS.link.test(c.text))?.text).toContain('unlinked_at IS NULL')
  })

  it('an actor no longer live is a 404, before the visibility answer', async () => {
    for (const answers of [{ actor: [] }, { team: [] }, { membership: [] }]) {
      const h = harness(answers)
      await expectNotFound(h.svc.opened(HR, OPP, body))
      expect(h.scopes.assertVisible).not.toHaveBeenCalled()
      expect(h.hits).not.toContain('opened')
    }
  })

  it('a visibility miss, NONE and bad ids are refused', async () => {
    const h = harness()
    h.scopes.assertVisible.mockRejectedValueOnce(new HttpException({ code: 'X' }, 404))
    await expect(h.svc.opened(HR, OPP, body)).rejects.toBeInstanceOf(HttpException)
    expect(h.hits).toEqual(['actor', 'team', 'membership'])
    await expectNotFound(harness({}, { kind: 'NONE' }).svc.opened(HR, OPP, body))
    await expectNotFound(harness().svc.opened(HR, 'nope', body))
    await expectNotFound(harness().svc.opened(HR, OPP, { sourceRecordId: 'nope' }))
  })
})

describe('suppress', () => {
  const body = { idempotencyKey: KEY }
  const FP = requestFingerprint(['SUPPRESSED', OPP])

  it('an ADMIN writes a versionless STUDIO action, and asks the live role', async () => {
    const h = harness({}, STUDIO_SCOPE)
    await h.svc.suppress(ADMIN, OPP, body)
    expect(h.hits).toEqual(['lockTarget', 'actor', 'earlier', 'log'])
    expect(h.scopes.resolve).toHaveBeenCalledWith(ADMIN, undefined, h.tx)
    expect(h.param('log')).toEqual([
      'SUPPRESSED',
      OPP,
      ADMIN_ID,
      'STUDIO',
      null,
      null,
      null,
      KEY,
      JSON.stringify({ fp: FP }),
    ])
  })

  it('anyone resolving to a team scope or none is a 403', async () => {
    const team = harness()
    await expect(team.svc.suppress(HR, OPP, body)).rejects.toBeInstanceOf(ForbiddenException)
    expect(team.hits).toEqual([])
    const none = harness({}, { kind: 'NONE' })
    await expect(none.svc.suppress(HR, OPP, body)).rejects.toBeInstanceOf(ForbiddenException)
  })

  it('a demoted ADMIN, a missing opportunity and a bad id are 404s', async () => {
    await expectNotFound(harness({ actor: [] }, STUDIO_SCOPE).svc.suppress(ADMIN, OPP, body))
    await expectNotFound(harness({ lockTarget: [] }, STUDIO_SCOPE).svc.suppress(ADMIN, OPP, body))
    await expectNotFound(harness({}, STUDIO_SCOPE).svc.suppress(ADMIN, 'nope', body))
  })

  it('a retry writes nothing; the key on another opportunity conflicts', async () => {
    const earlier = [
      { reason: JSON.stringify({ fp: FP }), after_version: null, created_at: new Date(T1) },
    ]
    const h = harness({ earlier }, STUDIO_SCOPE)
    await h.svc.suppress(ADMIN, OPP, body)
    expect(h.hits).toEqual(['lockTarget', 'actor', 'earlier'])
    const other = harness({ earlier, lockTarget: [{ id: COPY }] }, STUDIO_SCOPE)
    await expectCode(other.svc.suppress(ADMIN, COPY, body), 409, 'JOB_QUEUE_IDEMPOTENCY_CONFLICT')
  })
})

describe('a reused key is no existence oracle', () => {
  const usedElsewhere = [
    {
      reason: JSON.stringify({ fp: 'another request' }),
      after_version: 1,
      created_at: new Date(T1),
    },
  ]
  const dismissBody = { scope: 'TEAM' as const, reason: 'SPAM' as const, idempotencyKey: KEY }
  const undoBody = { scope: 'TEAM' as const, idempotencyKey: KEY, expectedVersion: 2 }
  const cancelBody = { idempotencyKey: KEY, expectedVersion: 2 }
  const live = [
    { senior_id: SENIOR, assignee_id: HR_ID, state: 'TAKEN', version: 2, taken_at: new Date(T1) },
  ]
  const hiddenFromScope = () => {
    const h = harness({ earlier: usedElsewhere })
    h.scopes.assertVisible.mockRejectedValueOnce(
      new HttpException({ code: 'JOB_OPPORTUNITY_NOT_FOUND' }, 404),
    )
    return h
  }

  it('submit: hidden and missing answer alike, the key unread', async () => {
    const hidden = hiddenFromScope()
    await expectNotFound(hidden.svc.submit(HR, OPP, submitBody()))
    expect(hidden.hits).not.toContain('earlier')
    const missing = harness({ earlier: usedElsewhere, lockSet: [] })
    await expectNotFound(missing.svc.submit(HR, OPP, submitBody()))
    expect(missing.hits).not.toContain('earlier')
  })

  it('dismiss: hidden and missing answer alike, the key unread', async () => {
    const hidden = hiddenFromScope()
    await expectNotFound(hidden.svc.dismiss(HR, OPP, dismissBody))
    expect(hidden.hits).not.toContain('earlier')
    const missing = harness({ earlier: usedElsewhere, lockTarget: [] })
    await expectNotFound(missing.svc.dismiss(HR, OPP, dismissBody))
    expect(missing.hits).not.toContain('earlier')
  })

  it('cancel: no row in the scope answers 404, the key unread', async () => {
    const h = harness({ earlier: usedElsewhere, cancelRead: [] })
    await expectNotFound(h.svc.cancelSubmission(HR, OPP, SUB, cancelBody))
    expect(h.hits).not.toContain('earlier')
  })

  it('undo: no dismissal in the scope answers 404, the key unread', async () => {
    const h = harness({ earlier: usedElsewhere, dismissal: [] })
    await expectNotFound(h.svc.undo(HR, OPP, undoBody))
    expect(h.hits).not.toContain('earlier')
  })

  it('an actor no longer live is a 404 on all four, the key unread', async () => {
    const answers = { earlier: usedElsewhere, actor: [], cancelRead: live }
    const attempts: Array<(h: ReturnType<typeof harness>) => Promise<unknown>> = [
      (h) => h.svc.submit(HR, OPP, submitBody()),
      (h) => h.svc.dismiss(HR, OPP, dismissBody),
      (h) => h.svc.cancelSubmission(HR, OPP, SUB, cancelBody),
      (h) => h.svc.undo(HR, OPP, undoBody),
    ]
    for (const attempt of attempts) {
      const h = harness(answers)
      await expectNotFound(attempt(h))
      expect(h.hits).not.toContain('earlier')
    }
  })

  it('suppress: a demoted ADMIN does not reach the key', async () => {
    const h = harness({ earlier: usedElsewhere, actor: [] }, STUDIO_SCOPE)
    await expectNotFound(h.svc.suppress(ADMIN, OPP, { idempotencyKey: KEY }))
    expect(h.hits).not.toContain('earlier')
  })
})

describe('the locks the statements take', () => {
  it('a replacement deletes only a cancelled row', async () => {
    const h = harness({
      existing: [{ id: SUB, state: 'RELEASED', team_id: TEAM_B, version: 2 }],
    })
    await h.svc.submit(HR, OPP, submitBody())
    expect(h.calls.find((c) => PATTERNS.remove.test(c.text))?.text).toContain("state = 'RELEASED'")
  })

  it('a single target is locked FOR NO KEY UPDATE', async () => {
    const h = harness()
    await h.svc.dismiss(HR, OPP, { scope: 'TEAM', reason: 'SPAM', idempotencyKey: KEY })
    expect(h.calls.find((c) => PATTERNS.lockTarget.test(c.text))?.text).toContain(
      'FOR NO KEY UPDATE',
    )
  })
})

describe('the transaction boundary', () => {
  const uniqueViolation = (constraint: string) =>
    Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('dup'), { code: '23505', constraint }),
    })

  it('an idempotency-key violation runs the operation again, which answers from the log', async () => {
    const h = harness()
    const earlier = [
      {
        reason: JSON.stringify({ fp: SUBMIT_FP, submissionId: SUB, submittedAt: T1 }),
        after_version: 1,
        created_at: new Date(T1),
      },
    ]
    h.transaction.mockImplementationOnce(async () => {
      throw uniqueViolation('uq_job_queue_actions_actor_idempotency')
    })
    const retry = harness({ earlier })
    h.transaction.mockImplementationOnce(retry.transaction)
    const res = await h.svc.submit(HR, OPP, submitBody())
    expect(res.submission.id).toBe(SUB)
    expect(h.transaction).toHaveBeenCalledTimes(2)
  })

  const deadlock = () =>
    Object.assign(new Error('Failed query'), {
      cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    })

  it('a deadlock victim is run once more, and the rerun answers', async () => {
    const h = harness()
    h.transaction.mockImplementationOnce(async () => {
      throw deadlock()
    })
    const res = await h.svc.submit(HR, OPP, submitBody())
    expect(res.submission.id).toBe(NEW_SUB)
    expect(h.transaction).toHaveBeenCalledTimes(2)
  })

  it('opened is a write like the others: a deadlock victim is run once more', async () => {
    const h = harness()
    h.transaction.mockImplementationOnce(async () => {
      throw deadlock()
    })
    await h.svc.opened(HR, OPP, { sourceRecordId: SOURCE })
    expect(h.transaction).toHaveBeenCalledTimes(2)
    expect(h.hits).toContain('opened')
  })

  it('there is one rerun: a second failure of either kind is the error itself', async () => {
    for (const failure of [
      deadlock,
      () => uniqueViolation('uq_job_queue_actions_actor_idempotency'),
    ]) {
      const h = harness()
      const second = failure()
      h.transaction
        .mockImplementationOnce(async () => {
          throw failure()
        })
        .mockImplementationOnce(async () => {
          throw second
        })
        .mockImplementationOnce(async () => {
          throw new Error('a third attempt')
        })
      await expect(h.svc.submit(HR, OPP, submitBody())).rejects.toBe(second)
      expect(h.transaction).toHaveBeenCalledTimes(2)
    }
  })

  it('a rerun is mapped like the first attempt: its lost race is the generic conflict', async () => {
    const h = harness()
    h.transaction
      .mockImplementationOnce(async () => {
        throw deadlock()
      })
      .mockImplementationOnce(async () => {
        throw uniqueViolation('uq_job_queue_assignments_opportunity_senior')
      })
    await expectStale(h.svc.submit(HR, OPP, submitBody()))
    expect(h.transaction).toHaveBeenCalledTimes(2)
  })

  it('a lost race on the submission key is the generic conflict, naming no row', async () => {
    const h = harness({ insert: uniqueViolation('uq_job_queue_assignments_opportunity_senior') })
    const r = await refusal(h.svc.submit(HR, OPP, submitBody()))
    expect(r.status).toBe(409)
    expect(r.body['code']).toBe('JOB_QUEUE_VERSION_CONFLICT')
    expect(r.body).not.toHaveProperty('submittedElsewhere')
    expect(h.transaction).toHaveBeenCalledTimes(1)
  })

  it('a lost race on the dismissal key is the generic conflict', async () => {
    const h = harness({
      dismissInsert: uniqueViolation('uq_job_queue_dismissals_opportunity_scope'),
    })
    await expectStale(
      h.svc.dismiss(HR, OPP, { scope: 'TEAM', reason: 'SPAM', idempotencyKey: KEY }),
    )
  })

  it('an unanticipated violation and any other failure stay errors, so the write rolls back', async () => {
    const other = uniqueViolation('some_other_constraint')
    await expect(harness({ insert: other }).svc.submit(HR, OPP, submitBody())).rejects.toBe(other)
    const auditDown = new Error('audit failed')
    const h = harness({ log: auditDown })
    await expect(h.svc.submit(HR, OPP, submitBody())).rejects.toBe(auditDown)
    expect(h.hits).not.toContain('name')
  })
})

describe('createManualCard (r5 Phase 6)', () => {
  const DESCRIPTION = 'We need a Go developer.'
  const DESCRIPTION_SHA = 'ea19eb119fac6a1ef9a249b7ae62c3c1a69f35c72cba531d73314f0d86e73123'
  const URL = 'https://acme.test/jobs/1'
  const manualBody = (over: Record<string, unknown> = {}) => ({
    title: 'Go Developer (Remote)',
    companyName: 'Acme, Inc.',
    applicationUrl: URL,
    descriptionMd: DESCRIPTION,
    idempotencyKey: KEY,
    submission: { teamId: TEAM_A, seniorId: SENIOR, resumeId: RESUME },
    confirmPossibleDuplicate: false,
    ...over,
  })
  const MANUAL_FP = requestFingerprint([
    'MANUAL',
    TEAM_A,
    SENIOR,
    RESUME,
    'Go Developer (Remote)',
    'Acme, Inc.',
    URL,
    DESCRIPTION_SHA,
    false,
  ])
  const MANUAL_WRITES: Statement[] = ['blob', 'card', 'insert', 'log']
  const answer = {
    submission: {
      id: NEW_SUB,
      opportunityId: CARD,
      seniorId: SENIOR,
      state: 'TAKEN',
      submittedAt: T1,
      cancelledAt: null,
      version: 1,
      submittedByName: 'Rita Recruiter',
    },
  }
  const expectIneligible = (p: Promise<unknown>) =>
    expectCode(p, 422, 'JOB_QUEUE_SENIOR_INELIGIBLE')
  const stopListed = {
    id: '90000000-0000-4000-8000-000000000001',
    senior_id: SENIOR,
    kind: 'COMPANY',
    value: 'Acme',
    normalized_value: 'acme',
    created_at: new Date(T1),
  }

  it('creates the card and its submission in one transaction, in order', async () => {
    const h = harness()
    expect(await h.svc.createManualCard(HR, manualBody())).toEqual(answer)
    expect(h.transaction).toHaveBeenCalledTimes(1)
    expect(h.hits).toEqual([
      'actor',
      'team',
      'membership',
      'earlier',
      'urlLock',
      'urlTaken',
      'blob',
      'card',
      'lockSet',
      'senior',
      'canonical',
      'ownManual',
      'ownProjects',
      'resume',
      'duplicates',
      'insert',
      'log',
      'name',
    ])
    expect(h.scopes.resolve).toHaveBeenCalledWith(HR, TEAM_A, h.tx)
    expect(h.scopes.assertVisible).not.toHaveBeenCalled()
  })

  it('stores the description blob by its lowercase hex digest, keeping an existing one', async () => {
    const h = harness()
    await h.svc.createManualCard(HR, manualBody())
    expect(h.param('blob')).toEqual([DESCRIPTION_SHA, DESCRIPTION])
    expect(h.calls.find((c) => PATTERNS.blob.test(c.text))?.text).toContain(
      'ON CONFLICT (sha256) DO NOTHING',
    )
  })

  it('writes the card with the candidate keys, the description and its owner team', async () => {
    const h = harness()
    await h.svc.createManualCard(HR, manualBody())
    expect(h.param('card')).toEqual([
      'Go Developer (Remote)',
      'go developer remote',
      'Acme, Inc.',
      'acme inc',
      URL,
      URL,
      DESCRIPTION_SHA,
      TEAM_A,
    ])
  })

  it('a card without an application link stores NULL for the link and its key, and is not looked up', async () => {
    const h = harness()
    await h.svc.createManualCard(HR, manualBody({ applicationUrl: undefined }))
    expect(h.param('card')[4]).toBeNull()
    expect(h.param('card')[5]).toBeNull()
    expect(h.hits).not.toContain('urlLock')
    expect(h.hits).not.toContain('urlTaken')
  })

  it('serializes on the dedupe key and looks the link up by key or exact href', async () => {
    const raw = 'https://Jobs.Example.test/x/?utm=1#apply'
    const h = harness()
    await h.svc.createManualCard(HR, manualBody({ applicationUrl: raw }))
    expect(h.param('urlLock')).toEqual([0x6d616e75, 'https://jobs.example.test/x'])
    expect(h.param('urlTaken')).toEqual([
      'https://jobs.example.test/x',
      'https://jobs.example.test/x/?utm=1',
    ])
    expect(h.param('card')[5]).toBe('https://jobs.example.test/x')
  })

  it('CR-M-3: the lock hashes the key; the lookup matches the key OR the exact link, one row', async () => {
    const h = harness()
    await h.svc.createManualCard(HR, manualBody())
    const text = (s: Statement) => h.calls.find((c) => PATTERNS[s].test(c.text))?.text
    expect(text('urlLock')).toBe('SELECT pg_advisory_xact_lock($1::int, hashtext($2))')
    expect(text('urlTaken')).toBe(
      'SELECT 1 FROM job_opportunities WHERE application_url_key = $1 OR application_url = $2 LIMIT 1',
    )
  })

  it.each([
    ['team', { teamId: 'not-a-uuid', seniorId: SENIOR, resumeId: RESUME }],
    ['senior', { teamId: TEAM_A, seniorId: 'not-a-uuid', resumeId: RESUME }],
    ['resume', { teamId: TEAM_A, seniorId: SENIOR, resumeId: 'not-a-uuid' }],
  ])(
    'only the %s id malformed: a 404 before any transaction or statement',
    async (_n, submission) => {
      const h = harness()
      await expectNotFound(h.svc.createManualCard(HR, manualBody({ submission })))
      expect(h.transaction).not.toHaveBeenCalled()
      expect(h.hits).toEqual([])
    },
  )

  it('a card INSERT that returns no row is not dereferenced: the response schema refuses it', async () => {
    // A plain INSERT ... RETURNING always yields its row; this pins the guarded read only:
    // no TypeError, the id reads as "undefined" and the answer's uuid check fails loud.
    const h = harness({ card: [] })
    await expect(h.svc.createManualCard(HR, manualBody())).rejects.toBeInstanceOf(ZodError)
    expect(h.param('lockSet')).toEqual(['undefined'])
  })

  it('a link any opportunity already carries is the generic 409, and nothing is written', async () => {
    const h = harness({ urlTaken: [{ '?column?': 1 }] })
    await expectCode(h.svc.createManualCard(HR, manualBody()), 409, 'JOB_QUEUE_MANUAL_DUPLICATE')
    expect(h.hits.filter((x) => MANUAL_WRITES.includes(x))).toEqual([])
  })

  it('a possible duplicate the senior already holds is the 409 with its preview, unless confirmed', async () => {
    const claimed = { duplicates: [{ opportunity_id: OPP }] }
    const h = harness(claimed)
    const r = await refusal(h.svc.createManualCard(HR, manualBody()))
    expect(r.status).toBe(409)
    expect(r.body).toEqual({
      code: 'JOB_QUEUE_POSSIBLE_DUPLICATE_CLAIMED',
      possibleDuplicates: {
        items: [{ opportunityId: OPP, title: 'Go Developer', companyName: 'Acme' }],
        totalCount: 1,
      },
    })
    expect(h.hits).not.toContain('insert')

    const confirmed = harness(claimed)
    await confirmed.svc.createManualCard(HR, manualBody({ confirmPossibleDuplicate: true }))
    expect(confirmed.hits).not.toContain('duplicates')
    expect(confirmed.hits).toContain('insert')
  })

  it('the duplicate set is read from the new card and locked', async () => {
    const h = harness()
    await h.svc.createManualCard(HR, manualBody())
    expect(h.param('lockSet')).toEqual([CARD])
    expect(h.calls.find((c) => PATTERNS.lockSet.test(c.text))?.text).toContain(
      'FOR NO KEY UPDATE OF d',
    )
  })

  it('submits the senior to the new card in the team scope, for the actor, with the resume', async () => {
    const h = harness()
    await h.svc.createManualCard(HR, manualBody())
    expect(h.param('insert')).toEqual([CARD, SENIOR, 'TEAM', TEAM_A, HR_ID, RESUME])
  })

  it('logs TAKEN from 0 to 1 on the card, with the resume in the replay', async () => {
    const h = harness()
    await h.svc.createManualCard(HR, manualBody())
    const [kind, opp, actor, scopeKind, team, before, after, key, reason] = h.param('log')
    expect([kind, opp, actor, scopeKind, team, before, after, key]).toEqual([
      'TAKEN',
      CARD,
      HR_ID,
      'TEAM',
      TEAM_A,
      0,
      1,
      KEY,
    ])
    expect(JSON.parse(reason as string)).toEqual({
      fp: MANUAL_FP,
      submissionId: NEW_SUB,
      submittedAt: T1,
      resumeId: RESUME,
    })
  })

  it("reads the resume as the senior's own READY one, locked for share", async () => {
    const h = harness()
    await h.svc.createManualCard(HR, manualBody())
    expect(h.param('resume')).toEqual([RESUME, SENIOR])
    const text = h.calls.find((c) => PATTERNS.resume.test(c.text))?.text
    expect(text).toContain("status = 'READY'")
    expect(text).toContain('FOR SHARE')
  })

  it('canonicalizes the ids before any statement', async () => {
    const h = harness()
    await h.svc.createManualCard(
      HR,
      manualBody({
        submission: {
          teamId: TEAM_A.toUpperCase(),
          seniorId: SENIOR.toUpperCase(),
          resumeId: RESUME.toUpperCase(),
        },
      }),
    )
    expect(h.scopes.resolve).toHaveBeenCalledWith(HR, TEAM_A, h.tx)
    expect(h.param('resume')).toEqual([RESUME, SENIOR])
    expect(h.param('insert')[1]).toBe(SENIOR)
  })

  it('an ADMIN names any live team and needs no membership of it', async () => {
    const h = harness()
    await h.svc.createManualCard(ADMIN, manualBody())
    expect(h.hits).not.toContain('membership')
    expect(h.param('insert')).toEqual([CARD, SENIOR, 'TEAM', TEAM_A, ADMIN_ID, RESUME])
  })

  it('a non-team scope (no membership, or STUDIO) is a 404 before any statement', async () => {
    for (const scope of [{ kind: 'NONE' }, STUDIO_SCOPE] as JobQueueScope[]) {
      const h = harness({}, scope)
      await expectNotFound(h.svc.createManualCard(HR, manualBody()))
      expect(h.hits).toEqual([])
    }
  })

  it('a demoted actor, an archived team or a left HR is a 404 before any write', async () => {
    for (const answers of [{ actor: [] }, { team: [] }, { membership: [] }]) {
      const h = harness(answers)
      await expectNotFound(h.svc.createManualCard(HR, manualBody()))
      expect(h.hits.filter((x) => MANUAL_WRITES.includes(x))).toEqual([])
    }
  })

  it('a senior who is not an active SENIOR member of the team is a 422, and nothing is submitted', async () => {
    const h = harness({ senior: [] })
    await expectIneligible(h.svc.createManualCard(HR, manualBody()))
    expect(h.hits).not.toContain('insert')
    expect(h.hits).not.toContain('log')
    const text = h.calls.find((c) => PATTERNS.senior.test(c.text))?.text
    expect(text).toContain("u.role = 'SENIOR'")
    expect(text).toContain('u.archived_at IS NULL')
    expect(h.param('senior')).toEqual([SENIOR, TEAM_A])
  })

  it('a senior who stop-listed the company is a 422', async () => {
    const h = harness({ ownManual: [stopListed] })
    await expectIneligible(h.svc.createManualCard(HR, manualBody()))
    expect(h.hits).not.toContain('insert')
  })

  it('a card the transaction cannot read back is a 422, not a submission', async () => {
    const h = harness({ canonical: [] })
    await expectIneligible(h.svc.createManualCard(HR, manualBody()))
    expect(h.hits).not.toContain('insert')
  })

  it('an unknown, foreign or unfinished resume is a 422, and nothing is submitted', async () => {
    const h = harness({ resume: [] })
    await expectCode(h.svc.createManualCard(HR, manualBody()), 422, 'JOB_QUEUE_RESUME_UNUSABLE')
    expect(h.hits).not.toContain('insert')
    expect(h.hits).not.toContain('log')
  })

  it('a failing step propagates, so the card rolls back with the transaction', async () => {
    const auditDown = new Error('audit failed')
    const h = harness({ log: auditDown })
    await expect(h.svc.createManualCard(HR, manualBody())).rejects.toBe(auditDown)
    expect(h.hits).toContain('card')
    expect(h.hits).not.toContain('name')
  })

  it('a retry answers from the log, on the card it names, and creates nothing', async () => {
    const h = harness({
      earlier: [
        {
          reason: JSON.stringify({
            fp: MANUAL_FP,
            submissionId: NEW_SUB,
            submittedAt: T1,
            resumeId: RESUME,
          }),
          after_version: 1,
          created_at: new Date(T2),
          opportunity_id: CARD,
        },
      ],
    })
    expect(await h.svc.createManualCard(HR, manualBody())).toEqual(answer)
    expect(h.scopes.assertVisible).toHaveBeenCalledWith(TEAM_SCOPE, CARD, h.tx)
    expect(h.hits.filter((x) => MANUAL_WRITES.includes(x))).toEqual([])
  })

  it('a reused key with another request is the idempotency conflict', async () => {
    const h = harness({
      earlier: [
        {
          reason: JSON.stringify({ fp: MANUAL_FP, submissionId: NEW_SUB, submittedAt: T1 }),
          after_version: 1,
          created_at: new Date(T1),
          opportunity_id: CARD,
        },
      ],
    })
    await expectCode(
      h.svc.createManualCard(HR, manualBody({ title: 'Rust Developer' })),
      409,
      'JOB_QUEUE_IDEMPOTENCY_CONFLICT',
    )
    expect(h.hits.filter((x) => MANUAL_WRITES.includes(x))).toEqual([])
  })
})
