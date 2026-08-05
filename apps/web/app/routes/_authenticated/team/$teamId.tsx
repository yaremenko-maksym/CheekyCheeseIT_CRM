import { createFileRoute, Link } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Briefcase,
  Calendar,
  Mail,
  Pencil,
  Phone,
  RefreshCw,
  Send,
  UserMinus,
  UserPlus,
  Users,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ProjectDto, TeamDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { hasRealPhone } from '@/lib/format-phone'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ProfileNameLink } from '@/components/users/ProfileNameLink'
import { ProjectLogo } from '@/components/projects/ProjectLogo'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  CrmDialogContent,
  CrmDialogHeader,
  CrmDialogBody,
  CrmDialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ShareSlider } from '@/components/ui/share-slider'
import { toast } from 'sonner'
import { tgUrl, tgDisplay } from '@/lib/tg-url'
import { ArchiveConfirmDialog } from '@/components/archive/ArchiveConfirmDialog'
import { useUnarchiveEntity } from '@/hooks/use-archive'
export const Route = createFileRoute('/_authenticated/team/$teamId')({
  component: TeamDetailPage,
})

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  SENIOR: 'Синьор',
  JUNIOR: 'Джун',
  HR: 'HR',
  ACCOUNTANT: 'Бухгалтер',
  DROP: 'Дроп',
}

const ROLE_VARIANT: Record<string, 'admin' | 'senior' | 'junior' | 'hr' | 'accountant' | 'drop'> = {
  ADMIN: 'admin',
  SENIOR: 'senior',
  JUNIOR: 'junior',
  HR: 'hr',
  ACCOUNTANT: 'accountant',
  DROP: 'drop',
}

function getInitials(name: string) {
  return (name || '?')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

async function fetchTeam(id: string): Promise<TeamDto> {
  const res = await api.get<TeamDto>(`/teams/${id}`)
  return res.data
}

async function fetchProjects(): Promise<ProjectDto[]> {
  const res = await api.get<ProjectDto[]>('/projects')
  return res.data
}

type UserOption = {
  id: string
  displayName: string
  email: string
  role: string
  avatarUrl: string | null
  avatarDocumentId: string | null
}

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.1 } },
}
const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.25, 0.1, 0.25, 1] as const } },
}

