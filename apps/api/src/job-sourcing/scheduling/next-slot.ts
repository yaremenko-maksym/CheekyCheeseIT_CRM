import { z } from 'zod'

/**
 * `nextSlot`: WHEN a job source next becomes due, as a pure function (source fetch strategy U1a).
 * Architecture: docs/architecture/2026-10-25-source-fetch-strategy.md, sections 1-4. Nothing calls it
 * yet; the ledger adopts it in U1b. No clock, no randomness, no I/O: the caller passes the database
 * clock as `now` and writes the absolute result (a UTC `Date`, like `next_attempt_at`).
 *
 * Decisions where the ADR is silent (each is an A1 line in the PR body):
 * - A window with `from >= to` is refused, so a window never crosses midnight. Midnight-crossing
 *   needs a second profile field; nothing in section 8 asks for one.
 * - `window: null` means "always active" on UTC days; its grid is `00:00 + stagger + k * interval`.
 * - The off grid restarts at local 00:00 every day with offset `stagger % offIntervalMinutes`, so an
 *   off interval that does not divide 24 h has a shorter step at midnight.
 * - `fixedSlots` ignores the stagger, and may not be combined with a window or an off interval.
 * - The slow-down gap uses the interval of the period `now` falls in (the active interval when the
 *   off interval is null).
 */

const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const
type Day = (typeof DAYS)[number]

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * MINUTE_MS
const MAX_INTERVAL_MINUTES = 7 * 24 * 60
const MAX_SLOWDOWN_LEVEL = 4
const SLOWDOWN_INTERVAL_CAP_MINUTES = 24 * 60
const SEARCH_DAYS_AHEAD = 8

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const minutesOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))

function isKnownZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}
const zone = z.string().refine(isKnownZone, { message: 'unknown IANA time zone' })
const interval = z.number().int().positive().max(MAX_INTERVAL_MINUTES)

export const fetchProfileSchema = z
  .object({
    intervalMinutes: interval,
    offIntervalMinutes: interval.nullable(),
    window: z
      .object({
        timeZone: zone,
        days: z.array(z.enum(DAYS)).min(1),
        from: hhmm,
        to: hhmm,
      })
      .refine((w) => minutesOf(w.from) < minutesOf(w.to), { message: 'from must be before to' })
      .nullable(),
    fixedSlots: z.object({ timeZone: zone, times: z.array(hhmm).min(1) }).optional(),
  })
  .refine(
    (p) => p.fixedSlots === undefined || (p.window === null && p.offIntervalMinutes === null),
    {
      message: 'fixedSlots replaces the grid: no window and no off interval',
    },
  )

export type FetchProfile = z.input<typeof fetchProfileSchema>

const slotPolicySchema = z.object({
  floorMinutes: z.number().int().nonnegative(),
  slowdownLevel: z.number().int().min(0).max(MAX_SLOWDOWN_LEVEL),
  staggerKey: z.string().min(1),
})

export type SlotPolicy = z.input<typeof slotPolicySchema>

/** A refused profile, policy or clock. A `RangeError`, so callers that catch the ADR's type still match. */
export class InvalidFetchProfileError extends RangeError {
  constructor(readonly issues: readonly string[]) {
    super(`invalid fetch profile: ${issues.join('; ')}`)
    this.name = 'InvalidFetchProfileError'
  }
}

function parseOrThrow<T extends z.ZodType>(schema: T, value: unknown, what: string): z.output<T> {
  const r = schema.safeParse(value)
  if (r.success) return r.data
  throw new InvalidFetchProfileError(
    r.error.issues.map((i) => `${what}.${i.path.join('.')}: ${i.message}`),
  )
}

/** FNV-1a, 32 bit, over the UTF-8 bytes: stable across processes, versions and platforms. */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5
  for (const byte of new TextEncoder().encode(text)) {
    h = Math.imul(h ^ byte, 0x01000193) >>> 0
  }
  return h
}

/** The per-source minute offset inside an interval: hash of the key, modulo the interval. */
export function staggerMinutes(staggerKey: string, intervalMinutes: number): number {
  return fnv1a32(staggerKey) % intervalMinutes
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    })
    formatters.set(timeZone, f)
  }
  return f
}

interface LocalParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly minute: number
  /** Local wall clock minus UTC, in ms. */
  readonly offsetMs: number
}

function localParts(timeZone: string, instantMs: number): LocalParts {
  const num: Record<string, number> = {}
  for (const p of formatterFor(timeZone).formatToParts(new Date(instantMs)))
    num[p.type] = Number(p.value)
  const minute = num['hour']! * 60 + num['minute']!
  const wall = Date.UTC(num['year']!, num['month']! - 1, num['day']!, 0, minute)
  return {
    year: num['year']!,
    month: num['month']!,
    day: num['day']!,
    minute,
    offsetMs: wall - Math.floor(instantMs / MINUTE_MS) * MINUTE_MS,
  }
}

