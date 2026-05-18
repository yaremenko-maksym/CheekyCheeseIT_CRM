import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { ArrowLeft, Calendar, Users, UserPlus, UserMinus } from 'lucide-react'
import type { ProjectDto, TeamDto } from '@crm/shared'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'

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

  // Group members by role for better organization
  const membersByRole = team.members.reduce((acc, member) => {
    if (!acc[member.role]) acc[member.role] = []
    acc[member.role]!.push(member)
    return acc
  }, {} as Record<string, typeof team.members>)

  const roleOrder = ['SENIOR', 'HR', 'ACCOUNTANT', 'JUNIOR']
  const orderedRoles = roleOrder.filter(role => (membersByRole[role]?.length ?? 0) > 0)

  return (
    <motion.div 
      className="space-y-6"
      variants={container}
      initial="hidden"
      animate="show"
    >
      {/* Header */}
      <motion.div variants={item} className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="icon" className="shrink-0">
            <Link to="/crm/team">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{team.name}</h1>
            <p className="text-sm text-muted-foreground flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              Создана {new Date(team.createdAt).toLocaleDateString('ru-RU', { 
                day: 'numeric', 
                month: 'long', 
                year: 'numeric' 
              })}
            </p>
          </div>
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="gap-1.5">
              <UserPlus className="h-4 w-4" />
              Добавить участника
            </Button>
          </div>
        )}
      </motion.div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Main Content - Team Members */}
        <motion.div variants={item} className="lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                Участники команды
                <Badge variant="outline" className="ml-auto">
                  {team.members.length}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {orderedRoles.map(role => (
                <div key={role} className="space-y-3">
                  <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                    <Badge variant={ROLE_VARIANT[role] ?? 'junior'} className="text-[10px]">
                      {ROLE_LABELS[role] ?? role}
                    </Badge>
                    <span className="text-xs">({membersByRole[role]!.length})</span>
                  </h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {membersByRole[role]!.map(member => (
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
                            <AvatarFallback className="text-xs">
                              {getInitials(member.displayName)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium leading-tight">
                              {member.displayName}
                            </p>
                            <p className="truncate text-xs text-muted-foreground mt-0.5">
                              {member.email}
                            </p>
                            {member.techStack && (
                              <div className="mt-1">
                                <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-mono">
                                  {member.techStack}
                                </Badge>
                              </div>
                            )}
                          </div>
                        </Link>
                        {canManage && (() => {
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
                            >
                              <UserMinus className="h-3.5 w-3.5" />
                            </Button>
                          ) : null
                        })()}
                      </motion.div>
                    ))}
                  </div>
                </div>
              ))}
              
              {team.members.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <Users className="h-8 w-8 text-muted-foreground/30" />
                  <p className="mt-3 text-sm font-medium">Нет участников</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {canManage ? 'Добавьте первого участника' : 'Команда пока пуста'}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Sidebar - Team Stats */}
        <motion.div variants={item} className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Статистика</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Всего участников</span>
                <span className="font-medium">{team.members.length}</span>
              </div>
              {orderedRoles.map(role => (
                <div key={role} className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{ROLE_LABELS[role]}</span>
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium">{membersByRole[role]!.length}</span>
                    <Badge variant={ROLE_VARIANT[role] ?? 'junior'} className="text-[9px] px-1">
                      {role === 'JUNIOR' ? 'JN' : role === 'SENIOR' ? 'SR' : role === 'HR' ? 'HR' : 'AC'}
                    </Badge>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Активность</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Активные проекты</span>
                <span className="font-medium">
                  {projects
                    ? projects.filter(p =>
                        p.status === 'ACTIVE' &&
                        team.members.some(m => m.role === 'SENIOR' && m.userId === p.seniorId)
                      ).length
                    : '—'}
                </span>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </motion.div>
  )
}