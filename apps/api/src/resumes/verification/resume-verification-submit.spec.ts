/**
 * Unit spec of `ResumeVerificationService.submit` (Task 14, rulings P5(a) and P7) over a recording DB
 * double: the refusals and their order, the queued write and its guard, and what happens after it.
 * Two concurrent submits on a real Postgres are in verification-runner.integration.spec.ts.
 */
import { HttpException } from '@nestjs/common'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import type { ResumeFacts } from '@crm/shared'
import type { SeniorResume } from '../../database/schema'
import { markSeniorResumeDirty } from '../../job-sourcing/dirty-producers'
import { fakeRunDb } from '../../test/fake-run-db'
import { ResumeVerificationService } from './resume-verification.service'
import { CLEARED_STAGED } from './verification-runner'

// Senior roles PR 4: the roster dirty mark is covered by resume-dirty.integration.spec.ts.
vi.mock('../../job-sourcing/dirty-producers')

const FACTS: ResumeFacts = {
  headline: 'Senior Backend Engineer',
  location: { city: 'Lisbon', country: 'Portugal' },
  workFormat: 'remote',
  skills: ['TypeScript', 'NestJS', 'PostgreSQL', 'Docker', 'Kafka'],
  experience: [
    {
      company: 'Acme Corp',
      role: 'Tech Lead',
      location: null,
      start: '2021-03',
      end: null,
      current: true,
      technologies: ['TypeScript'],
      notes: ['Led the payments team', 'Moved billing to PostgreSQL'],
    },
  ],
  education: [
    { institution: 'Stanford University', degree: 'BSc Physics', startYear: 2010, endYear: 2014 },
  ],
  languages: [{ name: 'English', level: 'C1' }],
  links: [{ label: 'GitHub', url: 'https://github.com/janedoe-unit' }],
}

const ROW = {
  id: 'r-1',
  status: 'READY',
  templateSource: null,
  verificationStatus: 'AWAITING_CONFIRM',
  verificationRunId: null,
  facts: FACTS,
  content: null,
  stagedPdfS3Key: 'resumes/r-1/staged/old.pdf',
  version: 7,
} as unknown as SeniorResume

function service(results: unknown[][]) {
  const db = fakeRunDb(results)
  const s3 = { delete: vi.fn(async (_key: string) => {}) }
  const runner = { run: vi.fn(async (_id: string, _run: string) => {}) }
  const svc = new ResumeVerificationService(db.service, s3 as never, runner as never)
  return { svc, s3, runner, log: db.log }
}

async function refusal(p: Promise<unknown>): Promise<HttpException> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(err instanceof HttpException)) throw new Error('expected an HttpException')
  return err
}

