import { Link, useNavigate } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Coins,
  Landmark,
  Pencil,
  Percent,
  Send,
  UserPlus,
  Users,
  Sparkles,
  ArrowLeft,
  ArrowRight,
  FileText,
  CheckCircle2,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { isValidPhoneNumber } from 'react-phone-number-input'
import type { Value as PhoneValue } from 'react-phone-number-input'
import { z } from 'zod'
import type { AxiosError } from 'axios'
import type {
  AdminUpdateUserDto,
  CreateDropDto,
  CreateUserDto,
  PaymentMethod,
  ProjectDto,
  TeamDto,
  TeamMode,
  UserProfileDto,
} from '@crm/shared'
import {
  adminUpdateUserSchema,
  createDropSchema,
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { TechAutocompleteInput } from '@/components/ui/tech-autocomplete-input'
import { AmountCurrencyInput, type Currency } from '@/components/ui/amount-currency-input'
import { SegmentedToggle } from '@/components/ui/segmented-toggle'
import { api } from '@/lib/axios'
import { cn } from '@/lib/utils'
import { CreateWizardStepper } from './CreateWizardStepper'
import {
  useEmployeeContract,
  useSaveContractBody,
} from '@/components/user-profile/contract/useEmployeeContract'
import { ContractEditor } from '@/components/user-profile/contract/ContractEditor'
import { ContractActionBar } from '@/components/user-profile/contract/ContractActionBar'
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
import { ShareSlider } from '@/components/ui/share-slider'
import { HrChipsField } from './HrChipsField'
import { AccountantChipField } from './AccountantChipField'

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
  const navigate = useNavigate()
  const { user: me } = useAuth()
  const isCreate = props.mode === 'create'
  const isEdit = props.mode === 'edit'
  const open = isCreate ? props.open : !!props.user
  const editingUser = isEdit ? props.user : null

  const hrOnly = isCreate ? !!props.hrOnly : false

  // ── Wizard state (create-mode only) ─────────────────────────────────────
  // currentStep: 1=Data, 2=Contract, 3=Confirm
  // createdUserId: set after successful POST /api/users in step 1
  // hasContract: set true when step 2 successfully loads a contract
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1)
  const [createdUserId, setCreatedUserId] = useState<string | null>(null)
  const [hasContract, setHasContract] = useState<boolean>(false)
  const [wizardContractBody, setWizardContractBody] = useState<string>('')
  const [wizardContractDirty, setWizardContractDirty] = useState<boolean>(false)
  const [wizardShowHint, setWizardShowHint] = useState<boolean>(false)

  // Reset wizard state when dialog opens/closes
  useEffect(() => {
    if (isCreate && !open) {
      setCurrentStep(1)
      setCreatedUserId(null)
      setHasContract(false)
      setWizardContractBody('')
      setWizardContractDirty(false)
      setWizardShowHint(false)
    }
  }, [isCreate, open])

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
  // ut-20: key includes today's calendar day so cache auto-refreshes past midnight.
  const exchangeTodayKey = new Date().toISOString().slice(0, 10)
  const { data: exchangeRates } = useQuery<ExchangeRates>({
    queryKey: ['exchange-rate', exchangeTodayKey],
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
  // Drop role - phase 1 fix (AC6): inline validation error shown under the
  // HR multiselect. Set when submit fails the «HR ≥ 1» guard; cleared as
  // soon as the user adds an HR (handled via `handleHrChange` below) so the
  // red error message doesn't linger after the user fixed the issue.
  const [hrError, setHrError] = useState<string | undefined>(undefined)
  // Wrapping setter so we clear the error optimistically when the user
  // edits the selection — matches `touched` semantics in TanStack Form.
  const handleHrChange = (next: string[]) => {
    setSelectedHrIds(next)
    if (hrError && next.length > 0) setHrError(undefined)
  }

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

  // Drop role - phase 1 (AC3): senior creation supports two team modes —
  // CREATE_NEW (default; existing behavior) or JOIN_DROP_TEAM (pick a
  // drop-team without an active senior). Fetched lazily only when the
  // create-senior path is open: avoids an extra network call for non-senior
  // role flows and during edit.
  const { data: dropTeamsForJoin } = useQuery({
    queryKey: ['teams', { type: 'DROP', vacant: true }],
    queryFn: () => api.get<TeamDto[]>('/teams').then((r) => r.data),
    enabled: isCreate && open,
    staleTime: 30_000,
  })
  /**
   * Drop teams eligible for `JOIN_DROP_TEAM`:
   *  - `type === 'DROP'`
   *  - not archived
   *  - no active senior member (`role === 'SENIOR'` && `leftAt === null`)
   *
   * Backend's `addSeniorToDropTeam` enforces the same invariants — this
   * client-side filter is a UX guard so the dropdown lists only valid
   * options. Falling out of sync (e.g. another admin just rotated a
   * senior in) surfaces a backend 400 toast.
   */
  const vacantDropTeams = useMemo(() => {
    if (!dropTeamsForJoin) return []
    return dropTeamsForJoin.filter(
      (t) =>
        t.type === 'DROP' &&
        !t.archivedAt &&
        !t.members.some((m) => m.role === 'SENIOR' && !m.leftAt),
    )
  }, [dropTeamsForJoin])

  /**
   * Senior's team is the team where the senior is an active member with role=SENIOR.
   * Existing HR/Accountant in that team (with leftAt=NULL) seed selections.
   * Also seeds `teamTelegramChannel` from the team row (ut-17).
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
        form.setFieldValue('teamTelegramChannel', seniorsTeam.telegramChannel ?? '')
      } else {
        setSelectedHrIds([])
        setSelectedAccountantId('')
        form.setFieldValue('teamTelegramChannel', '')
      }
    } else if (isCreate && open) {
      // For CREATE: defaults — pre-select if only one option exists
      const initial = hrUsers.length === 1 && hrUsers[0] ? [hrUsers[0].id] : []
      setSelectedHrIds(initial)
      const accInitial =
        accountantUsers.length === 1 && accountantUsers[0] ? accountantUsers[0].id : ''
      setSelectedAccountantId(accInitial)
    }
    // form is stable but we intentionally exclude it from deps — re-running on
    // every form-state change would clobber edits in progress.
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
  // ut-40: invalidate the generic `['users']` cache as well — that's the
  // key consumed by project/team dropdowns (`GET /api/users`). Without it,
  // a freshly-created SENIOR didn't appear in the «Создать проект» dropdown
  // until a manual refresh because the cached user list stayed stale.
  //
  // Drop-archive round 2 (B4): unified mutation error handler. 409 from
  // `/users` (and `/users/drops`) means "email already exists" — we show
  // a tailored toast and leave the dialog open so the operator can fix
  // the email and resubmit. Other HTTP codes surface the backend message
  // or a generic fallback. Shared between create-user, create-drop, and
  // (rarely) update — same `/users` endpoint surface.
  const explainUserMutationError = (
    err: AxiosError<{ message?: string }>,
    fallback: string,
  ): string => {
    if (err?.response?.status === 409) {
      return 'Пользователь с таким email уже существует'
    }
    return err?.response?.data?.message ?? fallback
  }

  const createMutation = useMutation({
    mutationFn: (data: CreateUserDto) => api.post<UserProfileDto>('/users', data),
    onSuccess: (res, variables) => {
      const newUserId = (res.data as UserProfileDto).id
      // A3-3 wizard: store created user id and advance to step 2.
      // Do NOT close dialog — user continues to contract step.
      setCreatedUserId(newUserId)
      setCurrentStep(2)
      // Drop role - phase 1 fix (AC8): SENIOR with JOIN_DROP_TEAM gets a
      // tailored toast — show it after all 3 steps at wizard close instead.
      // For non-senior creates keep silent here (success shown at wizard end).
      const isJoinDrop = variables.role === 'SENIOR' && variables.teamMode === 'JOIN_DROP_TEAM'
      if (isJoinDrop) {
        toast.success('Синьор добавлен в команду дропа', { duration: 4500 })
      }
    },
    onError: (err: AxiosError<{ message?: string }>) => {
      // 409 → duplicate email toast, dialog stays open. See `explainUserMutationError`.
      toast.error(explainUserMutationError(err, 'Ошибка при создании'))
    },
  })

  // DROP role — separate endpoint that atomically provisions both the user
  // and the drop-team. Response shape: `{ user, team: { id, ... }, members }`
  // — we navigate to the new team detail page on success (mirrors the legacy
  // CreateDropDialog flow now folded into UserDialog).
  const createDropMutation = useMutation({
    mutationFn: (data: CreateDropDto) =>
      api.post<{ user: UserProfileDto; team: { id: string } }>('/users/drops', data),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      // Drop role - phase 1 fix (AC8): explicit duration so the toast lives
      // through the team-detail navigation (sonner defaults to 4s, but we
      // close the dialog + navigate in the same tick — the previous render
      // sometimes pruned the toast before it ever painted). 4500ms keeps it
      // within the spec «4-5 sec» band.
      toast.success('Дроп создан', { duration: 4500 })
      props.onClose()
      const newTeamId = res.data.team?.id
      if (newTeamId) {
        void navigate({ to: '/crm/team/$teamId', params: { teamId: newTeamId } })
      }
    },
    onError: (err: AxiosError<{ message?: string }>) => {
      toast.error(explainUserMutationError(err, 'Ошибка при создании дропа'))
    },
  })

  // A3-3: wizard step-1 «Далее» uses PATCH when createdUserId is already set
  // (i.e. admin went Back from step 2 and edited fields). This avoids a
  // duplicate POST /users → 409 conflict.
  const wizardUpdateMutation = useMutation({
    mutationFn: (data: AdminUpdateUserDto) =>
      api.patch<UserProfileDto>(`/users/${createdUserId}`, data),
    onSuccess: () => {
      // Advance to contract step — same outcome as initial POST success.
      setCurrentStep(2)
    },
    onError: (err: AxiosError<{ message?: string }>) => {
      toast.error(explainUserMutationError(err, 'Ошибка при обновлении'))
    },
  })

  // A3-3: POST /api/users/:id/contract/ready — DRAFT → READY_TO_SIGN at wizard end.
  const markReadyMutation = useMutation({
    mutationFn: () => api.post(`/users/${createdUserId}/contract/ready`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success('Пользователь создан, контракт готов к подписанию', { duration: 4500 })
      setCurrentStep(1)
      setCreatedUserId(null)
      setHasContract(false)
      props.onClose()
    },
    onError: (err: AxiosError<{ message?: string }>) => {
      toast.error(explainUserMutationError(err, 'Ошибка при переводе контракта'))
    },
  })

  const updateMutation = useMutation({
    mutationFn: (data: AdminUpdateUserDto) =>
      api.patch<UserProfileDto>(`/users/${editingUser!.id}`, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      void queryClient.invalidateQueries({ queryKey: ['teams'] })
      void queryClient.invalidateQueries({ queryKey: ['user-profile', editingUser?.id] })
      toast.success('Пользователь обновлён')
      props.onClose()
    },
    onError: (err: AxiosError<{ message?: string }>) => {
      // Edit can hit 409 too if admin changes email to an already-taken one.
      toast.error(explainUserMutationError(err, 'Ошибка при обновлении'))
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
      // ut-17: SENIOR-only Telegram channel of the senior's team. Resolved from
      // the senior's team in the `allTeams` query (useEffect below). Empty
      // string when no channel set or non-SENIOR.
      teamTelegramChannel: '' as string,
      // Drop role - phase 1 (AC3): senior create mode picker. Default
      // `CREATE_NEW` preserves the legacy senior-team auto-create path
      // 1:1 — backend service also defaults to CREATE_NEW when this
      // field is omitted (defense-in-depth).
      teamMode: 'CREATE_NEW' as TeamMode,
      dropTeamId: '' as string,
      // DROP role — share % the drop keeps from each payout. Default 5
      // matches the spec and `createDropSchema` default.
      dropSharePercent: editingUser?.dropSharePercent ?? 5,
      // DROP role — optional Telegram channel of the drop-team (same
      // regex as the SENIOR team telegram channel).
      teamTelegramChannelDrop: '' as string,
      // Данные для контракта — юридическое ФИО (задаётся ADMIN, используется в MSA)
      legalFullName: editingUser?.legalFullName ?? '',
    },
    onSubmit: async ({ value }) => {
      const isSenior = value.role === 'SENIOR'
      const isDrop = value.role === 'DROP'
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

      if (isCreate && isDrop) {
        // DROP creation hits the dedicated endpoint which atomically
        // provisions both the user and the drop-team. HR + accountant
        // pickers are mandatory (same UI contract as senior CREATE_NEW).
        //
        // Drop role - phase 1 fix (AC6/AC7): inline error under the HR
        // multiselect AND a single «Заполните обязательные поля» toast.
        // Previously submit failed silently — dialog stayed open without
        // any feedback. We now both call out the broken field inline (so
        // the user can see *which* field) and surface a compact toast (so
        // they're aware submit didn't go through if their eyes are off
        // the form).
        if (hrIds.length === 0) {
          setHrError('Выберите минимум одного HR')
          toast.error('Заполните обязательные поля')
          return
        }
        if (!accountantId) {
          toast.error('Заполните обязательные поля')
          return
        }
        const trimmedChannel = value.teamTelegramChannelDrop.trim()
        const normalizedChannel = trimmedChannel
          ? trimmedChannel.startsWith('@')
            ? trimmedChannel.slice(1)
            : trimmedChannel
          : null

        const payload: CreateDropDto = {
          email: value.email.trim(),
          displayName: value.displayName.trim(),
          telegram: value.telegram.trim() ? normalizeTelegram(value.telegram) : undefined,
          phone: (value.phone as string) || undefined,
          ...(value.techStack.length > 0 && { techStack: value.techStack }),
          dropSharePercent: value.dropSharePercent,
          paymentMethod: value.paymentMethod,
          ...(value.paymentMethod === 'USDT_ERC20' && {
            walletUsdtErc20: value.walletUsdtErc20.trim(),
            ...(value.walletUsdtLabel.trim() && {
              walletUsdtLabel: value.walletUsdtLabel.trim(),
            }),
          }),
          ...(value.paymentMethod === 'BANK_UAH_FOP' && {
            bankUahRecipient: value.bankUahRecipient.trim(),
            bankUahIban: value.bankUahIban.trim(),
            bankUahRnokpp: value.bankUahRnokpp.trim(),
            ...(value.bankUahBankName.trim() && {
              bankUahBankName: value.bankUahBankName.trim(),
            }),
          }),
          hrIds,
          accountantId,
          telegramChannel: normalizedChannel,
        }
        const result = createDropSchema.safeParse(payload)
        if (!result.success) {
          const first = result.error.issues[0]
          toast.error(first?.message ?? 'Ошибка валидации данных')
          return
        }
        createDropMutation.mutate(result.data)
        return
      }

      if (isCreate) {
        // A3-3 AC6: if user was already created (createdUserId set after first
        // successful POST), «Далее» from step 1 must PATCH — not POST again.
        // This handles the «Назад» → edit → «Далее» flow without 409 duplicate.
        if (createdUserId !== null) {
          const paymentMethodUpdate: PaymentMethod =
            isSenior || value.role === 'ADMIN' ? 'USDT_ERC20' : value.paymentMethod
          const updatePayload: AdminUpdateUserDto = {
            displayName: value.displayName.trim(),
            telegram: value.telegram.trim() ? normalizeTelegram(value.telegram) : null,
            phone: (value.phone as string) || null,
            techStack: value.techStack.length > 0 ? value.techStack : null,
            paymentMethod: paymentMethodUpdate,
            ...(paymentMethodUpdate === 'USDT_ERC20' && {
              walletUsdtErc20: value.walletUsdtErc20.trim() || null,
              walletUsdtLabel: value.walletUsdtLabel.trim() || null,
            }),
            ...(paymentMethodUpdate === 'BANK_UAH_FOP' && {
              bankUahRecipient: value.bankUahRecipient.trim() || null,
              bankUahIban: value.bankUahIban.trim() || null,
              bankUahRnokpp: value.bankUahRnokpp.trim() || null,
              bankUahBankName: value.bankUahBankName.trim() || null,
            }),
            ...(isSenior && {
              seniorSharePercent: value.seniorSharePercent,
              hrIds,
              accountantId: accountantId || null,
            }),
            ...(!isSenior && {
              monthlySalary: value.monthlySalary ? computeMonthlySalaryUsd() : null,
              salaryCurrency: 'USD',
            }),
            ...(value.legalFullName.trim() && {
              legalFullName: value.legalFullName.trim(),
            }),
          }
          const updateResult = adminUpdateUserSchema.safeParse(updatePayload)
          if (!updateResult.success) {
            const first = updateResult.error.issues[0]
            toast.error(first?.message ?? 'Ошибка валидации данных')
            return
          }
          wizardUpdateMutation.mutate(updateResult.data)
          return
        }

        // Drop role - phase 1 (AC3): when JOIN_DROP_TEAM, HR/accountant are
        // sourced from the existing drop-team — local pickers stay hidden
        // and we skip the «HR required» guard. CREATE_NEW retains the
        // legacy validation 1:1.
        const isJoinDropTeam = isSenior && value.teamMode === 'JOIN_DROP_TEAM'
        if (isSenior && !isJoinDropTeam && hrIds.length === 0) {
          // Same inline + toast pair as the DROP branch — see comment above.
          setHrError('Выберите минимум одного HR')
          toast.error('Заполните обязательные поля')
          return
        }
        if (isJoinDropTeam && !value.dropTeamId) {
          toast.error('Заполните обязательные поля')
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
            // Drop role - phase 1 (AC3): when JOIN_DROP_TEAM, omit HR /
            // accountant — backend reads them from the chosen drop-team.
            // Sending stale arrays would just be ignored, but omitting
            // them keeps the payload truthful.
            ...(!isJoinDropTeam && {
              hrIds,
              accountantId: accountantId || null,
            }),
            ...(value.teamMode === 'JOIN_DROP_TEAM' && {
              teamMode: 'JOIN_DROP_TEAM' as TeamMode,
              dropTeamId: value.dropTeamId,
            }),
          }),
          ...(!isSenior &&
            String(value.monthlySalary).trim() && {
              monthlySalary: computeMonthlySalaryUsd() ?? undefined,
              salaryCurrency: 'USD',
            }),
          // ut-13: project optional for JUNIOR. Only attach if explicitly chosen.
          ...(value.role === 'JUNIOR' &&
            value.projectId && {
              projectId: value.projectId,
            }),
          // Contract data — legal full name for MSA contract (optional at create time).
          ...(value.legalFullName.trim() && {
            legalFullName: value.legalFullName.trim(),
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
          (value.paymentMethod !==
            (editingUser.paymentMethod ?? defaultPaymentMethod(value.role)) ||
            value.walletUsdtErc20.trim() !== (editingUser.walletUsdtErc20 ?? '') ||
            value.walletUsdtLabel.trim() !== (editingUser.walletUsdtLabel ?? '') ||
            value.bankUahRecipient.trim() !== (editingUser.bankUahRecipient ?? '') ||
            value.bankUahIban.trim() !== (editingUser.bankUahIban ?? '') ||
            value.bankUahRnokpp.trim() !== (editingUser.bankUahRnokpp ?? '') ||
            value.bankUahBankName.trim() !== (editingUser.bankUahBankName ?? ''))

        // ut-17: normalize team telegram channel value. Strip leading @ before
        // sending — the backend stores the bare handle, UI re-adds @ on display.
        const normalizedTeamChannel = (() => {
          if (!isSenior) return undefined
          const trimmed = value.teamTelegramChannel.trim()
          if (!trimmed) return null
          return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed
        })()

        const payload: AdminUpdateUserDto = {
          ...(editingUser &&
            value.email.trim() !== editingUser.email && {
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
            teamTelegramChannel: normalizedTeamChannel,
          }),
          ...(!isSenior && {
            monthlySalary: value.monthlySalary ? computeMonthlySalaryUsd() : null,
            salaryCurrency: 'USD',
          }),
          // Contract data — legal full name for MSA contract. Empty string → omit
          // (backend treats absence as "no change").
          ...(value.legalFullName.trim() && {
            legalFullName: value.legalFullName.trim(),
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
        // Re-seeded again by the allTeams effect once the query resolves.
        teamTelegramChannel: '',
        // Drop role - phase 1: team-mode picker is create-only. In edit
        // mode the field is ignored — re-seed to default for safety.
        teamMode: 'CREATE_NEW' as TeamMode,
        dropTeamId: '',
        dropSharePercent: editingUser.dropSharePercent ?? 5,
        teamTelegramChannelDrop: '',
        legalFullName: editingUser.legalFullName ?? '',
      })
    }
  }, [editingUser?.id, isEdit])

  const handleClose = () => {
    if (isCreate) {
      form.reset()
      setCurrentStep(1)
      setCreatedUserId(null)
      setHasContract(false)
    }
    props.onClose()
  }

  // A3-3: wizard finalize — «Сохранить как черновик»
  const handleWizardSaveDraft = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['users-admin'] })
    void queryClient.invalidateQueries({ queryKey: ['users'] })
    toast.success('Пользователь создан, контракт сохранён как черновик', { duration: 4500 })
    setCurrentStep(1)
    setCreatedUserId(null)
    setHasContract(false)
    props.onClose()
  }, [queryClient, props])

  const isPending =
    createMutation.isPending ||
    updateMutation.isPending ||
    createDropMutation.isPending ||
    wizardUpdateMutation.isPending ||
    markReadyMutation.isPending
  const submitLabel = isCreate
    ? createMutation.isPending || createDropMutation.isPending
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
            {/* ── Wizard Stepper (create-mode only) ─────────────────────── */}
            {isCreate && (
              <div className="px-1 pt-2">
                <CreateWizardStepper current={currentStep} />
              </div>
            )}

            {/* ── Step 2: Contract editor (create wizard) ────────────────── */}
            {isCreate && currentStep === 2 && createdUserId && (
              <WizardStep2
                userId={createdUserId}
                onHasContract={setHasContract}
                body={wizardContractBody}
                onBodyChange={(v) => {
                  setWizardContractBody(v)
                  setWizardContractDirty(true)
                }}
                isDirty={wizardContractDirty}
                showHint={wizardShowHint}
                onToggleHint={() => setWizardShowHint((p) => !p)}
              />
            )}

            {/* ── Step 3: Confirm (create wizard) ───────────────────────── */}
            {isCreate && currentStep === 3 && (
              <WizardStep3
                hasContract={hasContract}
                onSaveDraft={handleWizardSaveDraft}
                onMarkReady={() => markReadyMutation.mutate()}
                isMarkingReady={markReadyMutation.isPending}
                onBack={() => setCurrentStep(2)}
              />
            )}

            {/* ── Step 1 form (or edit form) — hidden at wizard steps 2/3 ─ */}
            <div className={cn('grid gap-3 py-2', isCreate && currentStep !== 1 && 'hidden')}>
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
                    const showError = field.state.meta.isTouched && field.state.meta.isDirty
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
                          className={cn(
                            err && 'border-destructive focus-visible:ring-destructive/30',
                          )}
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
                          className={cn(
                            err && 'border-destructive focus-visible:ring-destructive/30',
                          )}
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
                            <Badge variant="senior" className="text-[11px]">
                              Синьор
                            </Badge>
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

              {/* ── Section 1.5: Contract data (non-ADMIN only) ─────────── */}
              <form.Subscribe selector={(s) => s.values.role}>
                {(role) =>
                  role !== 'ADMIN' ? (
                    <Section title="Данные для контракта">
                      <form.Field
                        name="legalFullName"
                        validators={{
                          onBlur: ({ value, fieldApi }) => {
                            if (!fieldApi.state.meta.isDirty) return undefined
                            if (!value.trim()) return undefined
                            const r = z
                              .string()
                              .min(5, 'ФИО минимум 5 символов')
                              .max(200)
                              .safeParse(value.trim())
                            return r.success ? undefined : r.error.issues[0]?.message
                          },
                          // A3-3 AC6 / bug #2: surface superRefine error on submit attempt
                          // for contract-eligible roles (SENIOR/HR/JUNIOR/ACCOUNTANT/DROP).
                          // This fires when form.handleSubmit() is called and makes the
                          // red border + error text visible without requiring blur first.
                          onSubmit: ({ value }) => {
                            const CONTRACT_ROLES = new Set([
                              'SENIOR',
                              'HR',
                              'JUNIOR',
                              'ACCOUNTANT',
                              'DROP',
                            ])
                            if (isCreate && CONTRACT_ROLES.has(role) && !value.trim()) {
                              return 'Юридическое ФИО обязательно для этой роли'
                            }
                            return undefined
                          },
                        }}
                      >
                        {(field) => {
                          // Show error on blur/dirty OR immediately after a failed submit
                          // attempt (errors populated by onSubmit validator above).
                          const err = field.state.meta.errors[0]
                          const showError =
                            (field.state.meta.isTouched && field.state.meta.isDirty && !!err) ||
                            (field.state.meta.isSubmitted !== undefined &&
                              !field.state.meta.isValid &&
                              !!err) ||
                            (!!err && field.state.meta.isTouched)
                          return (
                            <Field
                              label="Юридическое ФИО"
                              error={showError ? err : undefined}
                              hint="Используется в MSA-контракте вместо display name. Формат: Фамилия Имя Отчество."
                            >
                              <Input
                                placeholder="Іваненко Іван Іванович"
                                value={field.state.value}
                                onChange={(e) => field.handleChange(e.target.value)}
                                onBlur={field.handleBlur}
                                aria-invalid={showError ? true : undefined}
                                className={cn(
                                  showError &&
                                    'border-destructive focus-visible:ring-destructive/30',
                                )}
                                data-testid="user-dialog-legal-full-name"
                              />
                            </Field>
                          )
                        }}
                      </form.Field>
                    </Section>
                  ) : null
                }
              </form.Subscribe>

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
                          className={cn(
                            err && 'border-destructive focus-visible:ring-destructive/30',
                          )}
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
                          const err = field.state.meta.isTouched
                            ? field.state.meta.errors[0]
                            : undefined
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
                    ) : role === 'DROP' ? (
                      <form.Field
                        name="dropSharePercent"
                        validators={{
                          onBlur: ({ value }) => {
                            if (value < 0 || value > 100) return 'Введите от 0 до 100'
                            return undefined
                          },
                        }}
                      >
                        {(field) => {
                          const val = field.state.value ?? 5
                          const err = field.state.meta.isTouched
                            ? field.state.meta.errors[0]
                            : undefined
                          return (
                            <Field
                              label="Доля дропа (%)"
                              hint="Сколько дроп оставляет себе с каждой выплаты"
                              error={err}
                              required={isCreate}
                            >
                              <ShareSlider
                                value={val}
                                onChange={(v) => field.handleChange(v)}
                                onBlur={field.handleBlur}
                                error={!!err}
                                role="DROP"
                              />
                              <p className="text-[11px] text-muted-foreground mt-1 inline-flex items-center gap-1">
                                <Percent className="h-3 w-3" />
                                По умолчанию 5%
                              </p>
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
                              {/* ut-15 + ut-24: iOS-style segmented control with a
                                sliding gold pill. Implemented via the shared
                                <SegmentedToggle> primitive (apps/web/app/components/ui/segmented-toggle.tsx)
                                so this design is consistent across the project. */}
                              <SegmentedToggle<PaymentMethod>
                                value={field.state.value}
                                onChange={(v) => field.handleChange(v)}
                                options={[
                                  { value: 'USDT_ERC20', label: 'USDT ERC-20', icon: Coins },
                                  {
                                    value: 'BANK_UAH_FOP',
                                    label: 'Bank UAH (ФОП)',
                                    icon: Landmark,
                                  },
                                ]}
                                ariaLabel="Способ оплаты"
                                layoutId="payment-method-active-pill"
                                testId="user-dialog-payment-method"
                              />
                              <p className="text-xs text-muted-foreground mt-1">
                                {field.state.value === 'USDT_ERC20'
                                  ? 'Будет использоваться адрес кошелька в сети Ethereum.'
                                  : 'Будет использоваться украинский банковский счёт ФОП.'}
                              </p>
                            </Field>
                          )}
                        </form.Field>
                      )}

                      <form.Subscribe
                        selector={(s) => (usdtOnly ? 'USDT_ERC20' : s.values.paymentMethod)}
                      >
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
                                  const showError =
                                    field.state.meta.isTouched && field.state.meta.isDirty
                                  const err = showError ? field.state.meta.errors[0] : undefined
                                  return (
                                    <Field label="USDT ERC-20 кошелёк" error={err} required>
                                      <Input
                                        placeholder="0x..."
                                        value={field.state.value}
                                        onChange={(e) => field.handleChange(e.target.value)}
                                        onBlur={field.handleBlur}
                                        autoComplete="off"
                                        className={cn(
                                          err &&
                                            'border-destructive focus-visible:ring-destructive/30',
                                        )}
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
                                  const showError =
                                    field.state.meta.isTouched && field.state.meta.isDirty
                                  const err = showError ? field.state.meta.errors[0] : undefined
                                  return (
                                    <Field label="ФИО получателя (ФОП)" error={err} required>
                                      <Input
                                        placeholder="Иванов Иван Иванович"
                                        value={field.state.value}
                                        onChange={(e) => field.handleChange(e.target.value)}
                                        onBlur={field.handleBlur}
                                        data-testid="user-dialog-bank-recipient"
                                        className={cn(
                                          err &&
                                            'border-destructive focus-visible:ring-destructive/30',
                                        )}
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
                                  const showError =
                                    field.state.meta.isTouched && field.state.meta.isDirty
                                  const err = showError ? field.state.meta.errors[0] : undefined
                                  return (
                                    <Field label="IBAN" error={err} required>
                                      <Input
                                        placeholder="UA000000000000000000000000000"
                                        value={field.state.value}
                                        onChange={(e) => field.handleChange(e.target.value)}
                                        onBlur={field.handleBlur}
                                        data-testid="user-dialog-bank-iban"
                                        className={cn(
                                          err &&
                                            'border-destructive focus-visible:ring-destructive/30',
                                        )}
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
                                  const showError =
                                    field.state.meta.isTouched && field.state.meta.isDirty
                                  const err = showError ? field.state.meta.errors[0] : undefined
                                  return (
                                    <Field label="РНОКПП (ИНН ФОП)" error={err} required>
                                      <Input
                                        placeholder="1234567890"
                                        value={field.state.value}
                                        onChange={(e) => field.handleChange(e.target.value)}
                                        onBlur={field.handleBlur}
                                        data-testid="user-dialog-bank-rnokpp"
                                        className={cn(
                                          err &&
                                            'border-destructive focus-visible:ring-destructive/30',
                                        )}
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
                  // DROP role - phase 1 fix: drop-team is provisioned
                  // atomically with the drop user via POST /api/users/drops.
                  // The team section is mandatory and identical in shape to
                  // the senior CREATE_NEW flow, minus the RadioGroup (no
                  // «join existing» option for a drop). Only renders in
                  // create-mode: editing a DROP user keeps the role lock
                  // and routes through PATCH /api/users/:id.
                  if (role === 'DROP' && isCreate) {
                    const onlyHr = hrUsers.length === 1
                    const onlyAccountant = accountantUsers.length === 1
                    return (
                      <Section title="Команда дропа">
                        <HrChipsField
                          hrUsers={hrUsers}
                          selectedIds={selectedHrIds}
                          onChange={handleHrChange}
                          required
                          onlyHr={onlyHr}
                          error={hrError}
                        />

                        <AccountantChipField
                          accountantUsers={accountantUsers}
                          selectedId={selectedAccountantId}
                          onChange={setSelectedAccountantId}
                          onlyAccountant={onlyAccountant}
                        />

                        <form.Field
                          name="teamTelegramChannelDrop"
                          validators={{
                            onBlur: ({ value, fieldApi }) => {
                              if (!fieldApi.state.meta.isDirty) return undefined
                              const trimmed = value.trim()
                              if (!trimmed) return undefined
                              return /^@?[a-zA-Z0-9_]{5,32}$/.test(trimmed)
                                ? undefined
                                : 'Некорректный канал (5–32 латинских символов или _, опц. @)'
                            },
                          }}
                        >
                          {(field) => {
                            const showError = field.state.meta.isTouched && field.state.meta.isDirty
                            const err = showError ? field.state.meta.errors[0] : undefined
                            return (
                              <Field
                                label="Telegram-канал команды"
                                error={err}
                                hint={err ? undefined : 'Опционально. Канал для общения команды.'}
                              >
                                <div className="relative">
                                  <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                                    <Send className="h-3.5 w-3.5" />
                                    t.me/
                                  </span>
                                  <Input
                                    placeholder="team_channel"
                                    className={cn(
                                      'pl-16',
                                      err && 'border-destructive focus-visible:ring-destructive/30',
                                    )}
                                    value={field.state.value}
                                    onChange={(e) => field.handleChange(e.target.value)}
                                    onBlur={field.handleBlur}
                                    autoComplete="off"
                                    data-testid="user-dialog-drop-team-telegram-channel"
                                  />
                                </div>
                              </Field>
                            )
                          }}
                        </form.Field>
                      </Section>
                    )
                  }

                  if (role === 'SENIOR') {
                    const onlyHr = hrUsers.length === 1
                    const onlyAccountant = accountantUsers.length === 1

                    return (
                      <Section title="Команда">
                        {/* Drop role - phase 1 (AC3): two-option team picker.
                          - CREATE_NEW (default): legacy senior-team flow.
                          - JOIN_DROP_TEAM: pick a vacant drop-team. HR /
                            accountant / channel sourced from that team. */}
                        {isCreate && (
                          <form.Field name="teamMode">
                            {(field) => (
                              <Field label="Тип команды" required>
                                <RadioGroup
                                  value={field.state.value}
                                  onValueChange={(v) => field.handleChange(v as TeamMode)}
                                  className="grid gap-2"
                                  data-testid="user-dialog-team-mode"
                                >
                                  <label
                                    className={cn(
                                      'flex items-start gap-2 rounded-md border px-3 py-2 text-xs cursor-pointer transition-colors',
                                      field.state.value === 'CREATE_NEW'
                                        ? 'border-primary/50 bg-primary/5'
                                        : 'border-input hover:bg-muted/40',
                                    )}
                                  >
                                    <RadioGroupItem
                                      value="CREATE_NEW"
                                      className="mt-0.5"
                                      data-testid="user-dialog-team-mode-create-new"
                                    />
                                    <div className="flex-1">
                                      <div className="font-medium inline-flex items-center gap-1">
                                        <Sparkles className="h-3 w-3" />
                                        Создать свою команду
                                      </div>
                                      <p className="text-muted-foreground mt-0.5">
                                        Новая команда синьора. Выберите состав ниже.
                                      </p>
                                    </div>
                                  </label>
                                  <label
                                    className={cn(
                                      'flex items-start gap-2 rounded-md border px-3 py-2 text-xs cursor-pointer transition-colors',
                                      field.state.value === 'JOIN_DROP_TEAM'
                                        ? 'border-primary/50 bg-primary/5'
                                        : 'border-input hover:bg-muted/40',
                                      vacantDropTeams.length === 0 && 'opacity-60',
                                    )}
                                  >
                                    <RadioGroupItem
                                      value="JOIN_DROP_TEAM"
                                      className="mt-0.5"
                                      disabled={vacantDropTeams.length === 0}
                                      data-testid="user-dialog-team-mode-join-drop"
                                    />
                                    <div className="flex-1">
                                      <div className="font-medium inline-flex items-center gap-1">
                                        <Users className="h-3 w-3" />
                                        Добавить в команду дропа
                                      </div>
                                      <p className="text-muted-foreground mt-0.5">
                                        {vacantDropTeams.length === 0
                                          ? 'Нет команд дропа без активного синьора.'
                                          : `${vacantDropTeams.length} ${
                                              vacantDropTeams.length === 1
                                                ? 'команда доступна'
                                                : 'команд(ы) доступно'
                                            }.`}
                                      </p>
                                    </div>
                                  </label>
                                </RadioGroup>
                              </Field>
                            )}
                          </form.Field>
                        )}

                        {/* CREATE_NEW branch: legacy HR / accountant / channel pickers. */}
                        <form.Subscribe selector={(s) => s.values.teamMode}>
                          {(teamMode) => {
                            // Edit mode: teamMode field doesn't apply — keep
                            // the original SENIOR edit form unchanged (renders
                            // the legacy CREATE_NEW pickers so admin can swap
                            // HR/accountant for the existing team).
                            if (isEdit || teamMode === 'CREATE_NEW')
                              return (
                                <>
                                  {/* ut-16: HR as chips + searchable add popover. */}
                                  <HrChipsField
                                    hrUsers={hrUsers}
                                    selectedIds={selectedHrIds}
                                    onChange={handleHrChange}
                                    required={isCreate}
                                    onlyHr={onlyHr}
                                    error={hrError}
                                  />

                                  {/* ut-16: Accountant as a chip in the same visual language. */}
                                  <AccountantChipField
                                    accountantUsers={accountantUsers}
                                    selectedId={selectedAccountantId}
                                    onChange={setSelectedAccountantId}
                                    onlyAccountant={onlyAccountant}
                                  />
                                </>
                              )
                            // JOIN_DROP_TEAM branch: pick the drop-team to attach to.
                            // HR/accountant are inherited from that team — no local
                            // pickers, no channel input.
                            return (
                              <form.Field
                                name="dropTeamId"
                                validators={{
                                  onBlur: ({ value, fieldApi }) => {
                                    if (!fieldApi.state.meta.isDirty) return undefined
                                    if (!value) return 'Выберите команду дропа'
                                    return undefined
                                  },
                                }}
                              >
                                {(field) => {
                                  const showError =
                                    field.state.meta.isTouched && field.state.meta.isDirty
                                  const err = showError ? field.state.meta.errors[0] : undefined
                                  return (
                                    <Field label="Команда дропа" error={err} required>
                                      {vacantDropTeams.length === 0 ? (
                                        <p className="text-xs text-muted-foreground italic">
                                          Нет команд дропа без активного синьора. Создайте дропа или
                                          выберите «Создать свою команду».
                                        </p>
                                      ) : (
                                        <Select
                                          value={field.state.value || ''}
                                          onValueChange={(v) => field.handleChange(v)}
                                        >
                                          <SelectTrigger data-testid="user-dialog-drop-team-trigger">
                                            <SelectValue placeholder="— выберите команду дропа —" />
                                          </SelectTrigger>
                                          <SelectContent>
                                            {vacantDropTeams.map((t) => {
                                              const drop = t.members.find(
                                                (m) => m.role === 'DROP' && !m.leftAt,
                                              )
                                              const hrs = t.members
                                                .filter((m) => m.role === 'HR' && !m.leftAt)
                                                .map((m) => m.displayName)
                                                .join(', ')
                                              return (
                                                <SelectItem key={t.id} value={t.id}>
                                                  <div className="flex flex-col items-start">
                                                    <span className="font-medium">{t.name}</span>
                                                    <span className="text-[10px] text-muted-foreground">
                                                      {drop?.displayName ?? 'Дроп не назначен'}
                                                      {hrs ? ` · HR: ${hrs}` : ''}
                                                    </span>
                                                  </div>
                                                </SelectItem>
                                              )
                                            })}
                                          </SelectContent>
                                        </Select>
                                      )}
                                    </Field>
                                  )
                                }}
                              </form.Field>
                            )
                          }}
                        </form.Subscribe>

                        {/* ut-17: optional team Telegram channel.
                          Hidden when joining an existing drop-team (channel
                          inherited from that team). */}
                        <form.Subscribe selector={(s) => s.values.teamMode}>
                          {(teamMode) =>
                            isEdit || teamMode === 'CREATE_NEW' ? (
                              <form.Field
                                name="teamTelegramChannel"
                                validators={{
                                  onBlur: ({ value, fieldApi }) => {
                                    if (!fieldApi.state.meta.isDirty) return undefined
                                    const trimmed = value.trim()
                                    if (!trimmed) return undefined
                                    return /^@?[a-zA-Z0-9_]{5,32}$/.test(trimmed)
                                      ? undefined
                                      : 'Некорректный канал (5–32 латинских символов или _, опц. @)'
                                  },
                                }}
                              >
                                {(field) => {
                                  const showError =
                                    field.state.meta.isTouched && field.state.meta.isDirty
                                  const err = showError ? field.state.meta.errors[0] : undefined
                                  return (
                                    <Field
                                      label="Telegram-канал команды"
                                      error={err}
                                      hint={
                                        err ? undefined : 'Опционально. Канал для общения команды.'
                                      }
                                    >
                                      <div className="relative">
                                        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 text-xs text-muted-foreground">
                                          <Send className="h-3.5 w-3.5" />
                                          t.me/
                                        </span>
                                        <Input
                                          placeholder="team_channel"
                                          className={cn(
                                            'pl-16',
                                            err &&
                                              'border-destructive focus-visible:ring-destructive/30',
                                          )}
                                          value={field.state.value}
                                          onChange={(e) => field.handleChange(e.target.value)}
                                          onBlur={field.handleBlur}
                                          autoComplete="off"
                                          data-testid="user-dialog-team-telegram-channel"
                                        />
                                      </div>
                                    </Field>
                                  )
                                }}
                              </form.Field>
                            ) : null
                          }
                        </form.Subscribe>
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
                            <div
                              className="flex flex-wrap gap-1"
                              data-testid="user-dialog-junior-projects"
                            >
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
            {/* end step-1 form grid */}
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
              {/* Wizard step 1: «Далее» instead of «Создать» in create mode */}
              {isCreate && currentStep === 1 ? (
                <Button
                  onClick={() => void form.handleSubmit()}
                  disabled={isPending}
                  data-testid="wizard-next-btn"
                >
                  {createMutation.isPending ? (
                    'Создание...'
                  ) : (
                    <span className="inline-flex items-center gap-1.5">
                      Далее
                      <ArrowRight className="h-3.5 w-3.5" />
                    </span>
                  )}
                </Button>
              ) : isCreate && currentStep === 2 ? (
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setCurrentStep(1)}
                    data-testid="wizard-back-btn"
                  >
                    <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
                    Назад
                  </Button>
                  <Button onClick={() => setCurrentStep(3)} data-testid="wizard-step2-next-btn">
                    <span className="inline-flex items-center gap-1.5">
                      Далее
                      <ArrowRight className="h-3.5 w-3.5" />
                    </span>
                  </Button>
                </div>
              ) : !isCreate ? (
                <Button
                  onClick={() => void form.handleSubmit()}
                  disabled={isPending}
                  data-testid="user-dialog-submit"
                >
                  {submitLabel}
                </Button>
              ) : null}
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
                <strong>{editingUser?.displayName}</strong>. Убедись, что пользователь знает и
                сменит свой Google account при необходимости.
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

// ── Wizard sub-components (create-mode only) ────────────────────────────────

interface WizardStep2Props {
  userId: string
  onHasContract: (has: boolean) => void
  body: string
  onBodyChange: (v: string) => void
  isDirty: boolean
  showHint: boolean
  onToggleHint: () => void
}

/**
 * Step 2 of the create wizard: contract editor on the freshly-created user.
 * Lazy-loads the A3-2 ContractEditor + uses useEmployeeContract for DRAFT lazy-create.
 * Renders a skippable empty-state when no active template (404).
 */
function WizardStep2({
  userId,
  onHasContract,
  body,
  onBodyChange,
  isDirty,
  showHint,
  onToggleHint,
}: WizardStep2Props) {
  const { data: contract, isLoading, error } = useEmployeeContract(userId)
  const saveBody = useSaveContractBody(userId)

  // Sync contract body into local state on first load.
  // deps intentionally limited to contract?.id — we only want to seed the
  // local body once per contract identity (not on every render where body
  // or the stable callbacks change). Adding body/onBodyChange/onHasContract
  // would re-seed on every keystroke and clobber in-progress edits.
  // (react-hooks/exhaustive-deps is not configured in this project's eslint)
  useEffect(() => {
    if (contract && body === '') {
      onBodyChange(contract.bodyMarkdown ?? '')
      onHasContract(true)
    }
  }, [contract?.id])

  // Notify parent whether we have a contract
  useEffect(() => {
    if (contract) onHasContract(true)
    else if (error) onHasContract(false)
  }, [contract, error])

  const handleSave = () => {
    saveBody.mutate(body)
  }

  // No active template → 404 empty state (step is skippable)
  const isNoTemplate =
    error &&
    ((error as { response?: { status?: number } })?.response?.status === 404 ||
      String((error as Error).message).includes('template'))

  return (
    <div className="py-2 flex flex-col gap-4" data-testid="wizard-contract-step">
      {isLoading && (
        <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
          Загружаем контракт...
        </div>
      )}

      {isNoTemplate && !isLoading && (
        <div className="rounded-lg border border-dashed border-border bg-muted/30 px-4 py-6 text-center">
          <FileText className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm font-medium text-muted-foreground">Нет активного шаблона</p>
          <p className="mt-1 text-xs text-muted-foreground/70">
            Контракт можно создать позже из профиля пользователя.
            <br />
            Нажмите «Далее» чтобы продолжить без контракта.
          </p>
        </div>
      )}

      {contract && !isLoading && (
        <>
          <ContractEditor
            value={body || contract.bodyMarkdown}
            onChange={onBodyChange}
            readOnly={contract.status !== 'DRAFT'}
            {...(contract.status === 'READY_TO_SIGN'
              ? { frozenBanner: 'Контракт передан на подпись — редактирование заблокировано.' }
              : {})}
            showHint={showHint}
            onToggleHint={onToggleHint}
          />
          <ContractActionBar
            status={contract.status}
            isDirty={isDirty}
            isSaving={saveBody.isPending}
            onSave={handleSave}
            onMarkReady={() => {
              /* handled in step 3 */
            }}
            onReset={() => {
              /* handled via profile tab */
            }}
            onRevert={() => {
              /* handled via profile tab */
            }}
          />
        </>
      )}
    </div>
  )
}

interface WizardStep3Props {
  hasContract: boolean
  onSaveDraft: () => void
  onMarkReady: () => void
  isMarkingReady: boolean
  onBack: () => void
}

/**
 * Step 3 of the create wizard: confirmation summary + finalize buttons.
 * «Сохранить как черновик» → close (contract stays DRAFT, already saved).
 * «Сохранить и отметить готовым» → POST /ready → close.
 * Ready button disabled when no contract (no-template path).
 */
function WizardStep3({
  hasContract,
  onSaveDraft,
  onMarkReady,
  isMarkingReady,
  onBack,
}: WizardStep3Props) {
  return (
    <div className="py-4 flex flex-col gap-6" data-testid="wizard-confirm-step">
      {/* Summary */}
      <div className="rounded-lg border border-border/60 bg-muted/30 p-4 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-primary shrink-0" />
          <p className="text-sm font-medium">Пользователь создан</p>
        </div>
        <p className="text-xs text-muted-foreground pl-7">
          {hasContract
            ? 'Контракт сохранён как черновик. Вы можете отметить его готовым к подписанию.'
            : 'Контракт не создан (нет активного шаблона для роли). Его можно добавить позже через профиль пользователя.'}
        </p>
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between gap-2">
        <Button variant="outline" onClick={onBack} data-testid="wizard-step3-back-btn">
          <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
          Назад
        </Button>

        <div className="flex gap-2">
          <Button variant="secondary" onClick={onSaveDraft} data-testid="wizard-save-draft-btn">
            Сохранить как черновик
          </Button>
          <Button
            onClick={onMarkReady}
            disabled={!hasContract || isMarkingReady}
            data-testid="wizard-mark-ready-btn"
          >
            {isMarkingReady ? 'Отправка...' : 'Сохранить и отметить готовым к подписи'}
          </Button>
        </div>
      </div>
    </div>
  )
}
