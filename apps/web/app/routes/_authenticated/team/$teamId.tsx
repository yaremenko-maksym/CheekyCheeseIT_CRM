import { createFileRoute, Link } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Archive, ArrowLeft, Calendar, Pencil, RefreshCw, Send, UserPlus } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { TeamDto } from '@crm/shared'
import { compareNames, formatDate } from '@crm/shared'
import { Trans, useLingui } from '@lingui/react/macro'
import { useAuth } from '@/context/auth'
import { useLocale } from '@/lib/i18n'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { getApiErrorMessage } from '@/lib/axios-utils'
import { getInitialsBySpaceSplit } from '@/lib/initials'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { ProfileNameLink } from '@/components/users/ProfileNameLink'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { tgUrl } from '@/lib/tg-url'
import { ArchiveConfirmDialog } from '@/components/archive/ArchiveConfirmDialog'
import { container, item } from './team-detail/constants'
import { fetchTeam, fetchProjects } from './team-detail/api'
import type { UserOption } from './team-detail/api'
import { AddMemberDialog } from './team-detail/components/AddMemberDialog'
import type { CandidateUser } from './team-detail/components/AddMemberDialog'
import { MembersCard } from './team-detail/components/MembersCard'
import { ActiveProjectsCard } from './team-detail/components/ActiveProjectsCard'
import { TeamLoadingSkeleton } from './team-detail/components/TeamLoadingSkeleton'
import { TeamNotFound } from './team-detail/components/TeamNotFound'
import { TeamUnarchiveHeaderButton } from './team-detail/components/TeamUnarchiveHeaderButton'
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

  // tgUrl imported from @/lib/tg-url

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
              SENIOR/JUNIOR: they don't see the team list (no "Team" nav item).
              DROP: redirected to their one team — nowhere to go back to, the
              back button would loop. */}
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
                {/* Drop role - phase 1 (AC5): DROP badge + "drop's team"
                  caption surface the team type. Senior-teams render no
                  extra badge, header rendering 1:1 as before. */}
                {isDropTeam && (
                  <Badge variant="drop" data-testid="team-drop-badge">
                    <Trans>Команда дропа</Trans>
                  </Badge>
                )}
                {team.archivedAt ? (
                  <Badge
                    variant="outline"
                    className="border-amber-500/30 bg-amber-500/10 text-amber-500"
                    data-testid="team-archived-badge"
                  >
                    <Trans>В архіві</Trans>
                  </Badge>
                ) : (
                  <Badge
                    variant="outline"
                    className="border-emerald-500/30 bg-emerald-500/10 text-emerald-500"
                  >
                    <Trans>Активна</Trans>
                  </Badge>
                )}
              </div>
              {/* AC5: drop owner link under the title — quick navigation to
                the drop's profile, mirrors the "senior" bookmark on senior
                teams. */}
              {isDropTeam && dropOwner && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  <Trans>Дроп:</Trans>{' '}
                  <ProfileNameLink
                    userId={dropOwner.userId}
                    viewerRole={user?.role ?? 'JUNIOR'}
                    className="text-primary hover:underline font-medium"
                  >
                    {dropOwner.displayName}
                  </ProfileNameLink>
                  {activeSenior ? (
                    <>
                      <Trans> · Сеньйор: </Trans>
                      <ProfileNameLink
                        userId={activeSenior.userId}
                        viewerRole={user?.role ?? 'JUNIOR'}
                        className="text-primary hover:underline font-medium"
                      >
                        {activeSenior.displayName}
                      </ProfileNameLink>
                    </>
                  ) : (
                    <span className="ml-1 text-amber-500/80">
                      <Trans>· Сеньйора не призначено</Trans>
                    </span>
                  )}
                </p>
              )}
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" />
                  <Trans>Створено {formatDate(team.createdAt, locale, 'long')}</Trans>
                </div>
                {/* TG channel hidden from JUNIOR viewer per task #11 */}
                {team.telegram && user?.role !== 'JUNIOR' && (
                  <a
                    href={tgUrl(team.telegram)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg border border-blue-500/50 px-4 py-2 text-sm font-medium text-blue-400 hover:bg-blue-500/10 hover:border-blue-400 transition-colors"
                    data-testid="team-telegram-link"
                  >
                    <Send className="h-3 w-3" />
                    <Trans>Telegram-чат</Trans>
                  </a>
                )}
              </div>
            </div>
          </div>
          {/* ut-39b: "Actions" dropdown replaced with explicit Archive /
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
                {activeSenior ? t`Змінити сеньйора` : t`Призначити сеньйора`}
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
                  <Trans>Додати учасника</Trans>
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
                  <Trans>Редагувати</Trans>
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
                <Trans>Архівувати</Trans>
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

        {/* Edit Team Dialog */}
        <Dialog open={showEdit} onOpenChange={setShowEdit}>
          <CrmDialogContent>
            <CrmDialogHeader>
              <DialogTitle>
                <Trans>Редагувати команду</Trans>
              </DialogTitle>
              <DialogDescription className="sr-only">
                <Trans>Редагування назви, Telegram-посилання та заміток команди.</Trans>
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
                        <Trans>Назва</Trans> <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        id="edit-name"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        placeholder={t`Назва команди`}
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
                        return t`Посилання має починатися з https://t.me/`
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
                        <Trans>Посилання на Telegram-чат команди</Trans>
                      </p>
                    </div>
                  )}
                </editForm.Field>
                <editForm.Field name="notes">
                  {(field) => (
                    <div className="grid gap-1.5">
                      <Label htmlFor="edit-notes">
                        <Trans>Замітки</Trans>
                      </Label>
                      <Textarea
                        id="edit-notes"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        placeholder={t`Внутрішні замітки…`}
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
                set. The reset button clears back to empty (no override).
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
                          <Label>
                            <Trans>Частка сеньйора на рівні команди</Trans>
                          </Label>
                          {hasOverride && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs text-muted-foreground"
                              onClick={() => field.handleChange('')}
                              data-testid="team-edit-senior-share-override-reset"
                            >
                              <Trans>Скинути</Trans>
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
                          {hasOverride ? (
                            <Trans>
                              Задано для команди. Діє на всіх її проєктах, крім тих, де є
                              індивідуальна частка за проєктом.
                            </Trans>
                          ) : (
                            <Trans>
                              Не задано — діє частка сеньйора за замовчуванням (26%, якщо не
                              змінювали). Пересуньте повзунок, щоб задати частку для команди.
                            </Trans>
                          )}
                        </p>
                      </div>
                    )
                  }}
                </editForm.Field>
              </CrmDialogBody>
              <CrmDialogFooter>
                <Button type="button" variant="outline" onClick={() => setShowEdit(false)}>
                  <Trans>Скасувати</Trans>
                </Button>
                <Button type="submit" disabled={updateMutation.isPending}>
                  {updateMutation.isPending ? t`Зберігаємо…` : t`Зберегти`}
                </Button>
              </CrmDialogFooter>
            </form>
          </CrmDialogContent>
        </Dialog>

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
                {activeSenior ? t`Змінити сеньйора` : t`Призначити сеньйора`}
              </DialogTitle>
              <DialogDescription className="sr-only">
                <Trans>Оберіть сеньйора для команди.</Trans>
              </DialogDescription>
              <p className="text-xs text-muted-foreground mt-1">
                {activeSenior
                  ? t`Поточного сеньйора «${activeSenior.displayName}» буде знято з команди. Новий сеньйор має бути без активної команди.`
                  : t`Оберіть сеньйора без активної команди. Дроп та інші учасники команди залишаються.`}
              </p>
            </CrmDialogHeader>
            <CrmDialogBody className="space-y-3">
              <div className="grid gap-1.5">
                <Label>
                  <Trans>Новий сеньйор</Trans>
                </Label>
                {vacantSeniors.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">
                    <Trans>Немає сеньйорів без активної команди</Trans>
                  </p>
                ) : (
                  <Select value={newSeniorId} onValueChange={setNewSeniorId}>
                    <SelectTrigger data-testid="team-rotate-senior-select">
                      <SelectValue placeholder={t`— оберіть сеньйора —`} />
                    </SelectTrigger>
                    <SelectContent>
                      {vacantSeniors.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          <div className="flex items-center gap-2">
                            <Avatar className="h-5 w-5">
                              {s.avatarUrl && <AvatarImage src={s.avatarUrl} alt={s.displayName} />}
                              <AvatarFallback className="text-[9px]">
                                {getInitialsBySpaceSplit(s.displayName)}
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
                <Trans>Скасувати</Trans>
              </Button>
              <Button
                disabled={!newSeniorId || rotateSeniorMutation.isPending}
                onClick={() => rotateSeniorMutation.mutate(newSeniorId)}
                data-testid="team-rotate-senior-submit"
              >
                {rotateSeniorMutation.isPending
                  ? t`Зберігаємо…`
                  : activeSenior
                    ? t`Змінити`
                    : t`Призначити`}
              </Button>
            </CrmDialogFooter>
          </CrmDialogContent>
        </Dialog>
      </motion.div>
    </div>
  )
}
