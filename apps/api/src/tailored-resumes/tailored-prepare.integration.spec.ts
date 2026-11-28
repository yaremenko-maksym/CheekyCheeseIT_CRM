/**
 * The tailored prepare step against a REAL Postgres (tailored-resume spec: prepare): the base read
 * by the senior, the owner's contacts, the posting through `loadOpportunity`. The bucket and the
 * page counter are fakes; every row read is real.
 *
 * NEVER `crm_db`:
 *   DATABASE_URL=postgresql://crm_user:password@localhost:5432/<scratch> \
 *     pnpm --filter @crm/api exec vitest run tailored-prepare.integration
 */
import { createHash } from 'node:crypto'
import { EMPTY_RESUME_CONTENT, type ResumeContent } from '@crm/shared'
import { eq, inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseService } from '../database/database.service'
import * as schema from '../database/schema'
import { jobOpportunities, jobTextBlobs, seniorResumes, users } from '../database/schema'
import { hasDatabaseUrl } from '../test/require-real-db'
import { prepareTailoring } from './tailored-prepare'
import { TailoredRunFailure } from './tailored-run'

const SENIOR = '7a110051-0000-4000-bb00-000000000001'
const OPP_FULL = '7a110051-0000-4000-bb00-0000000000a1'
const OPP_BARE = '7a110051-0000-4000-bb00-0000000000a2'
const DESCRIPTION =
  'We use React and Kubernetes. Mail jobs@globex.example or call +380 67 123 4567. Ask Tara Prep.'
const SHA = createHash('sha256').update(DESCRIPTION).digest('hex')

const content: ResumeContent = {
  ...EMPTY_RESUME_CONTENT,
  summary: 'Tara Prep builds APIs.',
  skills: ['Postgres'],
  experience: [
    { company: 'Acme', role: 'Dev', period: '2020 - 2022', bullets: ['Shipped React dashboards'] },
  ],
}

