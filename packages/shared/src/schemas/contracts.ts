import { z } from 'zod'

/**
 * Onboarding Phase 6A — MSA contract schemas.
 *
 * Five MSA templates exist: one per non-ADMIN role (HR, SENIOR, JUNIOR, DROP,
 * ACCOUNTANT). ADMIN bypasses the onboarding gate and never signs a contract;
 * the database enforces `contract_templates.target_role <> 'ADMIN'` via CHECK.
 *
 * Templates carry `is_active` semantics: at most one row per (target_role)
 * is active at a time. Publishing a new version atomically deactivates the
 * previous one (service layer). Signed contracts freeze the template body
 * via `bodyMarkdownSnapshot` + `variablesFilled` at signing time — the row
 * is an immutable audit trail.
 *
 * `contractNumber` follows `CHK-<seq>-<year>` (e.g. `CHK-1-2026`). The
 * sequence is server-side (`contract_number_seq`), monotonic, gaps allowed
 * on rollback.
 */

/**
 * Roles eligible to sign an MSA. ADMIN is excluded — they bypass the
 * onboarding gate entirely. Mirrors the DB CHECK constraint on
 * `contract_templates.target_role`.
 */
export const contractTargetRoleSchema = z.enum(['HR', 'SENIOR', 'JUNIOR', 'DROP', 'ACCOUNTANT'])

export const contractTemplateSchema = z.object({
  id: z.string().uuid(),
  targetRole: contractTargetRoleSchema,
  version: z.number().int().positive(),
  bodyMarkdown: z.string(),
  isActive: z.boolean(),
  createdByUserId: z.string().uuid(),
  createdAt: z.string().or(z.date()),
})

/**
 * ADMIN publishes a new version. Service layer atomically deactivates the
 * previous active row (per role) and inserts a new one with
 * `version = max + 1`, `isActive = true`.
 */
export const createContractTemplateSchema = z.object({
  targetRole: contractTargetRoleSchema,
  bodyMarkdown: z.string().min(1, 'Тело контракта не может быть пустым'),
})

export const signedContractSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  templateId: z.string().uuid(),
  bodyMarkdownSnapshot: z.string(),
  /**
   * JSONB blob of resolved template variables, frozen at signing time. Keys:
   * `employeeName`, `employeeEmail`, `role`, `onboardingDate`, `companyName`,
   * `walletUsdt`, `bankUahFop`, `preferredMethod`. Missing values stored as
   * the literal Russian string `'не указано'`.
   */
  variablesFilled: z.record(z.string(), z.string()),
  signedTypedName: z.string(),
  signedIp: z.string().nullable(),
  signedUserAgent: z.string().nullable(),
  signedAt: z.string().or(z.date()),
  /**
   * `CHK-<6 uppercase hex>` — server-generated, unique (e.g. `CHK-7F3A9C`).
   * Legacy seed rows use the old `CHK-<seq>-<year>` format and are allowed
   * through on read (the schema is used for API responses, not DB inserts).
   * Both patterns are accepted so existing seed contracts do not fail validation.
   */
  contractNumber: z
    .string()
    .regex(
      /^CHK-([0-9A-F]{6}|\d+-\d{4})$/,
      'Некорректный contract_number (ожидается CHK-XXXXXX или CHK-N-YYYY для legacy)',
    ),
})

/**
 * Body for `POST /api/contracts/sign`. IP / UA captured server-side from
 * `req.ip` + `req.headers['user-agent']` — not part of the request body.
 *
 * A2a change: `typedName` is now optional — the backend resolves the signed
 * name from `users.legalFullName` (spec §4.3 Option A). Clients MAY still
 * send `typedName` for backward compatibility but the value is ignored.
 */
export const signContractSchema = z.object({
  typedName: z.string().max(200).optional(),
})

export type ContractTargetRole = z.infer<typeof contractTargetRoleSchema>
export type ContractTemplateDto = z.infer<typeof contractTemplateSchema>
export type CreateContractTemplateDto = z.infer<typeof createContractTemplateSchema>
export type SignedContractDto = z.infer<typeof signedContractSchema>
export type SignContractDto = z.infer<typeof signContractSchema>

