import type { JobSourceType } from '@crm/shared'
import { type FetchProfile, fetchProfileSchema } from '../scheduling/next-slot'

/**
 * The fetch profile's build-time rules (source fetch strategy U1b; ADR
 * docs/architecture/2026-10-25-source-fetch-strategy.md, sections 1 and 8). Pure: `buildManifest`
 * turns a problem into its `ManifestError`, the way `hostRateProblem` works for host rates.
 */

/**
 * The accepted-risk types the owner connects last (Q8): never scheduled, so their profile is `null`,
 * and only theirs. Connecting one (U12) removes it from this list and gives it a profile.
 */
export const UNSCHEDULED_TYPES: readonly JobSourceType[] = [
  'HN_HIRING',
  'JOBGETHER_API',
  'SMARTRECRUITERS_ATS',
]

export interface ProfileProblem {
  readonly code: 'FETCH_PROFILE_INVALID' | 'CADENCE_INVALID'
  readonly message: string
}

const DAY_MINUTES = 24 * 60

/**
 * The `intervalMinutes` a `fixedSlots` profile must carry. `nextSlot` ignores it for the grid (the
 * listed times replace it); it is unused except for the slow-down gap, which it caps at one day
 * (U1a). U1a's schema requires the field, so this one value stands for "no interval".
 */
export const FIXED_SLOTS_INTERVAL_MINUTES = DAY_MINUTES
/**
 * An IANA `Area/Location` name, as written in the tz database (capitalised, with a slash). `Intl`
 * alone also accepts `UTC`, `EST`, offsets such as `+05:00` and any letter case, none of which names
 * a region's working day (the next-slot module leaves this stricter rule here). The schema has
 * already checked that `Intl` knows the zone.
 */
const isAreaLocation = (zone: string): boolean => /^[A-Z]/.test(zone) && zone.includes('/')

const minutesOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))

/** The gaps between consecutive fixed slots of a day, the one across midnight included. */
function fixedGaps(times: readonly string[]): number[] {
  const m = times.map(minutesOf).sort((a, b) => a - b)
  return m.map((t, i) => (i === 0 ? t + DAY_MINUTES - m[m.length - 1]! : t - m[i - 1]!))
}

/** What is wrong with a non-null profile under a provider floor of `floorHours`, or null. */
export function fetchProfileProblem(profile: unknown, floorHours: number): ProfileProblem | null {
  const parsed = fetchProfileSchema.safeParse(profile)
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `${['profile', ...i.path].join('.')}: ${i.message}`,
    )
    return { code: 'FETCH_PROFILE_INVALID', message: issues.join('; ') }
  }
  const p = parsed.data
  for (const zone of [p.window?.timeZone, p.fixedSlots?.timeZone]) {
    if (zone !== undefined && !isAreaLocation(zone)) {
      return {
        code: 'FETCH_PROFILE_INVALID',
        message: `time zone ${zone} is not an IANA Area/Location name`,
      }
    }
  }
  // SPEC-M-2: ADR section 1 forbids `fixedSlots` combined with an interval. U1a's schema still
  // requires `intervalMinutes`, so a fixed-slot profile carries exactly the placeholder.
  if (p.fixedSlots !== undefined && p.intervalMinutes !== FIXED_SLOTS_INTERVAL_MINUTES) {
    return {
      code: 'FETCH_PROFILE_INVALID',
      message: `fixed slots carry intervalMinutes ${FIXED_SLOTS_INTERVAL_MINUTES}, not ${p.intervalMinutes}`,
    }
  }
  const gaps =
    p.fixedSlots !== undefined
      ? fixedGaps(p.fixedSlots.times)
      : [p.intervalMinutes, p.offIntervalMinutes ?? Number.POSITIVE_INFINITY]
  const shortest = Math.min(...gaps)
  if (shortest < floorHours * 60) {
    return {
      code: 'CADENCE_INVALID',
      message: `${shortest} min between attempts is under the ${floorHours} h the provider's terms allow`,
    }
  }
  return null
}

/**
 * An upper bound on the attempts a profile schedules in any `minutes`-long span: what a budget, a
 * quota or a host's daily rate is checked against. The grid restarts every local day (`nextSlot`),
 * so a profile with no window has `ceil(day / interval)` slots a day whatever its interval, and a
 * window takes one day in seven per listed weekday. A `null` profile is never scheduled: 0.
 */
export function attemptsIn(profile: FetchProfile | null, minutes: number): number {
  if (profile === null) return 0
  const days = Math.ceil(minutes / DAY_MINUTES)
  if (profile.fixedSlots !== undefined) return days * new Set(profile.fixedSlots.times).size
  const w = profile.window
  if (w === null) return days * Math.ceil(DAY_MINUTES / profile.intervalMinutes)
  const activeDays = Math.min(days, Math.ceil(days / 7) * new Set(w.days).size)
  const inWindow = Math.ceil((minutesOf(w.to) - minutesOf(w.from)) / profile.intervalMinutes)
  const off =
    profile.offIntervalMinutes === null ? 0 : Math.ceil(DAY_MINUTES / profile.offIntervalMinutes)
  return activeDays * inWindow + days * off
}

/** The attempts a profile schedules in one day: what a host's `perDay` rate is checked against. */
export const attemptsPerDay = (profile: FetchProfile | null): number =>
  attemptsIn(profile, DAY_MINUTES)
