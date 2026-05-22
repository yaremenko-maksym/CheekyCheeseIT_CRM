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
  PaymentMethod,
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
import { useAuth } from '@/context/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
import {
  AmountCurrencyInput,
  type Currency,
} from '@/components/ui/amount-currency-input'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import {
  CREATE_ALLOWED_ROLES,
  ROLE_LABELS,
  ROLE_VARIANT,
  ROLES,
  type CreateAllowedRole,
  type Role,
  normalizeTelegram,
} from './constants'
import { Field, Section } from './section'
import { ShareSlider } from './share-slider'

const telegramFieldSchema = updateProfileSchema.shape.telegram.unwrap().unwrap()
const phoneFieldSchema = z.string().max(30)

// USDT/Bank requisite validators — mirror the shared schema patterns so the
// inline field errors match what the backend would return.
const usdtWalletPattern = /^0x[a-fA-F0-9]{40}$/
const ibanPattern = /^UA\d{27}$/
const rnokppPattern = /^\d{10}$/

/**
 * Default payment method per role. SENIOR / ADMIN are USDT-only (enforced both
 * frontend & backend). Other roles default to BANK_UAH_FOP since most internal
 * payouts (HR, JUNIOR, ACCOUNTANT) go through ФОП in UAH.
 */
function defaultPaymentMethod(role: Role): PaymentMethod {
  return role === 'SENIOR' || role === 'ADMIN' ? 'USDT_ERC20' : 'BANK_UAH_FOP'
}

async function fetchUsersForDialog(): Promise<UserProfileDto[]> {
  const res = await api.get<UserProfileDto[]>('/users')
  return res.data
}

type ExchangeRates = { usdUah: string; usdtUah: string; eurUah: string; date: string }

/**
 * Convert an amount in the picked currency to USD. Mirrors the conversion
 * used by `AmountCurrencyInput` so the value we persist matches what the
 * admin saw in the "≈ USD" badge.
 */
