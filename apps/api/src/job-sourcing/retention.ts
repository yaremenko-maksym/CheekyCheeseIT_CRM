import { VACANCY_RETENTION_ENABLED_SCHEMA } from '../config/env'

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
   * The bridged opportunity carries rows in `job_queue_actions`. Every parent FK out
   * of the action log is RESTRICT, so once a posting is bridged, a DELETE of its
   * opportunity is refused with `23503` BY DESIGN (r5 §1.4, carried from Task 1.2) —
   * the legal deletion of such a record is a tombstone: an UPDATE clearing text and
   * keeping the row.
   *
   * NOT A LIVE DEFENCE TODAY, and the wording used to imply otherwise: the legacy
   * `job_postings` store and the new `job_queue_*` store are FK-DISJOINT, so no
   * statement `purgeStalePostings` can issue is capable of reaching a `23503` at
   * all. This flag is INTENT for the SQL mirror that the bridging task must write —
   * it records which rows that future statement may not touch, so the rule exists
   * before the first statement that could break it.
   */
  hasLoggedActions: boolean
  /** An input to a backfill that has not been verified yet — protected until it is. */
  unverifiedBackfillInput: boolean
}

/**
 * Owner decision 2026-11-25: a vacancy lives at most this many days from its publication date
 * (`published_at`, else `first_seen_at`), in both stores. The new store's purge is
 * `store/opportunity-purge.ts`; the legacy store's is `POSTING_RETENTION_DAYS`; collection does not
 * create a posting already older than this (`isPastRetention`).
 */
export const VACANCY_RETENTION_DAYS = 60

const DAY_MS = 24 * 60 * 60 * 1000

/** A publication date older than `VACANCY_RETENTION_DAYS` before `now`; no date is never past it. */
export function isPastRetention(publishedAt: Date | null | undefined, now: Date): boolean {
  if (publishedAt == null) return false
  return publishedAt.getTime() < now.getTime() - VACANCY_RETENTION_DAYS * DAY_MS
}

/**
 * The vacancy-retention kill switch (SR-M-3). **Default on.** Declared, documented and
 * boot-validated as `VACANCY_RETENTION_ENABLED` in `config/env.ts`, read here from the environment
 * directly (the `meetingRecorderAutoMatchEnabled` pattern) because its readers are store functions
 * with no injector: the record closers, the availability re-derive, the legacy purge and the
 * sweep cron. It parses with the boot schema itself (`VACANCY_RETENTION_ENABLED_SCHEMA`, SR-M-6):
 * "true"/"false" in any case, unset is on, anything else throws (boot already refused it).
 * Off, nothing is removed by this feature: closers write CLOSED/EXPIRED as before it, the sweep
 * does not run, and the legacy purge keeps its previous `LEGACY_POSTING_RETENTION_DAYS`.
 */
export function vacancyRetentionEnabled(): boolean {
  return VACANCY_RETENTION_ENABLED_SCHEMA.parse(process.env['VACANCY_RETENTION_ENABLED'])
}

/**
 * NOT A RUNTIME SWITCH. A policy value fed only to `shouldKeepPosting`, the pure twin of the legacy
 * purge's SQL, whose callers are all in its own spec; nothing in production reads it. The runtime
 * switch for retention is `vacancyRetentionEnabled` (`VACANCY_RETENTION_ENABLED`). The value
 * tracks the owner's decision (2026-11-25: cleanup on, `VACANCY_RETENTION_DAYS`).
 *
 * This carries no duration on purpose. The two-year period for `job_queue_actions` is a literal
 * inside the trigger body and the purge function, pinned by checksum in the catalog check, and a
 * third copy in TypeScript would defeat that pinning.
 */
export interface RetentionPolicy {
  newStoreCleanupEnabled: boolean
}

/** The policy value: ON (owner 2026-11-25); the unit spec pins it. Not a switch (see above). */
export const NEW_STORE_CLEANUP_ENABLED: RetentionPolicy = { newStoreCleanupEnabled: true }

/** The switch OFF, for a caller (and the spec) that must keep every new-store record. */
export const NEW_STORE_CLEANUP_DISABLED: RetentionPolicy = { newStoreCleanupEnabled: false }

