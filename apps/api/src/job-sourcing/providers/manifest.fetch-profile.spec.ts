import { describe, expect, it } from 'vitest'
import { FIXTURE_ROOT } from '../../test/fixture-provenance'
import type { FetchProfile } from '../scheduling/next-slot'
import { buildManifest, ManifestError, type TypeDefinition } from './manifest'
import { MANIFEST_VALIDATION_ADAPTERS } from './manifest.adapters'
import { MANIFEST_DEFINITIONS } from './manifest.definitions'
import { attemptsIn, attemptsPerDay, fetchProfileProblem } from './manifest.fetch-profile'

/**
 * U1b: the fetch profile as manifest data (source fetch strategy ADR, sections 1 and 8). The
 * expected profiles below are typed out from the ADR's section 8 table, not derived from the
 * definitions, so a changed definition fails here.
 */

const build = (type?: string, edit: (d: TypeDefinition) => TypeDefinition = (d) => d) =>
  buildManifest({
    definitions: MANIFEST_DEFINITIONS.map((d) => (d.type === type ? edit(d) : d)),
    adapters: MANIFEST_VALIDATION_ADAPTERS,
    fixtureRoot: FIXTURE_ROOT,
  })
const codeOf = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e instanceof ManifestError ? e.code : `OTHER: ${String(e)}`
  }
  return null
}
/** Replaces the profile of every entry of `type` (and its default) with `p`. */
const withProfile = (type: string, p: unknown) =>
  build(type, (d) => ({
    ...d,
    fetchProfile: p as FetchProfile,
    entries: d.entries.map((e) => ({ ...e, fetchProfile: undefined })),
  }))

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI']
const weekday = (timeZone: string, intervalMinutes: number, off: number | null) => ({
  intervalMinutes,
  offIntervalMinutes: off,
  window: { timeZone, days: WEEKDAYS, from: '08:00', to: '19:00' },
})
const daily = (intervalMinutes: number) => ({
  intervalMinutes,
  offIntervalMinutes: null,
  window: null,
})
/** Quota entries keep their legacy interval (the seed's hours), one attempt each Monday. */
const mondays = (intervalMinutes: number) => ({
  intervalMinutes,
  offIntervalMinutes: null,
  window: { timeZone: 'Europe/Kyiv', days: ['MON'], from: '08:00', to: '19:00' },
})
const kyivAt = (time: string) => ({
  intervalMinutes: 1440,
  offIntervalMinutes: null,
  window: null,
  fixedSlots: { timeZone: 'Europe/Kyiv', times: [time] },
})

const EXPECTED: Record<string, unknown> = {
  'remoteok.api.latest': weekday('America/New_York', 60, 180),
  'remotive.api.software-dev': kyivAt('09:00'),
  'remotive.api.devops': kyivAt('13:00'),
  'remotive.api.data': kyivAt('17:00'),
  'himalayas.api.browse': kyivAt('08:00'),
  'jobicy.api.engineering-europe': weekday('Europe/Berlin', 120, 240),
  'arbeitnow.api.feed': { ...weekday('Europe/Berlin', 120, null), routinePages: 1 },
  'jobgether.api.jobs': null,
  'hn-hiring.thread.latest': null,
  'greenhouse.board.stripe': weekday('America/Los_Angeles', 60, 180),
  'greenhouse.board.airbnb': weekday('America/Los_Angeles', 60, 180),
  'greenhouse.board.cloudflare': weekday('America/Los_Angeles', 60, 180),
  'lever.board.spotify': weekday('Europe/Stockholm', 60, 180),
  'lever.board.eu.siteimprove': weekday('Europe/Copenhagen', 60, 180),
  'lever.board.quantco-': weekday('Europe/Berlin', 60, 180),
  'ashby.board.linear': weekday('America/Los_Angeles', 60, 180),
  'ashby.board.supabase': weekday('America/Los_Angeles', 60, 180),
  'workable.board.huggingface': weekday('America/New_York', 60, 180),
  'workable.board.hirefellows': weekday('Asia/Bahrain', 60, 180),
  'recruitee.board.bunq': weekday('Europe/Amsterdam', 60, 180),
  'personio.board.westwing': weekday('Europe/Berlin', 60, 180),
  'personio.board.personio': weekday('Europe/Berlin', 60, 180),
  'jooble.api.senior-developer-remote': mondays(10080),
  'jsearch.rapidapi.backend': daily(1440),
  'jsearch.rapidapi.frontend': daily(1440),
  'jsearch.rapidapi.ai-engineer': daily(1440),
  'theirstack.api.senior': mondays(5760),
  'muse.api.software-engineering-senior': daily(1440),
  'reed.api.senior-developer-remote': daily(1440),
  'djinni.rss.python': {
    intervalMinutes: 60,
    offIntervalMinutes: 120,
    window: {
      timeZone: 'Europe/Kyiv',
      days: [...WEEKDAYS, 'SAT', 'SUN'],
      from: '08:00',
      to: '20:00',
    },
  },
  'djinni.rss.rust': {
    intervalMinutes: 60,
    offIntervalMinutes: 120,
    window: {
      timeZone: 'Europe/Kyiv',
      days: [...WEEKDAYS, 'SAT', 'SUN'],
      from: '08:00',
      to: '20:00',
    },
  },
  'wwr.rss.all-jobs': weekday('America/Chicago', 180, 360),
  'wwr.rss.devops': weekday('America/Chicago', 180, 360),
  'euremotejobs.rss.feed': daily(1440),
}

