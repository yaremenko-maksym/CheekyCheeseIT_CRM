import type { JobSourceTriggerMode } from '@crm/shared'
import { type SQL, and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm'
import type { DatabaseService } from '../../database/database.service'
import { type JobSource, jobSources } from '../../database/schema'
import { MAX_CONSECUTIVE_FAILURES } from './due-policy'

/**
 * The scalar terms of the due predicate, in SQL (r5 Task 2.5 T4; ADR "The due predicate").
 *
 * What is HERE: `enabled`, `admin_state = 'ACTIVE'`, `manifest_id IS NOT NULL`, the trigger policy,
 * the failure cap, the cooldown and -- for a scheduled trigger only -- the cadence term. The clock
 * is the DATABASE's (`clock_timestamp()`), never an application `now`.
 *
 * What is NOT here, by design:
 *  - readiness. It is the manifest's `readinessAt(subject, clock)`, TypeScript, and the stored
 *    `job_sources.readiness` column is never read. Callers run `isDue` over the rows this returns.
 *  - the host term (T8) and the "already running" term (T3), which need columns and tables that
 *    other tasks create. `isDue` takes both as inputs.
 *
 * `findDueSources` is therefore a PRE-filter: every row `isDue` accepts is in its result, and
 * `isDue` makes the final call.
 */
export function dueSourcesPredicate(
  trigger: JobSourceTriggerMode,
  options: { readonly cadenceSlackMs?: number; readonly maxConsecutiveFailures?: number } = {},
): SQL {
  const slackMs = options.cadenceSlackMs ?? 0
  const cap = options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES
  const terms: (SQL | undefined)[] = [
    eq(jobSources.enabled, true),
    eq(jobSources.adminState, 'ACTIVE'),
    isNotNull(jobSources.manifestId),
    // The trigger policy: `sourceAcceptsTrigger` as a column comparison.
    or(eq(jobSources.triggerMode, 'BOTH'), eq(jobSources.triggerMode, trigger)),
    lt(jobSources.consecutiveFailures, cap),
    or(
      sql`${jobSources.cooldownUntil} IS NULL`,
      sql`${jobSources.cooldownUntil} <= clock_timestamp()`,
    ),
  ]
  // The cadence term, and the ONLY term a manual trigger drops. A NULL next_attempt_at is not due.
  if (trigger !== 'MANUAL') {
    terms.push(
      sql`${jobSources.nextAttemptAt} <= clock_timestamp() + ${slackMs} * interval '1 millisecond'`,
    )
  }
  const combined = and(...terms)
  // `and` returns undefined only for an empty list, which this never passes.
  return combined ?? sql`false`
}

/**
 * The one query: the rows that pass every scalar term of the due predicate, oldest
 * `next_attempt_at` first (the claim order of the ADR). `scope` narrows it to a set of rows (a
 * spec's own ids); production passes none.
 */
export async function findDueSources(
  db: DatabaseService['db'],
  trigger: JobSourceTriggerMode,
  options: {
    readonly cadenceSlackMs?: number
    readonly maxConsecutiveFailures?: number
    readonly onlyIds?: readonly string[]
  } = {},
): Promise<JobSource[]> {
  const predicate = dueSourcesPredicate(trigger, options)
  const where =
    options.onlyIds === undefined
      ? predicate
      : and(predicate, inArray(jobSources.id, [...options.onlyIds]))
  return db.select().from(jobSources).where(where).orderBy(jobSources.nextAttemptAt)
}
