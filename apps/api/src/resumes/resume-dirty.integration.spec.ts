/**
 * Senior roles PR 4 Task 4.3: every resume write that changes `content` or `facts` marks the
 * SENIOR `senior.resume` dirty IN ITS OWN TRANSACTION (the resume skills feed the matching profile
 * version). Real Postgres, real services; S3, the model, Typst and the check runner are stubs.
 *
 * Each site is driven twice: with a fault injected right AFTER the dirty row is written (the
 * write and the row must both be gone, so the mark cannot be on another connection), then clean
 * (exactly one `senior.resume` row). A render-status write marks nothing.
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

  it('runExtraction (the facts write): fault -> no facts, no row; commit -> one row', async () => {
    const id = await senior('extract')
    const row = await resumeOf(id, { status: 'QUEUED' })
    const text = async () => 'Senior backend engineer, Go and PostgreSQL, ten years. '.repeat(3)
    await faulted(id, () => service.runExtraction(row.id, text))
    expect((await rowOf(id))?.facts).toBeNull()
    await q(`UPDATE senior_resumes SET status = 'QUEUED' WHERE id = $1`, [row.id])
    await service.runExtraction(row.id, text)
    expect((await rowOf(id))?.facts?.skills).toEqual(['Go', 'Kafka'])
    expect(await dirty(id)).toEqual(RESUME_MARK)
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

  it('saveFacts: fault -> no facts, no row; commit -> one row', async () => {
    const id = await senior('facts')
    await resumeOf(id)
    const facts = { ...EMPTY_RESUME_FACTS, skills: ['Go', 'Terraform'] }
    await faulted(id, () => service.saveFacts(hr, id, facts))
    expect((await rowOf(id))?.facts).toBeNull()
    await service.saveFacts(hr, id, facts)
    expect((await rowOf(id))?.facts?.skills).toEqual(['Go', 'Terraform'])
    expect(await dirty(id)).toEqual(RESUME_MARK)
  })

  it('submit (the legacy-facts adoption write): fault -> still DRAFT, no row; commit -> one row', async () => {
    const id = await senior('submit')
    await resumeOf(id, { facts: FACTS })
    const name = 'Jane Doe' // the completeness gate wants a full name
    await faulted(id, async () => verification.submit((await rowOf(id))!, name, HR_ID))
    expect((await rowOf(id))?.verificationStatus).toBe('DRAFT')
    await verification.submit((await rowOf(id))!, name, HR_ID)
    expect((await rowOf(id))?.verificationStatus).toBe('QUEUED')
    expect(await dirty(id)).toEqual(RESUME_MARK)
  })

  it('confirm (staged content -> content): fault -> not promoted, no row; commit -> one row', async () => {
    const id = await senior('confirm')
    const owner = {
      displayName: 'RD confirm',
      email: `rd-${TAG}-confirm@test.spec`,
      legalFullName: null,
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
