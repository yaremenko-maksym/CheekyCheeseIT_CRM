import type { DouRssProvider } from '../dou.provider'
import { JobSourceRegistry } from './job-source-registry'
import { LegacyDouAdapter } from './registered-adapter'

/**
 * The registry the application runs with: DOU on the legacy contract, nothing else. Phase-3
 * adapters are NOT added here; they join with the run worker (T7), not before.
 *
 * The ONE place a registry is made from a bare DOU provider: the module's factory and
 * `resolveRegistry` (the service's constructor) both go through it, so they cannot disagree.
 */
export function createProductionRegistry(dou: DouRssProvider): JobSourceRegistry {
  return new JobSourceRegistry([new LegacyDouAdapter(dou)])
}

/**
 * What `JobSourcingService` was handed: the registry, or (for callers that build the service by
 * hand, e.g. the DOU golden specs) a bare DOU provider. Anything else is refused loudly -- a
 * registry-shaped mock must not be silently wrapped as a provider with no type.
 */
export function resolveRegistry(source: JobSourceRegistry | DouRssProvider): JobSourceRegistry {
  if (source instanceof JobSourceRegistry) return source
  if (typeof (source as { type?: unknown } | null | undefined)?.type !== 'string') {
    throw new TypeError(
      'JobSourcingService needs a JobSourceRegistry or a DouRssProvider; got something with no source type',
    )
  }
  return createProductionRegistry(source)
}
