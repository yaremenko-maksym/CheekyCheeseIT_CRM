import { sql } from 'drizzle-orm'
import { enqueueDerivedDirty } from './ownership/dirty-work.store'
import type { SqlExecutor } from './scheduling/host-state'

/**
 * Roster-side dirty producers (r5 Task 4.6 S5). Each is ONE call a service makes inside the
 * transaction of its own write, so the dirty row commits or rolls back with the write: a
 * vacancy's matches can never miss a roster change that happened, and never recompute for one
 * that did not. The worker fans every such row out to the opportunities (`runtime/roster-fanout`).
 *
 * The version is derived (decision D2, see DERIVED VERSION in `ownership/dirty-work.store.ts`).
 */

/** Reasons, bounded by `ck_job_dirty_work_reason_bounded`; they name the write, for the log. */
export type SeniorDirtyReason =
  'senior.stack' | 'senior.role' | 'senior.archive' | 'senior.unarchive' | 'senior.team'
export type ExclusionDirtyReason = 'exclusion.create' | 'exclusion.delete'
export type ProjectClientDirtyReason = 'project.create' | 'project.client'

/**
 * A SENIOR's stack, archive state or team membership changed. A user who is not a SENIOR after
 * the write is on nobody's roster, so nothing is enqueued (`markRoleDirty` covers leaving it).
 * The role is read in the caller's transaction, so it sees the caller's own write.
 */
export async function markSeniorDirty(
  tx: SqlExecutor,
  userId: string,
  reason: SeniorDirtyReason,
): Promise<boolean> {
  const { rows } = await tx.execute(sql`SELECT role FROM users WHERE id = ${userId}::uuid`)
  if (rows[0]?.['role'] !== 'SENIOR') return false
  await enqueueDerivedDirty(tx, 'SENIOR', userId, reason)
  return true
}

/** A role change: the roster changes only when the user becomes or stops being a SENIOR. */
export async function markRoleDirty(
  tx: SqlExecutor,
  userId: string,
  from: string,
  to: string,
): Promise<boolean> {
  if (from === to || (from !== 'SENIOR' && to !== 'SENIOR')) return false
  await enqueueDerivedDirty(tx, 'SENIOR', userId, 'senior.role')
  return true
}

/**
 * A user row edit (`set` is what the UPDATE wrote). A role change into or out of SENIOR, else a
 * stack edit of a SENIOR, is one dirty row; any other edit is none.
 */
export async function markUserEditDirty(
  tx: SqlExecutor,
  userId: string,
  fromRole: string,
  set: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  if ('role' in set && (await markRoleDirty(tx, userId, fromRole, String(set['role'])))) return true
  if ('techStack' in set) return markSeniorDirty(tx, userId, 'senior.stack')
  return false
}

/** A job exclusion was created or deleted (the row may be gone: the version does not need it). */
export async function markExclusionDirty(
  tx: SqlExecutor,
  exclusionId: string,
  reason: ExclusionDirtyReason,
): Promise<void> {
  await enqueueDerivedDirty(tx, 'EXCLUSION', exclusionId, reason)
}

/** The project columns `deriveProjectExclusions` / `loadRoster` read (archive does not count). */
const PROJECT_CLIENT_COLUMNS = ['name', 'companyName', 'seniorId'] as const

/** A project UPDATE (`set` is what it wrote): dirty only when it wrote a client-deriving column. */
export async function markProjectEditDirty(
  tx: SqlExecutor,
  projectId: string,
  set: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  if (!PROJECT_CLIENT_COLUMNS.some((c) => c in set)) return false
  await markProjectClientDirty(tx, projectId, 'project.client')
  return true
}

/** A project's client, name or senior changed: the senior's derived exclusions may differ. */
export async function markProjectClientDirty(
  tx: SqlExecutor,
  projectId: string,
  reason: ProjectClientDirtyReason,
): Promise<void> {
  await enqueueDerivedDirty(tx, 'PROJECT_CLIENT', projectId, reason)
}
