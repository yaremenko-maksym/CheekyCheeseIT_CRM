import { HttpStatus } from '@nestjs/common'
import { and, eq, isNull, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { apiError } from '../common/api-error'
import { teamAuditLog, teamMembers, users } from '../database/schema'
import type * as schema from '../database/schema'
import type { DrizzleTx } from '../database/types'
import type { ProjectWithMembers } from './team-mapping.util'

/** Drizzle handle exposed by `DatabaseService.db` (non-transactional). */
export type TeamsDb = NodePgDatabase<typeof schema>

/**
 * MED-3 (security-review round 2, authz-hardening): plain active-membership
 * check (any role), exposed publicly for callers that need to scope an
 * action to "a team this user actually belongs to" without loading the
 * full team+members tree. Introduced for `UsersService.createUser`'s
 * `teamMode='JOIN_DROP_TEAM'` path — `addSeniorToDropTeam` below
 * explicitly delegates RBAC to its caller (see that method's own
 * docblock), so without this check an HR actor could attach the SENIOR
 * they are provisioning to ANY drop-team with a free senior slot, not
 * just one they belong to — reaching into another team's payment routing.
 */
export async function isActiveMemberOfTeam(
  db: TeamsDb,
  teamId: string,
  userId: string,
): Promise<boolean> {
  const row = await db.query.teamMembers.findFirst({
    where: and(
      eq(teamMembers.teamId, teamId),
      eq(teamMembers.userId, userId),
      isNull(teamMembers.leftAt),
    ),
  })
  return row !== undefined
}

/**
 * LOW (security-review round 3, follow-up to #436): scope for
 * `UsersService.rejoinTeam`'s self-service `teamMode='JOIN_DROP_TEAM'`
 * path. That endpoint is invoked by the SENIOR themselves — there is no
 * HR/ADMIN actor to scope against `isActiveMemberOfTeam` above, because
 * the whole point of a self-service endpoint is that nobody else
 * authorizes the request. Without ANY scope check, a teamless SENIOR
 * could self-attach to ANY drop-team with a free senior slot company-wide,
 * not just one they have ever been part of — combined with the accepted
 * round-1 risk (an HR actor can provision a SENIOR on an email HR
 * controls), this chains into another team's payment routing, just one
 * hop further than the path #436 already closed.
 *
 * The correct scope for a "REjoin" is a PAST `team_members` row for this
 * EXACT team **that was held as SENIOR**, not just any past row —
 * `team_members` carries no per-row role snapshot, so a plain
 * `leftAt IS NOT NULL` check (round-3 v1 of this method) cannot tell a
 * former SENIOR apart from a former HR/ACCOUNTANT/DROP member of the SAME
 * team who was later promoted to SENIOR (role change is ADMIN-only, but
 * routine `TeamsController.addMember`/`removeMember` calls make HR/
 * ACCOUNTANT/DROP membership rows trivial to create and remove — far
 * easier than the two SENIOR-only detach paths below).
 *
 * MED-1 (security-review round 3, follow-up to #436) — v1 tried to verify
 * this via NEGATIVE evidence from `team_audit_log` (treat ABSENCE of a
 * disqualifying non-SENIOR removal row as a pass). That was wrong: the
 * SENIOR-only detach paths (`archiveDropTeam`, `rotateSenior`) wrote no
 * audit row of their own either, so absence of evidence proved nothing —
 * the check's correctness quietly depended on `archiveDropTeam`'s mass,
 * un-audited HR/Accountant/DROP detach (`.update(teamMembers).set({
 * leftAt: now }).where(teamId = X AND leftAt IS NULL)`, no per-row
 * `team_member_removed` write) never being reachable again from a
 * currently-active drop-team — true only because that method always also
 * archives the team in the same call, and nothing in this codebase
 * un-archives a drop-team today. A future "unarchive drop-team" feature
 * would have silently reopened the exact HR/ACCOUNTANT/DROP→SENIOR
 * promotion chain this method exists to close, with no test or docblock
 * flagging the dependency.
 *
 * MED-1 round 4 (closed same PR): flipped to POSITIVE evidence instead.
 * `archiveDropTeam`'s senior-detach and `rotateSenior`'s senior-detach —
 * the ONLY two paths that ever move a SENIOR out of a drop-team — now
 * EACH write their own `team_member_removed` `team_audit_log` row with
 * `changes.role.before = 'SENIOR'` (see those methods). This method
 * requires that exact row to exist for `(teamId, userId)` — fail-closed:
 * no positive proof, no rejoin. This needs no migration/backfill, is
 * immune to rows that predate this fix or get imported some other way,
 * and closes both today's archive-only path AND any future
 * unarchive-drop-team path the same way, instead of depending on an
 * incidental invariant holding forever.
 *
 * Accepted cost (owner-reviewed): a SENIOR detached BEFORE this change
 * shipped has no such audit row and therefore cannot self-rejoin anymore —
 * ADMIN/HR must reattach them via `rotateSenior` (or `createUser`'s
 * `teamMode='JOIN_DROP_TEAM'`) instead. Acceptable for the team's current
 * size; the alternative (a role column on `team_members` itself) needs a
 * prod migration plus edits at every one of the half-dozen insert sites.
 */
export async function wasFormerMemberOfTeam(
  db: TeamsDb,
  teamId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .select({ id: teamAuditLog.id })
    .from(teamAuditLog)
    .where(
      and(
        eq(teamAuditLog.targetId, teamId),
        eq(teamAuditLog.action, 'team_member_removed'),
        sql`${teamAuditLog.changes} -> 'userId' ->> 'before' = ${userId}`,
        sql`${teamAuditLog.changes} -> 'role' ->> 'before' = 'SENIOR'`,
      ),
    )
    .limit(1)
    .then((rows) => rows[0])

  return row !== undefined
}

export async function fetchAllProjects(db: TeamsDb): Promise<ProjectWithMembers[]> {
  return db.query.projects.findMany({
    with: { members: { with: { user: true } } },
  }) as Promise<ProjectWithMembers[]>
}

/**
 * Helper for asserting that a user has the expected role, surfacing
 * a 400 instead of an opaque 500.
 */
export async function assertUserRole(
  db: TeamsDb,
  userId: string,
  expectedRole: 'DROP' | 'SENIOR' | 'HR' | 'ACCOUNTANT',
  tx?: DrizzleTx,
  genericMessage = false,
): Promise<void> {
  // MED (security-review #328): callers that are reachable by non-ADMIN users
  // (e.g. rotateSenior, addSeniorToDropTeam) should pass genericMessage=true
  // so that the error message does not leak whether a userId exists or what
  // role it holds — an information oracle usable for user enumeration.
  const handle = tx ?? db
  const u = await handle
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .then((rows) => rows[0])
  if (!u || u.role !== expectedRole) {
    if (genericMessage) {
      throw apiError('TEAM_USER_NOT_FOUND_OR_WRONG_ROLE', HttpStatus.BAD_REQUEST)
    }
    if (!u) throw apiError('USER_NOT_FOUND', HttpStatus.BAD_REQUEST)
    throw apiError('TEAM_UNEXPECTED_USER_ROLE', HttpStatus.BAD_REQUEST, {
      expectedRole,
      actualRole: u.role,
    })
  }
}
