import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  fetchProfileSchema,
  firstSlotAfter,
  fnv1a32,
  gridMinutes,
  InvalidFetchProfileError,
  nextSlot,
  type Shape,
  staggerMinutes,
  type FetchProfile,
  type SlotPolicy,
} from './next-slot'

const ALL_DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const
const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI'] as const

/** A staggerKey whose stagger on `interval` is exactly `target` (the hash itself is pinned below). */
function keyFor(target: number, interval: number): string {
  for (let i = 0; i < 100_000; i++) {
    if (staggerMinutes(`src-${i}`, interval) === target) return `src-${i}`
  }
  throw new Error(`no key for ${target}/${interval}`)
}

const policy = (staggerKey: string, floorMinutes = 0, slowdownLevel = 0): SlotPolicy => ({
  floorMinutes,
  slowdownLevel,
  staggerKey,
})

function berlin(over: Partial<FetchProfile> = {}): FetchProfile {
  return {
    intervalMinutes: 60,
    offIntervalMinutes: 180,
    window: { timeZone: 'Europe/Berlin', days: [...WEEKDAYS], from: '08:00', to: '19:00' },
    ...over,
  }
}

/** Every day of the week, whole local day, in `timeZone`; slots are the `:30` minutes (stagger 30 / 60). */
function allDay(timeZone: string): FetchProfile {
  return {
    intervalMinutes: 60,
    offIntervalMinutes: null,
    window: { timeZone, days: [...ALL_DAYS], from: '00:00', to: '23:59' },
  }
}

const iso = (d: Date): string => d.toISOString()
const at = (s: string): Date => new Date(s)
const K7 = keyFor(7, 60)
const K0 = keyFor(0, 60)
const K30 = keyFor(30, 60)

describe('fnv1a32 / staggerMinutes', () => {
  it('matches the published FNV-1a 32-bit vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5)
    expect(fnv1a32('a')).toBe(0xe40c292c)
    expect(fnv1a32('foobar')).toBe(0xbf9cf968)
  })

  it('is stable and within [0, interval)', () => {
    expect(staggerMinutes('foobar', 60)).toBe(0xbf9cf968 % 60)
    expect(staggerMinutes('foobar', 1)).toBe(0)
  })

  it('spreads 200 ids over a 60-minute interval: >= 50 distinct minutes, no bucket above 8', () => {
    const buckets = new Array<number>(60).fill(0)
    for (let i = 0; i < 200; i++) buckets[staggerMinutes(`job-source-${i}`, 60)]!++
    expect(buckets.filter((n) => n > 0).length).toBeGreaterThanOrEqual(50)
    expect(Math.max(...buckets)).toBeLessThanOrEqual(8)
  })
})

describe('AC 1-3: the grid and the working window (Europe/Berlin, January = UTC+1)', () => {
  it('1: Tuesday 10:20 Berlin -> 11:07 Berlin', () => {
    expect(iso(nextSlot(at('2027-01-12T09:20:00Z'), berlin(), policy(K7)))).toBe(
      '2027-01-12T10:07:00.000Z',
    )
  })

  it('2: Tuesday 18:30 Berlin -> 21:07 Berlin, the first off-grid slot outside the window', () => {
    expect(iso(nextSlot(at('2027-01-12T17:30:00Z'), berlin(), policy(K7)))).toBe(
      '2027-01-12T20:07:00.000Z',
    )
  })

  it('3: off interval null, Friday 18:30 -> Monday 08:07', () => {
    const p = berlin({ offIntervalMinutes: null })
    expect(iso(nextSlot(at('2027-01-15T17:30:00Z'), p, policy(K7)))).toBe(
      '2027-01-18T07:07:00.000Z',
    )
  })

  it('before the window opens on a window day, the off grid applies (06:07, not 08:07)', () => {
    expect(iso(nextSlot(at('2027-01-12T04:10:00Z'), berlin(), policy(K7)))).toBe(
      '2027-01-12T05:07:00.000Z',
    )
  })

  it('off-grid slots inside the window are skipped on a window day, kept on a weekend day', () => {
    // Tue 06:07 -> the 09:07 off slot lies in the window, the 60-minute grid takes over at 08:07.
    expect(iso(nextSlot(at('2027-01-12T05:08:00Z'), berlin(), policy(K7)))).toBe(
      '2027-01-12T07:07:00.000Z',
    )
    // Sat 10:20: no window on Saturday, so the 180-minute off grid is the only grid -> 12:07.
    expect(iso(nextSlot(at('2027-01-16T09:20:00Z'), berlin(), policy(K7)))).toBe(
      '2027-01-16T11:07:00.000Z',
    )
  })

  it('"to" is exclusive: the last in-window slot is 18:07 and 19:07 is not in the window', () => {
    // Tue 18:08 -> 19:07 would be on the 60-minute grid but lies outside [08:00, 19:00); the off grid has 21:07.
    expect(iso(nextSlot(at('2027-01-12T17:08:00Z'), berlin(), policy(K7)))).toBe(
      '2027-01-12T20:07:00.000Z',
    )
  })

  it('a stagger beyond the window length wraps into the window', () => {
    const p = berlin({
      offIntervalMinutes: null,
      window: { timeZone: 'Europe/Berlin', days: ['MON', 'TUE'], from: '08:00', to: '08:30' },
    })
    // stagger 7 -> 08:07 is in; the next day's 08:07 follows.
    expect(iso(nextSlot(at('2027-01-11T07:08:00Z'), p, policy(K7)))).toBe(
      '2027-01-12T07:07:00.000Z',
    )
    // stagger 40 (>= window length 30) wraps into the window: 08:10, not "no slot".
    expect(iso(nextSlot(at('2027-01-11T07:08:00Z'), p, policy(keyFor(40, 60))))).toBe(
      '2027-01-11T07:10:00.000Z',
    )
  })

  it('window null: the grid runs on UTC days from 00:00 + stagger', () => {
    const p: FetchProfile = { intervalMinutes: 120, offIntervalMinutes: null, window: null }
    expect(iso(nextSlot(at('2027-01-12T01:30:00Z'), p, policy(K0)))).toBe(
      '2027-01-12T02:00:00.000Z',
    )
    expect(iso(nextSlot(at('2027-01-12T22:30:00Z'), p, policy(K0)))).toBe(
      '2027-01-13T00:00:00.000Z',
    )
  })

  it('a weekly-only profile finds its slot 7 days ahead', () => {
    const p = berlin({
      offIntervalMinutes: null,
      window: { timeZone: 'Europe/Berlin', days: ['WED'], from: '08:00', to: '09:00' },
    })
    expect(iso(nextSlot(at('2027-01-13T07:30:00Z'), p, policy(K7)))).toBe(
      '2027-01-20T07:07:00.000Z',
    )
  })
})

