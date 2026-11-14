/**
 * Unit spec of a look write (`setLayout` / `setTemplate` → `writeLook`), `resolveMiss` and the facts
 * read of `toDtoFields` over the recording DB double. The same writes on a real Postgres are in the
 * integration specs; this spec is what the mutation gate can see.
 */
import { HttpException, Logger } from '@nestjs/common'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RESUME_LAYOUT, EMPTY_RESUME_CONTENT, type ResumeLayoutOptions } from '@crm/shared'
import type { SeniorResume } from '../../database/schema'
import { fakeRunDb } from '../../test/fake-run-db'
import { ResumeVerificationService } from './resume-verification.service'

const dialect = new PgDialect()
const render = (v: unknown) => dialect.sqlToQuery(v as SQL).sql
const COMPACT: ResumeLayoutOptions = { ...DEFAULT_RESUME_LAYOUT, density: 'compact' }
const SPACIOUS: ResumeLayoutOptions = { ...DEFAULT_RESUME_LAYOUT, fontScale: 'large' }

const ROW = {
  id: 'r-1',
  userId: 'u-1',
  status: 'READY',
  content: EMPTY_RESUME_CONTENT,
  facts: null,
  layout: COMPACT,
  templateName: 'modern',
  templateSource: null,
  verificationStatus: 'DRAFT',
  verificationRunId: null,
  verificationErrorCode: null,
  verificationReport: { gates: [], fallbacks: ['summary'] },
  verifiedByUserId: null,
  stagedPdfS3Key: null,
  stagedEditedPaths: [],
  version: 4,
} as unknown as SeniorResume

function service(results: unknown[][]) {
  const db = fakeRunDb(results)
  const s3 = { delete: vi.fn(async (_key: string) => {}) }
  const runner = { run: vi.fn(async (_id: string, _run: string) => {}) }
  const svc = new ResumeVerificationService(db.service, s3 as never, runner as never)
  return { svc, s3, runner, log: db.log }
}

afterEach(() => vi.restoreAllMocks())

describe('a look write on a VERIFIED row starts a template run', () => {
  const verified = { ...ROW, verificationStatus: 'VERIFIED' } as SeniorResume

  it('stages the live content and version, keeps the stored layout, then runs', async () => {
    const { svc, runner, log } = service([[verified]])
    await svc.setTemplate(verified, 'classic', 'hr-1')
    const set = log[0]?.set ?? {}
    expect(set).toMatchObject({
      verificationKind: 'template',
      stagedTemplateName: 'classic',
      stagedLayout: COMPACT,
      verificationReport: { gates: [], fallbacks: ['summary'] },
    })
    expect(render(set['verificationBaseVersion'])).toBe('"senior_resumes"."version"')
    expect(render(set['stagedContent'])).toBe('"senior_resumes"."content"')
    expect(runner.run).toHaveBeenCalledWith('r-1', set['verificationRunId'])
  })

  it('a new layout is the staged one', async () => {
    const { svc, log } = service([[verified]])
    await svc.setLayout(verified, SPACIOUS, 'hr-1')
    expect(log[0]?.set).toMatchObject({ stagedLayout: SPACIOUS, stagedTemplateName: 'modern' })
  })

  it('deletes no staged PDF: the template run leaves the column, so the row still names it', async () => {
    const named = { ...verified, stagedPdfS3Key: 'resumes/r-1/staged/run-0.pdf' } as SeniorResume
    const { svc, s3, log } = service([[named]])
    await svc.setTemplate(named, 'classic', 'hr-1')
    expect(log[0]?.set).not.toHaveProperty('stagedPdfS3Key')
    expect(s3.delete).not.toHaveBeenCalled()
  })
})

