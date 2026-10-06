import { createFileRoute } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { useMemo, useState } from 'react'
import type { TeamDto } from '@crm/shared'
import { compareNames } from '@crm/shared'
import { useLingui } from '@lingui/react/macro'
import { useAuth } from '@/context/auth'
import { useLocale } from '@/lib/i18n'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { getApiErrorMessage } from '@/lib/axios-utils'
import { toast } from 'sonner'
import { ArchiveConfirmDialog } from '@/components/archive/ArchiveConfirmDialog'
import { container, item } from './team-detail/constants'
import { fetchTeam, fetchProjects } from './team-detail/api'
import type { UserOption } from './team-detail/api'
import { EditTeamDialog } from './team-detail/components/EditTeamDialog'
import { AddMemberDialog } from './team-detail/components/AddMemberDialog'
import type { CandidateUser } from './team-detail/components/AddMemberDialog'
import { RotateSeniorDialog } from './team-detail/components/RotateSeniorDialog'
import { MembersCard } from './team-detail/components/MembersCard'
import { ActiveProjectsCard } from './team-detail/components/ActiveProjectsCard'
import { TeamLoadingSkeleton } from './team-detail/components/TeamLoadingSkeleton'
import { TeamNotFound } from './team-detail/components/TeamNotFound'
import { TeamDetailHeader } from './team-detail/components/TeamDetailHeader'
export const Route = createFileRoute('/_authenticated/team/$teamId')({
  component: TeamDetailPage,
})