describe('ResumeVerificationService.submit', () => {
  it('queues a full run with a new run id, clears the staged columns, then fires the runner', async () => {
    const queued = { ...ROW, verificationStatus: 'QUEUED', userId: 'u-1' }
    const { svc, s3, runner, log } = service([[queued]])
    vi.mocked(markSeniorResumeDirty).mockClear()
    const out = await svc.submit(ROW, 'Jane Doe', 'viewer-1')

    expect(out).toBe(queued)
    expect(log).toHaveLength(1)
    const set = log[0]?.set as Record<string, unknown>
    expect(set).toMatchObject({
      facts: FACTS,
      verificationStatus: 'QUEUED',
      verificationKind: 'full',
      verificationTargetPath: null,
      verificationStartedAt: null,
      verificationErrorCode: null,
      verificationReport: null,
      ...CLEARED_STAGED,
      updatedByUserId: 'viewer-1',
    })
    expect(set.verificationQueuedAt).toBeInstanceOf(Date)
    expect(set.updatedAt).toBeInstanceOf(Date)
    expect(set.verificationRunId).toMatch(/^[0-9a-f-]{36}$/u)
    // The base version is the row's own version column, read in the same UPDATE.
    expect(new PgDialect().sqlToQuery(set.verificationBaseVersion as SQL)).toEqual({
      sql: '"senior_resumes"."version"',
      params: [],
    })
    expect(runner.run).toHaveBeenCalledWith('r-1', set.verificationRunId)
    // Senior roles PR 4: the queued write marks the senior's resume dirty, inside its transaction.
    expect(vi.mocked(markSeniorResumeDirty).mock.calls).toEqual([[expect.anything(), 'u-1']])
    // The old staged object goes after the write.
    expect(s3.delete.mock.calls).toEqual([['resumes/r-1/staged/old.pdf']])

    const where = log[0]?.where
    expect(where?.params).toEqual(
      expect.arrayContaining([
        'r-1',
        'resumes/r-1/staged/old.pdf',
        'DRAFT',
        'FAILED',
        'AWAITING_CONFIRM',
        'QUEUED',
        'RUNNING',
        7,
      ]),
    )
    expect(where?.sql).toContain('"senior_resumes"."template_source" is null')
    expect(where?.sql).toContain('"senior_resumes"."status" not in')
    expect(where?.sql).toContain('"senior_resumes"."version" = $')
  })

  it('a second run id each time', async () => {
    const a = service([[ROW]])
    const b = service([[ROW]])
    await a.svc.submit(ROW, 'Jane Doe', 'v')
    await b.svc.submit(ROW, 'Jane Doe', 'v')
    expect(a.log[0]?.set?.verificationRunId).not.toBe(b.log[0]?.set?.verificationRunId)
  })

  it('a custom template is 422 RESUME_CUSTOM_TEMPLATE, checked first', async () => {
    const { svc, log } = service([])
    const row = { ...ROW, templateSource: '#let render(d) = []', status: 'RUNNING' } as SeniorResume
    const err = await refusal(svc.submit(row, 'Jane Doe', 'v'))
    expect(err.getStatus()).toBe(422)
    expect(err.getResponse()).toMatchObject({ code: 'RESUME_CUSTOM_TEMPLATE' })
    expect(log).toHaveLength(0)
  })

  it.each([
    ['a queued run', { verificationStatus: 'QUEUED', verificationRunId: 'run-0' }],
    ['a checking run', { verificationStatus: 'CHECKING', verificationRunId: 'run-0' }],
    ['a queued extraction', { status: 'QUEUED' }],
    ['a running extraction', { status: 'RUNNING' }],
  ])('%s is 409 RESUME_VERIFICATION_BUSY before completeness', async (_label, over) => {
    const { svc, log } = service([])
    const row = { ...ROW, ...over, facts: { ...FACTS, skills: [] } } as SeniorResume
    const err = await refusal(svc.submit(row, 'Jane Doe', 'v'))
    expect(err.getStatus()).toBe(409)
    expect(err.getResponse()).toMatchObject({ code: 'RESUME_VERIFICATION_BUSY' })
    expect(log).toHaveLength(0)
  })

  it('an idle VERIFIED resume is 409 RESUME_ALREADY_VERIFIED and starts nothing', async () => {
    const { svc, s3, runner, log } = service([])
    const row = { ...ROW, verificationStatus: 'VERIFIED' } as SeniorResume
    const err = await refusal(svc.submit(row, 'Jane Doe', 'v'))
    expect(err.getStatus()).toBe(409)
    expect(err.getResponse()).toMatchObject({ code: 'RESUME_ALREADY_VERIFIED' })
    expect(log).toHaveLength(0)
    expect(runner.run).not.toHaveBeenCalled()
    expect(s3.delete).not.toHaveBeenCalled()
  })

  it('a VERIFIED resume flagged "re-check needed" queues a full run and keeps the flag (backlog 442)', async () => {
    const row = {
      ...ROW,
      verificationStatus: 'VERIFIED',
      recheckNeededAt: new Date('2026-11-15T10:00:00.000Z'),
    } as SeniorResume
    const { svc, runner, log } = service([[{ ...row, verificationStatus: 'QUEUED' }]])
    await svc.submit(row, 'Jane Doe', 'v')
    expect(log).toHaveLength(1)
    const set = log[0]?.set as Record<string, unknown>
    expect(set.verificationStatus).toBe('QUEUED')
    // Only the confirm clears the flag: a failed re-check still says "re-check needed".
    expect(set).not.toHaveProperty('recheckNeededAt')
    // The UPDATE takes a VERIFIED row only while it is flagged.
    const where = log[0]?.where
    expect(where?.sql).toContain(
      'in ($6, $7, $8) or ("senior_resumes"."verification_status" = $9 and "senior_resumes"."recheck_needed_at" is not null))',
    )
    expect(where?.params.slice(5, 9)).toEqual(['DRAFT', 'FAILED', 'AWAITING_CONFIRM', 'VERIFIED'])
    expect(runner.run).toHaveBeenCalledWith('r-1', set.verificationRunId)
  })

  it('an incomplete resume is 422 RESUME_INCOMPLETE without the issue list (P7)', async () => {
    const { svc, runner, log } = service([])
    const row = { ...ROW, facts: { ...FACTS, experience: [] } } as SeniorResume
    const err = await refusal(svc.submit(row, 'Jane Doe', 'v'))
    expect(err.getStatus()).toBe(422)
    const body = err.getResponse() as Record<string, unknown>
    expect(body.code).toBe('RESUME_INCOMPLETE')
    expect(body.params).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('experience')
    expect(log).toHaveLength(0)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it.each([
    ['a phone', 'Call +380 67 123 45 67'],
    ['the senior’s full name (R62)', 'jane DOE led the payments team'],
  ])('%s in a note is 422 RESUME_INCOMPLETE and starts nothing', async (_label, note) => {
    const { svc, runner, log } = service([])
    const experience = [{ ...FACTS.experience[0]!, notes: [note] }]
    const row = { ...ROW, facts: { ...FACTS, experience } } as SeniorResume
    const err = await refusal(svc.submit(row, 'Jane Doe', 'v'))
    expect(err.getStatus()).toBe(422)
    expect(err.getResponse()).toMatchObject({ code: 'RESUME_INCOMPLETE' })
    expect(log).toHaveLength(0)
    expect(runner.run).not.toHaveBeenCalled()
  })

  // PR #1351 round 5 (SR-H-3): the redaction misses a name with a bare mark at its edge, so the
  // completeness flag main had is what keeps it from the model.
  it.each([
    ['Ivan Petrenko', 'Ivan Petrenko\u0903x led the team'],
    ['김민준', '김민준\u03017 led the team'],
    ['김 민준', '김 민준\u03017 led the team'],
  ])('a name of %j with a bare mark at its edge is 422 RESUME_INCOMPLETE', async (name, note) => {
    const { svc, runner, log } = service([])
    const experience = [{ ...FACTS.experience[0]!, notes: [note] }]
    const row = { ...ROW, facts: { ...FACTS, experience } } as SeniorResume
    const err = await refusal(svc.submit(row, name, 'v'))
    expect(err.getStatus()).toBe(422)
    expect(err.getResponse()).toMatchObject({ code: 'RESUME_INCOMPLETE' })
    expect(log).toHaveLength(0)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a link the server would refuse (LINK_INVALID)',
      { links: [{ label: 'Site', url: 'http://x.com' }] },
    ],
    [
      'an education year out of range (YEAR_INVALID)',
      { education: [{ ...FACTS.education[0]!, startYear: 1949 }] },
    ],
  ])('%s is 422 RESUME_INCOMPLETE and starts nothing', async (_label, over) => {
    const { svc, runner, log } = service([])
    const row = { ...ROW, facts: { ...FACTS, ...over } } as SeniorResume
    const err = await refusal(svc.submit(row, 'Jane Doe', 'v'))
    expect(err.getStatus()).toBe(422)
    expect(err.getResponse()).toMatchObject({ code: 'RESUME_INCOMPLETE' })
    expect(log).toHaveLength(0)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('a write that misses on a row that still exists is 409 and starts nothing', async () => {
    const { svc, s3, runner, log } = service([[], [{ id: 'r-1' }]])
    vi.mocked(markSeniorResumeDirty).mockClear()
    const err = await refusal(svc.submit(ROW, 'Jane Doe', 'v'))
    expect(err.getStatus()).toBe(409)
    expect(log.map((q) => q.op)).toEqual(['update', 'select'])
    expect(runner.run).not.toHaveBeenCalled()
    expect(s3.delete).not.toHaveBeenCalled()
    // A write that matched nothing marks nothing: the dirty row would never be cleared.
    expect(markSeniorResumeDirty).not.toHaveBeenCalled()
  })

  it('a write that misses on a deleted row is 404', async () => {
    const { svc } = service([[], []])
    const err = await refusal(svc.submit(ROW, 'Jane Doe', 'v'))
    expect(err.getStatus()).toBe(404)
    expect(err.getResponse()).toMatchObject({ code: 'RESUME_NOT_FOUND' })
  })

  it('from DRAFT with no staged object deletes nothing', async () => {
    const row = { ...ROW, verificationStatus: 'DRAFT', stagedPdfS3Key: null } as SeniorResume
    const { svc, s3, runner } = service([[row]])
    await svc.submit(row, 'Jane Doe', 'v')
    expect(s3.delete).not.toHaveBeenCalled()
    expect(runner.run).toHaveBeenCalledTimes(1)
  })
})