/*
 * FUTURE RETENTION RULE for `job_dirty_work` (r5 Task 4.6 S5, CR-M-3 / SR-L-3). Nothing deletes
 * from that table today, and `ownership/dirty-work.retention-guard.spec.ts` fails the build if
 * anything starts to. The reason: the version of a SENIOR / EXCLUSION / PROJECT_CLIENT entity is
 * DERIVED as the highest `target_version` among its own rows (DERIVED VERSION in
 * `ownership/dirty-work.store.ts`). A cleanup that removed an entity's newest row would reset that
 * counter, so an older row could look current or a new one be swallowed by `ON CONFLICT`. Whoever
 * adds retention here MUST keep the newest row per (entity_kind, entity_id) of those three kinds,
 * may delete only terminal rows (DONE / DEFERRED / FAILED), and updates the guard spec with it.
 * Fan-out OPPORTUNITY rows (`fanout:<root>`) are the bulk of the growth and are safe to purge once
 * terminal.
 */

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
 * THE NEW-STORE CLAUSES BELOW HAVE NO SQL COUNTERPART, AND NO PRODUCTION CALLER
 * SUPPLIES THEM — stated plainly, because the first version of this comment called
 * that "agreement rather than drift" and the claim was vacuous (CR-M-2). What is
 * actually true:
 *   - every call site of this function today is in its own spec, and all of them
 *     pass two arguments, so `observation` and `policy` are unreachable in
 *     production. The clauses are ANTICIPATORY, not live;
 *   - the two sides do not agree even in principle. For an observed, stale,
 *     undecided row this function KEEPS the row while the SQL DELETES it. They
 *     coincide only because nothing supplies an observation, i.e. because the
 *     anticipated input never arrives — not because the predicates match.
 * So: this is the pure twin of a predicate the SQL does not have yet, and it
 * DIVERGES FROM THE SQL THE MOMENT A CALLER SUPPLIES AN OBSERVATION. Whoever wires
 * the new store into retention must land the mirrored SQL conjuncts in the same
 * change, or the two sides will disagree in production rather than on paper. The
 * three legacy clauses above are a true mirror today and are what the existing
 * integration cases exercise.
 */
export function shouldKeepPosting(
  row: RetentionRow,
  cutoff: Date,
  policy: RetentionPolicy = NEW_STORE_CLEANUP_ENABLED,
): boolean {
  // ── legacy predicate — mirrored by the SQL in purgeStalePostings ──
  if (row.collectedAt >= cutoff) return true
  if (row.queueStatus !== 'NEW') return true
  if (row.decidedBySenior) return true

  // ── new-store context (r5 §1.4) ──
  const obs = row.observation
  if (obs === undefined) return false
  // `.getTime()` on both sides rather than comparing the `Date` objects directly, and
  // the null guard beside it, are ONE decision with a measured justification (fix
  // round 1). Written the obvious way — `obs.lastObservedAt !== null &&
  // obs.lastObservedAt >= cutoff` — the guard is REDUNDANT: `null >= aDate` is `false`
  // in JavaScript, so the conjunction returns exactly what its second operand returns
  // for every input, and the mutation gate rightly flagged the collapse to `true` as a
  // surviving mutant that no test can kill. The three available answers were measured
  // rather than argued:
  //   - keep the redundant guard and suppress the mutant — a clause no test can kill;
  //   - delete the guard — does NOT COMPILE: `TS18047: 'obs.lastObservedAt' is possibly
  //     'null'` under strict null checks, and the only way through is a `!` assertion
  //     that tells the type system something the type does not say;
  //   - compare timestamps, which is this line: the guard stops being decorative and
  //     starts preventing a `TypeError`, so collapsing it to `true` is now KILLED (six
  //     cases go red, among them "a null lastObservedAt is NOT a date").
  // It also removes the coercion hazard on its own terms: a record that has never been
  // observed can no longer compare as though it had been observed at the epoch.
  // `>=` and not `>`: a record observed exactly AT the cutoff is still observed, and
  // that boundary has its own case — it is the clause likeliest to drift from the SQL.
  if (obs.lastObservedAt !== null && obs.lastObservedAt.getTime() >= cutoff.getTime()) return true
  if (obs.hasLoggedActions) return true
  if (obs.unverifiedBackfillInput) return true
  return !policy.newStoreCleanupEnabled
}
