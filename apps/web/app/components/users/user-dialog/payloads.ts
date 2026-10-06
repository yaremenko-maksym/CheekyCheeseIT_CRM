import type {
  AdminUpdateUserDto,
  CreateDropDto,
  CreateUserDto,
  Locale,
  PaymentMethod,
  TeamMode,
} from '@crm/shared'
import type { Currency } from '@/components/ui/amount-currency-input'
import { parseStrictAmount } from '@/lib/utils'
import { type Role, normalizeTelegram } from '../constants'
import { toUsd, type ExchangeRates } from './validation'

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
