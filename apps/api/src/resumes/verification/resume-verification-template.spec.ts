/**
 * Unit spec of the template run start and of `sweepStalledVerifications` (Task 16) over the recording
 * DB double: a look change on VERIFIED starts the runner with the run id it wrote; the sweep's
 * selection, the compare-and-set that repeats it, the two terminal shapes and the deletes after
 * commit. The same flows on a real Postgres are in resume-verification-template.integration.spec.ts.
 */
import { HttpException, Logger } from '@nestjs/common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RESUME_LAYOUT, RESUME_SECTION_ORDER } from '@crm/shared'
import type { SeniorResume } from '../../database/schema'
import { fakeRunDb } from '../../test/fake-run-db'
import { ResumeVerificationService } from './resume-verification.service'
import { CLEARED_STAGED, VERIFICATION_DEADLINE_MS } from './verification-runner'

const NOW = new Date('2026-11-11T12:00:00.000Z')
const CUTOFF = new Date(NOW.getTime() - VERIFICATION_DEADLINE_MS)
const STAGED_KEY = 'resumes/r-1/staged/run-0.pdf'

const s3 = { delete: vi.fn(async (_key: string) => {}) }
const runner = { run: vi.fn(async (_id: string, _runId: string) => {}) }
let logs: string[]

function sweep(results: unknown[][]) {
  const db = fakeRunDb(results)
  const service = new ResumeVerificationService(db.service, s3 as never, runner as never)
  return { swept: () => service.sweepStalledVerifications(NOW), log: db.log }
}

const CLEARED = {
  verificationErrorCode: 'STALLED',
  verificationReport: { gates: [], fallbacks: [] },
  verificationRunId: null,
  verificationKind: null,
  verificationTargetPath: null,
  verificationBaseVersion: null,
  ...CLEARED_STAGED,
}

beforeEach(() => {
  vi.clearAllMocks()
  logs = []
  vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
    logs.push(String(message))
  })
})
afterEach(() => vi.restoreAllMocks())

describe('sweepStalledVerifications', () => {
  it('selects run rows of QUEUED, CHECKING or VERIFIED queued before now minus the deadline', async () => {
    const { swept, log } = sweep([[]])
    expect(await swept()).toBe(0)
    expect(log).toHaveLength(1)
    const [select] = log
    expect(select?.columns).toEqual(['id', 'runId', 'status'])
    expect(select?.where?.sql).toBe(
      '("senior_resumes"."verification_run_id" is not null and "senior_resumes"."verification_queued_at" < $1 and "senior_resumes"."verification_status" in ($2, $3, $4))',
    )
    expect(select?.where?.params).toEqual([CUTOFF.toISOString(), 'QUEUED', 'CHECKING', 'VERIFIED'])
  })

  it('CHECKING → FAILED STALLED under a CAS repeating the selection; staged and derived keys go', async () => {
    const { swept, log } = sweep([
      [{ id: 'r-1', runId: 'run-1', status: 'CHECKING' }],
      [{ key: STAGED_KEY }],
      [{ id: 'r-1' }],
    ])
    expect(await swept()).toBe(1)
    const [, lock, update] = log
    expect([lock?.locked, lock?.inTransaction, lock?.columns]).toEqual([true, true, ['key']])
    expect(lock?.where?.params).toEqual(['r-1'])
    expect(update?.inTransaction).toBe(true)
    expect(update?.set).toEqual({ verificationStatus: 'FAILED', ...CLEARED })
    expect(update?.where?.params).toEqual([
      'r-1',
      CUTOFF.toISOString(),
      'QUEUED',
      'CHECKING',
      'VERIFIED',
      'CHECKING',
      'run-1',
    ])
    expect(update?.where?.sql).toContain('"verification_run_id" is not null')
    expect(s3.delete.mock.calls).toEqual([[STAGED_KEY], ['resumes/r-1/staged/run-1.pdf']])
    expect(logs).toEqual(['Verification run run-1 of resume r-1 swept: STALLED'])
  })

  it('a stalled template run on VERIFIED: the status is not written, the derived key goes', async () => {
    const { swept, log } = sweep([
      [{ id: 'r-2', runId: 'run-2', status: 'VERIFIED' }],
      [{ key: null }],
      [{ id: 'r-2' }],
    ])
    expect(await swept()).toBe(1)
    expect(log.at(-1)?.set).toEqual(CLEARED)
    expect(log.at(-1)?.where?.params?.slice(-2)).toEqual(['VERIFIED', 'run-2'])
    expect(s3.delete.mock.calls).toEqual([['resumes/r-2/staged/run-2.pdf']])
  })

  it('a staged key equal to the derived one is deleted once; a lost CAS deletes and counts nothing', async () => {
    const { swept } = sweep([
      [
        { id: 'r-1', runId: 'run-1', status: 'QUEUED' },
        { id: 'r-3', runId: 'run-3', status: 'CHECKING' },
      ],
      [{ key: 'resumes/r-1/staged/run-1.pdf' }],
      [{ id: 'r-1' }],
      [{ key: STAGED_KEY }],
      [],
    ])
    expect(await swept()).toBe(1)
    expect(s3.delete.mock.calls).toEqual([['resumes/r-1/staged/run-1.pdf']])
    expect(logs).toHaveLength(1)
  })

  it('a won CAS over a row whose lock read found nothing still deletes the derived key', async () => {
    const { swept } = sweep([
      [{ id: 'r-1', runId: 'run-1', status: 'QUEUED' }],
      [],
      [{ id: 'r-1' }],
    ])
    expect(await swept()).toBe(1)
    expect(s3.delete.mock.calls).toEqual([['resumes/r-1/staged/run-1.pdf']])
  })
})

