import { HttpException } from '@nestjs/common'
import { EMPTY_RESUME_CONTENT, type SessionUser } from '@crm/shared'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const authorizeSenior = vi.fn()
const visibleSeniors = vi.fn()
const startRun = vi.fn()
const loadOpportunity = vi.fn()
vi.mock('./tailored-access', () => ({
  authorizeSenior: (...a: unknown[]) => authorizeSenior(...a),
  visibleSeniors: (...a: unknown[]) => visibleSeniors(...a),
}))
vi.mock('./tailored-run', async (orig) => ({
  ...(await orig<object>()),
  startRun: (...a: unknown[]) => startRun(...a),
}))
vi.mock('../job-sourcing/runtime/production-catalog', () => ({
  productionLedgerCatalog: () => ({ onDemandTypes: () => ['GREENHOUSE_ATS'] }),
}))
vi.mock('../job-sourcing/runtime/recompute-inputs', async (orig) => ({
  ...(await orig<object>()),
  loadOpportunity: (...a: unknown[]) => loadOpportunity(...a),
}))

const { TailoredResumesService, rowDto, detailDto, pdfAnswer } =
  await import('./tailored-resumes.service')

const OPP = '0b5e0000-0000-4000-8000-0000000000a1'
const S1 = '0b5e0000-0000-4000-8000-000000000001'
const ROW = '0b5e0000-0000-4000-8000-0000000000f1'
const RUN = '0b5e0000-0000-4000-8000-0000000000e1'
const TEAM = { kind: 'TEAM', teamId: '0b5e0000-0000-4000-8000-0000000000c1' } as const
const hr = { id: '0b5e0000-0000-4000-8000-0000000000d1', role: 'HR' } as SessionUser
const dialect = new PgDialect()
const content = {
  ...EMPTY_RESUME_CONTENT,
  summary: 'Builds APIs.',
  skills: ['Go'],
  experience: [{ company: 'Acme', role: 'Dev', period: '2020', bullets: ['Shipped'] }],
}
const verification = {
  gates: [],
  revertedPaths: [],
  keptFromBase: 2,
  coverage: { matched: ['Go'], total: 3 },
  gaps: ['Rust'],
  injectionSuspected: false,
  postingPartial: true,
  postingTruncated: false,
  routes: [],
}

type Rows = Record<string, unknown>[]
type Answers = { tailored?: Rows; people?: Rows; pending?: Rows }

function fakeDb(a: Answers = {}) {
  const sqls: string[] = []
  const params: unknown[][] = []
  const execute = vi.fn(async (query: SQL) => {
    const { sql: text, params: values } = dialect.sqlToQuery(query)
    sqls.push(text)
    params.push(values)
    if (/FROM tailored_resumes/.test(text)) return { rows: a.tailored ?? [] }
    if (/FROM users u/.test(text)) return { rows: a.people ?? [] }
    if (/FROM job_dirty_work/.test(text)) return { rows: a.pending ?? [] }
    return { rows: [] }
  })
  const tx = { execute }
  const transaction = vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx))
  return { db: { execute, transaction }, sqls, params, execute, transaction, tx }
}

const person = (over: Record<string, unknown> = {}) => ({
  id: S1,
  display_name: 'Tara Prep',
  version: 3,
  verification_status: 'VERIFIED',
  content,
  ...over,
})

const opportunity = (over: Record<string, unknown> = {}) => ({
  revision: 7,
  canonical: { fields: { title: 'Senior Dev' } },
  onDemandMissing: [],
  ...over,
})

