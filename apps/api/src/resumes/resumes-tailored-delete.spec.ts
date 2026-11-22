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

vi.mock('../job-sourcing/dirty-producers', () => ({
  markSeniorResumeDirty: vi.fn(async () => true),
}))

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

/** `busy`: the fast-path read sees an active row; `locked`: what the in-transaction lock returns. */
function build(busy: boolean, locked: Record<string, unknown>[] = []) {
  const log: string[] = []
  const queries: { sql: string; params: unknown[] }[] = []
  const execute = (where: string) =>
    vi.fn(async (q: SQL) => {
      const { sql, params } = dialect.sqlToQuery(q)
      queries.push({ sql, params })
      log.push(`${where}:execute`)
      return { rows: where === 'db' ? (busy ? [{ id: 't-1' }] : []) : locked }
    })
  const remove = vi.fn(() => {
    log.push('tx:delete')
    return { where: () => ({ returning: async () => [{ id: 'r-1' }] }) }
  })
  const s3 = {
    delete: vi.fn(async (key: string) => void log.push(`s3:${key}`)),
    listObjects: vi.fn(async () => ({ objects: [], nextContinuationToken: undefined })),
  }
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

const IDLE_LOCKED = [
  { id: 't-1', run_status: 'SUCCEEDED', pdf_status: 'READY', pdf_s3_key: 'tailored/t-1.pdf' },
  { id: 't-2', run_status: 'FAILED', pdf_status: null, pdf_s3_key: null },
  { id: 't-3', run_status: 'SUCCEEDED', pdf_status: 'FAILED', pdf_s3_key: 'tailored/t-3.pdf' },
]

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

  it.each([
    ['a run QUEUED', { run_status: 'QUEUED', pdf_status: null }],
    ['a run RUNNING', { run_status: 'RUNNING', pdf_status: 'READY' }],
    ['a render QUEUED', { run_status: 'SUCCEEDED', pdf_status: 'QUEUED' }],
    ['a render RUNNING', { run_status: 'SUCCEEDED', pdf_status: 'RUNNING' }],
  ])(
    '%s that starts after the fast-path read: the lock sees it, 409, no row and no object deleted (SR-M-2)',
    async (_l, status) => {
      const { svc, s3, log } = build(false, [
        ...IDLE_LOCKED,
        { id: 't-4', pdf_s3_key: 'tailored/t-4.pdf', ...status },
      ])
      const err = await refusal(svc.deleteResume(hr, OWNER_ID))
      expect((err as HttpException).getStatus()).toBe(409)
      expect((err as HttpException).getResponse()).toMatchObject({ code: 'RESUME_DELETE_BUSY' })
      expect(log).toEqual(['db:execute', 'tx:execute'])
      expect(s3.delete).not.toHaveBeenCalled()
    },
  )

  it('idle: the transaction locks the tailored rows before the delete; the base objects go before the row (R-INT-12g), the tailored PDFs after the commit', async () => {
    const { svc, s3, log, queries } = build(false, IDLE_LOCKED)
    expect(await svc.deleteResume(hr, OWNER_ID)).toMatchObject({ resume: null })
    expect(log).toEqual([
      'db:execute',
      'tx:execute',
      's3:src',
      's3:live.pdf',
      'tx:delete',
      's3:tailored/t-1.pdf',
      's3:tailored/t-3.pdf',
    ])
    expect(s3.delete.mock.calls.map((c) => c[0])).toEqual([
      'src',
      'live.pdf',
      'tailored/t-1.pdf',
      'tailored/t-3.pdf',
    ])
    const lock = queries[1] as { sql: string; params: unknown[] }
    expect(lock.sql).toContain('FROM tailored_resumes')
    expect(lock.sql).toContain('senior_user_id = $1')
    expect(lock.sql).toContain('ORDER BY id FOR UPDATE')
    expect(lock.sql).toContain('pdf_s3_key')
    expect(lock.params).toEqual([OWNER_ID])
  })

  it('a delete that fails in the transaction deletes no object at all', async () => {
    const { svc, s3, db } = build(false, IDLE_LOCKED)
    db.db.transaction.mockRejectedValueOnce(new Error('connection lost'))
    await expect(svc.deleteResume(hr, OWNER_ID)).rejects.toThrow('connection lost')
    expect(s3.delete).not.toHaveBeenCalled()
  })
})
