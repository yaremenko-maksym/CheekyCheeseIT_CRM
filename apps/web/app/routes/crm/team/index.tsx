import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { ArchiveRestore, Check, Pencil, Plus, Search, Send, UserPlus, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { TechAutocompleteInput } from '@/components/ui/tech-autocomplete-input'
import { useUnarchiveEntity } from '@/hooks/use-archive'
import { AdminActionsMenu } from '@/components/admin-actions/AdminActionsMenu'

const teamSearchSchema = z.object({
  archived: z.boolean().optional(),
})

export const Route = createFileRoute('/crm/team/')({
  validateSearch: (search) => teamSearchSchema.parse(search),
  component: TeamPage,
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

const container = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.07 } },
}
const item = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: { duration: 0.35, ease: [0.25, 0.1, 0.25, 1] as const } },
}

type UserOption = { id: string; displayName: string; email: string; role: string; avatar: string | null }

async function fetchTeams(archived = false): Promise<TeamDto[]> {
  const res = await api.get<TeamDto[]>(`/teams${archived ? '?archived=true' : ''}`)
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

function ShareSlider({
  value,
  onChange,
  onBlur,
  seniorPct,
  error,
}: {
  value: number
  onChange: (v: number) => void
  onBlur?: () => void
  seniorPct: number
  error?: boolean
}) {
  return (
    <div className="space-y-3">
      <div className="relative h-7 rounded-md overflow-hidden flex text-[11px] font-medium select-none">
        <div
          className="flex items-center justify-center bg-primary/20 text-primary transition-all duration-150"
          style={{ width: `${value}%` }}
        >
          {value >= 12 ? `${value}% компания` : ''}
        </div>
        <div
          className="flex items-center justify-center bg-emerald-500/20 text-emerald-400 transition-all duration-150"
          style={{ width: `${seniorPct}%` }}
        >
          {seniorPct >= 12 ? `${seniorPct}% синьор` : ''}
        </div>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={1}
          max={100}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          onBlur={onBlur}
          className="flex-1 h-2 accent-primary cursor-pointer"
        />
        <input
          type="number"
          min={1}
          max={100}
          value={value}
          onChange={(e) => {
            const n = Math.min(100, Math.max(1, Number(e.target.value)))
            onChange(n)
          }}
          onBlur={onBlur}
          className={cn(
            'w-16 rounded-md border border-input bg-background px-2 py-1 text-sm text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
            error && 'border-destructive',
          )}
        />
      </div>
    </div>
  )
}

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
                  const val = field.state.value ?? 26
                  const seniorPct = 100 - val
                  const err = field.state.meta.isTouched ? (field.state.meta.errors[0] as string | undefined) : undefined
                  return (
                    <Field label="Доля компании (%)" error={err} required>
                      <ShareSlider
                        value={val}
                        onChange={(v) => field.handleChange(v)}
                        onBlur={field.handleBlur}
                        seniorPct={seniorPct}
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
  const queryClient = useQueryClient()

  const canManage = user?.role === 'ADMIN' || user?.role === 'HR'
  const isHr = user?.role === 'HR'
  const isAdmin = user?.role === 'ADMIN'

  const { data: teams, isLoading } = useQuery({
    queryKey: ['teams', { archived: isArchivedView }],
    queryFn: () => fetchTeams(isArchivedView),
    enabled: !!user,
  })

  // Auto-redirect for SENIOR and JUNIOR users who have only one team
  useEffect(() => {
    if (!teams || isLoading || !user) return
    
    if (user.role === 'SENIOR' || user.role === 'JUNIOR') {
      if (teams.length === 1 && teams[0]) {
        navigate({ to: '/crm/team/$teamId', params: { teamId: teams[0].id } })
      }
    }
  }, [teams, isLoading, user, navigate])

  const { data: allUsers } = useQuery({
    queryKey: ['users'],
    queryFn: fetchAllUsers,
    enabled: canManage,
  })

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: fetchProjects,
    enabled: !!user,
  })

  // HR: create senior dialog
  const [showCreateSenior, setShowCreateSenior] = useState(false)

  // Edit team name
  const [editTeam, setEditTeam] = useState<TeamDto | null>(null)

  const updateMutation = useMutation({
    mutationFn: ({ id, name, telegram, notes }: { id: string; name: string; telegram?: string | null; notes?: string | null }) =>
      api.patch(`/teams/${id}`, { name, telegram, notes }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      setEditTeam(null)
    },
  })

  const teamNameSchema = z.string().min(1, 'Обязательное поле').max(255, 'Максимум 255 символов')

  const editForm = useForm({
    defaultValues: { name: '', telegram: '', notes: '' },
    onSubmit: async ({ value }) => {
      if (!editTeam) return
      updateMutation.mutate({ 
        id: editTeam.id, 
        name: value.name.trim(),
        telegram: value.telegram.trim() || null,
        notes: value.notes.trim() || null
      })
    },
  })

  // Add member
  const [addMemberTeam, setAddMemberTeam] = useState<TeamDto | null>(null)
  const [addMemberUserId, setAddMemberUserId] = useState('')

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
              (p) => p.status === 'ACTIVE' && a.members.some((m) => m.role === 'SENIOR' && m.userId === p.seniorId),
            ).length
          : 0
        const bProjects = projects
          ? projects.filter(
              (p) => p.status === 'ACTIVE' && b.members.some((m) => m.role === 'SENIOR' && m.userId === p.seniorId),
            ).length
          : 0
        return bProjects - aProjects
      }
      return 0
    })

    return result
  }, [teams, projects, search, sortBy])

  const addMemberMutation = useMutation({
    mutationFn: ({ teamId, userId }: { teamId: string; userId: string }) =>
      api.post(`/teams/${teamId}/members`, { userId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      setAddMemberTeam(null)
      setAddMemberUserId('')
    },
  })


  const availableUsers = allUsers?.filter(
    (u) => !addMemberTeam?.members.some((m) => m.userId === u.id),
  ) ?? []

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Команда</h1>
        <div className="flex items-center gap-2">
          {isAdmin && (
            <Button
              variant={isArchivedView ? 'default' : 'outline'}
              size="sm"
              className="gap-1.5"
              onClick={() =>
                navigate({
                  to: '/crm/team',
                  search: isArchivedView ? {} : { archived: true },
                })
              }
              data-testid="toggle-archived-teams"
            >
              <ArchiveRestore className="h-4 w-4" />
              {isArchivedView ? 'Показать активные' : 'Показать архивных'}
            </Button>
          )}
          {isHr && (
            <Button onClick={() => setShowCreateSenior(true)} size="sm" className="gap-1.5">
              <Plus className="h-4 w-4" />
              Создать синьора
            </Button>
          )}
        </div>
      </div>

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
        layout
      >
        {filteredTeams.length === 0 && (teams?.length ?? 0) > 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Ничего не найдено
          </p>
        )}
        <AnimatePresence mode="popLayout" initial={false}>
        {filteredTeams.map((team) => {
          const canManage = user?.role === 'ADMIN' || (user?.role === 'HR' && team.members.some((m) => m.userId === user.id && m.role === 'HR'))
          const hrMembers = team.members.filter((m) => m.role === 'HR')
          const activeProjects = projects
            ? projects.filter(
                (p) => p.status === 'ACTIVE' && team.members.some((m) => m.role === 'SENIOR' && m.userId === p.seniorId),
              ).length
            : 0
          const isArchived = !!team.archivedAt

          return (
            <motion.div
              key={team.id}
              variants={item}
              layout
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
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

                {/* Rename / Unarchive / Admin actions */}
                {isArchived && isAdmin && (
                  <div className="relative z-30 flex shrink-0 gap-1">
                    <TeamUnarchiveButton teamId={team.id} />
                  </div>
                )}
                {!isArchived && canManage && (
                  <div
                    className="relative z-30 flex shrink-0 gap-1"
                    onClick={(e) => {
                      // Prevent the underlying Link from navigating when interacting with
                      // any action control (rename / admin menu / dialogs spawned by them).
                      e.stopPropagation()
                      e.preventDefault()
                    }}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        setEditTeam(team)
                        editForm.setFieldValue('name', team.name)
                        editForm.setFieldValue('telegram', team.telegram || '')
                        editForm.setFieldValue('notes', team.notes || '')
                      }}
                      title="Переименовать"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    {isAdmin && (
                      <AdminActionsMenu
                        entityType="team"
                        entityId={team.id}
                        entityName={team.name}
                        isArchived={false}
                      />
                    )}
                  </div>
                )}
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

      {/* Edit team dialog */}
      <Dialog open={!!editTeam} onOpenChange={(open) => { if (!open) setEditTeam(null) }}>
        <CrmDialogContent maxWidth="sm:max-w-md">
          <CrmDialogHeader>
            <DialogTitle>Редактировать команду</DialogTitle>
          </CrmDialogHeader>
          <CrmDialogBody className="pb-2">
            <div className="grid gap-4">
              {/* Name */}
              <editForm.Field
                name="name"
                validators={{ onBlur: ({ value }) => {
                  const r = teamNameSchema.safeParse(value.trim())
                  return r.success ? undefined : r.error.issues[0]?.message
                }}}
              >
                {(field) => {
                  const err = field.state.meta.isTouched ? (field.state.meta.errors[0] as string | undefined) : undefined
                  return (
                    <Field label="Название" error={err} required>
                      <Input
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                        placeholder="Название команды"
                        className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                      />
                    </Field>
                  )
                }}
              </editForm.Field>

              {/* Telegram */}
              <editForm.Field
                name="telegram"
                validators={{ onBlur: ({ value }) => {
                  if (!value.trim()) return undefined
                  const r = z.string().url('Некорректное URL').safeParse(value.trim())
                  return r.success ? undefined : r.error.issues[0]?.message
                }}}
              >
                {(field) => {
                  const err = field.state.meta.isTouched ? (field.state.meta.errors[0] as string | undefined) : undefined
                  return (
                    <Field label="Telegram" error={err}>
                      <Input
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={field.handleBlur}
                        placeholder="https://t.me/..."
                        className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                      />
                      <p className="text-xs text-muted-foreground">Ссылка на чат команды</p>
                    </Field>
                  )
                }}
              </editForm.Field>

              {/* Notes */}
              <editForm.Field name="notes">
                {(field) => (
                  <Field label="Заметки">
                    <Textarea
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      placeholder="Внутренние заметки…"
                      className="min-h-20"
                    />
                  </Field>
                )}
              </editForm.Field>
            </div>
          </CrmDialogBody>
          <CrmDialogFooter>
            <Button variant="ghost" onClick={() => setEditTeam(null)}>Отмена</Button>
            <Button onClick={() => void editForm.handleSubmit()} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? 'Сохранение...' : 'Сохранить'}
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>

      {/* Archive is now handled via AdminActionsMenu on the team detail page
          (ArchiveConfirmDialog with senior-name confirmation). No bulk delete UI here. */}

      {/* Add member dialog */}
      <Dialog open={!!addMemberTeam} onOpenChange={(open) => !open && setAddMemberTeam(null)}>
        <CrmDialogContent maxWidth="sm:max-w-sm">
          <CrmDialogHeader>
            <DialogTitle>Добавить участника — {addMemberTeam?.name}</DialogTitle>
          </CrmDialogHeader>
          <CrmDialogBody className="pb-2">
            <div className="space-y-3">
              <Label>Выберите сотрудника</Label>
              <div className="space-y-1">
                {availableUsers.length === 0 && (
                  <p className="text-sm text-muted-foreground">Все сотрудники уже в команде</p>
                )}
                {availableUsers.map((u) => (
                  <button
                    key={u.id}
                    className={cn('flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent', addMemberUserId === u.id && 'bg-accent')}
                    onClick={() => setAddMemberUserId(u.id)}
                  >
                    <Avatar className="h-7 w-7 shrink-0">
                      {u.avatar && <AvatarImage src={u.avatar} />}
                      <AvatarFallback className="bg-muted text-[10px]">{getInitials(u.displayName)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{u.displayName}</p>
                      <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                    </div>
                    <Badge variant={ROLE_VARIANT[u.role] ?? 'junior'} className="shrink-0 text-[10px]">
                      {ROLE_LABELS[u.role] ?? u.role}
                    </Badge>
                  </button>
                ))}
              </div>
            </div>
          </CrmDialogBody>
          <CrmDialogFooter>
            <Button variant="outline" onClick={() => setAddMemberTeam(null)}>Отмена</Button>
            <Button
              onClick={() => {
                if (addMemberTeam && addMemberUserId) {
                  addMemberMutation.mutate({ teamId: addMemberTeam.id, userId: addMemberUserId })
                }
              }}
              disabled={!addMemberUserId || addMemberMutation.isPending}
            >
              Добавить
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>
    </div>
  )
}

/**
 * Pair-unarchive a team (restores team + senior in one tx; projects stay archived).
 * Lives at list level so each row instantiates its own mutation hook.
 */
function TeamUnarchiveButton({ teamId }: { teamId: string }) {
  const unarchive = useUnarchiveEntity('team', teamId)
  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-1 h-7 px-2"
      disabled={unarchive.isPending}
      onClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
        void unarchive.mutateAsync({})
      }}
      data-testid={`team-unarchive-${teamId}`}
    >
      <ArchiveRestore className="h-3.5 w-3.5" />
      <span className="text-xs">Восстановить</span>
    </Button>
  )
}
