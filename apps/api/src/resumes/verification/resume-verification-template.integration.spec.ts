/**
 * Template runs on a VERIFIED resume and the stalled-run sweep (Task 16) on a real Postgres, through
 * SeniorResumesService (the RBAC layer) and the real VerificationRunner.
 *
 * Typst, the extractor, S3 and every model are fakes (`src/test/resume-run-fakes.ts`), as in the
 * Task 14/15 specs. The fake S3 keeps a set of the keys it holds, so "the promoted object exists"
 * and "the replaced object is gone" are facts about the store, not about calls.
 */
import { createHash } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { HttpException, NotFoundException } from '@nestjs/common'
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
import type { VisualReply, WriterReply, WriterTask } from './inference-clients'
import { ResumeVerificationService } from './resume-verification.service'
import { stagedPdfKey, VERIFICATION_DEADLINE_MS, VerificationRunner } from './verification-runner'

const OWNER_ID = 'a16e0000-0000-4000-8000-0000000000a1'
const HR_ID = 'a16e0000-0000-4000-8000-0000000000a3'
const NAME = 'Jane Doe'
const EMAIL = 'jane.doe@template.spec'
const OLD_LIVE_KEY = 'resumes/a16e-old-live.pdf'

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
  links: [{ label: 'GitHub', url: 'https://github.com/janedoe-template' }],
}
const SUMMARY = 'Backend engineer working with TypeScript and NestJS.'

const session = (id: string, role: SessionUser['role'], email: string) =>
  ({ id, email, role }) as SessionUser
const OWNER = session(OWNER_ID, 'SENIOR', EMAIL)
const HR = session(HR_ID, 'HR', 'hr@template.spec')

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
/** The keys the fake store holds. */
const stored = new Set<string>()
const s3 = {
  upload: vi.fn(async (key: string, _body: Buffer, _mime: string, _category: string) => {
    stored.add(key)
  }),
  delete: vi.fn(async (key: string) => {
    stored.delete(key)
  }),
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
  score: vi.fn(async (claims: { id: string }[]) => new Map(claims.map((c) => [c.id, 0.95]))),
}
let visionReplies: VisualReply[] = []
const vision = {
  check: vi.fn(
    async (): Promise<VisualReply> => visionReplies.shift() ?? { kind: 'ok', findings: [] },
  ),
}

async function rejectsWith(promise: Promise<unknown>, status: number, code: string) {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(HttpException)
  expect((err as HttpException).getStatus()).toBe(status)
  expect((err as HttpException).getResponse()).toMatchObject({ code })
}