const offsetAt = (timeZone: string, instantMs: number): number =>
  localParts(timeZone, instantMs).offsetMs

function dayOfWall(wallMs: number): Day {
  return DAYS[(new Date(wallMs).getUTCDay() + 6) % 7]!
}

/**
 * The instant of a local wall-clock time. A time that occurs twice (fall back) resolves to its first
 * occurrence; one that does not exist (spring forward) resolves to the first instant after the gap.
 */
function resolveLocal(timeZone: string, wallMs: number): number {
  const before = offsetAt(timeZone, wallMs - DAY_MS)
  const after = offsetAt(timeZone, wallMs + DAY_MS)
  const valid = [wallMs - before, wallMs - after].filter(
    (t) => offsetAt(timeZone, t) === wallMs - t,
  )
  if (valid.length > 0) return Math.min(...valid)
  // In the gap: the transition lies between these two instants; find its minute.
  let lo = wallMs - after
  let hi = wallMs - before
  while (hi - lo > MINUTE_MS) {
    const mid = lo + Math.floor((hi - lo) / (2 * MINUTE_MS)) * MINUTE_MS
    if (offsetAt(timeZone, mid) === after) hi = mid
    else lo = mid
  }
  return hi
}

type Profile = z.output<typeof fetchProfileSchema>
type Window = NonNullable<Profile['window']>
const ALL_DAY: Window = { timeZone: 'UTC', days: [...DAYS], from: '00:00', to: '23:59' }

/** Local minutes of one day on which the profile has a slot. */
function slotMinutes(p: Profile, day: Day, staggerKey: string): number[] {
  if (p.fixedSlots) return p.fixedSlots.times.map(minutesOf)
  const stagger = staggerMinutes(staggerKey, p.intervalMinutes)
  const win = p.window ?? ALL_DAY
  const active = win.days.includes(day)
  const from = p.window === null ? 0 : minutesOf(win.from)
  const to = p.window === null ? 24 * 60 : minutesOf(win.to)
  const out: number[] = []
  if (active) for (let m = from + stagger; m < to; m += p.intervalMinutes) out.push(m)
  const off = p.offIntervalMinutes
  if (off !== null && p.window !== null) {
    for (let m = stagger % off; m < 24 * 60; m += off) {
      if (!(active && m >= from && m < to)) out.push(m)
    }
  }
  return out
}

/** The interval of the period `nowMs` falls in: the active one inside the window, the off one outside. */
function periodInterval(p: Profile, nowMs: number): number {
  if (p.window === null || p.fixedSlots) return p.intervalMinutes
  const q = localParts(p.window.timeZone, nowMs)
  const day = dayOfWall(Date.UTC(q.year, q.month - 1, q.day))
  const inside =
    p.window.days.includes(day) &&
    q.minute >= minutesOf(p.window.from) &&
    q.minute < minutesOf(p.window.to)
  return inside ? p.intervalMinutes : (p.offIntervalMinutes ?? p.intervalMinutes)
}

/**
 * The first grid slot strictly after `now + gap`, where
 * `gap = max(floorMinutes, min(interval * 2^level, 24 h) - interval)` and `interval` is that of the
 * period `now` falls in. Throws `InvalidFetchProfileError` (a `RangeError`) on an invalid profile,
 * policy or clock, and a plain `RangeError` when the profile has no slot within 8 local days.
 */
export function nextSlot(now: Date, profile: FetchProfile, policy: SlotPolicy): Date {
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) throw new InvalidFetchProfileError(['now: invalid date'])
  const p = parseOrThrow(fetchProfileSchema, profile, 'profile')
  const pol = parseOrThrow(slotPolicySchema, policy, 'policy')

  const period = periodInterval(p, nowMs)
  const slowed = Math.min(period * 2 ** pol.slowdownLevel, SLOWDOWN_INTERVAL_CAP_MINUTES) - period
  const thresholdMs = nowMs + Math.max(pol.floorMinutes, slowed, 0) * MINUTE_MS

  const dayZone = p.fixedSlots?.timeZone ?? p.window?.timeZone ?? 'UTC'
  const t = localParts(dayZone, thresholdMs)
  const firstDayWall = Date.UTC(t.year, t.month - 1, t.day)
  for (let d = -1; d <= SEARCH_DAYS_AHEAD; d++) {
    const dayWall = firstDayWall + d * DAY_MS
    const offsetStart = offsetAt(dayZone, dayWall - DAY_MS)
    const offsetEnd = offsetAt(dayZone, dayWall + 2 * DAY_MS)
    const instants = slotMinutes(p, dayOfWall(dayWall), pol.staggerKey).map((m) => {
      const wall = dayWall + m * MINUTE_MS
      return offsetStart === offsetEnd ? wall - offsetStart : resolveLocal(dayZone, wall)
    })
    const later = instants.filter((i) => i > thresholdMs)
    if (later.length > 0) return new Date(Math.min(...later))
  }
  throw new RangeError(`nextSlot: no slot within ${SEARCH_DAYS_AHEAD} local days`)
}
