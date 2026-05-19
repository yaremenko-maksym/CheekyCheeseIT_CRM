import { createFileRoute, Link } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { ArrowLeft, Briefcase, Calendar, Mail, Pencil, Phone, Send, UserMinus, UserPlus, Users } from 'lucide-react'
import { useState } from 'react'
import type { ProjectDto, TeamDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
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
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'

export const Route = createFileRoute('/crm/team/$teamId')({
  component: TeamDetailPage,
})

const ROLE_LABELS: Record<string, string> = {
  ADMIN: 'Администратор',
  SENIOR: 'Синьор',
  JUNIOR: 'Джун',
  HR: 'HR',
  ACCOUNTANT: 'Бухгалтер',
}

const ROLE_VARIANT: Record<string, 'admin' | 'senior' | 'junior' | 'hr' | 'accountant'> = {
  ADMIN: 'admin',
  SENIOR: 'senior',
  JUNIOR: 'junior',
  HR: 'hr',
  ACCOUNTANT: 'accountant',
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
  avatar: string | null
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
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'])
  const { user } = useAuth()
  const { teamId } = Route.useParams()
  const queryClient = useQueryClient()

  const [showEdit, setShowEdit] = useState(false)
  const [showAddMember, setShowAddMember] = useState(false)

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => api.delete(`/teams/${teamId}/members/${userId}`),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['team', teamId] }) },
  })

  if (denied) return null

  const { data: team, isLoading, error } = useQuery({
    queryKey: ['team', teamId],
    queryFn: () => fetchTeam(teamId),
    enabled: !!user && !!teamId,
  })

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
    enabled: !!user,
  })

  const canManage = user?.role === 'ADMIN' || (user?.role === 'HR' && team?.members.some(m => m.userId === user?.id))

  const { data: allUsers } = useQuery<UserOption[]>({
    queryKey: ['users'],
    queryFn: () => api.get<UserOption[]>('/users').then((r) => r.data),
    enabled: !!(user && canManage),
  })

  // Edit form
  const editForm = useForm({
    defaultValues: { name: team?.name ?? '', telegram: team?.telegram ?? '', notes: team?.notes ?? '' },
    onSubmit: async ({ value }) => {
      await updateMutation.mutateAsync(value)
    },
  })

  const updateMutation = useMutation({
    mutationFn: (data: { name: string; telegram: string; notes: string }) =>
      api.patch(`/teams/${teamId}`, data),
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

  // Compute active projects for this team
  const activeProjects = projects?.filter(
    (p) =>
      p.status === 'ACTIVE' &&
      team?.members.some((m) => m.role === 'SENIOR' && m.userId === p.seniorId),
  ) ?? []

  // Junior sees only their own project
  const visibleProjects =
    user?.role === 'JUNIOR'
      ? activeProjects.filter((p) =>
          p.members?.some((m: { userId: string; leftAt: string | null }) => m.userId === user.id && m.leftAt === null),
        )
      : activeProjects

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-9 rounded-md" />
          <div className="space-y-1.5">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            <Skeleton className="h-48 rounded-xl" />
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
        <Button asChild variant="outline" size="sm" className="mt-4">
          <Link to="/crm/team">
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Вернуться к списку
          </Link>
        </Button>
      </div>
    )
  }


  // Add member dialog filtering logic
  const memberUserIds = new Set(team?.members.map((m) => m.userId) ?? [])
  const teamHasSenior = team?.members.some((m) => m.role === 'SENIOR') ?? false

  const juniorIdsWithProjects = new Set(
    projects?.flatMap((p) =>
      p.status === 'ACTIVE'
        ? p.members
            ?.filter((m: { leftAt: string | null }) => m.leftAt === null)
            .map((m: { userId: string }) => m.userId) ?? []
        : [],
    ) ?? [],
  )

  type CandidateUser = UserOption & { disabledReason?: string }

  const candidateUsers: CandidateUser[] = (allUsers || [])
    .filter((u: UserOption) => u.role !== 'ADMIN')
    .map((u: UserOption): CandidateUser => {
      if (memberUserIds.has(u.id)) return { ...u, disabledReason: 'в команде' }
      if (u.role === 'SENIOR' && teamHasSenior) return { ...u, disabledReason: 'уже есть синьор' }
      if (u.role === 'JUNIOR' && juniorIdsWithProjects.has(u.id)) return { ...u, disabledReason: 'есть проект' }
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

  return (
    <motion.div 
      className="space-y-6"
      variants={container}
      initial="hidden"
      animate="show"
    >
      {/* Header */}
      <motion.div variants={item} className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="icon" className="shrink-0">
            <Link to="/crm/team">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{team.name}</h1>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" />
                Создана {new Date(team.createdAt).toLocaleDateString('ru-RU', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
              </div>
              {team.telegram && (
                <a
                  href={team.telegram}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-blue-500/50 px-4 py-2 text-sm font-medium text-blue-400 hover:bg-blue-500/10 hover:border-blue-400 transition-colors"
                >
                  <Send className="h-3 w-3" />
                  Telegram-канал
                </a>
              )}
            </div>
          </div>
        </div>
        {canManage && (
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setShowAddMember(true)}>
              <UserPlus className="h-4 w-4" />
              Добавить
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => {
                editForm.setFieldValue('name', team.name)
                editForm.setFieldValue('telegram', team.telegram ?? '')
                editForm.setFieldValue('notes', team.notes ?? '')
                setShowEdit(true)
              }}
            >
              <Pencil className="h-4 w-4" />
              Редактировать
            </Button>
          </div>
        )}
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
                // Filter out other JUNIORs if current user is JUNIOR
                const visibleMembers = user?.role === 'JUNIOR' 
                  ? team.members.filter(m => m.role !== 'JUNIOR')
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
                        <Link
                          to="/crm/users/$userId"
                          params={{ userId: member.userId }}
                          className="flex min-w-0 flex-1 items-center gap-3 hover:opacity-80 transition-opacity"
                        >
                          <Avatar className="h-9 w-9 shrink-0">
                            {member.avatar && <AvatarImage src={member.avatar} alt={member.displayName} />}
                            <AvatarFallback className="bg-muted text-xs">{getInitials(member.displayName)}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <p className="truncate text-sm font-medium leading-tight">{member.displayName}</p>
                              <Badge variant={ROLE_VARIANT[member.role] ?? 'junior'} className="text-[9px] shrink-0">
                                {ROLE_LABELS[member.role] ?? member.role}
                              </Badge>
                            </div>
                            {member.techStack && (
                              <Badge variant="outline" className="mt-1 text-[9px] px-1.5 py-0 font-mono">
                                {member.techStack}
                              </Badge>
                            )}
                            <div className="mt-1 space-y-0.5">
                              <a href={`mailto:${member.email}`}
                                 onClick={e => e.stopPropagation()}
                                 className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors truncate">
                                <Mail className="h-3 w-3 shrink-0" />
                                {member.email}
                              </a>
                              {member.telegram && (
                                <a href={member.telegram} target="_blank" rel="noopener noreferrer"
                                   onClick={e => e.stopPropagation()}
                                   className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
                                  <Send className="h-3 w-3 shrink-0" />
                                  {member.telegram.replace('https://t.me/', '@')}
                                </a>
                              )}
                              {member.phone && (
                                <a href={`tel:${member.phone}`}
                                   onClick={e => e.stopPropagation()}
                                   className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors">
                                  <Phone className="h-3 w-3 shrink-0" />
                                  {member.phone}
                                </a>
                              )}
                            </div>
                          </div>
                        </Link>
                        {canManage && (() => {
                          const membersByRole = team.members.reduce((acc, m) => {
                            if (!acc[m.role]) acc[m.role] = []
                            acc[m.role]!.push(m)
                            return acc
                          }, {} as Record<string, typeof team.members>)
                          
                          const isSenior = member.role === 'SENIOR'
                          const isJunior = member.role === 'JUNIOR'
                          const isLastHr = member.role === 'HR' && membersByRole.HR && membersByRole.HR.length <= 1
                          const isLastAccountant = member.role === 'ACCOUNTANT' && membersByRole.ACCOUNTANT && membersByRole.ACCOUNTANT.length <= 1
                          const isSelf = member.userId === user?.id
                          const canRemove = !isSenior && !isJunior && !isLastHr && !isLastAccountant &&
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

        {/* Active Projects */}
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
                <p className="text-sm text-muted-foreground py-4 text-center">Нет активных проектов</p>
              ) : (
                <div className="space-y-2">
                  {visibleProjects.map((project) => {
                    const juniorMember = project.members?.find(
                      (m: { role: string; leftAt: string | null }) => m.role === 'JUNIOR' && m.leftAt === null
                    )
                    const junior = juniorMember
                      ? team.members.find(m => m.userId === juniorMember.userId)
                      : null
                    return (
                    <Link
                      key={project.id}
                      to="/crm/projects/$projectId"
                      params={{ projectId: project.id }}
                      className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/50 p-3 transition-all hover:border-primary/30 hover:bg-card"
                    >
                      <Avatar className="h-8 w-8 rounded-md shrink-0">
                        {project.logoUrl && <AvatarImage src={project.logoUrl} alt={project.name} />}
                        <AvatarFallback className="rounded-md text-xs">
                          {project.companyName.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{project.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{project.companyName}</p>
                        {junior ? (
                          <div className="flex items-center gap-1.5 mt-1">
                            <Avatar className="h-4 w-4">
                              {junior.avatar && <AvatarImage src={junior.avatar} alt={junior.displayName} />}
                              <AvatarFallback className="bg-muted text-[8px]">{getInitials(junior.displayName)}</AvatarFallback>
                            </Avatar>
                            <span className="text-xs text-muted-foreground truncate">{junior.displayName}</span>
                          </div>
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
      </div>

      {/* Edit Team Dialog */}
      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <CrmDialogContent>
          <CrmDialogHeader>
            <DialogTitle>Редактировать команду</DialogTitle>
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
                  }
                }}
              >
                {(field) => (
                  <div className="grid gap-1.5">
                    <Label htmlFor="edit-telegram">Telegram</Label>
                    <Input
                      id="edit-telegram"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      placeholder="https://t.me/team_chat"
                    />
                    {field.state.meta.errors[0] && (
                      <p className="text-xs text-destructive">{String(field.state.meta.errors[0])}</p>
                    )}
                    <p className="text-xs text-muted-foreground">Ссылка на Telegram-чат команды</p>
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
      <Dialog open={showAddMember} onOpenChange={(open) => { setShowAddMember(open); if (!open) setSelectedUserIds(new Set()) }}>
        <CrmDialogContent>
          <CrmDialogHeader>
            <DialogTitle>Добавить участника</DialogTitle>
          </CrmDialogHeader>
          <CrmDialogBody>
            <div className="space-y-1.5 max-h-80 overflow-y-auto pr-1">
              {candidateUsers.length === 0 && (
                <p className="py-4 text-center text-sm text-muted-foreground">Нет доступных пользователей</p>
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
                        <div className={cn(
                          'h-4 w-4 shrink-0 rounded border',
                          isSelected ? 'border-primary bg-primary flex items-center justify-center' : 'border-border',
                        )}>
                          {isSelected && <span className="text-[10px] text-primary-foreground font-bold">✓</span>}
                        </div>
                      )}
                      {isDisabled && <div className="h-4 w-4 shrink-0" />}
                      <Avatar className="h-6 w-6 shrink-0">
                        {u.avatar && <AvatarImage src={u.avatar} alt={u.displayName} />}
                        <AvatarFallback className="text-[9px]">{getInitials(u.displayName)}</AvatarFallback>
                      </Avatar>
                      <span className="flex-1 truncate text-sm">{u.displayName}</span>
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {ROLE_LABELS[u.role] ?? u.role}
                      </Badge>
                      {u.disabledReason && (
                        <span className="text-[10px] text-muted-foreground shrink-0">{u.disabledReason}</span>
                      )}
                    </button>
                  </div>
                )
              })}
            </div>
          </CrmDialogBody>
          <CrmDialogFooter>
            <Button variant="outline" onClick={() => { setShowAddMember(false); setSelectedUserIds(new Set()) }}>
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
    </motion.div>
  )
}