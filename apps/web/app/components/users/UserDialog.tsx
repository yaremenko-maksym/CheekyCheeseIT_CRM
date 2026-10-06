import { Link } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useQueryClient } from '@tanstack/react-query'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { Coins, Landmark, Pencil, Send, UserPlus, Users, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Value as PhoneValue } from 'react-phone-number-input'
import type {
  AdminUpdateUserDto,
  CreateDropDto,
  CreateUserDto,
  Locale,
  PaymentMethod,
  TeamMode,
  UserProfileDto,
} from '@crm/shared'
import { adminUpdateUserSchema, createDropSchema, createUserSchema } from '@crm/shared'
import { toast } from 'sonner'
import { useAuth } from '@/context/auth'
import { Badge } from '@/components/ui/badge'
import {
  CrmDialogBody,
  CrmDialogContent,
  CrmDialogHeader,
  Dialog,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/crm-dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { type Currency } from '@/components/ui/amount-currency-input'
import { SegmentedToggle } from '@/components/ui/segmented-toggle'
import { translateZodCode, translateZodMessage } from '@/lib/axios-utils'
import { cn, parseStrictAmount } from '@/lib/utils'
import { CreateWizardStepper } from './CreateWizardStepper'
import { type Role, normalizeTelegram } from './constants'
import { Field, Section } from './section'
import { ROLE_LABEL_MESSAGES } from '@/components/ui/role-select'
import { HrChipsField } from './HrChipsField'
import { AccountantChipField } from './AccountantChipField'
import { WizardStep2 } from './user-dialog/WizardStep2'
import { WizardStep3 } from './user-dialog/WizardStep3'
import { ContactsSection } from './user-dialog/ContactsSection'
import { FinanceSection } from './user-dialog/FinanceSection'
import { IdentitySection } from './user-dialog/IdentitySection'
import { TechStackSection } from './user-dialog/TechStackSection'
import { ContractDataSection } from './user-dialog/ContractDataSection'
import { EmailChangeWarningDialog } from './user-dialog/EmailChangeWarningDialog'
import { UserDialogFooter } from './user-dialog/UserDialogFooter'
import { useCreateWizard } from './user-dialog/useCreateWizard'
import { useUserDialogMutations } from './user-dialog/useUserDialogMutations'
import { useEditingUser } from './user-dialog/useEditingUser'
import { useUserDialogData } from './user-dialog/useUserDialogData'
import { useTeamSelection } from './user-dialog/useTeamSelection'

// Re-exported so existing test imports from '../UserDialog' keep resolving.
export { WizardStep2 }
import {
  defaultPaymentMethod,
  ibanPattern,
  rnokppPattern,
  toUsd,
  usdtWalletPattern,
} from './user-dialog/validation'

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
  const { t, i18n } = useLingui()
  const queryClient = useQueryClient()
  const { user: me } = useAuth()
  const isCreate = props.mode === 'create'
  const isEdit = props.mode === 'edit'
  const open = isCreate ? props.open : !!props.user
  const listUser = isEdit ? props.user : null

  const { editingUser, fullProfileLoadedId } = useEditingUser({ isEdit, open, listUser })

  const hrOnly = isCreate ? !!props.hrOnly : false

  // ── Wizard state (create-mode only) ─────────────────────────────────────
  const {
    currentStep,
    setCurrentStep,
    createdUserId,
    setCreatedUserId,
    hasContract,
    setHasContract,
    wizardContractBody,
    setWizardContractBody,
    wizardContractDirty,
    setWizardContractDirty,
    handleWizardSaveDraft,
  } = useCreateWizard({
    isCreate,
    open,
    queryClient,
    onClose: props.onClose,
    draftSavedMessage: t`Користувача створено, контракт збережено як чернетку`,
  })

  // ut-11: SENIOR/ADMIN locked for self-ADMIN edit. We compute it once and
  // reuse in the Role select + footer hint.
  const isSelfAdminEdit =
    isEdit && !!editingUser && !!me && editingUser.id === me.id && editingUser.role === 'ADMIN'

  // ── Auxiliary data: HR / Accountant / project / team queries + derived lists ──
  const {
    exchangeRates,
    allTeams,
    hrUsers,
    accountantUsers,
    vacantDropTeams,
    juniorActiveProjects,
    availableJuniorProjects,
  } = useUserDialogData({ open, isCreate, isEdit, editingUser })

  // ── Mutations ────────────────────────────────────────────────────────────
  const {
    createMutation,
    createDropMutation,
    wizardUpdateMutation,
    markReadyMutation,
    updateMutation,
  } = useUserDialogMutations({
    queryClient,
    createdUserId,
    setCreatedUserId,
    setCurrentStep,
    setHasContract,
    editingUser,
    onClose: props.onClose,
  })

  // ── Form ─────────────────────────────────────────────────────────────────
  const initialRole: Role = (editingUser?.role as Role) ?? (hrOnly ? 'SENIOR' : 'JUNIOR')
  const initialPaymentMethod: PaymentMethod =
    (editingUser?.paymentMethod as PaymentMethod | null) ?? defaultPaymentMethod(initialRole)

  const form = useForm({
    defaultValues: {
      email: editingUser?.email ?? '',
      // §4.4 — ADMIN-entered at creation only (no edit-mode default: the
      // spec's decision 7 restricts this field to the create flow).
      personalEmail: '',
      displayName: editingUser?.displayName ?? '',
      role: initialRole,
      // task-i18n-stage2 (Task 3, Step 6) — create-wizard-only field (this
      // dialog's Edit mode never sends it: `adminUpdateUserSchema` has no
      // `locale`, matching the profile-view/create-wizard scope decision
      // recorded in `users.service.ts`'s `FilteredUser` comment). Default
      // 'uk' matches `createUserSchema`'s own server-side default.
      locale: 'uk' as Locale,
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
      // ФОП юридические данные для контракта
      registrationAddress: editingUser?.registrationAddress ?? '',
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
        const num = parseStrictAmount(raw)
        if (!isFinite(num) || num < 0) return null
        if (!exchangeRates) return num // shouldn't happen — query enabled on open
        return Number(toUsd(num, value.salaryCurrency, exchangeRates).toFixed(2))
      }

      if (isCreate && isDrop) {
        // DROP creation hits the dedicated endpoint which atomically
        // provisions both the user and the drop-team. HR is mandatory (≥1);
        // the accountant picker is OPTIONAL (a workspace may have 0
        // accountants — a drop-team is valid without one, same as a senior
        // team). We surface an inline error under the HR multiselect AND a
        // field-specific toast so the user sees *which* field blocked submit
        // even if their eyes are off the form.
        if (hrIds.length === 0) {
          setHrError(translateZodCode('HR_REQUIRED_MIN'))
          toast.error(translateZodCode('HR_REQUIRED_MIN'))
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
          accountantId: accountantId || null,
          telegramChannel: normalizedChannel,
          // Данные для контракта — DROP still gets an MSA contract (owner
          // decision). legalFullName is REQUIRED (schema + UI validator);
          // registrationAddress is optional. Previously omitted from this
          // branch → the admin's input was silently lost (legal_full_name=null).
          ...(value.legalFullName.trim() && {
            legalFullName: value.legalFullName.trim(),
          }),
          ...(value.registrationAddress.trim() && {
            registrationAddress: value.registrationAddress.trim(),
          }),
        }
        const result = createDropSchema.safeParse(payload)
        if (!result.success) {
          const first = result.error.issues[0]
          toast.error(
            // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse — see this file's other field validators for the same invariant
            translateZodMessage(first?.message) ?? translateZodCode('VALIDATION_FAILED_FORM'),
          )
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
            ...(value.registrationAddress.trim() && {
              registrationAddress: value.registrationAddress.trim(),
            }),
          }
          const updateResult = adminUpdateUserSchema.safeParse(updatePayload)
          if (!updateResult.success) {
            const first = updateResult.error.issues[0]
            toast.error(
              // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse — see this file's other field validators for the same invariant
              translateZodMessage(first?.message) ?? translateZodCode('VALIDATION_FAILED_FORM'),
            )
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
          // Toast names the field so the user knows what blocked submit.
          setHrError(translateZodCode('HR_REQUIRED_MIN'))
          toast.error(translateZodCode('HR_REQUIRED_MIN'))
          return
        }
        if (isJoinDropTeam && !value.dropTeamId) {
          toast.error(translateZodCode('DROP_TEAM_ID_REQUIRED'))
          return
        }

        // Build payment-requisites slice. SENIOR/ADMIN are USDT-only; other
        // roles use whatever the form's `paymentMethod` field says.
        const paymentMethod: PaymentMethod =
          isSenior || value.role === 'ADMIN' ? 'USDT_ERC20' : value.paymentMethod

        const payload: CreateUserDto = {
          email: value.email.trim(),
          // §4.4 — optional, ADMIN-entered at creation only. Both `.trim()`
          // calls are defensive-only for `type="email"`: the HTML value
          // sanitization algorithm for the email state (WHATWG HTML §4.10.5.1.4)
          // strips leading/trailing whitespace before `onChange` ever sees the
          // value — confirmed empirically in jsdom, and it is spec behavior,
          // not a jsdom quirk, so real browsers behave the same. No typed
          // input can make `value.personalEmail` differ from its own
          // `.trim()`, so no interaction test can distinguish either call
          // being dropped. Kept for the same reason `email.trim()` above is
          // kept: defense if this value is ever populated from something
          // other than typing into this input (e.g. a future paste-from-
          // clipboard-object path, or a programmatic `setFieldValue`).
          // Stryker disable next-line MethodExpression: see the paragraph above — unreachable via any typed input on a type="email" field
          ...(value.personalEmail.trim() && { personalEmail: value.personalEmail.trim() }),
          displayName: value.displayName.trim(),
          role: value.role,
          telegram: value.telegram.trim() ? normalizeTelegram(value.telegram) : undefined,
          phone: (value.phone as string) || undefined,
          techStack: value.techStack.length > 0 ? value.techStack : undefined,
          // task-i18n-stage2 (Task 3, Step 6) — interface language picked in
          // the "Данные" step below.
          locale: value.locale,
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
          ...(value.registrationAddress.trim() && {
            registrationAddress: value.registrationAddress.trim(),
          }),
        }
        const result = createUserSchema.safeParse(payload)
        if (!result.success) {
          // Surface the first issue inline + as a single toast — the form
          // fields keep their own per-field error indicators below.
          const first = result.error.issues[0]
          toast.error(
            // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse — see this file's other field validators for the same invariant
            translateZodMessage(first?.message) ?? translateZodCode('VALIDATION_FAILED_FORM'),
          )
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

        // task-648-fix-round-2 (SR-M-5): see the payload comment below. Same
        // `!!editingUser &&` shape as `paymentChanged` directly above — with
        // no server snapshot to compare against there is no evidence the
        // operator changed anything, so the field stays off the wire.
        // `seniorSharePercent` is a non-nullable `number` on `UserProfileDto`,
        // so no `?? 26` fallback: it would be unreachable.
        const shareChanged =
          !!editingUser && value.seniorSharePercent !== editingUser.seniorSharePercent

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
          // task-648-fix-round-2 (SR-M-5 / QA-HIGH-3): the share % goes on
          // the wire ONLY when the operator actually moved it. It used to be
          // included on every save of a SENIOR — so an admin editing a phone
          // number sent `seniorSharePercent` too, and the backend's
          // "requested == active" branch (removed this round) read that as an
          // explicit "cancel the live proposal". Manual QA reproduced the
          // full path: one phone edit, `PENDING → CANCELLED`, no signal.
          // Same rule the project form has always used (`overrideChanged` in
          // `$projectId.tsx`): compare against the SERVER snapshot, not
          // against the form's own initial value, so a value typed and typed
          // back also counts as unchanged.
          ...(isSenior && {
            ...(shareChanged && { seniorSharePercent: value.seniorSharePercent }),
            hrIds,
            accountantId: accountantId || null,
            teamTelegramChannel: normalizedTeamChannel,
          }),
          // Prod bug fix: DROP's «Доля дропа (%)» edit was silently dropped —
          // this branch was missing entirely, unlike the isSenior one above.
          // The field renders and submits fine, but nothing carried the new
          // value to the PATCH body, so admin edits never persisted.
          ...(isDrop && {
            dropSharePercent: value.dropSharePercent,
          }),
          // DROP has no salary field in the finance section (Section 4 renders
          // SENIOR-slider / DROP-slider / salary-field, mutually exclusive) —
          // exclude it here so the payload doesn't re-send/clamp salaryCurrency
          // for a role that never had a salary to begin with.
          ...(!isSenior &&
            value.role !== 'DROP' && {
              monthlySalary: value.monthlySalary ? computeMonthlySalaryUsd() : null,
              salaryCurrency: 'USD',
            }),
          // Contract data — legal full name for MSA contract. Empty string → omit
          // (backend treats absence as "no change").
          ...(value.legalFullName.trim() && {
            legalFullName: value.legalFullName.trim(),
          }),
          // ФОП юридические данные — передаём null при очистке поля.
          registrationAddress: value.registrationAddress.trim() || null,
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
          toast.error(
            // Stryker disable next-line OptionalChaining: issues[0] is guaranteed non-null on a failed safeParse — see this file's other field validators for the same invariant
            translateZodMessage(first?.message) ?? translateZodCode('VALIDATION_FAILED_FORM'),
          )
          return
        }
        updateMutation.mutate(result.data)
      }
    },
  })

  // ── Team selection (SENIOR/DROP HR + Accountant) ─────────────────────────
  // Must stay after `useUserDialogData` (reads its lists) and `useForm` (takes `form`).
  const {
    selectedHrIds,
    selectedAccountantId,
    setSelectedAccountantId,
    hrError,
    setHrError,
    handleHrChange,
    selectedHrIdsRef,
    selectedAccountantIdRef,
  } = useTeamSelection(form, {
    editingUser,
    allTeams,
    hrUsers,
    accountantUsers,
    isCreate,
    isEdit,
    open,
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
        // §4.4 — create-only field, always blank on re-seed for Edit mode.
        // This instance is mounted with `mode="edit"` HARDCODED at its call
        // site (routes/_authenticated/users/index.tsx renders a SEPARATE
        // `<UserDialog mode="create" .../>` for creation) — `isCreate` is
        // therefore always false for the lifetime of this component, the
        // personalEmail `form.Field` above is gated on `isCreate &&` and so
        // never renders here, and the only reader of `value.personalEmail`
        // is the CREATE submit handler's payload builder, which this
        // instance's onSubmit branch never reaches either. The VALUE here
        // cannot become observable through any path — kept only because
        // `form.reset()`'s argument is the full form-values shape.
        // Stryker disable next-line StringLiteral: see the paragraph above — unobservable in this mode-locked instance
        personalEmail: '',
        // task-i18n-stage2 (Task 3, Step 6) — same reasoning as
        // `personalEmail` immediately above: create-wizard-only field, the
        // `locale` `form.Field` is gated on `isCreate &&` and this
        // mode="edit"-locked instance's onSubmit branch never reads
        // `value.locale`. Kept only because `form.reset()`'s argument is
        // the full form-values shape.
        locale: 'uk' as Locale,
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
        registrationAddress: editingUser.registrationAddress ?? '',
      })
    }
    // Re-seed when the edited user changes AND when the full profile finishes
    // loading (slim list → full /:id). `fullProfileLoadedId` flips from null to
    // the user id once GET /api/users/:id resolves, so the requisite / salary /
    // FOP-PII fields (absent from the slim list) get prefilled into the form.
    // `form` is stable and intentionally excluded (re-running on every form
    // change would clobber edits in progress).
  }, [editingUser?.id, isEdit, fullProfileLoadedId])

  const handleClose = () => {
    if (isCreate) {
      form.reset()
      setCurrentStep(1)
      setCreatedUserId(null)
      setHasContract(false)
    }
    props.onClose()
  }

  const isPending =
    createMutation.isPending ||
    updateMutation.isPending ||
    createDropMutation.isPending ||
    wizardUpdateMutation.isPending ||
    markReadyMutation.isPending
  const submitLabel = isCreate
    ? createMutation.isPending || createDropMutation.isPending
      ? t`Створюємо…`
      : // Stryker disable next-line StringLiteral: unreachable in the DOM — `submitLabel` is only ever rendered by the `user-dialog-submit` button in the `!isCreate` footer branch below (create mode shows the wizard's own step buttons instead), so this half of the ternary is computed every create-mode render but never inserted anywhere a test (or a user) can observe.
        t`Створити`
    : updateMutation.isPending
      ? t`Зберігаємо…`
      : t`Зберегти`

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
                  <Trans>Новий користувач</Trans>
                </>
              ) : (
                <>
                  <Pencil className="h-4 w-4" />
                  <Trans>Редагувати користувача</Trans>
                </>
              )}
            </DialogTitle>
            <DialogDescription className="sr-only">
              <Trans>Створення або редагування користувача</Trans>
            </DialogDescription>
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
              <IdentitySection
                form={form}
                isCreate={isCreate}
                isEdit={isEdit}
                editingUser={editingUser}
                hrOnly={hrOnly}
                isSelfAdminEdit={isSelfAdminEdit}
                originalEmail={originalEmail}
                onEmailChangeIntent={setPendingEmailChange}
              />

              {/* ── Section 1.5: Contract data (non-ADMIN only) ─────────── */}
              <ContractDataSection form={form} isCreate={isCreate} />

              {/* ── Section 2: Contacts ─────────────────────────────────── */}
              <ContactsSection form={form} />

              {/* ── Section 3: Profession (Tech stack) ──────────────────── */}
              <TechStackSection form={form} />

              {/* ── Section 4: Finance ──────────────────────────────────── */}
              <FinanceSection form={form} isCreate={isCreate} editingUser={editingUser} />

              {/* ── Section 5: Payment requisites (ut-14) ───────────────── */}
              <form.Subscribe selector={(s) => s.values.role}>
                {(role) => {
                  const usdtOnly = role === 'SENIOR' || role === 'ADMIN'
                  const roleLabel = i18n._(ROLE_LABEL_MESSAGES[role])
                  return (
                    <Section title={t`Реквізити для виплат`}>
                      {usdtOnly ? (
                        <p className="text-xs text-muted-foreground">
                          <Trans>Для ролі «{roleLabel}» доступні лише виплати в USDT ERC-20.</Trans>
                        </p>
                      ) : (
                        <form.Field name="paymentMethod">
                          {(field) => (
                            <Field label={t`Спосіб виплати`} required>
                              {/* ut-15 + ut-24: iOS-style segmented control with a
                                sliding gold pill. Implemented via the shared
                                <SegmentedToggle> primitive (apps/web/app/components/ui/segmented-toggle.tsx)
                                so this design is consistent across the project. */}
                              <SegmentedToggle<PaymentMethod>
                                value={field.state.value}
                                onChange={(v) => field.handleChange(v)}
                                options={[
                                  { value: 'USDT_ERC20', label: t`USDT ERC-20`, icon: Coins },
                                  {
                                    value: 'BANK_UAH_FOP',
                                    label: t`ФОП (UAH)`,
                                    icon: Landmark,
                                  },
                                ]}
                                ariaLabel={t`Спосіб виплати`}
                                layoutId="payment-method-active-pill"
                                testId="user-dialog-payment-method"
                              />
                              <p className="text-xs text-muted-foreground mt-1">
                                {field.state.value === 'USDT_ERC20' ? (
                                  <Trans>
                                    Використовуватиметься адреса гаманця в мережі Ethereum.
                                  </Trans>
                                ) : (
                                  <Trans>
                                    Використовуватиметься український банківський рахунок ФОП.
                                  </Trans>
                                )}
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
                                    if (!value.trim())
                                      return translateZodCode('USDT_WALLET_REQUIRED')
                                    return usdtWalletPattern.test(value.trim())
                                      ? undefined
                                      : translateZodCode('USDT_ADDRESS_FORMAT')
                                  },
                                }}
                              >
                                {(field) => {
                                  const showError =
                                    field.state.meta.isTouched && field.state.meta.isDirty
                                  const err = showError ? field.state.meta.errors[0] : undefined
                                  return (
                                    <Field label={t`Гаманець USDT (ERC-20)`} error={err} required>
                                      <Input
                                        placeholder="0x..."
                                        value={field.state.value}
                                        onChange={(e) => field.handleChange(e.target.value)}
                                        onBlur={field.handleBlur}
                                        autoComplete="off"
                                        autoCapitalize="off"
                                        autoCorrect="off"
                                        spellCheck={false}
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
                                  <Field label={t`Мітка гаманця (необов’язково)`}>
                                    <Input
                                      placeholder={t`наприклад: основний`}
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
                                      : translateZodCode('RECIPIENT_NAME_MIN')
                                  },
                                }}
                              >
                                {(field) => {
                                  const showError =
                                    field.state.meta.isTouched && field.state.meta.isDirty
                                  const err = showError ? field.state.meta.errors[0] : undefined
                                  return (
                                    <Field label={t`ПІБ отримувача (ФОП)`} error={err} required>
                                      <Input
                                        placeholder={t`Іваненко Іван Іванович`}
                                        value={field.state.value}
                                        onChange={(e) => field.handleChange(e.target.value)}
                                        onBlur={field.handleBlur}
                                        autoCapitalize="words"
                                        autoComplete="off"
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
                                      : translateZodCode('IBAN_FORMAT')
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
                                        autoCapitalize="characters"
                                        autoCorrect="off"
                                        spellCheck={false}
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
                                      : translateZodCode('RNOKPP_FORMAT')
                                  },
                                }}
                              >
                                {(field) => {
                                  const showError =
                                    field.state.meta.isTouched && field.state.meta.isDirty
                                  const err = showError ? field.state.meta.errors[0] : undefined
                                  return (
                                    <Field label={t`РНОКПП`} error={err} required>
                                      <Input
                                        placeholder="1234567890"
                                        value={field.state.value}
                                        onChange={(e) => field.handleChange(e.target.value)}
                                        onBlur={field.handleBlur}
                                        inputMode="numeric"
                                        pattern="[0-9]*"
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
                                  <Field label={t`Банк (необов’язково)`}>
                                    <Input
                                      placeholder={t`ПриватБанк`}
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
                      <Section title={t`Команда дропа`}>
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
                                : translateZodCode('TELEGRAM_CHANNEL_FORMAT')
                            },
                          }}
                        >
                          {(field) => {
                            const showError = field.state.meta.isTouched && field.state.meta.isDirty
                            const err = showError ? field.state.meta.errors[0] : undefined
                            return (
                              <Field
                                label={t`Telegram-канал команди`}
                                error={err}
                                hint={
                                  err ? undefined : t`Необов’язково. Канал для спілкування команди.`
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
                                      err && 'border-destructive focus-visible:ring-destructive/30',
                                    )}
                                    value={field.state.value}
                                    onChange={(e) => field.handleChange(e.target.value)}
                                    onBlur={field.handleBlur}
                                    autoComplete="off"
                                    autoCapitalize="off"
                                    autoCorrect="off"
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
                      <Section title={t`Команда`}>
                        {/* Drop role - phase 1 (AC3): two-option team picker.
                          - CREATE_NEW (default): legacy senior-team flow.
                          - JOIN_DROP_TEAM: pick a vacant drop-team. HR /
                            accountant / channel sourced from that team. */}
                        {isCreate && (
                          <form.Field name="teamMode">
                            {(field) => (
                              <Field label={t`Тип команди`} required>
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
                                        <Trans>Створити свою команду</Trans>
                                      </div>
                                      <p className="text-muted-foreground mt-0.5">
                                        <Trans>Нова команда сеньйора. Оберіть склад нижче.</Trans>
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
                                        <Trans>Додати до команди дропа</Trans>
                                      </div>
                                      <p className="text-muted-foreground mt-0.5">
                                        {vacantDropTeams.length === 0 ? (
                                          <Trans>Немає команд дропа без активного сеньйора.</Trans>
                                        ) : (
                                          <Plural
                                            value={vacantDropTeams.length}
                                            one="# команда доступна."
                                            few="# команди доступні."
                                            many="# команд доступно."
                                            other="# команди доступно."
                                          />
                                        )}
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
                                    if (!value) return translateZodCode('DROP_TEAM_ID_REQUIRED')
                                    return undefined
                                  },
                                }}
                              >
                                {(field) => {
                                  const showError =
                                    field.state.meta.isTouched && field.state.meta.isDirty
                                  const err = showError ? field.state.meta.errors[0] : undefined
                                  return (
                                    <Field label={t`Команда дропа`} error={err} required>
                                      {vacantDropTeams.length === 0 ? (
                                        <p className="text-xs text-muted-foreground italic">
                                          <Trans>
                                            Немає команд дропа без активного сеньйора. Створіть
                                            дропа або оберіть «Створити свою команду».
                                          </Trans>
                                        </p>
                                      ) : (
                                        <Select
                                          value={field.state.value || ''}
                                          onValueChange={(v) => field.handleChange(v)}
                                        >
                                          <SelectTrigger data-testid="user-dialog-drop-team-trigger">
                                            <SelectValue
                                              placeholder={t`— оберіть команду дропа —`}
                                            />
                                          </SelectTrigger>
                                          <SelectContent>
                                            {vacantDropTeams.map((team) => {
                                              const drop = team.members.find(
                                                (m) => m.role === 'DROP' && !m.leftAt,
                                              )
                                              const hrs = team.members
                                                .filter((m) => m.role === 'HR' && !m.leftAt)
                                                .map((m) => m.displayName)
                                                .join(', ')
                                              return (
                                                <SelectItem key={team.id} value={team.id}>
                                                  <div className="flex flex-col items-start">
                                                    <span className="font-medium">{team.name}</span>
                                                    <span className="text-[10px] text-muted-foreground">
                                                      {drop?.displayName ?? t`Дропа не призначено`}
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
                                      : translateZodCode('TELEGRAM_CHANNEL_FORMAT')
                                  },
                                }}
                              >
                                {(field) => {
                                  const showError =
                                    field.state.meta.isTouched && field.state.meta.isDirty
                                  const err = showError ? field.state.meta.errors[0] : undefined
                                  return (
                                    <Field
                                      label={t`Telegram-канал команди`}
                                      error={err}
                                      hint={
                                        err
                                          ? undefined
                                          : t`Необов’язково. Канал для спілкування команди.`
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
                                          autoCapitalize="off"
                                          autoCorrect="off"
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
                        <Section title={t`Команда`}>
                          <form.Field name="projectId">
                            {(field) => (
                              <Field
                                label={t`Проєкт`}
                                hint={t`Можна прикріпити пізніше в розділі «Проєкти»`}
                              >
                                {availableJuniorProjects.length === 0 ? (
                                  <p className="text-xs text-muted-foreground italic">
                                    <Trans>Немає проєктів без активного джуніора</Trans>
                                  </p>
                                ) : (
                                  <Select
                                    value={field.state.value || 'none'}
                                    onValueChange={(v) => field.handleChange(v === 'none' ? '' : v)}
                                  >
                                    <SelectTrigger>
                                      <SelectValue placeholder={t`— не обрано —`} />
                                    </SelectTrigger>
                                    <SelectContent>
                                      <SelectItem value="none">{t`— не обрано —`}</SelectItem>
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
                      <Section title={t`Команда`}>
                        <Field label={t`Активні проєкти`}>
                          {juniorActiveProjects.length === 0 ? (
                            <p className="text-xs text-muted-foreground italic">
                              <Trans>Немає активних проєктів</Trans>
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
                            to="/projects"
                            className="text-xs text-primary hover:underline mt-1 inline-block"
                            onClick={() => props.onClose()}
                          >
                            <Trans>Керувати в розділі «Проєкти» →</Trans>
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

          <UserDialogFooter
            form={form}
            isCreate={isCreate}
            currentStep={currentStep}
            setCurrentStep={setCurrentStep}
            isPending={isPending}
            submitLabel={submitLabel}
            createPending={createMutation.isPending}
            onClose={handleClose}
          />
        </CrmDialogContent>
      </Dialog>

      {/* ut-9: Email change warning. Confirms or reverts the email field. */}
      <EmailChangeWarningDialog
        pendingEmailChange={pendingEmailChange}
        editingUser={editingUser}
        originalEmail={originalEmail}
        onCancel={() => {
          form.setFieldValue('email', originalEmail)
          setPendingEmailChange(null)
        }}
        // Stryker disable next-line ArrowFunction: equivalent mutant — Radix AlertDialogAction also fires onOpenChange(false), whose onDismiss clears the same state, so no assertion can tell a no-op onConfirm apart (kept verbatim from the pre-extraction handler)
        onConfirm={() => setPendingEmailChange(null)}
        onDismiss={() => setPendingEmailChange(null)}
      />
    </>
  )
}
