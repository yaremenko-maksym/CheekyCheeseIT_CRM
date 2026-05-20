import { createFileRoute, Link } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { ArrowUpDown, ExternalLink, Pencil, Plus, Search, Trash2, UserPlus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { isValidPhoneNumber } from 'react-phone-number-input'
import type { Value as PhoneValue } from 'react-phone-number-input'
import { z } from 'zod'
import type { AdminUpdateUserDto, CreateUserDto, ProjectDto, UserProfileDto } from '@crm/shared'
import { adminUpdateUserSchema, createUserSchema, updateProfileSchema } from '@crm/shared'
import type { AxiosError } from 'axios'
import { useAuth } from '@/context/auth'
import { api } from '@/lib/axios'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

export const Route = createFileRoute('/crm/users/')({
  component: UsersPage,
})

// ── Constants ─────────────────────────────────────────────────────────────────

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

const ROLES = ['ADMIN', 'SENIOR', 'JUNIOR', 'HR', 'ACCOUNTANT'] as const
type Role = (typeof ROLES)[number]
type SortKey = 'displayName' | 'role' | 'email' | 'createdAt'
type SortDir = 'asc' | 'desc'

// Common tech stack suggestions
const TECH_STACK_OPTIONS = [
  'JavaScript FE',
  'JavaScript BE',
  'TypeScript FE',
  'TypeScript BE',
  'Python',
  'Java',
  'Kotlin',
  'Swift',
  'Go',
  'PHP',
  'Ruby',
  'C#',
  'C++',
  'Rust',
  'Flutter/Dart',
  'React Native',
]

function getInitials(name: string) {
  return (name || '?')
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

async function fetchUsers(): Promise<UserProfileDto[]> {
  const res = await api.get<UserProfileDto[]>('/users')
  return res.data
}

// ── Field wrapper with error ──────────────────────────────────────────────────

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

// ── Share percent slider ───────────────────────────────────────────────────────

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
      {/* Split bar */}
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

      {/* Slider + number input */}
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

// ── Shared field schemas ──────────────────────────────────────────────────────

function normalizeTelegram(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`
}

const telegramFieldSchema = updateProfileSchema.shape.telegram.unwrap().unwrap()
const phoneFieldSchema = z.string().max(30)

// ── TechStack field (shared between create + edit) ────────────────────────────

function TechStackField({
  value,
  onChange,
  onBlur,
  error,
}: {
  value: string
  onChange: (v: string) => void
  onBlur: () => void
  error?: string
}) {
  return (
    <Field label="Технологии" error={error}>
      <Input
        placeholder="JavaScript FE, Java, Kotlin..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        list="tech-stack-suggestions"
        className={cn(error && 'border-destructive focus-visible:ring-destructive/30')}
      />
      <datalist id="tech-stack-suggestions">
        {TECH_STACK_OPTIONS.map((opt) => (
          <option key={opt} value={opt} />
        ))}
      </datalist>
    </Field>
  )
}

// ── Create User Dialog ────────────────────────────────────────────────────────

function CreateUserDialog({ open, onClose, hrOnly = false }: { open: boolean; onClose: () => void; hrOnly?: boolean }) {
  const queryClient = useQueryClient()

  const { data: allUsers } = useQuery({
    queryKey: ['users-admin'],
    queryFn: fetchUsers,
  })

  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.get<ProjectDto[]>('/projects').then((r) => r.data),
  })

  const hrUsers = useMemo(() => allUsers?.filter((u) => u.role === 'HR') ?? [], [allUsers])
  const accountantUsers = useMemo(() => allUsers?.filter((u) => u.role === 'ACCOUNTANT') ?? [], [allUsers])

  // hrIds and accountantId live outside the form — initialized from current data
  // so they're correct even when user list is already cached on dialog open.
  const [selectedHrIds, setSelectedHrIds] = useState<string[]>(
    () => hrUsers.length === 1 && hrUsers[0] ? [hrUsers[0].id] : [],
  )
  const [selectedAccountantId, setSelectedAccountantId] = useState<string>(
    () => accountantUsers.length === 1 && accountantUsers[0] ? accountantUsers[0].id : '',
  )

  // Refs so onSubmit closure always reads the latest values (avoids stale closure in useForm)
  const selectedHrIdsRef = useRef(selectedHrIds)
  const selectedAccountantIdRef = useRef(selectedAccountantId)
  useEffect(() => { selectedHrIdsRef.current = selectedHrIds }, [selectedHrIds])
  useEffect(() => { selectedAccountantIdRef.current = selectedAccountantId }, [selectedAccountantId])

  const sortedProjects = useMemo(() => {
    if (!projects) return []
    return [...projects].sort((a, b) => {
      const aHasJunior = a.members.some((m) => m.role === 'JUNIOR' && m.leftAt === null)
      const bHasJunior = b.members.some((m) => m.role === 'JUNIOR' && m.leftAt === null)
      if (!aHasJunior && bHasJunior) return -1
      if (aHasJunior && !bHasJunior) return 1
      return 0
    })
  }, [projects])

  const mutation = useMutation({
    mutationFn: (data: CreateUserDto) => api.post<UserProfileDto>('/users', data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success('Пользователь создан')
      onClose()
    },
    onError: (err: AxiosError<{ message: string }>) => {
      const msg: string = err?.response?.data?.message ?? 'Ошибка при создании'
      toast.error(msg)
    },
  })

  const form = useForm({
    defaultValues: {
      email: '',
      displayName: '',
      role: (hrOnly ? 'SENIOR' : 'JUNIOR') as Role,
      telegram: '',
      phone: '' as PhoneValue | '',
      techStack: '',
      seniorSharePercent: 26 as number,
      projectId: '' as string,
      monthlySalary: '' as string,
    },
    onSubmit: async ({ value }) => {
      const isSenior = value.role === 'SENIOR'
      const hrIds = selectedHrIdsRef.current
      const accountantId = selectedAccountantIdRef.current

      if (isSenior && hrIds.length === 0) {
        toast.error('Выберите хотя бы одного HR для команды синьора')
        return
      }

      const payload: CreateUserDto = {
        email: value.email.trim(),
        displayName: value.displayName.trim(),
        role: value.role,
        telegram: value.telegram.trim() ? normalizeTelegram(value.telegram) : undefined,
        phone: (value.phone as string) || undefined,
        techStack: value.techStack.trim() ? value.techStack.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        paymentMethod: (isSenior || value.role === 'ADMIN') ? 'USDT_ERC20' as const : 'BANK_UAH_FOP' as const,
        ...(isSenior && {
          seniorSharePercent: value.seniorSharePercent,
          hrIds,
          accountantId: accountantId || null,
        }),
        ...(!isSenior && value.monthlySalary.trim() && {
          monthlySalary: parseFloat(value.monthlySalary),
        }),
        ...(value.role === 'JUNIOR' && {
          projectId: value.projectId || null,
        }),
      }
      mutation.mutate(payload)
    },
  })

  const handleClose = () => {
    form.reset()
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <CrmDialogContent maxWidth="sm:max-w-md">
        <CrmDialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            Новый пользователь
          </DialogTitle>
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
              const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
              return (
                <Field label="Email" error={err} required>
                  <Input
                    placeholder="user@cheekycheese.dev"
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
              const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
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

          {/* Role */}
          <form.Field name="role">
            {(field) => (
              <Field label="Роль" required>
                {hrOnly ? (
                  <div className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-3 py-2">
                    <Badge variant="senior" className="text-[11px]">Синьор</Badge>
                    <span className="text-xs text-muted-foreground">(HR может создавать только синьоров)</span>
                  </div>
                ) : (
                  <Select value={field.state.value} onValueChange={(v) => field.handleChange(v as Role)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r} value={r}>
                          <div className="flex items-center gap-2">
                            <Badge variant={ROLE_VARIANT[r]} className="text-[11px]">
                              {ROLE_LABELS[r]}
                            </Badge>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </Field>
            )}
          </form.Field>

          {/* Tech Stack */}
          <form.Field name="techStack">
            {(field) => (
              <TechStackField
                value={field.state.value}
                onChange={field.handleChange}
                onBlur={field.handleBlur}
              />
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
              const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
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
                // PhoneInput always pre-fills the country dial code (+380) — ignore if no subscriber digits entered
                if (!v || v.replace(/\D/g, '').length < 5) return undefined
                const r = phoneFieldSchema.safeParse(v)
                if (!r.success) return r.error.issues[0]?.message
                if (!isValidPhoneNumber(v)) return 'Некорректный номер телефона'
                return undefined
              },
            }}
          >
            {(field) => {
              const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
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

          {/* Role-specific fields — role читается напрямую из store чтобы избежать stale closure */}
          <form.Subscribe selector={(s) => s.values.role}>
            {(role) => role === 'SENIOR' ? (
              <div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-3">
                <p className="text-xs font-medium text-muted-foreground">Финансы и команда</p>
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
                    const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
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
              </div>
            ) : (
              <div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-3">
                <p className="text-xs font-medium text-muted-foreground">Зарплата</p>
                <form.Field name="monthlySalary">
                  {(field) => {
                    const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
                    return (
                      <Field label="Месячная зарплата (USD)" error={err}>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            min={0}
                            step={10}
                            placeholder="0"
                            value={field.state.value}
                            onChange={(e) => field.handleChange(e.target.value)}
                            onBlur={field.handleBlur}
                            className={cn('w-32', err && 'border-destructive focus-visible:ring-destructive/30')}
                          />
                          <span className="text-xs text-muted-foreground">USD / мес</span>
                        </div>
                      </Field>
                    )
                  }}
                </form.Field>
                {role === 'JUNIOR' && (
                  <form.Field name="projectId">
                    {(field) => (
                      <Field label="Проект">
                        {sortedProjects.length === 0 ? (
                          <p className="text-xs text-muted-foreground italic">Нет активных проектов</p>
                        ) : (
                          <Select value={field.state.value} onValueChange={(v) => field.handleChange(v)}>
                            <SelectTrigger>
                              <SelectValue placeholder="— выберите проект (необязательно) —" />
                            </SelectTrigger>
                            <SelectContent>
                              {sortedProjects.map((p) => {
                                const hasJunior = p.members.some((m) => m.role === 'JUNIOR' && m.leftAt === null)
                                return (
                                  <SelectItem key={p.id} value={p.id}>
                                    <span>{p.companyName} — {p.name}</span>
                                    {!hasJunior && (
                                      <span className="ml-2 text-[10px] text-destructive font-medium">нет джуна</span>
                                    )}
                                  </SelectItem>
                                )
                              })}
                            </SelectContent>
                          </Select>
                        )}
                      </Field>
                    )}
                  </form.Field>
                )}
              </div>
            )}
          </form.Subscribe>

          {/* HR + Accountant — вне form.Subscribe чтобы не было stale closure */}
          <form.Subscribe selector={(s) => s.values.role === 'SENIOR'}>
            {(isSenior) => isSenior ? (
              <div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-3">
                <p className="text-xs font-medium text-muted-foreground">Команда</p>

                <Field label="HR" required>
                  {hrUsers.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">Нет доступных HR</p>
                  ) : (
                    <div className="space-y-1">
                      {hrUsers.map((u) => (
                        <label key={u.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm cursor-pointer hover:bg-muted/30 transition-colors">
                          <input
                            type="checkbox"
                            checked={selectedHrIds.includes(u.id)}
                            onChange={(e) =>
                              setSelectedHrIds(e.target.checked
                                ? [...selectedHrIds, u.id]
                                : selectedHrIds.filter((id) => id !== u.id)
                              )
                            }
                            className="accent-primary"
                          />
                          {u.displayName}
                        </label>
                      ))}
                    </div>
                  )}
                </Field>

                <Field label="Бухгалтер">
                  {accountantUsers.length === 0 ? (
                    <p className="text-xs text-muted-foreground italic">Нет доступных бухгалтеров</p>
                  ) : (
                    <Select value={selectedAccountantId ?? 'none'} onValueChange={(v) => setSelectedAccountantId(v === 'none' ? '' : v)}>
                      <SelectTrigger>
                        <SelectValue placeholder="— выберите бухгалтера —" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">— не выбран —</SelectItem>
                        {accountantUsers.map((u) => (
                          <SelectItem key={u.id} value={u.id}>{u.displayName}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </Field>
              </div>
            ) : null}
          </form.Subscribe>
          </div>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button variant="ghost" onClick={handleClose}>
            Отмена
          </Button>
          <Button onClick={() => void form.handleSubmit()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Создание...' : 'Создать'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}

// ── Edit User Dialog ──────────────────────────────────────────────────────────

function EditUserDialog({ user, onClose }: { user: UserProfileDto | null; onClose: () => void }) {
  const queryClient = useQueryClient()

  const mutation = useMutation({
    mutationFn: (data: AdminUpdateUserDto) =>
      api.patch<UserProfileDto>(`/users/${user!.id}`, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      toast.success('Пользователь обновлён')
      onClose()
    },
    onError: (err: AxiosError<{ message: string }>) => {
      const msg: string = err?.response?.data?.message ?? 'Ошибка при обновлении'
      toast.error(msg)
    },
  })

  const form = useForm({
    defaultValues: {
      displayName: user?.displayName ?? '',
      role: (user?.role as Role) ?? 'JUNIOR',
      telegram: user?.telegram ?? '',
      phone: ((user?.phone as PhoneValue | undefined) ?? '') as PhoneValue | '',
      techStack: Array.isArray(user?.techStack) ? user.techStack.join(', ') : (user?.techStack ?? ''),
      seniorSharePercent: user?.seniorSharePercent ?? 26,
      monthlySalary: user?.monthlySalary ?? '',
    },
    onSubmit: async ({ value }) => {
      const isSenior = value.role === 'SENIOR'
      const payload: AdminUpdateUserDto = {
        displayName: value.displayName.trim(),
        telegram: value.telegram.trim() ? normalizeTelegram(value.telegram) : null,
        phone: (value.phone as string) || null,
        techStack: value.techStack.trim() ? value.techStack.split(',').map((s) => s.trim()).filter(Boolean) : null,
        ...(isSenior && {
          seniorSharePercent: value.seniorSharePercent,
        }),
        ...(!isSenior && {
          monthlySalary: value.monthlySalary ? parseFloat(String(value.monthlySalary)) : null,
        }),
      }
      const result = adminUpdateUserSchema.safeParse(payload)
      if (!result.success) { toast.error('Ошибка валидации данных'); return }
      mutation.mutate(result.data)
    },
  })

  useEffect(() => {
    if (user) {
      form.setFieldValue('displayName', user.displayName)
      form.setFieldValue('role', user.role as Role)
      form.setFieldValue('telegram', user.telegram ?? '')
      form.setFieldValue('phone', ((user.phone as PhoneValue | undefined) ?? '') as PhoneValue | '')
      form.setFieldValue('techStack', Array.isArray(user.techStack) ? user.techStack.join(', ') : (user.techStack ?? ''))
      form.setFieldValue('seniorSharePercent', user.seniorSharePercent ?? 26)
      form.setFieldValue('monthlySalary', user.monthlySalary ?? '')
    }
  }, [user?.id])

  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <CrmDialogContent maxWidth="sm:max-w-md">
        <CrmDialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4" />
            Редактировать пользователя
          </DialogTitle>
        </CrmDialogHeader>

        <CrmDialogBody>
          <div className="grid gap-4 py-2">
          {/* User identity card */}
          <div className="flex items-center gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5">
            <Avatar className="h-9 w-9 shrink-0">
              {user?.avatar && (
                <img
                  src={user.avatar}
                  alt={user.displayName}
                  className="h-full w-full rounded-full object-cover"
                />
              )}
              <AvatarFallback className="bg-primary/20 text-xs text-primary">
                {getInitials(user?.displayName ?? '')}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{user?.displayName}</p>
              <p className="text-xs text-muted-foreground truncate">{user?.email}</p>
            </div>
          </div>

          {/* Display name */}
          <form.Field
            name="displayName"
            validators={{
              onBlur: ({ value }) => {
                const r = adminUpdateUserSchema.shape.displayName.unwrap().safeParse(value.trim())
                return r.success ? undefined : r.error.issues[0]?.message
              },
            }}
          >
            {(field) => {
              const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
              return (
                <Field label="Имя и фамилия" error={err} required>
                  <Input
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                    className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                  />
                </Field>
              )
            }}
          </form.Field>

          {/* Role */}
          <form.Field name="role">
            {(field) => (
              <Field label="Роль" required>
                <Select value={field.state.value} onValueChange={(v) => field.handleChange(v as Role)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r} value={r}>
                        <div className="flex items-center gap-2">
                          <Badge variant={ROLE_VARIANT[r]} className="text-[11px]">
                            {ROLE_LABELS[r]}
                          </Badge>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </form.Field>

          {/* Tech Stack */}
          <form.Field name="techStack">
            {(field) => (
              <TechStackField
                value={field.state.value}
                onChange={field.handleChange}
                onBlur={field.handleBlur}
              />
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
              const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
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
                if (!v || v.replace(/\D/g, '').length < 5) return undefined
                const r = phoneFieldSchema.safeParse(v)
                if (!r.success) return r.error.issues[0]?.message
                if (!isValidPhoneNumber(v)) return 'Некорректный номер телефона'
                return undefined
              },
            }}
          >
            {(field) => {
              const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
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

          {/* Role-specific financial fields */}
          <form.Subscribe selector={(s) => s.values.role}>
            {(role) => role === 'SENIOR' ? (
              <div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-3">
                <p className="text-xs font-medium text-muted-foreground">Финансы</p>
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
                    const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
                    return (
                      <Field label="Доля компании (%)" error={err}>
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
              </div>
            ) : (
              <div className="rounded-md border border-border/60 bg-muted/20 p-3">
                <p className="text-xs font-medium text-muted-foreground mb-3">Зарплата</p>
                <form.Field name="monthlySalary">
                  {(field) => {
                    const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
                    return (
                      <Field label="Месячная зарплата (USD)" error={err}>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            min={0}
                            step={10}
                            placeholder="0"
                            value={field.state.value ?? ''}
                            onChange={(e) => field.handleChange(e.target.value)}
                            onBlur={field.handleBlur}
                            className={cn('w-32', err && 'border-destructive focus-visible:ring-destructive/30')}
                          />
                          <span className="text-xs text-muted-foreground">USD / мес</span>
                        </div>
                      </Field>
                    )
                  }}
                </form.Field>
              </div>
            )}
          </form.Subscribe>
          </div>
        </CrmDialogBody>

        <CrmDialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={() => void form.handleSubmit()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Сохранение...' : 'Сохранить'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}

// ── Delete Confirm Dialog ─────────────────────────────────────────────────────

function DeleteUserDialog({
  user,
  onClose,
}: {
  user: UserProfileDto | null
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => api.delete(`/users/${user!.id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success('Пользователь удалён')
      onClose()
    },
    onError: (err: AxiosError<{ message: string }>) => {
      const msg: string = err?.response?.data?.message ?? 'Ошибка при удалении'
      toast.error(msg)
    },
  })

  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <CrmDialogContent maxWidth="sm:max-w-sm">
        <CrmDialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="h-4 w-4" />
            Удалить пользователя
          </DialogTitle>
        </CrmDialogHeader>
        <CrmDialogBody className="pb-2">
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Вы уверены, что хотите удалить{' '}
              <span className="font-semibold text-foreground">{user?.displayName}</span>?
            </p>
            {user?.role === 'SENIOR' ? (
              <p className="text-xs text-destructive font-medium">
                Внимание: вместе с синьором будут удалены его команда и все его проекты.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Это действие необратимо. Все связанные данные будут удалены.
              </p>
            )}
          </div>
        </CrmDialogBody>
        <CrmDialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="destructive" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? 'Удаление...' : 'Удалить'}
          </Button>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