describe('the fetch profile of every manifest entry (ADR section 8)', () => {
  const m = build()

  it('every entry carries exactly the profile section 8 gives it', () => {
    const actual = Object.fromEntries(m.entries.map((e) => [e.id, e.fetchProfile]))
    expect(actual).toEqual(EXPECTED)
  })

  it('the entry no longer carries intervalHours', () => {
    for (const e of m.entries) expect(e).not.toHaveProperty('intervalHours')
  })

  it('exactly the three deferred accepted-risk types have a null profile (owner, Q8)', () => {
    const nullTypes = MANIFEST_DEFINITIONS.filter(
      (d) =>
        d.fetchProfile === null ||
        d.entries.some((e) => e.fetchProfile === null) ||
        (d.fetchProfile === undefined &&
          d.entries.length === 0 &&
          d.type === 'SMARTRECRUITERS_ATS'),
    ).map((d) => d.type)
    expect(nullTypes.sort()).toEqual(['HN_HIRING', 'JOBGETHER_API', 'SMARTRECRUITERS_ATS'])
    const sr = MANIFEST_DEFINITIONS.find((d) => d.type === 'SMARTRECRUITERS_ATS')!
    expect(sr.fetchProfile).toBeNull()
  })

  it.each(['HN_HIRING', 'JOBGETHER_API', 'SMARTRECRUITERS_ATS'])(
    'a non-null profile on the deferred type %s fails the build',
    (type) => {
      expect(codeOf(() => withProfile(type, daily(1440)))).toBe('FETCH_PROFILE_INVALID')
    },
  )
})

describe('the profile is resolved entry over type, and null exactly for the deferred types', () => {
  /** Edits ONE entry's own profile, the type default left as it is. */
  const withEntryProfile = (type: string, p: unknown) =>
    build(type, (d) => ({
      ...d,
      entries: d.entries.map((e, i) => (i === 0 ? { ...e, fetchProfile: p as FetchProfile } : e)),
    }))

  it('an entry of a deferred type may not override its null default with a profile', () => {
    expect(() => withEntryProfile('HN_HIRING', daily(1440))).toThrow(
      'FETCH_PROFILE_INVALID: hn-hiring.thread.latest: an unscheduled type (owner, Q8) takes a null profile',
    )
  })

  it('an entry of any other type may not be null', () => {
    expect(() => withEntryProfile('JOBICY_API', null)).toThrow(
      'FETCH_PROFILE_INVALID: jobicy.api.engineering-europe: needs a fetch profile',
    )
  })

  it('an entry with no profile of its own and no type default needs one', () => {
    expect(() => withProfile('JOBICY_API', undefined)).toThrow(
      'FETCH_PROFILE_INVALID: jobicy.api.engineering-europe: needs a fetch profile',
    )
  })

  it('a type default is checked even with no entries (SmartRecruiters), and may be absent', () => {
    expect(() => withProfile('SMARTRECRUITERS_ATS', daily(1440))).toThrow(
      'FETCH_PROFILE_INVALID: SMARTRECRUITERS_ATS: its default profile',
    )
    expect(codeOf(() => withProfile('SMARTRECRUITERS_ATS', undefined))).toBeNull()
  })

  it('an entry`s own profile wins over the type default', () => {
    const m = withEntryProfile('JOBICY_API', daily(1440))
    expect(m.entries.find((e) => e.id === 'jobicy.api.engineering-europe')!.fetchProfile).toEqual(
      daily(1440),
    )
  })
})

