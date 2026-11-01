import { describe, expect, it } from 'vitest'
import {
  createJobSourceNoteSchema,
  jobHealthReasonSchema,
  jobHealthStateSchema,
  jobSourceCorrelationSchema,
  jobSourceDetailSchema,
  jobSourceOperationalListSchema,
  jobSourceOperationalRowSchema,
  jobSourceProfileSummarySchema,
  jobSourceRunSchema,
  jobSourceSchema,
} from './index'

/**
 * Source-fetch-strategy U7 — the source-page DTOs. These are the contract the ADMIN source page
 * reads; the payload is operational data, so the note write is the one untrusted input and is
 * bounded + non-blank the same way the `job_source_health_events.note` column is.
 */

const PROFILE = {
  intervalMinutes: 360,
  offIntervalMinutes: null,
  window: { timeZone: 'Europe/Kyiv', days: ['MON', 'FRI'], from: '09:00', to: '21:00' },
  fixedSlotTimes: null,
  floorHours: 6,
}

const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'REMOTIVE_API',
  enabled: true,
  state: 'HEALTHY',
  reasonCode: null,
  lastCollectedAt: '2026-10-30T10:00:00.000Z',
  newestItemPublishedAt: '2026-10-30T08:00:00.000Z',
  profileSummary: PROFILE,
}

describe('createJobSourceNoteSchema', () => {
  it('accepts a bounded note and trims it', () => {
    expect(createJobSourceNoteSchema.parse({ note: '  provider announced an outage  ' })).toEqual({
      note: 'provider announced an outage',
    })
  })

  it('rejects a blank note', () => {
    expect(createJobSourceNoteSchema.safeParse({ note: '   ' }).success).toBe(false)
  })

  it('rejects a note past 500 characters', () => {
    expect(createJobSourceNoteSchema.safeParse({ note: 'x'.repeat(501) }).success).toBe(false)
  })

  it('refuses unknown keys', () => {
    expect(createJobSourceNoteSchema.safeParse({ note: 'ok', kind: 'TRANSITION' }).success).toBe(
      false,
    )
  })
})

describe('jobSourceProfileSummarySchema', () => {
  it('parses a scheduled profile with a window', () => {
    expect(jobSourceProfileSummarySchema.parse(PROFILE)).toEqual(PROFILE)
  })

  it('rejects a non-positive interval', () => {
    expect(
      jobSourceProfileSummarySchema.safeParse({ ...PROFILE, intervalMinutes: 0 }).success,
    ).toBe(false)
  })
})

describe('jobSourceOperationalListSchema', () => {
  it('parses a row with no health event and no schedule (null state / null profile)', () => {
    const parsed = jobSourceOperationalListSchema.parse({
      items: [{ ...ROW, state: null, reasonCode: null, profileSummary: null }],
    })
    expect(parsed.items[0]?.state).toBeNull()
    expect(parsed.items[0]?.profileSummary).toBeNull()
  })
})

describe('jobSourceDetailSchema', () => {
  it('parses a TRANSITION event with a correlation hint and a NOTE event with an author', () => {
    const parsed = jobSourceDetailSchema.parse({
      source: ROW,
      runs: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          startedAt: '2026-10-30T10:00:00.000Z',
          endedAt: '2026-10-30T10:00:05.000Z',
          outcome: 'SUCCEEDED',
          received: 40,
          created: 3,
          invalid: 0,
          requestCount: 1,
          bytesRead: 10240,
          lastHttpStatus: 200,
          newestItemPublishedAt: '2026-10-30T08:00:00.000Z',
          adapterVersion: 'remotive-2',
          configVersion: 4,
        },
      ],
      events: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          at: '2026-10-29T10:00:00.000Z',
          kind: 'TRANSITION',
          fromState: 'HEALTHY',
          toState: 'FAILING',
          reasonCode: 'ACCESS_CHANGED',
          adapterVersion: 'remotive-2',
          configVersion: 4,
          httpStatus: 403,
          errorSample: 'forbidden',
          actorName: null,
          note: null,
          correlation: 'NO_CHANGE',
        },
        {
          id: '44444444-4444-4444-8444-444444444444',
          at: '2026-10-29T12:00:00.000Z',
          kind: 'NOTE',
          fromState: null,
          toState: null,
          reasonCode: null,
          adapterVersion: null,
          configVersion: null,
          httpStatus: null,
          errorSample: null,
          actorName: 'Ada Admin',
          note: 'provider confirmed an auth change',
          correlation: null,
        },
      ],
    })
    expect(parsed.events[0]?.correlation).toBe('NO_CHANGE')
    expect(parsed.events[1]?.note).toBe('provider confirmed an auth change')
  })
})

