import { JOB_HOST_KEY_MAX, JOB_HOST_KEY_PATTERN } from '../../database/schema/job-patterns'

/**
 * The host vocabulary the production claim and ban paths share with the manifest (r5 Task 2.5 T8).
 * It lives HERE, not in `providers/manifest.hosts.ts`, because the manifest modules are excluded
 * from the production build: production code may not import them, and the manifest imports this.
 */

/** What a 403 bans: the host key (`HOST`, the default) or only the refused source (`SOURCE`). */
export type BanScope = 'HOST' | 'SOURCE'

export interface HostRate {
  /** At most this many claims in any 60 s: a claim waits `60 / perMinute` s after the last one. */
  readonly perMinute: number
  /** At most this many claims in the trailing 24 h. */
  readonly perDay: number
}

/**
 * A request-counting budget for a host (source fetch strategy U11, ADR section 8). Unlike `HostRate`
 * (which counts CLAIMS and so holds only for one request a run), this counts REQUESTS across the
 * trailing window, so it is the limiter a multi-board host needs at scale. Owner decision 11
 * (2026-10-26): a multi-board host starts at `perMinute: 2`, `perHour: 120`; a raise is a manual
 * manifest edit, never automatic.
 */
export interface HostRequestBudget {
  /** At most this many requests in the trailing 60 s (finished + in-flight + the claim's own). */
  readonly perMinute: number
  /** At most this many requests in the trailing 3600 s. */
  readonly perHour: number
}

/** What the claim and ban paths need to know about one host key, merged over every type on it. */
export interface HostPolicy {
  /** The strictest rate any type on the host declares, or null when none declares one. */
  readonly rate: HostRate | null
  /** The longest `minIntervalHoursFloor` of any type on the host (0 when none declares one). */
  readonly floorHours: number
  /**
   * The request-counting budget (U11), merged to the strictest any type on the host declares.
   * Absent or null: the host declares none and the claim behaves exactly as T8 (no new gap).
   */
  readonly requestBudget?: HostRequestBudget | null
  /**
   * The requests one run on this host is expected to send (U11), the largest any type on the host
   * declares. Used for the claim's own expected requests and for in-flight STARTED runs. Absent
   * reads as 1. Only consulted when `requestBudget` is set.
   */
  readonly requestsPerRun?: number
}

const HOST_KEY = new RegExp(JOB_HOST_KEY_PATTERN)

/** A key the database CHECK would accept: the same pattern and the same length bound. */
export function isValidHostKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= JOB_HOST_KEY_MAX && HOST_KEY.test(key)
}
