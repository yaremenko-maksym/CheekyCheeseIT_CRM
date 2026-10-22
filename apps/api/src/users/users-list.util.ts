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
 * Attaches `hasActiveProject` to each row. Only JUNIOR rows can be flagged
 * busy (member of a project with no `leftAt`); every other role is `false`.
 */
export function withActiveProjectFlag<T extends { id: string; role: string }>(
  rows: T[],
  busyJuniorIds: Set<string>,
): Array<T & { hasActiveProject: boolean }> {
  return rows.map((u) => ({
    ...u,
    hasActiveProject: u.role === 'JUNIOR' ? busyJuniorIds.has(u.id) : false,
  }))
}
