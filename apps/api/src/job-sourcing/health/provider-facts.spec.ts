/**
 * Source-fetch-strategy U4 CR-M-4 — the manifest/provider facts that make BOARD_GONE, STALE_FEED
 * and DEADLINE_NEAR live. Pure; no database.
 */
import { jobSourceTypeSchema } from '@crm/shared'
import { describe, expect, it } from 'vitest'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import { buildManifest } from '../providers/manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from '../providers/manifest.adapters'
import { MANIFEST_DEFINITIONS } from '../providers/manifest.definitions'
import type { FetchProfile } from '../scheduling/next-slot'
import {
  declaredCapBytesFor,
  expiryWindowMsFor,
  feedDepthMsFor,
  freshnessMaxAgeMsFor,
  isEmployerBoard,
  policyDeadlineFor,
} from './provider-facts'

const HOUR = 60 * 60 * 1000

describe('isEmployerBoard', () => {
  it('is true for the ATS board family and false for feeds/APIs', () => {
    expect(isEmployerBoard('GREENHOUSE_ATS')).toBe(true)
    expect(isEmployerBoard('RECRUITEE_ATS')).toBe(true)
    expect(isEmployerBoard('REMOTIVE_API')).toBe(false)
    expect(isEmployerBoard('DOU_RSS')).toBe(false)
  })
})

describe('freshnessMaxAgeMsFor', () => {
  it('is the provider feed-delay where declared, else null', () => {
    expect(freshnessMaxAgeMsFor('REMOTIVE_API')).toBe(24 * HOUR)
    expect(freshnessMaxAgeMsFor('JOBICY_API')).toBe(3 * HOUR)
    expect(freshnessMaxAgeMsFor('GREENHOUSE_ATS')).toBeNull()
  })
})

describe('feedDepthMsFor (CR-M-3)', () => {
  it("is TheirStack's default posted_at_max_age_days (7 days); unknown elsewhere", () => {
    expect(feedDepthMsFor('THEIRSTACK_API')).toBe(7 * 24 * HOUR)
    expect(feedDepthMsFor('REMOTIVE_API')).toBeUndefined()
  })
})

describe('expiryWindowMsFor (backlog 470)', () => {
  const DAY = 24 * HOUR

  it('gives every source type a window: 72 h by default, wider for the slow profiles', () => {
    expect(expiryWindowMsFor('REMOTIVE_API')).toBe(3 * DAY)
    expect(expiryWindowMsFor('NEXTLEVELJOBS_HTML')).toBe(3 * DAY)
    expect(expiryWindowMsFor('GREENHOUSE_ATS')).toBe(3 * DAY)
    expect(expiryWindowMsFor('ARBEITNOW_API')).toBe(9 * DAY)
    expect(expiryWindowMsFor('JOOBLE_API')).toBe(21 * DAY)
    expect(expiryWindowMsFor('THEIRSTACK_API')).toBe(21 * DAY)
    for (const type of jobSourceTypeSchema.options)
      expect(expiryWindowMsFor(type)).toBeGreaterThanOrEqual(3 * DAY)
  })

  /**
   * An upper bound on the longest gap a profile can leave between two attempts. Fixed slots: the
   * widest gap between slots. A window with nothing outside it: one day per absent day in the
   * longest run of them, plus one. Otherwise the slower of the two intervals.
   */
  function longestGapMs(p: FetchProfile): number {
    const MIN = 60_000
    if (p.fixedSlots !== undefined) {
      const m = p.fixedSlots.times
        .map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)))
        .sort((a, b) => a - b)
      const gaps = m.map((t, i) => (i === 0 ? t + 1440 - m[m.length - 1]! : t - m[i - 1]!))
      return Math.max(...gaps) * MIN
    }
    const window = p.window ?? null
    if (window !== null && (p.offIntervalMinutes ?? null) === null) {
      const days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
      const on = days.map((d) => (window.days as readonly string[]).includes(d))
      let longest = 0
      for (let i = 0; i < 7; i += 1) {
        let run = 0
        while (run < 7 && !on[(i + run) % 7]) run += 1
        longest = Math.max(longest, run)
      }
      return (longest + 1) * DAY
    }
    return Math.max(p.intervalMinutes, p.offIntervalMinutes ?? 0) * MIN
  }

  it('is at least 3 x the longest gap of every scheduled manifest entry of its type', () => {
    const manifest = buildManifest({
      definitions: MANIFEST_DEFINITIONS,
      adapters: MANIFEST_VALIDATION_ADAPTERS,
      fixtureRoot: FIXTURE_ROOT,
    })
    const scheduled = manifest.entries.filter((e) => e.fetchProfile !== null)
    expect(scheduled.length).toBeGreaterThan(0)
    const short = scheduled
      .filter((e) => expiryWindowMsFor(e.type) < 3 * longestGapMs(e.fetchProfile!))
      .map((e) => e.id)
    expect(short).toEqual([])
  })
})

describe('policyDeadlineFor', () => {
  it('is the known policy deadline where declared, else null', () => {
    expect(policyDeadlineFor('RECRUITEE_ATS')?.toISOString()).toBe('2027-02-10T00:00:00.000Z')
    expect(policyDeadlineFor('REMOTIVE_API')).toBeNull()
  })
})

describe('declaredCapBytesFor', () => {
  it('is the declared byte cap where configured, else null', () => {
    expect(declaredCapBytesFor('ARBEITNOW_API')).toBe(25_165_824)
    expect(declaredCapBytesFor('GERMANTECHJOBS_API')).toBe(4_194_304)
    expect(declaredCapBytesFor('ASHBY_ATS')).toBeNull()
    expect(declaredCapBytesFor('REMOTIVE_API')).toBeNull()
  })
})
