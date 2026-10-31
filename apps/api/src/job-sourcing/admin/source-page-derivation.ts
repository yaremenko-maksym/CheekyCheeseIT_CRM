import type {
  JobSourceCorrelation,
  JobSourceProfileSummary,
  JobSourceTimelineEventDto,
} from '@crm/shared'
import type { FetchProfile } from '../scheduling/next-slot'

/**
 * Source-fetch-strategy U7 — the two PURE derivations the source page needs, split out of the
 * service so they are tested without a database (the service's DB-gated specs would leave these
 * mutants alive in the mutation gate otherwise).
 */

/**
 * The cadence summary that replaced `minIntervalHours` (U7): the manifest's `FetchProfile`, flattened
 * into a page-ready shape. `null` profile → `null` summary (the source is never scheduled, owner Q8).
 */
export function summarizeProfile(
  profile: FetchProfile | null,
  floorHours: number,
): JobSourceProfileSummary | null {
  if (profile === null) return null
  return {
    intervalMinutes: profile.intervalMinutes,
    offIntervalMinutes: profile.offIntervalMinutes,
    window: profile.window
      ? {
          timeZone: profile.window.timeZone,
          days: [...profile.window.days],
          from: profile.window.from,
          to: profile.window.to,
        }
      : null,
    fixedSlotTimes: profile.fixedSlots ? [...profile.fixedSlots.times] : null,
    floorHours,
  }
}

/**
 * The correlation hint (ADR section 10): for each TRANSITION, did the change coincide with a change
 * ON OUR SIDE. `events` arrive newest-first; we walk oldest-first, comparing each TRANSITION's
 * adapter/config version to the PREVIOUS transition's, and return the same list (same order) with
 * `correlation` filled in. `null` on a NOTE, and on the first transition in the window (no baseline
 * to compare against — the previous transition may lie outside the bounded window). Adapter change
 * wins over a config change when both moved.
 */
export function correlateEvents(
  events: readonly JobSourceTimelineEventDto[],
): JobSourceTimelineEventDto[] {
  const correlationById = new Map<string, JobSourceCorrelation | null>()
  let prev: { adapterVersion: string | null; configVersion: number | null } | null = null
  for (const e of [...events].reverse()) {
    if (e.kind !== 'TRANSITION') {
      correlationById.set(e.id, null)
      continue
    }
    let c: JobSourceCorrelation | null = null
    if (prev !== null) {
      if (e.adapterVersion !== prev.adapterVersion) c = 'ADAPTER_CHANGE'
      else if (e.configVersion !== prev.configVersion) c = 'CONFIG_CHANGE'
      else c = 'NO_CHANGE'
    }
    correlationById.set(e.id, c)
    prev = { adapterVersion: e.adapterVersion, configVersion: e.configVersion }
  }
  return events.map((e) => ({ ...e, correlation: correlationById.get(e.id) ?? null }))
}