function make(a: Answers = {}) {
  const db = fakeDb(a)
  const scopes = {
    resolve: vi.fn(async () => TEAM),
    assertVisible: vi.fn(async () => undefined),
    policy: vi.fn(<T>(fn: () => Promise<T>) => fn()),
  }
  const audit = { record: vi.fn(async () => undefined) }
  const s3 = { getObject: vi.fn(async () => Buffer.from('%PDF')) }
  const runner = { enqueue: vi.fn() }
  const svc = new TailoredResumesService(
    db as never,
    scopes as never,
    audit as never,
    s3 as never,
    runner as never,
  )
  svc.onDemandTypes = () => ['DOU'] as never
  return { svc, db, scopes, audit, s3, runner }
}

const codeOf = (e: unknown) =>
  e instanceof HttpException
    ? { status: e.getStatus(), body: e.getResponse() as Record<string, unknown> }
    : { status: -1, body: { err: String(e) } }

const fail = (p: Promise<unknown>) => p.then(() => ({ status: 0, body: {} }), codeOf)

beforeEach(() => {
  vi.clearAllMocks()
  authorizeSenior.mockResolvedValue(TEAM)
  loadOpportunity.mockResolvedValue(opportunity())
})

describe('rowDto', () => {
  const base = { version: 3, verificationStatus: 'VERIFIED', content }
  const tara = { displayName: 'Tara', base }
  const published = {
    runStatus: 'SUCCEEDED',
    runStage: null,
    runErrorCode: null,
    content,
    pdfStatus: 'READY',
    pdfRenderId: null,
    baseVersion: 3,
    opportunityRevision: 7,
  } as const

  it('no row: idle, unpublished, eligibility from the base', () => {
    expect(
      rowDto({ seniorId: S1, row: undefined, person: tara, revision: 7, pending: false }),
    ).toEqual({
      seniorId: S1,
      eligibility: 'READY',
      runStatus: null,
      runStage: null,
      runErrorCode: null,
      published: false,
      pdfStatus: 'IDLE',
      pdfRenderId: null,
      baseChanged: false,
    })
  })

  it('a pending posting fetch is POSTING_PENDING; no base or no senior is NO_VERIFIED_RESUME', () => {
    const r = (person: { displayName: string; base?: typeof base } | undefined, pending: boolean) =>
      rowDto({ seniorId: S1, row: undefined, person: person as never, revision: 7, pending })
        .eligibility
    expect(r(tara, true)).toBe('POSTING_PENDING')
    expect(r({ displayName: 'Tara' }, false)).toBe('NO_VERIFIED_RESUME')
    expect(r(undefined, false)).toBe('NO_VERIFIED_RESUME')
    expect(r({ displayName: 'Тара', base }, false)).toBe('NON_LATIN_NAME')
  })

  it('baseChanged: the base version or the opportunity revision moved, only for a published row', () => {
    const changed = (
      row: Record<string, unknown>,
      b: typeof base | undefined = base,
      revision = 7,
    ) =>
      rowDto({
        seniorId: S1,
        row: row as never,
        person: { displayName: 'Tara', base: b },
        revision,
        pending: false,
      }).baseChanged
    expect(changed(published)).toBe(false)
    expect(changed(published, { ...base, version: 4 })).toBe(true)
    expect(changed(published, base, 8)).toBe(true)
    expect(
      rowDto({
        seniorId: S1,
        row: published as never,
        person: undefined,
        revision: 7,
        pending: false,
      }).baseChanged,
    ).toBe(true)
    expect(changed({ ...published, content: null, baseVersion: null })).toBe(false)
    expect(changed({ ...published, content: null, baseVersion: null }, base, 8)).toBe(false)
    expect(
      rowDto({ seniorId: S1, row: published as never, person: tara, revision: 7, pending: false })
        .published,
    ).toBe(true)
  })

  it('carries the run and render columns of the row', () => {
    const row = {
      ...published,
      runStatus: 'RUNNING',
      runStage: 'GENERATE',
      runErrorCode: 'BASE_CHANGED',
      pdfStatus: 'RUNNING',
      pdfRenderId: RUN,
    }
    expect(
      rowDto({ seniorId: S1, row: row as never, person: tara, revision: 7, pending: false }),
    ).toMatchObject({
      runStatus: 'RUNNING',
      runStage: 'GENERATE',
      runErrorCode: 'BASE_CHANGED',
      published: true,
      pdfStatus: 'RUNNING',
      pdfRenderId: RUN,
    })
  })
})

