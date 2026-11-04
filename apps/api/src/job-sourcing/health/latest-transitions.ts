import { and, desc, eq, inArray } from 'drizzle-orm'
import type { DatabaseService } from '../../database/database.service'
// Through the barrel, never the module: the ordered-import `public` circular-init trap documented
// in job-source-health.service.ts.
import { jobSourceHealthEvents } from '../../database/schema'

export interface LatestTransition {
  readonly toState: string | null
  readonly reasonCode: string | null
}

/**
 * The latest TRANSITION health event per source, in one bounded query (the `(source_id, at desc)`
 * index). A source with no transition is absent from the map. Shared by the ADMIN source page
 * (U7) and the source list's `healthState` (r5 Task 6.5), so both report the same state.
 */
export async function latestHealthTransitions(
  db: DatabaseService['db'],
  sourceIds: readonly string[],
): Promise<Map<string, LatestTransition>> {
  const rows = await db
    .selectDistinctOn([jobSourceHealthEvents.sourceId], {
      sourceId: jobSourceHealthEvents.sourceId,
      toState: jobSourceHealthEvents.toState,
      reasonCode: jobSourceHealthEvents.reasonCode,
    })
    .from(jobSourceHealthEvents)
    .where(
      and(
        inArray(jobSourceHealthEvents.sourceId, [...sourceIds]),
        eq(jobSourceHealthEvents.kind, 'TRANSITION'),
      ),
    )
    .orderBy(jobSourceHealthEvents.sourceId, desc(jobSourceHealthEvents.at))
  return new Map(rows.map((r) => [r.sourceId, { toState: r.toState, reasonCode: r.reasonCode }]))
}