describe.skipIf(!hasDatabaseUrl())(
  'Template runs and the stalled sweep — real DB (Task 16)',
  () => {
    let pool: Pool
    let dbSvc: DatabaseService
    let verification: ResumeVerificationService
    let service: SeniorResumesService
    let resumeId: string
    const pending: Promise<void>[] = []
    /** While set, a started run waits for it before it claims the row. */
    let hold: Promise<void> | null = null

    const rowOf = async (): Promise<SeniorResume> => {
      const [row] = await dbSvc.db
        .select()
        .from(seniorResumes)
        .where(eq(seniorResumes.id, resumeId))
      return row as SeniorResume
    }
    const setState = (set: Partial<typeof seniorResumes.$inferInsert>) =>
      dbSvc.db.update(seniorResumes).set(set).where(eq(seniorResumes.id, resumeId))
    const drain = async () => {
      await Promise.all(pending.splice(0))
    }
    const holdRuns = () => {
      let release!: () => void
      hold = new Promise((resolve) => (release = resolve))
      return release
    }
    const clearFakes = () => {
      for (const fake of [typst.render, typst.renderPng, s3.upload, s3.delete, s3.getObject]) {
        fake.mockClear()
      }
      for (const fake of [writer.write, entailment.score, vision.check]) fake.mockClear()
    }
    /** A full run, confirmed by HR: VERIFIED with its live PDF in the store. */
    const verified = async (): Promise<SeniorResume> => {
      await verification.submit(await rowOf(), NAME, OWNER_ID)
      await drain()
      const awaiting = await rowOf()
      await service.confirm(HR, OWNER_ID, {
        runId: awaiting.verificationRunId as string,
        version: awaiting.version,
      })
      const row = await rowOf()
      expect(row.verificationStatus).toBe('VERIFIED')
      expect(stored.has(row.pdfS3Key as string)).toBe(true)
      clearFakes()
      return row
    }
    /** `queued_at` this far from `now`: + is older than the deadline, − is younger. */
    const queuedPast = (now: Date, overDeadlineMs: number) =>
      new Date(now.getTime() - VERIFICATION_DEADLINE_MS - overDeadlineMs)

    beforeAll(async () => {
      pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
      const db = drizzle(pool, { schema })
      dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, {
        pool,
        db,
      })
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

      const ids = [OWNER_ID, HR_ID]
      await db.delete(users).where(inArray(users.id, ids))
      await db.insert(users).values([
        {
          id: OWNER_ID,
          email: EMAIL,
          displayName: NAME,
          googleId: `test-t16-${OWNER_ID}`,
          role: 'SENIOR',
        },
        {
          id: HR_ID,
          email: HR.email,
          displayName: 'Person HR',
          googleId: `test-t16-${HR_ID}`,
          role: 'HR',
        },
      ])
      const [row] = await db
        .insert(seniorResumes)
        .values({ userId: OWNER_ID, templateName: 'classic' })
        .returning({ id: seniorResumes.id })
      resumeId = (row as { id: string }).id
    }, 30_000)

    beforeEach(async () => {
      hold = null
      visionReplies = []
      stored.clear()
      stored.add(OLD_LIVE_KEY)
      await setState({
        facts: FACTS,
        status: 'READY',
        templateName: 'classic',
        templateSource: null,
        layout: { ...DEFAULT_RESUME_LAYOUT, sectionOrder: [...RESUME_SECTION_ORDER] },
        pdfS3Key: OLD_LIVE_KEY,
        pdfFingerprint: null,
        verificationStatus: 'DRAFT',
        verificationRunId: null,
        verificationKind: null,
        verificationTargetPath: null,
        verificationBaseVersion: null,
        verificationQueuedAt: null,
        verificationStartedAt: null,
        verificationErrorCode: null,
        verificationReport: null,
        verifiedVersion: null,
        stagedContent: null,
        stagedLayout: null,
        stagedTemplateName: null,
        stagedPdfS3Key: null,
        stagedEditedPaths: [],
      })
      clearFakes()
    })

    afterAll(async () => {
      try {
        await drain()
        const ids = [OWNER_ID, HR_ID]
        await dbSvc.db.delete(seniorResumes).where(inArray(seniorResumes.userId, ids))
        await dbSvc.db.delete(users).where(inArray(users.id, ids))
      } catch {
        // cleanup only: never mask a result
      }
      await pool?.end()
    }, 15_000)

    // ── Template runs ─────────────────────────────────────────────────────────

    it('1. template change on VERIFIED passes → VERIFIED with new template and verified_version == version', async () => {
      const before = await verified()
      await service.setTemplate(OWNER, OWNER_ID, 'modern')
      await drain()
      const after = await rowOf()
      expect(after.verificationStatus).toBe('VERIFIED')
      expect(after.templateName).toBe('modern')
      expect(after.content).toEqual(before.content)
      expect(after.version).toBe(before.version + 1)
      expect(after.verifiedVersion).toBe(after.version)
      expect(after.verifiedByUserId).toBe(HR_ID)
      expect(after.verificationErrorCode).toBeNull()
      expect([
        after.verificationRunId,
        after.verificationKind,
        after.verificationBaseVersion,
      ]).toEqual([null, null, null])
      expect([after.stagedContent, after.stagedLayout, after.stagedTemplateName]).toEqual([
        null,
        null,
        null,
      ])
      expect(writer.write).not.toHaveBeenCalled()
      expect(entailment.score).not.toHaveBeenCalled()
      // P11: the live PDF endpoint serves the checked PDF as is — no re-render is queued.
      const pdf = await service.getRenderedPdf(OWNER, OWNER_ID)
      expect(pdf.ready).toBe(true)
      expect(s3.getObject).toHaveBeenCalledWith(after.pdfS3Key)
      expect((await rowOf()).pdfRenderStatus).toBe('READY')
    })

    it('1b. a layout change on VERIFIED promotes the new layout the same way', async () => {
      const before = await verified()
      const relaxed = { ...(before.layout as object), density: 'relaxed' } as never
      await service.updateLayout(OWNER, OWNER_ID, relaxed)
      await drain()
      const after = await rowOf()
      expect(after.verificationStatus).toBe('VERIFIED')
      expect(after.layout).toMatchObject({ density: 'relaxed' })
      expect(after.templateName).toBe(before.templateName)
      expect(after.verifiedVersion).toBe(before.version + 1)
    })

    it('2. template change fails (vision unavailable) → previous template and PDF kept, VERIFIED', async () => {
      const before = await verified()
      visionReplies = [{ kind: 'unavailable', reason: 'TIMEOUT' } as VisualReply]
      await service.setTemplate(OWNER, OWNER_ID, 'modern')
      await drain()
      const after = await rowOf()
      expect(after.verificationStatus).toBe('VERIFIED')
      expect(after.templateName).toBe(before.templateName)
      expect(after.layout).toEqual(before.layout)
      expect(after.pdfS3Key).toBe(before.pdfS3Key)
      expect(after.pdfFingerprint).toBe(before.pdfFingerprint)
      expect(after.version).toBe(before.version)
      expect(after.verifiedVersion).toBe(before.verifiedVersion)
      expect(after.verificationErrorCode).toBe('VISUAL_CHECK_UNAVAILABLE')
      expect(after.verificationReport?.gates.at(-1)).toEqual({
        gate: 'visual',
        ok: false,
        items: [],
      })
      expect(after.verificationRunId).toBeNull()
      expect(after.stagedTemplateName).toBeNull()
      expect(s3.upload).not.toHaveBeenCalled()
      expect(stored.has(before.pdfS3Key as string)).toBe(true)
    })

    it('5. template pass promotes an object that exists in the fake S3', async () => {
      await verified()
      await service.setTemplate(OWNER, OWNER_ID, 'compact')
      await drain()
      const after = await rowOf()
      expect(after.pdfS3Key).toMatch(/^resumes\/.+\/staged\/.+\.pdf$/u)
      expect(stored.has(after.pdfS3Key as string)).toBe(true)
    })

    it('9. template pass deletes the replaced live PDF object', async () => {
      const before = await verified()
      await service.setTemplate(OWNER, OWNER_ID, 'modern')
      await drain()
      expect(s3.delete.mock.calls).toEqual([[before.pdfS3Key]])
      expect(stored.has(before.pdfS3Key as string)).toBe(false)
    })

    it('10. template run that lost the CAS writes nothing and deletes its object', async () => {
      const before = await verified()
      const release = holdRuns()
      await service.setTemplate(OWNER, OWNER_ID, 'modern')
      const started = await rowOf()
      // a write the busy guard cannot see moves the version under the run
      await setState({ version: started.version + 1 })
      release()
      await drain()
      const after = await rowOf()
      const key = stagedPdfKey(resumeId, started.verificationRunId as string)
      expect(s3.upload.mock.calls.map((c) => c[0])).toEqual([key])
      expect(s3.delete.mock.calls).toEqual([[key]])
      expect(stored.has(key)).toBe(false)
      expect(after.templateName).toBe(before.templateName)
      expect(after.pdfS3Key).toBe(before.pdfS3Key)
      expect(after.verifiedVersion).toBe(before.verifiedVersion)
      expect(after.verificationRunId).toBe(started.verificationRunId)
    })

    it('8. facts PUT during a template run → 409', async () => {
      await verified()
      const release = holdRuns()
      await service.setTemplate(OWNER, OWNER_ID, 'modern')
      expect((await rowOf()).verificationRunId).not.toBeNull()
      await rejectsWith(
        service.saveFacts(OWNER, OWNER_ID, { ...FACTS, headline: 'Staff Engineer' }),
        409,
        'RESUME_VERIFICATION_BUSY',
      )
      expect((await rowOf()).facts).toEqual(FACTS)
      release()
      await drain()
    })

    it('a template start stages both look columns and clears the last check error and report', async () => {
      const before = await verified()
      await setState({
        verificationErrorCode: 'VISUAL_CHECK_UNAVAILABLE',
        verificationReport: { gates: [], fallbacks: [] },
      })
      const release = holdRuns()
      await service.setTemplate(OWNER, OWNER_ID, 'technical')
      const started = await rowOf()
      expect(started.verificationStatus).toBe('VERIFIED')
      expect(started.verificationKind).toBe('template')
      expect(started.stagedTemplateName).toBe('technical')
      expect(started.stagedLayout).toEqual(before.layout)
      expect(started.stagedContent).toEqual(before.content)
      expect(started.stagedPdfS3Key).toBeNull()
      expect(started.verificationErrorCode).toBeNull()
      expect(started.verificationReport).toBeNull()
      expect(started.templateName).toBe(before.templateName)
      release()
      await drain()
    })

    // ── The sweep ─────────────────────────────────────────────────────────────

    it('3. sweep fails a CHECKING run past the deadline and deletes its object', async () => {
      const now = new Date()
      const run = 'a16e0000-0000-4000-8000-00000000c001'
      const staged = 'resumes/a16e-staged-item.pdf'
      stored.add(staged)
      // an item run re-checks a staged result: its staged object is still on the row
      await setState({
        verificationStatus: 'CHECKING',
        verificationRunId: run,
        verificationKind: 'item',
        verificationTargetPath: 'summary',
        verificationBaseVersion: 1,
        verificationQueuedAt: queuedPast(now, 1_000),
        stagedPdfS3Key: staged,
        stagedTemplateName: 'classic',
      })
      expect(await verification.sweepStalledVerifications(now)).toBe(1)
      const after = await rowOf()
      expect(after.verificationStatus).toBe('FAILED')
      expect(after.verificationErrorCode).toBe('STALLED')
      expect([after.verificationRunId, after.verificationKind, after.stagedPdfS3Key]).toEqual([
        null,
        null,
        null,
      ])
      expect(s3.delete.mock.calls).toEqual([[staged], [stagedPdfKey(resumeId, run)]])
      expect(stored.has(staged)).toBe(false)
    })

    it('6. sweep ignores a run just under the deadline and reaps one just past it', async () => {
      const now = new Date()
      await setState({
        verificationStatus: 'QUEUED',
        verificationRunId: 'a16e0000-0000-4000-8000-00000000c006',
        verificationKind: 'full',
        verificationQueuedAt: queuedPast(now, -1_000),
      })
      expect(await verification.sweepStalledVerifications(now)).toBe(0)
      expect((await rowOf()).verificationStatus).toBe('QUEUED')
      expect(s3.delete).not.toHaveBeenCalled()
      await setState({ verificationQueuedAt: queuedPast(now, 1_000) })
      expect(await verification.sweepStalledVerifications(now)).toBe(1)
      expect((await rowOf()).verificationStatus).toBe('FAILED')
    })

    it('4. sweep does not touch a run that reached AWAITING_CONFIRM after the sweep read it', async () => {
      const now = new Date()
      const run = 'a16e0000-0000-4000-8000-00000000c004'
      await setState({
        verificationStatus: 'CHECKING',
        verificationRunId: run,
        verificationKind: 'full',
        verificationQueuedAt: queuedPast(now, 1_000),
      })
      const realTx = dbSvc.db.transaction.bind(dbSvc.db)
      // the run lands its stage 9 between the sweep's read and its compare-and-set
      const tx = vi.spyOn(dbSvc.db, 'transaction').mockImplementationOnce(async (fn) => {
        await setState({
          verificationStatus: 'AWAITING_CONFIRM',
          stagedPdfS3Key: stagedPdfKey(resumeId, run),
        })
        return realTx(fn)
      })
      try {
        expect(await verification.sweepStalledVerifications(now)).toBe(0)
      } finally {
        tx.mockRestore()
      }
      const after = await rowOf()
      expect(after.verificationStatus).toBe('AWAITING_CONFIRM')
      expect(after.verificationRunId).toBe(run)
      expect(after.stagedPdfS3Key).toBe(stagedPdfKey(resumeId, run))
      expect(s3.delete).not.toHaveBeenCalled()
    })

    it('7. sweep clears a stalled template run and keeps VERIFIED', async () => {
      const before = await verified()
      const release = holdRuns()
      await service.setTemplate(OWNER, OWNER_ID, 'modern')
      const started = await rowOf()
      const now = new Date()
      await setState({ verificationQueuedAt: queuedPast(now, 1_000) })
      expect(await verification.sweepStalledVerifications(now)).toBe(1)
      const after = await rowOf()
      expect(after.verificationStatus).toBe('VERIFIED')
      expect(after.verificationErrorCode).toBe('STALLED')
      expect([after.verificationRunId, after.stagedTemplateName, after.stagedLayout]).toEqual([
        null,
        null,
        null,
      ])
      expect(after.templateName).toBe(before.templateName)
      expect(after.pdfS3Key).toBe(before.pdfS3Key)
      expect(after.verifiedVersion).toBe(before.verifiedVersion)
      // only the derived key of the dead run: the live PDF stays
      expect(s3.delete.mock.calls).toEqual([
        [stagedPdfKey(resumeId, started.verificationRunId as string)],
      ])
      // the held run wakes to a row it no longer owns, and writes nothing
      release()
      await drain()
      expect((await rowOf()).templateName).toBe(before.templateName)
      expect(s3.upload).not.toHaveBeenCalled()
    })

    it('P3. stalled staged-edit swept → FAILED, staged columns cleared, staged-pdf 404', async () => {
      await verification.submit(await rowOf(), NAME, OWNER_ID)
      await drain()
      const awaiting = await rowOf()
      const stagedKey = awaiting.stagedPdfS3Key as string
      expect(stored.has(stagedKey)).toBe(true)
      clearFakes()
      const release = holdRuns()
      await service.editStagedField(HR, OWNER_ID, {
        runId: awaiting.verificationRunId as string,
        path: 'summary',
        text: 'Backend engineer who builds billing systems.',
      })
      const running = await rowOf()
      expect([running.verificationStatus, running.verificationKind]).toEqual([
        'QUEUED',
        'staged-edit',
      ])
      const now = new Date()
      await setState({ verificationQueuedAt: queuedPast(now, 1_000) })
      expect(await verification.sweepStalledVerifications(now)).toBe(1)
      const after = await rowOf()
      expect(after.verificationStatus).toBe('FAILED')
      expect(after.verificationErrorCode).toBe('STALLED')
      expect({
        content: after.stagedContent,
        layout: after.stagedLayout,
        template: after.stagedTemplateName,
        key: after.stagedPdfS3Key,
        edited: after.stagedEditedPaths,
      }).toEqual({ content: null, layout: null, template: null, key: null, edited: [] })
      expect(stored.has(stagedKey)).toBe(false)
      await expect(service.getStagedPdf(OWNER, OWNER_ID)).rejects.toBeInstanceOf(NotFoundException)
      release()
      await drain()
      expect((await rowOf()).verificationStatus).toBe('FAILED')
    })
  },
)
