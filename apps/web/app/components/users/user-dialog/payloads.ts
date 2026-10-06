import type {
  AdminUpdateUserDto,
  CreateDropDto,
  CreateUserDto,
  Locale,
  PaymentMethod,
  TeamMode,
  UserProfileDto,
} from '@crm/shared'
import type { Currency } from '@/components/ui/amount-currency-input'
import { parseStrictAmount } from '@/lib/utils'
import { type Role, normalizeTelegram } from '../constants'
import { defaultPaymentMethod, toUsd, type ExchangeRates } from './validation'

/**
 * Pure payload builders extracted from `UserDialog`'s `onSubmit` closure.
 * They hold NO React state and never read refs: the caller resolves
 * everything (e.g. `selectedHrIdsRef.current`) and passes values in.
 * Gating, `safeParse` and `mutate` stay in `onSubmit`.
 */

/** The slice of the form's values the normal-CREATE payload reads. */
export type CreateUserFormValue = {
  email: string
  personalEmail: string
  displayName: string
  role: Role
  locale: Locale
  telegram: string
  phone: string
  techStack: string[]
  seniorSharePercent: number
  monthlySalary: unknown
  salaryCurrency: Currency
  projectId: string
  paymentMethod: PaymentMethod
  walletUsdtErc20: string
  walletUsdtLabel: string
  bankUahRecipient: string
  bankUahIban: string
  bankUahRnokpp: string
  bankUahBankName: string
  teamMode: TeamMode
  dropTeamId: string
  legalFullName: string
  registrationAddress: string
}

/** Convert the salary field to USD if needed. Backend stores USD numeric. */
export function computeMonthlySalaryUsd(args: {
  monthlySalary: unknown
  salaryCurrency: Currency
  exchangeRates: ExchangeRates | undefined
}): number | null {
  const { monthlySalary, salaryCurrency, exchangeRates } = args
  const num = parseStrictAmount(String(monthlySalary))
  if (!isFinite(num) || num < 0) return null
  if (!exchangeRates) return num // shouldn't happen — query enabled on open
  return Number(toUsd(num, salaryCurrency, exchangeRates).toFixed(2))
}

/** Everything the CREATE payload closes over beyond the form `value`. */
export type CreateUserPayloadDeps = {
  hrIds: string[]
  accountantId: string
  exchangeRates: ExchangeRates | undefined
}

/** Normal (non-DROP, first-POST) CREATE payload. Verbatim move from `onSubmit`. */
export function buildCreateUserPayload(
  value: CreateUserFormValue,
  { hrIds, accountantId, exchangeRates }: CreateUserPayloadDeps,
): CreateUserDto {
  const isSenior = value.role === 'SENIOR'
  const isJoinDropTeam = isSenior && value.teamMode === 'JOIN_DROP_TEAM'
  const computeSalaryUsd = () =>
    computeMonthlySalaryUsd({
      monthlySalary: value.monthlySalary,
      salaryCurrency: value.salaryCurrency,
      exchangeRates,
    })

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
    phone: value.phone || undefined,
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
        monthlySalary: computeSalaryUsd() ?? undefined,
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
  return payload
}

/** The slice of the form's values the DROP-create payload reads. */
export type CreateDropFormValue = {
  email: string
  displayName: string
  telegram: string
  phone: string
  techStack: string[]
  dropSharePercent: number
  paymentMethod: PaymentMethod
  walletUsdtErc20: string
  walletUsdtLabel: string
  bankUahRecipient: string
  bankUahIban: string
  bankUahRnokpp: string
  bankUahBankName: string
  teamTelegramChannelDrop: string
  legalFullName: string
  registrationAddress: string
}

/**
 * DROP-create payload (dedicated provisioning endpoint). Verbatim move from
 * `onSubmit`; the HR-required gate, `createDropSchema.safeParse` and `mutate`
 * stay in the caller.
 */
export function buildCreateDropPayload(
  value: CreateDropFormValue,
  { hrIds, accountantId }: { hrIds: string[]; accountantId: string },
): CreateDropDto {
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
    phone: value.phone || undefined,
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
  return payload
}

/** The slice of the form's values the wizard createdUserId-PATCH payload reads. */
export type WizardUpdateFormValue = {
  role: Role
  displayName: string
  telegram: string
  phone: string
  techStack: string[]
  seniorSharePercent: number
  monthlySalary: unknown
  salaryCurrency: Currency
  paymentMethod: PaymentMethod
  walletUsdtErc20: string
  walletUsdtLabel: string
  bankUahRecipient: string
  bankUahIban: string
  bankUahRnokpp: string
  bankUahBankName: string
  legalFullName: string
  registrationAddress: string
}

