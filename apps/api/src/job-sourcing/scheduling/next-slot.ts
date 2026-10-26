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
const MINUTES_PER_DAY = 24 * 60
const SLOWDOWN_INTERVAL_CAP_MINUTES = MINUTES_PER_DAY
/** Today plus 7 more local days: a weekly-only profile always finds its slot inside it. */
const LAST_SEARCH_DAY = 7

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const minutesOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))

function isKnownZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch (error) {
    if (error instanceof RangeError) return false
    throw error
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
    r.error.issues.map((i) => `${[what, ...i.path].join('.')}: ${i.message}`),
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
 * The instant of a local wall-clock time, given the UTC offsets `before` and `after` that bracket its
 * day. A time that occurs twice (fall back) resolves to its first occurrence; one that does not exist
 * (spring forward) resolves to the first instant after the gap.
 */
function resolveLocal(timeZone: string, wallMs: number, before: number, after: number): number {
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

/** The profile in one shape: no window means "every day, all day", fixed slots a day of listed minutes. */
interface Shape {
  readonly zone: string
  readonly days: readonly Day[]
  readonly from: number
  readonly to: number
  readonly interval: number
  readonly off: number | null
  readonly fixed: readonly number[] | null
}

function shapeOf(p: Profile): Shape {
  const w = p.window
  return {
    zone: p.fixedSlots?.timeZone ?? w?.timeZone ?? 'UTC',
    days: w?.days ?? DAYS,
    from: w ? minutesOf(w.from) : 0,
    to: w ? minutesOf(w.to) : MINUTES_PER_DAY,
    interval: p.intervalMinutes,
    off: p.offIntervalMinutes,
    fixed: p.fixedSlots ? p.fixedSlots.times.map(minutesOf) : null,
  }
}

const insideWindow = (s: Shape, day: Day, minute: number): boolean =>
  s.days.includes(day) && minute >= s.from && minute < s.to

/** Local minutes of one day on which the profile has a slot. */
function slotMinutes(s: Shape, day: Day, stagger: number): number[] {
  if (s.fixed !== null) return [...s.fixed]
  const out: number[] = []
  if (s.days.includes(day)) {
    for (let m = s.from + stagger; m < s.to; m += s.interval) out.push(m)
  }
  if (s.off !== null) {
    for (let m = stagger % s.off; m < MINUTES_PER_DAY; m += s.off) {
      if (!insideWindow(s, day, m)) out.push(m)
    }
  }
  return out
}

/** The interval of the period `nowMs` falls in: the active one inside the window, the off one outside. */
function periodInterval(s: Shape, nowMs: number): number {
  const q = localParts(s.zone, nowMs)
  const day = dayOfWall(Date.UTC(q.year, q.month - 1, q.day))
  return insideWindow(s, day, q.minute) || s.off === null ? s.interval : s.off
}

/**
 * The first grid slot strictly after `now + gap`, where
 * `gap = max(floorMinutes, min(interval * 2^level, 24 h) - interval)` and `interval` is that of the
 * period `now` falls in. Throws `InvalidFetchProfileError` (a `RangeError`) on an invalid profile,
 * policy or clock, and a plain `RangeError` when the profile has no slot within the 8 local days
 * from the one the threshold falls on.
 */
export function nextSlot(now: Date, profile: FetchProfile, policy: SlotPolicy): Date {
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) throw new InvalidFetchProfileError(['now: invalid date'])
  const s = shapeOf(parseOrThrow(fetchProfileSchema, profile, 'profile'))
  const pol = parseOrThrow(slotPolicySchema, policy, 'policy')

  const period = periodInterval(s, nowMs)
  const slowed = Math.min(period * 2 ** pol.slowdownLevel, SLOWDOWN_INTERVAL_CAP_MINUTES) - period
  const thresholdMs = nowMs + Math.max(pol.floorMinutes, slowed, 0) * MINUTE_MS

  const stagger = staggerMinutes(pol.staggerKey, s.interval)
  const t = localParts(s.zone, thresholdMs)
  const firstDayWall = Date.UTC(t.year, t.month - 1, t.day)
  for (let d = 0; d <= LAST_SEARCH_DAY; d++) {
    const dayWall = firstDayWall + d * DAY_MS
    const before = offsetAt(s.zone, dayWall - DAY_MS)
    const after = offsetAt(s.zone, dayWall + 2 * DAY_MS)
    const later = slotMinutes(s, dayOfWall(dayWall), stagger)
      .map((m) => resolveLocal(s.zone, dayWall + m * MINUTE_MS, before, after))
      .filter((instant) => instant > thresholdMs)
    if (later.length > 0) return new Date(Math.min(...later))
  }
  throw new RangeError(`nextSlot: no slot within ${LAST_SEARCH_DAY + 1} local days`)
}