/**
 * Row shape returned by GET /api/contracts/templates and
 * GET /api/contracts/templates/current/:role.
 *
 * Extracted here to serve as the single source of truth shared between
 * contracts.index.tsx (list page) and contracts.$role.tsx (editor page).
 * The `createdByUserId` field is optional in UI contexts where the API
 * may omit it for non-ADMIN callers.
 */
export interface ContractTemplateRow {
  id: string
  targetRole: ContractTargetRole
  version: number
  bodyMarkdown: string
  isActive: boolean
  createdByUserId?: string
  createdAt: string
}

/**
 * Canonical map of template variable bare-keys → human-readable Russian descriptions.
 *
 * Bare-key form (without `{{...}}` delimiters) is the authoritative type source.
 * Braced form is derived via CONTRACT_VARIABLE_DESCRIPTIONS_BRACED for admin hint
 * panel display and template authoring UI.
 *
 * This is the single source of truth for variable names used in:
 *   - Backend: SignedContractsService.interpolateVariables() — types the variables map
 *   - Frontend: contract-variables.ts — re-exports braced form for the admin hint panel
 *
 * `contractNumber` is generated server-side (CHK-N-YYYY) and not resolved via
 * interpolateVariables — included for admin documentation purposes only (see
 * InterpolatableVariableKey which excludes it).
 */
export const CONTRACT_VARIABLE_DESCRIPTIONS = {
  employeeName: 'Полное имя сотрудника',
  employeeEmail: 'Email сотрудника',
  role: 'Роль (HR / Синьор / Джун / Дроп / Бухгалтер)',
  onboardingDate: 'Дата подписания контракта',
  companyName: 'Название компании (Cheeky Cheese IT)',
  /** Legal name of the contracting legal entity (VolkerWessels Nederland IE B.V.) */
  companyLegalName: 'Юридическое название компании-контрагента',
  /** Registered address of the contracting legal entity */
  companyAddress: 'Адрес компании-контрагента',
  /** Country of incorporation of the contracting legal entity */
  companyCountry: 'Страна регистрации компании-контрагента',
  walletUsdt: 'USDT ERC-20 кошелёк (если указан)',
  bankUahFop: 'Банковские реквизиты UAH (ФОП)',
  preferredMethod: 'Предпочтительный метод оплаты (crypto / fop)',
  /**
   * Smart composite: shows the relevant payment requisites based on paymentMethod.
   * USDT_ERC20 → wallet address; BANK_UAH_FOP → ФОП fields; empty → 'не указано' (once).
   * Replaces the `{{walletUsdt}}{{bankUahFop}}` pair that produced "не указаноне указано"
   * when both fields were empty.
   */
  requisites: 'Реквизиты оплаты (определяются по методу оплаты автоматически)',
  /**
   * Monthly salary amount + currency. Resolved from users.monthlySalary +
   * users.salaryCurrency. Trailing ".00" stripped (e.g. "800.00" → "800").
   * Falls back to 'не указано' when monthlySalary is null.
   */
  salary: 'Ежемесячное вознаграждение (сумма + валюта, напр. "1200 USD")',
  contractNumber: 'Номер контракта (генерируется автоматически, CHK-N-YYYY)',
} as const

export type ContractVariableKey = keyof typeof CONTRACT_VARIABLE_DESCRIPTIONS

/**
 * Response shape for `GET /api/contracts/preview-rendered/:templateId`.
 * Returns the template body with all `{{placeholder}}` tokens substituted
 * using the calling user's current profile data (preview before signing).
 */
export const contractRenderedPreviewSchema = z.object({
  bodyMarkdown: z.string(),
})

export type ContractRenderedPreviewDto = z.infer<typeof contractRenderedPreviewSchema>

/**
 * Variables resolved at sign-time via interpolateVariables.
 * `contractNumber` is generated server-side (NOT interpolated from user data) — excluded
 * so the backend variables map is typed without it.
 */
export type InterpolatableVariableKey = Exclude<ContractVariableKey, 'contractNumber'>

/**
 * Derived braced form for admin UI display and template authoring hint panel.
 * Example: { '{{employeeName}}': 'Полное имя сотрудника', ... }
 */
export const CONTRACT_VARIABLE_DESCRIPTIONS_BRACED = Object.fromEntries(
  Object.entries(CONTRACT_VARIABLE_DESCRIPTIONS).map(([key, desc]) => [`{{${key}}}`, desc]),
) as Record<`{{${ContractVariableKey}}}`, string>
