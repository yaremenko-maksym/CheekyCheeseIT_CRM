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
