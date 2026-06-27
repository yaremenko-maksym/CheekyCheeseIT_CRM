import { z } from 'zod'

/**
 * A3-1 — per-employee contract schemas.
 *
 * Each non-ADMIN user has at most one active (non-CANCELLED) employee_contract.
 * Lifecycle:
 *   DRAFT → READY_TO_SIGN → SIGNED
 *   ADMIN can revert SIGNED | READY_TO_SIGN → DRAFT (re-opens onboarding)
 *   ADMIN can cancel (terminal; partial-unique index allows a new row after)
 *   ADMIN can reset body to active template (DRAFT only)
 *
 * DB: partial unique index employee_contracts_one_per_user ensures only one
 * non-CANCELLED row per user_id. Trigger prevents ADMIN from being the employee.
 */

export const employeeContractStatusSchema = z.enum([
  'DRAFT',
  'READY_TO_SIGN',
  'SIGNED',
  'CANCELLED',
])

/**
 * Bounded custom-values record: max 50 keys, key max 100 chars, value max 2000 chars.
 * Keys must match the regex of customVariableSchema (Latin, starts with letter).
 * Consistent with customVariableSchema.key constraint in contracts.ts.
 */
export const boundedCustomValuesSchema = z
  .record(
    z
      .string()
      .regex(
        /^[a-zA-Z][a-zA-Z0-9_]{0,49}$/,
        'Ключ: только латиница, начинается с буквы, макс 50 символов',
      ),
    z.string().max(2000, 'Значение переменной не может превышать 2000 символов'),
  )
  .refine((rec) => Object.keys(rec).length <= 50, {
    message: 'Не более 50 кастомных переменных',
  })

export const employeeContractSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  sourceTemplateId: z.string().uuid(),
  bodyMarkdown: z.string(),
  status: employeeContractStatusSchema,
  signedContractId: z.string().uuid().nullable(),
  createdByUserId: z.string().uuid(),
  customValues: boundedCustomValuesSchema.default({}),
  createdAt: z.string().or(z.date()),
  updatedAt: z.string().or(z.date()),
})

/**
 * PATCH /api/users/:id/contract — update body markdown.
 * Only allowed when status is DRAFT or READY_TO_SIGN.
 */
export const updateEmployeeContractSchema = z.object({
  bodyMarkdown: z.string().min(1, 'Тело контракта не может быть пустым'),
})

export type EmployeeContractStatus = z.infer<typeof employeeContractStatusSchema>
export type EmployeeContractDto = z.infer<typeof employeeContractSchema>
export type UpdateEmployeeContractDto = z.infer<typeof updateEmployeeContractSchema>
export type BoundedCustomValues = z.infer<typeof boundedCustomValuesSchema>

// ─── Screen 2: variable fill form ─────────────────────────────────────────────

/**
 * PATCH /api/users/:id/contract/custom-values
 * Body: { customValues: Record<string, string> }
 *
 * Uses boundedCustomValuesSchema so the controller layer enforces:
 *   - max 50 keys
 *   - key: Latin, starts with letter, max 50 chars (same as customVariableSchema)
 *   - value: max 2000 chars
 *
 * Cross-validation against the template's declared customVariables (rejecting
 * arbitrary keys not in the template) is enforced at the service layer in
 * employee-contracts.service.ts::updateCustomValues, where the template row
 * is available.
 */
export const updateCustomValuesSchema = z.object({
  customValues: boundedCustomValuesSchema,
})

export type UpdateCustomValuesDto = z.infer<typeof updateCustomValuesSchema>

/**
 * Source of a resolved template variable.
 *   user      — value comes from the user's profile fields
 *   company   — value comes from CONTRACT_COMPANY constants
 *   auto      — computed server-side (date, role label, etc.)
 *   custom    — defined in the template's customVariables array
 *   unknown   — token found in template body but not in any known source
 */
export const contractVariableSourceSchema = z.enum(['user', 'company', 'auto', 'custom', 'unknown'])

export type ContractVariableSource = z.infer<typeof contractVariableSourceSchema>

/**
 * A single resolved variable returned by GET /api/users/:id/contract/variables.
 */
export const contractVariableInfoSchema = z.object({
  /** Bare token key, e.g. 'employeeName' */
  key: z.string(),
  /** Human-readable Russian description */
  label: z.string(),
  source: contractVariableSourceSchema,
  /** Resolved value — empty string '' means the source field is not filled. */
  value: z.string(),
  /** True when the source field is empty/null in the DB row. */
  isEmpty: z.boolean(),
})

export type ContractVariableInfo = z.infer<typeof contractVariableInfoSchema>

/**
 * Response shape for GET /api/users/:id/contract/variables.
 */
export const contractVariablesResponseSchema = z.object({
  /** All {{token}} occurrences found in the contract body, with metadata. */
  variables: z.array(contractVariableInfoSchema),
  /** Template's customVariables definitions — used to render input fields. */
  customVariables: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      defaultValue: z.string().optional(),
    }),
  ),
})

export type ContractVariablesResponse = z.infer<typeof contractVariablesResponseSchema>
