import type { JobSourceTriggerMode } from '@crm/shared'
import { type SQL, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm'
import type { DatabaseService } from '../../database/database.service'
import { type JobSource, jobSources } from '../../database/schema'
import { MAX_CONSECUTIVE_FAILURES, isValidCadenceSlackMs, isValidFailureCap } from './due-policy'
import { hostOpenPredicate } from './host-state'

/**
 * The scalar terms of the due predicate, in SQL (r5 Task 2.5 T4; ADR "The due predicate").
 *
 * What is HERE: `enabled`, `admin_state = 'ACTIVE'`, `manifest_id IS NOT NULL`, the trigger policy,
 * the failure cap, the cooldown and -- for a scheduled trigger only -- the cadence term. The clock
 * is the DATABASE's (`clock_timestamp()`), never an application `now`.
 *
 * What is NOT here, by design:
 *  - readiness. It is the manifest's `readinessAt(subject, clock)` plus the payload flag,
 *    TypeScript, and the stored `job_sources.readiness` column is never read. Callers run `isDue`
 *    over the rows this returns.
 *  - the "already running" term (T3), which needs the run ledger. `isDue` takes it as an input.
 *
 * The host term (T8) IS here: `hostOpenPredicate`, which refuses a NULL `host_key` first and then a
 * host whose ban pause has not expired. DOU is never due to the ledger. The boundary in THIS query is
 * `manifest_id IS NOT NULL`: DOU has no manifest entry, so its row has none. Its NULL `host_key`
 * is a second, redundant exclusion. Neither is the explicit LEGACY allow the ADR requires; that
 * kind check is T3's claim gate and T7's routing, not part of this predicate.
 *
 * `findDueSources` is therefore a PRE-filter: every row `isDue` accepts is in its result, and
 * `isDue` makes the final call. An invalid option (a cap above the ceiling, a slack above its
 * maximum, NaN) throws: the SQL never widens what runs.
 */
export interface DueQueryOptions {
  readonly cadenceSlackMs?: number
  readonly maxConsecutiveFailures?: number
  /**
   * Source fetch strategy U3, the SWEEP predicate (ADR section 5): the cadence term is replaced by
   * "no run of this source in this cycle", so every scheduled source is due once per sweep cycle
   * whatever its slot. Nothing else is dropped: ban, cap, cooldown, trigger mode and admin state
   * stay. A NULL `next_attempt_at` (a null-profile source after its one refusal) is still never due.
   */
  readonly sweepCycleId?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function dueSourcesPredicate(
  trigger: JobSourceTriggerMode,
  options: DueQueryOptions = {},
): SQL {
  const slackMs = options.cadenceSlackMs ?? 0
  const cap = options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES
  if (!isValidCadenceSlackMs(slackMs)) throw new RangeError(`invalid cadence slack: ${slackMs}`)
  if (!isValidFailureCap(cap)) throw new RangeError(`invalid failure cap: ${cap}`)
  const terms: SQL[] = [
    eq(jobSources.enabled, true),
    eq(jobSources.adminState, 'ACTIVE'),
    isNotNull(jobSources.manifestId),
    // The trigger policy: `sourceAcceptsTrigger` as a column comparison.
    or(eq(jobSources.triggerMode, 'BOTH'), eq(jobSources.triggerMode, trigger)) as SQL,
    lt(jobSources.consecutiveFailures, cap),
    or(
      sql`${jobSources.cooldownUntil} IS NULL`,
      sql`${jobSources.cooldownUntil} <= clock_timestamp()`,
    ) as SQL,
    // T8: a source with no host key, or on a paused host, is never due -- a manual trigger included.
    hostOpenPredicate(),
  ]
  const sweep = options.sweepCycleId
  if (sweep !== undefined) {
    if (trigger !== 'SCHEDULED' || !UUID_RE.test(sweep)) throw new RangeError('invalid sweep cycle')
    terms.push(
      sql`${jobSources.nextAttemptAt} IS NOT NULL`,
      sql`NOT EXISTS (SELECT 1 FROM job_collection_runs sr WHERE sr.source_id = ${jobSources.id} AND sr.cycle_id = ${sweep}::uuid)`,
    )
  } else if (trigger !== 'MANUAL') {
    // The cadence term, and the ONLY term a manual trigger drops. A NULL next_attempt_at is not due.
    terms.push(
      sql`${jobSources.nextAttemptAt} <= clock_timestamp() + ${slackMs} * interval '1 millisecond'`,
    )
  }
  // Joined, never `and(...)`: that returns `undefined` for no terms, and an undefined WHERE selects
  // every row.
  return sql`(${sql.join(terms, sql` and `)})`
}

/**
 * The one query: the rows that pass every scalar term of the due predicate, oldest
 * `next_attempt_at` first (the claim order of the ADR). `onlyIds` narrows it to a set of rows and
 * has no production caller: it exists so a spec on a shared database reads only its own rows.
 */
export async function findDueSources(
  db: DatabaseService['db'],
  trigger: JobSourceTriggerMode,
  options: DueQueryOptions & { readonly onlyIds?: readonly string[] } = {},
): Promise<JobSource[]> {
  const predicate = dueSourcesPredicate(trigger, options)
  const where =
    options.onlyIds === undefined
      ? predicate
      : sql`${predicate} and ${inArray(jobSources.id, [...options.onlyIds])}`
  return db.select().from(jobSources).where(where).orderBy(jobSources.nextAttemptAt)
}
