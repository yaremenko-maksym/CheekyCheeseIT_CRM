/**
 * New-store context carried by a posting once it is bridged into the r5 job-queue
 * store. Absent on a legacy posting, which is the whole reason `shouldKeepPosting`
 * still reduces to the three-clause SQL predicate for every row that exists today.
 */
export interface ObservationContext {
  /**
   * When a collection run last observed this record AT THE SOURCE — not when the
   * row was inserted. r5 §1.4: "never delete an actively observed record for
   * insertion age alone", so this is compared against the same cutoff rather than
   * against a second duration of its own.
   */
  lastObservedAt: Date | null
  /**
   * The bridged opportunity carries rows in `job_queue_actions`. Every parent FK
   * out of the action log is RESTRICT, so a DELETE is refused with `23503` BY
   * DESIGN (r5 §1.4, carried from Task 1.2) — the legal deletion of such a record
   * is a tombstone: an UPDATE clearing text and keeping the row. Keeping it here
   * means the retention job never issues a statement the database must refuse.
   */
  hasLoggedActions: boolean
  /** An input to a backfill that has not been verified yet — protected until it is. */
  unverifiedBackfillInput: boolean
}

/**
 * Owner policy for new-store cleanup. r5 §1.4 freezes the durations later, and
 * until it does the cleanup stays DISABLED — see `NEW_STORE_CLEANUP_DISABLED`.
 *
 * This carries no duration on purpose. The one retention period that exists in
 * this area — two years for `job_queue_actions` — is a literal inside the trigger
 * body and the purge function, pinned by checksum in the catalog check, and a
 * third copy in TypeScript would defeat that pinning.
 */
export interface RetentionPolicy {
  newStoreCleanupEnabled: boolean
}

/**
 * The shipped policy: OFF. New-store cleanup beyond the action-log purge stays
 * disabled until the owner freezes its own durations (r5 §1.4), and the unit spec
 * pins that this default is `false` rather than trusting the comment.
 */
export const NEW_STORE_CLEANUP_DISABLED: RetentionPolicy = { newStoreCleanupEnabled: false }

export interface RetentionRow {
  collectedAt: Date
  queueStatus: 'NEW' | 'IN_PROGRESS' | 'DISMISSED'
  /** A senior APPLIED or REJECTED a suggestion for this posting (job_suggestions). */
  decidedBySenior: boolean
  /** Absent for a legacy posting; present once the record is bridged into the new store. */
  observation?: ObservationContext
}

/**
 * Whether the retention job must keep a posting.
 *
 * THIS FUNCTION AND THE SQL MIRROR EACH OTHER. The three clauses below the
 * "legacy predicate" heading are the TypeScript twin of the `WHERE` in
 * `JobSourcingService.purgeStalePostings` (`collected_at < cutoff AND
 * queue_status = 'NEW' AND NOT EXISTS (a decided suggestion)`); changing either
 * side without the other is the defect this twin exists to make visible. The pure
 * form is what the mutation gate can see at all, because the SQL path is
 * integration-only.
 *
 * IN_PROGRESS is HR's working history; DISMISSED must survive, or the vacancy
 * would be re-collected after the purge and come back as a brand-new queue row.
 *
 * The new-store clauses have no SQL counterpart YET, and that is agreement rather
 * than drift: no row carries an `observation` today (collection into the new store
 * is Phase 2+), so for every row the SQL can see, this function returns exactly
 * what the SQL predicate returns. When those columns land, the SQL gains the
 * mirrored conjuncts and this comment is the record of which ones.
 */
export function shouldKeepPosting(
  row: RetentionRow,
  cutoff: Date,
  policy: RetentionPolicy = NEW_STORE_CLEANUP_DISABLED,
): boolean {
  // ── legacy predicate — mirrored by the SQL in purgeStalePostings ──
  if (row.collectedAt >= cutoff) return true
  if (row.queueStatus !== 'NEW') return true
  if (row.decidedBySenior) return true

  // ── new-store context (r5 §1.4) ──
  const obs = row.observation
  if (obs === undefined) return false
  if (obs.lastObservedAt !== null && obs.lastObservedAt >= cutoff) return true
  if (obs.hasLoggedActions) return true
  if (obs.unverifiedBackfillInput) return true
  return !policy.newStoreCleanupEnabled
}
