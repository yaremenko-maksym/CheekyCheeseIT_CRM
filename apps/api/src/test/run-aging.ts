import type { Pool, PoolClient } from 'pg'

/**
 * `ageRun` / `ageSource` (r5 Task 2.5 T3, ADR "Rules": time is moved by AGING STORED TIMESTAMPS,
 * never by an injected clock). The ledger compares only against the database clock
 * (`clock_timestamp()`), so moving a stored instant back is the one honest way to step a spec past
 * a lease, a run's max age, a cooldown or a cadence. T8's `ageHostPause` does the same for hosts.
 *
 * Run on the MIGRATION role's pool (`CrmAppSession.admin`): a fixture write, never the statement
 * under test. Each throws when nothing was aged, so a mistyped id cannot leave a test passing on
 * un-aged data. Excluded from the production build (`tsconfig.build.json`).
 */
type Db = Pick<Pool | PoolClient, 'query'>

export type RunTimeColumn = 'lease_expires_at' | 'started_at'

function validMs(fn: string, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`${fn}: invalid ms ${ms}`)
}

/** Move a run's `lease_expires_at` (default) or `started_at` back by `ms`. */
export async function ageRun(
  db: Db,
  runId: string,
  ms: number,
  column: RunTimeColumn = 'lease_expires_at',
): Promise<void> {
  validMs('ageRun', ms)
  // One of two fixed names from the union, never input text.
  const target = column === 'started_at' ? 'started_at' : 'lease_expires_at'
  const { rowCount } = await db.query(
    `UPDATE job_collection_runs SET ${target} = ${target} - make_interval(secs => $2::double precision / 1000)
      WHERE id = $1 AND ${target} IS NOT NULL`,
    [runId, ms],
  )
  if (rowCount !== 1) throw new Error(`ageRun: no ${target} to age on run ${runId}`)
}

/**
 * Move a source's scheduling instants back by `ms`: `next_attempt_at` and, when set,
 * `cooldown_until`, together, so "the cadence and the backoff have both passed" is one call.
 */
export async function ageSource(db: Db, sourceId: string, ms: number): Promise<void> {
  validMs('ageSource', ms)
  const { rowCount } = await db.query(
    `UPDATE job_sources
        SET next_attempt_at = next_attempt_at - make_interval(secs => $2::double precision / 1000),
            cooldown_until = cooldown_until - make_interval(secs => $2::double precision / 1000)
      WHERE id = $1 AND next_attempt_at IS NOT NULL`,
    [sourceId, ms],
  )
  if (rowCount !== 1) throw new Error(`ageSource: no next_attempt_at to age on source ${sourceId}`)
}
