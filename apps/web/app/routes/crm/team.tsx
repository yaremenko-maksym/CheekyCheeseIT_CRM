import { createFileRoute, Link } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { Check, Pencil, Plus, Trash2, UserMinus, UserPlus, Users } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { isValidPhoneNumber } from 'react-phone-number-input'
import type { Value as PhoneValue } from 'react-phone-number-input'
import { z } from 'zod'
import type { CreateUserDto, TeamDto, UserProfileDto } from '@crm/shared'
import { createUserSchema, updateProfileSchema } from '@crm/shared'
import type { AxiosError } from 'axios'
import { cn } from '@/lib/utils'
import { useAuth } from '@/context/auth'
import { useRoleGuard } from '@/hooks/use-role-guard'
import { api } from '@/lib/axios'
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
import { PhoneInput } from '@/components/ui/phone-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'

export const Route = createFileRoute('/crm/team')({
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

const TECH_STACK_OPTIONS = [
  'JavaScript FE', 'JavaScript BE', 'TypeScript FE', 'TypeScript BE',
  'Python', 'Java', 'Kotlin', 'Swift', 'Go', 'PHP', 'Ruby', 'C#', 'C++',
  'Rust', 'Flutter/Dart', 'React Native',
]

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

async function fetchTeams(): Promise<TeamDto[]> {
  const res = await api.get<TeamDto[]>('/teams')
  return res.data
}

async function fetchAllUsers(): Promise<UserOption[]> {
  const res = await api.get<UserOption[]>('/users')
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
      techStack: '',
      seniorSharePercent: 74 as number,
    },
    onSubmit: async ({ value }) => {
      const payload: CreateUserDto = {
        email: value.email.trim(),
        displayName: value.displayName.trim(),
        role: 'SENIOR',
        telegram: value.telegram.trim() ? normalizeTelegram(value.telegram) : undefined,
        phone: (value.phone as string) || undefined,
        techStack: value.techStack.trim() || undefined,
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
                  <Input
                    placeholder="JavaScript FE, Java, Kotlin..."
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                    list="hr-tech-stack-suggestions"
                  />
                  <datalist id="hr-tech-stack-suggestions">
                    {TECH_STACK_OPTIONS.map((opt) => (
                      <option key={opt} value={opt} />
                    ))}
                  </datalist>
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
  const { denied } = useRoleGuard(['ADMIN', 'SENIOR', 'HR', 'ACCOUNTANT'])
  const { user } = useAuth()
  if (denied) return null
  const queryClient = useQueryClient()

  const canManage = user?.role === 'ADMIN' || user?.role === 'HR'
  const isAdmin = user?.role === 'ADMIN'
  const isHr = user?.role === 'HR'

  const { data: teams, isLoading } = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams,
    enabled: !!user,
  })

  const { data: allUsers } = useQuery({
    queryKey: ['users'],
    queryFn: fetchAllUsers,
    enabled: canManage,
  })

  // HR: create senior dialog
  const [showCreateSenior, setShowCreateSenior] = useState(false)

  // Edit team name
  const [editTeam, setEditTeam] = useState<TeamDto | null>(null)

  const updateMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      api.patch(`/teams/${id}`, { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      setEditTeam(null)
    },
  })

  const teamNameSchema = z.string().min(1, 'Обязательное поле').max(255, 'Максимум 255 символов')

  const editForm = useForm({
    defaultValues: { name: '' },
    onSubmit: async ({ value }) => {
      if (!editTeam) return
      updateMutation.mutate({ id: editTeam.id, name: value.name.trim() })
    },
  })

  // Delete team
  const [deleteTeam, setDeleteTeam] = useState<TeamDto | null>(null)

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/teams/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      setDeleteTeam(null)
    },
  })

  // Add member
  const [addMemberTeam, setAddMemberTeam] = useState<TeamDto | null>(null)
  const [addMemberUserId, setAddMemberUserId] = useState('')

  const addMemberMutation = useMutation({
    mutationFn: ({ teamId, userId }: { teamId: string; userId: string }) =>
      api.post(`/teams/${teamId}/members`, { userId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      setAddMemberTeam(null)
      setAddMemberUserId('')
    },
  })

  // Remove member
  const removeMemberMutation = useMutation({
    mutationFn: ({ teamId, userId }: { teamId: string; userId: string }) =>
      api.delete(`/teams/${teamId}/members/${userId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['teams'] }),
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
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Команда</h1>
          <p className="text-sm text-muted-foreground">Состав и роли сотрудников</p>
        </div>
        {isHr && (
          <Button onClick={() => setShowCreateSenior(true)} size="sm" className="gap-1.5">
            <Plus className="h-4 w-4" />
            Создать синьора
          </Button>
        )}
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

      <motion.div
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
        variants={container}
        initial="hidden"
        animate="show"
      >
        {teams?.map((team) => (
          <motion.div key={team.id} variants={item}>
            <Card className="flex flex-col">
              <CardHeader className="flex flex-row items-start justify-between gap-2 pb-3">
                <div className="min-w-0">
                  <CardTitle className="truncate text-base">{team.name}</CardTitle>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {team.members.filter((m) => m.role === 'HR').map((m) => m.displayName).join(', ') || 'Нет HR'}
                  </p>
                </div>
                {canManage && (
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => { setAddMemberTeam(team); setAddMemberUserId('') }}
                      title="Добавить участника"
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => { setEditTeam(team); editForm.setFieldValue('name', team.name) }}
                      title="Переименовать"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    {isAdmin && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        onClick={() => setDeleteTeam(team)}
                        title="Удалить команду"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                )}
              </CardHeader>

              <CardContent className="flex-1 space-y-2">
                {team.members.length === 0 && (
                  <p className="text-xs text-muted-foreground">Нет участников</p>
                )}
                {team.members.map((member) => (
                  <div key={member.id} className="flex items-center gap-2.5">
                    <Link
                      to="/crm/users/$userId"
                      params={{ userId: member.userId }}
                      className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md hover:opacity-80 transition-opacity"
                    >
                      <Avatar className="h-7 w-7 shrink-0">
                        {member.avatar && <AvatarImage src={member.avatar} alt={member.displayName} />}
                        <AvatarFallback className="text-[10px]">
                          {getInitials(member.displayName)}
                        </AvatarFallback>
                      </Avatar>
                      <p className="truncate text-sm font-medium leading-none">{member.displayName}</p>
                    </Link>
                    <div className="flex shrink-0 items-center gap-1">
                      <Badge variant={ROLE_VARIANT[member.role] ?? 'junior'} className="text-[10px]">
                        {ROLE_LABELS[member.role] ?? member.role}
                      </Badge>
                      {member.techStack && (
                        <Badge variant="outline" className="text-[9px] px-1 py-0 font-mono text-muted-foreground">
                          {member.techStack}
                        </Badge>
                      )}
                      {member.role === 'JUNIOR' && (
                        <Badge variant="outline" className="text-[9px] px-1 py-0 text-muted-foreground">
                          проект
                        </Badge>
                      )}
                    </div>
                    {canManage && (() => {
                      const isSenior = member.role === 'SENIOR'
                      const isJunior = member.role === 'JUNIOR'
                      const isLastHr = member.role === 'HR' && team.members.filter((m) => m.role === 'HR').length <= 1
                      const isLastAccountant = member.role === 'ACCOUNTANT' && team.members.filter((m) => m.role === 'ACCOUNTANT').length <= 1
                      const isSelf = member.userId === user?.id
                      // HR может удалить только себя; ADMIN может удалять всех кроме защищённых
                      const canRemove = !isSenior && !isJunior && !isLastHr && !isLastAccountant &&
                        (isAdmin ? true : isSelf)
                      return canRemove ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={() => removeMemberMutation.mutate({ teamId: team.id, userId: member.userId })}
                          title="Исключить"
                        >
                          <UserMinus className="h-3 w-3" />
                        </Button>
                      ) : (
                        <div className="h-6 w-6 shrink-0" />
                      )
                    })()}
                  </div>
                ))}
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </motion.div>

      {/* HR: Create senior dialog */}
      {isHr && user && (
        <HrCreateSeniorDialog
          open={showCreateSenior}
          onClose={() => setShowCreateSenior(false)}
          hrUserId={user.id}
        />
      )}

      {/* Edit team name dialog */}
      <Dialog open={!!editTeam} onOpenChange={(open) => { if (!open) setEditTeam(null) }}>
        <CrmDialogContent maxWidth="sm:max-w-sm">
          <CrmDialogHeader>
            <DialogTitle>Переименовать команду</DialogTitle>
          </CrmDialogHeader>
          <CrmDialogBody className="pb-2">
            <editForm.Field
              name="name"
              validators={{ onBlur: ({ value }) => {
                const r = teamNameSchema.safeParse(value.trim())
                return r.success ? undefined : r.error.issues[0]?.message
              }}}
            >
              {(field) => (
                <div className="space-y-1.5">
                  <Label htmlFor="edit-name" className={cn(field.state.meta.isTouched && field.state.meta.errors.length > 0 && 'text-destructive')}>
                    Название
                  </Label>
                  <Input
                    id="edit-name"
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                    placeholder="Название команды"
                    className={cn(field.state.meta.isTouched && field.state.meta.errors.length > 0 && 'border-destructive focus-visible:ring-destructive/30')}
                    onKeyDown={(e) => { if (e.key === 'Enter') void editForm.handleSubmit() }}
                  />
                  {field.state.meta.isTouched && field.state.meta.errors[0] && (
                    <p className="text-xs text-destructive">{field.state.meta.errors[0]}</p>
                  )}
                </div>
              )}
            </editForm.Field>
          </CrmDialogBody>
          <CrmDialogFooter>
            <Button variant="outline" onClick={() => setEditTeam(null)}>Отмена</Button>
            <Button onClick={() => void editForm.handleSubmit()} disabled={updateMutation.isPending}>
              Сохранить
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>

      {/* Delete team confirmation dialog */}
      <Dialog open={!!deleteTeam} onOpenChange={(open) => !open && setDeleteTeam(null)}>
        <CrmDialogContent maxWidth="sm:max-w-sm">
          <CrmDialogHeader>
            <DialogTitle>Удалить команду «{deleteTeam?.name}»?</DialogTitle>
          </CrmDialogHeader>
          <CrmDialogBody className="pb-2">
            <p className="text-sm text-muted-foreground">
              Вместе с командой будут удалены её синьор и все его проекты. Это действие нельзя отменить.
            </p>
          </CrmDialogBody>
          <CrmDialogFooter>
            <Button variant="outline" onClick={() => setDeleteTeam(null)}>Отмена</Button>
            <Button
              variant="destructive"
              onClick={() => deleteTeam && deleteMutation.mutate(deleteTeam.id)}
              disabled={deleteMutation.isPending}
            >
              Удалить
            </Button>
          </CrmDialogFooter>
        </CrmDialogContent>
      </Dialog>

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
                      <AvatarFallback className="text-[10px]">{getInitials(u.displayName)}</AvatarFallback>
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
