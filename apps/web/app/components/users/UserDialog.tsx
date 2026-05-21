import { Link } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, UserPlus } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { isValidPhoneNumber } from 'react-phone-number-input'
import type { Value as PhoneValue } from 'react-phone-number-input'
import { z } from 'zod'
import type { AxiosError } from 'axios'
import type {
  AdminUpdateUserDto,
  CreateUserDto,
  ProjectDto,
  TeamDto,
  UserProfileDto,
} from '@crm/shared'
import {
  adminUpdateUserSchema,
  createUserSchema,
  updateProfileSchema,
} from '@crm/shared'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  CrmDialogBody,
  CrmDialogContent,
  CrmDialogFooter,
  CrmDialogHeader,
  Dialog,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TechAutocompleteInput } from '@/components/ui/tech-autocomplete-input'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import {
  ROLE_LABELS,
  ROLE_VARIANT,
  ROLES,
  type Role,
  normalizeTelegram,
} from './constants'
import { Field, Section } from './section'
import { ShareSlider } from './share-slider'

const telegramFieldSchema = updateProfileSchema.shape.telegram.unwrap().unwrap()
const phoneFieldSchema = z.string().max(30)

async function fetchUsersForDialog(): Promise<UserProfileDto[]> {
  const res = await api.get<UserProfileDto[]>('/users')
  return res.data
}

type CommonProps = {
  mode: 'create' | 'edit'
  onClose: () => void
  /** Restrict role choices to SENIOR-only (HR creating senior). create mode. */
  hrOnly?: boolean
}

type CreateProps = CommonProps & { mode: 'create'; open: boolean; user?: never }
type EditProps = CommonProps & { mode: 'edit'; user: UserProfileDto | null; open?: never }

export type UserDialogProps = CreateProps | EditProps

/**
 * Sectioned user CRUD dialog. 5 sections in a single vertical scroll:
 *   1. Identity (email + name + role)
 *   2. Contacts (telegram + phone)
 *   3. Tech stack
 *   4. Finance (SENIOR ShareSlider | non-SENIOR monthly salary)
 *   5. Team (SENIOR HR multiselect + Accountant; JUNIOR initial project (create) / current projects read-only (edit))
 *
 * Sticky footer: role badge (left) + Cancel/Submit (right).
 *
 * `mode: 'edit'` makes Email read-only; SENIOR Team section stays editable (fixes asymmetry).
 */