describe('a look write on a row that is not VERIFIED', () => {
  it('AWAITING_CONFIRM: back to DRAFT, then the staged PDF goes', async () => {
    const awaiting = {
      ...ROW,
      verificationStatus: 'AWAITING_CONFIRM',
      stagedPdfS3Key: 'resumes/r-1/staged/run.pdf',
    } as SeniorResume
    const { svc, s3, runner, log } = service([[awaiting]])
    await svc.setLayout(awaiting, SPACIOUS, 'hr-1')
    expect(log[0]?.set).toMatchObject({ layout: SPACIOUS, verificationStatus: 'DRAFT' })
    expect(s3.delete).toHaveBeenCalledWith('resumes/r-1/staged/run.pdf')
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('DRAFT: the look and the next version only; nothing deleted, no run', async () => {
    const { svc, s3, runner, log } = service([[ROW]])
    await svc.setTemplate(ROW, 'classic', 'hr-1')
    const set = log[0]?.set ?? {}
    expect(set['templateName']).toBe('classic')
    expect(render(set['version'])).toBe('"senior_resumes"."version" + 1')
    expect(set).not.toHaveProperty('verificationStatus')
    expect(s3.delete).not.toHaveBeenCalled()
    expect(runner.run).not.toHaveBeenCalled()
  })
})

describe('resolveMiss', () => {
  async function refusal(p: Promise<unknown>): Promise<HttpException> {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    )
    if (!(err instanceof HttpException)) throw new Error('expected an HttpException')
    return err
  }

  it('a row gone answers 404', async () => {
    const { svc, log } = service([[], []])
    const err = await refusal(svc.setTemplate(ROW, 'classic', 'hr-1'))
    expect(err.getStatus()).toBe(404)
    expect(err.message).toBe('Резюме не найдено')
    expect(log[1]?.columns).toEqual(['id'])
  })

  it('a row still there answers 409 busy', async () => {
    const { svc } = service([[], [{ id: 'r-1' }]])
    const err = await refusal(svc.setTemplate(ROW, 'classic', 'hr-1'))
    expect(err.getStatus()).toBe(409)
    expect(err.getResponse()).toMatchObject({ code: 'RESUME_VERIFICATION_BUSY' })
  })
})

describe('the facts a DTO shows', () => {
  it('a legacy row without facts maps them from content, and warns nothing', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const { svc } = service([])
    const dto = await svc.toDtoFields(ROW)
    expect(dto.facts.skills).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('stored facts that do not parse are mapped from content, with one warn', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const { svc } = service([])
    await svc.toDtoFields({ ...ROW, facts: { headline: 1 } } as unknown as SeniorResume)
    expect(warn).toHaveBeenCalledWith(
      'Stored resume facts failed validation — mapping from content',
    )
  })
})

describe('the verification fields a DTO shows', () => {
  function withVerifier(displayName: string) {
    const findFirst = vi.fn(async () => ({ displayName }))
    const db = { db: { query: { users: { findFirst } } } }
    const svc = new ResumeVerificationService(db as never, {} as never, {} as never)
    return { svc, findFirst }
  }
  const HR_ID = '00000000-0000-4000-8000-000000000001'
  const STAGED_ROW = {
    ...ROW,
    verificationStatus: 'AWAITING_CONFIRM',
    verificationErrorCode: 'WRITER_UNAVAILABLE',
    verifiedVersion: 3,
    verifiedAt: new Date('2026-11-01T10:00:00.000Z'),
    verifiedByUserId: 'u-9',
    stagedPdfS3Key: 'resumes/r-1/staged/run-1.pdf',
    verificationRunId: 'run-1',
    stagedTemplateName: 'classic',
    stagedEditedPaths: [{ path: 'summary', userId: HR_ID }],
  } as unknown as SeniorResume

  it('stored values reach the DTO, and a staged PDF with its run makes the confirm step', async () => {
    const { svc, findFirst } = withVerifier('Olena K.')
    const dto = await svc.toDtoFields(STAGED_ROW)
    expect(findFirst).toHaveBeenCalledTimes(1)
    expect(dto).toMatchObject({
      verificationStatus: 'AWAITING_CONFIRM',
      verificationErrorCode: 'WRITER_UNAVAILABLE',
      verificationReport: { gates: [], fallbacks: ['summary'] },
      verifiedVersion: 3,
      verifiedAt: '2026-11-01T10:00:00.000Z',
      verifiedByName: 'Olena K.',
      staged: {
        runId: 'run-1',
        templateName: 'classic',
        pdfAvailable: true,
        editedPaths: [{ path: 'summary', userId: HR_ID }],
      },
    })
  })

  it.each([
    ['a staged PDF without a run (a swept row)', { verificationRunId: null }],
    ['a run without a staged PDF (a template run)', { stagedPdfS3Key: null }],
  ])('%s makes no confirm step', async (_, patch) => {
    const { svc } = withVerifier('Olena K.')
    const dto = await svc.toDtoFields({ ...STAGED_ROW, ...patch } as SeniorResume)
    expect(dto.staged).toBeNull()
  })
})
