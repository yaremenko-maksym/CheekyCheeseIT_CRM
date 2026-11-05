import { describe, expect, it } from 'vitest'
import type { RecordIssue, StructurerOutcome } from '../../structuring/html-structurer.port'
import type { EnrichmentRecord } from './html-ports'
import { parks, settledRecord, settlementsOf } from './model-settlement'

const IDS = ['a', 'b', 'c']
const issue = (id: string, failure: RecordIssue['failure'] = 'INVALID_OUTPUT'): RecordIssue => ({
  id,
  failure,
  droppedRecords: 0,
  nulledUrls: 0,
  droppedEvidence: 0,
  nulledFacts: 0,
})
const settled = (outcome: StructurerOutcome | null, ids = IDS) =>
  Object.fromEntries(settlementsOf(outcome, ids))

const extracted = (perRecordIssues: RecordIssue[] = []): StructurerOutcome => ({
  kind: 'EXTRACTED',
  extractionVersion: 'v',
  records: [],
  perRecordIssues,
})
const stop = (over: object, remainingIds: string[], perRecordIssues: RecordIssue[] = []) =>
  ({ ...over, remainingIds, perRecordIssues }) as StructurerOutcome
const partial = (stoppedBy: object, remainingIds: string[], perRecordIssues: RecordIssue[] = []) =>
  ({
    kind: 'PARTIAL',
    extractionVersion: 'v',
    records: [],
    stoppedBy,
    remainingIds,
    perRecordIssues,
  }) as StructurerOutcome

describe('settlementsOf: the outcome table (ADR 5.4)', () => {
  it('answered, including a page that gave no fields: cleared', () => {
    expect(settled(extracted())).toEqual({ a: 'CLEARED', b: 'CLEARED', c: 'CLEARED' })
  })

  it('a kept record with a guard issue was answered', () => {
    expect(settled(extracted([issue('a', null)]))).toEqual({
      a: 'CLEARED',
      b: 'CLEARED',
      c: 'CLEARED',
    })
  })

  it('record-caused: a failed record in a pass where another succeeded', () => {
    expect(settled(extracted([issue('b')]))).toEqual({
      a: 'CLEARED',
      b: 'RECORD_CAUSED',
      c: 'CLEARED',
    })
  })

  it('a failed record before a stop is record-caused when another succeeded; the rest stay owed', () => {
    const budget = { kind: 'BUDGET_EXHAUSTED', cause: 'CYCLE_LIMIT' }
    expect(settled(partial(budget, ['c'], [issue('b')]))).toEqual({
      a: 'CLEARED',
      b: 'RECORD_CAUSED',
      c: 'OWED',
    })
  })

  it('nothing succeeded (EXTRACTOR_FAILED): no record is blamed', () => {
    const allFailed = stop(
      { kind: 'EXTRACTOR_FAILED', code: 'INVALID_OUTPUT' },
      [],
      IDS.map((id) => issue(id)),
    )
    expect(settled(allFailed)).toEqual({ a: 'OWED', b: 'OWED', c: 'OWED' })
  })

  it('a failed record before a stop with no success anywhere is not blamed', () => {
    const budget = { kind: 'BUDGET_EXHAUSTED', cause: 'RATE_LIMITED' }
    expect(settled(partial(budget, ['b', 'c'], [issue('a')]))).toEqual({
      a: 'OWED',
      b: 'OWED',
      c: 'OWED',
    })
  })

  it.each([
    ['CANCELLED', { kind: 'EXTRACTOR_FAILED', code: 'CANCELLED' }],
    ['PORT_THREW', { kind: 'EXTRACTOR_FAILED', code: 'PORT_THREW' }],
    ['an unknown code', { kind: 'EXTRACTOR_FAILED', code: 'UNKNOWN_CODE' }],
    ['the local-time limit', { kind: 'BUDGET_EXHAUSTED', cause: 'CYCLE_LIMIT' }],
    ['a rate limit', { kind: 'BUDGET_EXHAUSTED', cause: 'RATE_LIMITED' }],
    ['PROVIDER_ERROR', { kind: 'MODEL_UNAVAILABLE', code: 'PROVIDER_ERROR' }],
  ])("not the record's fault, %s: stays owed", (_name, over) => {
    expect(settled(stop(over, IDS))).toEqual({ a: 'OWED', b: 'OWED', c: 'OWED' })
  })

  it('a thrown structurer leaves all owed', () => {
    expect(settled(null)).toEqual({ a: 'OWED', b: 'OWED', c: 'OWED' })
  })

  it('TIMEOUT: the record in flight is marked, the rest stay owed', () => {
    const timeout = { kind: 'EXTRACTOR_FAILED', code: 'TIMEOUT' }
    expect(settled(stop(timeout, ['b', 'c']), ['b', 'c'])).toEqual({ b: 'TIMED_OUT', c: 'OWED' })
    expect(settled(partial(timeout, ['b', 'c']))).toEqual({
      a: 'CLEARED',
      b: 'TIMED_OUT',
      c: 'OWED',
    })
  })

  it('a stop other than TIMEOUT marks no record as in flight', () => {
    const cancelled = { kind: 'EXTRACTOR_FAILED', code: 'CANCELLED' }
    expect(settled(partial(cancelled, ['b']), ['a', 'b'])).toEqual({ a: 'CLEARED', b: 'OWED' })
    const budget = { kind: 'MODEL_UNAVAILABLE', code: 'TIMEOUT' }
    expect(settled(partial(budget, ['b']), ['a', 'b'])).toEqual({ a: 'CLEARED', b: 'OWED' })
  })

  it.each([
    [
      'NOT_CONFIGURED',
      stop({ kind: 'MODEL_UNAVAILABLE', code: 'NOT_CONFIGURED' }, ['a', 'b', 'c']),
    ],
    [
      'NOT_CONFIGURED behind a partial pass',
      partial({ kind: 'MODEL_UNAVAILABLE', code: 'NOT_CONFIGURED' }, ['b', 'c'], [issue('a')]),
    ],
    ['ai-input no', { kind: 'SKIPPED_AI_INPUT_NO' } as StructurerOutcome],
    ['ai-input unspecified', { kind: 'SKIPPED_AI_INPUT_UNSPECIFIED' } as StructurerOutcome],
  ])('a configuration state or a decision, %s: cleared', (_name, outcome) => {
    expect(settled(outcome)).toEqual({ a: 'CLEARED', b: 'CLEARED', c: 'CLEARED' })
  })
})

