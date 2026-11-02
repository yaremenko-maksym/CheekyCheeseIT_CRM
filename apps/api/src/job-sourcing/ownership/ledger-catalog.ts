import type { JobSourceType } from '@crm/shared'
import type { DetailMode } from '../providers/detail-mode'
import type { ActivationFacts } from '../registry/activation'
import type { BanScope, HostPolicy } from '../scheduling/host-policy'
import type { FetchProfile } from '../scheduling/next-slot'

/**
 * What the run ledger must know about the manifest (r5 Task 2.5 T3), as a port.
 *
 * The manifest itself is excluded from the production build (it reads fixture files), so the ledger
 * never imports it: it is constructed with a catalog. `buildLedgerCatalog` in
 * `providers/manifest.ledger-catalog.ts` builds one from a manifest; T7 owns wiring one in
 * production. The ledger reads the host policy HERE, never from a claim's caller, so a caller
 * cannot loosen a host's rate by building its own policy (T8 backlog: "claimHostSlot trusts the
 * policy argument").
 */
export interface LedgerCatalogEntry {
  /** The entry's type. A `job_sources` row of another type pointing at it is not resolved. */
  readonly type: JobSourceType
  /** The TYPE's activation facts at `at` (T2's `activationFactsByType`), evaluated at the DB clock. */
  activationFacts(at: Date): ActivationFacts
  /** The ENTRY's own `readinessAt(entry, at).status`, evaluated at the DB clock. */
  entryReadiness(at: Date): 'CANDIDATE' | 'BLOCKED' | 'LEGACY'
  /** The type's manifest declares a quota: a source of it without a meter fails closed. */
  readonly quotaDeclared: boolean
  /**
   * When the entry is next due (source fetch strategy U1b): `nextSlot`'s profile. `null` = never
   * scheduled (owner, Q8): a scheduled claim refuses it and a finish leaves no next attempt.
   */
  readonly fetchProfile: FetchProfile | null
  /** The type's `minIntervalHoursFloor`. */
  readonly floorHours: number
  /**
   * U11 (SR-H-1): the most requests one run of this type may send, enforced at runtime by the
   * collection context so the per-host budget is a true upper bound. Defaults to 1 for a list-only
   * type.
   */
  readonly requestsPerRun: number
  /**
   * T7 (SR-M-24): what a 403 bans. Absent reads as `HOST` -- anything but a literal `SOURCE` scope
   * bans the host key, so an entry that forgot it fails toward stopping.
   */
  readonly banScope?: BanScope
  /**
   * SFS U10 (ADR 6a): `ON_DEMAND` reads the list without the description and fetches each posting's
   * detail on demand; `IN_LIST` (the default) carries it in the list. The run worker's detail tail
   * runs only for an `ON_DEMAND` entry. Absent reads as `IN_LIST` (a pre-U10 fake needs no change).
   */
  readonly detailMode?: DetailMode
  /** `ON_DEMAND` only: how many pending detail fetches one run claims after its list phase; else `null`. */
  readonly detailPerRun?: number | null
}

export interface LedgerCatalog {
  /** The entry `job_sources.manifest_id` names, or undefined (the claim refuses it). */
  entry(manifestId: string): LedgerCatalogEntry | undefined
  /** The merged policy of a host key, or undefined (the claim refuses it, fail closed). */
  hostPolicy(hostKey: string): HostPolicy | undefined
  /** SFS U10: the source types whose `detailMode` is `ON_DEMAND` (empty until a source is flipped). */
  onDemandTypes(): readonly JobSourceType[]
}
