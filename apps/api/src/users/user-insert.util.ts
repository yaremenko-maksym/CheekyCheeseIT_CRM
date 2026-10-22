import type { Locale } from '@crm/shared'
import type { users } from '../database/schema'

/**
 * Pure insert-values builders extracted from `UsersService.createUser` and
 * `UsersService.createDrop`. No db, no `this` — the `tx.insert(users)` write,
 * the `user_emails` writes and the audit record stay inline in the service.
 */

type UserInsert = typeof users.$inferInsert

interface PaymentRequisitesInput {
  paymentMethod?: 'USDT_ERC20' | 'BANK_UAH_FOP'
  walletUsdtErc20?: string | null
  walletUsdtLabel?: string | null
  bankUahRecipient?: string | null
  bankUahIban?: string | null
  bankUahRnokpp?: string | null
  bankUahBankName?: string | null
}

/**
 * Payment requisites — only persist the fields matching the selected method.
 * Mutates `insertValues` (same as the inline blocks it replaced).
 */
function applyPaymentRequisites(insertValues: UserInsert, data: PaymentRequisitesInput): void {
  if (data.paymentMethod) {
    insertValues.paymentMethod = data.paymentMethod
    if (data.paymentMethod === 'USDT_ERC20') {
      insertValues.walletUsdtErc20 = data.walletUsdtErc20 ?? null
      insertValues.walletUsdtLabel = data.walletUsdtLabel ?? null
    } else {
      insertValues.bankUahRecipient = data.bankUahRecipient ?? null
      insertValues.bankUahIban = data.bankUahIban ?? null
      insertValues.bankUahRnokpp = data.bankUahRnokpp ?? null
      insertValues.bankUahBankName = data.bankUahBankName ?? null
    }
  }
}

export interface CreateUserInsertInput extends PaymentRequisitesInput {
  email: string
  displayName: string
  role: UserInsert['role']
  telegram?: string | null
  phone?: string | null
  avatarUrl?: string | null
  techStack?: string[] | null
  seniorSharePercent?: number
  monthlySalary?: number | null
  salaryCurrency?: 'USDT' | 'USD' | 'EUR' | 'UAH'
  legalFullName?: string
}

/** Insert payload for `createUser`; `locale` is resolved by the caller. */
export function buildCreateUserInsertValues(
  data: CreateUserInsertInput,
  locale: Locale,
): UserInsert {
  const insertValues: UserInsert = {
    email: data.email,
    displayName: data.displayName,
    role: data.role,
    telegram: data.telegram ?? null,
    phone: data.phone ?? null,
    // No auto-generated (dicebear) placeholder — new users get null here and
    // the UI (UserAvatar) falls back to initials until a real photo/upload
    // is set.
    avatarUrl: data.avatarUrl ?? null,
    techStack: data.techStack ?? null,
    // task-i18n-stage2 (Task 3) — explicit default (not left to the column
    // default) so the returned row reflects the value callers expect back.
    locale,
  }
  if (data.seniorSharePercent !== undefined)
    insertValues.seniorSharePercent = data.seniorSharePercent
  if (data.monthlySalary != null) insertValues.monthlySalary = String(data.monthlySalary)
  if (data.salaryCurrency) insertValues.salaryCurrency = data.salaryCurrency
  if (data.legalFullName?.trim()) insertValues.legalFullName = data.legalFullName.trim()

  applyPaymentRequisites(insertValues, data)
  return insertValues
}

export interface DropInsertInput extends PaymentRequisitesInput {
  email: string
  displayName: string
  telegram?: string | null
  phone?: string | null
  avatarUrl?: string | null
  techStack?: string[] | null
  dropSharePercent?: number
  legalFullName?: string | null
  registrationAddress?: string | null
}

/** Insert payload for `createDrop` (role is always `DROP`). */
export function buildDropInsertValues(data: DropInsertInput): UserInsert {
  const insertValues: UserInsert = {
    email: data.email,
    displayName: data.displayName,
    role: 'DROP',
    telegram: data.telegram ?? null,
    phone: data.phone ?? null,
    // Same rationale as createUser — no dicebear placeholder.
    avatarUrl: data.avatarUrl ?? null,
    techStack: data.techStack ?? null,
    dropSharePercent: data.dropSharePercent ?? 5,
  }
  // Contract data — persist the legal ФИО / registration address so the
  // drop's MSA contract renders them. Trim + only set when non-blank.
  if (data.legalFullName?.trim()) insertValues.legalFullName = data.legalFullName.trim()
  if (data.registrationAddress?.trim())
    insertValues.registrationAddress = data.registrationAddress.trim()

  applyPaymentRequisites(insertValues, data)
  return insertValues
}
