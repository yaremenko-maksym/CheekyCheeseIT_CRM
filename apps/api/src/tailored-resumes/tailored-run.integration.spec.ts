/**
 * The tailored run lifecycle against a REAL Postgres (tailored-resume spec §6, §8): the start upsert's
 * refusals, the run-id compare-and-set, a failure keeping the published variant, and the sweep.
 * The bucket is an in-memory fake; every row write is real.
 *
 * NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run tailored-run.integration
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Logger } from '@nestjs/common'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_RESUME_CONTENT } from '@crm/shared'
import * as schema from '../database/schema'
import { jobOpportunities, tailoredResumes, users } from '../database/schema'
import { DatabaseService } from '../database/database.service'
import { hasDatabaseUrl } from '../test/require-real-db'
import { claimRun, failRun, ownsRun, startRun, toTailoredCode } from './tailored-run'
import { TailoredSweepCron } from './tailored-sweep.cron'

const SENIOR = '7a110031-0000-4000-bb00-000000000001'
const HR = '7a110031-0000-4000-bb00-000000000002'
const OPP = '7a110031-0000-4000-bb00-0000000000a1'
const MIN = 60_000

describe.skipIf(!hasDatabaseUrl())('tailored run lifecycle — real DB', () => {
  let pool: Pool
  let dbSvc: DatabaseService
  const s3 = {
    delete: vi.fn(async (_key: string) => undefined),
    deleteOrThrow: vi.fn(),
    headLastModified: vi.fn(),
    listObjects: vi.fn(),
  }
  const logger = new Logger('tailored-run.integration')
  const deps = () => ({ db: dbSvc.db, s3, logger })
  const start = (over: Partial<Parameters<typeof startRun>[1]> = {}) =>
    startRun(dbSvc.db, {
      opportunityId: OPP,
      seniorId: SENIOR,
      userId: HR,
      baseVersion: 3,
      overwrite: false,
      ...over,
    })
  const row = async () => {
    const [r] = await dbSvc.db
      .select()
      .from(tailoredResumes)
      .where(eq(tailoredResumes.jobOpportunityId, OPP))
    if (!r) throw new Error('no tailored row')
    return r
  }
  /** A published variant on the row, with no active run. */
  const publish = async () =>
    dbSvc.db
      .update(tailoredResumes)
      .set({
        content: EMPTY_RESUME_CONTENT,
        coverLetter: 'Dear team',
        pdfS3Key: 'tailored-resumes/x/run-old.pdf',
        pdfStatus: 'READY',
        runStatus: 'SUCCEEDED',
      })
      .where(eq(tailoredResumes.jobOpportunityId, OPP))

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, {
      pool,
      db: drizzle(pool, { schema }),
    })
    await dbSvc.db
      .insert(users)
      .values([
        {
          id: SENIOR,
          email: 'tailored-run-senior@test.spec',
          displayName: 'TR Senior',
          role: 'SENIOR',
        },
        { id: HR, email: 'tailored-run-hr@test.spec', displayName: 'TR HR', role: 'HR' },
      ])
      .onConflictDoNothing()
    await dbSvc.db
      .insert(jobOpportunities)
      .values({ id: OPP, title: 'TR role', titleKey: 'tr role' })
      .onConflictDoNothing()
  })

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
    s3.delete.mockClear()
    await dbSvc.db.delete(tailoredResumes).where(eq(tailoredResumes.jobOpportunityId, OPP))
  })

  afterAll(async () => {
    if (dbSvc === undefined) return
    await dbSvc.db.delete(jobOpportunities).where(eq(jobOpportunities.id, OPP))
    await dbSvc.db.delete(users).where(inArray(users.id, [SENIOR, HR]))
    await pool.end()
  })

  it('startRun creates a QUEUED row with runBaseVersion and the requester', async () => {
    const r = await start()
    expect(r.kind).toBe('STARTED')
    const saved = await row()
    expect(r).toEqual({ kind: 'STARTED', rowId: saved.id, runId: saved.runId })
    expect(saved).toMatchObject({
      runStatus: 'QUEUED',
      runBaseVersion: 3,
      runRequestedByUserId: HR,
      runStartedAt: null,
      content: null,
      pdfStatus: 'IDLE',
    })
    expect(saved.runQueuedAt).toBeInstanceOf(Date)
  })

  it('startRun twice while QUEUED → ACTIVE with the first runId; nothing is re-queued', async () => {
    const first = await start()
    const before = await row()
    const second = await start({ overwrite: true })
    expect(second).toEqual({ kind: 'ACTIVE', rowId: before.id, runId: before.runId })
    expect((await row()).runQueuedAt).toEqual(before.runQueuedAt)
    expect(first.kind).toBe('STARTED')
  })

  it('two concurrent startRun on an absent row: exactly one STARTED, the other ACTIVE on its runId', async () => {
    const results = await Promise.all([start(), start({ overwrite: true })])
    const started = results.filter((r) => r.kind === 'STARTED')
    const active = results.filter((r) => r.kind === 'ACTIVE')
    expect(started).toHaveLength(1)
    expect(active).toHaveLength(1)
    const saved = await row()
    expect(started[0]).toEqual({ kind: 'STARTED', rowId: saved.id, runId: saved.runId })
    expect(active[0]).toEqual({ kind: 'ACTIVE', rowId: saved.id, runId: saved.runId })
    expect(saved.runStatus).toBe('QUEUED')
  })

  it('startRun on a published row, overwrite=false → CONFLICT PUBLISHED, content unchanged', async () => {
    await start()
    await publish()
    const before = await row()
    expect(await start()).toEqual({ kind: 'CONFLICT', reason: 'PUBLISHED' })
    const after = await row()
    expect(after.content).toEqual(EMPTY_RESUME_CONTENT)
    expect(after.runStatus).toBe('SUCCEEDED')
    expect(after.runId).toBe(before.runId)
  })

  it('startRun on a published row, overwrite=true → a new run; the published variant stays', async () => {
    await start()
    await publish()
    const before = await row()
    const r = await start({ overwrite: true })
    expect(r.kind).toBe('STARTED')
    const after = await row()
    expect(after.runId).not.toBe(before.runId)
    expect(after).toMatchObject({
      runStatus: 'QUEUED',
      coverLetter: 'Dear team',
      pdfStatus: 'READY',
    })
    expect(after.pdfS3Key).toBe('tailored-resumes/x/run-old.pdf')
  })

  it('startRun while pdf_status RUNNING → CONFLICT RENDERING', async () => {
    await start()
    await publish()
    await dbSvc.db
      .update(tailoredResumes)
      .set({ pdfStatus: 'RUNNING', pdfRenderId: '7a110031-0000-4000-bb00-0000000000e1' })
      .where(eq(tailoredResumes.jobOpportunityId, OPP))
    expect(await start({ overwrite: true })).toEqual({ kind: 'CONFLICT', reason: 'RENDERING' })
  })

  it('claimRun moves QUEUED → RUNNING once; a stale or repeated claim → null', async () => {
    const r = await start()
    if (r.kind === 'CONFLICT') throw new Error('unexpected conflict')
    expect(await claimRun(dbSvc.db, r.rowId, '7a110031-0000-4000-bb00-0000000000f9')).toBeNull()
    const claimed = await claimRun(dbSvc.db, r.rowId, r.runId)
    expect(claimed).toMatchObject({ runStatus: 'RUNNING', runId: r.runId })
    expect(claimed?.runStartedAt).toBeInstanceOf(Date)
    expect(await claimRun(dbSvc.db, r.rowId, r.runId)).toBeNull()
    expect(await ownsRun(dbSvc.db, r.rowId, r.runId)).toBe(true)
  })

  it('toTailoredCode: GLYPH_CHECK_FAILED → itself, a VBR-only code → INTERNAL_ERROR', () => {
    expect(toTailoredCode('GLYPH_CHECK_FAILED')).toBe('GLYPH_CHECK_FAILED')
    expect(toTailoredCode('INCOMPLETE')).toBe('INTERNAL_ERROR')
  })

  it('failRun keeps content, cover_letter and pdf_s3_key; the run no longer owns the row', async () => {
    await start()
    await publish()
    const r = await start({ overwrite: true })
    if (r.kind !== 'STARTED') throw new Error('expected a new run')
    expect(await failRun(deps(), r.rowId, r.runId, 'RENDER_FAILED')).toBe(true)
    const after = await row()
    expect(after).toMatchObject({
      runStatus: 'FAILED',
      runErrorCode: 'RENDER_FAILED',
      runId: r.runId,
      content: EMPTY_RESUME_CONTENT,
      coverLetter: 'Dear team',
      pdfS3Key: 'tailored-resumes/x/run-old.pdf',
    })
    expect(s3.delete).toHaveBeenCalledExactlyOnceWith(
      `tailored-resumes/${r.rowId}/run-${r.runId}.pdf`,
    )
    expect(await ownsRun(dbSvc.db, r.rowId, r.runId)).toBe(false)
    expect(await failRun(deps(), r.rowId, r.runId, 'STALLED')).toBe(false)
  })

  it('sweepRuns fails a RUNNING run past 10 min with STALLED and keeps the published variant', async () => {
    await start()
    await publish()
    const r = await start({ overwrite: true })
    if (r.kind !== 'STARTED') throw new Error('expected a new run')
    await claimRun(dbSvc.db, r.rowId, r.runId)
    await dbSvc.db
      .update(tailoredResumes)
      .set({ runStartedAt: new Date(Date.now() - 11 * MIN) })
      .where(eq(tailoredResumes.id, r.rowId))
    const cron = new TailoredSweepCron(dbSvc, s3 as never)

    expect(await cron.reapRuns(new Date(), new Set())).toEqual({ runs: 1, renders: 0 })

    expect(await row()).toMatchObject({
      runStatus: 'FAILED',
      runErrorCode: 'STALLED',
      content: EMPTY_RESUME_CONTENT,
      coverLetter: 'Dear team',
      pdfS3Key: 'tailored-resumes/x/run-old.pdf',
    })
  })

  it('sweepRuns leaves a fresh RUNNING run alone', async () => {
    const r = await start()
    if (r.kind !== 'STARTED') throw new Error('expected a new run')
    await claimRun(dbSvc.db, r.rowId, r.runId)
    const cron = new TailoredSweepCron(dbSvc, s3 as never)
    expect(await cron.reapRuns(new Date(), new Set())).toEqual({ runs: 0, renders: 0 })
    expect((await row()).runStatus).toBe('RUNNING')
  })

  it('sweepRuns marks an edit render RUNNING past 2 min pdf_status FAILED, pdf_s3_key kept', async () => {
    await start()
    await publish()
    await dbSvc.db
      .update(tailoredResumes)
      .set({
        pdfStatus: 'RUNNING',
        pdfRenderId: '7a110031-0000-4000-bb00-0000000000e2',
        pdfRenderStartedAt: new Date(Date.now() - 3 * MIN),
      })
      .where(eq(tailoredResumes.jobOpportunityId, OPP))
    const cron = new TailoredSweepCron(dbSvc, s3 as never)

    expect(await cron.reapRuns(new Date(), new Set())).toEqual({ runs: 0, renders: 1 })

    expect(await row()).toMatchObject({
      pdfStatus: 'FAILED',
      pdfRenderError: 'STALLED',
      pdfRenderId: null,
      pdfS3Key: 'tailored-resumes/x/run-old.pdf',
      runStatus: 'SUCCEEDED',
    })
  })

  it('sweepOrphans deletes an unreferenced PDF older than 1 h and keeps the one a row publishes', async () => {
    await start()
    await publish()
    const old = new Date(Date.now() - 2 * 60 * MIN)
    const published = 'tailored-resumes/x/run-old.pdf'
    const orphan = 'tailored-resumes/x/run-orphan.pdf'
    const young = 'tailored-resumes/x/edit-young.pdf'
    const listed = new Map([
      [published, old],
      [orphan, old],
      [young, new Date(Date.now() - 59 * MIN)],
    ])
    const bucket = {
      ...s3,
      listObjects: vi.fn(async () => ({
        objects: [...listed].map(([key, lastModified]) => ({ key, sizeBytes: 1, lastModified })),
        nextContinuationToken: undefined,
      })),
      headLastModified: vi.fn(async (key: string) => listed.get(key) ?? null),
      deleteOrThrow: vi.fn(async (_key: string) => undefined),
    }
    const cron = new TailoredSweepCron(dbSvc, bucket as never)

    const r = await cron.deleteOrphans(new Date())

    expect(bucket.deleteOrThrow).toHaveBeenCalledExactlyOnceWith(orphan)
    expect(r).toMatchObject({ deleted: 1, referenced: 1, young: 1, complete: true })
  })
})
