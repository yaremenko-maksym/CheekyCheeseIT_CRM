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
  /** `CHK-<seq>-<year>` — server-generated, unique. */
  contractNumber: z.string().regex(/^CHK-\d+-\d{4}$/, 'Некорректный contract_number'),
})

/**
 * Body for `POST /api/contracts/sign`. IP / UA captured server-side from
 * `req.ip` + `req.headers['user-agent']` — not part of the request body.
 */
export const signContractSchema = z.object({
  typedName: z.string().min(1, 'Введите ваше имя').max(200),
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
 * Canonical map of template variable placeholders → human-readable Russian
 * descriptions.
 *
 * This is the single source of truth for variable names used in:
 *   - Backend: SignedContractsService.interpolateVariables() — resolves values
 *   - Frontend: contract-variables.ts — re-exports this map for the admin hint panel
 *
 * Key format: `{{camelCaseKey}}` — must match the regex in interpolateVariables
 * (`/\{\{([a-zA-Z0-9_]+)\}\}/g`).
 *
 * `contractNumber` is generated server-side (CHK-N-YYYY) and not resolved via
 * interpolateVariables — included here for admin documentation purposes only.
 */
export const CONTRACT_VARIABLE_DESCRIPTIONS = {
  '{{employeeName}}': 'Полное имя сотрудника',
  '{{employeeEmail}}': 'Email сотрудника',
  '{{role}}': 'Роль (HR / Синьор / Джун / Дроп / Бухгалтер)',
  '{{onboardingDate}}': 'Дата подписания контракта',
  '{{companyName}}': 'Название компании (Cheeky Cheese IT)',
  '{{walletUsdt}}': 'USDT ERC-20 кошелёк (если указан)',
  '{{bankUahFop}}': 'Банковские реквизиты UAH (ФОП)',
  '{{preferredMethod}}': 'Предпочтительный метод оплаты (crypto / fop)',
  '{{contractNumber}}': 'Номер контракта (генерируется автоматически, CHK-N-YYYY)',
} as const

export type ContractVariableKey = keyof typeof CONTRACT_VARIABLE_DESCRIPTIONS
