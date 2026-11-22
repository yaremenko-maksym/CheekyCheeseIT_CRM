/**
 * C3: the base resume cannot be deleted while a tailored run or a tailored render of that senior
 * is active (QUEUED or RUNNING), and the delete transaction locks the senior's tailored rows
 * before it removes the base: the base FK cascades into them, and publish locks the tailored row
 * first, then the base. The run and render filters themselves are proven against Postgres in
 * resumes-tailored-delete.integration.spec.ts.
 */
import { HttpException } from '@nestjs/common'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it, vi } from 'vitest'
import type { SessionUser } from '@crm/shared'
import { SeniorResumesService } from './resumes.service'

const dialect = new PgDialect()
const OWNER_ID = 'c3c30000-0000-4000-8000-0000000000a1'
const HR_ID = 'c3c30000-0000-4000-8000-0000000000b1'
const OWNER = { id: OWNER_ID, role: 'SENIOR', displayName: 'Jane Doe', email: 'jane@unit.spec' }
const ROW = {
  id: 'r-1',
  userId: OWNER_ID,
  sourceS3Key: 'src',
  pdfS3Key: 'live.pdf',
  stagedPdfS3Key: null,
  verificationStatus: 'VERIFIED',
  verificationRunId: null,
}
const hr = { id: HR_ID, role: 'HR' } as SessionUser

function build(busy: boolean) {
  const log: string[] = []
  const queries: { sql: string; params: unknown[] }[] = []
  const execute = (where: string) =>
    vi.fn(async (q: SQL) => {
      const { sql, params } = dialect.sqlToQuery(q)
      queries.push({ sql, params })
      log.push(`${where}:execute`)
      return { rows: busy && where === 'db' ? [{ id: 't-1' }] : [] }
    })
  const remove = vi.fn(() => {
    log.push('tx:delete')
    throw new Error('row delete reached')
  })
  const s3 = { delete: vi.fn(async () => undefined) }
  const db = {
    db: {
      query: {
        users: { findFirst: vi.fn(async () => OWNER) },
        seniorResumes: { findFirst: vi.fn(async () => ROW) },
      },
      execute: execute('db'),
      transaction: vi.fn((work: (tx: unknown) => Promise<unknown>) =>
        work({ execute: execute('tx'), delete: remove }),
      ),
    },
  }
  const svc = new SeniorResumesService(
    db as never,
    s3 as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
  return { svc, db, s3, log, queries }
}

const refusal = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  )

describe('SeniorResumesService.deleteResume — tailored activity (C3)', () => {
  it('an active tailored run or render: 409 RESUME_DELETE_BUSY, no object and no row deleted', async () => {
    const { svc, db, s3, queries } = build(true)
    const err = await refusal(svc.deleteResume(hr, OWNER_ID))
    expect(err).toBeInstanceOf(HttpException)
    expect((err as HttpException).getStatus()).toBe(409)
    expect((err as HttpException).getResponse()).toMatchObject({ code: 'RESUME_DELETE_BUSY' })
    expect(s3.delete).not.toHaveBeenCalled()
    expect(db.db.transaction).not.toHaveBeenCalled()
    const probe = queries[0] as { sql: string; params: unknown[] }
    expect(probe.sql).toContain('FROM tailored_resumes')
    expect(probe.sql).toContain('senior_user_id = $1')
    expect(probe.sql).toContain(`run_status IN ('QUEUED', 'RUNNING')`)
    expect(probe.sql).toContain(`pdf_status IN ('QUEUED', 'RUNNING')`)
    expect(probe.params).toEqual([OWNER_ID])
  })

  it('idle: the objects go, and the transaction locks the tailored rows before the delete', async () => {
    const { svc, s3, log, queries } = build(false)
    const err = await refusal(svc.deleteResume(hr, OWNER_ID))
    expect((err as Error).message).toBe('row delete reached')
    expect(s3.delete.mock.calls.map((c) => c[0])).toEqual(['src', 'live.pdf'])
    expect(log).toEqual(['db:execute', 'tx:execute', 'tx:delete'])
    const lock = queries[1] as { sql: string; params: unknown[] }
    expect(lock.sql).toContain('FROM tailored_resumes')
    expect(lock.sql).toContain('senior_user_id = $1')
    expect(lock.sql).toContain('FOR UPDATE')
    expect(lock.params).toEqual([OWNER_ID])
  })
})
