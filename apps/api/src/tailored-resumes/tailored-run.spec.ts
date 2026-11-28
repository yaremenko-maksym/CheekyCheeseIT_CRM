import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { fakeRunDb as fakeRunService } from '../test/fake-run-db'
import {
  ACTIVE_RUN_STATUSES,
  failRun,
  isRenderStalled,
  isStalled,
  TAILORED_RENDER_DEADLINE_MS,
  TAILORED_RUN_DEADLINE_MS,
  ownsRun,
  setStage,
  startRun,
  TailoredRunFailure,
  type TailoredRunOrigin,
  toTailoredCode,
} from './tailored-run'

const NOW = new Date('2026-11-21T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)
const MIN = 60_000
const NONE: ReadonlySet<string> = new Set()

type RunRow = Parameters<typeof isStalled>[0]
const run = (over: Partial<RunRow>): RunRow => ({
  runStatus: 'RUNNING',
  runId: 'run-1',
  runQueuedAt: ago(30 * MIN),
  runStartedAt: ago(30 * MIN),
  ...over,
})

describe('deadlines', () => {
  it('a run has 10 min, an edit re-render 2 min', () => {
    expect(TAILORED_RUN_DEADLINE_MS).toBe(600_000)
    expect(TAILORED_RENDER_DEADLINE_MS).toBe(120_000)
  })
})

describe('isStalled', () => {
  it('RUNNING started 10 min + 1 ms ago → true; exactly 10 min or 10 min − 1 ms → false', () => {
    expect(isStalled(run({ runStartedAt: ago(10 * MIN + 1) }), NOW, NONE)).toBe(true)
    expect(isStalled(run({ runStartedAt: ago(10 * MIN) }), NOW, NONE)).toBe(false)
    expect(isStalled(run({ runStartedAt: ago(10 * MIN - 1) }), NOW, NONE)).toBe(false)
  })

  it('the clock starts at the claim: queued long ago, claimed just now → false', () => {
    expect(isStalled(run({ runQueuedAt: ago(60 * MIN), runStartedAt: ago(MIN) }), NOW, NONE)).toBe(
      false,
    )
  })

  it('an unclaimed QUEUED run is measured from the queue', () => {
    const queued = (at: Date) => run({ runStatus: 'QUEUED', runQueuedAt: at, runStartedAt: null })
    expect(isStalled(queued(ago(10 * MIN + 1)), NOW, NONE)).toBe(true)
    expect(isStalled(queued(ago(10 * MIN - 1)), NOW, NONE)).toBe(false)
  })

  it('a run with no clock at all is stalled: nothing else would ever end it', () => {
    expect(isStalled(run({ runQueuedAt: null, runStartedAt: null }), NOW, NONE)).toBe(true)
  })

  it('a QUEUED run past the deadline but waiting for a slot in this process → false', () => {
    const queued = run({ runStatus: 'QUEUED', runStartedAt: null, runId: 'run-w' })
    expect(isStalled(queued, NOW, new Set(['run-w']))).toBe(false)
    expect(isStalled(queued, NOW, new Set(['other']))).toBe(true)
  })

  it('a finished run or no run → false, however old', () => {
    expect(isStalled(run({ runStatus: 'SUCCEEDED' }), NOW, NONE)).toBe(false)
    expect(isStalled(run({ runStatus: 'FAILED' }), NOW, NONE)).toBe(false)
    expect(isStalled(run({ runStatus: null }), NOW, NONE)).toBe(false)
  })

  it('an active run without a run id cannot be compare-and-set, so it is not swept', () => {
    expect(isStalled(run({ runId: null }), NOW, NONE)).toBe(false)
  })
})

describe('isRenderStalled', () => {
  type RenderRow = Parameters<typeof isRenderStalled>[0]
  const render = (over: Partial<RenderRow>): RenderRow => ({
    pdfStatus: 'RUNNING',
    pdfRenderStartedAt: ago(30 * MIN),
    ...over,
  })

  it('RUNNING started 2 min + 1 ms ago → true; exactly 2 min or 2 min − 1 ms → false', () => {
    expect(isRenderStalled(render({ pdfRenderStartedAt: ago(2 * MIN + 1) }), NOW)).toBe(true)
    expect(isRenderStalled(render({ pdfRenderStartedAt: ago(2 * MIN) }), NOW)).toBe(false)
    expect(isRenderStalled(render({ pdfRenderStartedAt: ago(2 * MIN - 1) }), NOW)).toBe(false)
  })

  it('a RUNNING render with no start time is stalled', () => {
    expect(isRenderStalled(render({ pdfRenderStartedAt: null }), NOW)).toBe(true)
  })

  it('any other PDF status → false, however old', () => {
    for (const pdfStatus of ['IDLE', 'QUEUED', 'READY', 'FAILED'] as const) {
      expect(isRenderStalled(render({ pdfStatus }), NOW)).toBe(false)
    }
  })
})

describe('toTailoredCode', () => {
  it('a code both runs share maps to itself', () => {
    for (const code of [
      'WRITER_UNAVAILABLE',
      'ENTAILMENT_UNAVAILABLE',
      'RENDER_FAILED',
      'ATS_CHECK_FAILED',
      'GLYPH_CHECK_FAILED',
      'LAYOUT_UNFIXABLE',
      'VISUAL_CHECK_FAILED',
      'VISUAL_CHECK_UNAVAILABLE',
      'STALLED',
    ] as const) {
      expect(toTailoredCode(code)).toBe(code)
    }
  })

  it('a verified-base-only code maps to INTERNAL_ERROR', () => {
    expect(toTailoredCode('INCOMPLETE')).toBe('INTERNAL_ERROR')
  })
})

describe('TailoredRunFailure', () => {
  it('carries the code, the gates and the origin; the message is the code', () => {
    const gates = [{ gate: 'ats', ok: false, items: [] }]
    const origin: TailoredRunOrigin = { provider: 'jev', reason: 'TIMEOUT' }
    const f = new TailoredRunFailure('LIMITS_EXHAUSTED', gates, origin)
    expect(f).toBeInstanceOf(Error)
    expect(f.name).toBe('TailoredRunFailure')
    expect(f.message).toBe('LIMITS_EXHAUSTED')
    expect(f.code).toBe('LIMITS_EXHAUSTED')
    expect(f.gates).toBe(gates)
    expect(f.origin).toBe(origin)
  })

  it('the origin reason is a closed code set, never free text: it reaches the log', () => {
    expectTypeOf<TailoredRunOrigin['reason']>().toEqualTypeOf<
      | 'NOT_CONFIGURED'
      | 'PROVIDER_ERROR'
      | 'INVALID_OUTPUT'
      | 'RATE_LIMITED'
      | 'TIMEOUT'
      | 'LIMITS_EXHAUSTED'
      | 'INVALID_INPUT'
      | 'SWEPT'
    >()
    // @ts-expect-error a provider's free-text error is not a reason
    const free: TailoredRunOrigin = { provider: 'jev', reason: 'upstream: quota for a@b.c' }
    expect(free.provider).toBe('jev')
  })

  it('defaults to no gates and no origin', () => {
    const f = new TailoredRunFailure('STALLED')
    expect(f.gates).toEqual([])
    expect(f.origin).toBeNull()
  })
})

/** The recording double's Drizzle handle: these helpers take the handle, not the service. */
const fakeRunDb = (rows: unknown[][]) => {
  const { log, service } = fakeRunService(rows)
  return { log, service: (service as { db: never }).db }
}

describe('the run compare-and-set', () => {
  it('only QUEUED and RUNNING runs own the row', () => {
    expect(ACTIVE_RUN_STATUSES).toEqual(['QUEUED', 'RUNNING'])
  })

  it('ownsRun reads by row id, run id and an active status', async () => {
    const { log, service } = fakeRunDb([[{ id: 'row-1' }], []])
    expect(await ownsRun(service, 'row-1', 'run-1')).toBe(true)
    expect(await ownsRun(service, 'row-1', 'run-1')).toBe(false)
    expect(log[0]?.where?.sql).toBe(
      '("tailored_resumes"."id" = $1 and "tailored_resumes"."run_id" = $2 and "tailored_resumes"."run_status" in ($3, $4))',
    )
    expect(log[0]?.where?.params).toEqual(['row-1', 'run-1', 'QUEUED', 'RUNNING'])
    expect(log[0]?.columns).toEqual(['id'])
  })

  it('setStage writes the stage under the same CAS; false when the run lost the row', async () => {
    const { log, service } = fakeRunDb([[{ id: 'row-1' }], []])
    expect(await setStage(service, 'row-1', 'run-1', 'TAILORING')).toBe(true)
    expect(await setStage(service, 'row-1', 'run-1', 'TAILORING')).toBe(false)
    expect(log[0]?.set).toMatchObject({ runStage: 'TAILORING' })
    expect(log[0]?.where?.params).toEqual(['row-1', 'run-1', 'QUEUED', 'RUNNING'])
    expect(log[0]?.columns).toEqual(['id'])
  })
})

describe('startRun after a refused upsert', () => {
  const START = {
    opportunityId: 'opp-1',
    seniorId: 'senior-1',
    userId: 'hr-1',
    baseVersion: 3,
    overwrite: false,
  }
  const refused = (row: unknown[], overwrite = false) => {
    const { log, service } = fakeRunDb([[], row])
    return { log, start: () => startRun(service, { ...START, overwrite }) }
  }
  const idle = { id: 'row-1', runStatus: 'SUCCEEDED', runId: 'run-0', pdfStatus: 'READY' }

  const FREE =
    '("tailored_resumes"."run_status" IS NULL OR "tailored_resumes"."run_status" NOT IN (\'QUEUED\', \'RUNNING\')) AND "tailored_resumes"."pdf_status" NOT IN (\'QUEUED\', \'RUNNING\')'

  it('a free row is taken in one upsert: STARTED with a fresh QUEUED run', async () => {
    const { log, service } = fakeRunDb([[{ id: 'row-1' }]])
    const r = await startRun(service, START)
    expect(r).toEqual({ kind: 'STARTED', rowId: 'row-1', runId: expect.any(String) })
    const runId = r.kind === 'STARTED' ? r.runId : ''
    expect(log).toHaveLength(1)
    const [insert] = log
    const run = {
      runStatus: 'QUEUED',
      runId,
      runBaseVersion: 3,
      runStage: null,
      runQueuedAt: expect.any(Date),
      runStartedAt: null,
      runErrorCode: null,
      runRequestedByUserId: 'hr-1',
      updatedAt: insert?.values?.['runQueuedAt'],
    }
    expect(insert).toMatchObject({ op: 'insert', inTransaction: true, columns: ['id'] })
    expect(insert?.values).toEqual({ jobOpportunityId: 'opp-1', seniorUserId: 'senior-1', ...run })
    expect(insert?.conflict?.target).toEqual(['job_opportunity_id', 'senior_user_id'])
    expect(insert?.conflict?.set).toEqual(run)
    // Without overwrite a published variant also refuses the update.
    expect(insert?.conflict?.setWhere?.sql).toBe(`${FREE} AND "tailored_resumes"."content" IS NULL`)
  })

  it('with overwrite, only an active run or render refuses the upsert', async () => {
    const { log, service } = fakeRunDb([[{ id: 'row-1' }]])
    await startRun(service, { ...START, overwrite: true })
    expect(log[0]?.conflict?.setWhere?.sql).toBe(FREE)
  })

  it('a published variant without overwrite is the PUBLISHED conflict', async () => {
    const { log, start } = refused([{ ...idle, published: true }])
    expect(await start()).toEqual({ kind: 'CONFLICT', reason: 'PUBLISHED' })
    expect(log.map((q) => [q.op, q.inTransaction])).toEqual([
      ['insert', true],
      ['select', true],
    ])
    expect(log[1]?.columns).toEqual(['id', 'runStatus', 'runId', 'pdfStatus', 'published'])
    expect(log[1]?.expressions).toEqual({ published: '"tailored_resumes"."content" IS NOT NULL' })
    expect(log[1]?.where).toMatchObject({
      sql: '("tailored_resumes"."job_opportunity_id" = $1 and "tailored_resumes"."senior_user_id" = $2)',
      params: ['opp-1', 'senior-1'],
    })
  })

  it('a row that is gone by the read is BUSY, not PUBLISHED', async () => {
    expect(await refused([]).start()).toEqual({ kind: 'CONFLICT', reason: 'BUSY' })
  })

  it('a row freed by the read is BUSY, not PUBLISHED', async () => {
    expect(await refused([{ ...idle, published: false }]).start()).toEqual({
      kind: 'CONFLICT',
      reason: 'BUSY',
    })
  })

  it('with overwrite, a published row cannot have refused it: BUSY', async () => {
    expect(await refused([{ ...idle, published: true }], true).start()).toEqual({
      kind: 'CONFLICT',
      reason: 'BUSY',
    })
  })

  it('a QUEUED or RUNNING run is ACTIVE; a QUEUED or RUNNING render is RENDERING', async () => {
    for (const runStatus of ['QUEUED', 'RUNNING']) {
      expect(
        await refused([{ ...idle, runStatus, runId: 'run-9', published: true }]).start(),
      ).toEqual({ kind: 'ACTIVE', rowId: 'row-1', runId: 'run-9' })
    }
    for (const pdfStatus of ['QUEUED', 'RUNNING']) {
      expect(await refused([{ ...idle, pdfStatus, published: false }], true).start()).toEqual({
        kind: 'CONFLICT',
        reason: 'RENDERING',
      })
    }
  })
})

describe('failRun', () => {
  const deps = (rows: unknown[][]) => {
    const { log, service } = fakeRunDb(rows)
    const s3 = { delete: vi.fn(async (_key: string) => undefined) }
    const logger = { warn: vi.fn(), log: vi.fn() }
    return { log, s3, logger, d: { db: service, s3, logger: logger as never } }
  }

  it('FAILED with the code and no stage; the published columns are not in the write', async () => {
    const { log, d } = deps([[{ id: 'row-1' }]])
    expect(await failRun(d, 'row-1', 'run-1', 'WRITER_UNAVAILABLE')).toBe(true)
    const set = log[0]?.set ?? {}
    expect(set).toMatchObject({
      runStatus: 'FAILED',
      runErrorCode: 'WRITER_UNAVAILABLE',
      runStage: null,
    })
    for (const kept of ['content', 'coverLetter', 'verification', 'pdfS3Key', 'runId']) {
      expect(set).not.toHaveProperty(kept)
    }
    expect(log[0]?.where?.params).toEqual(['row-1', 'run-1', 'QUEUED', 'RUNNING'])
    expect(log[0]?.columns).toEqual(['id'])
  })

  it("after the write, deletes the run's own upload and logs one structured line", async () => {
    const { s3, logger, d } = deps([[{ id: 'row-1' }]])
    await failRun(d, 'row-1', 'run-1', 'STALLED', {
      provider: 'jev',
      reason: 'TIMEOUT',
      status: 504,
    })
    expect(s3.delete).toHaveBeenCalledExactlyOnceWith('tailored-resumes/row-1/run-run-1.pdf')
    expect(logger.warn).toHaveBeenCalledOnce()
    expect(JSON.parse(String(logger.warn.mock.calls[0]?.[0]))).toEqual({
      event: 'tailored_resume_run_failed',
      runId: 'run-1',
      rowId: 'row-1',
      code: 'STALLED',
      provider: 'jev',
      cause: 'TIMEOUT',
      status: 504,
      applied: true,
    })
  })

  it('a run that lost the row deletes nothing and logs applied: false with a null origin', async () => {
    const { s3, logger, d } = deps([[]])
    expect(await failRun(d, 'row-1', 'run-1', 'STALLED')).toBe(false)
    expect(s3.delete).not.toHaveBeenCalled()
    expect(JSON.parse(String(logger.warn.mock.calls[0]?.[0]))).toMatchObject({
      provider: null,
      cause: null,
      status: null,
      applied: false,
    })
  })
})
