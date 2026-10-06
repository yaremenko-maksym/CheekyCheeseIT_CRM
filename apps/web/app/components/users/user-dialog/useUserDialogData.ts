import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { ProjectDto, TeamDto, UserProfileDto } from '@crm/shared'
import { kyivToday } from '@crm/shared'
import { api } from '@/lib/axios'
import { fetchUsersForDialog, type ExchangeRates } from './validation'

type UseUserDialogDataArgs = {
  open: boolean
  isCreate: boolean
  isEdit: boolean
  editingUser: UserProfileDto | null
}

/**
 * Auxiliary data for UserDialog: the HR / Accountant / project / team
 * queries plus the collections derived from them.
 */
export function useUserDialogData({ open, isCreate, isEdit, editingUser }: UseUserDialogDataArgs) {
  // ── Auxiliary data: HR / Accountant / project list ────────────────────────
  const { data: allUsers } = useQuery({
    queryKey: ['users-admin'],
    queryFn: fetchUsersForDialog,
    enabled: open,
  })

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<ProjectDto[]>('/projects').then((r) => r.data),
    enabled: open,
  })

  // Exchange rates — needed when admin enters a salary in non-USD currency.
  // Same query key as `AmountCurrencyInput` so the cache is shared.
  // ut-20: key includes today's calendar day so cache auto-refreshes past midnight.
  // `kyivToday()`, not the browser's local/UTC day (security-review PR #578
  // review, MED-1) — must match the KYIV day the server prices by (backlog 148).
  const exchangeTodayKey = kyivToday()
  const { data: exchangeRates } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', exchangeTodayKey],
    queryFn: () => api.get<ExchangeRates>('/finance/exchange-rate').then((r) => r.data),
    staleTime: 1000 * 60 * 60 * 24,
    enabled: open,
  })

  const hrUsers = useMemo(
    () => allUsers?.filter((u) => u.role === 'HR' && !u.archivedAt) ?? [],
    [allUsers],
  )
  const accountantUsers = useMemo(
    () => allUsers?.filter((u) => u.role === 'ACCOUNTANT' && !u.archivedAt) ?? [],
    [allUsers],
  )

  // Fetch all teams (active) to find current HR/Accountant for a SENIOR being edited.
  const { data: allTeams } = useQuery({
    queryKey: ['teams'],
    queryFn: () => api.get<TeamDto[]>('/teams').then((r) => r.data),
    enabled: isEdit && !!editingUser && editingUser.role === 'SENIOR',
  })

  // Drop role - phase 1 (AC3): senior creation supports two team modes —
  // CREATE_NEW (default; existing behavior) or JOIN_DROP_TEAM (pick a
  // drop-team without an active senior). Fetched lazily only when the
  // create-senior path is open: avoids an extra network call for non-senior
  // role flows and during edit.
  const { data: dropTeamsForJoin } = useQuery({
    queryKey: ['teams', { type: 'DROP', vacant: true }],
    queryFn: () => api.get<TeamDto[]>('/teams').then((r) => r.data),
    enabled: isCreate && open,
    staleTime: 30_000,
  })
  /**
   * Drop teams eligible for `JOIN_DROP_TEAM`:
   *  - `type === 'DROP'`
   *  - not archived
   *  - no active senior member (`role === 'SENIOR'` && `leftAt === null`)
   *
   * Backend's `addSeniorToDropTeam` enforces the same invariants — this
   * client-side filter is a UX guard so the dropdown lists only valid
   * options. Falling out of sync (e.g. another admin just rotated a
   * senior in) surfaces a backend 400 toast.
   */
  const vacantDropTeams = useMemo(() => {
    if (!dropTeamsForJoin) return []
    return dropTeamsForJoin.filter(
      (t) =>
        t.type === 'DROP' &&
        !t.archivedAt &&
        !t.members.some((m) => m.role === 'SENIOR' && !m.leftAt),
    )
  }, [dropTeamsForJoin])

  // For JUNIOR projects display in Edit
  const juniorActiveProjects = useMemo(() => {
    if (!editingUser || editingUser.role !== 'JUNIOR' || !projects) return []
    return projects.filter((p) =>
      p.members.some((m) => m.userId === editingUser.id && m.leftAt === null),
    )
  }, [editingUser, projects])

  // ut-7: For initial JUNIOR project select in Create — only projects without
  // an active JUNIOR. The business rule "max 1 active junior per project" makes
  // any project with a current JUNIOR an invalid pick at creation time.
  const availableJuniorProjects = useMemo(() => {
    if (!projects) return []
    return projects.filter((p) => {
      if (p.archivedAt) return false
      return !p.members.some((m) => m.role === 'JUNIOR' && m.leftAt === null)
    })
  }, [projects])

  return {
    allUsers,
    projects,
    exchangeRates,
    allTeams,
    dropTeamsForJoin,
    hrUsers,
    accountantUsers,
    vacantDropTeams,
    juniorActiveProjects,
    availableJuniorProjects,
  }
}
