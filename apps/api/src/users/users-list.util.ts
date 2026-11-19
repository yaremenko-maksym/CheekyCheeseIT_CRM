import { isNotNull, isNull, type SQL } from 'drizzle-orm'
import { users } from '../database/schema'

/**
 * Tri-state archived filter shared by the user list endpoints.
 * `'all'` -> no filter (active + archived), `true` -> archived only,
 * anything else (false / undefined) -> active only.
 */
export function resolveArchivedFilter(filter: { archived?: boolean | 'all' }): SQL | undefined {
  return filter.archived === 'all'
    ? undefined
    : filter.archived === true
      ? isNotNull(users.archivedAt)
      : isNull(users.archivedAt)
}

/**
 * Attaches `hasActiveProject` to each row, and gates `technicalRoles` on the row's
 * own role. Only JUNIOR rows can be flagged busy (member of a project with no
 * `leftAt`); every other role is `false`.
 *
 * SR-L-3: the roles belong to a SENIOR, so a non-SENIOR row leaves with `[]` — the
 * same gate `buildProfileView` and both `team-mapping.util.ts` sites apply. The
 * column itself is not proof of the role: `'{}'` is only written on the UPDATE that
 * changes the role, so a row can still carry a stale non-empty list, and the role
 * decides rather than the column.
 */
export function withActiveProjectFlag<
  T extends { id: string; role: string; technicalRoles: string[] },
>(rows: T[], busyJuniorIds: Set<string>): Array<T & { hasActiveProject: boolean }> {
  return rows.map((u) => ({
    ...u,
    technicalRoles: u.role === 'SENIOR' ? u.technicalRoles : [],
    hasActiveProject: u.role === 'JUNIOR' ? busyJuniorIds.has(u.id) : false,
  }))
}
