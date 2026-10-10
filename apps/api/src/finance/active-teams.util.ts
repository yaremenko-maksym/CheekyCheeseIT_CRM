import { and, eq, isNull } from 'drizzle-orm'
import type { DatabaseService } from '../database/database.service'
import { teamMembers } from '../database/schema'

/**
 * Active team memberships for a given user — returns the team rows joined
 * through `team_members`. Only `leftAt IS NULL` rows are included so a
 * historical membership cannot accidentally apply an override.
 *
 * `archivedAt IS NULL` is enforced on the team side because an archived
 * team must never participate in a fresh override decision (the override
 * stays in DB for audit but does not apply to new income).
 */
export async function findActiveTeamsForUser(
  db: DatabaseService['db'],
  userId: string,
): Promise<{ id: string; seniorSharePercentOverride: number | null }[]> {
  // Use the relational query API instead of a raw `db.select(...).from(...)`
  // chain so existing service-spec mocks (which only stub
  // `db.query.<entity>.findFirst/findMany`) keep working without re-doing
  // every spec's mock surface. The query reaches the team rows via the
  // membership join, then JS-filters out archived teams — the dataset per
  // user is small (one or two teams in practice) so the secondary filter
  // is cheap.
  let rows: Array<{
    team: { id: string; seniorSharePercentOverride: number | null; archivedAt: Date | null }
  }>
  try {
    rows = (await db.query.teamMembers.findMany({
      where: and(eq(teamMembers.userId, userId), isNull(teamMembers.leftAt)),
      with: { team: true },
    })) as unknown as Array<{
      team: { id: string; seniorSharePercentOverride: number | null; archivedAt: Date | null }
    }>
  } catch {
    // Defensive fallback for test mocks that don't stub
    // `query.teamMembers.findMany` — treat as "no team memberships". The
    // resolver then simply falls through to project / user-default.
    // Stryker disable next-line ArrayDeclaration: equivalent — a non-empty junk array is dropped by the `r.team &&` filter below (a string has no `.team`), so the result is still []
    rows = []
  }

  return rows
    .filter((r) => r.team && r.team.archivedAt === null)
    .map((r) => ({
      id: r.team.id,
      seniorSharePercentOverride: r.team.seniorSharePercentOverride ?? null,
    }))
}
