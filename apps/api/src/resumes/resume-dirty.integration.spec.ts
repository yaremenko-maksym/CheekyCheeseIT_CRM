/**
 * Senior roles PR 4 Task 4.3: a resume write that changes the skill set the MATCHER reads marks
 * the SENIOR `senior.resume` dirty IN ITS OWN TRANSACTION (the resume skills feed the matching
 * profile version). Real Postgres, real services; S3, the model, Typst and the check runner are
 * stubs.
 *
 * The read set is exactly `loadRoster`'s: `content -> 'skills'` plus the `technologies` of
 * `facts -> 'experience'` (`runtime/recompute-inputs.resumeSkills`). `facts.skills` is NOT in it,
 * so a write that only moves `facts.skills` enqueues nothing (SR-L-1): the recompute would read
 * the same two fields and reach the same matches, and the fan-out over every opportunity is the
 * cost of the row.
 *
 * A site whose write CAN change the read set is driven twice: with a fault injected right AFTER
 * the dirty row is written (the write and the row must both be gone, so the mark cannot be on
 * another connection), then clean (exactly one `senior.resume` row). A render-status write, and a
 * write that leaves the read set alone, mark nothing.
 *
 * DB-SKIP-GUARD: `describe.skipIf(!hasDatabaseUrl())`; the live `crm_db` is refused.
 */
import { createHash, randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq } from 'drizzle-orm'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_RESUME_CONTENT,
  EMPTY_RESUME_FACTS,
  type ResumeFacts,
  type SessionUser,
} from '@crm/shared'
import * as schema from '../database/schema'
import { seniorResumes, type SeniorResume } from '../database/schema'
import { DatabaseService } from '../database/database.service'
import { hasDatabaseUrl } from '../test/require-real-db'
import { SeniorResumesService } from './resumes.service'
import { ResumeVerificationService } from './verification/resume-verification.service'
import { renderOwnerKey } from './verification/run-columns'

const fault = vi.hoisted(() => ({ armed: false }))
vi.mock('../job-sourcing/ownership/dirty-work.store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../job-sourcing/ownership/dirty-work.store')>()
  return {
    ...real,
    enqueueDerivedDirty: async (...args: Parameters<typeof real.enqueueDerivedDirty>) => {
      const out = await real.enqueueDerivedDirty(...args)
      if (fault.armed) {
        fault.armed = false
        throw new Error('injected after the dirty row')
      }
      return out
    },
  }
})

const TAG = randomUUID().slice(0, 8)
const HR_ID = randomUUID()
const hr = { id: HR_ID, email: `rd-${TAG}-hr@test.spec`, role: 'HR' } as SessionUser
const userIds: string[] = [HR_ID]

/** Complete facts (the submit gate); the skills are what the matching profile reads. */
const FACTS: ResumeFacts = {
  headline: 'Senior Backend Engineer',
  location: { city: 'Lisbon', country: 'Portugal' },
  workFormat: 'remote',
  skills: ['Go', 'PostgreSQL', 'Docker', 'Kafka', 'Terraform'],
  experience: [
    {
      company: 'Acme Corp',
      role: 'Tech Lead',
      location: null,
      start: '2021-03',
      end: null,
      current: true,
      technologies: ['Go'],
      notes: ['Led the payments team', 'Moved billing to PostgreSQL'],
    },
  ],
  education: [
    { institution: 'Stanford University', degree: 'BSc Physics', startYear: 2010, endYear: 2014 },
  ],
  languages: [{ name: 'English', level: 'C1' }],
  links: [{ label: 'GitHub', url: 'https://github.com/resume-dirty-unit' }],
}

let pool: Pool
let dbSvc: DatabaseService
let service: SeniorResumesService
let verification: ResumeVerificationService
const q = (text: string, params: unknown[] = []) => pool.query(text, params)

async function senior(name: string): Promise<string> {
  const id = randomUUID()
  await q(
    `INSERT INTO users (id, email, display_name, role, tech_stack, technical_roles)
     VALUES ($1, $2, $3, 'SENIOR', ARRAY['Go','SQL','AWS'], ARRAY['BACKEND_ENGINEER'])`,
    [id, `rd-${TAG}-${name}@test.spec`, `RD ${name}`],
  )
  userIds.push(id)
  return id
}

async function resumeOf(userId: string, set: Partial<SeniorResume> = {}): Promise<SeniorResume> {
  const [row] = await dbSvc.db
    .insert(seniorResumes)
    .values({ userId, content: { ...EMPTY_RESUME_CONTENT, skills: ['Go'] }, ...set })
    .returning()
  if (!row) throw new Error('no resume row')
  return row
}

const rowOf = async (userId: string) =>
  dbSvc.db.query.seniorResumes.findFirst({ where: eq(seniorResumes.userId, userId) })

