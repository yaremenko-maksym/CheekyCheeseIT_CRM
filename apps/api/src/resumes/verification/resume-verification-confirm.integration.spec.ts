/**
 * Confirm, staged edit, item regenerate and the staged PDF (Task 15) on a real Postgres, through
 * SeniorResumesService (the RBAC layer) and the real VerificationRunner.
 *
 * Typst, the extractor, S3 and every model are fakes (`src/test/resume-run-fakes.ts`), as in the
 * Task 14 runner spec: this spec is about the state machine and the access rules, not typesetting.
 * Runs go through a tracked runner that can be held, so a test can act while a run is in flight.
 */
import { createHash } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  RESUME_SECTION_ORDER,
  type ResumeFacts,
  type SessionUser,
} from '@crm/shared'
import * as schema from '../../database/schema'
import { seniorResumes, users, type SeniorResume } from '../../database/schema'
import { DatabaseService } from '../../database/database.service'
import { hasDatabaseUrl } from '../../test/require-real-db'
import {
  decodePdf,
  encodePdf,
  encodePng,
  skeletonLines,
  splitPages,
} from '../../test/resume-run-fakes'
import type { ResumeRenderInput } from '../resume-typst.service'
import { SeniorResumesService } from '../resumes.service'
import type { EntailmentClaim, WriterReply, WriterTask } from './inference-clients'
import { ResumeVerificationService } from './resume-verification.service'
import { stagedPdfKey, VerificationRunner } from './verification-runner'

const OWNER_ID = 'a15e0000-0000-4000-8000-0000000000a1'
const FOREIGN_ID = 'a15e0000-0000-4000-8000-0000000000a2'
const HR_ID = 'a15e0000-0000-4000-8000-0000000000a3'
const ADMIN_ID = 'a15e0000-0000-4000-8000-0000000000a4'
const NAME = 'Jane Doe'
const EMAIL = 'jane.doe@confirm.spec'
const OLD_LIVE_KEY = 'resumes/a15e-old-live.pdf'

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
  links: [{ label: 'GitHub', url: 'https://github.com/janedoe-confirm' }],
}
const SUMMARY = 'Backend engineer working with TypeScript and NestJS.'

const session = (id: string, role: SessionUser['role'], email: string) =>
  ({ id, email, role }) as SessionUser
const OWNER = session(OWNER_ID, 'SENIOR', EMAIL)
const FOREIGN = session(FOREIGN_ID, 'SENIOR', 'other.senior@confirm.spec')
const HR = session(HR_ID, 'HR', 'hr@confirm.spec')
const ADMIN = session(ADMIN_ID, 'ADMIN', 'admin@confirm.spec')

// ── Fakes ───────────────────────────────────────────────────────────────────

const typst = {
  fingerprint: (input: ResumeRenderInput) =>
    createHash('sha256').update(JSON.stringify(input)).digest('hex'),
  render: vi.fn(async (input: ResumeRenderInput) => encodePdf(input)),
  renderPng: vi.fn(async (input: ResumeRenderInput) => [encodePng(input)]),
}
const extraction = {
  countRenderedPages: vi.fn(async () => 1),
  extractRenderedPages: vi.fn(async (pdf: Buffer) =>
    splitPages(skeletonLines(decodePdf(pdf), { omitEmail: false }), 1),
  ),
}
const s3 = {
  upload: vi.fn(async (_key: string, _body: Buffer, _mime: string, _category: string) => {}),
  delete: vi.fn(async (_key: string) => {}),
  getObject: vi.fn(async (key: string) => Buffer.from(`bytes of ${key}`)),
}
const writer = {
  write: vi.fn(
    async (task: WriterTask, payload: string, _feedback: string[]): Promise<WriterReply> => {
      if (task === 'summary') return { kind: 'ok', summary: SUMMARY }
      const parsed = JSON.parse(payload) as { experience: { notes: string[] }[] }
      return { kind: 'ok', items: [{ index: 0, bullets: parsed.experience[0]?.notes ?? [] }] }
    },
  ),
}
const entailment = {
  score: vi.fn(
    async (claims: EntailmentClaim[]): Promise<Map<string, number> | 'unavailable'> =>
      new Map(claims.map((c) => [c.id, 0.95])),
  ),
}
const vision = { check: vi.fn(async () => ({ kind: 'ok' as const, findings: [] })) }