function UsersPage() {
  const { user: me } = useAuth()
  
  // Admin-only page guard
  if (!me) return null
  if (me.role !== 'ADMIN') {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Пользователи</h1>
        </div>
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-24 text-center">
          <p className="text-sm font-medium text-muted-foreground">Доступ только для администратора</p>
        </div>
      </div>
    )
  }
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<Role | 'ALL'>('ALL')
  const [sortKey, setSortKey] = useState<SortKey>('displayName')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [createOpen, setCreateOpen] = useState(false)
  const [createKey, setCreateKey] = useState(0)
  const [editUser, setEditUser] = useState<UserProfileDto | null>(null)
  const [deleteUser, setDeleteUser] = useState<UserProfileDto | null>(null)

  const { data: users, isLoading } = useQuery({
    queryKey: ['users-admin'],
    queryFn: fetchUsers,
  })

  const filtered = useMemo(() => {
    if (!users) return []
    let list = [...users]
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter(
        (u) =>
          u.displayName.toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q) ||
          (u.telegram ?? '').toLowerCase().includes(q) ||
          (Array.isArray(u.techStack) ? u.techStack.join(', ') : (u.techStack ?? '')).toLowerCase().includes(q),
      )
    }
    if (roleFilter !== 'ALL') list = list.filter((u) => u.role === roleFilter)
    list.sort((a, b) => {
      let av: string | number = ''
      let bv: string | number = ''
      if (sortKey === 'displayName') { av = a.displayName; bv = b.displayName }
      else if (sortKey === 'email') { av = a.email; bv = b.email }
      else if (sortKey === 'role') { av = a.role; bv = b.role }
      else if (sortKey === 'createdAt') {
        av = new Date(a.createdAt).getTime()
        bv = new Date(b.createdAt).getTime()
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1
      if (av > bv) return sortDir === 'asc' ? 1 : -1
      return 0
    })
    return list
  }, [users, search, roleFilter, sortKey, sortDir])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir('asc') }
  }

  const SortIcon = ({ k }: { k: SortKey }) => (
    <ArrowUpDown
      className={cn(
        'ml-1 inline h-3 w-3 transition-colors',
        sortKey === k ? 'text-primary' : 'text-muted-foreground/40',
      )}
    />
  )

  const isAdmin = true // already guarded above: only ADMIN reaches here

  return (
    <div className="space-y-6">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28 }}
        className="flex items-center justify-between gap-4 flex-wrap"
      >
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Пользователи</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {isLoading ? '...' : `${filtered.length} из ${users?.length ?? 0}`}
          </p>
        </div>
        <Button onClick={() => { setCreateKey((k) => k + 1); setCreateOpen(true) }}>
          <Plus className="mr-2 h-4 w-4" />
          Добавить
        </Button>
      </motion.div>

      {/* Filters */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, delay: 0.05 }}
      >
        <Card>
          <CardContent className="flex flex-wrap gap-3 pt-4 pb-4">
            <div className="relative flex-1 min-w-50">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Поиск по имени, email, telegram, технологии..."
                className="pl-8"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select value={roleFilter} onValueChange={(v) => setRoleFilter(v as Role | 'ALL')}>
              <SelectTrigger className="w-44">
                <SelectValue placeholder="Все роли" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Все роли</SelectItem>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
      </motion.div>

      {/* Table */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.28, delay: 0.1 }}
      >
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="divide-y divide-border">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-4 px-4 py-3">
                    <Skeleton className="h-9 w-9 rounded-full" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-4 w-36" />
                      <Skeleton className="h-3 w-48" />
                    </div>
                    <Skeleton className="h-5 w-20 rounded-full" />
                    <Skeleton className="h-8 w-20" />
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
                <Search className="h-8 w-8 opacity-30" />
                <p className="text-sm">Пользователи не найдены</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
              <Table className="table-fixed w-full min-w-225">
                <TableHeader>
                  <TableRow>
                    <TableHead
                      className="cursor-pointer select-none w-44"
                      onClick={() => toggleSort('displayName')}
                    >
                      Пользователь <SortIcon k="displayName" />
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none w-52"
                      onClick={() => toggleSort('email')}
                    >
                      Email <SortIcon k="email" />
                    </TableHead>
                    <TableHead
                      className="cursor-pointer select-none w-26"
                      onClick={() => toggleSort('role')}
                    >
                      Роль <SortIcon k="role" />
                    </TableHead>
                    <TableHead className="w-28">Технологии</TableHead>
                    <TableHead className="w-36">Контакты</TableHead>
                    <TableHead
                      className="cursor-pointer select-none w-22"
                      onClick={() => toggleSort('createdAt')}
                    >
                      Добавлен <SortIcon k="createdAt" />
                    </TableHead>
                    <TableHead className="w-18" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Link to="/crm/profile/$userId" params={{ userId: u.id }}>
                            <Avatar className="h-8 w-8 shrink-0">
                              {u.avatar && (
                                <img
                                  src={u.avatar}
                                  alt={u.displayName}
                                  className="h-full w-full rounded-full object-cover"
                                />
                              )}
                              <AvatarFallback className="bg-primary/20 text-xs text-primary">
                                {getInitials(u.displayName)}
                              </AvatarFallback>
                            </Avatar>
                          </Link>
                          <div className="min-w-0">
                            <Link
                              to="/crm/profile/$userId"
                              params={{ userId: u.id }}
                              className="text-sm font-medium hover:underline truncate block"
                            >
                              {u.displayName}
                            </Link>
                            {u.id === me?.id && (
                              <span className="text-[10px] text-muted-foreground">Вы</span>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground max-w-0">
                        <a
                          href={`mailto:${u.email}`}
                          className="hover:text-foreground transition-colors truncate block"
                          title={u.email}
                        >
                          {u.email}
                        </a>
                      </TableCell>
                      <TableCell>
                        <Badge variant={ROLE_VARIANT[u.role] ?? 'outline'}>
                          {ROLE_LABELS[u.role]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {u.techStack ? (
                          <Badge variant="outline" className="text-[10px] font-mono">
                            {u.techStack}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground/30">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                          {u.telegram ? (
                            <a
                              href={`https://t.me/${u.telegram.replace('@', '')}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:text-foreground transition-colors"
                            >
                              {u.telegram}
                            </a>
                          ) : (
                            <span className="opacity-30">—</span>
                          )}
                          {u.phone && (
                            <a href={`tel:${u.phone}`} className="hover:text-foreground transition-colors">
                              {u.phone}
                            </a>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(u.createdAt).toLocaleDateString('uk-UA')}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-0.5">
                          <Link to="/crm/profile/$userId" params={{ userId: u.id }}>
                            <Button variant="ghost" size="icon" className="h-7 w-7">
                              <ExternalLink className="h-3.5 w-3.5" />
                            </Button>
                          </Link>
                          {isAdmin && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => setEditUser(u)}
                                title="Редактировать"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-destructive hover:text-destructive disabled:opacity-30"
                                onClick={() => setDeleteUser(u)}
                                disabled={u.id === me?.id}
                                title={u.id === me?.id ? 'Нельзя удалить себя' : 'Удалить'}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

      <CreateUserDialog key={createKey} open={createOpen} onClose={() => setCreateOpen(false)} hrOnly={false} />
      <EditUserDialog user={editUser} onClose={() => setEditUser(null)} />
      <DeleteUserDialog user={deleteUser} onClose={() => setDeleteUser(null)} />
    </div>
  )
}