describe('detailDto', () => {
  // Built inside each test: a throw at collection time would hide every test of this file.
  const row0 = () =>
    rowDto({ seniorId: S1, row: undefined, person: undefined, revision: 1, pending: false })

  it('nothing published: every published field is null', () => {
    expect(detailDto(row0(), undefined)).toMatchObject({
      coverLetter: null,
      editable: null,
      summary: null,
      generatedAt: null,
      editedAt: null,
    })
  })

  it('a published variant: editable fields, the short summary and ISO times', () => {
    const at = new Date('2026-11-20T10:00:00.000Z')
    const got = detailDto(row0(), {
      content,
      coverLetter: 'Dear Hiring Team,',
      verification,
      generatedAt: at,
      editedAt: null,
    } as never)
    expect(got.coverLetter).toBe('Dear Hiring Team,')
    expect(got.editable).toEqual({
      summary: 'Builds APIs.',
      skills: ['Go'],
      experience: [{ company: 'Acme', role: 'Dev', period: '2020', bullets: ['Shipped'] }],
    })
    expect(got.summary).toEqual({
      keptFromBase: 2,
      gaps: ['Rust'],
      coverage: { matched: ['Go'], total: 3 },
      postingPartial: true,
    })
    expect(got.generatedAt).toBe('2026-11-20T10:00:00.000Z')
    expect(got.editedAt).toBeNull()
  })

  it('content without verification keeps the summary null', () => {
    const got = detailDto(row0(), {
      content,
      coverLetter: null,
      verification: null,
      generatedAt: null,
      editedAt: new Date('2026-11-21T00:00:00.000Z'),
    } as never)
    expect(got.summary).toBeNull()
    expect(got.editedAt).toBe('2026-11-21T00:00:00.000Z')
  })
})

describe('pdfAnswer', () => {
  const r = (over: Record<string, unknown>) =>
    pdfAnswer({ runStatus: null, pdfStatus: 'IDLE', pdfS3Key: null, ...over } as never)
  it('a render in flight is pending even with an old key', () => {
    expect(r({ pdfStatus: 'QUEUED', pdfS3Key: 'k' })).toEqual({ kind: 'PENDING' })
    expect(r({ pdfStatus: 'RUNNING', pdfS3Key: 'k' })).toEqual({ kind: 'PENDING' })
  })
  it('during a regenerate the previous PDF is served', () => {
    expect(r({ runStatus: 'RUNNING', pdfStatus: 'READY', pdfS3Key: 'k' })).toEqual({
      kind: 'SERVE',
      key: 'k',
    })
  })
  it('the first run is pending; nothing at all is 404', () => {
    expect(r({ runStatus: 'QUEUED' })).toEqual({ kind: 'PENDING' })
    expect(r({ runStatus: 'RUNNING' })).toEqual({ kind: 'PENDING' })
    expect(r({ runStatus: 'FAILED' })).toEqual({ kind: 'NONE' })
    expect(pdfAnswer(undefined)).toEqual({ kind: 'NONE' })
  })
})

