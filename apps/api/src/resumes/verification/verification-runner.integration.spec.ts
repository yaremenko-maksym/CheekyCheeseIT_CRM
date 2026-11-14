/**
 * The verification run (Task 14) on a real Postgres: submit queues it, the runner claims it and ends
 * AWAITING_CONFIRM or FAILED through compare-and-set writes.
 *
 * Typst, the extractor, S3 and every model are fakes (`src/test/resume-run-fakes.ts`): the CI
 * integration job has no Typst binary, and this spec is about the run's gates and state, not the
 * typesetter. The fake render encodes its input (and a test-controlled page count) in the buffer.
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { HttpException } from '@nestjs/common'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  RESUME_SECTION_ORDER,
  type ResumeFacts,
  type ResumeLayoutOptions,
} from '@crm/shared'
import * as schema from '../../database/schema'
import { seniorResumes, userEmails, users, type SeniorResume } from '../../database/schema'
import { DatabaseService } from '../../database/database.service'
import { hasDatabaseUrl } from '../../test/require-real-db'
import {
  decodePdf,
  decodePng,
  encodePdf,
  encodePng,
  skeletonLines,
  splitPages,
} from '../../test/resume-run-fakes'
import type { ResumeRenderInput } from '../resume-typst.service'
import type { EntailmentClaim, VisualReply, WriterReply, WriterTask } from './inference-clients'
import { ResumeVerificationService } from './resume-verification.service'
import { stagedPdfKey, VerificationRunner } from './verification-runner'

const USER_ID = 'a14e0000-0000-4000-8000-0000000000a1'
const OTHER_RUN_ID = 'a14e0000-0000-4000-8000-0000000000ff'
const NAME = 'Jane Doe'
const EMAIL = 'jane.doe@runner.spec'
const PERSONAL_EMAIL = 'jane.home@runner.spec'
const LINK_URL = 'https://github.com/janedoe-runner'

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
    {
      company: 'Globex',
      role: 'Engineer',
      location: null,
      start: '2018-01',
      end: '2021-02',
      current: false,
      technologies: ['Docker'],
      notes: ['Built the billing service'],
    },
  ],
  education: [
    { institution: 'Stanford University', degree: 'BSc Physics', startYear: 2010, endYear: 2014 },
  ],
  languages: [{ name: 'English', level: 'C1' }],
  links: [{ label: 'GitHub', url: LINK_URL }],
}
const SUMMARY = 'Backend engineer working with TypeScript and NestJS.'

// ── Fakes ───────────────────────────────────────────────────────────────────

/** Test-controlled render state. */
const world = {
  pagesFor: (_layout: ResumeLayoutOptions) => 1,
  omitEmail: false,
}

const typst = {
  render: vi.fn(async (input: ResumeRenderInput) => encodePdf(input)),
  renderPng: vi.fn(async (input: ResumeRenderInput) => [encodePng(input)]),
}
const extraction = {
  countRenderedPages: vi.fn(async (pdf: Buffer) => world.pagesFor(decodePdf(pdf).layout)),
  extractRenderedPages: vi.fn(async (pdf: Buffer) => {
    const input = decodePdf(pdf)
    const lines = skeletonLines(input, { omitEmail: world.omitEmail })
    return splitPages(lines, world.pagesFor(input.layout))
  }),
}
const s3 = {
  upload: vi.fn(async (_key: string, _body: Buffer, _mime: string, _category: string) => {}),
  delete: vi.fn(async (_key: string) => {}),
}

type WriteCall = { task: WriterTask; payload: string; feedback: string[] }
const writeCalls: WriteCall[] = []
/** Default writer: the summary above; each item's bullets echo its notes (always grounded). */
let writerReply: (call: WriteCall) => WriterReply | Promise<WriterReply>
function echoNotes(call: WriteCall): WriterReply {
  if (call.task === 'summary') return { kind: 'ok', summary: SUMMARY }
  const payload = JSON.parse(call.payload) as { experience: { notes: string[] }[] }
  return { kind: 'ok', items: [{ index: 0, bullets: payload.experience[0]?.notes ?? [] }] }
}
const writer = {
  write: vi.fn(async (task: WriterTask, payload: string, feedback: string[]) => {
    const call = { task, payload, feedback }
    writeCalls.push(call)
    return writerReply(call)
  }),
}
const entailment = {
  score: vi.fn(
    async (claims: EntailmentClaim[]): Promise<Map<string, number> | 'unavailable'> =>
      new Map(claims.map((c) => [c.id, 0.95])),
  ),
}
let visionReplies: VisualReply[]
const vision = {
  check: vi.fn(
    async (_pages: Buffer[]): Promise<VisualReply> =>
      visionReplies.shift() ?? { kind: 'ok', findings: [] },
  ),
}

