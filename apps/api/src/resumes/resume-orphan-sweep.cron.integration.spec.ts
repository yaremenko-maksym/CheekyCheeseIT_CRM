/**
 * ResumeOrphanSweepCron — real DB integration (backlog item 441, Verify).
 *
 * The orphan is produced by the real code path: a senior replaces their resume source while the
 * superseded-source delete fails. The bucket is an in-memory fake (no live R2 in tests); the
 * referenced set is read from real Postgres, so every key column the sweep must honour is real.
 *
 *   DATABASE_URL=<scratch db> pnpm --filter @crm/api exec vitest run resume-orphan-sweep.cron.integration
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import { eq, inArray } from 'drizzle-orm'
import { Pool } from 'pg'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { EMPTY_RESUME_CONTENT, type SessionUser } from '@crm/shared'
import * as schema from '../database/schema'
import { seniorResumes, users } from '../database/schema'
import { DatabaseService } from '../database/database.service'
import { SeniorResumesService } from './resumes.service'
import { ResumeVerificationService } from './verification/resume-verification.service'
import { stagedPdfKey } from './verification/run-columns'
import { ResumeOrphanSweepCron } from './resume-orphan-sweep.cron'
import { buildDocx } from '../test/resume-fixtures'
import { hasDatabaseUrl } from '../test/require-real-db'

const SENIOR_ID = '7b3d91c4-2e5f-4a00-aa00-000000000441'
const SENIOR: SessionUser = {
  id: SENIOR_ID,
  email: 'orphan-sweep-senior@test.spec',
  role: 'SENIOR',
} as SessionUser
/** A senior cannot write their own resume; HR and ADMIN can. */
const ADMIN: SessionUser = {
  id: '7b3d91c4-2e5f-4a00-aa00-000000000442',
  email: 'orphan-sweep-admin@test.spec',
  role: 'ADMIN',
} as SessionUser
const HOUR = 60 * 60 * 1000

/** An in-memory bucket: key -> LastModified. */
class FakeBucket {
  readonly objects = new Map<string, Date>()
  failDeleteOf: string | null = null

  readonly upload = vi.fn(async (key: string) => {
    this.objects.set(key, new Date())
  })
  /** The service's swallowing delete; the stub throws for the superseded source. */
  readonly delete = vi.fn(async (key: string) => {
    if (key === this.failDeleteOf) throw new Error('R2 unavailable')
    this.objects.delete(key)
  })
  readonly deleteOrThrow = vi.fn(async (key: string) => {
    this.objects.delete(key)
  })
  readonly headLastModified = vi.fn(async (key: string) => this.objects.get(key) ?? null)
  readonly listObjects = vi.fn(async (_token: string | undefined, prefix: string) => ({
    objects: [...this.objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, lastModified]) => ({ key, sizeBytes: 1, lastModified })),
    nextContinuationToken: undefined,
  }))
  readonly getObject = vi.fn()
  readonly getPresignedDownloadUrl = vi.fn()
}

describe.skipIf(!hasDatabaseUrl())('ResumeOrphanSweepCron — real DB (backlog 441)', () => {
  let pool: Pool
  let dbSvc: DatabaseService
  let bucket: FakeBucket
  let service: SeniorResumesService

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    const db = drizzle(pool, { schema })
    dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, {
      pool,
      db,
    })
    bucket = new FakeBucket()
    const ai = {
      extractStructure: vi.fn().mockResolvedValue({
        ok: true,
        content: EMPTY_RESUME_CONTENT,
        tokensUsed: 1,
      }),
    }
    const typst = {
      fingerprint: vi.fn((input: unknown) =>
        createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      ),
      render: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.7 fake')),
    }
    const runner = { run: vi.fn().mockResolvedValue(undefined) }
    service = new SeniorResumesService(
      dbSvc,
      bucket as never,
      ai as never,
      new (await import('./resume-text-extraction.service')).ResumeTextExtractionService(),
      typst as never,
      new ResumeVerificationService(dbSvc, bucket as never, runner as never),
    )
    await db.delete(seniorResumes).where(eq(seniorResumes.userId, SENIOR_ID))
    await db
      .insert(users)
      .values(
        [SENIOR, ADMIN].map((u) => ({
          id: u.id,
          email: u.email,
          displayName: `Orphan Sweep ${u.role}`,
          role: u.role,
          googleId: `test-orphan-sweep-${u.id}`,
        })),
      )
      .onConflictDoNothing()
  }, 30_000)

  afterAll(async () => {
    try {
      await dbSvc.db.delete(seniorResumes).where(eq(seniorResumes.userId, SENIOR_ID))
      await dbSvc.db.delete(users).where(inArray(users.id, [SENIOR_ID, ADMIN.id]))
    } finally {
      await pool.end()
    }
  })

  /** Upload a source and let the detached extraction (and any render it queues) land. */
  async function upload(text: string): Promise<string> {
    await service.uploadSource(ADMIN, SENIOR_ID, {
      buffer: buildDocx([text]),
      mimetype: 'application/octet-stream',
      originalname: 'cv.docx',
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const [row] = await dbSvc.db
      .select({ key: seniorResumes.sourceS3Key })
      .from(seniorResumes)
      .where(eq(seniorResumes.userId, SENIOR_ID))
    return row!.key!
  }

  it('Verify: the source a failed superseded-source delete left is swept; referenced keys stay', async () => {
    const first = await upload('First CV, Senior engineer at Acme')
    bucket.failDeleteOf = first
    const second = await upload('Second CV, Senior engineer at Globex')

    // The failed delete really left the superseded source in the bucket, unreferenced.
    expect(second).not.toBe(first)
    expect(bucket.delete).toHaveBeenCalledWith(first)
    expect(bucket.objects.has(first)).toBe(true)
    // Only the two sources were stored: no detached render added a key to the bucket.
    expect(bucket.upload.mock.calls.map(([key]) => key)).toEqual([first, second])

    // A current PDF, a staged PDF and the staged result a run may restore, on the same row.
    const [row] = await dbSvc.db
      .select({ id: seniorResumes.id })
      .from(seniorResumes)
      .where(eq(seniorResumes.userId, SENIOR_ID))
    const pdf = `senior-resumes/${SENIOR_ID}/pdf/${row!.id}-0123456789abcdef.pdf`
    const staged = stagedPdfKey(row!.id, 'run-current')
    const previous = `senior-resumes/${SENIOR_ID}/previous-staged.pdf`
    await dbSvc.db
      .update(seniorResumes)
      .set({ pdfS3Key: pdf, stagedPdfS3Key: staged, stagedPrevious: { pdfKey: previous } })
      .where(eq(seniorResumes.id, row!.id))
    for (const key of [pdf, staged, previous]) bucket.objects.set(key, new Date())

    // Age everything past the grace, plus one fresh orphan that must survive.
    const now = new Date()
    for (const key of bucket.objects.keys()) {
      bucket.objects.set(key, new Date(now.getTime() - 48 * HOUR))
    }
    const fresh = `senior-resumes/${SENIOR_ID}/in-flight-upload`
    bucket.objects.set(fresh, new Date(now.getTime() - HOUR))

    const result = await new ResumeOrphanSweepCron(dbSvc, bucket as never).sweep(now)

    expect(bucket.deleteOrThrow.mock.calls).toEqual([[first]])
    expect(bucket.objects.has(first)).toBe(false)
    for (const key of [second, pdf, staged, previous, fresh]) {
      expect(bucket.objects.has(key)).toBe(true)
    }
    expect(result).toMatchObject({ deleted: 1, failed: 0, young: 1, complete: true })
  })
})