describe('generate (POST)', () => {
  const body = { overwrite: false }

  it('STARTED: authorizes in the tx, starts from the base version, audits ids only, enqueues after commit', async () => {
    const { svc, db, audit, runner } = make({ people: [person()] })
    let committed = false
    db.transaction.mockImplementation(async (cb) => {
      const out = await cb(db.tx)
      committed = true
      return out
    })
    runner.enqueue.mockImplementation(() => expect(committed).toBe(true))
    startRun.mockResolvedValueOnce({ kind: 'STARTED', rowId: ROW, runId: RUN })
    expect(await svc.generate(hr, OPP, S1.toUpperCase(), { ...body, teamId: TEAM.teamId })).toEqual(
      { runId: RUN },
    )
    expect(authorizeSenior).toHaveBeenCalledWith(expect.anything(), hr, OPP, S1, TEAM.teamId, db.tx)
    expect(startRun).toHaveBeenCalledWith(db.tx, {
      opportunityId: OPP,
      seniorId: S1,
      userId: hr.id,
      baseVersion: 3,
      overwrite: false,
    })
    expect(audit.record).toHaveBeenCalledWith(
      {
        actorId: hr.id,
        targetId: S1,
        action: 'tailored_resume_generate',
        changes: {
          opportunityId: { before: null, after: OPP },
          teamId: { before: null, after: TEAM.teamId },
          runId: { before: null, after: RUN },
          overwrite: { before: null, after: false },
        },
      },
      db.tx,
    )
    expect(runner.enqueue).toHaveBeenCalledWith(ROW, RUN)
    expect(loadOpportunity).toHaveBeenCalledWith(db.tx, OPP, ['DOU'])
    // both reads ask for exactly this senior; no record is missing, so no dirty-work read
    expect(db.params.filter((p) => p.includes(JSON.stringify([S1])))).toHaveLength(2)
    expect(db.sqls.some((s) => /job_dirty_work/.test(s))).toBe(false)
  })

  it('the default on-demand types come from the production catalog', () => {
    const svc = new TailoredResumesService(
      ...([
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ] as unknown as ConstructorParameters<typeof TailoredResumesService>),
    )
    expect(svc.onDemandTypes()).toEqual(['GREENHOUSE_ATS'])
  })

  it('a senior the read no longer finds is 422 NO_VERIFIED_RESUME, nothing starts', async () => {
    const { svc } = make({ people: [] })
    const got = await fail(svc.generate(hr, OPP, S1, body))
    expect([got.status, got.body['params']]).toEqual([422, { eligibility: 'NO_VERIFIED_RESUME' }])
    expect(startRun).not.toHaveBeenCalled()
  })

  it('a STUDIO scope audits teamId "studio"', async () => {
    const { svc, audit } = make({ people: [person()] })
    authorizeSenior.mockResolvedValueOnce({ kind: 'STUDIO' })
    startRun.mockResolvedValueOnce({ kind: 'STARTED', rowId: ROW, runId: RUN })
    await svc.generate(hr, OPP, S1, { overwrite: true })
    expect(audit.record.mock.calls[0]?.[0]).toMatchObject({
      changes: {
        teamId: { before: null, after: 'studio' },
        overwrite: { before: null, after: true },
      },
    })
  })

  it('an active run answers 202 with it before starting: no start, no audit, no enqueue', async () => {
    const { svc, audit, runner } = make({
      people: [person()],
      tailored: [{ id: ROW, senior_user_id: S1, run_status: 'RUNNING', run_id: RUN }],
    })
    expect(await svc.generate(hr, OPP, S1, body)).toEqual({ runId: RUN })
    expect(startRun).not.toHaveBeenCalled()
    expect(audit.record).not.toHaveBeenCalled()
    expect(runner.enqueue).not.toHaveBeenCalled()
  })

  it('a QUEUED run is active too; a finished one is not', async () => {
    const queued = make({
      people: [person()],
      tailored: [{ id: ROW, senior_user_id: S1, run_status: 'QUEUED', run_id: RUN }],
    })
    expect(await queued.svc.generate(hr, OPP, S1, body)).toEqual({ runId: RUN })
    expect(startRun).not.toHaveBeenCalled()
    const done = make({
      people: [person()],
      tailored: [{ id: ROW, senior_user_id: S1, run_status: 'FAILED', run_id: RUN }],
    })
    startRun.mockResolvedValueOnce({ kind: 'STARTED', rowId: ROW, runId: 'n' })
    expect(await done.svc.generate(hr, OPP, S1, body)).toEqual({ runId: 'n' })
  })

  it('startRun ACTIVE (a racing POST won) answers 202 with that run, no audit, no enqueue', async () => {
    const { svc, audit, runner } = make({ people: [person()] })
    startRun.mockResolvedValueOnce({ kind: 'ACTIVE', rowId: ROW, runId: RUN })
    expect(await svc.generate(hr, OPP, S1, body)).toEqual({ runId: RUN })
    expect(audit.record).not.toHaveBeenCalled()
    expect(runner.enqueue).not.toHaveBeenCalled()
  })

  it.each(['PUBLISHED', 'RENDERING', 'BUSY'])(
    'C5: startRun CONFLICT %s is the retryable 409, never a 500',
    async (reason) => {
      const { svc, runner } = make({ people: [person()] })
      startRun.mockResolvedValueOnce({ kind: 'CONFLICT', reason })
      const got = await fail(svc.generate(hr, OPP, S1, body))
      expect(got.status).toBe(409)
      expect(got.body).toMatchObject({ code: 'TAILORED_RESUME_CONFLICT' })
      expect(runner.enqueue).not.toHaveBeenCalled()
    },
  )

  it('eligibility POSTING_PENDING is 422 with params.eligibility, before any start', async () => {
    const { svc } = make({ people: [person()], pending: [{ one: 1 }] })
    loadOpportunity.mockResolvedValue(
      opportunity({ onDemandMissing: [{ recordId: ROW, version: 4 }] }),
    )
    const got = await fail(svc.generate(hr, OPP, S1, body))
    expect(got.status).toBe(422)
    expect(got.body).toMatchObject({
      code: 'TAILORED_RESUME_NOT_ELIGIBLE',
      params: { eligibility: 'POSTING_PENDING' },
    })
    expect(startRun).not.toHaveBeenCalled()
  })

  it('a missing record of a pending fetch (no PENDING/CLAIMED row) is READY', async () => {
    const { svc, db } = make({ people: [person()], pending: [] })
    loadOpportunity.mockResolvedValue(
      opportunity({ onDemandMissing: [{ recordId: ROW, version: 4 }] }),
    )
    startRun.mockResolvedValueOnce({ kind: 'STARTED', rowId: ROW, runId: RUN })
    expect(await svc.generate(hr, OPP, S1, body)).toEqual({ runId: RUN })
    const pendingSql = db.sqls.find((s) => /FROM job_dirty_work/.test(s)) ?? ''
    expect(pendingSql).toMatch(/status IN \('PENDING', 'CLAIMED'\)/)
    expect(pendingSql).toMatch(/entity_kind = 'SOURCE_RECORD'/)
  })

  it('no base resume is 422 NO_VERIFIED_RESUME; an unverified base too', async () => {
    const none = make({
      people: [person({ version: null, verification_status: null, content: null })],
    })
    expect((await fail(none.svc.generate(hr, OPP, S1, body))).body).toMatchObject({
      params: { eligibility: 'NO_VERIFIED_RESUME' },
    })
    const draft = make({ people: [person({ verification_status: 'DRAFT' })] })
    expect((await fail(draft.svc.generate(hr, OPP, S1, body))).status).toBe(422)
  })

  it('a malformed senior id or a gone opportunity is the uniform 404', async () => {
    const { svc } = make({ people: [person()] })
    const bad = await fail(svc.generate(hr, OPP, 'nope', body))
    expect(bad.status).toBe(404)
    expect(bad.body).toMatchObject({ code: 'JOB_OPPORTUNITY_NOT_FOUND' })
    expect(authorizeSenior).not.toHaveBeenCalled()
    loadOpportunity.mockResolvedValueOnce(null)
    expect((await fail(svc.generate(hr, OPP, S1, body))).status).toBe(404)
  })

  it('a throwing audit insert rolls back: the error surfaces and nothing is enqueued', async () => {
    const { svc, audit, runner } = make({ people: [person()] })
    startRun.mockResolvedValueOnce({ kind: 'STARTED', rowId: ROW, runId: RUN })
    audit.record.mockRejectedValueOnce(new Error('insert failed'))
    expect((await fail(svc.generate(hr, OPP, S1, body))).body).toEqual({
      err: 'Error: insert failed',
    })
    expect(runner.enqueue).not.toHaveBeenCalled()
  })

  it('a deadlock gets one rerun; a second is the retryable 409', async () => {
    const deadlock = Object.assign(new Error('deadlock'), { code: '40P01' })
    const { svc, db } = make({ people: [person()] })
    startRun.mockRejectedValueOnce(deadlock)
    startRun.mockResolvedValueOnce({ kind: 'STARTED', rowId: ROW, runId: RUN })
    expect(await svc.generate(hr, OPP, S1, body)).toEqual({ runId: RUN })
    expect(db.transaction).toHaveBeenCalledTimes(2)
    startRun.mockRejectedValueOnce(deadlock).mockRejectedValueOnce(deadlock)
    const got = await fail(svc.generate(hr, OPP, S1, body))
    expect(got.status).toBe(409)
    expect(got.body).toMatchObject({ code: 'TAILORED_RESUME_CONFLICT' })
  })
})