describe.skipIf(!hasDatabaseUrl())('Verification run — real DB (Task 14)', () => {
  let pool: Pool
  let dbSvc: DatabaseService
  let runner: VerificationRunner
  let service: ResumeVerificationService
  let resumeId: string
  const pending: Promise<void>[] = []

  const rowOf = async (): Promise<SeniorResume> => {
    const [row] = await dbSvc.db.select().from(seniorResumes).where(eq(seniorResumes.id, resumeId))
    return row as SeniorResume
  }
  const setState = (set: Partial<typeof seniorResumes.$inferInsert>) =>
    dbSvc.db.update(seniorResumes).set(set).where(eq(seniorResumes.id, resumeId))
  /** Submit, then wait for the run it started. */
  const submitAndRun = async () => {
    await service.submit(await rowOf(), NAME, USER_ID)
    await Promise.all(pending.splice(0))
    return rowOf()
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, { pool, db })
    runner = new VerificationRunner(
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
        const p = runner.run(id, runId)
        pending.push(p)
        return p
      },
    }
    service = new ResumeVerificationService(dbSvc, s3 as never, tracked as never)

    await db.delete(users).where(eq(users.id, USER_ID))
    await db.insert(users).values({
      id: USER_ID,
      email: EMAIL,
      displayName: NAME,
      legalFullName: 'Jane Quinn Doe',
      googleId: `test-runner-${USER_ID}`,
      role: 'SENIOR',
    })
    await db.insert(userEmails).values({ userId: USER_ID, email: PERSONAL_EMAIL, kind: 'PERSONAL' })
    const [row] = await db
      .insert(seniorResumes)
      .values({ userId: USER_ID, templateName: 'classic' })
      .returning({ id: seniorResumes.id })
    resumeId = (row as { id: string }).id
  }, 30_000)

  beforeEach(async () => {
    await setState({
      facts: FACTS,
      status: 'READY',
      templateSource: null,
      layout: { ...DEFAULT_RESUME_LAYOUT, sectionOrder: [...RESUME_SECTION_ORDER] },
      verificationStatus: 'DRAFT',
      verificationRunId: null,
      verificationKind: null,
      verificationBaseVersion: null,
      verificationErrorCode: null,
      verificationReport: null,
      stagedContent: null,
      stagedLayout: null,
      stagedTemplateName: null,
      stagedPdfS3Key: null,
      stagedEditedPaths: [],
    })
    world.pagesFor = () => 1
    world.omitEmail = false
    writerReply = echoNotes
    visionReplies = []
    writeCalls.length = 0
    for (const fake of [typst.render, typst.renderPng, s3.upload, s3.delete, writer.write]) {
      fake.mockClear()
    }
    entailment.score.mockClear()
    vision.check.mockClear()
    extraction.countRenderedPages.mockClear()
    extraction.extractRenderedPages.mockClear()
  })

  afterAll(async () => {
    try {
      await dbSvc.db.delete(seniorResumes).where(eq(seniorResumes.userId, USER_ID))
      await dbSvc.db.delete(users).where(eq(users.id, USER_ID))
    } catch {
      // cleanup only: never mask a result
    }
    await pool?.end()
  }, 15_000)

  it('1. happy path ends AWAITING_CONFIRM with staged content and report', async () => {
    const row = await submitAndRun()
    expect(row.verificationStatus).toBe('AWAITING_CONFIRM')
    expect(row.verificationErrorCode).toBeNull()
    expect(row.stagedContent?.summary).toBe(SUMMARY)
    expect(row.stagedContent?.experience.map((e) => e.bullets)).toEqual([
      ['Led the payments team', 'Moved billing to PostgreSQL'],
      ['Built the billing service'],
    ])
    expect(row.stagedContent?.experience[0]?.period).toBe('Mar 2021 – Present')
    expect(row.stagedTemplateName).toBe('classic')
    const key = stagedPdfKey(resumeId, row.verificationRunId as string)
    expect(row.stagedPdfS3Key).toBe(key)
    expect(s3.upload).toHaveBeenCalledTimes(1)
    expect(s3.upload.mock.calls[0]?.[0]).toBe(key)
    expect(row.verificationReport).toEqual({
      gates: [
        { gate: 'content', ok: true, items: [] },
        { gate: 'ats', ok: true, items: [] },
        { gate: 'layout', ok: true, items: [] },
        { gate: 'visual', ok: true, items: [] },
      ],
      fallbacks: [],
      // the owner name/email digest confirm compares against (B10): a sha256 hex, never the PII
      ownerKey: expect.stringMatching(/^[\da-f]{64}$/),
    })
    // the live columns are untouched until the human confirms
    expect(row.content).toEqual(expect.objectContaining({ summary: '' }))
  })

  it('2. writer unavailable → FAILED WRITER_UNAVAILABLE, live columns untouched', async () => {
    const before = await rowOf()
    writerReply = () => ({ kind: 'unavailable', reason: 'TIMEOUT' })
    const row = await submitAndRun()
    expect(row.verificationStatus).toBe('FAILED')
    expect(row.verificationErrorCode).toBe('WRITER_UNAVAILABLE')
    expect(row.verificationRunId).toBeNull()
    expect(row.stagedContent).toBeNull()
    expect(row.stagedPdfS3Key).toBeNull()
    expect({
      content: row.content,
      layout: row.layout,
      templateName: row.templateName,
      version: row.version,
      pdfS3Key: row.pdfS3Key,
    }).toEqual({
      content: before.content,
      layout: before.layout,
      templateName: before.templateName,
      version: before.version,
      pdfS3Key: before.pdfS3Key,
    })
  })

  it('3. a bullet with an invented "40%" is regenerated, then falls back to the notes', async () => {
    writerReply = (call) =>
      call.task === 'bullets' && call.payload.includes('Acme Corp')
        ? { kind: 'ok', items: [{ index: 0, bullets: ['Cut payment costs by 40%'] }] }
        : echoNotes(call)
    const row = await submitAndRun()
    const acme = writeCalls.filter((c) => c.task === 'bullets' && c.payload.includes('Acme Corp'))
    expect(acme).toHaveLength(3)
    expect(acme[0]?.feedback).toEqual([])
    expect(acme[1]?.feedback.join(' ')).toContain('40')
    expect(row.verificationStatus).toBe('AWAITING_CONFIRM')
    expect(row.stagedContent?.experience[0]?.bullets).toEqual(FACTS.experience[0]?.notes)
    expect(row.verificationReport?.fallbacks).toEqual(['experience.0.bullets'])
    expect(row.verificationReport?.gates[0]).toEqual({
      gate: 'content',
      ok: false,
      items: [{ path: 'experience.0.bullets', reason: 'UNGROUNDED' }],
    })
  })

  it('4. the writer payload has no name, email, location, education, languages or links', async () => {
    await submitAndRun()
    expect(writeCalls.length).toBeGreaterThan(0)
    for (const call of writeCalls) {
      const payload = JSON.parse(call.payload) as Record<string, unknown>
      expect(Object.keys(payload).sort()).toEqual(
        ['experience', 'headline', 'skills', 'yearsOfExperience'].sort(),
      )
      for (const secret of [NAME, EMAIL, PERSONAL_EMAIL, 'Lisbon', 'Portugal', 'Stanford']) {
        expect(call.payload).not.toContain(secret)
      }
      expect(call.payload).not.toContain(LINK_URL)
      expect(call.payload).not.toContain('"languages"')
    }
  })

  it('5. model output containing the full name fails that item', async () => {
    writerReply = (call) =>
      call.task === 'bullets' && call.payload.includes('Globex')
        ? { kind: 'ok', items: [{ index: 0, bullets: ['Jane Doe built the billing service'] }] }
        : echoNotes(call)
    const row = await submitAndRun()
    expect(row.verificationStatus).toBe('AWAITING_CONFIRM')
    expect(row.stagedContent?.experience[1]?.bullets).toEqual(['Built the billing service'])
    expect(row.verificationReport?.fallbacks).toEqual(['experience.1.bullets'])
    expect(row.verificationReport?.gates[0]?.items).toEqual([
      { path: 'experience.1.bullets', reason: 'CONTACT_IN_TEXT' },
    ])
    // the feedback never echoes the contact
    for (const call of writeCalls) expect(call.feedback.join(' ')).not.toContain('Jane')
  })

  it('6. a superseded run (run_id changed mid-run) stops at its next model call: no write, no object (CD-3)', async () => {
    let ownRunId = ''
    writerReply = async (call) => {
      if (call.task === 'summary' && ownRunId === '') {
        ownRunId = (await rowOf()).verificationRunId as string
        await setState({ verificationRunId: OTHER_RUN_ID })
      }
      return echoNotes(call)
    }
    const row = await submitAndRun()
    expect(row.verificationRunId).toBe(OTHER_RUN_ID)
    expect(row.verificationStatus).toBe('CHECKING')
    expect(row.stagedContent).toBeNull()
    expect(row.stagedPdfS3Key).toBeNull()
    expect(row.verificationReport).toBeNull()
    expect(ownRunId).not.toBe('')
    // the summary call was the last model call: the ownership read before the next one missed
    expect(writer.write).toHaveBeenCalledTimes(1)
    expect(vision.check).not.toHaveBeenCalled()
    expect(s3.upload).not.toHaveBeenCalled()
    expect(s3.delete).not.toHaveBeenCalled()
  })

  it('7. an unconfirmed vision finding does not fail the run', async () => {
    visionReplies = [
      { kind: 'ok', findings: [{ check: 'overlap', page: 0, text: 'two lines overlap' }] },
      { kind: 'ok', findings: [{ check: 'overflow', page: 0, text: 'something else' }] },
    ]
    const row = await submitAndRun()
    expect(vision.check).toHaveBeenCalledTimes(2)
    expect(row.verificationStatus).toBe('AWAITING_CONFIRM')
  })

  it('7b. a confirmed vision finding fails VISUAL_CHECK_FAILED with check and page only', async () => {
    const finding = { check: 'overlap' as const, page: 0, text: 'two lines overlap' }
    visionReplies = [
      { kind: 'ok', findings: [finding] },
      { kind: 'ok', findings: [finding] },
    ]
    const row = await submitAndRun()
    expect(row.verificationErrorCode).toBe('VISUAL_CHECK_FAILED')
    expect(row.verificationReport?.gates.at(-1)).toEqual({
      gate: 'visual',
      ok: false,
      items: [{ path: 'pages.0', reason: 'overlap' }],
    })
    expect(JSON.stringify(row.verificationReport)).not.toContain('two lines overlap')
  })

  it('8. vision unavailable → VISUAL_CHECK_UNAVAILABLE', async () => {
    visionReplies = [{ kind: 'unavailable', reason: 'NOT_CONFIGURED' }]
    const row = await submitAndRun()
    expect(row.verificationStatus).toBe('FAILED')
    expect(row.verificationErrorCode).toBe('VISUAL_CHECK_UNAVAILABLE')
  })

  it('9. a 3-page first render is repaired by density, not failed by the ATS stage', async () => {
    world.pagesFor = (layout) => (layout.density === 'compact' ? 2 : 3)
    const row = await submitAndRun()
    expect(row.verificationStatus).toBe('AWAITING_CONFIRM')
    expect(typst.render.mock.calls.map((c) => c[0].layout.density)).toEqual(['normal', 'compact'])
    expect(row.stagedLayout?.density).toBe('compact')
  })

  it('9b. a render over 30 pages enters the repair loop as TOO_MANY_PAGES', async () => {
    world.pagesFor = (layout) => (layout.density === 'compact' ? 1 : 31)
    const row = await submitAndRun()
    expect(row.verificationStatus).toBe('AWAITING_CONFIRM')
    // 31 pages is decided by the page count: the text is never extracted
    expect(extraction.extractRenderedPages).toHaveBeenCalledTimes(1)
  })

  it('9c. a layout still too long after 3 repair rounds → LAYOUT_UNFIXABLE', async () => {
    world.pagesFor = () => 3
    const row = await submitAndRun()
    expect(row.verificationErrorCode).toBe('LAYOUT_UNFIXABLE')
    // normal → compact → font small: one first render and two repairs, then nothing left to shrink
    expect(
      typst.render.mock.calls.map((c) => [c[0].layout.density, c[0].layout.fontScale]),
    ).toEqual([
      ['normal', 'normal'],
      ['compact', 'normal'],
      ['compact', 'small'],
    ])
    expect(s3.upload).not.toHaveBeenCalled()
  })

  it('10. the PNG copy sent to vision has no real name, email or link URL', async () => {
    await submitAndRun()
    expect(typst.renderPng).toHaveBeenCalledTimes(1)
    const sent = vision.check.mock.calls[0]?.[0] ?? []
    expect(sent).toHaveLength(1)
    const copy = decodePng(sent[0] as Buffer)
    expect(copy.displayName).toBe('Firstname Lastname')
    expect(copy.email).toBe('name@example.com')
    expect(copy.content.links).toEqual([{ label: 'Link', url: 'https://example.com' }])
    const text = JSON.stringify(copy)
    for (const secret of [NAME, EMAIL, PERSONAL_EMAIL, LINK_URL, 'GitHub']) {
      expect(text).not.toContain(secret)
    }
  })

  it('A1. a contact typed into an experience company is redacted in the PNG copy sent to vision', async () => {
    const phone = '+1 415 555 0100'
    const facts = structuredClone(FACTS)
    ;(facts.experience[1] as ResumeFacts['experience'][number]).company = `Globex ${phone}`
    await setState({ facts })
    const row = await submitAndRun()
    // redacted, not failed
    expect(row.verificationStatus).toBe('AWAITING_CONFIRM')
    expect(row.stagedContent?.experience[1]?.company).toBe(`Globex ${phone}`)
    const copy = decodePng(vision.check.mock.calls[0]?.[0][0] as Buffer)
    expect(copy.content.experience[1]?.company).toBe('Globex [REDACTED]')
    expect(JSON.stringify(copy)).not.toContain('555')
  })

  it('11. two concurrent submits → one run', async () => {
    const stale = await rowOf()
    const results = await Promise.allSettled([
      service.submit(stale, NAME, USER_ID),
      service.submit(stale, NAME, USER_ID),
    ])
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = results.find((r) => r.status === 'rejected')
    expect(((rejected as PromiseRejectedResult).reason as HttpException).getStatus()).toBe(409)
    expect(pending).toHaveLength(1)
    await Promise.all(pending.splice(0))
    expect(writeCalls.filter((c) => c.task === 'summary')).toHaveLength(1)
    expect((await rowOf()).verificationStatus).toBe('AWAITING_CONFIRM')
  })

  it('12. re-submit from AWAITING_CONFIRM deletes the old staged object', async () => {
    const first = await submitAndRun()
    const oldKey = first.stagedPdfS3Key as string
    expect(first.verificationStatus).toBe('AWAITING_CONFIRM')
    s3.delete.mockClear()
    writerReply = () => ({ kind: 'unavailable', reason: 'TIMEOUT' })
    await service.submit(first, NAME, USER_ID)
    // cleared and deleted at submit, before the run ends
    const queued = await rowOf()
    expect(queued.stagedPdfS3Key).toBeNull()
    expect(queued.stagedContent).toBeNull()
    expect(s3.delete.mock.calls.map((c) => c[0])).toEqual([oldKey])
    await Promise.all(pending.splice(0))
  })

  it('12b. submit refuses a custom template and incomplete facts with 422, busy with 409', async () => {
    const expectStatus = async (p: Promise<unknown>, status: number) => {
      const err = await p.then(
        () => undefined,
        (e: unknown) => e,
      )
      expect((err as HttpException).getStatus()).toBe(status)
    }
    await setState({ templateSource: '#let x = 1' })
    await expectStatus(service.submit(await rowOf(), NAME, USER_ID), 422)
    await setState({ templateSource: null, facts: { ...FACTS, headline: '' } })
    await expectStatus(service.submit(await rowOf(), NAME, USER_ID), 422)
    await setState({ facts: FACTS, status: 'RUNNING' })
    await expectStatus(service.submit(await rowOf(), NAME, USER_ID), 409)
    expect(pending).toHaveLength(0)
  })

  it('13. after a density repair the uploaded object is the repaired render', async () => {
    world.pagesFor = (layout) => (layout.density === 'compact' ? 2 : 3)
    await submitAndRun()
    const uploaded = s3.upload.mock.calls[0]?.[1] as Buffer
    expect(decodePdf(uploaded).layout.density).toBe('compact')
    expect(uploaded.equals(await typst.render.mock.results[1]?.value)).toBe(true)
  })

  it('14. a missing email on page 1 → FAILED ATS_CHECK_FAILED', async () => {
    world.omitEmail = true
    const row = await submitAndRun()
    expect(row.verificationStatus).toBe('FAILED')
    expect(row.verificationErrorCode).toBe('ATS_CHECK_FAILED')
    expect(row.verificationReport?.gates.at(-1)?.items.map((i) => i.reason)).toContain(
      'CONTACT_NOT_IN_BODY',
    )
  })

  it.each([
    ['the writer', () => (writerReply = () => ({ kind: 'unavailable', reason: 'TIMEOUT' }))],
    ['entailment', () => entailment.score.mockResolvedValueOnce('unavailable')],
    ['the ATS stage', () => (world.omitEmail = true)],
    ['the vision check', () => (visionReplies = [{ kind: 'unavailable', reason: 'TIMEOUT' }])],
  ])('15. a run that fails at %s uploads nothing', async (_stage, arrange) => {
    arrange()
    const row = await submitAndRun()
    expect(row.verificationStatus).toBe('FAILED')
    expect(s3.upload).not.toHaveBeenCalled()
  })
})
