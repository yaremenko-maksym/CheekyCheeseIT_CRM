import { z } from 'zod'
import { roleSchema } from './users'
import { paymentRequisitesSchema, currencyEnumSchema } from './payment-requisites'
import { withSalaryFloor } from './money'

export const changeRoleSchema = z.object({
  role: roleSchema,
})

export const changeSalarySchema = z
  .object({
    // BIZ-14. task-money-floor-and-lying-comments (security-review MED-1) —
    // THIRD write path to `users.monthly_salary` (numeric(10,2)); see
    // `./money`'s module comment for the full write-path map this closes.
    monthlySalary: withSalaryFloor(z.number().nonnegative().max(500_000)).nullable().optional(), // BIZ-14
    salaryCurrency: currencyEnumSchema.optional(),
    seniorSharePercent: z.number().int().min(0).max(100).optional(),
  })
  .refine((d) => d.monthlySalary !== undefined || d.seniorSharePercent !== undefined, {
    message: 'Укажите хотя бы одно из полей: monthlySalary или seniorSharePercent',
  })

export const changeRequisitesSchema = paymentRequisitesSchema

export const setNoteSchema = z.object({
  note: z.string().max(2000).nullable(),
})

export type ChangeRoleDto = z.infer<typeof changeRoleSchema>
export type ChangeSalaryDto = z.infer<typeof changeSalarySchema>
export type ChangeRequisitesDto = z.infer<typeof changeRequisitesSchema>
export type SetNoteDto = z.infer<typeof setNoteSchema>