describe('list (batch GET)', () => {
  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `0b5e0000-0000-4000-8000-${String(i).padStart(12, '0')}`)

  it('a fixed number of queries for 1 and for 100 seniors, and it never enqueues', async () => {
    const one = make({ people: [person()] })
    visibleSeniors.mockResolvedValueOnce(ids(1))
    await one.svc.list(hr, OPP, { seniorIds: ids(1) })
    const hundred = make({ people: ids(100).map((id) => person({ id })) })
    visibleSeniors.mockResolvedValueOnce(ids(100))
    const rows = await hundred.svc.list(hr, OPP, { seniorIds: ids(100) })
    expect(rows).toHaveLength(100)
    expect(one.db.execute.mock.calls.length).toBeGreaterThan(0)
    expect(hundred.db.execute).toHaveBeenCalledTimes(one.db.execute.mock.calls.length)
    expect(hundred.runner.enqueue).not.toHaveBeenCalled()
    expect(hundred.db.transaction).not.toHaveBeenCalled()
  })

  it('resolves and checks visibility, then answers only the visible seniors, in their order', async () => {
    const [a, b] = ids(2) as [string, string]
    const { svc, scopes, db } = make({
      people: [person({ id: a }), person({ id: b, display_name: 'Ж' })],
      tailored: [
        { id: ROW, senior_user_id: b, run_status: 'QUEUED', run_id: RUN, pdf_status: 'IDLE' },
      ],
    })
    visibleSeniors.mockResolvedValueOnce([b, a])
    const rows = await svc.list(hr, OPP, {
      teamId: TEAM.teamId,
      seniorIds: [a, b, ids(3)[2] as string],
    })
    expect(scopes.resolve).toHaveBeenCalledWith(hr, TEAM.teamId, db.db)
    expect(scopes.assertVisible).toHaveBeenCalledWith(TEAM, OPP, db.db)
    expect(visibleSeniors).toHaveBeenCalledWith(scopes, TEAM, OPP, [a, b, ids(3)[2]], db.db)
    expect(rows.map((r) => [r.seniorId, r.eligibility, r.runStatus])).toEqual([
      [b, 'NON_LATIN_NAME', 'QUEUED'],
      [a, 'READY', null],
    ])
  })

  it('a NONE scope is the uniform 404; no visible senior answers [] without reads', async () => {
    const { svc, scopes, db } = make()
    scopes.resolve.mockResolvedValueOnce({ kind: 'NONE' } as never)
    expect((await fail(svc.list(hr, OPP, { seniorIds: [S1] }))).status).toBe(404)
    visibleSeniors.mockResolvedValueOnce([])
    expect(await svc.list(hr, OPP, { seniorIds: [S1] })).toEqual([])
    expect(db.execute).not.toHaveBeenCalled()
  })
})

