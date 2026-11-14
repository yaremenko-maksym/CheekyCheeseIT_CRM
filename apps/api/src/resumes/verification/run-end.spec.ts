/** Unit spec of the run-ownership read (CD-3) and the FAILED write (FR-A-2) over the recording DB double. */
import type { Logger } from '@nestjs/common'
import { describe, expect, it, vi } from 'vitest'
import { fakeRunDb } from '../../test/fake-run-db'
import { CLEARED_STAGED, stagedPdfKey } from './run-columns'
import { failRun, ownsRun } from './run-end'

describe('ownsRun', () => {
  it('reads the row by its id and this run id', async () => {
    const db = fakeRunDb([[{ id: 'r-1' }]])
    await expect(ownsRun(db.service, 'r-1', 'run-1')).resolves.toBe(true)
    expect(db.log).toHaveLength(1)
    expect(db.log[0]?.op).toBe('select')
    expect(db.log[0]?.columns).toEqual(['id'])
    expect(db.log[0]?.where?.params).toEqual(['r-1', 'run-1'])
    expect(db.log[0]?.where?.sql).toContain('"verification_run_id" = $2')
  })

  it('a row gone, swept or owned by another run is no longer owned', async () => {
    await expect(ownsRun(fakeRunDb([[]]).service, 'r-1', 'run-1')).resolves.toBe(false)
  })
})

describe('failRun keeps the previous staged result on an infra failure (FR-A-2)', () => {
  const RESUME = 'r-1'
  const RUN = 'run-2'
  const KEPT_KEY = 'resumes/r-1/staged/run-1.pdf'
  const SECRET = 'Hand written summary with jane@unit.spec'
  const REPORT = { gates: [], fallbacks: ['summary'], ownerKey: 'k-1' }
  const SNAPSHOT = {
    content: { summary: SECRET },
    layout: { density: 'compact' },
    templateName: 'modern',
    pdfKey: KEPT_KEY,
    editedPaths: [{ path: 'summary', userId: 'hr-1' }],
    runId: 'run-1',
    kind: 'full',
    targetPath: null,
    baseVersion: 7,
    report: REPORT,
  }
  const FAILED_REPORT = { gates: [], fallbacks: [] }

  function setup(kind: string, previous: unknown) {
    const db = fakeRunDb([
      [{ key: KEPT_KEY, kind, live: 'resumes/r-1/live.pdf', report: REPORT, previous }],
      [{ id: RESUME }],
    ])
    const s3 = { delete: vi.fn(async (_key: string) => {}) }
    const logger = { warn: vi.fn() }
    const deps = { db: db.service, s3, logger: logger as unknown as Logger }
    return { deps, s3, logger, log: db.log }
  }

  it.each(['staged-edit', 'item'])(
    '%s run, WRITER_UNAVAILABLE: back to AWAITING_CONFIRM on the snapshot, only its own upload deleted',
    async (kind) => {
      const { deps, s3, log } = setup(kind, SNAPSHOT)
      await failRun(deps, RESUME, RUN, 'WRITER_UNAVAILABLE', FAILED_REPORT)
      expect(log[0]?.columns).toEqual(['key', 'kind', 'live', 'report', 'previous'])
      expect(log[1]?.where?.params).toEqual([RESUME, RUN])
      expect(log[1]?.set).toEqual({
        verificationStatus: 'AWAITING_CONFIRM',
        verificationErrorCode: 'WRITER_UNAVAILABLE',
        verificationReport: REPORT,
        verificationRunId: 'run-1',
        verificationKind: 'full',
        verificationTargetPath: null,
        verificationBaseVersion: 7,
        stagedContent: SNAPSHOT.content,
        stagedLayout: SNAPSHOT.layout,
        stagedTemplateName: 'modern',
        stagedPdfS3Key: KEPT_KEY,
        stagedEditedPaths: SNAPSHOT.editedPaths,
        stagedPrevious: null,
      })
      expect(s3.delete.mock.calls).toEqual([[stagedPdfKey(RESUME, RUN)]])
    },
  )

  it.each(['VISUAL_CHECK_UNAVAILABLE', 'ENTAILMENT_UNAVAILABLE', 'STALLED'] as const)(
    'every infra code keeps the snapshot: %s',
    async (code) => {
      const { deps, log } = setup('item', SNAPSHOT)
      await failRun(deps, RESUME, RUN, code, FAILED_REPORT)
      expect(log[1]?.set).toMatchObject({
        verificationStatus: 'AWAITING_CONFIRM',
        verificationErrorCode: code,
        stagedPdfS3Key: KEPT_KEY,
      })
    },
  )

  it('a gate failure of a staged run still clears the staged state', async () => {
    const { deps, s3, log } = setup('staged-edit', SNAPSHOT)
    await failRun(deps, RESUME, RUN, 'RENDER_FAILED', FAILED_REPORT)
    expect(log[1]?.set).toEqual({
      verificationStatus: 'FAILED',
      verificationErrorCode: 'RENDER_FAILED',
      verificationReport: FAILED_REPORT,
      verificationRunId: null,
      verificationKind: null,
      verificationTargetPath: null,
      verificationBaseVersion: null,
      ...CLEARED_STAGED,
    })
    expect(CLEARED_STAGED).toMatchObject({ stagedPrevious: null })
    expect(s3.delete.mock.calls).toEqual([[KEPT_KEY]])
  })

  it('a full run on an infra code is FAILED, even beside a stale snapshot', async () => {
    const { deps, log } = setup('full', SNAPSHOT)
    await failRun(deps, RESUME, RUN, 'WRITER_UNAVAILABLE', FAILED_REPORT)
    expect(log[1]?.set).toMatchObject({ verificationStatus: 'FAILED', ...CLEARED_STAGED })
  })

  it('a staged run without a readable snapshot is FAILED', async () => {
    const { deps, log } = setup('item', { runId: 'run-1' })
    await failRun(deps, RESUME, RUN, 'WRITER_UNAVAILABLE', FAILED_REPORT)
    expect(log[1]?.set).toMatchObject({ verificationStatus: 'FAILED', ...CLEARED_STAGED })
  })

  it('one structured warn line: ids, kind, code, provider and cause; no resume text', async () => {
    const { deps, logger } = setup('staged-edit', SNAPSHOT)
    await failRun(deps, RESUME, RUN, 'WRITER_UNAVAILABLE', FAILED_REPORT, {
      provider: 'extraction-worker:/resume-write',
      reason: 'PROVIDER_ERROR',
      status: 503,
    })
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const line = String(logger.warn.mock.calls[0]?.[0])
    expect(JSON.parse(line)).toEqual({
      event: 'resume_verification_run_failed',
      runId: RUN,
      resumeId: RESUME,
      kind: 'staged-edit',
      code: 'WRITER_UNAVAILABLE',
      provider: 'extraction-worker:/resume-write',
      cause: 'PROVIDER_ERROR',
      status: 503,
      kept: true,
    })
    expect(line).not.toContain('jane@unit.spec')
    expect(line).not.toContain('Hand written')
  })

  it('a failure with no origin logs a null provider and cause', async () => {
    const { deps, logger } = setup('full', null)
    await failRun(deps, RESUME, RUN, 'RENDER_FAILED', FAILED_REPORT)
    expect(JSON.parse(String(logger.warn.mock.calls[0]?.[0]))).toMatchObject({
      kind: 'full',
      provider: null,
      cause: null,
      status: null,
      kept: false,
    })
  })
})
