/**
 * Unit spec of `ResumeVerificationService.confirm`, `editStagedField` and `regenerateStagedField`
 * (Task 15) over a recording DB double: the refusals, the CAS writes and what follows them. The
 * same paths on a real Postgres are in resume-verification-confirm.integration.spec.ts; this spec
 * is what the mutation gate can see.
 */
import { BadRequestException, HttpException } from '@nestjs/common'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import { RESUME_LIMITS, type ResumeContent } from '@crm/shared'
import type { SeniorResume } from '../../database/schema'
import { fakeRunDb } from '../../test/fake-run-db'
import {
  editPathCap,
  isRegeneratePath,
  ResumeVerificationService,
} from './resume-verification.service'
import { CLEARED_STAGED } from './verification-runner'
import { renderOwnerKey } from './run-columns'

const RUN = 'a15e0000-0000-4000-8000-000000000001'
const HR0 = 'a15e0000-0000-4000-8000-0000000000b0'
const HR1 = 'a15e0000-0000-4000-8000-0000000000b1'
const STAGED: ResumeContent = {
  summary: 'Backend engineer.',
  skills: ['TypeScript'],
  experience: [
    {
      company: 'Acme Corp',
      role: 'Tech Lead',
      period: 'Mar 2021 – Present',
      bullets: ['Led the payments team', 'Moved billing to PostgreSQL'],
    },
    {
      company: 'Globex',
      role: 'Engineer',
      period: 'Jan 2018 – Feb 2021',
      bullets: ['Built the billing service'],
    },
  ],
  education: [],
  languages: [],
  links: [],
}

const ROW = {
  id: 'r-1',
  userId: 'u-1',
  templateSource: null,
  verificationStatus: 'AWAITING_CONFIRM',
  verificationRunId: RUN,
  stagedContent: STAGED,
  stagedEditedPaths: [],
  stagedPdfS3Key: 'resumes/r-1/staged/run.pdf',
  pdfS3Key: 'resumes/r-1/live.pdf',
  version: 7,
  verificationReport: {
    gates: [],
    fallbacks: [],
    ownerKey: renderOwnerKey({ displayName: 'Jane Doe', email: 'jane@unit.spec' }),
  },
} as unknown as SeniorResume
/** The owner the staged run rendered with, as the confirm reads it. */
const OWNER_REF = { displayName: 'Jane Doe', email: 'jane@unit.spec' }

const dialect = new PgDialect()
const OWNER = [{ displayName: 'Jane Doe', email: 'jane@unit.spec', legalFullName: null }]

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

async function expectCode(p: Promise<unknown>, status: number, code: string, params?: object) {
  const err = await refusal(p)
  expect(err.getStatus()).toBe(status)
  expect(err.getResponse()).toMatchObject(params ? { code, params } : { code })
}

describe('editPathCap / isRegeneratePath (P8, P10)', () => {
  it('caps a summary at the summary limit and a bullet at the bullet limit', () => {
    expect(editPathCap('summary', STAGED)).toBe(RESUME_LIMITS.summary)
    expect(editPathCap('experience.0.bullets.1', STAGED)).toBe(RESUME_LIMITS.bullet)
    expect(editPathCap('experience.1.bullets.0', STAGED)).toBe(RESUME_LIMITS.bullet)
  })

  it('names no text for an out-of-bounds or foreign path', () => {
    for (const path of [
      'experience.0.bullets.2',
      'experience.2.bullets.0',
      'experience.0.bullets',
      'headline',
      'xexperience.0.bullets.0',
      'experience.0.bullets.0x',
      'summary.0',
    ]) {
      expect(editPathCap(path, STAGED)).toBeNull()
    }
  })

  it('refuses a leading-zero index: an accepted path has one spelling (SR-H-1)', () => {
    for (const path of [
      'experience.01.bullets.0',
      'experience.0.bullets.00',
      'experience.00.bullets.0',
      'experience.0.bullets.01',
    ]) {
      expect(editPathCap(path, STAGED)).toBeNull()
    }
  })

  it('reads multi-digit item and bullet indexes', () => {
    const item = { ...STAGED.experience[0]!, bullets: Array.from({ length: 101 }, () => 'b') }
    const wide = { ...STAGED, experience: Array.from({ length: 101 }, () => item) }
    expect(editPathCap('experience.10.bullets.10', wide)).toBe(RESUME_LIMITS.bullet)
    expect(editPathCap('experience.100.bullets.100', wide)).toBe(RESUME_LIMITS.bullet)
    expect(editPathCap('experience.10.bullets.101', wide)).toBeNull()
  })

  it('accepts summary and an in-bounds item as regenerate paths, nothing else', () => {
    expect(isRegeneratePath('summary', STAGED)).toBe(true)
    expect(isRegeneratePath('experience.0.bullets', STAGED)).toBe(true)
    expect(isRegeneratePath('experience.1.bullets', STAGED)).toBe(true)
    expect(isRegeneratePath('experience.2.bullets', STAGED)).toBe(false)
    expect(isRegeneratePath('experience.0.bullets.0', STAGED)).toBe(false)
    expect(isRegeneratePath('headline', STAGED)).toBe(false)
    expect(isRegeneratePath('experience.01.bullets', STAGED)).toBe(false)
  })
})

