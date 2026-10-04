export interface RetentionRow {
  collectedAt: Date
  queueStatus: 'NEW' | 'IN_PROGRESS' | 'DISMISSED'
  /** A senior APPLIED or REJECTED a suggestion for this posting (job_suggestions). */
  decidedBySenior: boolean
}

/**
 * Whether the retention job must keep a posting. Mirrors the SQL condition in
 * `JobSourcingService.purgeStalePostings` (`collected_at < cutoff AND
 * queue_status = 'NEW' AND id NOT IN decided`) — this pure form is the unit-level
 * twin the mutation gate can see (the SQL path is integration-only).
 *
 * IN_PROGRESS is HR's working history; DISMISSED must survive, or the vacancy
 * would be re-collected after the purge and come back as a brand-new queue row.
 */
export function shouldKeepPosting(row: RetentionRow, cutoff: Date): boolean {
  if (row.collectedAt >= cutoff) return true
  if (row.queueStatus !== 'NEW') return true
  return row.decidedBySenior
}
