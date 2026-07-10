import type { InterpolatableVariableKey } from '@crm/shared'
import type { User } from '../database/schema'
import { CONTRACT_COMPANY } from '../common/pdf/pdf.constants'

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
  | 'monthlySalary'
  | 'salaryCurrency'
  | 'seniorSharePercent'
  | 'dropSharePercent'
  | 'phone'
  | 'registrationAddress'
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
 * Build the complete key→resolvedValue map for all standard contract variables.
 *
 * This is a pure data-building step extracted from `renderContractTemplate` so
 * that `getContractVariables` (the variables-list endpoint) can reuse the exact
 * same resolution logic as the PDF renderer — keeping the list and the document
 * byte-for-byte consistent.
 *
 * Security note: this function only BUILDS the map — it does NOT perform any
 * string substitution. The single-pass substitution that preserves the security
 * invariant happens inside `renderContractTemplate`, which calls this function
 * and then runs ONE regex replace over the body.
 *
 * @param user       User row (pick of relevant fields).
 * @param signedAt   Timestamp used for `{{onboardingDate}}`.
 *                   When called from the variables-list endpoint (no sign time
 *                   available), pass `new Date()` — the value is shown as a
 *                   preview and is NOT baked into any stored record.
 */
export function buildContractVariableMap(
  user: ContractRenderUserContext,
  signedAt: Date,
): Record<InterpolatableVariableKey, string> {
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

  /**
   * Salary: "<amount> <currency>" where amount has trailing ".00" stripped.
   * Examples: "800.00" → "800 USD"; "1234.50" → "1234.50 USD".
   * Falls back to 'не указано' when monthlySalary is null/empty.
   */
  let salary: string
  if (user.monthlySalary != null && String(user.monthlySalary).trim() !== '') {
    const raw = String(user.monthlySalary)
    // Strip trailing ".00" but keep e.g. "1234.50" intact.
    const amount = raw.replace(/\.00$/, '')
    const currency = user.salaryCurrency ?? 'USD'
    salary = `${amount} ${currency}`
  } else {
    salary = 'не указано'
  }

  /**
   * Smart composite requisites: select the relevant value based on paymentMethod
   * so templates using {{requisites}} never produce "не указаноне указано".
   *
   *   USDT_ERC20  → wallet address (or 'не указано' if blank)
   *   BANK_UAH_FOP → ФОП fields joined (or 'не указано' if all blank)
   *   null/other  → 'не указано' (single occurrence)
   */
  let requisites: string
  if (user.paymentMethod === 'USDT_ERC20') {
    requisites = walletUsdt
  } else if (user.paymentMethod === 'BANK_UAH_FOP') {
    requisites = bankUahFop
  } else {
    requisites = 'не указано'
  }

  /**
   * sharePercent / companySharePercent — role-dependent split percentages.
   *
   * SENIOR → uses seniorSharePercent (int 0-100, default 26).
   * DROP   → uses dropSharePercent (int 0-100, default 5; nullable for other roles).
   * Other  → '' (empty string so frontend can detect "not applicable").
   *
   * companySharePercent = 100 − sharePercent (computed, no direct DB field).
   */
  let sharePercent: string
  let companySharePercent: string
  if (user.role === 'SENIOR') {
    sharePercent = String(user.seniorSharePercent)
    companySharePercent = String(100 - user.seniorSharePercent)
  } else if (user.role === 'DROP' && user.dropSharePercent != null) {
    sharePercent = String(user.dropSharePercent)
    companySharePercent = String(100 - user.dropSharePercent)
  } else {
    sharePercent = ''
    companySharePercent = ''
  }

  return {
    // Fallback chain: legal ФИО → platform displayName → 'не указано' (AC1).
    // legalFullName is set by ADMIN (Cyrillic ФИО for the contract).
    // Fallback through displayName preserves backward compat for users
    // created before this field was introduced.
    employeeName: user.legalFullName?.trim() || user.displayName || 'не указано',
    employeeEmail: user.email ?? 'не указано',
    role: ROLE_LABELS[user.role] ?? user.role,
    onboardingDate: signedAt.toISOString().slice(0, 10),
    companyName: 'Cheeky Cheese IT',
    // Legal entity data for «Сторони / Компанія» section (T3).
    companyLegalName: CONTRACT_COMPANY.legalName,
    companyAddress: CONTRACT_COMPANY.address,
    companyCountry: CONTRACT_COMPANY.country,
    walletUsdt,
    bankUahFop,
    preferredMethod,
    requisites,
    salary,
    // New in contract-variables v2 (PR #147 backend extension).
    // Empty string '' = not set → frontend shows "не заполнено" indicator.
    rnokpp: user.bankUahRnokpp?.trim() ?? '',
    phone: user.phone?.trim() ?? '',
    salaryCurrency: user.salaryCurrency ?? '',
    registrationAddress: user.registrationAddress?.trim() ?? '',
    sharePercent,
    companySharePercent,
    companyRegNumber: CONTRACT_COMPANY.regNumber,
    companyVat: CONTRACT_COMPANY.vat,
    companyBank: CONTRACT_COMPANY.bank,
    companyAuthorityBasis: CONTRACT_COMPANY.authorityBasis,
  }
}