describe('ResumeVerificationService.confirm', () => {
  const input = { runId: RUN, version: 7 }

  it('promotes in one locked transaction with a CAS on run, version, status and template', async () => {
    const won = { ...ROW, verificationStatus: 'VERIFIED' }
    const { svc, s3, log } = service([[{ key: 'resumes/r-1/live.pdf' }], [won]])
    const out = await svc.confirm(ROW, input, HR1, 'fp-1', OWNER_REF)
    expect(out).toBe(won)
    expect(log.map((q) => [q.op, q.locked, q.inTransaction])).toEqual([
      ['select', true, true],
      ['update', false, true],
    ])
    const update = log[1]
    expect(update?.set).toMatchObject({
      pdfFingerprint: 'fp-1',
      pdfRenderStatus: 'READY',
      pdfRenderError: null,
      pdfRenderRunId: null,
      pdfRenderStartedAt: null,
      verifiedByUserId: HR1,
      verificationStatus: 'VERIFIED',
      verificationRunId: null,
      verificationKind: null,
      verificationTargetPath: null,
      verificationBaseVersion: null,
      verificationQueuedAt: null,
      verificationStartedAt: null,
      verificationErrorCode: null,
      updatedByUserId: HR1,
      ...CLEARED_STAGED,
    })
    expect(update?.set?.['verifiedAt']).toBeInstanceOf(Date)
    expect(update?.set?.['updatedAt']).toBe(update?.set?.['verifiedAt'])
    expect(update?.where?.sql).toContain('"template_source" is null')
    expect(update?.where?.sql).toContain('"verification_status" = $')
    expect(update?.where?.params).toEqual(
      expect.arrayContaining(['r-1', RUN, 7, 'AWAITING_CONFIRM', 'QUEUED', 'RUNNING']),
    )
    expect(update?.where?.sql).toContain('"status" not in')
    // the replaced live object goes after the commit
    expect(s3.delete).toHaveBeenCalledTimes(1)
    expect(s3.delete).toHaveBeenCalledWith('resumes/r-1/live.pdf')
  })

  it('locks the live key only, and promotes the staged columns with version + 1', async () => {
    const { svc, log } = service([[{ key: null }], [ROW]])
    await svc.confirm(ROW, input, HR1, 'fp', OWNER_REF)
    expect(log[0]?.columns).toEqual(['key'])
    const set = log[1]?.set as Record<string, SQL>
    const compiled = (key: string) => dialect.sqlToQuery(set[key] as SQL).sql
    expect(compiled('content')).toBe('"senior_resumes"."staged_content"')
    expect(compiled('layout')).toBe('"senior_resumes"."staged_layout"')
    expect(compiled('templateName')).toBe('"senior_resumes"."staged_template_name"')
    expect(compiled('pdfS3Key')).toBe('"senior_resumes"."staged_pdf_s3_key"')
    expect(compiled('version')).toBe('"senior_resumes"."version" + 1')
    expect(compiled('verifiedVersion')).toBe('"senior_resumes"."version" + 1')
  })

  it('a row gone from the locked read still confirms and deletes nothing', async () => {
    const { svc, s3 } = service([[], [ROW]])
    await expect(svc.confirm(ROW, input, HR1, 'fp', OWNER_REF)).resolves.toBe(ROW)
    expect(s3.delete).not.toHaveBeenCalled()
  })

  it('a CAS miss answers 409 and deletes nothing', async () => {
    const { svc, s3 } = service([[{ key: 'resumes/r-1/live.pdf' }], []])
    await expectCode(svc.confirm(ROW, input, HR1, 'fp', OWNER_REF), 409, 'RESUME_CONFIRM_STALE')
    expect(s3.delete).not.toHaveBeenCalled()
  })

  it('a row with no live PDF deletes nothing after a confirm', async () => {
    const { svc, s3 } = service([[{ key: null }], [ROW]])
    await svc.confirm(ROW, input, HR1, 'fp', OWNER_REF)
    expect(s3.delete).not.toHaveBeenCalled()
  })

  it('refuses before any query when the row is not AWAITING_CONFIRM or names another run', async () => {
    for (const row of [
      { ...ROW, verificationStatus: 'CHECKING' },
      { ...ROW, verificationRunId: 'a15e0000-0000-4000-8000-000000000002' },
    ] as SeniorResume[]) {
      const { svc, log } = service([])
      await expectCode(svc.confirm(row, input, HR1, 'fp', OWNER_REF), 409, 'RESUME_CONFIRM_STALE')
      expect(log).toHaveLength(0)
    }
  })

  it.each([
    ['a changed display name', { ...OWNER_REF, displayName: 'Jane Smith' }],
    ['a changed email', { ...OWNER_REF, email: 'jane@other.spec' }],
  ])('%s since the run is 409 RESUME_CONFIRM_STALE before any query (B10)', async (_l, owner) => {
    const { svc, s3, log } = service([])
    await expectCode(svc.confirm(ROW, input, HR1, 'fp', owner), 409, 'RESUME_CONFIRM_STALE')
    expect(log).toHaveLength(0)
    expect(s3.delete).not.toHaveBeenCalled()
  })

  it.each([
    ['no report', null],
    ['a report from before the owner key', { gates: [], fallbacks: [] }],
    ['a malformed owner key', { gates: [], fallbacks: [], ownerKey: 7 }],
  ])('%s is 409 RESUME_CONFIRM_STALE: the run must be repeated', async (_l, verificationReport) => {
    const { svc, log } = service([])
    const row = { ...ROW, verificationReport } as unknown as SeniorResume
    await expectCode(svc.confirm(row, input, HR1, 'fp', OWNER_REF), 409, 'RESUME_CONFIRM_STALE')
    expect(log).toHaveLength(0)
  })
})

