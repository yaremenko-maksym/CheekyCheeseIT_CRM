import { and, eq, isNull, ne, or, sql } from 'drizzle-orm'
import type { DatabaseService } from '../../database/database.service'
import { jobModelHealthFlags, jobModelRouteDaily } from '../../database/schema'
import { MODEL_HEALTH_SERVER_TIMEOUT_MS, type ModelHealthStore } from './model-health'

type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0]

/** The §5.3 tables behind the handler's port. Staged: nothing constructs this until task 5.5b. */
export function createDrizzleModelHealthStore(db: DatabaseService['db']): ModelHealthStore {
  const flags = jobModelHealthFlags
  const write = <T>(work: (tx: Tx) => Promise<T>) =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('statement_timeout', ${`${MODEL_HEALTH_SERVER_TIMEOUT_MS}ms`}, true)`,
      )
      return work(tx)
    })
  return {
    async addRouteCounts(rows) {
      await write((tx) =>
        tx
          .insert(jobModelRouteDaily)
          .values(rows)
          .onConflictDoUpdate({
            target: [jobModelRouteDaily.day, jobModelRouteDaily.route, jobModelRouteDaily.code],
            set: { count: sql`${jobModelRouteDaily.count} + excluded.count` },
          }),
      )
    },
    async raiseFlag(flag) {
      await write((tx) =>
        tx
          .insert(flags)
          .values({ flag })
          .onConflictDoUpdate({
            target: flags.flag,
            // Still raised keeps its first raised_at, so the row says how long it has been down.
            set: {
              raisedAt: sql`CASE WHEN ${flags.clearedAt} IS NULL THEN ${flags.raisedAt} ELSE now() END`,
              clearedAt: null,
            },
          }),
      )
    },
    async clearFlag(flag) {
      await write((tx) =>
        tx
          .update(flags)
          .set({ clearedAt: sql`now()` })
          .where(and(eq(flags.flag, flag), isNull(flags.clearedAt))),
      )
    },
    // One statement, so two processes in one cycle cannot both claim a flag.
    async claimEmissions(cycleId) {
      const rows = await write((tx) =>
        tx
          .update(flags)
          .set({ lastEmittedCycleId: cycleId })
          .where(
            and(
              isNull(flags.clearedAt),
              or(isNull(flags.lastEmittedCycleId), ne(flags.lastEmittedCycleId, cycleId)),
            ),
          )
          .returning({ flag: flags.flag }),
      )
      return rows.map((r) => r.flag)
    },
  }
}
