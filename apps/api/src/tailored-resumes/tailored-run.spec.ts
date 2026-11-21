import { describe, expect, it } from 'vitest'
import {
  isRenderStalled,
  isStalled,
  TAILORED_RENDER_DEADLINE_MS,
  TAILORED_RUN_DEADLINE_MS,
  TailoredRunFailure,
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
    const origin = { provider: 'jev', reason: 'TIMEOUT' }
    const f = new TailoredRunFailure('LIMITS_EXHAUSTED', gates, origin)
    expect(f).toBeInstanceOf(Error)
    expect(f.name).toBe('TailoredRunFailure')
    expect(f.message).toBe('LIMITS_EXHAUSTED')
    expect(f.code).toBe('LIMITS_EXHAUSTED')
    expect(f.gates).toBe(gates)
    expect(f.origin).toBe(origin)
  })

  it('defaults to no gates and no origin', () => {
    const f = new TailoredRunFailure('STALLED')
    expect(f.gates).toEqual([])
    expect(f.origin).toBeNull()
  })
})