describe('ResumeVerificationService.editStagedField', () => {
  it('stages the edited text, records the editor and starts a staged-edit run', async () => {
    const row = {
      ...ROW,
      stagedEditedPaths: [
        { path: 'summary', userId: HR0 },
        { path: 'experience.0.bullets.1', userId: HR0 },
      ],
    } as unknown as SeniorResume
    const started = { ...row, verificationStatus: 'QUEUED' }
    const { svc, runner, log } = service([OWNER, [], [started]])
    const out = await svc.editStagedField(
      row,
      { runId: RUN, path: 'experience.0.bullets.1', text: 'Moved billing to PostgreSQL 16' },
      HR1,
    )
    expect(out).toBe(started)
    const update = log[2]
    expect(update?.op).toBe('update')
    const set = update?.set as Record<string, unknown>
    expect((set['stagedContent'] as ResumeContent).experience.map((e) => e.bullets)).toEqual([
      ['Led the payments team', 'Moved billing to PostgreSQL 16'],
      ['Built the billing service'],
    ])
    expect((set['stagedContent'] as ResumeContent).summary).toBe('Backend engineer.')
    expect(set['stagedEditedPaths']).toEqual([
      { path: 'summary', userId: HR0 },
      { path: 'experience.0.bullets.1', userId: HR1 },
    ])
    expect(set).toMatchObject({
      verificationStatus: 'QUEUED',
      verificationKind: 'staged-edit',
      verificationTargetPath: 'experience.0.bullets.1',
      verificationStartedAt: null,
      verificationErrorCode: null,
    })
    expect(set['verificationQueuedAt']).toBeInstanceOf(Date)
    const newRun = set['verificationRunId'] as string
    expect(newRun).toMatch(/^[0-9a-f-]{36}$/)
    expect(newRun).not.toBe(RUN)
    // CD-2: an extraction claimed after the read makes the start a miss.
    expect(update?.where?.params).toEqual(['r-1', RUN, 'AWAITING_CONFIRM', 'QUEUED', 'RUNNING'])
    expect(update?.where?.sql).toContain('"status" not in')
    expect(runner.run).toHaveBeenCalledWith('r-1', newRun)
  })

  it('rewrites the named item only, and the run base is the row version', async () => {
    const { svc, log } = service([OWNER, [], [ROW]])
    await svc.editStagedField(
      ROW,
      { runId: RUN, path: 'experience.1.bullets.0', text: 'New.' },
      'h',
    )
    const set = log[2]?.set as Record<string, unknown>
    expect((set['stagedContent'] as ResumeContent).experience.map((e) => e.bullets)).toEqual([
      ['Led the payments team', 'Moved billing to PostgreSQL'],
      ['New.'],
    ])
    expect(dialect.sqlToQuery(set['verificationBaseVersion'] as SQL).sql).toBe(
      '"senior_resumes"."version"',
    )
  })

  it('an owner with no user row adds no contact rule', async () => {
    const { svc, runner } = service([[], [ROW]])
    await svc.editStagedField(ROW, { runId: RUN, path: 'summary', text: 'Ask Jane Doe' }, 'h')
    expect(runner.run).toHaveBeenCalledTimes(1)
  })

  it('an empty text at a path that names no staged text is 400', async () => {
    const { svc, log } = service([])
    await expect(
      svc.editStagedField(ROW, { runId: RUN, path: 'headline', text: '' }, 'h'),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(log).toHaveLength(0)
  })

  it('rewrites the summary only when the path is summary', async () => {
    const { svc, log } = service([OWNER, [], [ROW]])
    await svc.editStagedField(ROW, { runId: RUN, path: 'summary', text: 'New summary.' }, HR1)
    const staged = log[2]?.set?.['stagedContent'] as ResumeContent
    expect(staged.summary).toBe('New summary.')
    expect(staged.experience).toEqual(STAGED.experience)
  })

  it('a bullet at its cap is accepted, one over is 400', async () => {
    const ok = service([OWNER, [], [ROW]])
    const atCap = 'x'.repeat(RESUME_LIMITS.bullet)
    await ok.svc.editStagedField(
      ROW,
      { runId: RUN, path: 'experience.1.bullets.0', text: atCap },
      'h',
    )
    expect(ok.runner.run).toHaveBeenCalledTimes(1)
    const over = service([])
    await expect(
      over.svc.editStagedField(
        ROW,
        { runId: RUN, path: 'experience.1.bullets.0', text: `${atCap}x` },
        'h',
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(over.log).toHaveLength(0)
  })

  it('Cyrillic → 422 NON_LATIN before any query', async () => {
    const { svc, log, runner } = service([])
    await expectCode(
      svc.editStagedField(ROW, { runId: RUN, path: 'summary', text: 'Бекенд' }, 'h'),
      422,
      'RESUME_STAGED_TEXT_INVALID',
      { reason: 'NON_LATIN' },
    )
    expect(log).toHaveLength(0)
    expect(runner.run).not.toHaveBeenCalled()
  })

  it('a contact of the senior → 422 CONTACT_IN_TEXT, the text never echoed, no write', async () => {
    for (const text of ['Mail jane@unit.spec today', 'Ask Jane Doe', 'Mail home@unit.spec']) {
      const { svc, log, runner } = service([OWNER, [{ email: 'home@unit.spec' }]])
      const err = await refusal(
        svc.editStagedField(ROW, { runId: RUN, path: 'summary', text }, 'h'),
      )
      expect(err.getStatus()).toBe(422)
      expect(err.getResponse()).toMatchObject({
        code: 'RESUME_STAGED_TEXT_INVALID',
        params: { reason: 'CONTACT_IN_TEXT' },
      })
      expect(JSON.stringify(err.getResponse())).not.toContain(text)
      expect(log.filter((q) => q.op === 'update')).toHaveLength(0)
      expect(runner.run).not.toHaveBeenCalled()
    }
  })

  it('a stale run id or a row not awaiting confirm → 409 before any query', async () => {
    const { svc, log } = service([])
    const other = 'a15e0000-0000-4000-8000-000000000002'
    await expectCode(
      svc.editStagedField(ROW, { runId: other, path: 'summary', text: 'x' }, 'h'),
      409,
      'RESUME_CONFIRM_STALE',
    )
    await expectCode(
      svc.editStagedField(
        { ...ROW, verificationStatus: 'QUEUED' } as SeniorResume,
        { runId: RUN, path: 'summary', text: 'x' },
        'h',
      ),
      409,
      'RESUME_CONFIRM_STALE',
    )
    expect(log).toHaveLength(0)
  })

  it('an awaiting row whose staged content does not parse → 409 before any query', async () => {
    const { svc, log } = service([])
    const broken = { ...ROW, stagedContent: { summary: 1 } } as unknown as SeniorResume
    await expectCode(
      svc.editStagedField(broken, { runId: RUN, path: 'summary', text: 'x' }, 'h'),
      409,
      'RESUME_CONFIRM_STALE',
    )
    await expectCode(
      svc.regenerateStagedField(broken, { runId: RUN, path: 'summary' }),
      409,
      'RESUME_CONFIRM_STALE',
    )
    expect(log).toHaveLength(0)
  })

  it('a start UPDATE that matches nothing → 409 and no run', async () => {
    const { svc, runner } = service([OWNER, [], []])
    await expectCode(
      svc.editStagedField(ROW, { runId: RUN, path: 'summary', text: 'New.' }, 'h'),
      409,
      'RESUME_CONFIRM_STALE',
    )
    expect(runner.run).not.toHaveBeenCalled()
  })
})

describe('ResumeVerificationService.regenerateStagedField', () => {
  const edited = [
    { path: 'summary', userId: HR0 },
    { path: 'experience.0.bullets.0', userId: HR0 },
    { path: 'experience.0.bullets.1', userId: HR0 },
    { path: 'experience.1.bullets.0', userId: HR0 },
    { path: 'experience.0.bulletsx', userId: HR0 },
  ]
  const row = { ...ROW, stagedEditedPaths: edited } as unknown as SeniorResume

  it('starts an item run and drops every edit under the path', async () => {
    const { svc, runner, log } = service([[row]])
    await svc.regenerateStagedField(row, { runId: RUN, path: 'experience.0.bullets' })
    const set = log[0]?.set as Record<string, unknown>
    expect(set['stagedEditedPaths']).toEqual([
      { path: 'summary', userId: HR0 },
      { path: 'experience.1.bullets.0', userId: HR0 },
      { path: 'experience.0.bulletsx', userId: HR0 },
    ])
    expect(set).toMatchObject({
      verificationKind: 'item',
      verificationTargetPath: 'experience.0.bullets',
    })
    expect(set['stagedContent']).toBeUndefined()
    expect(runner.run).toHaveBeenCalledWith('r-1', set['verificationRunId'])
  })

  it('regenerating the summary drops the summary edit only', async () => {
    const { svc, log } = service([[row]])
    await svc.regenerateStagedField(row, { runId: RUN, path: 'summary' })
    expect(log[0]?.set?.['stagedEditedPaths']).toEqual(edited.slice(1))
  })

  it('a bullet path is not a regenerate path (400, no query)', async () => {
    const { svc, log } = service([])
    await expect(
      svc.regenerateStagedField(row, { runId: RUN, path: 'experience.0.bullets.0' }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(log).toHaveLength(0)
  })
})

describe('leading-zero staged paths (SR-H-1) → 400, no query, no run', () => {
  it('edit refuses experience.01.bullets.0 and experience.0.bullets.00', async () => {
    for (const path of ['experience.01.bullets.0', 'experience.0.bullets.00']) {
      const { svc, log, runner } = service([])
      await expect(
        svc.editStagedField(ROW, { runId: RUN, path, text: 'Led the team' }, 'h'),
      ).rejects.toBeInstanceOf(BadRequestException)
      expect(log).toHaveLength(0)
      expect(runner.run).not.toHaveBeenCalled()
    }
  })

  it('regenerate refuses experience.01.bullets', async () => {
    const { svc, log, runner } = service([])
    await expect(
      svc.regenerateStagedField(ROW, { runId: RUN, path: 'experience.01.bullets' }),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(log).toHaveLength(0)
    expect(runner.run).not.toHaveBeenCalled()
  })
})

describe('an extraction in flight: staged edit, regenerate and confirm are 409 busy (CD-2)', () => {
  it.each(['QUEUED', 'RUNNING'])(
    'extraction %s → 409 RESUME_VERIFICATION_BUSY, no query',
    async (status) => {
      const { svc, log, runner } = service([])
      const row = { ...ROW, status } as unknown as SeniorResume
      await expectCode(
        svc.editStagedField(row, { runId: RUN, path: 'summary', text: 'New.' }, 'h'),
        409,
        'RESUME_VERIFICATION_BUSY',
      )
      await expectCode(
        svc.regenerateStagedField(row, { runId: RUN, path: 'summary' }),
        409,
        'RESUME_VERIFICATION_BUSY',
      )
      await expectCode(
        svc.confirm(row, { runId: RUN, version: 7 }, HR1, 'fp-1', OWNER_REF),
        409,
        'RESUME_VERIFICATION_BUSY',
      )
      expect(log).toHaveLength(0)
      expect(runner.run).not.toHaveBeenCalled()
    },
  )
})
