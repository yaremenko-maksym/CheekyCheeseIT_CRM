/**
 * The verification run (Task 14) on a real Postgres: submit queues it, the runner claims it and ends
 * AWAITING_CONFIRM or FAILED through compare-and-set writes.
 *
 * Typst, the extractor, S3 and every model are fakes. The CI integration job has no Typst binary, and
 * this spec is about the run's gates and state, not the typesetter: the fake render encodes its input
 * (and a test-controlled page count) in the buffer, and the fake extractor turns that input back into
 * page text shaped like what `unpdf` returns for the skeleton (see resume-ats-checker.spec.ts), so the
 * REAL ATS checker runs on it. The real render, extract and ATS chain is pinned by the ATS specs.
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { HttpException } from '@nestjs/common'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RESUME_LAYOUT,
  RESUME_SECTION_ORDER,
  type ResumeContent,
  type ResumeFacts,
  type ResumeLayoutOptions,
} from '@crm/shared'
import * as schema from '../../database/schema'
import { seniorResumes, userEmails, users, type SeniorResume } from '../../database/schema'
import { DatabaseService } from '../../database/database.service'
import { hasDatabaseUrl } from '../../test/require-real-db'
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

const PDF_MAGIC = '%PDF-FAKE\n'
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const decodePdf = (pdf: Buffer) =>
  JSON.parse(pdf.subarray(PDF_MAGIC.length).toString('utf8')) as ResumeRenderInput
const decodePng = (png: Buffer) =>
  JSON.parse(png.subarray(PNG_MAGIC.length).toString('utf8')) as ResumeRenderInput

const TITLES: Record<string, string> = {
  summary: 'Summary',
  skills: 'Skills',
  experience: 'Experience',
  education: 'Education',
  languages: 'Languages',
  links: 'Links',
}

/** The skeleton's text lines for an input, in the order `unpdf` reads them. */
function skeletonLines(input: ResumeRenderInput, opts: { omitEmail: boolean }): string[] {
  const c: ResumeContent = input.content
  const lines = [input.displayName, ...(opts.omitEmail ? [] : [input.email])]
  const hidden = new Set(input.layout.hiddenSections)
  for (const key of input.layout.sectionOrder.filter((k) => !hidden.has(k))) {
    lines.push(TITLES[key] as string)
    if (key === 'summary') lines.push(c.summary)
    if (key === 'skills') lines.push(c.skills.join(' · '))
    if (key === 'experience') {
      for (const item of c.experience) {
        lines.push(item.role, item.company, item.period, ...item.bullets.map((b) => `• ${b}`))
      }
    }
    if (key === 'education') {
      for (const item of c.education) lines.push(item.institution, item.degree, item.period)
    }
    if (key === 'languages') for (const l of c.languages) lines.push(`${l.name} — ${l.level}`)
    if (key === 'links') for (const l of c.links) lines.push(l.label)
  }
  return lines
}

/** Test-controlled render state. */
const world = {
  pagesFor: (_layout: ResumeLayoutOptions) => 1,
  omitEmail: false,
}

function splitPages(lines: string[], n: number): string[] {
  const per = Math.ceil(lines.length / n)
  return Array.from({ length: n }, (_, i) => lines.slice(i * per, (i + 1) * per).join('\n'))
}

const typst = {
  render: vi.fn(async (input: ResumeRenderInput) =>
    Buffer.concat([Buffer.from(PDF_MAGIC), Buffer.from(JSON.stringify(input))]),
  ),
  renderPng: vi.fn(async (input: ResumeRenderInput) => [
    Buffer.concat([PNG_MAGIC, Buffer.from(JSON.stringify(input))]),
  ]),
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

  it('6. a superseded run (run_id changed mid-run) writes nothing and deletes its object', async () => {
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
    const own = stagedPdfKey(resumeId, ownRunId)
    expect(s3.upload.mock.calls.map((c) => c[0])).toEqual([own])
    expect(s3.delete.mock.calls.map((c) => c[0])).toEqual([own])
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
})
