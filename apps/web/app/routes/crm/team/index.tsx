import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { SegmentedToggle, type SegmentedToggleOption } from '@/components/ui/segmented-toggle'
import { Archive, Check, Plus, Search, Send, UserPlus, Users } from 'lucide-react'
import { useEffect, useMemo, useState, useTransition } from 'react'
import { isValidPhoneNumber } from 'react-phone-number-input'
import type { Value as PhoneValue } from 'react-phone-number-input'
import { z } from 'zod'
import type { CreateUserDto, ProjectDto, TeamDto, UserProfileDto } from '@crm/shared'
import { createUserSchema, updateProfileSchema } from '@crm/shared'
import type { AxiosError } from 'axios'
import { cn } from '@/lib/utils'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
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
import { PhoneInput } from '@/components/ui/phone-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ShareSlider } from '@/components/ui/share-slider'
import { toast } from 'sonner'
import { TechAutocompleteInput } from '@/components/ui/tech-autocomplete-input'

const teamSearchSchema = z.object({
  archived: z.boolean().optional(),
})

export const Route = createFileRoute('/crm/team/')({
  validateSearch: (search) => teamSearchSchema.parse(search),
  component: TeamPage,
})

function getInitials(name: string) {
  return (name || '?')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
}
const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.25, 0.1, 0.25, 1] as const } },
}

type UserOption = { id: string; displayName: string; email: string; role: string; avatar: string | null }

async function fetchTeams(archivedQuery: '' | 'true' | 'all' = ''): Promise<TeamDto[]> {
  const res = await api.get<TeamDto[]>(`/teams${archivedQuery ? `?archived=${archivedQuery}` : ''}`)
  return res.data
}

async function fetchAllUsers(): Promise<UserOption[]> {
  const res = await api.get<UserOption[]>('/users')
  return res.data
}

async function fetchProjects(): Promise<ProjectDto[]> {
  const res = await api.get<ProjectDto[]>('/projects')
  return res.data
}

// ── Field wrapper ─────────────────────────────────────────────────────────────

