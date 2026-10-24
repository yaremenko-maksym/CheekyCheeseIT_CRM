import type { JobSourceType } from '@crm/shared'
import type { JobSourceProvider } from '../job-source.provider'
import type { ReportingJobSourceProvider } from '../providers/reporting-provider'

/**
 * What the registry holds: ONE entry per `JobSourceType`, tagged with the contract it implements.
 * Two contracts coexist on purpose (plan A1h / C-20: DOU stays on the legacy one); two REGISTRIES
 * would disagree silently, so there is exactly one.
 */
export type RegisteredAdapter = LegacyDouAdapter | ReportingAdapter

/**
 * DOU, wrapped. The wrapper adds nothing to behaviour: it only makes the legacy contract an explicit,
 * named case of the registry instead of a special case of the service's constructor.
 */
export class LegacyDouAdapter {
  readonly contract = 'LEGACY' as const

  constructor(readonly provider: JobSourceProvider) {}

  get type(): JobSourceType {
    return this.provider.type
  }
}

/** A phase-3 adapter on the reporting contract. Registered for activation, never run by this task. */
export class ReportingAdapter {
  readonly contract = 'REPORTING' as const

  constructor(readonly provider: ReportingJobSourceProvider) {}

  get type(): JobSourceType {
    return this.provider.type
  }
}