export function UserDialog(props: UserDialogProps) {
  const queryClient = useQueryClient()
  const isCreate = props.mode === 'create'
  const isEdit = props.mode === 'edit'
  const open = isCreate ? props.open : !!props.user
  const editingUser = isEdit ? props.user : null

  const hrOnly = isCreate ? !!props.hrOnly : false

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

  const hrUsers = useMemo(
    () => allUsers?.filter((u) => u.role === 'HR' && !u.archivedAt) ?? [],
    [allUsers],
  )
  const accountantUsers = useMemo(
    () => allUsers?.filter((u) => u.role === 'ACCOUNTANT' && !u.archivedAt) ?? [],
    [allUsers],
  )

  // SENIOR-only team controls (HR multiselect + Accountant)
  const [selectedHrIds, setSelectedHrIds] = useState<string[]>([])
  const [selectedAccountantId, setSelectedAccountantId] = useState<string>('')

  // Refs to avoid stale-closure in onSubmit
  const selectedHrIdsRef = useRef(selectedHrIds)
  const selectedAccountantIdRef = useRef(selectedAccountantId)
  useEffect(() => {
    selectedHrIdsRef.current = selectedHrIds
  }, [selectedHrIds])
  useEffect(() => {
    selectedAccountantIdRef.current = selectedAccountantId
  }, [selectedAccountantId])

  // Fetch all teams (active) to find current HR/Accountant for a SENIOR being edited.
  const { data: allTeams } = useQuery({
    queryKey: ['teams'],
    queryFn: () => api.get<TeamDto[]>('/teams').then((r) => r.data),
    enabled: isEdit && !!editingUser && editingUser.role === 'SENIOR',
  })

  /**
   * Senior's team is the team where the senior is an active member with role=SENIOR.
   * Existing HR/Accountant in that team (with leftAt=NULL) seed selections.
   */
  useEffect(() => {
    if (isEdit && editingUser && editingUser.role === 'SENIOR' && allTeams) {
      const seniorsTeam = allTeams.find((t) =>
        t.members.some((m) => m.userId === editingUser.id && m.role === 'SENIOR' && !m.leftAt),
      )
      if (seniorsTeam) {
        const activeHrIds = seniorsTeam.members
          .filter((m) => m.role === 'HR' && !m.leftAt)
          .map((m) => m.userId)
        const activeAccountant = seniorsTeam.members.find(
          (m) => m.role === 'ACCOUNTANT' && !m.leftAt,
        )
        setSelectedHrIds(activeHrIds)
        setSelectedAccountantId(activeAccountant?.userId ?? '')
      } else {
        setSelectedHrIds([])
        setSelectedAccountantId('')
      }
    } else if (isCreate && open) {
      // For CREATE: defaults — pre-select if only one option exists
      const initial = hrUsers.length === 1 && hrUsers[0] ? [hrUsers[0].id] : []
      setSelectedHrIds(initial)
      const accInitial = accountantUsers.length === 1 && accountantUsers[0] ? accountantUsers[0].id : ''
      setSelectedAccountantId(accInitial)
    }
  }, [allTeams, editingUser?.id, hrUsers.length, accountantUsers.length, isEdit, isCreate, open])

  // For JUNIOR projects display in Edit
  const juniorActiveProjects = useMemo(() => {
    if (!editingUser || editingUser.role !== 'JUNIOR' || !projects) return []
    return projects.filter((p) =>
      p.members.some((m) => m.userId === editingUser.id && m.leftAt === null),
    )
  }, [editingUser, projects])

  // For initial JUNIOR project select in Create
  const sortedProjects = useMemo(() => {
    if (!projects) return []
    return [...projects]
      .filter((p) => !p.archivedAt)
      .sort((a, b) => {
        const aHasJunior = a.members.some((m) => m.role === 'JUNIOR' && m.leftAt === null)
        const bHasJunior = b.members.some((m) => m.role === 'JUNIOR' && m.leftAt === null)
        if (!aHasJunior && bHasJunior) return -1
        if (aHasJunior && !bHasJunior) return 1
        return 0
      })
  }, [projects])

  // ── Mutations ────────────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (data: CreateUserDto) => api.post<UserProfileDto>('/users', data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      toast.success('Пользователь создан')
      props.onClose()
    },
    onError: (err: AxiosError<{ message: string }>) => {
      toast.error(err?.response?.data?.message ?? 'Ошибка при создании')
    },
  })

  const updateMutation = useMutation({
    mutationFn: (data: AdminUpdateUserDto) =>
      api.patch<UserProfileDto>(`/users/${editingUser!.id}`, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['user-profile', editingUser?.id] })
      toast.success('Пользователь обновлён')
      props.onClose()
    },
    onError: (err: AxiosError<{ message: string }>) => {
      toast.error(err?.response?.data?.message ?? 'Ошибка при обновлении')
    },
  })

  // ── Form ─────────────────────────────────────────────────────────────────
  const form = useForm({
    defaultValues: {
      email: editingUser?.email ?? '',
      displayName: editingUser?.displayName ?? '',
      role: ((editingUser?.role as Role) ?? (hrOnly ? 'SENIOR' : 'JUNIOR')) as Role,
      telegram: editingUser?.telegram ?? '',
      phone: ((editingUser?.phone as PhoneValue | undefined) ?? '') as PhoneValue | '',
      techStack: (editingUser?.techStack ?? []) as string[],
      seniorSharePercent: editingUser?.seniorSharePercent ?? 26,
      monthlySalary: editingUser?.monthlySalary ?? '',
      projectId: '' as string,
    },
    onSubmit: async ({ value }) => {
      const isSenior = value.role === 'SENIOR'
      const hrIds = selectedHrIdsRef.current
      const accountantId = selectedAccountantIdRef.current

      if (isCreate) {
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
          techStack: value.techStack.length > 0 ? value.techStack : undefined,
          paymentMethod: (isSenior || value.role === 'ADMIN') ? ('USDT_ERC20' as const) : ('BANK_UAH_FOP' as const),
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
        createMutation.mutate(payload)
      } else {
        // Edit
        const payload: AdminUpdateUserDto = {
          displayName: value.displayName.trim(),
          telegram: value.telegram.trim() ? normalizeTelegram(value.telegram) : null,
          phone: (value.phone as string) || null,
          techStack: value.techStack.length > 0 ? value.techStack : null,
          ...(isSenior && {
            seniorSharePercent: value.seniorSharePercent,
            hrIds,
            accountantId: accountantId || null,
          }),
          ...(!isSenior && {
            monthlySalary: value.monthlySalary ? parseFloat(String(value.monthlySalary)) : null,
          }),
        }
        const result = adminUpdateUserSchema.safeParse(payload)
        if (!result.success) {
          toast.error('Ошибка валидации данных')
          return
        }
        updateMutation.mutate(result.data)
      }
    },
  })

  // Re-seed form when editing user changes (dialog reopens for different user).
  // `form.reset(defaults)` is idiomatic TanStack Form re-seed — clears touched/dirty
  // state between edit sessions, unlike per-field setFieldValue which preserves them.
  // Deps are intentionally limited to `editingUser?.id` + `isEdit`: `form` is
  // stable and re-running on every prop change would clobber user edits in-flight.
  useEffect(() => {
    if (isEdit && editingUser) {
      form.reset({
        email: editingUser.email,
        displayName: editingUser.displayName,
        role: editingUser.role as Role,
        telegram: editingUser.telegram ?? '',
        phone: ((editingUser.phone as PhoneValue | undefined) ?? '') as PhoneValue | '',
        techStack: editingUser.techStack ?? [],
        seniorSharePercent: editingUser.seniorSharePercent ?? 26,
        monthlySalary: editingUser.monthlySalary ?? '',
        projectId: '',
      })
    }
  }, [editingUser?.id, isEdit])

  const handleClose = () => {
    if (isCreate) form.reset()
    props.onClose()
  }

  const isPending = createMutation.isPending || updateMutation.isPending
  const submitLabel = isCreate
    ? createMutation.isPending
      ? 'Создание...'
      : 'Создать'
    : updateMutation.isPending
      ? 'Сохранение...'
      : 'Сохранить'

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <CrmDialogContent maxWidth="sm:max-w-lg" data-testid="user-dialog">
        <CrmDialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isCreate ? (
              <>
                <UserPlus className="h-4 w-4" />
                Новый пользователь
              </>
            ) : (
              <>
                <Pencil className="h-4 w-4" />
                Редактировать пользователя
              </>
            )}
          </DialogTitle>
        </CrmDialogHeader>

        <CrmDialogBody>
          <div className="grid gap-3 py-2">
            {/* ── Section 1: Identity ─────────────────────────────────── */}
            <Section title="Идентичность">
              {isCreate ? (
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
                          data-testid="user-dialog-email"
                        />
                      </Field>
                    )
                  }}
                </form.Field>
              ) : (
                <Field label="Email">
                  <div
                    className="text-sm text-muted-foreground rounded-md border border-input bg-muted/30 px-3 py-2"
                    data-testid="user-dialog-email-readonly"
                  >
                    {editingUser?.email}
                  </div>
                </Field>
              )}

              <form.Field
                name="displayName"
                validators={{
                  onBlur: ({ value }) => {
                    const r = (isCreate
                      ? createUserSchema.shape.displayName
                      : adminUpdateUserSchema.shape.displayName.unwrap()
                    ).safeParse(value.trim())
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
                        data-testid="user-dialog-name"
                      />
                    </Field>
                  )
                }}
              </form.Field>

              <form.Field name="role">
                {(field) => (
                  <Field label="Роль" required>
                    {hrOnly ? (
                      <div className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-3 py-2">
                        <Badge variant="senior" className="text-[11px]">Синьор</Badge>
                        <span className="text-xs text-muted-foreground">
                          (HR может создавать только синьоров)
                        </span>
                      </div>
                    ) : (
                      <Select
                        value={field.state.value}
                        onValueChange={(v) => field.handleChange(v as Role)}
                      >
                        <SelectTrigger data-testid="user-dialog-role-trigger">
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
            </Section>

            {/* ── Section 2: Contacts ─────────────────────────────────── */}
            <Section title="Контакты">
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
            </Section>

            {/* ── Section 3: Profession (Tech stack) ──────────────────── */}
            <Section title="Профессия">
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
            </Section>

            {/* ── Section 4: Finance ──────────────────────────────────── */}
            <form.Subscribe selector={(s) => s.values.role}>
              {(role) => (
                <Section title="Финансы">
                  {role === 'SENIOR' ? (
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
                          <Field label="Доля компании (%)" error={err} required={isCreate}>
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
                  ) : (
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
                                className={cn(
                                  'w-32',
                                  err && 'border-destructive focus-visible:ring-destructive/30',
                                )}
                              />
                              <span className="text-xs text-muted-foreground">USD / мес</span>
                            </div>
                          </Field>
                        )
                      }}
                    </form.Field>
                  )}
                </Section>
              )}
            </form.Subscribe>

            {/* ── Section 5: Team ─────────────────────────────────────── */}
            <form.Subscribe selector={(s) => s.values.role}>
              {(role) => {
                if (role === 'SENIOR') {
                  return (
                    <Section title="Команда">
                      <Field label="HR" required={isCreate}>
                        {hrUsers.length === 0 ? (
                          <p className="text-xs text-muted-foreground italic">Нет доступных HR</p>
                        ) : (
                          <div className="space-y-1" data-testid="user-dialog-hr-multiselect">
                            {hrUsers.map((u) => (
                              <label
                                key={u.id}
                                className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm cursor-pointer hover:bg-muted/30 transition-colors"
                              >
                                <input
                                  type="checkbox"
                                  checked={selectedHrIds.includes(u.id)}
                                  onChange={(e) =>
                                    setSelectedHrIds(
                                      e.target.checked
                                        ? [...selectedHrIds, u.id]
                                        : selectedHrIds.filter((id) => id !== u.id),
                                    )
                                  }
                                  className="accent-primary"
                                  data-testid={`user-dialog-hr-${u.id}`}
                                />
                                {u.displayName}
                              </label>
                            ))}
                          </div>
                        )}
                      </Field>

                      <Field label="Бухгалтер">
                        {accountantUsers.length === 0 ? (
                          <p className="text-xs text-muted-foreground italic">
                            Нет доступных бухгалтеров
                          </p>
                        ) : (
                          <Select
                            value={selectedAccountantId || 'none'}
                            onValueChange={(v) =>
                              setSelectedAccountantId(v === 'none' ? '' : v)
                            }
                          >
                            <SelectTrigger data-testid="user-dialog-accountant-trigger">
                              <SelectValue placeholder="— выберите бухгалтера —" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">— не выбран —</SelectItem>
                              {accountantUsers.map((u) => (
                                <SelectItem key={u.id} value={u.id}>
                                  {u.displayName}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </Field>
                    </Section>
                  )
                }

                if (role === 'JUNIOR') {
                  if (isCreate) {
                    return (
                      <Section title="Команда">
                        <form.Field name="projectId">
                          {(field) => (
                            <Field label="Проект">
                              {sortedProjects.length === 0 ? (
                                <p className="text-xs text-muted-foreground italic">
                                  Нет активных проектов
                                </p>
                              ) : (
                                <Select
                                  value={field.state.value}
                                  onValueChange={(v) => field.handleChange(v)}
                                >
                                  <SelectTrigger>
                                    <SelectValue placeholder="— выберите проект (необязательно) —" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {sortedProjects.map((p) => {
                                      const hasJunior = p.members.some(
                                        (m) => m.role === 'JUNIOR' && m.leftAt === null,
                                      )
                                      return (
                                        <SelectItem key={p.id} value={p.id}>
                                          <span>
                                            {p.companyName} — {p.name}
                                          </span>
                                          {!hasJunior && (
                                            <span className="ml-2 text-[10px] text-destructive font-medium">
                                              нет джуна
                                            </span>
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
                      </Section>
                    )
                  }
                  // Edit JUNIOR: read-only project list + link
                  return (
                    <Section title="Команда">
                      <Field label="Активные проекты">
                        {juniorActiveProjects.length === 0 ? (
                          <p className="text-xs text-muted-foreground italic">
                            Нет активных проектов
                          </p>
                        ) : (
                          <div className="flex flex-wrap gap-1" data-testid="user-dialog-junior-projects">
                            {juniorActiveProjects.map((p) => (
                              <Badge key={p.id} variant="outline" className="text-[11px]">
                                {p.companyName} — {p.name}
                              </Badge>
                            ))}
                          </div>
                        )}
                        <Link
                          to="/crm/projects"
                          className="text-xs text-primary hover:underline mt-1 inline-block"
                          onClick={() => props.onClose()}
                        >
                          Управлять в Проектах →
                        </Link>
                      </Field>
                    </Section>
                  )
                }

                // ADMIN / HR / ACCOUNTANT — no team section (HR and ACCOUNTANT manage assignments via Teams page)
                return null
              }}
            </form.Subscribe>
          </div>
        </CrmDialogBody>

        <CrmDialogFooter className="items-center justify-between">
          <form.Subscribe selector={(s) => s.values.role}>
            {(role) => (
              <Badge variant={ROLE_VARIANT[role]} className="text-[11px]">
                {ROLE_LABELS[role]}
              </Badge>
            )}
          </form.Subscribe>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={handleClose}>
              Отмена
            </Button>
            <Button
              onClick={() => void form.handleSubmit()}
              disabled={isPending}
              data-testid="user-dialog-submit"
            >
              {submitLabel}
            </Button>
          </div>
        </CrmDialogFooter>
      </CrmDialogContent>
    </Dialog>
  )
}