describe('AC 4-5: DST (hour-aligned and half-hour grids)', () => {
  const kyiv = allDay('Europe/Kyiv')
  const ny = allDay('America/New_York')
  const sydney = allDay('Australia/Sydney')

  it('4: Kyiv 2027-03-28 spring forward: the 03:30 slot resolves to 04:00 local (01:00Z)', () => {
    expect(iso(nextSlot(at('2027-03-28T00:30:00Z'), kyiv, policy(K30)))).toBe(
      '2027-03-28T01:00:00.000Z',
    )
    // ... and the following slot is 04:30 local, not a second 04:00.
    expect(iso(nextSlot(at('2027-03-28T01:00:00Z'), kyiv, policy(K30)))).toBe(
      '2027-03-28T01:30:00.000Z',
    )
  })

  it('a nonexistent slot that lands on an existing one fires once (Kyiv, stagger 0: 03:00 -> 04:00)', () => {
    expect(iso(nextSlot(at('2027-03-28T00:00:00Z'), kyiv, policy(K0)))).toBe(
      '2027-03-28T01:00:00.000Z',
    )
    expect(iso(nextSlot(at('2027-03-28T01:00:00Z'), kyiv, policy(K0)))).toBe(
      '2027-03-28T02:00:00.000Z',
    )
  })

  it('5: Kyiv 2027-10-31 fall back: 03:30 is returned once, at its first occurrence', () => {
    expect(iso(nextSlot(at('2027-10-30T23:30:00Z'), kyiv, policy(K30)))).toBe(
      '2027-10-31T00:30:00.000Z',
    )
    // just after the first 03:30 (00:30Z): the next slot is 04:30 EET (02:30Z), not the repeated 03:30 (01:30Z)
    expect(iso(nextSlot(at('2027-10-31T00:31:00Z'), kyiv, policy(K30)))).toBe(
      '2027-10-31T02:30:00.000Z',
    )
    expect(iso(nextSlot(at('2027-10-31T00:30:00Z'), kyiv, policy(K30)))).toBe(
      '2027-10-31T02:30:00.000Z',
    )
  })

  it('5: America/New_York 2027-03-14 spring forward: 02:30 -> 03:00 EDT (07:00Z)', () => {
    expect(iso(nextSlot(at('2027-03-14T06:30:00Z'), ny, policy(K30)))).toBe(
      '2027-03-14T07:00:00.000Z',
    )
    expect(iso(nextSlot(at('2027-03-14T07:00:00Z'), ny, policy(K30)))).toBe(
      '2027-03-14T07:30:00.000Z',
    )
  })

  it('5: America/New_York 2027-11-07 fall back: 01:30 once, then 02:30 EST', () => {
    expect(iso(nextSlot(at('2027-11-07T04:30:00Z'), ny, policy(K30)))).toBe(
      '2027-11-07T05:30:00.000Z',
    )
    expect(iso(nextSlot(at('2027-11-07T05:30:00Z'), ny, policy(K30)))).toBe(
      '2027-11-07T07:30:00.000Z',
    )
  })

  it('southern hemisphere (Australia/Sydney): spring forward 2027-10-03 and fall back 2027-04-04', () => {
    expect(iso(nextSlot(at('2027-10-02T15:30:00Z'), sydney, policy(K30)))).toBe(
      '2027-10-02T16:00:00.000Z',
    )
    expect(iso(nextSlot(at('2027-04-03T15:30:00Z'), sydney, policy(K30)))).toBe(
      '2027-04-03T17:30:00.000Z',
    )
  })

  it('a window day boundary across the transition keeps the window in local time (Berlin, 2027-03-28 is a Sunday)', () => {
    // Monday 2027-03-29 08:07 CEST = 06:07Z (the week before it was +1)
    const p = berlin({ offIntervalMinutes: null })
    expect(iso(nextSlot(at('2027-03-26T17:30:00Z'), p, policy(K7)))).toBe(
      '2027-03-29T06:07:00.000Z',
    )
  })
})

