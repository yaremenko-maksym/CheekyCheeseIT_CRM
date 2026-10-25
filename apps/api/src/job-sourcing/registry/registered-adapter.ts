import type { JobSourceType } from '@crm/shared'
import type { JobSourceProvider } from '../job-source.provider'
import type {
  ReportingJobSourceProvider,
  ValidatedSourceConfig,
} from '../providers/reporting-provider'

/**
 * What the registry holds: ONE entry per `JobSourceType`, tagged with the contract it implements.
 * Two contracts coexist on purpose (plan A1h / C-20: DOU stays on the legacy one); two REGISTRIES
 * would disagree silently, so there is exactly one.
 */
export type RegisteredAdapter = LegacyDouAdapter | ReportingAdapter

/** The one type allowed on the legacy contract (plan A1h / C-20). */
export const LEGACY_SOURCE_TYPE: JobSourceType = 'DOU_RSS'

/**
 * DOU, wrapped. The wrapper adds nothing to behaviour: it only makes the legacy contract an explicit,
 * named case of the registry instead of a special case of the service's constructor.
 *
 * It REFUSES any provider that is not DOU: the legacy contract skips every manifest check at
 * activation, so wrapping a phase-3 provider here would silently exempt it.
 */
export class LegacyDouAdapter {
  readonly contract = 'LEGACY' as const

  readonly type: JobSourceType

  constructor(readonly provider: JobSourceProvider) {
    if (provider.type !== LEGACY_SOURCE_TYPE) {
      throw new TypeError(
        `LegacyDouAdapter wraps ${LEGACY_SOURCE_TYPE} only; got ${String(provider.type)}`,
      )
    }
    this.type = provider.type
  }
}

/** The exact hosts one source's requests may reach, from the ADAPTER-PARSED config. */
export type AllowedHostsOf = (config: ValidatedSourceConfig) => readonly string[]

/**
 * How a reporting adapter is wired to the transport (r5 Task 2.5 T3 gate, T6 fills it in). Absent
 * means NOT wired: the run ledger refuses to claim a source whose adapter declares no
 * `allowedHosts` (`TRANSPORT_NOT_WIRED`, SR-M-16) or no version to stamp on its run row.
 *
 * `allowedHosts` is a fixed list for an adapter with one API host, or a function of the parsed
 * config for a tenant-subdomain one (Recruitee, Personio) or a regional one (Lever). The transport
 * matches hosts EXACTLY (no suffix, no wildcard), so a tenant's host is named, never its apex.
 */
export interface ReportingWiring {
  readonly adapterVersion?: string
  readonly allowedHosts?: readonly string[] | AllowedHostsOf
}

/** A phase-3 adapter on the reporting contract. Registered for activation, never run by this task. */
export class ReportingAdapter {
  readonly contract = 'REPORTING' as const

  readonly type: JobSourceType

  readonly adapterVersion: string | null

  /** Whether the adapter declares hosts at all; without them it is never claimed. */
  readonly transportWired: boolean

  private readonly hostsOf: AllowedHostsOf

  constructor(
    readonly provider: ReportingJobSourceProvider,
    wiring: ReportingWiring = {},
  ) {
    this.type = provider.type
    this.adapterVersion = wiring.adapterVersion ?? null
    const declared = wiring.allowedHosts ?? []
    if (typeof declared === 'function') {
      this.transportWired = true
      this.hostsOf = declared
    } else {
      const fixed = Object.freeze([...declared])
      this.transportWired = fixed.length > 0
      this.hostsOf = () => fixed
    }
  }

  /** The hosts the transport is pinned to for this source (a fresh frozen copy). */
  allowedHostsFor(config: ValidatedSourceConfig): readonly string[] {
    return Object.freeze([...this.hostsOf(config)])
  }
}