describe('fetchProfileProblem and attemptsIn (pure)', () => {
  const fixed = (times: string[]) => ({
    ...kyivAt(times[0]!),
    fixedSlots: { timeZone: 'Europe/Kyiv', times },
  })

  it('fixed slots are compared in time order, the gap across midnight included', () => {
    // 02:00 and 23:00: gaps 21 h and 3 h, so a 3 h floor holds whatever order they are listed in.
    expect(fetchProfileProblem(fixed(['23:00', '02:00']), 3)).toBeNull()
    expect(fetchProfileProblem(fixed(['02:00', '23:00']), 4)?.code).toBe('CADENCE_INVALID')
  })

  it('a slot`s minutes count: 09:00 and 14:30 are 5 h 30 min apart', () => {
    expect(fetchProfileProblem(fixed(['09:00', '14:30']), 5)).toBeNull()
    expect(fetchProfileProblem(fixed(['09:00', '14:30']), 6)).toEqual({
      code: 'CADENCE_INVALID',
      message: "330 min between attempts is under the 6 h the provider's terms allow",
    })
  })

  it('every schema issue is reported, separated by "; "', () => {
    const p = fetchProfileProblem(
      { ...daily(0), window: { ...weekday('Europe/Berlin', 1, 1).window, days: [] } },
      0,
    )
    expect(p?.code).toBe('FETCH_PROFILE_INVALID')
    expect(p?.message).toMatch(/^profile\.intervalMinutes: .+; profile\.window\.days: /)
  })

  it('names the zone that is not Area/Location', () => {
    expect(fetchProfileProblem(weekday('UTC', 60, 180), 0)).toEqual({
      code: 'FETCH_PROFILE_INVALID',
      message: 'time zone UTC is not an IANA Area/Location name',
    })
  })

  it.each(['america/Argentina/Buenos_Aires', 'europe/berlin'])(
    'a zone Intl accepts in another letter case (%s) is refused',
    (z) => {
      expect(fetchProfileProblem(weekday(z, 60, 180), 0)?.code).toBe('FETCH_PROFILE_INVALID')
    },
  )

  it('a three-part zone is Area/Location', () => {
    expect(fetchProfileProblem(weekday('America/Argentina/Buenos_Aires', 60, 180), 0)).toBeNull()
  })

  it('attempts: none for a null profile; hand-counted for the others', () => {
    expect(attemptsIn(null, 30 * 1440)).toBe(0)
    expect(attemptsPerDay(null)).toBe(0)
    // 08:00-19:00 hourly is 11, plus 8 at 3 h through the day.
    expect(attemptsPerDay(weekday('Europe/Berlin', 60, 180) as FetchProfile)).toBe(19)
    expect(attemptsPerDay(kyivAt('09:00') as FetchProfile)).toBe(1)
    expect(attemptsPerDay(daily(360) as FetchProfile)).toBe(4)
    // Mondays only: at most 5 in any 30 days.
    expect(attemptsIn(mondays(10080) as FetchProfile, 30 * 1440)).toBe(5)
  })
})