describe('AC 6: slowdown, the 24 h cap and the provider floor', () => {
  const p = berlin()
  const slot = at('2027-01-12T09:07:00Z') // Tue 10:07 Berlin, exactly on the grid

  it('level 0 returns the following slot; the same instant is not returned twice (idempotent per slot)', () => {
    expect(iso(nextSlot(slot, p, policy(K7)))).toBe('2027-01-12T10:07:00.000Z')
  })

  it('level 1 skips exactly one slot, level 2 skips three', () => {
    expect(iso(nextSlot(slot, p, policy(K7, 0, 1)))).toBe('2027-01-12T11:07:00.000Z')
    expect(iso(nextSlot(slot, p, policy(K7, 0, 2)))).toBe('2027-01-12T13:07:00.000Z')
  })

  it('level 4 on 60 minutes is a 15 h gap: Wednesday 03:07 Berlin', () => {
    expect(iso(nextSlot(slot, p, policy(K7, 0, 4)))).toBe('2027-01-13T02:07:00.000Z')
  })

  it('level 4 caps the interval at 24 h', () => {
    const utc: FetchProfile = { intervalMinutes: 180, offIntervalMinutes: null, window: null }
    const now = at('2027-01-12T00:00:00Z')
    expect(iso(nextSlot(now, utc, policy(keyFor(0, 180), 0, 4)))).toBe('2027-01-13T00:00:00.000Z')
  })

  it('a floor larger than the gap pushes past a slot; a floor below the gap changes nothing', () => {
    expect(iso(nextSlot(slot, p, policy(K7, 90)))).toBe('2027-01-12T11:07:00.000Z')
    expect(iso(nextSlot(slot, p, policy(K7, 59)))).toBe('2027-01-12T10:07:00.000Z')
    // the result is strictly after now + gap: a slot exactly floor minutes away is excluded (10:07 + 60 -> 12:07)
    expect(iso(nextSlot(slot, p, policy(K7, 60)))).toBe('2027-01-12T11:07:00.000Z')
  })

  it('the gap uses the interval of the period now falls in (off period: 180 minutes)', () => {
    // Tue 21:07 Berlin (off), level 1 -> gap 180: threshold 00:07 Wed, first off slot after is 03:07.
    expect(iso(nextSlot(at('2027-01-12T20:07:00Z'), p, policy(K7, 0, 1)))).toBe(
      '2027-01-13T02:07:00.000Z',
    )
  })

  it('a floor above 24 h still wins over the slowdown cap', () => {
    const utc: FetchProfile = { intervalMinutes: 60, offIntervalMinutes: null, window: null }
    expect(iso(nextSlot(at('2027-01-12T00:00:00Z'), utc, policy(K0, 3000)))).toBe(
      '2027-01-14T03:00:00.000Z',
    )
  })
})

describe('AC 7: fixedSlots', () => {
  const fixed: FetchProfile = {
    intervalMinutes: 360,
    offIntervalMinutes: null,
    window: null,
    fixedSlots: { timeZone: 'Europe/Kyiv', times: ['15:00', '09:00'] },
  }

  it('returns the next listed local time, wrapping to the next day (stagger is not applied)', () => {
    expect(iso(nextSlot(at('2027-01-12T08:00:00Z'), fixed, policy(K7)))).toBe(
      '2027-01-12T13:00:00.000Z',
    )
    expect(iso(nextSlot(at('2027-01-12T07:00:00Z'), fixed, policy(K7)))).toBe(
      '2027-01-12T13:00:00.000Z',
    )
    expect(iso(nextSlot(at('2027-01-12T13:00:00Z'), fixed, policy(K7)))).toBe(
      '2027-01-13T07:00:00.000Z',
    )
  })

  it('a fixed local time inside the spring-forward gap resolves to the gap end', () => {
    const f: FetchProfile = { ...fixed, fixedSlots: { timeZone: 'Europe/Kyiv', times: ['03:30'] } }
    expect(iso(nextSlot(at('2027-03-28T00:00:00Z'), f, policy(K7)))).toBe(
      '2027-03-28T01:00:00.000Z',
    )
  })

  it('slowdown and floor apply to fixed slots too', () => {
    expect(iso(nextSlot(at('2027-01-12T07:00:00Z'), fixed, policy(K7, 0, 1)))).toBe(
      '2027-01-13T07:00:00.000Z',
    )
  })
})

