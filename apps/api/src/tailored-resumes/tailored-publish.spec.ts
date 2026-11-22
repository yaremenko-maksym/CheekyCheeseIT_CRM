/**
 * `publishRun` against the recording Drizzle double: the CAS predicate, the locks, the published
 * columns and the order of the object writes. The real SQL is pinned by the integration spec.
 */
import { Logger } from '@nestjs/common'
import { DEFAULT_RESUME_LAYOUT, EMPTY_RESUME_CONTENT } from '@crm/shared'
import { describe, expect, it, vi } from 'vitest'
import { fakeRunDb } from '../test/fake-run-db'
import { publishRun, type RunResult } from './tailored-publish'
import { TAILORED_RUN_DEADLINE_MS } from './tailored-run'

const NOW = new Date('2026-11-22T12:00:00.000Z')
const RESULT: RunResult = {
  accepted: {
    pdf: Buffer.from('%PDF'),
    content: EMPTY_RESUME_CONTENT,
    layout: DEFAULT_RESUME_LAYOUT,
    gates: [],
    fallbacks: [],
  },
  coverLetter: 'Dear Hiring Team,\n\nBody.\n\nKind regards,\nJane Doe',
  verification: {
    gates: [],
    revertedPaths: [],
    keptFromBase: 0,
    coverage: { matched: [], total: 0 },
    gaps: [],
    injectionSuspected: false,
    postingPartial: false,
    postingTruncated: false,
    routes: [],
  },
  baseResumeId: 'base-1',
  baseVersion: 3,
  opportunityRevision: 7,
  templateName: 'classic',
}
const VERIFIED = { status: 'VERIFIED', version: 3, verifiedVersion: 3 }

function setup(results: unknown[][]) {
  const fake = fakeRunDb(results)
  const calls: string[] = []
  const s3 = {
    upload: vi.fn(async (key: string) => {
      calls.push(`upload ${key}`)
    }),
    delete: vi.fn(async (key: string) => {
      calls.push(`delete ${key}`)
    }),
  }
  const logger = { warn: vi.fn() } as unknown as Logger
  const db = (fake.service as { db: never }).db
  const publish = () =>
    publishRun(
      { db, s3, logger, now: () => NOW },
      { rowId: 'row-1', runId: 'run-1', runBaseVersion: 3, result: RESULT },
    )
  return { ...fake, s3, calls, logger, publish }
}

describe('publishRun', () => {
  it('uploads the run key first, then CAS-locks RUNNING within the deadline', async () => {
    const t = setup([[{ pdfS3Key: null, requestedBy: 'hr-1' }], [VERIFIED], []])
    expect(await t.publish()).toBe('PUBLISHED')
    expect(t.calls[0]).toBe('upload tailored-resumes/row-1/run-run-1.pdf')
    expect(t.s3.upload).toHaveBeenCalledWith(
      'tailored-resumes/row-1/run-run-1.pdf',
      RESULT.accepted.pdf,
      'application/pdf',
      'RESUME',
    )
    const [lock, base] = t.log
    expect(lock).toMatchObject({ op: 'select', lock: 'update', inTransaction: true })
    expect(lock?.where?.sql).toContain('"run_status" = $3')
    expect(lock?.where?.sql).toContain('"run_started_at" >= $4')
    expect(lock?.where?.params).toEqual([
      'row-1',
      'run-1',
      'RUNNING',
      new Date(NOW.getTime() - TAILORED_RUN_DEADLINE_MS).toISOString(),
    ])
    expect(base).toMatchObject({ op: 'select', lock: 'share', inTransaction: true })
    expect(base?.where?.params).toEqual(['base-1'])
  })

  it('writes every published column, a fresh render id and the requester as generator', async () => {
    const t = setup([[{ pdfS3Key: null, requestedBy: 'hr-1' }], [VERIFIED], []])
    await t.publish()
    const write = t.log[2]
    expect(write?.where?.params).toEqual(['row-1'])
    expect(write?.set).toMatchObject({
      baseResumeId: 'base-1',
      baseVersion: 3,
      opportunityRevision: 7,
      content: RESULT.accepted.content,
      coverLetter: RESULT.coverLetter,
      layout: RESULT.accepted.layout,
      templateName: 'classic',
      verification: RESULT.verification,
      runStatus: 'SUCCEEDED',
      runStage: null,
      runErrorCode: null,
      pdfStatus: 'READY',
      pdfRenderStartedAt: null,
      pdfRenderError: null,
      pdfS3Key: 'tailored-resumes/row-1/run-run-1.pdf',
      generatedByUserId: 'hr-1',
      generatedAt: NOW,
      editedByUserId: null,
      editedAt: null,
      updatedAt: NOW,
    })
    expect(write?.set?.['pdfRenderId']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('deletes the previous PDF after the commit, never before', async () => {
    const t = setup([
      [{ pdfS3Key: 'tailored-resumes/row-1/run-old.pdf', requestedBy: 'hr-1' }],
      [VERIFIED],
      [],
    ])
    await t.publish()
    expect(t.calls).toEqual([
      'upload tailored-resumes/row-1/run-run-1.pdf',
      'delete tailored-resumes/row-1/run-old.pdf',
    ])
  })

  it('no previous PDF → nothing deleted', async () => {
    const t = setup([[{ pdfS3Key: null, requestedBy: null }], [VERIFIED], []])
    await t.publish()
    expect(t.s3.delete).not.toHaveBeenCalled()
  })

  it('no row under the CAS → LOST, own object deleted, nothing written', async () => {
    const t = setup([[]])
    expect(await t.publish()).toBe('LOST')
    expect(t.log).toHaveLength(1)
    expect(t.s3.delete).toHaveBeenCalledWith('tailored-resumes/row-1/run-run-1.pdf')
    expect(vi.mocked(t.logger.warn).mock.calls[0]?.[0]).toContain('"outcome":"LOST"')
  })

  it.each([
    ['moved version', { ...VERIFIED, version: 4, verifiedVersion: 4 }],
    ['verified_version ≠ runBaseVersion', { ...VERIFIED, verifiedVersion: 2 }],
    ['version ≠ runBaseVersion', { ...VERIFIED, version: 2 }],
    ['not VERIFIED', { ...VERIFIED, status: 'PENDING' }],
  ])('%s → BASE_CHANGED: run FAILED, nothing published, own object deleted', async (_n, base) => {
    const t = setup([
      [{ pdfS3Key: 'tailored-resumes/row-1/run-old.pdf', requestedBy: 'hr-1' }],
      [base],
      [],
    ])
    expect(await t.publish()).toBe('BASE_CHANGED')
    expect(t.log[2]).toMatchObject({
      op: 'update',
      inTransaction: true,
      set: { runStatus: 'FAILED', runErrorCode: 'BASE_CHANGED', runStage: null, updatedAt: NOW },
    })
    expect(t.log[2]?.where?.params).toEqual(['row-1'])
    expect(t.log).toHaveLength(3)
    expect(t.calls.at(-1)).toBe('delete tailored-resumes/row-1/run-run-1.pdf')
    expect(t.s3.delete).toHaveBeenCalledTimes(1)
  })

  it('a missing base row → BASE_CHANGED', async () => {
    const t = setup([[{ pdfS3Key: null, requestedBy: null }], [], []])
    expect(await t.publish()).toBe('BASE_CHANGED')
  })
})
