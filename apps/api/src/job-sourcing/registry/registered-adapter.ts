import type { JobSourceType } from '@crm/shared'
import type { JobSourceProvider } from '../job-source.provider'
import type { ReportingJobSourceProvider } from '../providers/reporting-provider'

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

/** A phase-3 adapter on the reporting contract. Registered for activation, never run by this task. */
export class ReportingAdapter {
  readonly contract = 'REPORTING' as const

  readonly type: JobSourceType

  constructor(readonly provider: ReportingJobSourceProvider) {
    this.type = provider.type
  }
}