describe('AC 8: invalid input is refused with a typed error, never clamped', () => {
  const now = at('2027-01-12T09:20:00Z')

  it('an unknown zone throws a RangeError (InvalidFetchProfileError)', () => {
    const p = berlin({
      window: { timeZone: 'Mars/Olympus', days: ['MON'], from: '08:00', to: '19:00' },
    })
    expect(() => nextSlot(now, p, policy(K7))).toThrow(RangeError)
    expect(() => nextSlot(now, p, policy(K7))).toThrow(InvalidFetchProfileError)
  })

  // With the in-window stagger wrapping (CR-M-1) a valid profile always has a slot: the former
  // "no slot in 8 days" profile now returns one, and the guard is exercised with a shape that has none.
  const emptyShape: Shape = {
    zone: 'UTC',
    days: ['MON'],
    from: 480,
    to: 480,
    interval: 60,
    off: null,
    fixed: null,
  }

  it('the former no-slot profile (5 minute window, stagger 10) now lands in its window', () => {
    const p = berlin({
      offIntervalMinutes: null,
      window: { timeZone: 'Europe/Berlin', days: ['MON'], from: '08:00', to: '08:05' },
    })
    expect(iso(nextSlot(now, p, policy(keyFor(10, 60))))).toBe('2027-01-18T07:00:00.000Z')
  })

  it('a shape with no slot within the search throws a plain RangeError saying how far it looked', () => {
    const run = (): Date => firstSlotAfter(emptyShape, 0, Date.UTC(2027, 0, 12))
    expect(run).toThrow(RangeError)
    expect(run).toThrow(/no slot within 8 local days/)
    expect(run).not.toThrow(InvalidFetchProfileError)
  })

  it('searches the threshold day and seven more, no further', () => {
    const monday: Shape = { ...emptyShape, to: 540 } // MON 08:00-09:00, stagger 0 -> 08:00
    const tuesday = Date.UTC(2027, 0, 12, 12) // Tue 12:00: next Monday is 6 days ahead
    expect(firstSlotAfter(monday, 0, tuesday, 6).toISOString()).toBe('2027-01-18T08:00:00.000Z')
    expect(() => firstSlotAfter(monday, 0, tuesday, 5)).toThrow(/no slot within 6 local days/)
    const mondayNoon = Date.UTC(2027, 0, 11, 12) // Mon 12:00: next Monday is exactly 7 days ahead
    expect(firstSlotAfter(monday, 0, mondayNoon).toISOString()).toBe('2027-01-18T08:00:00.000Z')
  })

  const win = (over: Partial<NonNullable<FetchProfile['window']>>): FetchProfile =>
    berlin({
      window: { timeZone: 'Europe/Berlin', days: ['MON'], from: '08:00', to: '19:00', ...over },
    })

  it.each([
    ['interval 0', berlin({ intervalMinutes: 0 })],
    ['interval negative', berlin({ intervalMinutes: -5 })],
    ['interval NaN', berlin({ intervalMinutes: Number.NaN })],
    ['interval Infinity', berlin({ intervalMinutes: Number.POSITIVE_INFINITY })],
    ['interval fractional', berlin({ intervalMinutes: 1.5 })],
    ['interval above a week', berlin({ intervalMinutes: 10_081 })],
    ['off interval 0', berlin({ offIntervalMinutes: 0 })],
    ['off interval NaN', berlin({ offIntervalMinutes: Number.NaN })],
    ['empty days', win({ days: [] })],
    ['from == to', win({ from: '08:00', to: '08:00' })],
    ['from > to (midnight crossing is not supported)', win({ from: '22:00', to: '06:00' })],
    ['hour 24', win({ to: '24:00' })],
    ['minute 60', win({ from: '08:60' })],
    ['one-digit hour', win({ from: '8:00' })],
    ['empty from', win({ from: '' })],
    ['trailing text', win({ to: '19:00x' })],
    ['empty zone', win({ timeZone: '' })],
    [
      'fixedSlots with a window',
      {
        ...berlin({ offIntervalMinutes: null }),
        fixedSlots: { timeZone: 'UTC', times: ['09:00'] },
      },
    ],
    [
      'fixedSlots with an off interval',
      { ...berlin({ window: null }), fixedSlots: { timeZone: 'UTC', times: ['09:00'] } },
    ],
    [
      'fixedSlots with no times',
      {
        ...berlin({ window: null, offIntervalMinutes: null }),
        fixedSlots: { timeZone: 'UTC', times: [] },
      },
    ],
    [
      'fixedSlots with a bad time',
      {
        ...berlin({ window: null, offIntervalMinutes: null }),
        fixedSlots: { timeZone: 'UTC', times: ['9am'] },
      },
    ],
    [
      'fixedSlots with a bad zone',
      {
        ...berlin({ window: null, offIntervalMinutes: null }),
        fixedSlots: { timeZone: 'Nope/Nope', times: ['09:00'] },
      },
    ],
  ] as [string, FetchProfile][])('refuses: %s', (_name, profile) => {
    expect(fetchProfileSchema.safeParse(profile).success).toBe(false)
    expect(() => nextSlot(now, profile, policy(K7))).toThrow(InvalidFetchProfileError)
  })

  it('refuses a bad policy and an invalid now', () => {
    expect(() => nextSlot(now, berlin(), policy(K7, -1))).toThrow(InvalidFetchProfileError)
    expect(() => nextSlot(now, berlin(), policy(K7, Number.NaN))).toThrow(InvalidFetchProfileError)
    expect(() => nextSlot(now, berlin(), policy(K7, 0, 5))).toThrow(InvalidFetchProfileError)
    expect(() => nextSlot(now, berlin(), policy(K7, 0, -1))).toThrow(InvalidFetchProfileError)
    expect(() => nextSlot(now, berlin(), policy(K7, 0, 1.5))).toThrow(InvalidFetchProfileError)
    expect(() => nextSlot(now, berlin(), policy(''))).toThrow(InvalidFetchProfileError)
    expect(() => nextSlot(new Date(Number.NaN), berlin(), policy(K7))).toThrow(
      InvalidFetchProfileError,
    )
  })

  it('accepts the boundary values', () => {
    const ok = berlin({ intervalMinutes: 1, offIntervalMinutes: 10_080 })
    expect(fetchProfileSchema.safeParse(ok).success).toBe(true)
    expect(
      fetchProfileSchema.safeParse(
        berlin({ window: { timeZone: 'UTC', days: ['SUN'], from: '00:00', to: '23:59' } }),
      ).success,
    ).toBe(true)
    expect(() => nextSlot(now, berlin(), policy(K7, 0, 4))).not.toThrow()
    expect(() => nextSlot(now, berlin(), policy(K7, 0, 0))).not.toThrow()
  })
})

