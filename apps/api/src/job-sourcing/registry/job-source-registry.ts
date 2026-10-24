import type { JobSourceType } from '@crm/shared'
import type { JobSourceProvider } from '../job-source.provider'
import { type ActivationFacts, type ActivationStatus, activationOf } from './activation'
import type { RegisteredAdapter } from './registered-adapter'

/** Two adapters claimed one `JobSourceType`. Thrown while the registry is built, i.e. at startup. */
export class DuplicateJobSourceTypeError extends Error {
  constructor(readonly sourceType: JobSourceType) {
    super(`Job source type ${sourceType} is registered twice; a type has exactly one adapter`)
    this.name = 'DuplicateJobSourceTypeError'
  }
}

/**
 * THE registry of job-source adapters (r5 Task 2.5 T2): one adapter per `JobSourceType`, duplicates
 * rejected when it is constructed, which Nest does while the module initialises.
 *
 * It replaces the `providers` map that `JobSourcingService` used to build for itself. There is no
 * second map beside it and no optional constructor argument that changes the pipeline.
 *
 * !! MERGING THIS MAKES NO SOURCE RUNNABLE. In production it holds DOU only (legacy contract).
 * Nothing builds a `CollectionContext` and nothing claims a run (T3/T7), so a registered reporting
 * adapter would still not be executed by anything.
 */
export class JobSourceRegistry {
  private readonly byType: ReadonlyMap<JobSourceType, RegisteredAdapter>

  constructor(adapters: readonly RegisteredAdapter[]) {
    const byType = new Map<JobSourceType, RegisteredAdapter>()
    for (const adapter of adapters) {
      if (byType.has(adapter.type)) throw new DuplicateJobSourceTypeError(adapter.type)
      byType.set(adapter.type, adapter)
    }
    this.byType = byType
  }

  get(type: JobSourceType): RegisteredAdapter | undefined {
    return this.byType.get(type)
  }

  types(): JobSourceType[] {
    return [...this.byType.keys()]
  }

  /**
   * The provider the CURRENT pipeline can run: a legacy adapter's. A reporting adapter is not
   * returned: the pipeline has no way to run one yet.
   */
  legacyProvider(type: JobSourceType): JobSourceProvider | undefined {
    const adapter = this.byType.get(type)
    return adapter?.contract === 'LEGACY' ? adapter.provider : undefined
  }

  /** The activation status of one type, given the manifest facts for it (if any). */
  activation(type: JobSourceType, facts?: ActivationFacts): ActivationStatus {
    return activationOf(this.byType.get(type), facts)
  }

  /**
   * The ACTIVATION QUERY: registered types that may be switched on. A type missing from `facts` is
   * judged without facts (a reporting adapter is then `NOT_VERIFIED`). `enabled` on a source row is
   * never consulted here and never sufficient.
   */
  activatable(facts: ReadonlyMap<JobSourceType, ActivationFacts>): JobSourceType[] {
    return this.types().filter((t) => this.activation(t, facts.get(t)) === 'ACTIVATABLE')
  }
}