function Field({
  label,
  error,
  required,
  children,
}: {
  label: string
  error?: string | undefined
  required?: boolean | undefined
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <Label className={cn(error && 'text-destructive')}>
        {label}
        {required && <span className="ml-0.5 text-destructive">*</span>}
      </Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}

// ── Share slider ──────────────────────────────────────────────────────────────
// The component lives in `@/components/ui/share-slider` (relocated from
// `components/users/` in PR #39 round 1). `value` is the SENIOR's share
// (matches API field `seniorSharePercent`). Visual order [company %] [senior %].

const telegramFieldSchema = updateProfileSchema.shape.telegram.unwrap().unwrap()
const phoneFieldSchema = z.string().max(30)

function normalizeTelegram(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`
}

// ── HR: Create Senior Dialog ──────────────────────────────────────────────────
// HR uses this to create a new SENIOR user (which auto-creates the team).
// hrIds is pre-filled with the current HR user; accountant is optional.

function HrCreateSeniorDialog({
  open,
  onClose,
  hrUserId,
}: {
  open: boolean
  onClose: () => void
  hrUserId: string
}) {
  const queryClient = useQueryClient()

  const { data: allUsers } = useQuery({
    queryKey: ['users'],
    queryFn: fetchAllUsers,
    enabled: open,
  })

  const accountantUsers = useMemo(
    () => (allUsers ?? []).filter((u) => u.role === 'ACCOUNTANT'),
    [allUsers],
  )

  const [selectedAccountantId, setSelectedAccountantId] = useState('')

  useEffect(() => {
    if (!open) return
    setSelectedAccountantId(
      accountantUsers.length === 1 && accountantUsers[0] ? accountantUsers[0].id : '',
    )
  }, [open, accountantUsers])

  const mutation = useMutation({
    mutationFn: (data: CreateUserDto) => api.post<UserProfileDto>('/users', data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success('Синьор создан, команда сформирована')
      onClose()
      form.reset()
    },
    onError: (err: AxiosError<{ message: string }>) => {
      toast.error(err?.response?.data?.message ?? 'Ошибка при создании')
    },
  })

  const form = useForm({
    defaultValues: {
      email: '',
      displayName: '',
      telegram: '',
      phone: '' as PhoneValue | '',
      techStack: [] as string[],
      seniorSharePercent: 26 as number,
    },
    onSubmit: async ({ value }) => {
      const payload: CreateUserDto = {
        email: value.email.trim(),
        displayName: value.displayName.trim(),
        role: 'SENIOR',
        telegram: value.telegram.trim() ? normalizeTelegram(value.telegram) : undefined,
        phone: (value.phone as string) || undefined,
        techStack: value.techStack.length > 0 ? value.techStack : undefined,
        paymentMethod: 'USDT_ERC20' as const,
        seniorSharePercent: value.seniorSharePercent,
        hrIds: [hrUserId],
        accountantId: selectedAccountantId || null,
      }
      const result = createUserSchema.safeParse(payload)
      if (!result.success) {
        toast.error('Ошибка валидации данных')
        return
      }
      mutation.mutate(result.data)
    },
  })

  const handleClose = () => {
    form.reset()
    setSelectedAccountantId('')
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <CrmDialogContent maxWidth="sm:max-w-md">
        <CrmDialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            Создать синьора
          </DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Будет создан аккаунт синьора и сформирована команда с вами в роли HR.
          </p>
        </CrmDialogHeader>
        <CrmDialogBody>
          <div className="grid gap-4 py-2">
            {/* Email */}
            <form.Field
              name="email"
              validators={{
                onBlur: ({ value }) => {
                  const r = createUserSchema.shape.email.safeParse(value.trim())
                  return r.success ? undefined : r.error.issues[0]?.message
                },
              }}
            >
              {(field) => {
                const err = field.state.meta.isTouched ? (field.state.meta.errors[0] as string | undefined) : undefined
                return (
                  <Field label="Email" error={err} required>
                    <Input
                      placeholder="senior@cheekycheese.dev"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                      autoComplete="off"
                    />
                  </Field>
                )
              }}
            </form.Field>

            {/* Name */}
            <form.Field
              name="displayName"
              validators={{
                onBlur: ({ value }) => {
                  const r = createUserSchema.shape.displayName.safeParse(value.trim())
                  return r.success ? undefined : r.error.issues[0]?.message
                },
              }}
            >
              {(field) => {
                const err = field.state.meta.isTouched ? (field.state.meta.errors[0] as string | undefined) : undefined
                return (
                  <Field label="Имя и фамилия" error={err} required>
                    <Input
                      placeholder="Иван Иванов"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                    />
                  </Field>
                )
              }}
            </form.Field>

            {/* Tech Stack */}
            <form.Field name="techStack">
              {(field) => (
                <Field label="Технологии">
                  <TechAutocompleteInput
                    value={field.state.value}
                    onChange={field.handleChange}
                    onBlur={field.handleBlur}
                    placeholder="Начните вводить технологию..."
                  />
                </Field>
              )}
            </form.Field>

            {/* Telegram */}
            <form.Field
              name="telegram"
              validators={{
                onBlur: ({ value }) => {
                  if (!value.trim()) return undefined
                  const r = telegramFieldSchema.safeParse(value.trim())
                  return r.success ? undefined : r.error.issues[0]?.message
                },
              }}
            >
              {(field) => {
                const err = field.state.meta.isTouched ? (field.state.meta.errors[0] as string | undefined) : undefined
                return (
                  <Field label="Telegram" error={err}>
                    <Input
                      placeholder="@username"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                    />
                  </Field>
                )
              }}
            </form.Field>

            {/* Phone */}
            <form.Field
              name="phone"
              validators={{
                onBlur: ({ value }) => {
                  const v = value as string
                  if (!v) return undefined
                  const r = phoneFieldSchema.safeParse(v)
                  if (!r.success) return r.error.issues[0]?.message
                  if (!isValidPhoneNumber(v)) return 'Некорректный номер телефона'
                  return undefined
                },
              }}
            >
              {(field) => {
                const err = field.state.meta.isTouched ? (field.state.meta.errors[0] as string | undefined) : undefined
                return (
                  <Field label="Телефон" error={err}>
                    <PhoneInput
                      value={field.state.value as PhoneValue | undefined}
                      onChange={(v) => field.handleChange((v ?? '') as PhoneValue | '')}
                      onBlur={field.handleBlur}
                      className={cn(err && '[&_input]:border-destructive')}
                    />
                  </Field>
                )
              }}
            </form.Field>

            {/* Financials + team */}
            <div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-3">
              <p className="text-xs font-medium text-muted-foreground">Финансы и команда</p>

              {/* Share % */}
              <form.Field
                name="seniorSharePercent"
                validators={{
                  onBlur: ({ value }) => {
                    if (value < 1 || value > 100) return 'Введите от 1 до 100'
                    return undefined
                  },
                }}
              >
                {(field) => {
                  // ut-31: value is SENIOR's share (default 26 → 74% company / 26% senior).
                  const val = field.state.value ?? 26
                  const err = field.state.meta.isTouched ? (field.state.meta.errors[0] as string | undefined) : undefined
                  return (
                    <Field label="Доля синьора (%)" error={err} required>
                      <ShareSlider
                        value={val}
                        onChange={(v) => field.handleChange(v)}
                        onBlur={field.handleBlur}
                        error={!!err}
                      />
                    </Field>
                  )
                }}
              </form.Field>

              {/* HR — auto (current user) */}
              <Field label="HR">
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                  <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                  <span>Вы</span>
                  <span className="text-xs text-muted-foreground ml-auto">авто</span>
                </div>
              </Field>

              {/* Accountant */}
              <Field label="Бухгалтер">
                {accountantUsers.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">Нет доступных бухгалтеров</p>
                ) : accountantUsers.length === 1 ? (
                  <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                    <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    <span>{accountantUsers[0]!.displayName}</span>
                    <span className="text-xs text-muted-foreground ml-auto">авто</span>
                  </div>
                ) : (
                  <Select value={selectedAccountantId} onValueChange={setSelectedAccountantId}>
                    <SelectTrigger>
                      <SelectValue placeholder="— выберите бухгалтера —" />
                    </SelectTrigger>
                    <SelectContent>
                      {accountantUsers.map((u) => (
                        <SelectItem key={u.id} value={u.id}>{u.displayName}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            </div>
          </div>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button variant="ghost" onClick={handleClose}>Отмена</Button>
          <Button onClick={() => void form.handleSubmit()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Создание...' : 'Создать'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

function TeamPage() {
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'])
  const { user } = useAuth()
  const navigate = useNavigate()
  const routeSearch = Route.useSearch()
  const isArchivedView = routeSearch.archived === true
  if (denied) return null

  const isHr = user?.role === 'HR'
  const isAdmin = user?.role === 'ADMIN'

  // ut-44: tri-state filter — local ALL/ACTIVE plus URL-driven ARCHIVED.
  const [teamFilter, setTeamFilter] = useState<'ALL' | 'ACTIVE'>('ACTIVE')

  // ut-32: keepPreviousData + useTransition keep the previous list visible
  // during the URL switch + refetch so the SegmentedToggle's gold-pill
  // layout animation isn't interrupted by a render that throws the list
  // into a skeleton state mid-flight.
  const archivedQuery: '' | 'true' | 'all' = isArchivedView
    ? 'true'
    : teamFilter === 'ALL'
      ? 'all'
      : ''
  const { data: teams, isLoading } = useQuery({
    queryKey: ['teams', { archived: archivedQuery || 'active' }],
    queryFn: () => fetchTeams(archivedQuery),
    enabled: !!user,
    placeholderData: keepPreviousData,
  })

  const [, startTransition] = useTransition()

  // Auto-redirect for SENIOR and JUNIOR users who have only one team
  useEffect(() => {
    if (!teams || isLoading || !user) return
    
    if (user.role === 'SENIOR' || user.role === 'JUNIOR') {
      if (teams.length === 1 && teams[0]) {
        navigate({ to: '/crm/team/$teamId', params: { teamId: teams[0].id } })
      }
    }
  }, [teams, isLoading, user, navigate])

  // ut-39a: top-level users query removed — `HrCreateSeniorDialog` fetches
  // its own list on demand, and the rest of the page doesn't need user data.

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
    enabled: !!user,
  })

  // HR: create senior dialog
  const [showCreateSenior, setShowCreateSenior] = useState(false)

  // ut-39a: edit + add-member dialogs removed from list page — those flows
  // now live on the team detail page header.

  // Toolbar state
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<'name' | 'members' | 'projects'>('name')

  // Filtered and sorted teams
  const filteredTeams = useMemo(() => {
    if (!teams) return []
    let result = [...teams]

    if (search.trim()) {
      const q = search.toLowerCase()
      result = result.filter((t) => t.name.toLowerCase().includes(q))
    }

    result.sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name)
      if (sortBy === 'members') return b.members.length - a.members.length
      if (sortBy === 'projects') {
        const aProjects = projects
          ? projects.filter(
              (p) => p.archivedAt === null && a.members.some((m) => m.role === 'SENIOR' && m.userId === p.seniorId),
            ).length
          : 0
        const bProjects = projects
          ? projects.filter(
              (p) => p.archivedAt === null && b.members.some((m) => m.role === 'SENIOR' && m.userId === p.seniorId),
            ).length
          : 0
        return bProjects - aProjects
      }
      return 0
    })

    return result
  }, [teams, projects, search, sortBy])

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-1.5">
            <Skeleton className="h-7 w-32" />
            <Skeleton className="h-4 w-52" />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-52 rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  // ut-25 + ut-33 + ut-44: tabs for teams page — «Все | Активные | Архив»
  // for ADMIN, unified through SegmentedToggle so the gold-pill animation
  // lives in one place. The «Все» tab fetches with `archived=all`; the
  // «Архив» tab keeps the legacy `archived=true` query param + URL state.
  type TeamTab = 'ALL' | 'ACTIVE' | 'ARCHIVED'
  const teamTabs: ReadonlyArray<SegmentedToggleOption<TeamTab>> = [
    { value: 'ALL', label: 'Все' },
    { value: 'ACTIVE', label: 'Активные' },
    { value: 'ARCHIVED', label: 'Архив', testId: 'toggle-archived-teams', icon: Archive },
  ]
  const currentTeamTab: TeamTab = isArchivedView ? 'ARCHIVED' : teamFilter
  const handleTeamTabChange = (next: TeamTab) => {
    // ut-32: wrap navigation in startTransition so the gold-pill layout
    // animation isn't preempted by the query refetch render.
    startTransition(() => {
      if (next === 'ARCHIVED') {
        navigate({ to: '/crm/team', search: { archived: true } })
        return
      }
      if (isArchivedView) {
        navigate({ to: '/crm/team', search: {} })
      }
      setTeamFilter(next === 'ALL' ? 'ALL' : 'ACTIVE')
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Команда</h1>
        <div className="flex items-center gap-2">
          {isHr && (
            <Button onClick={() => setShowCreateSenior(true)} size="sm" className="gap-1.5">
              <Plus className="h-4 w-4" />
              Создать синьора
            </Button>
          )}
        </div>
      </div>

      {/* ut-25 + ut-26 + ut-33: Tabs row replacing the «Показать архивных» button.
          Only ADMIN sees the Archive tab; for other roles tabs aren't needed
          since they don't have access to archived teams. */}
      {isAdmin && (
        <SegmentedToggle<TeamTab>
          value={currentTeamTab}
          onChange={handleTeamTabChange}
          options={teamTabs}
          ariaLabel="Фильтр команд"
          variant="tabs"
          size="sm"
          layoutId="team-status-tabs"
          className="w-fit"
          testId="team-status-tabs"
        />
      )}

      {teams && teams.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
          <Users className="h-10 w-10 text-muted-foreground/30" />
          <p className="mt-4 text-sm font-medium">Команд пока нет</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {isHr
              ? 'Нажмите «Создать синьора» чтобы сформировать первую команду'
              : 'Команды создаются автоматически при добавлении синьора в систему'}
          </p>
        </div>
      )}

      {teams && teams.length > 0 && (
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Поиск по названию…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Сортування" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">Название A→Z</SelectItem>
              <SelectItem value="members">Участники ↓</SelectItem>
              <SelectItem value="projects">Проекты ↓</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <motion.div
        className="flex flex-col gap-1.5"
        variants={container}
        initial="hidden"
        animate="show"
      >
        {filteredTeams.length === 0 && (teams?.length ?? 0) > 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Ничего не найдено
          </p>
        )}
        <AnimatePresence mode="popLayout" initial={false}>
        {filteredTeams.map((team) => {
          // ut-39a: per-card management controls removed — all team CRUD is
          // performed from the detail page header. No need for per-team
          // RBAC computation here.
          const hrMembers = team.members.filter((m) => m.role === 'HR')
          const activeProjects = projects
            ? projects.filter(
                (p) => p.archivedAt === null && team.members.some((m) => m.role === 'SENIOR' && m.userId === p.seniorId),
              ).length
            : 0
          const isArchived = !!team.archivedAt

          return (
            <motion.div
              key={team.id}
              variants={item}
              layout="position"
              exit={{ opacity: 0 }}
              transition={{ duration: 0.08, ease: 'easeOut' }}
            >
              <div
                data-testid={`team-card-${team.id}`}
                data-archived={isArchived ? 'true' : 'false'}
                className={cn(
                  'group relative flex h-14 items-center gap-3 rounded-lg border border-border/60 bg-card/50 px-3 transition-all duration-200 hover:border-primary/30 hover:bg-card cursor-pointer',
                  isArchived && 'opacity-60',
                )}
                onClick={() => navigate({ to: '/crm/team/$teamId', params: { teamId: team.id } })}
              >
                <Link
                  to="/crm/team/$teamId"
                  params={{ teamId: team.id }}
                  className="absolute inset-0 z-10"
                  title={`Перейти до команди ${team.name}`}
                />

                {/* Avatars */}
                <div className="flex shrink-0 -space-x-2 relative z-20">
                  {team.members.slice(0, 4).map((member, index) => (
                    <Avatar
                      key={member.id}
                      className="h-7 w-7 ring-2 ring-background bg-muted"
                      style={{ zIndex: 4 - index }}
                    >
                      {member.avatar && <AvatarImage src={member.avatar} alt={member.displayName} />}
                      <AvatarFallback className="bg-muted text-[10px]">{getInitials(member.displayName)}</AvatarFallback>
                    </Avatar>
                  ))}
                  {team.members.length > 4 && (
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted ring-2 ring-background">
                      <span className="text-[9px] font-medium text-muted-foreground">
                        +{team.members.length - 4}
                      </span>
                    </div>
                  )}
                </div>

                {/* Name + HRs */}
                <div className="relative z-20 min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold group-hover:text-primary transition-colors">
                    {team.name}
                  </p>
                  <p className="truncate text-xs text-muted-foreground overflow-hidden whitespace-nowrap">
                    HR: {hrMembers.map((m) => m.displayName).join(', ') || 'Без HR'}
                  </p>
                </div>

                {/* Pills */}
                <div className="relative z-20 flex shrink-0 items-center gap-2">
                  {isArchived && (
                    <Badge
                      variant="outline"
                      className="border-amber-500/30 bg-amber-500/10 text-amber-500 text-[11px]"
                    >
                      В архиве
                    </Badge>
                  )}
                  {team.telegram && (
                    <a
                      href={team.telegram}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/30 px-2.5 py-1 text-xs font-medium text-blue-500 hover:bg-blue-500/10 transition-colors"
                    >
                      <Send className="h-3 w-3" />
                      Telegram
                    </a>
                  )}
                  <Badge variant="outline" className="text-[11px] tabular-nums">
                    {team.members.length} уч.
                  </Badge>
                  <Badge
                    variant="outline"
                    className={cn(
                      'text-[11px] tabular-nums',
                      activeProjects > 0
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                        : 'text-muted-foreground',
                    )}
                  >
                    {activeProjects} {activeProjects === 1 ? 'проект' : activeProjects < 5 ? 'проекта' : 'проектов'}
                  </Badge>
                </div>

                {/* ut-39a: rename / unarchive / admin actions removed from
                    list cards (matches ut-38 project pattern). All team
                    management lives on the detail page header. */}
              </div>
            </motion.div>
          )
        })}
        </AnimatePresence>
      </motion.div>

      {/* HR: Create senior dialog */}
      {isHr && user && (
        <HrCreateSeniorDialog
          open={showCreateSenior}
          onClose={() => setShowCreateSenior(false)}
          hrUserId={user.id}
        />
      )}

      {/* ut-39a: Edit + Add member + Unarchive flows live on the team detail
          page header — list page is purely navigational. */}
    </div>
  )
}