describe('pinned edges (grid boundaries, period interval, messages)', () => {
  const issuesOf = (fn: () => unknown): string[] => {
    try {
      fn()
    } catch (error) {
      return error instanceof InvalidFetchProfileError
        ? [...error.issues]
        : [`other: ${String(error)}`]
    }
    return []
  }
  const now = at('2027-01-12T09:20:00Z')

  it.each(['x09:00', '09:00x', '9:00', '09:0', '24:00', '23:60', ' 09:00'])(
    'fixed time %j is refused',
    (time) => {
      const p: FetchProfile = {
        intervalMinutes: 60,
        offIntervalMinutes: null,
        window: null,
        fixedSlots: { timeZone: 'UTC', times: [time] },
      }
      expect(fetchProfileSchema.safeParse(p).success).toBe(false)
      expect(
        fetchProfileSchema.safeParse({ ...p, fixedSlots: { timeZone: 'UTC', times: ['09:00'] } })
          .success,
      ).toBe(true)
    },
  )

  it('names the offending field and says why', () => {
    const zone = berlin({
      window: { timeZone: 'Mars/Olympus', days: ['MON'], from: '08:00', to: '19:00' },
    })
    expect(issuesOf(() => nextSlot(now, zone, policy(K7)))).toEqual([
      'profile.window.timeZone: unknown IANA time zone',
    ])
    const order = berlin({ window: { timeZone: 'UTC', days: ['MON'], from: '19:00', to: '08:00' } })
    expect(issuesOf(() => nextSlot(now, order, policy(K7)))).toEqual([
      'profile.window: from must be before to',
    ])
    const fixed = { ...berlin(), fixedSlots: { timeZone: 'UTC', times: ['09:00'] } }
    expect(issuesOf(() => nextSlot(now, fixed, policy(K7)))).toEqual([
      'profile: fixedSlots replaces the grid: no window and no off interval',
    ])
    expect(issuesOf(() => nextSlot(new Date(Number.NaN), berlin(), policy(K7)))).toEqual([
      'now: invalid date',
    ])
    expect(issuesOf(() => nextSlot(now, berlin(), policy(K7, -1)))).toEqual([
      expect.stringMatching(/^policy\.floorMinutes: /),
    ])
    expect(issuesOf(() => nextSlot(now, berlin(), policy('')))).toEqual([
      expect.stringMatching(/^policy\.staggerKey: /),
    ])
  })

  it('the error is named, and its message lists every issue', () => {
    const bad = berlin({ intervalMinutes: 0, offIntervalMinutes: 0 })
    let caught: unknown
    try {
      nextSlot(now, bad, policy(K7))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(InvalidFetchProfileError)
    expect((caught as Error).name).toBe('InvalidFetchProfileError')
    expect((caught as Error).message).toMatch(
      /^invalid fetch profile: profile\.intervalMinutes: .+; profile\.offIntervalMinutes: .+$/,
    )
  })

  it('an off slot exactly at "from" belongs to the window (off 450, stagger 30: 08:00 is skipped)', () => {
    const p = berlin({ offIntervalMinutes: 450 })
    expect(iso(nextSlot(at('2027-01-12T06:00:00Z'), p, policy(K30)))).toBe(
      '2027-01-12T07:30:00.000Z',
    )
  })

  it('an off slot exactly at "to" is outside the window (off 555, stagger 30: 19:00 is kept)', () => {
    const p = berlin({ offIntervalMinutes: 555 })
    expect(iso(nextSlot(at('2027-01-12T17:45:00Z'), p, policy(K30)))).toBe(
      '2027-01-12T18:00:00.000Z',
    )
  })

  it('an in-window slot exactly at "to" is not a slot', () => {
    const p = berlin({
      offIntervalMinutes: null,
      window: { timeZone: 'Europe/Berlin', days: [...WEEKDAYS], from: '08:00', to: '09:00' },
    })
    expect(iso(nextSlot(at('2027-01-12T07:00:30Z'), p, policy(K0)))).toBe(
      '2027-01-13T07:00:00.000Z',
    )
  })

  it('the off grid ends at midnight: a slot at minute 1440 is not invented (off 470, stagger 30)', () => {
    const p: FetchProfile = {
      intervalMinutes: 60,
      offIntervalMinutes: 470,
      window: { timeZone: 'UTC', days: [...ALL_DAYS], from: '08:00', to: '09:00' },
    }
    expect(iso(nextSlot(at('2027-01-12T20:00:00Z'), p, policy(K30)))).toBe(
      '2027-01-13T00:30:00.000Z',
    )
  })

  it.each([
    ['before the window', '2027-01-12T04:30:00Z', '2027-01-12T08:07:00.000Z'],
    ['after the window', '2027-01-12T18:30:00Z', '2027-01-12T23:07:00.000Z'],
    ['exactly at "from" (inside)', '2027-01-12T07:00:00Z', '2027-01-12T08:07:00.000Z'],
    ['exactly at "to" (outside)', '2027-01-12T18:00:00Z', '2027-01-12T23:07:00.000Z'],
    ['on a day outside the window', '2027-01-16T09:20:00Z', '2027-01-16T14:07:00.000Z'],
  ])('level 1 uses the interval of the period now falls in: %s', (_name, nowIso, expected) => {
    expect(iso(nextSlot(at(nowIso), berlin(), policy(K7, 0, 1)))).toBe(expected)
  })

  it('with no off interval, level 4 outside the window still uses the active interval (a 15 h gap)', () => {
    const p = berlin({ offIntervalMinutes: null })
    expect(iso(nextSlot(at('2027-01-11T06:30:00Z'), p, policy(K7, 0, 4)))).toBe(
      '2027-01-12T07:07:00.000Z',
    )
  })

  it('an interval above 24 h never moves the threshold before now', () => {
    const p: FetchProfile = { intervalMinutes: 2880, offIntervalMinutes: null, window: null }
    expect(iso(nextSlot(at('2027-01-12T00:00:00Z'), p, policy(keyFor(0, 2880))))).toBe(
      '2027-01-13T00:00:00.000Z',
    )
  })
})

describe('review round 1', () => {
  const now = at('2027-01-12T00:00:00Z') // Tue 01:00 Berlin, before the window
  const withKeys = {
    window: { timeZone: 'Europe/Berlin', days: [...WEEKDAYS], from: '08:00', to: '19:00' },
  }

  describe('CR-M-2: unknown keys are refused at every level', () => {
    it.each([
      ['profile', { ...berlin(), fixedSlot: { timeZone: 'UTC', times: ['09:00'] } }],
      ['window', berlin({ window: { ...withKeys.window, day: ['MON'] } as never })],
      [
        'fixedSlots',
        {
          intervalMinutes: 60,
          offIntervalMinutes: null,
          window: null,
          fixedSlots: { timeZone: 'UTC', times: ['09:00'], time: '10:00' },
        },
      ],
    ] as [string, FetchProfile][])('refuses an unknown key in the %s', (_level, profile) => {
      expect(fetchProfileSchema.safeParse(profile).success).toBe(false)
      expect(() => nextSlot(now, profile, policy(K7))).toThrow(InvalidFetchProfileError)
    })

    it('refuses an unknown key in the policy', () => {
      const bad = { floorMinutes: 0, slowdownLevel: 0, staggerKey: K7, level: 1 } as never
      expect(() => nextSlot(now, berlin(), bad)).toThrow(InvalidFetchProfileError)
    })
  })

  describe('SPEC-M-1: routinePages (ADR section 1)', () => {
    it.each([1, 3, 100])('accepts routinePages %d', (n) => {
      expect(fetchProfileSchema.safeParse(berlin({ routinePages: n })).success).toBe(true)
    })
    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1'])(
      'refuses routinePages %j',
      (n) => {
        expect(fetchProfileSchema.safeParse({ ...berlin(), routinePages: n }).success).toBe(false)
      },
    )
    it('is optional, and does not influence the slot', () => {
      expect(fetchProfileSchema.safeParse(berlin()).success).toBe(true)
      const base = nextSlot(now, berlin(), policy(K7)).getTime()
      expect(nextSlot(now, berlin({ routinePages: 1 }), policy(K7)).getTime()).toBe(base)
    })
  })

  describe('CR-M-1: a valid profile always has a slot inside an active window', () => {
    const daily = berlin({ intervalMinutes: 1440, offIntervalMinutes: null })
    // stagger (on a 1440 interval) -> expected slot: 08:00 + stagger % 660 on Tue 2027-01-12, Berlin = UTC+1
    it.each([
      [0, '2027-01-12T07:00:00.000Z'],
      [659, '2027-01-12T17:59:00.000Z'], // the last minute of the window
      [660, '2027-01-12T07:00:00.000Z'], // at the window length: wraps to the start
      [700, '2027-01-12T07:40:00.000Z'],
      [1000, '2027-01-12T12:40:00.000Z'],
      [1439, '2027-01-12T08:59:00.000Z'],
    ])('daily interval on an 11 h window, stagger %d', (stagger, expected) => {
      expect(iso(nextSlot(now, daily, policy(keyFor(stagger, 1440))))).toBe(expected)
    })

    it('a weekly interval with a stagger beyond a day still lands in the window (and in the null window)', () => {
      const weekly = berlin({ intervalMinutes: 10_080, offIntervalMinutes: null })
      expect(iso(nextSlot(now, weekly, policy(keyFor(5000, 10_080))))).toBe(
        '2027-01-12T13:20:00.000Z',
      )
      const open: FetchProfile = { intervalMinutes: 10_080, offIntervalMinutes: null, window: null }
      expect(iso(nextSlot(now, open, policy(keyFor(5000, 10_080))))).toBe(
        '2027-01-12T11:20:00.000Z',
      )
    })

    it('an interval below the window length keeps the plain stagger (ADR instants unchanged)', () => {
      expect(iso(nextSlot(at('2027-01-12T09:20:00Z'), berlin(), policy(K7)))).toBe(
        '2027-01-12T10:07:00.000Z',
      )
    })
  })

  describe('gridMinutes', () => {
    it('lists first, first + step, ... strictly below end', () => {
      expect(gridMinutes(5, 10, 30)).toEqual([5, 15, 25])
      expect(gridMinutes(10, 10, 10)).toEqual([])
      expect(gridMinutes(30, 10, 30)).toEqual([])
      expect(gridMinutes(25, 10, 30)).toEqual([25])
    })
    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses step %j', (step) => {
      expect(() => gridMinutes(0, step, 10)).toThrow(RangeError)
      expect(() => gridMinutes(0, step, 10)).toThrow(`grid step must be positive, got ${step}`)
    })
    it('refuses a null step (an absent off interval must never reach the grid)', () => {
      expect(() => gridMinutes(0, null as never, 10)).toThrow(RangeError)
    })
  })

  describe('floorMinutes is bounded (backlog LOW)', () => {
    it('accepts one year and refuses more, with the typed error', () => {
      expect(() => nextSlot(now, berlin(), policy(K7, 525_600))).not.toThrow()
      expect(() => nextSlot(now, berlin(), policy(K7, 525_601))).toThrow(InvalidFetchProfileError)
      expect(() => nextSlot(now, berlin(), policy(K7, 1e15))).toThrow(InvalidFetchProfileError)
    })
  })

  describe('SPEC-L-2: the OFF grid across a transition (window + off interval, both directions)', () => {
    // Transitions fall on Sundays, outside the Mon-Fri window, so the 60-minute off grid (stagger 30) applies.
    const off = (timeZone: string): FetchProfile => ({
      intervalMinutes: 60,
      offIntervalMinutes: 60,
      window: { timeZone, days: [...WEEKDAYS], from: '08:00', to: '19:00' },
    })
    it.each([
      [
        'Kyiv spring forward 03:30 -> 04:00',
        'Europe/Kyiv',
        '2027-03-28T00:30:00Z',
        '2027-03-28T01:00:00.000Z',
      ],
      [
        'Kyiv after the gap slot',
        'Europe/Kyiv',
        '2027-03-28T01:00:00Z',
        '2027-03-28T01:30:00.000Z',
      ],
      [
        'Kyiv fall back, first 03:30',
        'Europe/Kyiv',
        '2027-10-30T23:30:00Z',
        '2027-10-31T00:30:00.000Z',
      ],
      [
        'Kyiv fall back, repeat skipped',
        'Europe/Kyiv',
        '2027-10-31T00:31:00Z',
        '2027-10-31T02:30:00.000Z',
      ],
      [
        'New_York spring forward',
        'America/New_York',
        '2027-03-14T06:30:00Z',
        '2027-03-14T07:00:00.000Z',
      ],
      [
        'New_York after the gap slot',
        'America/New_York',
        '2027-03-14T07:00:00Z',
        '2027-03-14T07:30:00.000Z',
      ],
      [
        'New_York fall back, first 01:30',
        'America/New_York',
        '2027-11-07T04:30:00Z',
        '2027-11-07T05:30:00.000Z',
      ],
      [
        'New_York fall back, repeat skipped',
        'America/New_York',
        '2027-11-07T05:30:00Z',
        '2027-11-07T07:30:00.000Z',
      ],
      [
        'Sydney spring forward',
        'Australia/Sydney',
        '2027-10-02T15:30:00Z',
        '2027-10-02T16:00:00.000Z',
      ],
      [
        'Sydney fall back, repeat skipped',
        'Australia/Sydney',
        '2027-04-03T15:30:00Z',
        '2027-04-03T17:30:00.000Z',
      ],
    ])('%s', (_name, zone, from, expected) => {
      expect(iso(nextSlot(at(from), off(zone), policy(K30)))).toBe(expected)
    })
  })
})

