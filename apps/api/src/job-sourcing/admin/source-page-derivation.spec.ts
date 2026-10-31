import { describe, expect, it } from 'vitest'
import type { JobSourceTimelineEventDto } from '@crm/shared'
import type { FetchProfile } from '../scheduling/next-slot'
import { correlateEvents, summarizeProfile } from './source-page-derivation'

/**
 * Source-fetch-strategy U7 — the pure page derivations. DB-free so the mutation gate reaches them:
 * every assertion names an INDEPENDENT expected value, not one recomputed from the code.
 */

describe('summarizeProfile', () => {
  it('returns null for a never-scheduled source', () => {
    expect(summarizeProfile(null, 6)).toBeNull()
  })

  it('flattens a windowed profile and carries the floor', () => {
    const profile: FetchProfile = {
      intervalMinutes: 360,
      offIntervalMinutes: 720,
      window: { timeZone: 'Europe/Kyiv', days: ['MON', 'FRI'], from: '09:00', to: '21:00' },
    }
    expect(summarizeProfile(profile, 6)).toEqual({
      intervalMinutes: 360,
      offIntervalMinutes: 720,
      window: { timeZone: 'Europe/Kyiv', days: ['MON', 'FRI'], from: '09:00', to: '21:00' },
      fixedSlotTimes: null,
      floorHours: 6,
    })
  })

  it('carries fixed slot times and a null window', () => {
    const profile: FetchProfile = {
      intervalMinutes: 1440,
      offIntervalMinutes: null,
      window: null,
      fixedSlots: { timeZone: 'UTC', times: ['08:30'] },
    }
    const summary = summarizeProfile(profile, 24)
    expect(summary?.window).toBeNull()
    expect(summary?.fixedSlotTimes).toEqual(['08:30'])
    expect(summary?.offIntervalMinutes).toBeNull()
  })
})

describe('correlateEvents', () => {
  const ev = (over: Partial<JobSourceTimelineEventDto>): JobSourceTimelineEventDto => ({
    id: over.id ?? '00000000-0000-4000-8000-000000000000',
    at: over.at ?? '2026-10-29T10:00:00.000Z',
    kind: over.kind ?? 'TRANSITION',
    fromState: over.fromState ?? null,
    toState: over.toState ?? 'FAILING',
    reasonCode: over.reasonCode ?? null,
    adapterVersion: over.adapterVersion ?? 'a1',
    configVersion: over.configVersion ?? 1,
    httpStatus: over.httpStatus ?? null,
    errorSample: over.errorSample ?? null,
    actorName: over.actorName ?? null,
    note: over.note ?? null,
    correlation: null,
  })

  const byId = (events: JobSourceTimelineEventDto[], id: string) =>
    events.find((e) => e.id === id)?.correlation ?? null

  it('leaves the first transition (no baseline) and every NOTE null', () => {
    const out = correlateEvents([
      ev({ id: '44444444-4444-4444-8444-444444444444', kind: 'NOTE', toState: null }),
      ev({ id: '11111111-1111-4111-8111-111111111111' }),
    ])
    expect(byId(out, '11111111-1111-4111-8111-111111111111')).toBeNull()
    expect(byId(out, '44444444-4444-4444-8444-444444444444')).toBeNull()
  })

  it('marks ADAPTER_CHANGE, CONFIG_CHANGE and NO_CHANGE against the previous transition', () => {
    // newest-first: t3 (adapter moved), t2 (only config moved), t1 (baseline)
    const t1 = ev({
      id: '11111111-1111-4111-8111-111111111111',
      adapterVersion: 'a1',
      configVersion: 1,
    })
    const t2 = ev({
      id: '22222222-2222-4222-8222-222222222222',
      adapterVersion: 'a1',
      configVersion: 2,
    })
    const t3 = ev({
      id: '33333333-3333-4333-8333-333333333333',
      adapterVersion: 'a2',
      configVersion: 2,
    })
    const out = correlateEvents([t3, t2, t1])
    expect(byId(out, '11111111-1111-4111-8111-111111111111')).toBeNull()
    expect(byId(out, '22222222-2222-4222-8222-222222222222')).toBe('CONFIG_CHANGE')
    expect(byId(out, '33333333-3333-4333-8333-333333333333')).toBe('ADAPTER_CHANGE')
  })

  it('a transition with nothing moved on our side is NO_CHANGE (provider-side)', () => {
    const t1 = ev({
      id: '11111111-1111-4111-8111-111111111111',
      adapterVersion: 'a1',
      configVersion: 1,
    })
    const t2 = ev({
      id: '22222222-2222-4222-8222-222222222222',
      adapterVersion: 'a1',
      configVersion: 1,
      toState: 'EMPTY',
    })
    expect(byId(correlateEvents([t2, t1]), '22222222-2222-4222-8222-222222222222')).toBe(
      'NO_CHANGE',
    )
  })

  it('preserves the input order (newest-first) in the output', () => {
    const t1 = ev({ id: '11111111-1111-4111-8111-111111111111' })
    const t2 = ev({ id: '22222222-2222-4222-8222-222222222222' })
    const out = correlateEvents([t2, t1])
    expect(out.map((e) => e.id)).toEqual([
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
    ])
  })
})