function toUsd(amount: number, currency: Currency, rates: ExchangeRates): number {
  if (currency === 'USD' || currency === 'USDT') return amount
  if (currency === 'EUR') return amount * (parseFloat(rates.eurUah) / parseFloat(rates.usdUah))
  if (currency === 'UAH') return amount / parseFloat(rates.usdUah)
  return amount
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
 * Sectioned user CRUD dialog. 6 sections in a single vertical scroll:
 *   1. Identity (email + name + role)
 *   2. Contacts (telegram + phone)
 *   3. Tech stack
 *   4. Finance (SENIOR ShareSlider | non-SENIOR monthly salary with currency)
 *   5. Payment requisites (USDT / Bank UAH FOP)
 *   6. Team (SENIOR HR multiselect + Accountant; JUNIOR initial project (create) / current projects read-only (edit))
 *
 * Sticky footer: role badge (left) + Cancel/Submit (right).
 *
 * Edit mode now allows email changes (ut-9) — with a confirm dialog warning
 * about Google OAuth breakage. ADMIN cannot edit another ADMIN (ut-10), cannot
 * change their own role (ut-11), and ADMIN is removed from Create's role
 * dropdown (ut-12).
 */
export function UserDialog(props: UserDialogProps) {
  const queryClient = useQueryClient()
  const { user: me } = useAuth()
  const isCreate = props.mode === 'create'
  const isEdit = props.mode === 'edit'
  const open = isCreate ? props.open : !!props.user
  const editingUser = isEdit ? props.user : null

  const hrOnly = isCreate ? !!props.hrOnly : false

  // ut-11: SENIOR/ADMIN locked for self-ADMIN edit. We compute it once and
  // reuse in the Role select + footer hint.
  const isSelfAdminEdit =
    isEdit && !!editingUser && !!me && editingUser.id === me.id && editingUser.role === 'ADMIN'

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

  // Exchange rates — needed when admin enters a salary in non-USD currency.
  // Same query key as `AmountCurrencyInput` so the cache is shared.
  const { data: exchangeRates } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', 'today'],
    queryFn: () => api.get<ExchangeRates>('/finance/exchange-rate').then((r) => r.data),
    staleTime: 1000 * 60 * 60 * 24,
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

  // ut-7: For initial JUNIOR project select in Create — only projects without
  // an active JUNIOR. The business rule "max 1 active junior per project" makes
  // any project with a current JUNIOR an invalid pick at creation time.
  const availableJuniorProjects = useMemo(() => {
    if (!projects) return []
    return projects.filter((p) => {
      if (p.archivedAt) return false
      return !p.members.some((m) => m.role === 'JUNIOR' && m.leftAt === null)
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
  const initialRole: Role = (editingUser?.role as Role) ?? (hrOnly ? 'SENIOR' : 'JUNIOR')
  const initialPaymentMethod: PaymentMethod =
    (editingUser?.paymentMethod as PaymentMethod | null) ?? defaultPaymentMethod(initialRole)

  const form = useForm({
    defaultValues: {
      email: editingUser?.email ?? '',
      displayName: editingUser?.displayName ?? '',
      role: initialRole,
      telegram: editingUser?.telegram ?? '',
      phone: ((editingUser?.phone as PhoneValue | undefined) ?? '') as PhoneValue | '',
      techStack: (editingUser?.techStack ?? []) as string[],
      seniorSharePercent: editingUser?.seniorSharePercent ?? 26,
      monthlySalary: editingUser?.monthlySalary ?? '',
      salaryCurrency: ((editingUser?.salaryCurrency as Currency | undefined) ?? 'USD') as Currency,
      projectId: '' as string,
      // Payment requisites (ut-14)
      paymentMethod: initialPaymentMethod,
      walletUsdtErc20: editingUser?.walletUsdtErc20 ?? '',
      walletUsdtLabel: editingUser?.walletUsdtLabel ?? '',
      bankUahRecipient: editingUser?.bankUahRecipient ?? '',
      bankUahIban: editingUser?.bankUahIban ?? '',
      bankUahRnokpp: editingUser?.bankUahRnokpp ?? '',
      bankUahBankName: editingUser?.bankUahBankName ?? '',
    },
    onSubmit: async ({ value }) => {
      const isSenior = value.role === 'SENIOR'
      const hrIds = selectedHrIdsRef.current
      const accountantId = selectedAccountantIdRef.current

      // Convert salary to USD if needed. Backend stores USD numeric.
      const computeMonthlySalaryUsd = (): number | null => {
        const raw = String(value.monthlySalary).trim()
        if (!raw) return null
        const num = parseFloat(raw)
        if (!isFinite(num) || num < 0) return null
        if (!exchangeRates) return num // shouldn't happen — query enabled on open
        return Number(toUsd(num, value.salaryCurrency, exchangeRates).toFixed(2))
      }

      if (isCreate) {
        if (isSenior && hrIds.length === 0) {
          toast.error('Выберите хотя бы одного HR для команды синьора')
          return
        }

        // Build payment-requisites slice. SENIOR/ADMIN are USDT-only; other
        // roles use whatever the form's `paymentMethod` field says.
        const paymentMethod: PaymentMethod =
          isSenior || value.role === 'ADMIN' ? 'USDT_ERC20' : value.paymentMethod

        const payload: CreateUserDto = {
          email: value.email.trim(),
          displayName: value.displayName.trim(),
          role: value.role,
          telegram: value.telegram.trim() ? normalizeTelegram(value.telegram) : undefined,
          phone: (value.phone as string) || undefined,
          techStack: value.techStack.length > 0 ? value.techStack : undefined,
          paymentMethod,
          ...(paymentMethod === 'USDT_ERC20' && {
            walletUsdtErc20: value.walletUsdtErc20.trim(),
            ...(value.walletUsdtLabel.trim() && { walletUsdtLabel: value.walletUsdtLabel.trim() }),
          }),
          ...(paymentMethod === 'BANK_UAH_FOP' && {
            bankUahRecipient: value.bankUahRecipient.trim(),
            bankUahIban: value.bankUahIban.trim(),
            bankUahRnokpp: value.bankUahRnokpp.trim(),
            ...(value.bankUahBankName.trim() && { bankUahBankName: value.bankUahBankName.trim() }),
          }),
          ...(isSenior && {
            seniorSharePercent: value.seniorSharePercent,
            hrIds,
            accountantId: accountantId || null,
          }),
          ...(!isSenior && String(value.monthlySalary).trim() && {
            monthlySalary: computeMonthlySalaryUsd() ?? undefined,
            salaryCurrency: 'USD',
          }),
          // ut-13: project optional for JUNIOR. Only attach if explicitly chosen.
          ...(value.role === 'JUNIOR' && value.projectId && {
            projectId: value.projectId,
          }),
        }
        const result = createUserSchema.safeParse(payload)
        if (!result.success) {
          // Surface the first issue inline + as a single toast — the form
          // fields keep their own per-field error indicators below.
          const first = result.error.issues[0]
          toast.error(first?.message ?? 'Ошибка валидации данных')
          return
        }
        createMutation.mutate(result.data)
      } else {
        // Edit
        // Detect whether admin actually touched any payment requisite field.
        // When nothing changed we omit the entire payment slice — otherwise
        // `refineRequisitePresence` would block submit for users with empty
        // requisites in seed data (e.g. SENIOR without a wallet) even when the
        // admin only edited unrelated fields like HR/Accountant.
        const paymentChanged =
          !!editingUser &&
          (value.paymentMethod !== (editingUser.paymentMethod ?? defaultPaymentMethod(value.role)) ||
            value.walletUsdtErc20.trim() !== (editingUser.walletUsdtErc20 ?? '') ||
            value.walletUsdtLabel.trim() !== (editingUser.walletUsdtLabel ?? '') ||
            value.bankUahRecipient.trim() !== (editingUser.bankUahRecipient ?? '') ||
            value.bankUahIban.trim() !== (editingUser.bankUahIban ?? '') ||
            value.bankUahRnokpp.trim() !== (editingUser.bankUahRnokpp ?? '') ||
            value.bankUahBankName.trim() !== (editingUser.bankUahBankName ?? ''))

        const payload: AdminUpdateUserDto = {
          ...(editingUser && value.email.trim() !== editingUser.email && {
            email: value.email.trim(),
          }),
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
            monthlySalary: value.monthlySalary
              ? computeMonthlySalaryUsd()
              : null,
            salaryCurrency: 'USD',
          }),
          // Payment requisites — only include when admin actually changed them.
          // Sending paymentMethod without matching requisite fields would trip
          // `refineRequisitePresence` on the shared schema and block submit.
          ...(paymentChanged && {
            paymentMethod: value.paymentMethod,
            ...(value.paymentMethod === 'USDT_ERC20' && {
              walletUsdtErc20: value.walletUsdtErc20.trim() || null,
              walletUsdtLabel: value.walletUsdtLabel.trim() || null,
            }),
            ...(value.paymentMethod === 'BANK_UAH_FOP' && {
              bankUahRecipient: value.bankUahRecipient.trim() || null,
              bankUahIban: value.bankUahIban.trim() || null,
              bankUahRnokpp: value.bankUahRnokpp.trim() || null,
              bankUahBankName: value.bankUahBankName.trim() || null,
            }),
          }),
        }
        const result = adminUpdateUserSchema.safeParse(payload)
        if (!result.success) {
          const first = result.error.issues[0]
          toast.error(first?.message ?? 'Ошибка валидации данных')
          return
        }
        updateMutation.mutate(result.data)
      }
    },
  })

  // ut-9: Email change warning. We delay the form-level update until the admin
  // confirms; cancel reverts the field to the original email.
  const [pendingEmailChange, setPendingEmailChange] = useState<string | null>(null)
  const originalEmail = editingUser?.email ?? ''

  // Re-seed form when editing user changes (dialog reopens for different user).
  // `form.reset(defaults)` is idiomatic TanStack Form re-seed — clears touched/dirty
  // state between edit sessions, unlike per-field setFieldValue which preserves them.
  // Deps are intentionally limited to `editingUser?.id` + `isEdit`: `form` is
  // stable and re-running on every prop change would clobber user edits in-flight.
  useEffect(() => {
    if (isEdit && editingUser) {
      const role = editingUser.role as Role
      form.reset({
        email: editingUser.email,
        displayName: editingUser.displayName,
        role,
        telegram: editingUser.telegram ?? '',
        phone: ((editingUser.phone as PhoneValue | undefined) ?? '') as PhoneValue | '',
        techStack: editingUser.techStack ?? [],
        seniorSharePercent: editingUser.seniorSharePercent ?? 26,
        monthlySalary: editingUser.monthlySalary ?? '',
        salaryCurrency: ((editingUser.salaryCurrency as Currency | undefined) ?? 'USD') as Currency,
        projectId: '',
        paymentMethod:
          (editingUser.paymentMethod as PaymentMethod | null) ?? defaultPaymentMethod(role),
        walletUsdtErc20: editingUser.walletUsdtErc20 ?? '',
        walletUsdtLabel: editingUser.walletUsdtLabel ?? '',
        bankUahRecipient: editingUser.bankUahRecipient ?? '',
        bankUahIban: editingUser.bankUahIban ?? '',
        bankUahRnokpp: editingUser.bankUahRnokpp ?? '',
        bankUahBankName: editingUser.bankUahBankName ?? '',
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
    <>
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
              <form.Field
                name="email"
                validators={{
                  onBlur: ({ value, fieldApi }) => {
                    // ut-8: skip validation if the field was never touched. The
                    // dialog opens with an empty email in Create; clicking
                    // anywhere outside the empty input shouldn't ignite the
                    // "Invalid email" hint.
                    if (!fieldApi.state.meta.isDirty) return undefined
                    const trimmed = value.trim()
                    if (!trimmed) return 'Email обязателен'
                    const r = z.string().email('Некорректный email').safeParse(trimmed)
                    return r.success ? undefined : r.error.issues[0]?.message
                  },
                }}
              >
                {(field) => {
                  // ut-8: hide error until the field has been edited at least
                  // once. `isDirty` flips after the first change — pure focus
                  // + blur (no value change) keeps the error suppressed.
                  const showError =
                    field.state.meta.isTouched && field.state.meta.isDirty
                  const err = showError ? field.state.meta.errors[0] : undefined
                  return (
                    <Field label="Email" error={err} required>
                      <Input
                        placeholder="user@cheekycheese.dev"
                        value={field.state.value}
                        onChange={(e) => field.handleChange(e.target.value)}
                        onBlur={() => {
                          field.handleBlur()
                          // ut-9: in Edit mode, surface the warning dialog
                          // once the admin commits an email that differs from
                          // the original (and is non-empty + valid email).
                          if (
                            isEdit &&
                            editingUser &&
                            field.state.value.trim() !== originalEmail &&
                            field.state.value.trim().length > 0
                          ) {
                            setPendingEmailChange(field.state.value.trim())
                          }
                        }}
                        className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                        autoComplete="off"
                        data-testid="user-dialog-email"
                      />
                    </Field>
                  )
                }}
              </form.Field>

              <form.Field
                name="displayName"
                validators={{
                  onBlur: ({ value, fieldApi }) => {
                    if (!fieldApi.state.meta.isDirty) return undefined
                    const r = z
                      .string()
                      .min(2, 'Имя минимум 2 символа')
                      .max(255)
                      .safeParse(value.trim())
                    return r.success ? undefined : r.error.issues[0]?.message
                  },
                }}
              >
                {(field) => {
                  const showError = field.state.meta.isTouched && field.state.meta.isDirty
                  const err = showError ? field.state.meta.errors[0] : undefined
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
                {(field) => {
                  // ut-12: in Create, ADMIN is intentionally omitted.
                  // ut-11: in Edit, self-ADMIN cannot change away from ADMIN.
                  const optionList: readonly Role[] = isCreate
                    ? (CREATE_ALLOWED_ROLES as readonly CreateAllowedRole[])
                    : ROLES
                  return (
                    <Field
                      label="Роль"
                      required
                      hint={isSelfAdminEdit ? 'Нельзя сменить свою роль ADMIN' : undefined}
                    >
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
                          disabled={isSelfAdminEdit}
                        >
                          <SelectTrigger data-testid="user-dialog-role-trigger">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {optionList.map((r) => (
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
                  )
                }}
              </form.Field>
            </Section>

            {/* ── Section 2: Contacts ─────────────────────────────────── */}
            <Section title="Контакты">
              <form.Field
                name="telegram"
                validators={{
                  onBlur: ({ value, fieldApi }) => {
                    if (!fieldApi.state.meta.isDirty) return undefined
                    if (!value.trim()) return undefined
                    const r = telegramFieldSchema.safeParse(value.trim())
                    return r.success ? undefined : r.error.issues[0]?.message
                  },
                }}
              >
                {(field) => {
                  const showError = field.state.meta.isTouched && field.state.meta.isDirty
                  const err = showError ? field.state.meta.errors[0] : undefined
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
                  onBlur: ({ value, fieldApi }) => {
                    if (!fieldApi.state.meta.isDirty) return undefined
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
                  const showError = field.state.meta.isTouched && field.state.meta.isDirty
                  const err = showError ? field.state.meta.errors[0] : undefined
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
                        const err = field.state.meta.isTouched ? field.state.meta.errors[0] : undefined
                        return (
                          <Field
                            label="Доля синьора (%)"
                            hint="То, что синьор оставляет себе"
                            error={err}
                            required={isCreate}
                          >
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
                  ) : (
                    <form.Field name="monthlySalary">
                      {(field) => (
                        <form.Field name="salaryCurrency">
                          {(curField) => (
                            <Field label="Месячная зарплата">
                              <AmountCurrencyInput
                                amount={String(field.state.value ?? '')}
                                currency={curField.state.value}
                                onAmountChange={field.handleChange}
                                onCurrencyChange={curField.handleChange}
                                label="Сумма"
                                placeholder="0"
                              />
                            </Field>
                          )}
                        </form.Field>
                      )}
                    </form.Field>
                  )}
                </Section>
              )}
            </form.Subscribe>

            {/* ── Section 5: Payment requisites (ut-14) ───────────────── */}
            <form.Subscribe selector={(s) => s.values.role}>
              {(role) => {
                const usdtOnly = role === 'SENIOR' || role === 'ADMIN'
                return (
                  <Section title="Платёжные реквизиты">
                    {usdtOnly ? (
                      <p className="text-xs text-muted-foreground">
                        Для роли «{ROLE_LABELS[role]}» доступна только оплата через USDT ERC-20.
                      </p>
                    ) : (
                      <form.Field name="paymentMethod">
                        {(field) => (
                          <Field label="Способ оплаты" required>
                            <div className="flex gap-3" data-testid="user-dialog-payment-method">
                              {(['USDT_ERC20', 'BANK_UAH_FOP'] as const).map((m) => (
                                <label
                                  key={m}
                                  className={cn(
                                    'flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer transition-colors',
                                    field.state.value === m
                                      ? 'border-primary bg-primary/5'
                                      : 'border-border hover:bg-muted/30',
                                  )}
                                >
                                  <input
                                    type="radio"
                                    name="paymentMethod"
                                    value={m}
                                    checked={field.state.value === m}
                                    onChange={() => field.handleChange(m)}
                                    className="accent-primary"
                                  />
                                  {m === 'USDT_ERC20' ? 'USDT ERC-20' : 'Bank UAH (ФОП)'}
                                </label>
                              ))}
                            </div>
                          </Field>
                        )}
                      </form.Field>
                    )}

                    <form.Subscribe selector={(s) => (usdtOnly ? 'USDT_ERC20' : s.values.paymentMethod)}>
                      {(method) =>
                        method === 'USDT_ERC20' ? (
                          <>
                            <form.Field
                              name="walletUsdtErc20"
                              validators={{
                                onBlur: ({ value, fieldApi }) => {
                                  if (!fieldApi.state.meta.isDirty) return undefined
                                  if (!value.trim()) return 'USDT кошелёк обязателен'
                                  return usdtWalletPattern.test(value.trim())
                                    ? undefined
                                    : 'USDT ERC-20 адрес должен начинаться с 0x и содержать 42 символа'
                                },
                              }}
                            >
                              {(field) => {
                                const showError = field.state.meta.isTouched && field.state.meta.isDirty
                                const err = showError ? field.state.meta.errors[0] : undefined
                                return (
                                  <Field label="USDT ERC-20 кошелёк" error={err} required>
                                    <Input
                                      placeholder="0x..."
                                      value={field.state.value}
                                      onChange={(e) => field.handleChange(e.target.value)}
                                      onBlur={field.handleBlur}
                                      autoComplete="off"
                                      className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                                      data-testid="user-dialog-wallet"
                                    />
                                  </Field>
                                )
                              }}
                            </form.Field>
                            <form.Field name="walletUsdtLabel">
                              {(field) => (
                                <Field label="Лейбл кошелька">
                                  <Input
                                    placeholder="Основной"
                                    value={field.state.value}
                                    onChange={(e) => field.handleChange(e.target.value)}
                                    onBlur={field.handleBlur}
                                  />
                                </Field>
                              )}
                            </form.Field>
                          </>
                        ) : (
                          <>
                            <form.Field
                              name="bankUahRecipient"
                              validators={{
                                onBlur: ({ value, fieldApi }) => {
                                  if (!fieldApi.state.meta.isDirty) return undefined
                                  return value.trim().length >= 3
                                    ? undefined
                                    : 'ФИО получателя минимум 3 символа'
                                },
                              }}
                            >
                              {(field) => {
                                const showError = field.state.meta.isTouched && field.state.meta.isDirty
                                const err = showError ? field.state.meta.errors[0] : undefined
                                return (
                                  <Field label="ФИО получателя (ФОП)" error={err} required>
                                    <Input
                                      placeholder="Иванов Иван Иванович"
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
                              name="bankUahIban"
                              validators={{
                                onBlur: ({ value, fieldApi }) => {
                                  if (!fieldApi.state.meta.isDirty) return undefined
                                  return ibanPattern.test(value.trim())
                                    ? undefined
                                    : 'IBAN должен быть в формате UA + 27 цифр'
                                },
                              }}
                            >
                              {(field) => {
                                const showError = field.state.meta.isTouched && field.state.meta.isDirty
                                const err = showError ? field.state.meta.errors[0] : undefined
                                return (
                                  <Field label="IBAN" error={err} required>
                                    <Input
                                      placeholder="UA000000000000000000000000000"
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
                              name="bankUahRnokpp"
                              validators={{
                                onBlur: ({ value, fieldApi }) => {
                                  if (!fieldApi.state.meta.isDirty) return undefined
                                  return rnokppPattern.test(value.trim())
                                    ? undefined
                                    : 'РНОКПП должен быть 10 цифр'
                                },
                              }}
                            >
                              {(field) => {
                                const showError = field.state.meta.isTouched && field.state.meta.isDirty
                                const err = showError ? field.state.meta.errors[0] : undefined
                                return (
                                  <Field label="РНОКПП (ИНН ФОП)" error={err} required>
                                    <Input
                                      placeholder="1234567890"
                                      value={field.state.value}
                                      onChange={(e) => field.handleChange(e.target.value)}
                                      onBlur={field.handleBlur}
                                      className={cn(err && 'border-destructive focus-visible:ring-destructive/30')}
                                    />
                                  </Field>
                                )
                              }}
                            </form.Field>
                            <form.Field name="bankUahBankName">
                              {(field) => (
                                <Field label="Банк (опционально)">
                                  <Input
                                    placeholder="ПриватБанк"
                                    value={field.state.value}
                                    onChange={(e) => field.handleChange(e.target.value)}
                                    onBlur={field.handleBlur}
                                  />
                                </Field>
                              )}
                            </form.Field>
                          </>
                        )
                      }
                    </form.Subscribe>
                  </Section>
                )
              }}
            </form.Subscribe>

            {/* ── Section 6: Team ─────────────────────────────────────── */}
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
                            <Field
                              label="Проект"
                              hint="Можно прикрепить позже через раздел «Проекты»"
                            >
                              {availableJuniorProjects.length === 0 ? (
                                <p className="text-xs text-muted-foreground italic">
                                  Нет проектов без активного джуна
                                </p>
                              ) : (
                                <Select
                                  value={field.state.value || 'none'}
                                  onValueChange={(v) => field.handleChange(v === 'none' ? '' : v)}
                                >
                                  <SelectTrigger>
                                    <SelectValue placeholder="— не выбран —" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="none">— не выбран —</SelectItem>
                                    {availableJuniorProjects.map((p) => (
                                      <SelectItem key={p.id} value={p.id}>
                                        {p.companyName} — {p.name}
                                      </SelectItem>
                                    ))}
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

    {/* ut-9: Email change warning. Confirms or reverts the email field. */}
    <AlertDialog
      open={!!pendingEmailChange}
      onOpenChange={(o) => !o && setPendingEmailChange(null)}
    >
      <AlertDialogContent data-testid="email-change-warning">
        <AlertDialogHeader>
          <AlertDialogTitle>Сменить email?</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">
              Смена email может разорвать вход через Google для{' '}
              <strong>{editingUser?.displayName}</strong>. Убедись, что пользователь
              знает и сменит свой Google account при необходимости.
            </span>
            <span className="block text-muted-foreground">
              Старый: <code className="px-1 rounded bg-muted">{originalEmail}</code>
              <br />
              Новый: <code className="px-1 rounded bg-muted">{pendingEmailChange}</code>
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={() => {
              form.setFieldValue('email', originalEmail)
              setPendingEmailChange(null)
            }}
          >
            Отмена
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={() => setPendingEmailChange(null)}
            data-testid="email-change-confirm"
          >
            Подтвердить изменение
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    </>
  )
}
