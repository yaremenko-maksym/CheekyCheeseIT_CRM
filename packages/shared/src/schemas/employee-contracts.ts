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

export const employeeContractSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  sourceTemplateId: z.string().uuid(),
  bodyMarkdown: z.string(),
  status: employeeContractStatusSchema,
  signedContractId: z.string().uuid().nullable(),
  createdByUserId: z.string().uuid(),
  customValues: z.record(z.string(), z.string()).default({}),
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

// ─── Screen 2: variable fill form ─────────────────────────────────────────────

/**
 * PATCH /api/users/:id/contract/custom-values
 * Body: { customValues: Record<string, string> }
 */
export const updateCustomValuesSchema = z.object({
  customValues: z.record(z.string(), z.string()),
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