describe('the health vocabularies are the exact ADR section-10 lists', () => {
  it('eight states, in order', () => {
    expect(jobHealthStateSchema.options).toEqual([
      'BLOCKED',
      'CAPPED',
      'PAUSED',
      'FAILING',
      'EMPTY',
      'DEGRADED',
      'SILENT',
      'HEALTHY',
    ])
  })

  it('eleven detector reasons', () => {
    expect(jobHealthReasonSchema.options).toEqual([
      'VOLUME_DROP',
      'NO_NEW_ITEMS',
      'EMPTY_RESPONSE',
      'SCHEMA_DRIFT',
      'ACCESS_CHANGED',
      'THROTTLED',
      'SLOW',
      'PAYLOAD_GROWTH',
      'STALE_FEED',
      'BOARD_GONE',
      'DEADLINE_NEAR',
    ])
  })

  it('three correlation hints', () => {
    expect(jobSourceCorrelationSchema.options).toEqual([
      'ADAPTER_CHANGE',
      'CONFIG_CHANGE',
      'NO_CHANGE',
    ])
  })
})

describe('jobSourceProfileSummarySchema — field bounds', () => {
  it('accepts a valid HH:MM window time and rejects out-of-range / mis-formatted ones', () => {
    const withTime = (from: string) =>
      jobSourceProfileSummarySchema.safeParse({ ...PROFILE, window: { ...PROFILE.window, from } })
        .success
    expect(withTime('00:00')).toBe(true)
    expect(withTime('23:59')).toBe(true)
    expect(withTime('24:00')).toBe(false) // hour out of range
    expect(withTime('09:60')).toBe(false) // minute out of range
    expect(withTime('9:00')).toBe(false) // not zero-padded
    // Anchored at BOTH ends: junk before (kills a dropped `^`) and after (a dropped `$`).
    expect(withTime('x09:00')).toBe(false)
    expect(withTime('09:00x')).toBe(false)
  })

  it('accepts all seven weekdays and rejects an empty day list', () => {
    const withDays = (days: string[]) =>
      jobSourceProfileSummarySchema.safeParse({ ...PROFILE, window: { ...PROFILE.window, days } })
        .success
    expect(withDays(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'])).toBe(true)
    expect(withDays(['FUNDAY'])).toBe(false)
    expect(withDays([])).toBe(false)
  })

  it('rejects an empty fixedSlotTimes array (min 1) but accepts null', () => {
    const withFixed = (fixedSlotTimes: unknown) =>
      jobSourceProfileSummarySchema.safeParse({ ...PROFILE, window: null, fixedSlotTimes }).success
    expect(withFixed(null)).toBe(true)
    expect(withFixed(['08:30'])).toBe(true)
    expect(withFixed([])).toBe(false)
  })
})

describe('the list/row/run schemas enforce their shape (not an empty object)', () => {
  it('an empty object is rejected by each', () => {
    expect(jobSourceOperationalRowSchema.safeParse({}).success).toBe(false)
    expect(jobSourceOperationalListSchema.safeParse({}).success).toBe(false)
    expect(jobSourceRunSchema.safeParse({}).success).toBe(false)
  })

  it('a run parses and keeps its nullable counts', () => {
    const run = jobSourceRunSchema.parse({
      id: '22222222-2222-4222-8222-222222222222',
      startedAt: '2026-10-30T10:00:00.000Z',
      endedAt: null,
      outcome: 'STARTED',
      received: null,
      created: null,
      invalid: null,
      requestCount: null,
      bytesRead: null,
      lastHttpStatus: null,
      newestItemPublishedAt: null,
      adapterVersion: null,
      configVersion: null,
    })
    expect(run.outcome).toBe('STARTED')
    expect(run.received).toBeNull()
  })
})

describe('jobSourceSchema (minIntervalHours removed — U7)', () => {
  it('no longer carries minIntervalHours', () => {
    expect('minIntervalHours' in jobSourceSchema.shape).toBe(false)
  })
})