describe('detail and pdf (GET)', () => {
  const published = {
    id: ROW,
    senior_user_id: S1,
    run_status: 'SUCCEEDED',
    run_id: RUN,
    pdf_status: 'READY',
    pdf_s3_key: 'tailored-resumes/x/run-y.pdf',
    content,
    cover_letter: 'Dear Hiring Team,',
    verification,
    base_version: 3,
    opportunity_revision: 7,
    generated_at: new Date('2026-11-20T10:00:00.000Z'),
    edited_at: new Date('2026-11-21T08:30:00.000Z'),
  }

  it('detail authorizes the senior on the root handle and answers the published variant', async () => {
    const { svc, db } = make({ people: [person()], tailored: [published] })
    const got = await svc.detail(hr, OPP, S1, TEAM.teamId)
    expect(authorizeSenior).toHaveBeenCalledWith(expect.anything(), hr, OPP, S1, TEAM.teamId, db.db)
    expect(got).toMatchObject({
      seniorId: S1,
      published: true,
      baseChanged: false,
      coverLetter: 'Dear Hiring Team,',
      generatedAt: '2026-11-20T10:00:00.000Z',
      editedAt: '2026-11-21T08:30:00.000Z',
    })
    expect(db.params.filter((p) => p.includes(JSON.stringify([S1])))).toHaveLength(2)
  })

  it('a senior deleted after the authorize is the uniform 404 on detail and pdf', async () => {
    const { svc, s3 } = make({ people: [], tailored: [published] })
    for (const got of [
      await fail(svc.detail(hr, OPP, S1, undefined)),
      await fail(svc.pdf(hr, OPP, S1, undefined)),
    ]) {
      expect([got.status, got.body['code']]).toEqual([404, 'JOB_OPPORTUNITY_NOT_FOUND'])
    }
    expect(s3.getObject).not.toHaveBeenCalled()
  })

  it('pdf serves the published key with the D15 file name', async () => {
    const { svc, s3 } = make({ people: [person()], tailored: [published] })
    const got = await svc.pdf(hr, OPP, S1, undefined)
    expect(s3.getObject).toHaveBeenCalledWith('tailored-resumes/x/run-y.pdf')
    expect(got).toEqual({
      kind: 'PDF',
      body: Buffer.from('%PDF'),
      filename: {
        ascii: 'Tara Prep - Senior Dev - CV.pdf',
        utf8: 'Tara%20Prep%20-%20Senior%20Dev%20-%20CV.pdf',
      },
    })
  })

  it('pdf: 202-pending during the first run, 404 when nothing exists', async () => {
    const first = make({
      people: [person()],
      tailored: [
        { id: ROW, senior_user_id: S1, run_status: 'RUNNING', run_id: RUN, pdf_status: 'IDLE' },
      ],
    })
    expect(await first.svc.pdf(hr, OPP, S1, undefined)).toEqual({ kind: 'PENDING' })
    expect(first.s3.getObject).not.toHaveBeenCalled()
    const none = make({ people: [person()] })
    const got = await fail(none.svc.pdf(hr, OPP, S1, undefined))
    expect(got.status).toBe(404)
    expect(got.body).toMatchObject({ code: 'JOB_OPPORTUNITY_NOT_FOUND' })
  })

  it('a malformed senior id is the 404 before authorize', async () => {
    const { svc } = make()
    expect((await fail(svc.detail(hr, OPP, 'x', undefined))).status).toBe(404)
    expect((await fail(svc.pdf(hr, OPP, 'x', undefined))).status).toBe(404)
    expect(authorizeSenior).not.toHaveBeenCalled()
  })
})