function TeamDetailPage() {
  const { t } = useLingui()
  const locale = useLocale()
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT', 'DROP'])
  const { user } = useAuth()
  const { teamId } = Route.useParams()
  const queryClient = useQueryClient()

  const [showEdit, setShowEdit] = useState(false)
  const [showAddMember, setShowAddMember] = useState(false)
  // audit tab removed (PR-1 documents redesign)
  // ut-39b: explicit Archive button triggers ArchiveConfirmDialog (same flow
  // the AdminActionsMenu dropdown used to provide).
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false)
  // Drop role - phase 1 (AC5): rotate-senior dialog state. ADMIN / HR of
  // the team can swap the active senior of a drop-team.
  const [rotateSeniorOpen, setRotateSeniorOpen] = useState(false)
  const [newSeniorId, setNewSeniorId] = useState<string>('')

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => api.delete(`/teams/${teamId}/members/${userId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['team', teamId] })
      // Список команд в sidebar/карточках тоже показывает состав
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
    },
  })

  // Drop role - phase 1 (AC5): rotate-senior mutation. Calls the new
  // controller endpoint POST /api/teams/:id/rotate-senior which delegates
  // to TeamsService.rotateSenior (existing service primitive).
  const rotateSeniorMutation = useMutation({
    mutationFn: (sId: string) => api.post(`/teams/${teamId}/rotate-senior`, { newSeniorId: sId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['team', teamId] })
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
      toast.success(t`Сеньйора оновлено`)
      setRotateSeniorOpen(false)
      setNewSeniorId('')
    },
    onError: (err: unknown) => {
      toast.error(getApiErrorMessage(err, t`Не вдалося змінити сеньйора — спробуйте ще раз`))
    },
  })

  const {
    data: team,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['team', teamId],
    queryFn: () => fetchTeam(teamId),
    enabled: !!user && !!teamId,
  })

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
    enabled: !!user,
  })

  const canManage =
    user?.role === 'ADMIN' ||
    (user?.role === 'HR' && team?.members.some((m) => m.userId === user?.id))

  // Drop role - phase 1 (AC5): drop-team rendering branch + rotate-senior
  // affordance. Active SENIOR = `role='SENIOR' && leftAt === null`.
  const isDropTeam = team?.type === 'DROP'
  const activeSenior = team?.members.find((m) => m.role === 'SENIOR' && !m.leftAt) ?? null
  const dropOwner = team?.members.find((m) => m.role === 'DROP' && !m.leftAt) ?? null
  const canRotateSenior = isDropTeam && canManage && !team?.archivedAt

  const { data: allUsers } = useQuery<UserOption[]>({
    queryKey: ['users'],
    queryFn: () => api.get<UserOption[]>('/users').then((r) => r.data),
    enabled: !!(user && canManage),
  })

  // Drop role - phase 1 (AC5): fetch all teams to filter out SENIORs that
  // already have an active team membership. Backend's `rotateSenior` rejects
  // such picks with 400 — this client filter is a UX guard.
  const { data: allTeamsForRotate } = useQuery<TeamDto[]>({
    queryKey: ['teams'],
    queryFn: () => api.get<TeamDto[]>('/teams').then((r) => r.data),
    enabled: !!(user && canRotateSenior && rotateSeniorOpen),
    staleTime: 30_000,
  })
  const vacantSeniors = useMemo(() => {
    if (!allUsers) return []
    const seniorsInActiveTeam = new Set(
      (allTeamsForRotate ?? [])
        .filter((t) => !t.archivedAt)
        .flatMap((t) =>
          t.members.filter((m) => m.role === 'SENIOR' && !m.leftAt).map((m) => m.userId),
        ),
    )
    return allUsers
      .filter((u) => u.role === 'SENIOR' && !seniorsInActiveTeam.has(u.id))
      .sort((a, b) => compareNames(locale)(a.displayName, b.displayName))
  }, [allUsers, allTeamsForRotate, locale])

  // Edit form
  // task-team-senior-share-override. `seniorSharePercentOverride` is a
  // string in the form (empty string = "no override", numeric string = a
  // 0-100 integer). We map it to `number | null` only at submit time so
  // the user can clear the field with no jumps in the input.
  const editForm = useForm({
    defaultValues: {
      name: team?.name ?? '',
      telegram: team?.telegram ?? '',
      notes: team?.notes ?? '',
      seniorSharePercentOverride:
        team?.seniorSharePercentOverride !== null && team?.seniorSharePercentOverride !== undefined
          ? String(team.seniorSharePercentOverride)
          : '',
    },
    onSubmit: async ({ value }) => {
      const raw = value.seniorSharePercentOverride.trim()
      const parsedOverride = raw === '' ? null : Number(raw)
      await updateMutation.mutateAsync({
        name: value.name,
        telegram: value.telegram,
        notes: value.notes,
        seniorSharePercentOverride: parsedOverride,
      })
    },
  })

  const updateMutation = useMutation({
    mutationFn: (data: {
      name: string
      telegram: string
      notes: string
      seniorSharePercentOverride: number | null
    }) => api.patch(`/teams/${teamId}`, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['team', teamId] })
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      setShowEdit(false)
      toast.success(t`Команду оновлено`)
    },
    onError: (err: unknown) =>
      toast.error(getApiErrorMessage(err, t`Не вдалося оновити команду — спробуйте ще раз`)),
  })

  // Add member logic
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set())

  const addMemberMutation = useMutation({
    mutationFn: (userId: string) => api.post(`/teams/${teamId}/members`, { userId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['team', teamId] })
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
    },
    onError: (err: unknown) => {
      toast.error(getApiErrorMessage(err, t`Не вдалося додати учасника — спробуйте ще раз`))
    },
  })

  // Compute active projects for this team. Round 5: project lifecycle is
  // binary — active === archivedAt is null.
  // Drop role - phase 1 (AC5): drop-teams own projects via `dropId`
  // (`projects.dropId === drop.userId`), not through the senior link.
  const activeProjects =
    projects?.filter((p) => {
      if (p.archivedAt !== null) return false
      if (isDropTeam) {
        return dropOwner ? p.dropId === dropOwner.userId : false
      }
      return team?.members.some((m) => m.role === 'SENIOR' && m.userId === p.seniorId) ?? false
    }) ?? []

  // Junior sees only their own project
  const visibleProjects =
    user?.role === 'JUNIOR'
      ? activeProjects.filter((p) =>
          p.members?.some(
            (m: { userId: string; leftAt: string | null }) =>
              m.userId === user.id && m.leftAt === null,
          ),
        )
      : activeProjects

  // Rules of Hooks: moved here — after every hook above — instead of
  // between the mutations near the top and the ~10 hooks that follow it
  // (useQuery x4/useMemo/useForm/useMutation/useState/useMutation/useMemo).
  // `denied` flips false→true mid-mount once `useAuth`'s `isLoading`
  // resolves to a disallowed role; a guard sitting in the middle of the
  // hook list made that transition change the hook count between renders
  // ("Rendered fewer hooks than expected") — the same failure class
  // as the earlier crash on /team/$teamId. This
  // route is also gated at the layout level (see use-role-guard.ts), so
  // this remains defense-in-depth, not the only guard.
  if (denied) return null

  if (isLoading) {
    return <TeamLoadingSkeleton />
  }

  if (error || !team) {
    return <TeamNotFound userRole={user?.role} />
  }

  // Add member dialog filtering logic
  const memberUserIds = new Set(team?.members.map((m) => m.userId) ?? [])
  const teamHasSenior = team?.members.some((m) => m.role === 'SENIOR') ?? false

  const juniorIdsWithProjects = new Set(
    projects?.flatMap((p) =>
      p.archivedAt === null
        ? (p.members
            ?.filter((m: { leftAt: string | null }) => m.leftAt === null)
            .map((m: { userId: string }) => m.userId) ?? [])
        : [],
    ) ?? [],
  )

  const candidateUsers: CandidateUser[] = (allUsers || [])
    .filter((u: UserOption) => u.role !== 'ADMIN')
    .map((u: UserOption): CandidateUser => {
      if (memberUserIds.has(u.id)) return { ...u, disabledReason: t`в команді` }
      if (u.role === 'SENIOR' && teamHasSenior) return { ...u, disabledReason: t`вже є сеньйор` }
      if (u.role === 'JUNIOR' && juniorIdsWithProjects.has(u.id))
        return { ...u, disabledReason: t`є проєкт` }
      return u
    })
    .sort((a: CandidateUser, b: CandidateUser) => {
      const aDisabled = !!a.disabledReason
      const bDisabled = !!b.disabledReason
      if (aDisabled !== bDisabled) return aDisabled ? 1 : -1
      return compareNames(locale)(a.displayName, b.displayName)
    })

  function toggleSelectedUser(userId: string) {
    setSelectedUserIds((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) {
        next.delete(userId)
      } else {
        next.add(userId)
      }
      return next
    })
  }

  async function handleAddMembers() {
    for (const userId of selectedUserIds) {
      await addMemberMutation.mutateAsync(userId)
    }
    setSelectedUserIds(new Set())
    setShowAddMember(false)
    toast.success(t`Учасників додано`)
  }

  return (
    <div className="flex flex-col h-full">
      <motion.div
        className="flex-1 min-h-0 overflow-y-auto space-y-6 px-6 pt-4 pb-6"
        variants={container}
        initial="hidden"
        animate="show"
      >
        {/* Header */}
        <TeamDetailHeader
          team={team}
          viewerRole={user?.role}
          isDropTeam={isDropTeam}
          dropOwner={dropOwner}
          activeSenior={activeSenior}
          canManage={canManage}
          canRotateSenior={canRotateSenior}
          onRotateSenior={() => setRotateSeniorOpen(true)}
          onAddMember={() => setShowAddMember(true)}
          onEdit={() => {
            editForm.setFieldValue('name', team.name)
            editForm.setFieldValue('telegram', team.telegram ?? '')
            editForm.setFieldValue('notes', team.notes ?? '')
            editForm.setFieldValue(
              'seniorSharePercentOverride',
              team.seniorSharePercentOverride !== null &&
                team.seniorSharePercentOverride !== undefined
                ? String(team.seniorSharePercentOverride)
                : '',
            )
            setShowEdit(true)
          }}
          onArchive={() => setArchiveDialogOpen(true)}
        />

        <div className="space-y-6">
          {/* Members */}
          <motion.div variants={item}>
            <MembersCard
              members={team.members}
              viewerRole={user?.role}
              viewerId={user?.id}
              canManage={canManage}
              onRemove={(userId) => removeMemberMutation.mutate(userId)}
            />
          </motion.div>

          {/* Active Projects — hidden from JUNIOR viewers per task #11;
            also hidden from SENIOR (task-senior-ui-followups §3b):
            SENIOR has no profile-link access to teammates and seeing the
            junior slot with identity hidden adds no value. */}
          {user?.role !== 'JUNIOR' && user?.role !== 'SENIOR' && (
            <motion.div variants={item}>
              <ActiveProjectsCard
                visibleProjects={visibleProjects}
                viewerRole={user?.role}
                members={team.members}
              />
            </motion.div>
          )}
        </div>

        <EditTeamDialog
          open={showEdit}
          onOpenChange={setShowEdit}
          form={editForm}
          isPending={updateMutation.isPending}
        />

        {/* Add Member Dialog */}
        <AddMemberDialog
          open={showAddMember}
          onOpenChange={(open) => {
            setShowAddMember(open)
            if (!open) setSelectedUserIds(new Set())
          }}
          candidateUsers={candidateUsers}
          selectedUserIds={selectedUserIds}
          onToggle={toggleSelectedUser}
          onSubmit={() => void handleAddMembers()}
          isPending={addMemberMutation.isPending}
        />

        {/* ut-39b: Archive confirm dialog — triggered by explicit Archive button. */}
        {archiveDialogOpen && (
          <ArchiveConfirmDialog
            entityType="team"
            entityId={team.id}
            entityName={team.name}
            onClose={() => setArchiveDialogOpen(false)}
          />
        )}

        {/* Drop role - phase 1 (AC5): rotate-senior dialog. Lists SENIORs
          with no active team membership; backend re-validates on submit. */}
        <RotateSeniorDialog
          open={rotateSeniorOpen}
          onOpenChange={(o) => {
            if (!o) {
              setRotateSeniorOpen(false)
              setNewSeniorId('')
            }
          }}
          activeSenior={activeSenior}
          vacantSeniors={vacantSeniors}
          newSeniorId={newSeniorId}
          onSelect={setNewSeniorId}
          onSubmit={() => rotateSeniorMutation.mutate(newSeniorId)}
          isPending={rotateSeniorMutation.isPending}
        />
      </motion.div>
    </div>
  )
}
