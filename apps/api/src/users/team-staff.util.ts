import { HttpStatus } from '@nestjs/common'
import { and, inArray, isNull } from 'drizzle-orm'
import { apiError } from '../common/api-error'
import { users } from '../database/schema'
import type { DrizzleTx } from '../database/types'

/**
 * SR-M-1: the single team-staff role invariant, shared by every path that enrols users into
 * a team (createUser CREATE_NEW, rejoinTeam CREATE_NEW, admin team reconcile). Every `hrIds`
 * entry must be an existing, non-archived user with role HR. One probe (`users.id IN (...) AND archived_at IS NULL`);
 * an archived or unknown id falls out of the result and so counts as invalid. Reads only, so
 * callers invoke it BEFORE their first write and a rejection leaves nothing behind.
 */
export async function assertTeamStaffRoles(
  db: Pick<DrizzleTx, 'select'>,
  hrIds: readonly string[],
): Promise<void> {
  const ids = [...hrIds]
  if (ids.length === 0) return

  const rows = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(and(inArray(users.id, ids), isNull(users.archivedAt)))
  const roleById = new Map(rows.map((r) => [r.id, r.role]))
  if (hrIds.some((id) => roleById.get(id) !== 'HR')) {
    throw apiError('TEAM_HR_MEMBER_MUST_BE_HR', HttpStatus.BAD_REQUEST)
  }
}
