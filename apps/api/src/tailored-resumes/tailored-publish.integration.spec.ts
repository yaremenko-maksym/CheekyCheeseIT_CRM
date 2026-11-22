/**
 * `publishRun` against a REAL Postgres (spec §8, Review Focus 1, SR-L-1): the run-id CAS, the run
 * deadline, the base version check under `FOR SHARE`, and the previous PDF deleted after commit.
 *
 * NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run src/tailored-resumes/tailored-publish.integration.spec.ts
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Logger } from '@nestjs/common'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RESUME_LAYOUT, EMPTY_RESUME_CONTENT, type ResumeContent } from '@crm/shared'
import * as schema from '../database/schema'
import { jobOpportunities, seniorResumes, tailoredResumes, users } from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'
import { publishRun, type RunResult } from './tailored-publish'
import { TAILORED_RUN_DEADLINE_MS } from './tailored-run'

const SENIOR = '7a110091-0000-4000-bb00-000000000001'
const HR = '7a110091-0000-4000-bb00-000000000002'
const OPP = '7a110091-0000-4000-bb00-0000000000a1'
const RUN = '7a110091-0000-4000-bb00-0000000000f1'
const OLD_KEY = 'tailored-resumes/x/run-old.pdf'
const NOW = new Date('2026-11-22T12:00:00.000Z')

const PUBLISHED: ResumeContent = { ...EMPTY_RESUME_CONTENT, summary: 'Old published variant.' }
const NEW: ResumeContent = { ...EMPTY_RESUME_CONTENT, summary: 'New tailored variant.' }

describe.skipIf(!hasDatabaseUrl())('publishRun — real DB', () => {
  let pool: Pool
  let db: ReturnType<typeof drizzle<typeof schema>>
  let rowId: string
  let baseId: string
  const seenAtDelete: (string | null)[] = []
  const s3 = {
    upload: vi.fn(async (_key: string) => undefined),
    delete: vi.fn(async (_key: string) => {
      // What another connection sees at the moment of the delete: the commit happened first.
      const [r] = await db
        .select({ key: tailoredResumes.pdfS3Key })
        .from(tailoredResumes)
        .where(eq(tailoredResumes.id, rowId))
      seenAtDelete.push(r?.key ?? null)
    }),
  }
  const logger = new Logger('tailored-publish.integration')
  const result = (): RunResult => ({
    accepted: {
      pdf: Buffer.from('%PDF-new'),
      content: NEW,
      layout: DEFAULT_RESUME_LAYOUT,
      gates: [],
      fallbacks: [],
    },
    coverLetter: 'Dear Hiring Team,\n\nNew.\n\nKind regards,\nTR Senior',
    verification: {
      gates: [{ gate: 'content', ok: true, items: [] }],
      revertedPaths: [],
      keptFromBase: 0,
      coverage: { matched: ['Go'], total: 1 },
      gaps: [],
      injectionSuspected: false,
      postingPartial: false,
      postingTruncated: false,
      routes: ['jev'],
    },
    baseResumeId: baseId,
    baseVersion: 3,
    opportunityRevision: 5,
    templateName: 'classic',
  })
  const publish = (now = NOW) =>
    publishRun(
      { db, s3, logger, now: () => now },
      { rowId, runId: RUN, runBaseVersion: 3, result: result() },
    )
  const row = async () => {
    const [r] = await db.select().from(tailoredResumes).where(eq(tailoredResumes.id, rowId))
    if (!r) throw new Error('no tailored row')
    return r
  }
  const setRow = (over: Partial<typeof tailoredResumes.$inferInsert>) =>
    db.update(tailoredResumes).set(over).where(eq(tailoredResumes.id, rowId))
  const setBase = (over: Partial<typeof seniorResumes.$inferInsert>) =>
    db.update(seniorResumes).set(over).where(eq(seniorResumes.id, baseId))

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    db = drizzle(pool, { schema })
    await db
      .insert(users)
      .values([
        {
          id: SENIOR,
          email: 'tailored-publish-senior@test.spec',
          displayName: 'TR Senior',
          role: 'SENIOR',
        },
        { id: HR, email: 'tailored-publish-hr@test.spec', displayName: 'TR HR', role: 'HR' },
      ])
      .onConflictDoNothing()
    await db
      .insert(jobOpportunities)
      .values({ id: OPP, title: 'TP role', titleKey: 'tp role' })
      .onConflictDoNothing()
  })

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    s3.upload.mockClear()
    s3.delete.mockClear()
    seenAtDelete.length = 0
    await db.delete(tailoredResumes).where(eq(tailoredResumes.jobOpportunityId, OPP))
    await db.delete(seniorResumes).where(eq(seniorResumes.userId, SENIOR))
    const [base] = await db
      .insert(seniorResumes)
      .values({
        userId: SENIOR,
        content: EMPTY_RESUME_CONTENT,
        version: 3,
        verifiedVersion: 3,
        templateName: 'classic',
        pdfS3Key: 'resumes/tailored-publish.pdf',
        verificationStatus: 'VERIFIED',
      })
      .returning({ id: seniorResumes.id })
    baseId = (base as { id: string }).id
    const [r] = await db
      .insert(tailoredResumes)
      .values({
        jobOpportunityId: OPP,
        seniorUserId: SENIOR,
        content: PUBLISHED,
        coverLetter: 'Old letter',
        pdfS3Key: OLD_KEY,
        pdfStatus: 'READY',
        pdfRenderId: '7a110091-0000-4000-bb00-0000000000e1',
        runStatus: 'RUNNING',
        runId: RUN,
        runBaseVersion: 3,
        runQueuedAt: new Date(NOW.getTime() - 120_000),
        runStartedAt: new Date(NOW.getTime() - 60_000),
        runRequestedByUserId: HR,
      })
      .returning({ id: tailoredResumes.id })
    rowId = (r as { id: string }).id
  })

  afterAll(async () => {
    if (db === undefined) return
    await db.delete(tailoredResumes).where(eq(tailoredResumes.jobOpportunityId, OPP))
    await db.delete(seniorResumes).where(eq(seniorResumes.userId, SENIOR))
    await db.delete(jobOpportunities).where(eq(jobOpportunities.id, OPP))
    await db.delete(users).where(inArray(users.id, [SENIOR, HR]))
    await pool.end()
  })

  const ownKey = () => `tailored-resumes/${rowId}/run-${RUN}.pdf`

  it('publishes: every column written, the run SUCCEEDED, the requester the generator', async () => {
    expect(await publish()).toBe('PUBLISHED')
    const r = await row()
    expect(r).toMatchObject({
      content: NEW,
      baseResumeId: baseId,
      baseVersion: 3,
      opportunityRevision: 5,
      templateName: 'classic',
      runStatus: 'SUCCEEDED',
      runStage: null,
      pdfStatus: 'READY',
      pdfS3Key: ownKey(),
      generatedByUserId: HR,
    })
    expect(r.coverLetter).toContain('New.')
    expect(r.verification?.routes).toEqual(['jev'])
  })

  it('publish sets a fresh pdf_render_id', async () => {
    await publish()
    const r = await row()
    expect(r.pdfRenderId).not.toBeNull()
    expect(r.pdfRenderId).not.toBe('7a110091-0000-4000-bb00-0000000000e1')
  })

  it('previous PDF deleted after commit, never before', async () => {
    await publish()
    expect(s3.delete).toHaveBeenCalledWith(OLD_KEY)
    expect(seenAtDelete).toEqual([ownKey()])
  })

  it('publish refuses a VERIFIED base with verified_version ≠ runBaseVersion', async () => {
    await setBase({ verifiedVersion: 2 })
    expect(await publish()).toBe('BASE_CHANGED')
    expect(await row()).toMatchObject({ runStatus: 'FAILED', runErrorCode: 'BASE_CHANGED' })
  })

  it('publish refuses when base version moved: content and pdf_s3_key unchanged, run object deleted', async () => {
    await setBase({ version: 4, verifiedVersion: 4 })
    expect(await publish()).toBe('BASE_CHANGED')
    const r = await row()
    expect(r).toMatchObject({
      content: PUBLISHED,
      coverLetter: 'Old letter',
      pdfS3Key: OLD_KEY,
      runStatus: 'FAILED',
      runErrorCode: 'BASE_CHANGED',
    })
    expect(s3.delete.mock.calls).toEqual([[ownKey()]])
  })

  it('publish after the sweep took the run → LOST, own object deleted', async () => {
    await setRow({ runStatus: 'FAILED', runErrorCode: 'STALLED' })
    expect(await publish()).toBe('LOST')
    expect(await row()).toMatchObject({
      content: PUBLISHED,
      pdfS3Key: OLD_KEY,
      runErrorCode: 'STALLED',
    })
    expect(s3.delete.mock.calls).toEqual([[ownKey()]])
  })

  it('a newer run id owns the row → LOST', async () => {
    await setRow({ runId: '7a110091-0000-4000-bb00-0000000000f2' })
    expect(await publish()).toBe('LOST')
  })

  it('SR-L-1: a run started past the deadline → LOST, own object deleted; at the deadline it publishes', async () => {
    await setRow({ runStartedAt: new Date(NOW.getTime() - TAILORED_RUN_DEADLINE_MS - 1) })
    expect(await publish()).toBe('LOST')
    expect(s3.delete.mock.calls).toEqual([[ownKey()]])
    expect((await row()).pdfS3Key).toBe(OLD_KEY)

    await setRow({ runStartedAt: new Date(NOW.getTime() - TAILORED_RUN_DEADLINE_MS) })
    expect(await publish()).toBe('PUBLISHED')
  })
})