describe.skipIf(!hasDatabaseUrl())('tailored prepare — real DB', () => {
  let pool: Pool
  let dbSvc: DatabaseService
  const pdf = Buffer.from('%PDF-base')
  const getObject = vi.fn(async (_key: string) => pdf)
  const countRenderedPages = vi.fn(async (_pdf: Buffer) => 2)
  const prepare = (opportunityId: string, runBaseVersion = 3) =>
    prepareTailoring(
      { db: dbSvc, s3: { getObject }, extraction: { countRenderedPages }, onDemandTypes: [] },
      { rowId: 'r', runId: 'u', opportunityId, seniorId: SENIOR, runBaseVersion },
    )
  const setBase = (over: Partial<typeof seniorResumes.$inferInsert>) =>
    dbSvc.db.update(seniorResumes).set(over).where(eq(seniorResumes.userId, SENIOR))

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env['DATABASE_URL'] })
    dbSvc = Object.assign(Object.create(DatabaseService.prototype) as DatabaseService, {
      pool,
      db: drizzle(pool, { schema }),
    })
    await dbSvc.db
      .insert(users)
      .values({
        id: SENIOR,
        email: 'tailored-prepare@test.spec',
        displayName: 'Tara Prep',
        role: 'SENIOR',
      })
      .onConflictDoNothing()
    await dbSvc.db
      .insert(jobTextBlobs)
      .values({ sha256: SHA, text: DESCRIPTION })
      .onConflictDoNothing()
    await dbSvc.db
      .insert(jobOpportunities)
      .values([
        {
          id: OPP_FULL,
          title: 'Senior Engineer',
          titleKey: 'senior engineer',
          employerName: 'Globex',
          stackKeywords: ['Postgres'],
          descriptionSha256: SHA,
        },
        {
          id: OPP_BARE,
          title: 'Platform Engineer',
          titleKey: 'platform engineer',
          stackKeywords: ['Go', 'Rust'],
        },
      ])
      .onConflictDoNothing()
  })

  beforeEach(async () => {
    getObject.mockClear()
    countRenderedPages.mockClear()
    await dbSvc.db.delete(seniorResumes).where(eq(seniorResumes.userId, SENIOR))
    await dbSvc.db.insert(seniorResumes).values({
      userId: SENIOR,
      content,
      version: 3,
      templateName: 'modern',
      pdfS3Key: 'resumes/tailored-prepare.pdf',
      verificationStatus: 'VERIFIED',
    })
  })

  afterAll(async () => {
    if (dbSvc === undefined) return
    await dbSvc.db.delete(seniorResumes).where(eq(seniorResumes.userId, SENIOR))
    await dbSvc.db
      .delete(jobOpportunities)
      .where(inArray(jobOpportunities.id, [OPP_FULL, OPP_BARE]))
    await dbSvc.db.delete(jobTextBlobs).where(eq(jobTextBlobs.sha256, SHA))
    await dbSvc.db.delete(users).where(eq(users.id, SENIOR))
    await pool.end()
  })

  it('prepare marks postingPartial on missing description', async () => {
    const r = await prepare(OPP_BARE)
    expect(r.posting).toEqual({
      title: 'Platform Engineer',
      employerName: '',
      text: 'Platform Engineer\nGo, Rust',
      partial: true,
      truncated: false,
    })
  })

  it('prepare strips an email and a phone from the posting', async () => {
    const r = await prepare(OPP_FULL)
    expect(r.posting.partial).toBe(false)
    expect(r.posting.text).toContain('We use React and Kubernetes.')
    expect(r.posting.text).not.toMatch(/jobs@globex|4567|Tara/)
    expect(r.requirements).toEqual([
      { name: 'Kubernetes', bucket: 'gap' },
      { name: 'React', bucket: 'supported' },
      { name: 'PostgreSQL', bucket: 'existing' },
    ])
  })

  it('prepare fails BASE_CHANGED when the base version moved after start', async () => {
    await setBase({ version: 4 })
    const e = await prepare(OPP_FULL).catch((err: unknown) => err)
    expect(e instanceof TailoredRunFailure && e.code).toBe('BASE_CHANGED')
    expect(getObject).not.toHaveBeenCalled()
  })

  it('a base no longer VERIFIED fails BASE_NOT_VERIFIED', async () => {
    await setBase({ verificationStatus: 'DRAFT' })
    const e = await prepare(OPP_FULL).catch((err: unknown) => err)
    expect(e instanceof TailoredRunFailure && e.code).toBe('BASE_NOT_VERIFIED')
  })

  it('prepare reads pdfPages from the base PDF, never renders', async () => {
    const r = await prepare(OPP_FULL)
    expect(getObject).toHaveBeenCalledWith('resumes/tailored-prepare.pdf')
    expect(countRenderedPages).toHaveBeenCalledWith(pdf)
    expect(r.base).toMatchObject({ version: 3, templateName: 'modern', pdfPages: 2, content })
  })

  it('payload headline is the redacted base summary', async () => {
    const r = await prepare(OPP_FULL)
    expect(JSON.parse(r.payload)).toMatchObject({ headline: '[REDACTED] builds APIs.' })
    expect(r.displayName).toBe('Tara Prep')
    expect(r.email).toBe('tailored-prepare@test.spec')
  })

  it('fitTailor on a resume over the worker budget trims the oldest items, sentItems < item count, and the trimmed items keep their base bullets', async () => {
    const bullets = Array.from({ length: 20 }, (_, i) => `${i} ${'x'.repeat(900)}`)
    const items = Array.from({ length: 5 }, (_, i) => ({
      company: `Co${i}`,
      role: 'Dev',
      period: '2020 - 2022',
      bullets,
    }))
    await setBase({ content: { ...content, experience: items } })
    const r = await prepare(OPP_FULL)
    expect(r.sentItems).toBeGreaterThan(0)
    expect(r.sentItems).toBeLessThan(5)
    expect(r.base.content.experience).toEqual(items)
  })
})