/** The `[kind, reason]` dirty rows of `userId`. */
async function dirty(userId: string): Promise<string[][]> {
  const { rows } = await q(
    `SELECT entity_kind, reason FROM job_dirty_work WHERE entity_id = $1 ORDER BY target_version`,
    [userId],
  )
  return rows.map((r) => [String(r.entity_kind), String(r.reason)])
}

/** The write rejects with the injected fault, and its dirty row went with it. */
async function faulted(userId: string, write: () => Promise<unknown>): Promise<void> {
  fault.armed = true
  await expect(write()).rejects.toThrow('injected after the dirty row')
  expect(fault.armed).toBe(false) // the fault fired: the mark ran inside the write
  expect(await dirty(userId)).toEqual([])
}

const RESUME_MARK = [['SENIOR', 'senior.resume']]

describe.skipIf(!hasDatabaseUrl())('resume writes mark senior.resume (senior roles PR 4)', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const { rows } = await q(`SELECT current_database() AS db`)
    if (rows[0].db === 'crm_db') throw new Error('refusing the live database')
    dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, {
      pool,
      db: drizzle(pool, { schema }),
    })
    const s3 = {
      upload: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      listObjects: vi.fn().mockResolvedValue({ objects: [], nextContinuationToken: undefined }),
      getObject: vi.fn(),
    }
    const ai = {
      extractStructure: vi.fn().mockResolvedValue({
        ok: true,
        content: { ...EMPTY_RESUME_CONTENT, skills: ['Go', 'Kafka'] },
        tokensUsed: 7,
      }),
    }
    const typst = {
      fingerprint: vi.fn((input: unknown) =>
        createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      ),
      render: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7 fake')),
    }
    verification = new ResumeVerificationService(
      dbSvc,
      s3 as never,
      {
        run: vi.fn().mockResolvedValue(undefined),
      } as never,
    )
    service = new SeniorResumesService(
      dbSvc,
      s3 as never,
      ai as never,
      {} as never,
      typst as never,
      verification,
    )
    await q(`INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'RD HR', 'HR')`, [
      HR_ID,
      hr.email,
    ])
  }, 60_000)

  beforeEach(() => {
    fault.armed = false
  })

  afterAll(async () => {
    if (pool === undefined) return
    try {
      await q(`DELETE FROM job_dirty_work WHERE entity_id = ANY($1::uuid[])`, [userIds])
      await q(`DELETE FROM tailored_resumes WHERE senior_user_id = ANY($1::uuid[])`, [userIds])
      await q(`DELETE FROM job_opportunities WHERE title LIKE $1`, [`rd-${TAG}-%`])
      await q(`DELETE FROM senior_resumes WHERE user_id = ANY($1::uuid[])`, [userIds])
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [userIds])
    } finally {
      await pool.end()
    }
  })

  it('updateContent: fault -> no content, no row; commit -> one senior.resume row', async () => {
    const id = await senior('content')
    const before = await resumeOf(id)
    const content = { ...EMPTY_RESUME_CONTENT, skills: ['Rust'] }
    await faulted(id, () => service.updateContent(hr, id, content))
    expect((await rowOf(id))?.version).toBe(before.version)
    await service.updateContent(hr, id, content)
    expect((await rowOf(id))?.content.skills).toEqual(['Rust'])
    expect(await dirty(id)).toEqual(RESUME_MARK)
  })

  it('updateContent of a non-skill field marks nothing (SR-L-1 / SR-L-3)', async () => {
    const id = await senior('content-noop')
    await resumeOf(id)
    const same = { ...EMPTY_RESUME_CONTENT, skills: ['Go'], summary: 'A rewritten summary.' }
    await service.updateContent(hr, id, same)
    expect((await rowOf(id))?.content.summary).toBe('A rewritten summary.')
    // The guard's `after` is the row the UPDATE returned, never a hand-built `{content, facts}`
    // pair (SR-L-3). Narrowing that projection would make `skillsOf(after)` read an empty set
    // here, and a summary rewrite would fan out over every opportunity.
    expect(await dirty(id)).toEqual([])
  })

  it('runExtraction over facts that carried technologies: fault -> no facts, no row; commit -> one row', async () => {
    const id = await senior('extract')
    // `contentToFacts` derives `technologies: []`, so the Kafka the facts carried leaves the
    // matcher's read set with this write — a real change, unlike the `facts.skills` it rewrites.
    const kafka = [{ ...FACTS.experience[0]!, technologies: ['Kafka'] }]
    const row = await resumeOf(id, { status: 'QUEUED', facts: { ...FACTS, experience: kafka } })
    const text = async () => 'Senior backend engineer, Go and PostgreSQL, ten years. '.repeat(3)
    await faulted(id, () => service.runExtraction(row.id, text))
    expect((await rowOf(id))?.facts?.experience[0]?.technologies).toEqual(['Kafka'])
    await q(`UPDATE senior_resumes SET status = 'QUEUED' WHERE id = $1`, [row.id])
    await service.runExtraction(row.id, text)
    expect((await rowOf(id))?.facts?.skills).toEqual(['Go', 'Kafka'])
    expect(await dirty(id)).toEqual(RESUME_MARK)
  })

  it('runExtraction that only rewrites facts.skills marks nothing (SR-L-1)', async () => {
    const id = await senior('extract-noop')
    const row = await resumeOf(id, { status: 'QUEUED' })
    const text = async () => 'Senior backend engineer, Go and PostgreSQL, ten years. '.repeat(3)
    await service.runExtraction(row.id, text)
    // The facts landed: `facts.skills` moved, and the matcher reads neither it nor an empty
    // `technologies`, so the read set (`content.skills` = Go) is the one it already had.
    expect((await rowOf(id))?.facts?.skills).toEqual(['Go', 'Kafka'])
    expect(await dirty(id)).toEqual([])
  })

  it('deleteResume: fault -> the row stays, no dirty row; commit -> gone and one row', async () => {
    const id = await senior('delete')
    await resumeOf(id)
    await faulted(id, () => service.deleteResume(hr, id))
    expect(await rowOf(id)).toBeDefined()
    await service.deleteResume(hr, id)
    expect(await rowOf(id)).toBeUndefined()
    expect(await dirty(id)).toEqual(RESUME_MARK)
  })

  /** A tailored row of `userId` on a fresh opportunity (C3): `cols` and their SQL `values`. */
  async function tailored(userId: string, cols: string, values: string): Promise<void> {
    const { rows } = await q(
      `INSERT INTO job_opportunities (title, title_key, revision, availability, technical_roles, role_status)
       VALUES ($1, $1, 1, 'OPEN', ARRAY['BACKEND_ENGINEER'], 'RULE') RETURNING id`,
      [`rd-${TAG}-${randomUUID().slice(0, 8)}`],
    )
    await q(
      `INSERT INTO tailored_resumes (job_opportunity_id, senior_user_id, ${cols})
       VALUES ($1, $2, ${values})`,
      [rows[0].id, userId],
    )
  }

  const tailoredRows = async (userId: string) =>
    (await q(`SELECT 1 FROM tailored_resumes WHERE senior_user_id = $1`, [userId])).rowCount

  it.each([
    [
      'a tailored run QUEUED (no base cited yet)',
      'run_status, run_id',
      `'QUEUED', gen_random_uuid()`,
    ],
    ['a tailored run RUNNING', 'run_status, run_id', `'RUNNING', gen_random_uuid()`],
    ['a tailored render QUEUED', 'pdf_status', `'QUEUED'`],
    ['a tailored render RUNNING', 'pdf_status, pdf_render_id', `'RUNNING', gen_random_uuid()`],
  ])(
    'deleteResume while %s: 409 RESUME_DELETE_BUSY, the base stays (C3)',
    async (_l, cols, values) => {
      const id = await senior(`c3-${randomUUID().slice(0, 6)}`)
      await resumeOf(id)
      await tailored(id, cols, values)
      const err = await service.deleteResume(hr, id).then(
        () => null,
        (e: unknown) => e as { getStatus: () => number; getResponse: () => unknown },
      )
      expect(err?.getStatus()).toBe(409)
      expect(err?.getResponse()).toMatchObject({ code: 'RESUME_DELETE_BUSY' })
      expect(await rowOf(id)).toBeDefined()
    },
  )

  it('deleteResume: a run that starts after the fast-path read is refused under the lock; nothing goes (SR-M-2)', async () => {
    const id = await senior('c3-race')
    await resumeOf(id)
    await tailored(id, 'run_status, run_id', `'RUNNING', gen_random_uuid()`)
    // The fast-path read ran before the run started: it saw nothing active.
    const early = vi.spyOn(dbSvc.db, 'execute').mockResolvedValueOnce({ rows: [] } as never)
    const err = await service.deleteResume(hr, id).then(
      () => null,
      (e: unknown) => e as { getStatus: () => number; getResponse: () => unknown },
    )
    const earlyReads = early.mock.calls.length
    early.mockRestore()
    expect(earlyReads).toBe(1)
    expect(err?.getStatus()).toBe(409)
    expect(err?.getResponse()).toMatchObject({ code: 'RESUME_DELETE_BUSY' })
    expect(await rowOf(id)).toBeDefined()
    expect(await tailoredRows(id)).toBe(1)
  })

  it('deleteResume with idle tailored rows deletes the base; a published variant goes with it (C3)', async () => {
    const id = await senior('c3-idle')
    const base = await resumeOf(id)
    await tailored(id, 'run_status, run_id', `'FAILED', gen_random_uuid()`)
    await tailored(
      id,
      'base_resume_id, content, cover_letter, pdf_status, run_status, run_id',
      `'${base.id}', '{}'::jsonb, 'x', 'READY', 'SUCCEEDED', gen_random_uuid()`,
    )
    await service.deleteResume(hr, id)
    expect(await rowOf(id)).toBeUndefined()
    // the base FK cascades: only the row that never cited a base survives
    expect(await tailoredRows(id)).toBe(1)
  })

  it('saveFacts (a technology the matcher reads): fault -> no facts, no row; commit -> one row', async () => {
    const id = await senior('facts')
    await resumeOf(id)
    const experience = [{ ...FACTS.experience[0]!, technologies: ['Terraform'] }]
    const facts = { ...EMPTY_RESUME_FACTS, skills: ['Go', 'Terraform'], experience }
    await faulted(id, () => service.saveFacts(hr, id, facts))
    expect((await rowOf(id))?.facts).toBeNull()
    await service.saveFacts(hr, id, facts)
    expect((await rowOf(id))?.facts?.experience[0]?.technologies).toEqual(['Terraform'])
    expect(await dirty(id)).toEqual(RESUME_MARK)
  })

  it('saveFacts of a non-skill field marks nothing (SR-L-1)', async () => {
    const id = await senior('facts-noop')
    await resumeOf(id)
    const experience = [{ ...FACTS.experience[0]!, technologies: ['Terraform'] }]
    const facts = { ...EMPTY_RESUME_FACTS, skills: ['Go', 'Terraform'], experience }
    await service.saveFacts(hr, id, facts)
    expect(await dirty(id)).toEqual(RESUME_MARK)
    await service.saveFacts(hr, id, { ...facts, headline: 'Staff Backend Engineer' })
    expect((await rowOf(id))?.facts?.headline).toBe('Staff Backend Engineer')
    expect(await dirty(id)).toEqual(RESUME_MARK) // still the one row of the first write
  })

  it('submit (the legacy-facts adoption write) stores the same facts, so it marks nothing', async () => {
    const id = await senior('submit')
    await resumeOf(id, { facts: FACTS })
    const name = 'Jane Doe' // the completeness gate wants a full name
    await verification.submit((await rowOf(id))!, name, HR_ID)
    const row = await rowOf(id)
    // The write stored `factsOf(row)` — the row's own valid facts — so the read set is unchanged.
    expect([row?.verificationStatus, row?.facts?.experience[0]?.technologies]).toEqual([
      'QUEUED',
      ['Go'],
    ])
    expect(await dirty(id)).toEqual([])
  })

  it('confirm (staged content -> content): fault -> not promoted, no row; commit -> one row', async () => {
    const id = await senior('confirm')
    const owner = {
      displayName: 'RD confirm',
      email: `rd-${TAG}-confirm@test.spec`,
      legalFullName: null,
      phone: null,
      telegram: null,
    }
    const runId = randomUUID()
    await resumeOf(id, {
      facts: FACTS,
      verificationStatus: 'AWAITING_CONFIRM',
      verificationRunId: runId,
      verificationKind: 'full',
      stagedContent: { ...EMPTY_RESUME_CONTENT, skills: ['Go', 'Elixir'] },
      verificationReport: { ownerKey: renderOwnerKey(owner) } as never,
      stagedPdfS3Key: `resumes/${TAG}/staged/run.pdf`,
    })
    // `layout` is NOT NULL and the confirm copies the staged layout over it.
    await q(`UPDATE senior_resumes SET staged_layout = layout WHERE user_id = $1`, [id])
    const confirm = async () => {
      const row = (await rowOf(id))!
      return verification.confirm(row, { runId, version: row.version }, HR_ID, 'fp', owner)
    }
    await faulted(id, confirm)
    expect((await rowOf(id))?.verificationStatus).toBe('AWAITING_CONFIRM')
    await confirm()
    const promoted = await rowOf(id)
    expect([promoted?.verificationStatus, promoted?.content.skills]).toEqual([
      'VERIFIED',
      ['Go', 'Elixir'],
    ])
    expect(await dirty(id)).toEqual(RESUME_MARK)
  })

  it('a render-status write (markRenderStarted) marks nothing', async () => {
    const id = await senior('render')
    const runId = randomUUID()
    const row = await resumeOf(id, { pdfRenderStatus: 'RUNNING', pdfRenderRunId: runId })
    const internals = service as unknown as {
      markRenderStarted(resumeId: string, run: string): Promise<void>
    }
    await internals.markRenderStarted(row.id, runId)
    expect((await rowOf(id))?.pdfRenderStartedAt).not.toBeNull()
    expect(await dirty(id)).toEqual([])
  })
})
