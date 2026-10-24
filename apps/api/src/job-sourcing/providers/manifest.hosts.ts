/**
 * Host-level declarations of the manifest (r5 Task 2.5 T8; ADR
 * 2026-10-24-job-source-run-ownership.md, T8 (a) and SR-M-24).
 *
 * Per type, three facts the code cannot read from anywhere else:
 *  - `hostKey(config)`: the SCOPE the provider bans or rate-limits at. For a provider with one API
 *    host it is that host (`remotive.com`); for a tenant-subdomain provider (Recruitee, Personio) it
 *    is the provider's apex, so a provider-wide limit pauses every tenant. It is computed from the
 *    adapter-PARSED config, so a default (Lever's `region`, Personio's `tld`) is the one the adapter
 *    will actually use.
 *  - `banScope`: what a 403 bans. `HOST` (the default, Master's decision A1) pauses the host key;
 *    `SOURCE` counts the 403 as that source's own failure only. 429 and 451 always ban the host key.
 *  - `hostRate`: a provider's own request rate (`perMinute`, `perDay`) the cadence cannot express.
 *    `perDay` counts CLAIMS, so it is valid only for a type that sends one request per run.
 *
 * Nothing here reads a database or a clock. The production claim path does not import the manifest
 * (it is data, not a registry): the caller passes `hostPolicyOf(manifest, key)` in.
 */
import type { JobSourceType } from '@crm/shared'
import { JOB_HOST_KEY_MAX, JOB_HOST_KEY_PATTERN } from '../../database/schema/job-patterns'

export type BanScope = 'HOST' | 'SOURCE'

export interface HostRate {
  /** At most this many claims in any 60 s: a claim waits `60 / perMinute` s after the last one. */
  readonly perMinute: number
  /** At most this many claims in the trailing 24 h. */
  readonly perDay: number
}

export type HostKeyOf = (config: Readonly<Record<string, unknown>>) => string

/** The longest provider-documented interval floor we accept, and the largest rate figures. */
export const MAX_FLOOR_HOURS = 720
const MAX_PER_MINUTE = 60
const MAX_PER_DAY = 10_000

const HOST_KEY = new RegExp(JOB_HOST_KEY_PATTERN)

/** A key the database CHECK would accept: the same pattern and the same bound. */
export function isValidHostKey(key: unknown): key is string {
  return typeof key === 'string' && key.length <= JOB_HOST_KEY_MAX && HOST_KEY.test(key)
}

/** Why a rate declaration is refused, or null when it is valid for a type of `requestsPerRun`. */
export function hostRateProblem(rate: HostRate, requestsPerRun: number): string | null {
  if (!Number.isInteger(rate.perMinute) || rate.perMinute < 1 || rate.perMinute > MAX_PER_MINUTE) {
    return `perMinute ${rate.perMinute} is not an integer from 1 to ${MAX_PER_MINUTE}`
  }
  if (!Number.isInteger(rate.perDay) || rate.perDay < 1 || rate.perDay > MAX_PER_DAY) {
    return `perDay ${rate.perDay} is not an integer from 1 to ${MAX_PER_DAY}`
  }
  // `perDay` counts claims: with N requests a run it would let N times the provider's figure out.
  if (requestsPerRun !== 1) {
    return `perDay counts claims, and this type sends ${requestsPerRun} requests a run`
  }
  return null
}

/** What the claim and ban paths need to know about one host key, merged over every type on it. */
export interface HostPolicy {
  /** The strictest rate any type on the host declares, or null when none declares one. */
  readonly rate: HostRate | null
  /** The longest `minIntervalHoursFloor` of any type on the host (0 when none declares one). */
  readonly floorHours: number
}

export interface HostedType {
  readonly type: JobSourceType
  readonly hostRate: HostRate | null
  readonly minIntervalHoursFloor: number
}

export interface HostedEntry {
  readonly type: JobSourceType
  readonly hostKey: string
}

/**
 * The policy of `hostKey`: the types that own at least one entry on it, merged. Two types on one
 * host take the SMALLER of each rate figure and the LONGER floor, so sharing a host never loosens
 * either. A key no entry carries has no policy (`undefined`): the caller fails closed.
 */
export function hostPolicyOf(
  manifest: { readonly types: readonly HostedType[]; readonly entries: readonly HostedEntry[] },
  hostKey: string,
): HostPolicy | undefined {
  const typesOnHost = new Set(
    manifest.entries.filter((e) => e.hostKey === hostKey).map((e) => e.type),
  )
  if (typesOnHost.size === 0) return undefined
  let rate: HostRate | null = null
  let floorHours = 0
  for (const t of manifest.types) {
    if (!typesOnHost.has(t.type)) continue
    floorHours = Math.max(floorHours, t.minIntervalHoursFloor)
    if (t.hostRate === null) continue
    rate =
      rate === null
        ? t.hostRate
        : {
            perMinute: Math.min(rate.perMinute, t.hostRate.perMinute),
            perDay: Math.min(rate.perDay, t.hostRate.perDay),
          }
  }
  return { rate, floorHours }
}

/** One observed request: the real host an entry's adapter reached, and the entry's key. */
export interface HostObservation {
  readonly entryId: string
  readonly requestHost: string
  readonly hostKey: string
}

/**
 * The drift rule of T8 AC 14: sources whose requests reach one REAL host must share one key, and a
 * key must name the host it scopes (the request host itself or a parent domain of it). Returns the
 * problems found, as sentences; an empty list is a pass.
 */
export function hostKeyProblems(observations: readonly HostObservation[]): string[] {
  const problems: string[] = []
  const keysByHost = new Map<string, Set<string>>()
  for (const o of observations) {
    const keys = keysByHost.get(o.requestHost) ?? new Set<string>()
    keys.add(o.hostKey)
    keysByHost.set(o.requestHost, keys)
    if (o.requestHost !== o.hostKey && !o.requestHost.endsWith(`.${o.hostKey}`)) {
      problems.push(
        `${o.entryId}: key ${o.hostKey} does not scope its request host ${o.requestHost}`,
      )
    }
  }
  for (const [host, keys] of keysByHost) {
    if (keys.size > 1)
      problems.push(`${host} is reached under ${keys.size} keys: ${[...keys].sort().join(', ')}`)
  }
  return problems
}