describe('a look change on VERIFIED starts a template run (Task 16)', () => {
  const LAYOUT = { ...DEFAULT_RESUME_LAYOUT, sectionOrder: [...RESUME_SECTION_ORDER] }
  const ROW = {
    id: 'r-1',
    templateName: 'classic',
    layout: LAYOUT,
    stagedPdfS3Key: null,
    verificationStatus: 'VERIFIED',
    verificationRunId: null,
  } as unknown as SeniorResume

  function service(results: unknown[][]) {
    const db = fakeRunDb(results)
    return {
      svc: new ResumeVerificationService(db.service, s3 as never, runner as never),
      log: db.log,
    }
  }

  it('template: the start UPDATE stages the requested template and the live layout, then the runner runs it', async () => {
    const { svc, log } = service([[{ id: 'r-1' }]])
    await svc.setTemplate(ROW, 'modern', 'viewer-1')
    const set = log[0]?.set ?? {}
    expect(set).toMatchObject({
      verificationKind: 'template',
      verificationStartedAt: null,
      verificationErrorCode: null,
      verificationReport: null,
      stagedLayout: LAYOUT,
      stagedTemplateName: 'modern',
      updatedByUserId: 'viewer-1',
    })
    expect(set).not.toHaveProperty('templateName')
    expect(set).not.toHaveProperty('layout')
    expect(set['verificationQueuedAt']).toBeInstanceOf(Date)
    expect(typeof set['verificationRunId']).toBe('string')
    expect(runner.run.mock.calls).toEqual([['r-1', set['verificationRunId']]])
  })

  it('layout: the requested layout and the live template are staged', async () => {
    const { svc, log } = service([[{ id: 'r-1' }]])
    const relaxed = { ...LAYOUT, density: 'relaxed' as const }
    await svc.setLayout(ROW, relaxed, 'viewer-1')
    expect(log[0]?.set).toMatchObject({ stagedLayout: relaxed, stagedTemplateName: 'classic' })
    expect(runner.run).toHaveBeenCalledTimes(1)
  })

  it('a start UPDATE that misses (409), or a look change off VERIFIED, runs nothing', async () => {
    const miss = service([[], [{ id: 'r-1' }]])
    const err = await miss.svc.setTemplate(ROW, 'modern', 'v').catch((e: unknown) => e)
    expect((err as HttpException).getStatus()).toBe(409)
    const draft = service([[{ id: 'r-1' }]])
    await draft.svc.setTemplate({ ...ROW, verificationStatus: 'DRAFT' }, 'modern', 'v')
    expect(draft.log[0]?.set).toMatchObject({ templateName: 'modern' })
    expect(runner.run).not.toHaveBeenCalled()
  })
})
