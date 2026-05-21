import { z } from 'zod'
import { roleSchema } from './users'
import { paymentRequisitesSchema, currencyEnumSchema } from './payment-requisites'

export const changeRoleSchema = z.object({
  role: roleSchema,
})

export const changeSalarySchema = z.object({
  monthlySalary: z.number().nonnegative().nullable().optional(),
  salaryCurrency: currencyEnumSchema.optional(),
  seniorSharePercent: z.number().int().min(0).max(100).optional(),
}).refine((d) => d.monthlySalary !== undefined || d.seniorSharePercent !== undefined, {
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
