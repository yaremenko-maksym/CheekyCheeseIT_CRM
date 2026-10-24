import type { DouRssProvider } from '../dou.provider'
import { JobSourceRegistry } from './job-source-registry'
import { LegacyDouAdapter } from './registered-adapter'

/**
 * The registry the application runs with: DOU on the legacy contract, nothing else. Phase-3
 * adapters are NOT added here; they join with the run worker (T7), not before.
 */
export function createProductionRegistry(dou: DouRssProvider): JobSourceRegistry {
  return new JobSourceRegistry([new LegacyDouAdapter(dou)])
}