describe('settledRecord', () => {
  const NOW = new Date('2026-11-01T10:00:00.000Z')
  const H = 60 * 60 * 1000
  const REVISIT = 72 * H
  const record = (over: Partial<EnrichmentRecord> = {}): EnrichmentRecord =>
    ({
      lastAttemptAt: NOW,
      nextDueAt: new Date(0),
      modelPending: true,
      modelAttempts: 0,
      ...over,
    }) as EnrichmentRecord
  const dueIn = (ms: number) => new Date(NOW.getTime() + ms)

  it('CLEARED resets the count and the order, due at the revisit pace', () => {
    expect(
      settledRecord(record({ modelAttempts: 2, modelOfferLast: true }), 'CLEARED', REVISIT),
    ).toMatchObject({
      modelPending: false,
      modelAttempts: 0,
      modelOfferLast: false,
      nextDueAt: dueIn(REVISIT),
    })
  })

  it.each([
    [0, 1, 6 * H],
    [1, 2, 24 * H],
  ])('RECORD_CAUSED after %i: count %i, owed on the backoff', (attempts, count, backoff) => {
    expect(
      settledRecord(
        record({ modelAttempts: attempts, modelOfferLast: true }),
        'RECORD_CAUSED',
        REVISIT,
      ),
    ).toMatchObject({
      modelPending: true,
      modelAttempts: count,
      modelOfferLast: false,
      nextDueAt: dueIn(backoff),
    })
  })

  it('the third RECORD_CAUSED parks at the revisit pace', () => {
    expect(settledRecord(record({ modelAttempts: 2 }), 'RECORD_CAUSED', REVISIT)).toMatchObject({
      modelPending: false,
      modelAttempts: 3,
      nextDueAt: dueIn(REVISIT),
    })
  })

  it('OWED keeps the count and the order, due at the longest backoff', () => {
    expect(settledRecord(record({ modelAttempts: 2 }), 'OWED', REVISIT)).toMatchObject({
      modelPending: true,
      modelAttempts: 2,
      modelOfferLast: false,
      nextDueAt: dueIn(24 * H),
    })
    expect(settledRecord(record({ modelOfferLast: true }), 'OWED', REVISIT).modelOfferLast).toBe(
      true,
    )
  })

  it('TIMED_OUT is OWED, and offered last', () => {
    expect(settledRecord(record({ modelAttempts: 1 }), 'TIMED_OUT', REVISIT)).toMatchObject({
      modelPending: true,
      modelAttempts: 1,
      modelOfferLast: true,
      nextDueAt: dueIn(24 * H),
    })
  })

  it('parks only the third record-caused failure', () => {
    expect(parks(record({ modelAttempts: 1 }), 'RECORD_CAUSED')).toBe(false)
    expect(parks(record({ modelAttempts: 2 }), 'RECORD_CAUSED')).toBe(true)
    expect(parks(record({ modelAttempts: 2 }), 'OWED')).toBe(false)
    expect(parks(record({ modelAttempts: 2 }), 'CLEARED')).toBe(false)
  })
})