function TeamDetailPage() {
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
      toast.success('Синьор обновлён')
      setRotateSeniorOpen(false)
      setNewSeniorId('')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast.error(msg ?? 'Не удалось сменить синьора')
    },
  })

  if (denied) return null

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
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
  }, [allUsers, allTeamsForRotate])

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
      toast.success('Команда обновлена')
    },
    onError: () => toast.error('Не удалось обновить команду'),
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
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast.error(msg ?? 'Ошибка добавления')
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

  // Pre-compute members grouped by role once per team.members change. MUST be
  // ABOVE the early returns below — Rules of Hooks: an unconditional hook call.
  // Placing it after `if (isLoading)` changed the hook count between the loading
  // and loaded renders -> "Rendered more hooks than during the previous render"
  // crash on every navigation to /team/$teamId.
  // (Also avoids the prior O(N²) per-member reduce inside the JSX .map().)
  const membersByRole = useMemo(
    () =>
      (team?.members ?? []).reduce(
        (acc, m) => {
          if (!acc[m.role]) acc[m.role] = []
          acc[m.role]!.push(m)
          return acc
        },
        {} as Record<string, NonNullable<typeof team>['members']>,
      ),
    [team?.members],
  )

  if (isLoading) {
    return (
      <div className="space-y-6 px-6 pt-4 pb-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-md" />
          <div className="space-y-1.5">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            {/* Members card skeleton — matches real grid gap-2 sm:grid-cols-2 */}
            <div className="rounded-xl border border-border p-4 space-y-3">
              <Skeleton className="h-5 w-36" />
              <div className="grid gap-2 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 rounded-lg" />
                ))}
              </div>
            </div>
          </div>
          <div className="space-y-4">
            <Skeleton className="h-32 rounded-xl" />
          </div>
        </div>
      </div>
    )
  }

  if (error || !team) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <Users className="h-10 w-10 text-muted-foreground/30" />
        <p className="mt-4 text-sm font-medium">Команда не найдена</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Возможно, у вас нет доступа к этой команде
        </p>
        {/* «Вернуться к списку» скрыто для DROP: им некуда возвращаться. */}
        {user?.role !== 'DROP' && (
          <Button asChild variant="outline" size="sm" className="mt-4">
            <Link to="/team">
              <ArrowLeft className="h-4 w-4 mr-1.5" />
              Вернуться к списку
            </Link>
          </Button>
        )}
      </div>
    )
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

  type CandidateUser = UserOption & { disabledReason?: string }

  const candidateUsers: CandidateUser[] = (allUsers || [])
    .filter((u: UserOption) => u.role !== 'ADMIN')
    .map((u: UserOption): CandidateUser => {
      if (memberUserIds.has(u.id)) return { ...u, disabledReason: 'в команде' }
      if (u.role === 'SENIOR' && teamHasSenior) return { ...u, disabledReason: 'уже есть синьор' }
      if (u.role === 'JUNIOR' && juniorIdsWithProjects.has(u.id))
        return { ...u, disabledReason: 'есть проект' }
      return u
    })
    .sort((a: CandidateUser, b: CandidateUser) => {
      const aDisabled = !!a.disabledReason
      const bDisabled = !!b.disabledReason
      if (aDisabled !== bDisabled) return aDisabled ? 1 : -1
      return a.displayName.localeCompare(b.displayName)
    })

  async function handleAddMembers() {
    for (const userId of selectedUserIds) {
      await addMemberMutation.mutateAsync(userId)
    }
    setSelectedUserIds(new Set())
    setShowAddMember(false)
    toast.success('Участники добавлены')
  }

  // tgUrl / tgDisplay imported from @/lib/tg-url

  return (
    <div className="flex flex-col h-full">
      <motion.div
        className="flex-1 min-h-0 overflow-y-auto space-y-6 px-6 pt-4 pb-6"
        variants={container}
        initial="hidden"
        animate="show"
      >
        {/* Header */}
        <motion.div variants={item} className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            {/* Back button hidden for SENIOR, JUNIOR, and DROP.
              SENIOR/JUNIOR: они не видят список команд (нет пункта «Команда» в nav).
              DROP: редиректится на свою единственную команду — возвращаться некуда,
              кнопка «назад» вела бы в петлю. */}
            {user?.role !== 'SENIOR' && user?.role !== 'JUNIOR' && user?.role !== 'DROP' && (
              <Button
                asChild
                variant="outline"
                size="icon"
                className="shrink-0"
                data-testid="back-button"
              >
                <Link to="/team">
                  <ArrowLeft className="h-4 w-4" />
                </Link>
              </Button>
            )}
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold tracking-tight">{team.name}</h1>
                {/* Drop role - phase 1 (AC5): DROP badge + «Команда дропа»
                  caption surface the team type. Senior-teams render no
                  extra badge, header rendering 1:1 as before. */}
                {isDropTeam && (
                  <Badge variant="drop" data-testid="team-drop-badge">
                    Команда дропа
                  </Badge>
                )}
                {team.archivedAt ? (
                  <Badge
                    variant="outline"
                    className="border-amber-500/30 bg-amber-500/10 text-amber-500"
                    data-testid="team-archived-badge"
                  >
                    В архиве
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                  >
                    Активна
                  </Badge>
                )}
              </div>
              {/* AC5: drop owner link under the title — quick navigation to
                the drop's profile, mirrors the «синьор» bookmark on senior
                teams. */}
              {isDropTeam && dropOwner && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  Дроп:{' '}
                  <ProfileNameLink
                    userId={dropOwner.userId}
                    viewerRole={user?.role ?? 'JUNIOR'}
                    className="text-primary hover:underline font-medium"
                  >
                    {dropOwner.displayName}
                  </ProfileNameLink>
                  {activeSenior ? (
                    <>
                      {' · Синьор: '}
                      <ProfileNameLink
                        userId={activeSenior.userId}
                        viewerRole={user?.role ?? 'JUNIOR'}
                        className="text-primary hover:underline font-medium"
                      >
                        {activeSenior.displayName}
                      </ProfileNameLink>
                    </>
                  ) : (
                    <span className="ml-1 text-amber-500/80">· Синьор не назначен</span>
                  )}
                </p>
              )}
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" />
                  Создана{' '}
                  {new Date(team.createdAt).toLocaleDateString('ru-RU', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                  })}
                </div>
                {/* TG-канал hidden from JUNIOR viewer per task #11 */}
                {team.telegram && user?.role !== 'JUNIOR' && (
                  <a
                    href={tgUrl(team.telegram)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg border border-blue-500/50 px-4 py-2 text-sm font-medium text-blue-400 hover:bg-blue-500/10 hover:border-blue-400 transition-colors"
                    data-testid="team-telegram-link"
                  >
                    <Send className="h-3 w-3" />
                    Telegram-канал
                  </a>
                )}
              </div>
            </div>
          </div>
          {/* ut-39b: «Действия» dropdown replaced with explicit Archive /
            Unarchive buttons (matches ut-28 project detail pattern).
            Add / Edit remain side-by-side; archive controls are admin-only. */}
          <div className="flex shrink-0 gap-2 flex-wrap justify-end">
            {/* Drop role - phase 1 (AC5): rotate-senior is the headline
              action for drop-teams. Senior-teams never see this button. */}
            {canRotateSenior && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setRotateSeniorOpen(true)}
                data-testid="team-rotate-senior-button"
              >
                <RefreshCw className="h-4 w-4" />
                {activeSenior ? 'Сменить синьора' : 'Назначить синьора'}
              </Button>
            )}
            {canManage && !team.archivedAt && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setShowAddMember(true)}
                  data-testid="team-add-member-button"
                >
                  <UserPlus className="h-4 w-4" />
                  Добавить
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  data-testid="team-edit-button"
                  onClick={() => {
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
                >
                  <Pencil className="h-4 w-4" />
                  Редактировать
                </Button>
              </>
            )}
            {user?.role === 'ADMIN' && !team.archivedAt && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setArchiveDialogOpen(true)}
                className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                data-testid="team-archive-button"
              >
                <Archive className="h-4 w-4" />
                Архивировать
              </Button>
            )}
            {user?.role === 'ADMIN' && team.archivedAt && (
              <TeamUnarchiveHeaderButton teamId={team.id} />
            )}
          </div>
        </motion.div>

        <div className="space-y-6">
          {/* Members */}
          <motion.div variants={item}>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  Участники команды
                  <Badge variant="outline" className="ml-auto">
                    {team.members.length}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {(() => {
                  // RBAC member visibility:
                  // JUNIOR viewer → hide all JUNIORs (sees non-junior roster only).
                  // SENIOR viewer → hide all JUNIORs (identity hidden per RBAC rule #1).
                  // Other roles → full member list.
                  const visibleMembers =
                    user?.role === 'JUNIOR' || user?.role === 'SENIOR'
                      ? team.members.filter((m) => m.role !== 'JUNIOR')
                      : team.members

                  return (
                    <div className="grid gap-2 sm:grid-cols-2">
                      {visibleMembers.map((member) => (
                        <motion.div
                          key={member.id}
                          className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/50 p-3"
                          whileHover={{ scale: 1.01 }}
                          transition={{ duration: 0.15 }}
                        >
                          {/* round-2 AC1: avatar + name is the only profile <Link>;
                            email/telegram/phone are sibling <a> tags (NOT nested
                            inside another anchor) — fixes validateDOMNesting.
                            task-drop-profile-lockdown: for a DROP viewer these
                            become plain (non-navigable) — DROP has no profile
                            access. Contacts below stay visible. */}
                          <div className="flex min-w-0 flex-1 items-center gap-3">
                            <ProfileNameLink
                              userId={member.userId}
                              viewerRole={user?.role ?? 'JUNIOR'}
                              className="shrink-0 transition-opacity hover:opacity-80"
                            >
                              <Avatar className="h-9 w-9 shrink-0">
                                {member.avatarUrl && (
                                  <AvatarImage src={member.avatarUrl} alt={member.displayName} />
                                )}
                                <AvatarFallback className="bg-muted text-xs">
                                  {getInitials(member.displayName)}
                                </AvatarFallback>
                              </Avatar>
                            </ProfileNameLink>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <ProfileNameLink
                                  userId={member.userId}
                                  viewerRole={user?.role ?? 'JUNIOR'}
                                  className="min-w-0 transition-opacity hover:opacity-80"
                                >
                                  <p className="truncate text-sm font-medium leading-tight hover:text-primary transition-colors">
                                    {member.displayName}
                                  </p>
                                </ProfileNameLink>
                                <Badge
                                  variant={ROLE_VARIANT[member.role] ?? 'junior'}
                                  className="text-[9px] shrink-0"
                                >
                                  {ROLE_LABELS[member.role] ?? member.role}
                                </Badge>
                              </div>
                              {Array.isArray(member.techStack) && member.techStack.length > 0 && (
                                <div className="mt-1 flex flex-wrap gap-1">
                                  {(member.techStack as string[]).map((t) => (
                                    <Badge
                                      key={t}
                                      variant="outline"
                                      className="text-[9px] px-1.5 py-0 font-mono"
                                    >
                                      {t}
                                    </Badge>
                                  ))}
                                </div>
                              )}
                              <div className="mt-1 flex flex-col gap-0.5 min-w-0">
                                <a
                                  href={`mailto:${member.email}`}
                                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors min-w-0"
                                >
                                  <Mail className="h-3 w-3 shrink-0" />
                                  <span className="truncate">{member.email}</span>
                                </a>
                                {member.telegram && (
                                  <a
                                    href={tgUrl(member.telegram)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors min-w-0"
                                  >
                                    <Send className="h-3 w-3 shrink-0" />
                                    <span className="truncate">{tgDisplay(member.telegram)}</span>
                                  </a>
                                )}
                                {hasRealPhone(member.phone) && (
                                  <a
                                    href={`tel:${member.phone}`}
                                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors min-w-0"
                                  >
                                    <Phone className="h-3 w-3 shrink-0" />
                                    <span className="truncate">{member.phone}</span>
                                  </a>
                                )}
                              </div>
                            </div>
                          </div>
                          {canManage &&
                            (() => {
                              // membersByRole is pre-computed above via useMemo([team.members])
                              const isSenior = member.role === 'SENIOR'
                              const isJunior = member.role === 'JUNIOR'
                              const isLastHr =
                                member.role === 'HR' &&
                                membersByRole.HR &&
                                membersByRole.HR.length <= 1
                              const isLastAccountant =
                                member.role === 'ACCOUNTANT' &&
                                membersByRole.ACCOUNTANT &&
                                membersByRole.ACCOUNTANT.length <= 1
                              const isSelf = member.userId === user?.id
                              const canRemove =
                                !isSenior &&
                                !isJunior &&
                                !isLastHr &&
                                !isLastAccountant &&
                                (user?.role === 'ADMIN' ? true : isSelf)
                              return canRemove ? (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                                  title="Исключить"
                                  onClick={() => removeMemberMutation.mutate(member.userId)}
                                >
                                  <UserMinus className="h-3.5 w-3.5" />
                                </Button>
                              ) : null
                            })()}
                        </motion.div>
                      ))}
                      {visibleMembers.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-12 text-center col-span-2">
                          <p className="mt-3 text-sm font-medium">Нет участников</p>
                        </div>
                      )}
                    </div>
                  )
                })()}
              </CardContent>
            </Card>
          </motion.div>

          {/* Active Projects — hidden from JUNIOR viewers per task #11;
            also hidden from SENIOR (task-senior-ui-followups §3b):
            SENIOR has no profile-link access to teammates and seeing the
            junior slot with identity hidden adds no value. */}
          {user?.role !== 'JUNIOR' && user?.role !== 'SENIOR' && (
            <motion.div variants={item}>
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Briefcase className="h-5 w-5" />
                    Активные проекты
                    {visibleProjects.length > 0 && (
                      <Badge className="ml-auto bg-emerald-500/15 text-emerald-400 border-emerald-500/25 hover:bg-emerald-500/20">
                        {visibleProjects.length}
                      </Badge>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {visibleProjects.length === 0 ? (
                    <p className="text-sm text-muted-foreground py-4 text-center">
                      Нет активных проектов
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {visibleProjects.map((project) => {
                        const juniorMember = project.members?.find(
                          (m: { role: string; leftAt: string | null }) =>
                            m.role === 'JUNIOR' && m.leftAt === null,
                        )
                        // RBAC rule #1: SENIOR viewer must not see junior identity.
                        // junior slot still visible (project has a junior), but name/avatar hidden.
                        const showJuniorIdentity = user?.role !== 'SENIOR'
                        const junior =
                          showJuniorIdentity && juniorMember
                            ? team.members.find((m) => m.userId === juniorMember.userId)
                            : null
                        return (
                          <Link
                            key={project.id}
                            to="/projects/$projectId"
                            params={{ projectId: project.id }}
                            className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/50 p-3 transition-all hover:border-primary/30 hover:bg-card"
                          >
                            <ProjectLogo
                              documentId={project.logoDocumentId}
                              externalUrl={project.logoExternalUrl}
                              companyName={project.companyName}
                              fallback={project.companyName.slice(0, 2).toUpperCase()}
                              avatarClassName="h-8 w-8 rounded-md shrink-0 [&_[data-slot=avatar-fallback]]:rounded-md [&_[data-slot=avatar-fallback]]:text-xs"
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">{project.name}</p>
                              <p className="truncate text-xs text-muted-foreground">
                                {project.companyName}
                              </p>
                              {junior ? (
                                <div
                                  className="flex items-center gap-1.5 mt-1"
                                  data-testid="project-junior-slot"
                                >
                                  <Avatar className="h-4 w-4">
                                    {junior.avatarUrl && (
                                      <AvatarImage
                                        src={junior.avatarUrl}
                                        alt={junior.displayName}
                                      />
                                    )}
                                    <AvatarFallback className="bg-muted text-[8px]">
                                      {getInitials(junior.displayName)}
                                    </AvatarFallback>
                                  </Avatar>
                                  <span className="text-xs text-muted-foreground truncate">
                                    {junior.displayName}
                                  </span>
                                </div>
                              ) : juniorMember && !showJuniorIdentity ? (
                                // SENIOR viewer: slot occupied but identity hidden
                                <p className="text-xs text-muted-foreground/60 mt-1">
                                  Джун назначен
                                </p>
                              ) : (
                                <p className="text-xs text-destructive mt-1">Джун не прикреплён</p>
                              )}
                            </div>
                            <Badge className="shrink-0 bg-emerald-500/15 text-emerald-400 border-emerald-500/25 text-[10px]">
                              Активный
                            </Badge>
                          </Link>
                        )
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          )}
        </div>

        {/* Edit Team Dialog */}
        <Dialog open={showEdit} onOpenChange={setShowEdit}>
          <CrmDialogContent>
            <CrmDialogHeader>
              <DialogTitle>Редактировать команду</DialogTitle>
              <DialogDescription className="sr-only">
                Редактирование названия, Telegram-ссылки и заметок команды.
              </DialogDescription>
            </CrmDialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void editForm.handleSubmit()
              }}
            >
              <CrmDialogBody className="space-y-4">
                <editForm.Field name="name">
                  {(field) => (
                    <div className="grid gap-1.5">
                      <Label htmlFor="edit-name">
                        Название <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        id="edit-name"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        placeholder="Название команды"
                      />
                      {field.state.meta.errors[0] && (
                        <p className="text-xs text-destructive">{field.state.meta.errors[0]}</p>
                      )}
                    </div>
                  )}
                </editForm.Field>
                <editForm.Field
                  name="telegram"
                  validators={{
                    onChange: ({ value }) => {
                      if (value && !value.startsWith('https://t.me/')) {
                        return 'Ссылка должна начинаться с https://t.me/'
                      }
                      return undefined
                    },
                  }}
                >
                  {(field) => (
                    <div className="grid gap-1.5">
                      <Label htmlFor="edit-telegram">Telegram</Label>
                      <Input
                        id="edit-telegram"
                        type="url"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        placeholder="https://t.me/team_chat"
                      />
                      {field.state.meta.errors[0] && (
                        <p className="text-xs text-destructive">
                          {String(field.state.meta.errors[0])}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Ссылка на Telegram-чат команды
                      </p>
                    </div>
                  )}
                </editForm.Field>
                <editForm.Field name="notes">
                  {(field) => (
                    <div className="grid gap-1.5">
                      <Label htmlFor="edit-notes">Заметки</Label>
                      <Textarea
                        id="edit-notes"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        placeholder="Внутренние заметки…"
                        className="min-h-20"
                      />
                    </div>
                  )}
                </editForm.Field>
                {/*
                task-team-senior-share-override. Team-level override for the
                SENIOR's share percent. Empty string = "no override → fall
                through to project / user default". ShareSlider replaces the
                plain number input (UT #9). Default shown when no override is
                set. «Сбросить» clears back to empty (no override).
              */}
                <editForm.Field name="seniorSharePercentOverride">
                  {(field) => {
                    const raw = field.state.value
                    const hasOverride = raw.trim() !== ''
                    // Slider value: override if set, else 26 (global default).
                    const sliderValue = hasOverride ? Math.min(100, Math.max(0, Number(raw))) : 26
                    return (
                      <div className="grid gap-1.5">
                        <div className="flex items-center justify-between">
                          <Label>Доля синьора (override для команды)</Label>
                          {hasOverride && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs text-muted-foreground"
                              onClick={() => field.handleChange('')}
                              data-testid="team-edit-senior-share-override-reset"
                            >
                              Сбросить
                            </Button>
                          )}
                        </div>
                        <ShareSlider
                          value={sliderValue}
                          min={0}
                          max={100}
                          onChange={(v) => field.handleChange(String(v))}
                          onBlur={field.handleBlur}
                          inputTestId="team-edit-senior-share-override-input"
                        />
                        <p className="text-xs text-muted-foreground">
                          {hasOverride
                            ? 'Override задан. Применяется ко всем проектам команды (приоритет ниже project override, выше user default).'
                            : 'Не задано — используется значение синьора (26% по умолчанию). Передвиньте слайдер чтобы задать override.'}
                        </p>
                      </div>
                    )
                  }}
                </editForm.Field>
              </CrmDialogBody>
              <CrmDialogFooter>
                <Button type="button" variant="outline" onClick={() => setShowEdit(false)}>
                  Отмена
                </Button>
                <Button type="submit" disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? 'Сохранение…' : 'Сохранить'}
                </Button>
              </CrmDialogFooter>
            </form>
          </CrmDialogContent>
        </Dialog>

        {/* Add Member Dialog */}
        <Dialog
          open={showAddMember}
          onOpenChange={(open) => {
            setShowAddMember(open)
            if (!open) setSelectedUserIds(new Set())
          }}
        >
          <CrmDialogContent>
            <CrmDialogHeader>
              <DialogTitle>Добавить участника</DialogTitle>
              <DialogDescription className="sr-only">
                Выбор пользователей для добавления в состав команды.
              </DialogDescription>
            </CrmDialogHeader>
            <CrmDialogBody>
              <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
                {candidateUsers.length === 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    Нет доступных пользователей
                  </p>
                )}
                {candidateUsers.map((u, idx) => {
                  const isDisabled = !!u.disabledReason
                  const isSelected = selectedUserIds.has(u.id)
                  const prevDisabled = idx > 0 && !!candidateUsers[idx - 1]?.disabledReason
                  const showDivider = isDisabled && !prevDisabled && idx > 0
                  return (
                    <div key={u.id}>
                      {showDivider && <div className="my-2 border-t border-border/50" />}
                      <button
                        type="button"
                        disabled={isDisabled}
                        onClick={() => {
                          if (isDisabled) return
                          setSelectedUserIds((prev) => {
                            const next = new Set(prev)
                            if (next.has(u.id)) {
                              next.delete(u.id)
                            } else {
                              next.add(u.id)
                            }
                            return next
                          })
                        }}
                        className={cn(
                          'flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors',
                          isDisabled
                            ? 'cursor-not-allowed opacity-35'
                            : isSelected
                              ? 'bg-primary/10'
                              : 'hover:bg-muted/50',
                        )}
                      >
                        {!isDisabled && (
                          <div
                            className={cn(
                              'h-4 w-4 shrink-0 rounded border',
                              isSelected
                                ? 'border-primary bg-primary flex items-center justify-center'
                                : 'border-border',
                            )}
                          >
                            {isSelected && (
                              <span className="text-[10px] text-primary-foreground font-bold">
                                ✓
                              </span>
                            )}
                          </div>
                        )}
                        {isDisabled && <div className="h-4 w-4 shrink-0" />}
                        <Avatar className="h-6 w-6 shrink-0">
                          {u.avatarUrl && <AvatarImage src={u.avatarUrl} alt={u.displayName} />}
                          <AvatarFallback className="text-[9px]">
                            {getInitials(u.displayName)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="flex-1 truncate text-sm">{u.displayName}</span>
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {ROLE_LABELS[u.role] ?? u.role}
                        </Badge>
                        {u.disabledReason && (
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            {u.disabledReason}
                          </span>
                        )}
                      </button>
                    </div>
                  )
                })}
              </div>
            </CrmDialogBody>
            <CrmDialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setShowAddMember(false)
                  setSelectedUserIds(new Set())
                }}
              >
                Отмена
              </Button>
              <Button
                disabled={selectedUserIds.size === 0 || addMemberMutation.isPending}
                onClick={() => void handleAddMembers()}
              >
                Добавить{selectedUserIds.size > 0 ? ` (${selectedUserIds.size})` : ''}
              </Button>
            </CrmDialogFooter>
          </CrmDialogContent>
        </Dialog>

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
        <Dialog
          open={rotateSeniorOpen}
          onOpenChange={(o) => {
            if (!o) {
              setRotateSeniorOpen(false)
              setNewSeniorId('')
            }
          }}
        >
          <CrmDialogContent data-testid="team-rotate-senior-dialog">
            <CrmDialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <RefreshCw className="h-4 w-4" />
                {activeSenior ? 'Сменить синьора' : 'Назначить синьора'}
              </DialogTitle>
              <DialogDescription className="sr-only">
                Смена или назначение синьора в команде. Текущий синьор будет откреплён.
              </DialogDescription>
              <p className="text-xs text-muted-foreground mt-1">
                {activeSenior
                  ? `Текущий синьор «${activeSenior.displayName}» будет откреплён. Новый синьор должен быть без активной команды.`
                  : 'Выберите синьора без активной команды. Дроп и остальные участники команды остаются.'}
              </p>
            </CrmDialogHeader>
            <CrmDialogBody className="space-y-3">
              <div className="grid gap-1.5">
                <Label>Новый синьор</Label>
                {vacantSeniors.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">
                    Нет синьоров без активной команды
                  </p>
                ) : (
                  <Select value={newSeniorId} onValueChange={setNewSeniorId}>
                    <SelectTrigger data-testid="team-rotate-senior-select">
                      <SelectValue placeholder="— выберите синьора —" />
                    </SelectTrigger>
                    <SelectContent>
                      {vacantSeniors.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          <div className="flex items-center gap-2">
                            <Avatar className="h-5 w-5">
                              {s.avatarUrl && <AvatarImage src={s.avatarUrl} alt={s.displayName} />}
                              <AvatarFallback className="text-[9px]">
                                {getInitials(s.displayName)}
                              </AvatarFallback>
                            </Avatar>
                            <span>{s.displayName}</span>
                            <span className="text-[10px] text-muted-foreground">{s.email}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </CrmDialogBody>
            <CrmDialogFooter>
              <Button
                variant="ghost"
                onClick={() => {
                  setRotateSeniorOpen(false)
                  setNewSeniorId('')
                }}
              >
                Отмена
              </Button>
              <Button
                disabled={!newSeniorId || rotateSeniorMutation.isPending}
                onClick={() => rotateSeniorMutation.mutate(newSeniorId)}
                data-testid="team-rotate-senior-submit"
              >
                {rotateSeniorMutation.isPending
                  ? 'Сохранение...'
                  : activeSenior
                    ? 'Сменить'
                    : 'Назначить'}
              </Button>
            </CrmDialogFooter>
          </CrmDialogContent>
        </Dialog>
      </motion.div>
    </div>
  )
}

/**
 * ut-39b: Header-level Unarchive button — replaces the AdminActionsMenu
 * dropdown for archived teams. Pair-unarchive (team + senior in one tx) is
 * handled by the backend.
 */
function TeamUnarchiveHeaderButton({ teamId }: { teamId: string }) {
  const unarchive = useUnarchiveEntity('team', teamId)
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => void unarchive.mutateAsync({})}
      disabled={unarchive.isPending}
      className="gap-1.5"
      data-testid="team-unarchive-button"
    >
      <ArchiveRestore className="h-4 w-4" />
      Восстановить
    </Button>
  )
}
