import { sql } from 'drizzle-orm'

import type { DatabaseService } from '../../database/database.service'

/**
 * task-onchain-payment-integrity — TEST-ONLY cleanup for `consumed_tx_hashes`.
 *
 * The registry deliberately OUTLIVES its referent in production: deleting a
 * payout must never free its on-chain hash for re-use. That makes it hostile to
 * integration suites, which re-use a handful of fixed test hashes
 * (`0x1111…`, `0xaaaa…`) across files and runs — the second run would get a
 * perfectly legitimate «хеш уже использован» rejection.
 *
 * Deleting by `consumed_by_user_id` does NOT work: that FK is
 * `ON DELETE SET NULL`, so as soon as a suite drops its seeded users in
 * `afterAll` the rows become un-attributable orphans.
 *
 * So we sweep exactly the rows that are provably garbage: those whose
 * `reference_id` no longer points at a payout_request or a transaction. Live
 * settlements are never touched, and leftovers from OTHER suites (or from an
 * aborted previous run) are cleaned too — which is what makes re-runs
 * deterministic.
 *
 * Call it from `clearAll()` AFTER deleting transactions / payout_requests.
 */
export async function sweepOrphanConsumedTxHashes(dbSvc: DatabaseService): Promise<void> {
  await dbSvc.db.execute(sql`
    DELETE FROM consumed_tx_hashes c
     WHERE NOT EXISTS (SELECT 1 FROM payout_requests p WHERE p.id = c.reference_id)
       AND NOT EXISTS (SELECT 1 FROM transactions   t WHERE t.id = c.reference_id)
  `)
}