/** A seeded LCG: the same sequence on every machine. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function localParts(
  timeZone: string,
  t: number,
): { day: string; minute: number; offsetMin: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(new Date(t))
  const get = (k: string): string => parts.find((p) => p.type === k)!.value
  const wall = Date.UTC(+get('year'), +get('month') - 1, +get('day'), +get('hour'), +get('minute'))
  return {
    day: get('weekday').slice(0, 3).toUpperCase(),
    minute: +get('hour') * 60 + +get('minute'),
    offsetMin: (wall - Math.floor(t / 60_000) * 60_000) / 60_000,
  }
}

describe('AC 9: seeded property checks (1,000 random instants across 2027, three zones)', () => {
  const zones = ['Europe/Kyiv', 'America/New_York', 'Australia/Sydney'] as const
  const start = Date.UTC(2027, 0, 1)
  const year = 365 * 86_400_000

  for (const zone of zones) {
    for (const [name, key, stagger] of [
      ['stagger 0', K0, 0],
      ['stagger 7', K7, 7],
    ] as const) {
      it(`${zone}, ${name}: after now, on the grid, never skips a slot, idempotent`, () => {
        const profile: FetchProfile = {
          intervalMinutes: 60,
          offIntervalMinutes: 180,
          window: { timeZone: zone, days: [...WEEKDAYS], from: '08:00', to: '19:00' },
        }
        const rnd = lcg(zone.length * 1000 + stagger)
        let checkedGrid = 0
        const problems: string[] = []
        const inWindow = (q: { day: string; minute: number }): boolean =>
          (WEEKDAYS as readonly string[]).includes(q.day) && q.minute >= 480 && q.minute < 1140
        const onGrid = (q: { day: string; minute: number }): boolean =>
          inWindow(q)
            ? q.minute >= 480 + stagger && (q.minute - 480 - stagger) % 60 === 0
            : q.minute >= stagger && (q.minute - stagger) % 180 === 0
        for (let i = 0; i < 334; i++) {
          const now = Math.floor((start + rnd() * year) / 1000) * 1000
          const slot = nextSlot(new Date(now), profile, policy(key)).getTime()
          if (slot <= now) problems.push(`not after now: ${now}`)
          // idempotent per slot: asked one ms before the slot, the slot; at the slot, a later one
          if (nextSlot(new Date(slot - 1), profile, policy(key)).getTime() !== slot)
            problems.push(`not idempotent: ${slot}`)
          if (nextSlot(new Date(slot), profile, policy(key)).getTime() <= slot)
            problems.push(`repeats: ${slot}`)
          const lp = localParts(zone, slot)
          const dstDay =
            localParts(zone, slot - 86_400_000).offsetMin !==
            localParts(zone, slot + 86_400_000).offsetMin
          if (dstDay) continue // DST days: covered by the explicit AC 4-5 cases
          checkedGrid++
          if (!onGrid(lp)) problems.push(`off grid: ${new Date(slot).toISOString()}`)
          // never skips: no minute strictly between now and the slot lies on the grid
          if (slot - now <= 4 * 3_600_000) {
            for (let t = Math.floor(now / 60_000) * 60_000 + 60_000; t < slot; t += 60_000) {
              if (onGrid(localParts(zone, t)))
                problems.push(`skipped ${new Date(t).toISOString()} before ${slot}`)
            }
          }
        }
        expect(problems).toEqual([])
        expect(checkedGrid).toBeGreaterThan(300)
      })
    }
  }
})

describe('purity', () => {
  it('does not read the clock or randomness', () => {
    const src = readFileSync(new URL('./next-slot.ts', import.meta.url), 'utf8')
    expect(src).not.toMatch(/Date\.now\(|new Date\(\)|Math\.random|performance\.now/)
  })

  it('does not mutate its inputs and returns equal results for equal inputs', () => {
    const p = Object.freeze(berlin())
    const now = at('2027-01-12T09:20:00Z')
    const a = nextSlot(now, p, policy(K7))
    expect(now.toISOString()).toBe('2027-01-12T09:20:00.000Z')
    expect(nextSlot(now, p, policy(K7)).getTime()).toBe(a.getTime())
  })
})
