import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type * as schema from '../../database/schema'
import type { NormalizedPosting } from '../job-source.provider'
import type { SavedPage } from '../ownership/job-run-ledger'
import { LEGACY_RUN_ADAPTER_VERSION } from '../ownership/legacy-run-claim'
import { type SourceObservation, buildSourceObservation } from '../normalize/observation'
import type { ValidatedCheckpoint } from '../providers/reporting-provider'
import { chunkPage, saveObservationPage } from '../store/source-record.store'
import type { BridgeRun } from './bridge-delivery'
import { douPostingToRawObservation } from './dou-observation'

/**
 * r5 Task 4.6 S6d — T2, the observation-store write (ADR `2026-10-31-dou-bridge-run-ownership.md`,
 * section 2). Best-effort and pure of service state (moved out of the service, CR-M-3): it takes the
 * store db, the owned run, the postings and a log sink. Covers the S6e *mapping* (S6e keeps the
 * golden + the 50-item yield).
 */

type Db = NodePgDatabase<typeof schema>

/**
 * The T2 page checkpoint for a DOU run. DOU is a single full-feed fetch, not a paginated cursor, so
 * the position is a fixed marker; the ledger's writer only structurally validates it
 * (`validatedCheckpointSchema`) and never resumes a LEGACY run from it.
 */
export function douCheckpoint(): ValidatedCheckpoint {
  return {
    configVersion: 1,
    policyVersion: 1,
    adapterVersion: LEGACY_RUN_ADAPTER_VERSION,
    position: { kind: 'CURSOR', page: 1, cursor: 'dou-full-feed' },
    completedAt: new Date(),
  }
}

/**
 * The pure half of T2 (covers the S6e mapping): map the DOU postings to observations, counting the
 * items the validator refuses. No DB. Kept separate so it is unit-testable (the store write is not).
 */
export function mapDouObservations(postings: readonly NormalizedPosting[]): {
  observations: SourceObservation[]
  refused: number
} {
  const observations: SourceObservation[] = []
  let refused = 0
  for (const p of postings) {
    const mapped = buildSourceObservation(douPostingToRawObservation(p))
    if (mapped.ok) observations.push(mapped.observation)
    else refused += 1
  }
  return { observations, refused }
}

/**
 * T2 — map the DOU postings to observations and write them to the store (chunked), best-effort. An
 * item the validator refuses is skipped and logged; a store-write failure is logged and the DOU run
 * is NOT failed (Q3). Counters go through `saveObservationPage` → `writePageCheckpoint`
 * (ledger-side), never a direct service UPDATE of `job_collection_runs`.
 */
export async function storeObservations(
  db: Db,
  run: BridgeRun,
  postings: readonly NormalizedPosting[],
  log: (message: string) => void,
): Promise<void> {
  try {
    const { observations, refused } = mapDouObservations(postings)
    if (refused > 0) {
      log(`DOU observation mapping skipped ${refused} item(s) the validator refused`)
    }
    // Stryker disable next-line all: the empty-page skip's "always skip" variant is only observable
    // on a non-empty page, which is the store path — covered by compat-barrier.integration (parity).
    if (observations.length === 0) return
    const page: SavedPage = { observations, checkpoint: douCheckpoint() }
    // Stryker disable next-line all: the page write runs only against a real DB — covered by
    // compat-barrier.integration (parity + the T2-failure case); the unit gate cannot run a tx.
    for (const chunk of chunkPage(page)) {
      await saveObservationPage(db, run.handle, chunk)
    }
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    // Stryker disable next-line all: the catch fires only on a real store-write failure — asserted
    // by compat-barrier.integration "T2 store failure swallowed"; unreachable under the unit gate.
    log(`DOU observation store write failed (run not failed): ${detail}`)
  }
}