/**
 * Resolve all `{{placeholder}}` tokens in a contract template body.
 *
 * @param bodyMarkdown   Raw template body from `contract_templates.body_markdown`.
 * @param user           User row (or pick of relevant fields).
 * @param signedAt       Timestamp used for `{{onboardingDate}}`.
 * @param customValues   Optional map of custom variable key → value supplied by the
 *                       client (e.g. from the "fill variables" form before signing).
 *                       Resolution order: standard variables → customValues → leave
 *                       `{{key}}` as-is (unknown token, visible to admin).
 *                       Single-pass substitution is preserved — customValues are
 *                       inserted in the same regex pass, so values containing
 *                       `{{...}}` tokens are NOT re-interpolated.
 * @returns              `body` — rendered markdown; `variables` — frozen
 *                       key→value map for audit trail storage.
 */
export function renderContractTemplate(
  bodyMarkdown: string,
  user: ContractRenderUserContext,
  signedAt: Date,
  customValues?: Record<string, string>,
): { body: string; variables: Record<InterpolatableVariableKey, string> } {
  // Build the full variable map using the shared helper.
  // renderContractTemplate is the ONLY place that runs string substitution.
  const variables = buildContractVariableMap(user, signedAt)

  // SECURITY: single-pass substitution via one regex so user-controlled values
  // (e.g. `displayName = '{{walletUsdt}}'`) CANNOT trigger a second round.
  // Resolution order within the replacer:
  //   1. Standard variables (from `variables` map above).
  //   2. Custom values (from `customValues` param — admin-defined template vars).
  //   3. Unknown token → left as-is for ADMIN auditing of template authoring mistakes.
  const body = bodyMarkdown.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      return variables[key as InterpolatableVariableKey]!
    }
    if (customValues && Object.prototype.hasOwnProperty.call(customValues, key)) {
      return customValues[key]!
    }
    return match
  })

  return { body, variables }
}

/** Heading prepended to the auto-appended company requisites section. */
export const COMPANY_REQUISITES_HEADING = '## Реквизиты компании'

/**
 * Append the company requisites as a «Реквизиты компании» section at the END of
 * a contract body.
 *
 * Owner decision: requisites are an auto-section at the end of every NEW
 * contract — templates are NOT edited. This keeps the requisites out of the
 * authored template (so an admin can change them centrally) while baking the
 * value current at sign time into the immutable snapshot.
 *
 * Behavior:
 *   - `requisitesMarkdown` null / empty / whitespace-only → return `body`
 *     unchanged (NO heading-only section).
 *   - otherwise → `body` + blank line + `## Реквизиты компании` + blank line +
 *     the requisites markdown (verbatim — already authored markdown, NOT token-
 *     interpolated, matching the «tokens stay visible» preview semantics).
 *
 * Pure + idempotent at the call sites that use it once (sign + preview). It does
 * NOT itself guard against double-append; callers append exactly once.
 *
 * @param body              Rendered (or raw) contract body.
 * @param requisitesMarkdown Company requisites markdown, or null.
 * @returns                 Body with the requisites section appended, or the
 *                          original body when there are no requisites.
 */
export function appendCompanyRequisitesSection(
  body: string,
  requisitesMarkdown: string | null | undefined,
): string {
  if (!requisitesMarkdown || requisitesMarkdown.trim() === '') {
    return body
  }
  return `${body}\n\n${COMPANY_REQUISITES_HEADING}\n\n${requisitesMarkdown}`
}
