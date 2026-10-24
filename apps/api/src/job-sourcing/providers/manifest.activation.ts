import type { JobSourceType } from '@crm/shared'
import type { ActivationFacts } from '../registry/activation'
import { type Manifest, readinessAt } from './manifest'

/**
 * The manifest's side of activation (r5 Task 2.5 T2): what the registry needs to know about each
 * type AT A CLOCK. Readiness is evaluated here against `now`, never read from the stored
 * `job_sources.readiness` column, which is a snapshot of the seed clock and goes stale on its own
 * (Task 3.7 review, SPEC-L-2 / SR-M-2).
 *
 * Its own file, and nothing in the pipeline imports it: the manifest reads fixture files, which a
 * production process must not do. It is what the T7 run worker will be handed, built where the
 * manifest is built.
 */
export function activationFactsByType(
  manifest: Pick<Manifest, 'types'>,
  now: Date,
): ReadonlyMap<JobSourceType, ActivationFacts> {
  return new Map(
    manifest.types.map((t) => {
      const r = readinessAt(t, now)
      const facts: ActivationFacts = {
        readiness: r.status,
        blockerCodes: r.blockers.map((b) => b.code),
        payloadVerified: t.payloadVerified,
      }
      return [t.type, facts] as const
    }),
  )
}
