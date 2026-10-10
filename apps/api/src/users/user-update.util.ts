import type { AppRole } from './users.service'

/**
 * Pure `set` builder extracted from `UsersService.adminUpdateUser`. No db, no
 * `this`, never throws — `assertAvatarDocument` (+ the `avatarDocumentId`
 * assignment) and the `updateUserRow` write stay inline in the service.
 */

export type AdminUserUpdateSet = Partial<{
  email: string
  displayName: string
  role: AppRole
  telegram: string | null
  phone: string | null
  avatarUrl: string | null
  avatarDocumentId: string | null
  techStack: string[] | null
  seniorSharePercent: number
  dropSharePercent: number
  monthlySalary: string | null
  salaryCurrency: 'USDT' | 'USD' | 'EUR' | 'UAH'
  paymentMethod: 'USDT_ERC20' | 'BANK_UAH_FOP'
  walletUsdtErc20: string | null
  walletUsdtLabel: string | null
  bankUahRecipient: string | null
  bankUahIban: string | null
  bankUahRnokpp: string | null
  bankUahBankName: string | null
  legalFullName: string | null
  registrationAddress: string | null
  updatedAt: Date
}>

export interface AdminUserUpdateInput {
  email?: string
  displayName?: string
  role?: AppRole
  telegram?: string | null | undefined
  phone?: string | null | undefined
  avatarUrl?: string | null | undefined
  techStack?: string[] | null | undefined
  dropSharePercent?: number | undefined
  seniorSharePercent?: number | undefined
  monthlySalary?: number | null | undefined
  salaryCurrency?: 'USDT' | 'USD' | 'EUR' | 'UAH' | undefined
  paymentMethod?: 'USDT_ERC20' | 'BANK_UAH_FOP' | undefined
  walletUsdtErc20?: string | null | undefined
  walletUsdtLabel?: string | null | undefined
  bankUahRecipient?: string | null | undefined
  bankUahIban?: string | null | undefined
  bankUahRnokpp?: string | null | undefined
  bankUahBankName?: string | null | undefined
  legalFullName?: string | undefined
  registrationAddress?: string | null | undefined
}

export function buildAdminUserUpdateSet(
  data: AdminUserUpdateInput,
  effectiveRole: AppRole,
): { set: AdminUserUpdateSet; requestedSeniorSharePercent: number | undefined } {
  const set: AdminUserUpdateSet = { updatedAt: new Date() }

  if (data.email !== undefined) set.email = data.email
  if (data.displayName !== undefined) set.displayName = data.displayName
  if (data.role !== undefined) set.role = data.role
  if ('telegram' in data) set.telegram = data.telegram ?? null
  if ('phone' in data) set.phone = data.phone ?? null
  if ('avatarUrl' in data) set.avatarUrl = data.avatarUrl ?? null
  if ('techStack' in data) set.techStack = data.techStack ?? null
  // `seniorSharePercent` is DELIBERATELY excluded from `set`: it is routed
  // through `proposeSeniorShareChangeInTx` by the caller (pending-share flow).
  // Role-gated: only a SENIOR effective role may request a base-share change.
  const requestedSeniorSharePercent: number | undefined =
    effectiveRole === 'SENIOR' ? data.seniorSharePercent : undefined
  if (data.dropSharePercent !== undefined && effectiveRole === 'DROP')
    set.dropSharePercent = data.dropSharePercent
  if ('monthlySalary' in data)
    set.monthlySalary = data.monthlySalary != null ? String(data.monthlySalary) : null
  if (data.salaryCurrency !== undefined) set.salaryCurrency = data.salaryCurrency
  if (data.legalFullName !== undefined) set.legalFullName = data.legalFullName.trim() || null
  if ('registrationAddress' in data)
    set.registrationAddress = data.registrationAddress?.trim() || null

  // Payment requisites — switching method clears the other branch's fields.
  if (data.paymentMethod !== undefined) {
    set.paymentMethod = data.paymentMethod
    if (data.paymentMethod === 'USDT_ERC20') {
      if ('walletUsdtErc20' in data) set.walletUsdtErc20 = data.walletUsdtErc20 ?? null
      if ('walletUsdtLabel' in data) set.walletUsdtLabel = data.walletUsdtLabel ?? null
      set.bankUahRecipient = null
      set.bankUahIban = null
      set.bankUahRnokpp = null
      set.bankUahBankName = null
    } else {
      if ('bankUahRecipient' in data) set.bankUahRecipient = data.bankUahRecipient ?? null
      if ('bankUahIban' in data) set.bankUahIban = data.bankUahIban ?? null
      if ('bankUahRnokpp' in data) set.bankUahRnokpp = data.bankUahRnokpp ?? null
      if ('bankUahBankName' in data) set.bankUahBankName = data.bankUahBankName ?? null
      set.walletUsdtErc20 = null
      set.walletUsdtLabel = null
    }
  } else {
    // No method switch — individual fields of the current method may still be patched.
    if ('walletUsdtErc20' in data) set.walletUsdtErc20 = data.walletUsdtErc20 ?? null
    if ('walletUsdtLabel' in data) set.walletUsdtLabel = data.walletUsdtLabel ?? null
    if ('bankUahRecipient' in data) set.bankUahRecipient = data.bankUahRecipient ?? null
    if ('bankUahIban' in data) set.bankUahIban = data.bankUahIban ?? null
    if ('bankUahRnokpp' in data) set.bankUahRnokpp = data.bankUahRnokpp ?? null
    if ('bankUahBankName' in data) set.bankUahBankName = data.bankUahBankName ?? null
  }

  return { set, requestedSeniorSharePercent }
}
