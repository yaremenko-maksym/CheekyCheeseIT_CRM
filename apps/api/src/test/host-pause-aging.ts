import type { Pool, PoolClient } from 'pg'

/**
 * `ageHostPause` (r5 Task 2.5 T8, ADR round 6 CR-M-19): moves a host's stored time BACK by `ms`,
 * so a spec can step past a pause or a per-minute gap without an injected clock. The code under
 * test compares only against the DATABASE clock (`clock_timestamp()`), so aging the stored value
 * is the one honest way to move time for it. T3 reuses this beside its own `ageRun`.
 *
 * Run it on the MIGRATION role's pool (`CrmAppSession.admin`): it is a fixture write, not the
 * statement under test. It throws when no row was aged, so a mistyped key cannot leave a test
 * passing on an un-aged host.
 */
export type HostTimeColumn = 'paused_until' | 'last_claimed_at'

export async function ageHostPause(
  db: Pick<Pool | PoolClient, 'query'>,
  hostKey: string,
  ms: number,
  column: HostTimeColumn = 'paused_until',
): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`ageHostPause: invalid ms ${ms}`)
  // The column is one of two fixed names from the union above, never input text.
  const target = column === 'last_claimed_at' ? 'last_claimed_at' : 'paused_until'
  const { rowCount } = await db.query(
    `UPDATE job_source_hosts SET ${target} = ${target} - make_interval(secs => $2::double precision / 1000)
      WHERE host_key = $1 AND ${target} IS NOT NULL`,
    [hostKey, ms],
  )
  if (rowCount !== 1) throw new Error(`ageHostPause: no ${target} to age on host ${hostKey}`)
}
