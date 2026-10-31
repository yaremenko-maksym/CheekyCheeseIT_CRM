/**
 * The health-event vocabularies live twice — as CHECK value lists in `schema/job-health.ts` (the
 * DB side) and as the `HealthState` / `HealthReason` unions in `job-sourcing/health/types.ts` (the
 * code side). This holds them to each other so a value added to one but not the other fails here
 * rather than at an INSERT.
 *
 * The DB-side arrays are imported through the schema barrel (`./schema`), not `./schema/job-health`
 * directly: a schema module imported in isolation can hit the circular-init order that leaves a
 * sibling table undefined, which the barrel's ordered load avoids.
 */
import { describe, expect, it } from 'vitest'
import { HEALTH_REASONS, HEALTH_STATES } from '../job-sourcing/health/types'
import { HEALTH_REASON_VALUES, HEALTH_STATE_VALUES } from './schema'

describe('job_source_health_events vocabularies', () => {
  it('the DB state list equals the HealthState union, in the same order', () => {
    expect(HEALTH_STATE_VALUES).toEqual(HEALTH_STATES)
  })

  it('the DB reason list equals the HealthReason union, in the same order', () => {
    expect(HEALTH_REASON_VALUES).toEqual(HEALTH_REASONS)
  })
})