/** The 409/422 envelope an apiError carries. */
async function rejectsWith(promise: Promise<unknown>, status: number, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(HttpException)
  expect((err as HttpException).getStatus()).toBe(status)
  expect((err as HttpException).getResponse()).toMatchObject({ code })
  return (err as HttpException).getResponse() as Record<string, unknown>
}

describe.skipIf(!hasDatabaseUrl())('Confirm, staged edit, regenerate — real DB (Task 15)', () => {
  let pool: Pool
  let dbSvc: DatabaseService
  let verification: ResumeVerificationService
  let service: SeniorResumesService
  let resumeId: string
  const pending: Promise<void>[] = []
  /** While set, a started run waits for it before it claims the row. */
  let hold: Promise<void> | null = null

  const rowOf = async (): Promise<SeniorResume> => {
    const [row] = await dbSvc.db.select().from(seniorResumes).where(eq(seniorResumes.id, resumeId))
    return row as SeniorResume
  }
  const setState = (set: Partial<typeof seniorResumes.$inferInsert>) =>
    dbSvc.db.update(seniorResumes).set(set).where(eq(seniorResumes.id, resumeId))
  const drain = async () => {
    await Promise.all(pending.splice(0))
  }
  /** A full run that ended AWAITING_CONFIRM, with a live PDF object from before. */
  const awaiting = async (): Promise<SeniorResume> => {
    await verification.submit(await rowOf(), NAME, OWNER_ID)
    await drain()
    const row = await rowOf()
    expect(row.verificationStatus).toBe('AWAITING_CONFIRM')
    for (const fake of [s3.upload, s3.delete, s3.getObject, writer.write, entailment.score]) {
      fake.mockClear()
    }
    return row
  }
  const confirmInput = (row: SeniorResume) => ({
    runId: row.verificationRunId as string,
    version: row.version,
  })

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, { pool, db })
    const runner = new VerificationRunner(
      dbSvc,
      s3 as never,
      typst as never,
      extraction as never,
      writer as never,
      vision as never,
      entailment as never,
    )
    const tracked = {
      run: (id: string, runId: string) => {
        const p = (async () => {
          if (hold) await hold
          await runner.run(id, runId)
        })()
        pending.push(p)
        return p
      },
    }
    verification = new ResumeVerificationService(dbSvc, s3 as never, tracked as never)
    service = new SeniorResumesService(
      dbSvc,
      s3 as never,
      {} as never,
      {} as never,
      typst as never,
      verification,
    )

    const ids = [OWNER_ID, FOREIGN_ID, HR_ID, ADMIN_ID]
    await db.delete(users).where(inArray(users.id, ids))
    await db.insert(users).values(
      [OWNER, FOREIGN, HR, ADMIN].map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.id === OWNER_ID ? NAME : `Person ${u.role}`,
        googleId: `test-confirm-${u.id}`,
        role: u.role,
      })),
    )
    const [row] = await db
      .insert(seniorResumes)
      .values({ userId: OWNER_ID, templateName: 'classic' })
      .returning({ id: seniorResumes.id })
    resumeId = (row as { id: string }).id
    await db.insert(seniorResumes).values({
      userId: FOREIGN_ID,
      templateName: 'classic',
      stagedPdfS3Key: 'resumes/foreign.pdf',
    })
  }, 30_000)

  beforeEach(async () => {
    hold = null
    await setState({
      facts: FACTS,
      status: 'READY',
      templateSource: null,
      layout: { ...DEFAULT_RESUME_LAYOUT, sectionOrder: [...RESUME_SECTION_ORDER] },
      pdfS3Key: OLD_LIVE_KEY,
      pdfFingerprint: null,
      verificationStatus: 'DRAFT',
      verificationRunId: null,
      verificationKind: null,
      verificationBaseVersion: null,
      verificationErrorCode: null,
      verificationReport: null,
      verifiedVersion: null,
      stagedContent: null,
      stagedLayout: null,
      stagedTemplateName: null,
      stagedPdfS3Key: null,
      stagedEditedPaths: [],
    })
    for (const fake of [typst.render, typst.renderPng, s3.upload, s3.delete, s3.getObject]) {
      fake.mockClear()
    }
    writer.write.mockClear()
    entailment.score.mockClear()
  })

  afterAll(async () => {
    try {
      await drain()
      const ids = [OWNER_ID, FOREIGN_ID, HR_ID, ADMIN_ID]
      await dbSvc.db.delete(seniorResumes).where(inArray(seniorResumes.userId, ids))
      await dbSvc.db.delete(users).where(inArray(users.id, ids))
    } catch {
      // cleanup only: never mask a result
    }
    await pool?.end()
  }, 15_000)

  // ── Confirm ───────────────────────────────────────────────────────────────

  it('1. two concurrent confirms: exactly one 200, one 409, version bumped once', async () => {
    const row = await awaiting()
    const results = await Promise.allSettled([
      service.confirm(HR, OWNER_ID, confirmInput(row)),
      service.confirm(ADMIN, OWNER_ID, confirmInput(row)),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(rejected).toHaveLength(1)
    await rejectsWith(Promise.reject(rejected[0]?.reason), 409, 'RESUME_CONFIRM_STALE')
    const after = await rowOf()
    expect(after.version).toBe(row.version + 1)
    expect(after.verificationStatus).toBe('VERIFIED')
  })

  it('1b. a confirm built from a row read before another confirm misses the CAS (409)', async () => {
    const row = await awaiting()
    await service.confirm(HR, OWNER_ID, confirmInput(row))
    // The stale read still says AWAITING_CONFIRM, so only the UPDATE's WHERE can refuse it.
    await rejectsWith(
      verification.confirm(row, confirmInput(row), HR_ID, 'fp'),
      409,
      'RESUME_CONFIRM_STALE',
    )
    expect((await rowOf()).version).toBe(row.version + 1)
  })

  it('2. confirm after a facts edit → 409, nothing promoted', async () => {
    const row = await awaiting()
    await service.saveFacts(HR, OWNER_ID, { ...FACTS, headline: 'Staff Backend Engineer' })
    await rejectsWith(service.confirm(HR, OWNER_ID, confirmInput(row)), 409, 'RESUME_CONFIRM_STALE')
    // the version moved under the stale row: the CAS refuses it too
    await rejectsWith(
      verification.confirm(row, confirmInput(row), HR_ID, 'fp'),
      409,
      'RESUME_CONFIRM_STALE',
    )
    const after = await rowOf()
    expect(after.verificationStatus).toBe('DRAFT')
    expect(after.verifiedVersion).toBeNull()
    expect(after.pdfS3Key).toBe(OLD_LIVE_KEY)
  })

  it('3. SENIOR cannot confirm their own resume (403), row untouched', async () => {
    const row = await awaiting()
    // The owner has write access and the input is current: only the confirm rule stops this.
    await expect(service.confirm(OWNER, OWNER_ID, confirmInput(row))).rejects.toBeInstanceOf(
      ForbiddenException,
    )
    const after = await rowOf()
    expect(after.verificationStatus).toBe('AWAITING_CONFIRM')
    expect(after.version).toBe(row.version)
    expect(s3.delete).not.toHaveBeenCalled()
  })

  it('4. HR can confirm: staged columns promoted to live and cleared', async () => {
    const row = await awaiting()
    const stagedKey = row.stagedPdfS3Key
    expect(stagedKey).toBe(stagedPdfKey(resumeId, row.verificationRunId as string))
    await service.confirm(HR, OWNER_ID, confirmInput(row))
    const after = await rowOf()
    expect(after.verificationStatus).toBe('VERIFIED')
    expect(after.verifiedByUserId).toBe(HR_ID)
    expect(after.verifiedAt).toBeInstanceOf(Date)
    expect(after.content).toEqual(row.stagedContent)
    expect(after.layout).toEqual(row.stagedLayout)
    expect(after.templateName).toBe(row.stagedTemplateName)
    expect(after.pdfS3Key).toBe(stagedKey)
    expect(after.pdfRenderStatus).toBe('READY')
    expect(after.pdfRenderError).toBeNull()
    expect(after.pdfRenderRunId).toBeNull()
    expect({
      runId: after.verificationRunId,
      kind: after.verificationKind,
      base: after.verificationBaseVersion,
      stagedContent: after.stagedContent,
      stagedLayout: after.stagedLayout,
      stagedTemplateName: after.stagedTemplateName,
      stagedPdfS3Key: after.stagedPdfS3Key,
      stagedEditedPaths: after.stagedEditedPaths,
    }).toEqual({
      runId: null,
      kind: null,
      base: null,
      stagedContent: null,
      stagedLayout: null,
      stagedTemplateName: null,
      stagedPdfS3Key: null,
      stagedEditedPaths: [],
    })
    // P11: the live PDF endpoint serves the checked PDF as is — no re-render is queued.
    const pdf = await service.getRenderedPdf(HR, OWNER_ID)
    expect(pdf.ready).toBe(true)
    expect(s3.getObject).toHaveBeenCalledWith(stagedKey)
  })

  it('4b. a row with a personal template source is not confirmed (409)', async () => {
    const row = await awaiting()
    await setState({ templateSource: '#let x = 1' })
    await rejectsWith(service.confirm(HR, OWNER_ID, confirmInput(row)), 409, 'RESUME_CONFIRM_STALE')
    expect((await rowOf()).verificationStatus).toBe('AWAITING_CONFIRM')
  })

  it('6. confirm during a staged-edit run → 409', async () => {
    const row = await awaiting()
    let release!: () => void
    hold = new Promise((resolve) => (release = resolve))
    await service.editStagedField(HR, OWNER_ID, {
      runId: row.verificationRunId as string,
      path: 'summary',
      text: 'Backend engineer who builds billing systems.',
    })
    const running = await rowOf()
    expect(running.verificationStatus).toBe('QUEUED')
    // the input names the CURRENT run: only the status refuses it
    await rejectsWith(
      service.confirm(HR, OWNER_ID, confirmInput(running)),
      409,
      'RESUME_CONFIRM_STALE',
    )
    release()
    await drain()
    expect((await rowOf()).verificationStatus).toBe('AWAITING_CONFIRM')
  })

  it('9. confirm deletes the old live PDF object, after commit', async () => {
    const row = await awaiting()
    await service.confirm(ADMIN, OWNER_ID, confirmInput(row))
    expect(s3.delete).toHaveBeenCalledTimes(1)
    expect(s3.delete).toHaveBeenCalledWith(OLD_LIVE_KEY)
  })

  it('10. confirm sets verified_version to the new version', async () => {
    const row = await awaiting()
    await service.confirm(ADMIN, OWNER_ID, confirmInput(row))
    const after = await rowOf()
    expect(after.version).toBe(row.version + 1)
    expect(after.verifiedVersion).toBe(row.version + 1)
  })

  // ── Staged edit ───────────────────────────────────────────────────────────

  it('5. a staged-edit run calls neither the writer nor the entailment model', async () => {
    const row = await awaiting()
    await service.editStagedField(HR, OWNER_ID, {
      runId: row.verificationRunId as string,
      path: 'experience.0.bullets.1',
      text: 'Moved billing to PostgreSQL 16',
    })
    await drain()
    const after = await rowOf()
    expect(after.verificationStatus).toBe('AWAITING_CONFIRM')
    expect(after.verificationKind).toBe('staged-edit')
    expect(after.stagedContent?.experience[0]?.bullets).toEqual([
      'Led the payments team',
      'Moved billing to PostgreSQL 16',
    ])
    expect(writer.write).toHaveBeenCalledTimes(0)
    expect(entailment.score).toHaveBeenCalledTimes(0)
  })

  it('7. a staged-edit run stages against the version at its start', async () => {
    const row = await awaiting()
    await service.editStagedField(HR, OWNER_ID, {
      runId: row.verificationRunId as string,
      path: 'summary',
      text: 'Backend engineer who builds billing systems.',
    })
    const started = await rowOf()
    expect(started.verificationBaseVersion).toBe(row.version)
    await drain()
    const after = await rowOf()
    expect(after.verificationStatus).toBe('AWAITING_CONFIRM')
    expect(after.verificationBaseVersion).toBe(row.version)
    expect(after.stagedContent?.summary).toBe('Backend engineer who builds billing systems.')
    // and the staged result it produced is the one a confirm accepts
    await service.confirm(HR, OWNER_ID, confirmInput(after))
    expect((await rowOf()).content.summary).toBe('Backend engineer who builds billing systems.')
  })

  it('7b. a version moved during the staged-edit run → nothing is staged', async () => {
    const row = await awaiting()
    let release!: () => void
    hold = new Promise((resolve) => (release = resolve))
    await service.editStagedField(HR, OWNER_ID, {
      runId: row.verificationRunId as string,
      path: 'summary',
      text: 'Backend engineer who builds billing systems.',
    })
    const runId = (await rowOf()).verificationRunId as string
    await setState({ version: row.version + 1 })
    release()
    await drain()
    const after = await rowOf()
    expect(after.verificationStatus).not.toBe('AWAITING_CONFIRM')
    expect(after.stagedPdfS3Key).not.toBe(stagedPdfKey(resumeId, runId))
  })

  it('11. a staged edit holding an email → 422 CONTACT_IN_TEXT, no run, text not echoed', async () => {
    const row = await awaiting()
    const body = await rejectsWith(
      service.editStagedField(HR, OWNER_ID, {
        runId: row.verificationRunId as string,
        path: 'summary',
        text: `Write to ${EMAIL} for details.`,
      }),
      422,
      'RESUME_STAGED_TEXT_INVALID',
    )
    expect(body['params']).toEqual({ reason: 'CONTACT_IN_TEXT' })
    expect(JSON.stringify(body)).not.toContain(EMAIL)
    const after = await rowOf()
    expect(after.verificationStatus).toBe('AWAITING_CONFIRM')
    expect(after.verificationRunId).toBe(row.verificationRunId)
    expect(after.stagedContent).toEqual(row.stagedContent)
    expect(pending).toHaveLength(0)
  })

  it('11b. a staged edit in Cyrillic → 422 NON_LATIN, no run', async () => {
    const row = await awaiting()
    const body = await rejectsWith(
      service.editStagedField(HR, OWNER_ID, {
        runId: row.verificationRunId as string,
        path: 'summary',
        text: 'Бекенд інженер',
      }),
      422,
      'RESUME_STAGED_TEXT_INVALID',
    )
    expect(body['params']).toEqual({ reason: 'NON_LATIN' })
    expect(pending).toHaveLength(0)
  })

  it('11c. a path out of bounds or a bullet over its cap → 400, no run', async () => {
    const row = await awaiting()
    const runId = row.verificationRunId as string
    for (const input of [
      { runId, path: 'experience.1.bullets.0', text: 'Built it' },
      { runId, path: 'experience.0.bullets.2', text: 'Built it' },
      { runId, path: 'headline', text: 'Built it' },
      { runId, path: 'experience.00.bullets.0', text: 'Built it' },
      { runId, path: 'experience.0.bullets.00', text: 'Built it' },
      { runId, path: 'experience.0.bullets.0', text: 'x'.repeat(501) },
    ]) {
      await expect(service.editStagedField(HR, OWNER_ID, input)).rejects.toBeInstanceOf(
        BadRequestException,
      )
    }
    expect(pending).toHaveLength(0)
    // a summary over the bullet cap is accepted: the run starts with the text staged
    let release!: () => void
    hold = new Promise((resolve) => (release = resolve))
    await service.editStagedField(HR, OWNER_ID, {
      runId,
      path: 'summary',
      text: 'a'.repeat(1200),
    })
    const started = await rowOf()
    expect(started.verificationStatus).toBe('QUEUED')
    expect(started.stagedContent?.summary).toBe('a'.repeat(1200))
    release()
    await drain()
  })

  it('12. a staged edit records { path, userId } in staged_edited_paths', async () => {
    const row = await awaiting()
    await service.editStagedField(HR, OWNER_ID, {
      runId: row.verificationRunId as string,
      path: 'experience.0.bullets.0',
      text: 'Led the payments team of five',
    })
    await drain()
    const next = await rowOf()
    expect(next.stagedEditedPaths).toEqual([{ path: 'experience.0.bullets.0', userId: HR_ID }])
    // the same path edited again by someone else: one entry, the latest editor
    await service.editStagedField(ADMIN, OWNER_ID, {
      runId: next.verificationRunId as string,
      path: 'experience.0.bullets.0',
      text: 'Led the payments team of six',
    })
    await drain()
    expect((await rowOf()).stagedEditedPaths).toEqual([
      { path: 'experience.0.bullets.0', userId: ADMIN_ID },
    ])
  })

  it('13. a staged-edit run replaces the previous staged object and deletes it', async () => {
    const row = await awaiting()
    const previous = row.stagedPdfS3Key as string
    await service.editStagedField(HR, OWNER_ID, {
      runId: row.verificationRunId as string,
      path: 'summary',
      text: 'Backend engineer who builds billing systems.',
    })
    const runId = (await rowOf()).verificationRunId as string
    await drain()
    const after = await rowOf()
    expect(after.stagedPdfS3Key).toBe(stagedPdfKey(resumeId, runId))
    expect(after.stagedPdfS3Key).not.toBe(previous)
    expect(s3.upload).toHaveBeenCalledWith(
      stagedPdfKey(resumeId, runId),
      expect.any(Buffer),
      'application/pdf',
      expect.any(String),
    )
    expect(s3.delete).toHaveBeenCalledWith(previous)
  })

  it('a staged edit with a run id that is not the current one → 409', async () => {
    await awaiting()
    await rejectsWith(
      service.editStagedField(HR, OWNER_ID, {
        runId: 'a15e0000-0000-4000-8000-0000000000ff',
        path: 'summary',
        text: 'Backend engineer.',
      }),
      409,
      'RESUME_CONFIRM_STALE',
    )
    expect(pending).toHaveLength(0)
  })

  // ── Regenerate ────────────────────────────────────────────────────────────

  it('regenerate bullets: an item run writes that item only, and drops edits under it', async () => {
    let row = await awaiting()
    await service.editStagedField(HR, OWNER_ID, {
      runId: row.verificationRunId as string,
      path: 'summary',
      text: 'Backend engineer who builds billing systems.',
    })
    await drain()
    row = await rowOf()
    await service.editStagedField(HR, OWNER_ID, {
      runId: row.verificationRunId as string,
      path: 'experience.0.bullets.0',
      text: 'Led the payments team of five',
    })
    await drain()
    row = await rowOf()
    writer.write.mockClear()
    await service.regenerateStagedField(HR, OWNER_ID, {
      runId: row.verificationRunId as string,
      path: 'experience.0.bullets',
    })
    expect((await rowOf()).stagedEditedPaths).toEqual([{ path: 'summary', userId: HR_ID }])
    await drain()
    const after = await rowOf()
    expect(after.verificationStatus).toBe('AWAITING_CONFIRM')
    expect(after.verificationKind).toBe('item')
    expect(writer.write.mock.calls.map((c) => c[0])).toEqual(['bullets'])
    expect(after.stagedContent?.experience[0]?.bullets).toEqual([
      'Led the payments team',
      'Moved billing to PostgreSQL',
    ])
    // the hand-written summary is kept
    expect(after.stagedContent?.summary).toBe('Backend engineer who builds billing systems.')
    expect(after.stagedEditedPaths).toEqual([{ path: 'summary', userId: HR_ID }])
  })

  it('regenerate summary: the writer writes the summary; a bullet path is not a regenerate path', async () => {
    const row = await awaiting()
    const runId = row.verificationRunId as string
    for (const path of [
      'experience.0.bullets.0',
      'experience.1.bullets',
      'experience.00.bullets',
      'headline',
    ]) {
      await expect(
        service.regenerateStagedField(HR, OWNER_ID, { runId, path }),
      ).rejects.toBeInstanceOf(BadRequestException)
    }
    await service.regenerateStagedField(HR, OWNER_ID, { runId, path: 'summary' })
    await drain()
    const after = await rowOf()
    expect(after.verificationStatus).toBe('AWAITING_CONFIRM')
    expect(writer.write.mock.calls.map((c) => c[0])).toEqual(['summary'])
    expect(after.stagedContent?.summary).toBe(SUMMARY)
  })

  // ── Staged PDF ────────────────────────────────────────────────────────────

  it('14. staged-pdf: the owner gets the file; a foreign SENIOR and no staged PDF get 404', async () => {
    const row = await awaiting()
    const key = row.stagedPdfS3Key as string
    const own = await service.getStagedPdf(OWNER, OWNER_ID)
    expect(own.pdfBuffer.toString()).toBe(`bytes of ${key}`)
    expect(own.displayName).toBe(NAME)
    s3.getObject.mockClear()

    // the foreign senior's own row HAS a staged PDF: only the access rule stops this read
    await expect(service.getStagedPdf(OWNER, FOREIGN_ID)).rejects.toBeInstanceOf(NotFoundException)
    await expect(service.getStagedPdf(FOREIGN, OWNER_ID)).rejects.toBeInstanceOf(NotFoundException)
    expect(s3.getObject).not.toHaveBeenCalled()

    await service.confirm(HR, OWNER_ID, confirmInput(row))
    await expect(service.getStagedPdf(OWNER, OWNER_ID)).rejects.toBeInstanceOf(NotFoundException)
    expect(s3.getObject).not.toHaveBeenCalled()
  })
})
