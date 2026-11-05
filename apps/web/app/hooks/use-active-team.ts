import { useQuery } from '@tanstack/react-query'
import type { TeamDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { useOnboardingGate } from '@/context/onboarding'
import { api } from '@/lib/axios'

/**
 * Drop role - phase 1 (frontend AC7).
 *
 * Derives the active team of the current user. A user is "active in a team"
 * when there exists an active membership (`leftAt === null`) in any non-
 * archived team.
 *
 * Used to:
 *  - gate sidebar nav (teamless SENIOR loses «Проекты» / «Собеседования»)
 *  - render the «без команды» chip in profile header
 *  - show empty-state on `/projects` and `/interviews` for orphaned senior
 *
 * Returns:
 *  - `team`: the active team (or `null` if none)
 *  - `isTeamless`: true when the request resolved and no active team found
 *  - `isLoading`: still fetching teams
 */
export function useActiveTeam(): {
  team: TeamDto | null
  isTeamless: boolean
  isLoading: boolean
} {
  const { teams, isLoading } = useActiveTeams()
  if (teams === null) return { team: null, isTeamless: false, isLoading }
  const active = teams[0] ?? null
  return { team: active, isTeamless: active === null, isLoading: false }
}

/**
 * Every team the current user is actively in (same query and membership rule as
 * `useActiveTeam`, which takes the first). `teams` is `null` while unknown (no user /
 * still loading). r5 Task 7.2: the job queue lets an HR with several teams switch.
 */
export function useActiveTeams(): { teams: TeamDto[] | null; isLoading: boolean } {
  const { user } = useAuth()
  // Gate: do not call /api/teams while the user is still in the onboarding
  // wizard — OnboardingGuard would 403 non-ADMIN pre-onboarding callers and
  // produce console noise. ADMIN always has isComplete=true so the gate is
  // transparent for them.
  const { isComplete } = useOnboardingGate()

  const { data, isLoading } = useQuery({
    queryKey: ['teams', { archived: 'active' }],
    queryFn: async () => {
      const res = await api.get<TeamDto[]>('/teams')
      return res.data
    },
    enabled: !!user && isComplete,
    staleTime: 60_000,
  })

  if (!user || isLoading || !data) return { teams: null, isLoading }

  // Active membership in any non-archived team — `leftAt === null`. Backend
  // already filters out archived teams in the default `findAll` call (no
  // ?archived=true), so any returned team is active.
  return {
    teams: data.filter(
      (t) => !t.archivedAt && t.members.some((m) => m.userId === user.id && !m.leftAt),
    ),
    isLoading: false,
  }
}
