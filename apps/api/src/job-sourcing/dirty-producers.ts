import { sql } from 'drizzle-orm'
import { rolesChanged } from '../users/role-guards.util'
import { enqueueDerivedDirty } from './ownership/dirty-work.store'
import { resumeSkills } from './runtime/recompute-inputs'
import type { SqlExecutor } from './scheduling/host-state'

/**
 * Roster-side dirty producers (r5 Task 4.6 S5). Each is ONE call a service makes inside the
 * transaction of its own write, so the dirty row commits or rolls back with the write: a
 * vacancy's matches can never miss a roster change that happened, and never recompute for one
 * that did not. The worker fans every such row out to the opportunities (`runtime/roster-fanout`).
 *
 * The version is derived (decision D2, see DERIVED VERSION in `ownership/dirty-work.store.ts`).
 * Ids are lowercased here (SR-L-1): `ParseUUIDPipe` accepts an uppercase route id, the store's
 * validation does not, and Postgres compares uuids case-insensitively anyway.
 */

/** Reasons, bounded by `ck_job_dirty_work_reason_bounded`; they name the write, for the log. */
export type SeniorDirtyReason =
  | 'senior.roles'
  | 'senior.resume'
  | 'senior.role'
  | 'senior.archive'
  | 'senior.unarchive'
  | 'senior.team'
export type ExclusionDirtyReason = 'exclusion.create' | 'exclusion.delete'
export type ProjectClientDirtyReason = 'project.create' | 'project.client'

/**
 * SENIORs' technical roles, resume, archive state or team membership changed. A user who is not a SENIOR after
 * the write is on nobody's roster, so nothing is enqueued for them (`markRoleDirty` covers
 * leaving it). Roles are read in the caller's transaction, so they see the caller's own write.
 * Several users are locked in sorted id order (SR-L-2), so two concurrent multi-user writes
 * (a senior swap) can never wait on each other's advisory locks in opposite orders.
 */
export async function markSeniorsDirty(
  tx: SqlExecutor,
  userIds: readonly string[],
  reason: SeniorDirtyReason,
): Promise<number> {
  let marked = 0
  for (const id of [...new Set(userIds.map((u) => u.toLowerCase()))].sort()) {
    const { rows } = await tx.execute(sql`SELECT role FROM users WHERE id = ${id}::uuid`)
    if (rows[0]?.['role'] !== 'SENIOR') continue
    await enqueueDerivedDirty(tx, 'SENIOR', id, reason)
    marked += 1
  }
  return marked
}

/** One SENIOR (see `markSeniorsDirty`). */
export async function markSeniorDirty(
  tx: SqlExecutor,
  userId: string,
  reason: SeniorDirtyReason,
): Promise<boolean> {
  return (await markSeniorsDirty(tx, [userId], reason)) === 1
}

/** A role change: the roster changes only when the user becomes or stops being a SENIOR. */
export async function markRoleDirty(
  tx: SqlExecutor,
  userId: string,
  from: string,
  to: string,
): Promise<boolean> {
  if (from === to || (from !== 'SENIOR' && to !== 'SENIOR')) return false
  await enqueueDerivedDirty(tx, 'SENIOR', userId.toLowerCase(), 'senior.role')
  return true
}

const rolesOf = (v: unknown): readonly string[] => (Array.isArray(v) ? v.map(String) : [])

/**
 * A user row edit (`set` is what the UPDATE wrote, `existing` the row before it). A role change
 * into or out of SENIOR, else a REAL technical-roles change of a SENIOR, is one dirty row; an
 * unchanged resubmit (CR-M-1) or any other edit (the tech stack included: matching reads roles
 * and resume skills since senior roles PR 4) is none.
 */
export async function markUserEditDirty(
  tx: SqlExecutor,
  userId: string,
  existing: { readonly role: string; readonly technicalRoles?: unknown },
  set: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  if ('role' in set && (await markRoleDirty(tx, userId, existing.role, String(set['role']))))
    return true
  if (
    'technicalRoles' in set &&
    rolesChanged(rolesOf(set['technicalRoles']), rolesOf(existing.technicalRoles))
  )
    return markSeniorDirty(tx, userId, 'senior.roles')
  return false
}

/** The resume shape the matcher reads: `content -> 'skills'` and `facts -> 'experience'`. */
export type ResumeSkillSource = { readonly content?: unknown; readonly facts?: unknown }

const field = (o: unknown, key: string): unknown =>
  typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[key] : undefined

/** The matcher-read skill set of one resume side, canonicalised exactly as `loadRoster` reads it. */
const skillsOf = (r: ResumeSkillSource): string =>
  (resumeSkills(field(r.content, 'skills'), field(r.facts, 'experience')) ?? []).join('\u0000')

/**
 * A SENIOR's resume was written (`change.before` is the row before it, `change.after` the row
 * after; a deleted resume is `{}`). Dirty only when the skill set the matcher actually reads
 * changed (SR-L-1): a summary, a position title or a reordered duplicate of the same skill moves
 * no match, and an unconditional row would fan out over every opportunity for nothing. Call it
 * inside the resume write's own transaction; a non-SENIOR owner marks nothing.
 */
export async function markSeniorResumeDirty(
  tx: SqlExecutor,
  userId: string,
  change: { readonly before: ResumeSkillSource; readonly after: ResumeSkillSource },
): Promise<boolean> {
  if (skillsOf(change.before) === skillsOf(change.after)) return false
  return markSeniorDirty(tx, userId, 'senior.resume')
}

/** A job exclusion was created or deleted (the row may be gone: the version does not need it). */
export async function markExclusionDirty(
  tx: SqlExecutor,
  exclusionId: string,
  reason: ExclusionDirtyReason,
): Promise<void> {
  await enqueueDerivedDirty(tx, 'EXCLUSION', exclusionId.toLowerCase(), reason)
}

/** The project columns `deriveProjectExclusions` / `loadRoster` read (archive does not count). */
const PROJECT_CLIENT_COLUMNS = ['name', 'companyName', 'seniorId'] as const
type ProjectClient = { readonly [K in (typeof PROJECT_CLIENT_COLUMNS)[number]]?: unknown }

/** True when a project UPDATE writes a client-deriving column with a NEW value (CR-M-1). */
export const touchesProjectClient = (
  set: Readonly<Record<string, unknown>>,
  existing: ProjectClient,
): boolean => PROJECT_CLIENT_COLUMNS.some((c) => c in set && set[c] !== existing[c])

/** A project UPDATE (`set` is what it wrote): dirty only when a client-deriving value changed. */
export async function markProjectEditDirty(
  tx: SqlExecutor,
  projectId: string,
  existing: ProjectClient,
  set: Readonly<Record<string, unknown>>,
): Promise<boolean> {
  if (!touchesProjectClient(set, existing)) return false
  await markProjectClientDirty(tx, projectId, 'project.client')
  return true
}

/** A project's client, name or senior changed: the senior's derived exclusions may differ. */
export async function markProjectClientDirty(
  tx: SqlExecutor,
  projectId: string,
  reason: ProjectClientDirtyReason,
): Promise<void> {
  await enqueueDerivedDirty(tx, 'PROJECT_CLIENT', projectId.toLowerCase(), reason)
}