describe('the build refuses each profile section 1 forbids', () => {
  it('an interval below the provider floor (Remotive, 6 h)', () => {
    expect(codeOf(() => withProfile('REMOTIVE_API', daily(300)))).toBe('CADENCE_INVALID')
  })

  it('an off interval below the provider floor', () => {
    expect(codeOf(() => withProfile('REMOTIVE_API', weekday('Europe/Kyiv', 1440, 300)))).toBe(
      'CADENCE_INVALID',
    )
  })

  it('fixed slots closer together than the provider floor', () => {
    const p = {
      ...kyivAt('09:00'),
      fixedSlots: { timeZone: 'Europe/Kyiv', times: ['09:00', '14:00'] },
    }
    expect(codeOf(() => withProfile('REMOTIVE_API', p))).toBe('CADENCE_INVALID')
  })

  it('fixed slots across midnight closer than the floor', () => {
    const p = {
      ...kyivAt('23:00'),
      fixedSlots: { timeZone: 'Europe/Kyiv', times: ['02:00', '23:00'] },
    }
    expect(codeOf(() => withProfile('REMOTIVE_API', p))).toBe('CADENCE_INVALID')
  })

  it('an interval exactly at the floor is accepted', () => {
    // 360 min a day is 4 attempts per entry: over Remotive's perDay, so only one entry keeps it.
    const def = MANIFEST_DEFINITIONS.find((d) => d.type === 'REMOTIVE_API')!
    expect(
      codeOf(() =>
        build('REMOTIVE_API', () => ({
          ...def,
          entries: [{ ...def.entries[0]!, fetchProfile: daily(360) }],
        })),
      ),
    ).toBeNull()
  })

  it('an unknown IANA zone', () => {
    expect(codeOf(() => withProfile('JOBICY_API', weekday('Mars/Olympus', 120, 240)))).toBe(
      'FETCH_PROFILE_INVALID',
    )
  })

  it.each(['+05:00', 'UTC', 'EST'])('a zone %s that Intl accepts but is not Area/Location', (z) => {
    expect(codeOf(() => withProfile('JOBICY_API', weekday(z, 120, 240)))).toBe(
      'FETCH_PROFILE_INVALID',
    )
  })

  it('a fixed-slot zone that is not Area/Location', () => {
    const p = { ...kyivAt('09:00'), fixedSlots: { timeZone: 'UTC', times: ['09:00'] } }
    expect(codeOf(() => withProfile('HIMALAYAS_API', p))).toBe('FETCH_PROFILE_INVALID')
  })

  it('a window with from >= to', () => {
    const p = {
      ...daily(120),
      window: { timeZone: 'Europe/Berlin', days: WEEKDAYS, from: '19:00', to: '08:00' },
    }
    expect(codeOf(() => withProfile('JOBICY_API', p))).toBe('FETCH_PROFILE_INVALID')
  })

  it('a window with no days', () => {
    const p = {
      ...daily(120),
      window: { timeZone: 'Europe/Berlin', days: [], from: '08:00', to: '19:00' },
    }
    expect(codeOf(() => withProfile('JOBICY_API', p))).toBe('FETCH_PROFILE_INVALID')
  })

  it('fixed slots combined with an off interval', () => {
    const p = { ...kyivAt('08:00'), offIntervalMinutes: 180 }
    expect(codeOf(() => withProfile('HIMALAYAS_API', p))).toBe('FETCH_PROFILE_INVALID')
  })

  it('a Remotive schedule whose daily attempts exceed hostRate.perDay', () => {
    // Three entries at two slots each: 6 a day against the host's 4.
    const p = {
      ...kyivAt('08:00'),
      fixedSlots: { timeZone: 'Europe/Kyiv', times: ['08:00', '16:00'] },
    }
    expect(codeOf(() => withProfile('REMOTIVE_API', p))).toBe('HOST_RATE_INVALID')
  })

  it('a Remotive schedule at exactly hostRate.perDay is accepted', () => {
    const def = MANIFEST_DEFINITIONS.find((d) => d.type === 'REMOTIVE_API')!
    const fourth = {
      ...def.entries[0]!,
      id: 'remotive.api.extra',
      config: { category: 'design' },
      fetchProfile: kyivAt('21:00'),
    }
    expect(
      codeOf(() => build('REMOTIVE_API', () => ({ ...def, entries: [...def.entries, fourth] }))),
    ).toBeNull()
  })

  it('a fifth Remotive attempt a day is refused', () => {
    const def = MANIFEST_DEFINITIONS.find((d) => d.type === 'REMOTIVE_API')!
    const more = ['design', 'qa'].map((c, i) => ({
      ...def.entries[0]!,
      id: `remotive.api.${c}`,
      config: { category: c },
      fetchProfile: kyivAt(i === 0 ? '21:00' : '03:00'),
    }))
    expect(
      codeOf(() => build('REMOTIVE_API', () => ({ ...def, entries: [...def.entries, ...more] }))),
    ).toBe('HOST_RATE_INVALID')
  })

  it('an entry whose profile resolves to nothing (no entry and no type default)', () => {
    expect(codeOf(() => withProfile('JOBICY_API', undefined))).toBe('FETCH_PROFILE_INVALID')
  })

  it('a schedule that exceeds the entry`s own budget', () => {
    // Jooble's entry budget is 6 a month; daily is 30.
    expect(codeOf(() => withProfile('JOOBLE_API', daily(1440)))).toBe('CADENCE_INVALID')
  })

  it('a schedule that exceeds the account`s monthly quota', () => {
    // JSearch: 3 entries hourly against 200 requests a month (each entry's own budget of 60 too).
    const def = MANIFEST_DEFINITIONS.find((d) => d.type === 'JSEARCH_API')!
    const edit = () => ({
      ...def,
      entries: def.entries.map((e) => ({ ...e, budget: undefined, fetchProfile: daily(240) })),
    })
    expect(codeOf(() => build('JSEARCH_API', edit))).toBe('QUOTA_INCONSISTENT')
  })

  it('the refusal names the entry', () => {
    expect(() => withProfile('JOBICY_API', weekday('Mars/Olympus', 120, 240))).toThrow(
      /FETCH_PROFILE_INVALID: jobicy\.api\.engineering-europe: /,
    )
  })
})
