import type { InterpolatableVariableKey } from '@crm/shared'
import type { User } from '../database/schema'

/**
 * Onboarding Phase 6A — pure rendering helpers for MSA contract templates.
 *
 * Extracted from SignedContractsService so the same substitution logic can be
 * used both at sign-time (immutable snapshot) and at preview-time
 * (GET /api/contracts/preview-rendered/:templateId).
 *
 * Security invariant: substitution runs in a SINGLE regex pass so that
 * user-controlled values containing `{{...}}` tokens cannot trigger a second
 * round of substitution. See the replacer function comment below.
 */

export type ContractRenderUserContext = Pick<
  User,
  | 'displayName'
  | 'legalFullName'
  | 'email'
  | 'role'
  | 'walletUsdtErc20'
  | 'walletUsdtLabel'
  | 'bankUahRecipient'
  | 'bankUahIban'
  | 'bankUahRnokpp'
  | 'bankUahBankName'
  | 'paymentMethod'
>

const ROLE_LABELS: Record<string, string> = {
  HR: 'HR',
  SENIOR: 'Senior',
  JUNIOR: 'Junior',
  DROP: 'Drop',
  ACCOUNTANT: 'Accountant',
  ADMIN: 'Admin',
}

const METHOD_LABELS: Record<string, string> = {
  USDT_ERC20: 'USDT (ERC-20)',
  BANK_UAH_FOP: 'ФОП (UAH)',
}

/**
 * Resolve all `{{placeholder}}` tokens in a contract template body.
 *
 * @param bodyMarkdown  Raw template body from `contract_templates.body_markdown`.
 * @param user          User row (or pick of relevant fields).
 * @param signedAt      Timestamp used for `{{onboardingDate}}`.
 * @returns             `body` — rendered markdown; `variables` — frozen
 *                      key→value map for audit trail storage.
 */
export function renderContractTemplate(
  bodyMarkdown: string,
  user: ContractRenderUserContext,
  signedAt: Date,
): { body: string; variables: Record<InterpolatableVariableKey, string> } {
  const walletUsdt = user.walletUsdtErc20?.trim() || 'не указано'

  const fopParts = [
    user.bankUahRecipient,
    user.bankUahIban,
    user.bankUahRnokpp,
    user.bankUahBankName,
  ].filter((p): p is string => Boolean(p && p.trim()))
  const bankUahFop = fopParts.length > 0 ? fopParts.join(', ') : 'не указано'

  const preferredMethod = user.paymentMethod
    ? (METHOD_LABELS[user.paymentMethod] ?? user.paymentMethod)
    : 'не указано'

  const variables: Record<InterpolatableVariableKey, string> = {
    // Fallback chain: legal ФИО → platform displayName → 'не указано' (AC1).
    // legalFullName is set by ADMIN (Cyrillic ФИО for the contract).
    // Fallback through displayName preserves backward compat for users
    // created before this field was introduced.
    employeeName: user.legalFullName?.trim() || user.displayName || 'не указано',
    employeeEmail: user.email ?? 'не указано',
    role: ROLE_LABELS[user.role] ?? user.role,
    onboardingDate: signedAt.toISOString().slice(0, 10),
    companyName: 'Cheeky Cheese IT',
    walletUsdt,
    bankUahFop,
    preferredMethod,
  }

  // SECURITY: single-pass substitution via one regex so user-controlled values
  // (e.g. `displayName = '{{walletUsdt}}'`) CANNOT trigger a second round.
  // Unknown tokens are left as-is for ADMIN auditing of template authoring mistakes.
  const body = bodyMarkdown.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key)
      ? variables[key as InterpolatableVariableKey]!
      : match
  })

  return { body, variables }
}
