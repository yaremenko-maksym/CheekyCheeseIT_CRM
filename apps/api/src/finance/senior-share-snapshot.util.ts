import type { DatabaseService } from '../database/database.service'
import { findActiveTeamsForUser } from './active-teams.util'
import { resolveSeniorShare } from './senior-share-resolver'

/**
 * Pre-fetches the active teams for the senior, then calls the pure
 * senior-share resolver. Drop-project route: the senior in question is the
 * project's assigned senior (project.seniorId); drop-team memberships are
 * considered alongside senior-teams — both can carry an override.
 */
export async function resolveSeniorShareSnapshot(
  db: DatabaseService['db'],
  project: { seniorSharePercentOverride: number | null | undefined },
  senior: { id: string; seniorSharePercent: number | null | undefined },
): Promise<{ value: number; source: 'PROJECT' | 'TEAM' | 'USER_DEFAULT' }> {
  const applicableTeams = await findActiveTeamsForUser(db, senior.id)
  return resolveSeniorShare(
    { seniorSharePercentOverride: project.seniorSharePercentOverride },
    { seniorSharePercent: senior.seniorSharePercent },
    applicableTeams,
  )
}