/**
 * Wizard «Назад» → edit → «Далее» PATCH-on-create payload (A3-3 AC6). Verbatim
 * move from `onSubmit`; `adminUpdateUserSchema.safeParse` and `mutate` stay in
 * the caller.
 */
export function buildWizardUpdatePayload(
  value: WizardUpdateFormValue,
  { hrIds, accountantId, exchangeRates }: CreateUserPayloadDeps,
): AdminUpdateUserDto {
  const isSenior = value.role === 'SENIOR'
  const paymentMethodUpdate: PaymentMethod =
    isSenior || value.role === 'ADMIN' ? 'USDT_ERC20' : value.paymentMethod
  const updatePayload: AdminUpdateUserDto = {
    displayName: value.displayName.trim(),
    telegram: value.telegram.trim() ? normalizeTelegram(value.telegram) : null,
    phone: value.phone || null,
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
      monthlySalary: value.monthlySalary
        ? computeMonthlySalaryUsd({
            monthlySalary: value.monthlySalary,
            salaryCurrency: value.salaryCurrency,
            exchangeRates,
          })
        : null,
      salaryCurrency: 'USD',
    }),
    ...(value.legalFullName.trim() && {
      legalFullName: value.legalFullName.trim(),
    }),
    ...(value.registrationAddress.trim() && {
      registrationAddress: value.registrationAddress.trim(),
    }),
  }
  return updatePayload
}

/** The slice of the form's values the normal-EDIT payload reads. */
export type EditUserFormValue = {
  email: string
  role: Role
  displayName: string
  telegram: string
  phone: string
  techStack: string[]
  seniorSharePercent: number
  dropSharePercent: number
  teamTelegramChannel: string
  monthlySalary: unknown
  salaryCurrency: Currency
  paymentMethod: PaymentMethod
  walletUsdtErc20: string
  walletUsdtLabel: string
  bankUahRecipient: string
  bankUahIban: string
  bankUahRnokpp: string
  bankUahBankName: string
  legalFullName: string
  registrationAddress: string
}

/** Everything the EDIT payload closes over beyond the form `value`. */
export type EditUserPayloadDeps = CreateUserPayloadDeps & {
  /** SERVER snapshot — change-detection compares against this, never the form's initial. */
  editingUser: UserProfileDto | null
}

/**
 * Normal EDIT (PATCH) payload. Verbatim move from `onSubmit`, including the
 * server-snapshot change-detection (`paymentChanged`, `shareChanged`, email);
 * `adminUpdateUserSchema.safeParse` and `mutate` stay in the caller.
 */
export function buildEditUpdatePayload(
  value: EditUserFormValue,
  { editingUser, hrIds, accountantId, exchangeRates }: EditUserPayloadDeps,
): AdminUpdateUserDto {
  const isSenior = value.role === 'SENIOR'
  const isDrop = value.role === 'DROP'

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

  // task-648-fix-round-2 (SR-M-5): see the payload comment below. Same
  // `!!editingUser &&` shape as `paymentChanged` directly above — with
  // no server snapshot to compare against there is no evidence the
  // operator changed anything, so the field stays off the wire.
  // `seniorSharePercent` is a non-nullable `number` on `UserProfileDto`,
  // so no `?? 26` fallback: it would be unreachable.
  const shareChanged = !!editingUser && value.seniorSharePercent !== editingUser.seniorSharePercent

  // ut-17: normalize team telegram channel value. Strip leading @ before
  // sending — the backend stores the bare handle, UI re-adds @ on display.
  const normalizedTeamChannel = (() => {
    // Stryker disable next-line ConditionalExpression: only the guard-forced-FALSE mutant is equivalent (a non-SENIOR then computes a value read solely inside the `...(isSenior && {...})` spread below, so the output is identical); the forced-TRUE mutant is unsuppressed-killable and is pinned by the SENIOR teamTelegramChannel tests — verified by removing this directive (only the FALSE mutant survived)
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
    phone: value.phone || null,
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
        monthlySalary: value.monthlySalary
          ? computeMonthlySalaryUsd({
              monthlySalary: value.monthlySalary,
              salaryCurrency: value.salaryCurrency,
              exchangeRates,
            })
          : null,
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
  return payload
}
