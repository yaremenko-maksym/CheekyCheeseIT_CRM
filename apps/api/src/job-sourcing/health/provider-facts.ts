/**
 * Source-fetch-strategy U4 — the manifest/provider facts the detector pass feeds the three
 * detectors that are not pure run-history (BOARD_GONE, STALE_FEED, DEADLINE_NEAR).
 *
 * Derived from the source `type` and a small tunable table of provider facts (section 10 and the
 * ADR research file), kept in code — no schema column — so they are tunable without a migration,
 * like `HEALTH_THRESHOLDS`. Wiring these is what makes those three detectors live in production
 * (CR-M-4 / SPEC-M-1); a `type` with no entry simply yields null (the detector stays quiet), which
 * is conservative rather than wrong.
 */
import type { JobSourceType } from '@crm/shared'
import { ARBEITNOW_MAX_BYTES } from '../providers/sources/arbeitnow.provider'
import { GERMANTECHJOBS_MAX_BYTES } from '../providers/sources/germantechjobs.provider'

const HOUR_MS = 60 * 60 * 1000

/** An employer-board ATS (Greenhouse/Lever/Ashby/Recruitee/…): the `_ATS` provider family. */
export function isEmployerBoard(type: JobSourceType): boolean {
  return type.endsWith('_ATS')
}

/**
 * The provider's own freshness allowance — how old the newest item may be before the feed is
 * STALE. ADR section 10: Remotive 24 h, Jobicy 3 h. Providers not listed here declare no allowance
 * (STALE_FEED cannot fire for them until one is added).
 */
const FRESHNESS_MAX_AGE_MS: Partial<Record<JobSourceType, number>> = {
  REMOTIVE_API: 24 * HOUR_MS,
  JOBICY_API: 3 * HOUR_MS,
}

export function freshnessMaxAgeMsFor(type: JobSourceType): number | null {
  return FRESHNESS_MAX_AGE_MS[type] ?? null
}

/**
 * A provider's known policy deadline after which it may stop serving us (ADR section 10: Recruitee
 * 2027-02-10). `DEADLINE_NEAR` fires within 30 days of it. A `type` with no known deadline yields
 * null.
 */
const POLICY_DEADLINE_ISO: Partial<Record<JobSourceType, string>> = {
  RECRUITEE_ATS: '2027-02-10T00:00:00.000Z',
}

export function policyDeadlineFor(type: JobSourceType): Date | null {
  const iso = POLICY_DEADLINE_ISO[type]
  return iso === undefined ? null : new Date(iso)
}

/**
 * Declared per-source response byte caps.
 *
 * Sources with a declared cap evaluate a near-cap early warning (the run's average page >= 80% of
 * the declared per-page cap) via `detectSlowdownGrowth` (`PAYLOAD_GROWTH`), which `alertStateOf`
 * sends to ADMINs on entry, before the cap fails the run.
 */
const DECLARED_BYTE_CAPS: Partial<Record<JobSourceType, number>> = {
  // The cap the Arbeitnow request declares, not the shared ceiling it happens to equal today.
  ARBEITNOW_API: ARBEITNOW_MAX_BYTES,
  // The 4 MiB cap the GermanTechJobs request declares. The near-cap warning is evaluated only for
  // allow-listed sources (`ALLOWLISTED_BYTE_CAP_SOURCES`), so this entry declares the cap but does not
  // by itself enable the warning.
  GERMANTECHJOBS_API: GERMANTECHJOBS_MAX_BYTES,
}

export function declaredCapBytesFor(type: JobSourceType): number | null {
  return DECLARED_BYTE_CAPS[type] ?? null
}
